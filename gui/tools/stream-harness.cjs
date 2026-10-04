// Offline harness for lib/stream.js — no Telegram, no tdl.exe.
//
// Copies gui/lib into a temp dir, stubs tdl.js (fake --serve that answers
// Range from a deterministic byte pattern) and tasks.js (buildDlArgs +
// injectable listServeSessions), then drives preview + the Range proxy and
// asserts byte-exact responses, cache behaviour, and the 边看边下 disk source.
//
// Run: node gui/tools/stream-harness.cjs
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const FILE_SIZE = 32 * 1024 * 1024 + 777; // odd tail exercises the last block
const PATTERN = (pos) => (pos * 31 + 7) % 251;
const expected = (start, len) => {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = PATTERN(start + i);
  return buf;
};

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  PASS ${name}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

async function readBody(res) {
  const chunks = [];
  for await (const c of res.body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function main() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-harness-'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(TMP, 'lib'), { recursive: true });

  // ---- fake serve (a stand-in for `tdl dl --serve`) ------------------------
  let serveHits = []; // {start,end} of every range GET the fake serve saw
  let serveSockets = new Set();
  const fakeServe = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // two real files plus hostile hrefs that safeHref must drop
      return res.end([
        '<a href="2414158977/23006"></a>',
        '<a href="2414158977/23007"></a>',
        '<a href="http://evil.example/x"></a>',
        '<a href="//evil.example/x"></a>',
        '<a href="/absolute/x"></a>',
        '<a href="../escape"></a>',
        '<a href="a/../../b"></a>',
        '<a href="javascript:alert(1)"></a>',
      ].join(''));
    }
    const name = req.url.endsWith('23006') ? 'IMG_1428.MP4' : 'notes.pdf';
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': String(FILE_SIZE),
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      return res.end();
    }
    const m = String(req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
    let start = 0; let end = FILE_SIZE - 1; let status = 200;
    if (m) { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), FILE_SIZE - 1) : FILE_SIZE - 1; status = 206; }
    serveHits.push({ start, end });
    // Emulate tdl --serve's REAL range behaviour, verified against upstream
    // source: serve streams through partio.NewStreamer(..., partSize) with
    // partSize = 512KiB (cmd/root.go: the deprecated --size flag defaults to
    // 512*1024), and partio aligns every read DOWN to that unit
    // (`nearestOffset`: offset - offset%align). So the bytes that come back
    // start at a unit boundary and cover whole units — NOT necessarily the
    // range that was asked for. A span ending at EOF keeps its partial tail.
    // The proxy must align its own requests and clip locally, which is what
    // the 64KiB urgent slices got wrong (block 0 never landed → 4K hung).
    const U = 512 * 1024;
    const qs = start - (start % U); // partio nearestOffset: round DOWN
    const qe = end === FILE_SIZE - 1 ? end : Math.ceil((end + 1) / U) * U - 1;
    res.writeHead(status, {
      'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${FILE_SIZE}` } : {}),
      'Content-Disposition': `attachment; filename="${name}"`,
    });
    let pos = qs;
    const timer = setInterval(() => {
      if (pos > qe) { clearInterval(timer); res.end(); return; }
      const len = Math.min(64 * 1024, qe - pos + 1);
      const buf = Buffer.alloc(len);
      for (let i = 0; i < len; i++) buf[i] = PATTERN(pos + i);
      res.write(buf);
      pos += len;
    }, 1);
    req.on('close', () => { clearInterval(timer); serveSockets.delete(res); });
  });

  // ---- module stubs ---------------------------------------------------------
  // tdl.js stub: startServe returns a handle; the harness binds the fake serve
  // on the requested port itself. startTdl stands in for `tdl migrate`.
  fs.writeFileSync(path.join(TMP, 'lib', 'tdl.js'), `
    const http = require('node:http');
    module.exports = {
      queueInfo: () => ({ active: null }),
      enqueue: (name, fn) => fn(),
      startTdl: () => ({
        onLine() {}, onChunk() {}, write() {}, kill() {},
        exit: Promise.resolve({ exitCode: 0 }),
      }),
      startServe: (baseArgs, port) => ({
        onLine(cb) { /* serve logs ignored */ },
        exit: new Promise(() => {}),
        kill() {},
      }),
    };
  `);
  fs.writeFileSync(path.join(TMP, 'lib', 'tasks.js'), `
    let serveSessions = [];
    module.exports = {
      buildDlArgs: (t) => ['dl', ...(t.config.urls || []).flatMap((u) => ['-u', u])],
      listServeSessions: () => serveSessions,
      hasRunningServe: () => serveSessions.length > 0,
      __setServeSessions: (list) => { serveSessions = list; },
    };
  `);

  const stream = require(path.join(TMP, 'lib', 'stream.js'));
  const tasksStub = require(path.join(TMP, 'lib', 'tasks.js'));
  const tdlStub = require(path.join(TMP, 'lib', 'tdl.js'));

  // bind the fake serve on the session's port (unknown until preview picks a
  // sid, so hook startServe which receives it)
  tdlStub.startServe = (baseArgs, port) => {
    fakeServe.listen(port, '127.0.0.1');
    return {
      onLine() {},
      exit: new Promise(() => {}),
      kill() { try { fakeServe.close(); } catch { /* gone */ } },
    };
  };

  // ---- gateway exposing handlePlay like server.js does ----------------------
  const gw = http.createServer((req, res) => {
    const m = req.url.match(/^\/api\/stream\/([0-9a-f]+)\/(\d+)$/);
    if (m) return stream.handlePlay(req, res, m[1], m[2]);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"nope"}');
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  const gwPort = gw.address().port;

  // ---- 1. preview ------------------------------------------------------------
  console.log('# preview');
  const r = await stream.preview(['https://t.me/testchannel/23006']);
  check('preview ok', !!r.session, r.error);
  const sid = r.session && r.session.sid;
  const files = (r.session && r.session.files) || [];
  check('two files listed', files.length === 2, JSON.stringify(files));
  check('hostile hrefs dropped (SSRF guard)', files.every((f) => /^[A-Za-z0-9][A-Za-z0-9/_.%-]*$/.test(f.href)),
    JSON.stringify(files.map((f) => f.href)));
  check('name from Content-Disposition', files[0] && files[0].name === 'IMG_1428.MP4');
  check('size from HEAD', files[0] && files[0].size === FILE_SIZE, files[0] && String(files[0].size));
  check('ext/playable', files[0] && files[0].ext === 'mp4' && files[0].playable === true);
  check('second file pdf not playable', files[1] && files[1].ext === 'pdf' && files[1].playable === false);
  // tdl serve writes the filename as raw UTF-8 bytes and every HTTP client
  // hands JS the header latin1-decoded — filenameFrom must re-assemble it or
  // non-ASCII names show up as mojibake in the file list. (Node's own http
  // server refuses to EMIT those C1 bytes alongside Content-Length, so this
  // is tested against a header shim instead of the fake serve.)
  const serveDl = require(path.join(TMP, 'lib', 'serve-dl.js'));
  const dispOf = (v) => ({ get: (k) => (String(k).toLowerCase() === 'content-disposition' ? v : null) });
  const mojibakeDisp = `attachment; filename="${Buffer.from('凡人修仙传 第194集.pdf', 'utf8').toString('latin1')}"`;
  check('filenameFrom re-decodes latin1 header bytes',
    serveDl.filenameFrom(dispOf(mojibakeDisp), '') === '凡人修仙传 第194集.pdf',
    serveDl.filenameFrom(dispOf(mojibakeDisp), ''));
  check('filenameFrom passes ascii through',
    serveDl.filenameFrom(dispOf('attachment; filename="IMG_1428.MP4"'), '') === 'IMG_1428.MP4');
  check('filenameFrom handles RFC5987 encoded names',
    serveDl.filenameFrom(dispOf(`attachment; filename*=UTF-8''${encodeURIComponent('凡人.pdf')}`), '') === '凡人.pdf');
  serveHits = [];

  const get = async (range, idx = 0) => {
    const res = await fetch(`http://127.0.0.1:${gwPort}/api/stream/${sid}/${idx}`, {
      headers: range ? { Range: range } : {},
    });
    const body = await readBody(res);
    return { status: res.status, headers: res.headers, body };
  };

  // ---- 2. basic range --------------------------------------------------------
  console.log('# range basics');
  let resp = await get('bytes=0-999999');
  check('206 status', resp.status === 206, String(resp.status));
  check('content-range', resp.headers.get('content-range') === `bytes 0-999999/${FILE_SIZE}`);
  check('content-length', Number(resp.headers.get('content-length')) === 1000000);
  check('bytes exact', resp.body.equals(expected(0, 1000000)));

  resp = await get(`bytes=${FILE_SIZE - 1000}-${FILE_SIZE - 1}`);
  check('tail bytes exact', resp.body.equals(expected(FILE_SIZE - 1000, 1000)));

  resp = await get('bytes=-1000'); // suffix range
  check('suffix 206', resp.status === 206);
  check('suffix bytes exact', resp.body.equals(expected(FILE_SIZE - 1000, 1000)));

  resp = await get(`bytes=${FILE_SIZE + 10}-${FILE_SIZE + 20}`);
  check('out-of-range 416', resp.status === 416, String(resp.status));

  // block-crossing request (1MiB blocks)
  const CROSS = 1024 * 1024 - 5;
  resp = await get(`bytes=${CROSS}-${CROSS + 11}`);
  check('block-crossing bytes exact', resp.body.equals(expected(CROSS, 12)));

  // ---- 2b. serve unit quantization -------------------------------------------
  // The fake serve now only ships whole 512KiB units from aligned starts,
  // like the real one. The old 64KiB urgent slices came back empty here —
  // block 0 never landed and playback never started (缓冲 200M+ 不起播).
  console.log('# serve unit quantization');
  const U = 512 * 1024;
  const QSTART = 12 * 1024 * 1024 + 123; // mid-unit start, untouched block
  resp = await get(`bytes=${QSTART}-${QSTART + 65535}`);
  check('sub-unit range over quantized serve bytes exact',
    resp.body.equals(expected(QSTART, 65536)));
  check('content-length equals body (no overshoot)',
    Number(resp.headers.get('content-length')) === resp.body.length,
    `${resp.headers.get('content-length')} vs ${resp.body.length}`);
  const MIDBYTE = 12 * 1024 * 1024 + U + 77;
  resp = await get(`bytes=${MIDBYTE}-${MIDBYTE}`);
  check('single byte mid-unit exact', resp.body.equals(expected(MIDBYTE, 1)),
    resp.body.length ? `got ${resp.body.length}B` : 'empty body');
  resp = await get(`bytes=${FILE_SIZE - 1}-${FILE_SIZE - 1}`);
  check('final byte via EOF tail unit exact', resp.body.equals(expected(FILE_SIZE - 1, 1)));

  // ---- 3. cache: a second identical hit must not touch the serve -------------
  console.log('# cache');
  const overlap = (hits, a, b) => hits.filter((h) => h.start <= b && h.end >= a).length;
  const hitsBefore = overlap(serveHits, 0, 999999);
  resp = await get('bytes=0-999999');
  check('warm hit bytes exact', resp.body.equals(expected(0, 1000000)));
  check('warm hit costs no serve request', overlap(serveHits, 0, 999999) === hitsBefore,
    `overlapping hits ${overlap(serveHits, 0, 999999) - hitsBefore} (pool window fetches are expected and counted out)`);

  // ---- 4. seek far forward then backward --------------------------------------
  console.log('# seek');
  const FAR = 30 * 1024 * 1024;
  resp = await get(`bytes=${FAR}-${FAR + 999999}`);
  check('far seek bytes exact', resp.body.equals(expected(FAR, 1000000)));
  resp = await get('bytes=0-999999');
  check('seek-back still exact', resp.body.equals(expected(0, 1000000)));

  // ---- 5. 边看边下: disk source from a running task's .part -------------------
  console.log('# 边看边下 disk source');
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-task-'));
  const partFile = path.join(taskDir, 'IMG_1428.MP4.part');
  const sidecar = `${partFile}.json`;
  const TD_TASK_BLOCK = 8 * 1024 * 1024;
  const doneBlocks = 2; // first 16MiB of the .part are complete
  const fd = fs.openSync(partFile, 'w');
  fs.ftruncateSync(fd, FILE_SIZE);
  for (let b = 0; b < doneBlocks; b++) {
    const len = Math.min(TD_TASK_BLOCK, FILE_SIZE - b * TD_TASK_BLOCK);
    fs.writeSync(fd, expected(b * TD_TASK_BLOCK, len), 0, len, b * TD_TASK_BLOCK);
  }
  fs.closeSync(fd);
  fs.writeFileSync(sidecar, JSON.stringify({ size: FILE_SIZE, done: [0, 1], partial: {} }));
  // point the 边看边下 lookup at the ACTUAL session port (the fake serve)
  const sessionPort = fakeServe.address() && fakeServe.address().port;
  tasksStub.__setServeSessions([{ id: 'deadbeef', port: sessionPort, dir: taskDir }]);

  const IN_PART = 5 * 1024 * 1024 + 123; // inside task block 0
  serveHits = [];
  resp = await get(`bytes=${IN_PART}-${IN_PART + 499999}`);
  check('part-range bytes exact', resp.body.equals(expected(IN_PART, 500000)));
  const netHits = serveHits.filter((h) => h.start <= IN_PART + 499999 && h.end >= IN_PART);
  check('part range served from disk (no net)', netHits.length === 0, JSON.stringify(serveHits));

  // a range straddling the done/undone boundary must return exact bytes —
  // the side is served from disk, the other from net or the prefetch pool
  // (which may have cached it already; either way the mix must be seamless)
  const STRADDLE = 2 * TD_TASK_BLOCK - 100;
  resp = await get(`bytes=${STRADDLE}-${STRADDLE + 999}`);
  check('straddle bytes exact', resp.body.equals(expected(STRADDLE, 1000)));

  // after the task finishes, the final file serves everything
  fs.renameSync(partFile, path.join(taskDir, 'IMG_1428.MP4'));
  try { fs.unlinkSync(sidecar); } catch { /* gone */ }
  serveHits = [];
  const AFTER = 20 * 1024 * 1024;
  resp = await get(`bytes=${AFTER}-${AFTER + 499999}`);
  check('final-file bytes exact', resp.body.equals(expected(AFTER, 500000)));
  check('final file served from disk', !serveHits.some((h) => h.start <= AFTER && h.end >= AFTER + 499999), JSON.stringify(serveHits));
  tasksStub.__setServeSessions([]);

  // ---- 7. HUD stats -----------------------------------------------------------
  // (before the link-validation section, which replaces the session)
  console.log('# stats');
  const s0 = stream.stats(sid, '0');
  check('stats shape', typeof s0.buffered === 'number' && typeof s0.total === 'number'
    && typeof s0.netBps === 'number' && typeof s0.active === 'number', JSON.stringify(s0));
  check('stats total matches file', s0.total === FILE_SIZE, String(s0.total));
  check('stats buffered within file', s0.buffered >= 0 && s0.buffered <= FILE_SIZE, String(s0.buffered));
  const sBad = stream.stats(sid, '99');
  check('stats rejects unknown file', !!sBad.error, JSON.stringify(sBad));
  const sWrong = stream.stats('deadbeef', '0');
  check('stats rejects unknown session', !!sWrong.error, JSON.stringify(sWrong));

  // ---- 8. link whitelist (the only user text that reaches tdl args) -----------
  console.log('# link validation');
  const linkCases = [
    ['https://t.me/HOTAVES/23006', true],
    ['https://t.me/c/1697797156/150/200', true],
    ['https://t.me/telegram/193?comment=360409', true],
    ['https://t.me/opencfdchannel/4434?thread=1485523', true],
    // http is deliberately refused: links are normalised to https
    ['http://t.me/tdl/1', false],
    ['ftp://t.me/tdl/1', false],
    ['https://evil.example/tdl/1', false],
    ['https://t.me.evil.example/tdl/1', false],
    ['https://user:pass@t.me/tdl/1', false],
    ['https://t.me:8443/tdl/1', false],
    ['https://t.me/../../etc/passwd', false],
    ['https://t.me/tdl/1; rm -rf /', false],
    ['https://t.me/tdl/$(whoami)', false],
    ['not a url', false],
  ];
  const bad = [];
  for (const [input, shouldPass] of linkCases) {
    const res = await stream.preview([input]);
    const passed = !!res.session;
    if (passed !== shouldPass) bad.push(`${input} -> ${passed ? 'accepted' : 'rejected'}`);
    if (passed) await stream.stop('');
  }
  check('link whitelist accepts only telegram message links', bad.length === 0, bad.join('; '));

  // a link that passes is rebuilt, not forwarded verbatim
  const rebuilt = await stream.preview(['https://t.me/HOTAVES/23006?thread=9']);
  check('accepted link is rebuilt from validated parts',
    !!rebuilt.session && rebuilt.session.urls.every((u) => /^https:\/\/t\.me\//.test(u)),
    JSON.stringify(rebuilt.session && rebuilt.session.urls));
  if (rebuilt.session) await stream.stop('');

  // ---- 9. stop ----------------------------------------------------------------
  console.log('# stop');
  const st = await stream.stop(sid);
  check('stop ok', st.ok === true);
  resp = await get('bytes=0-10').catch((e) => ({ err: String(e) }));
  check('play after stop fails', resp.status === 404 || resp.err, JSON.stringify(resp).slice(0, 120));

  gw.close();
  try { fakeServe.close(); } catch { /* gone */ }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
