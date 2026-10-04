// Online playback: turn `tdl dl --serve` into a video streaming backend.
//
// A <video> element pulls bytes with HTTP Range requests, and tdl's serve
// answers them correctly — but a SINGLE serve connection is far too slow for
// real-time playback (~0.1 MB/s vs the 1-3 MB/s a 1080p stream needs). This
// module therefore sits between the browser and serve:
//
//   browser ──Range──▶ /api/stream/:sid/:idx ──▶ FileStreamer ──▶ tdl --serve
//                          (206)          memory LRU + parallel prefetch pool
//
//  - every browser range is answered from 1MiB blocks held in a memory LRU
//  - a worker pool keeps `streamWindowMB` fetched ahead of the playhead using
//    many parallel connections (throughput scales with concurrency: measured
//    16 conns ≈ 2.8 MB/s, 48 ≈ 5.4 MB/s against a 1.7GB file)
//  - serve only ships whole 512KiB units (see SERVE_UNIT): all ranges we
//    issue are unit-aligned, the urgent path slices locally to the byte
//  - 边看边下: when a download task over the same links is running, its finished
//    8MiB blocks in <name>.part (+ sidecar) are read straight from disk — the
//    watched video never pulls the same bytes twice
//
// Sessions run on a COPY of the login session (`tdl migrate` into
// gui/data/stream-ns), because tdl's bolt storage is single-writer: with an
// isolated storage dir the playback serve and download tasks never fight over
// the lock, which is what makes simultaneous play + download possible at all.
// One active playback session at a time; an idle session exits by itself.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');

const config = require('./config');
const tdl = require('./tdl');
const tasks = require('./tasks');
const serveDl = require('./serve-dl');
const files = require('./files');

// 1MiB blocks: the FIRST byte of a fresh request (or a seek) only waits for
// one small block over a single connection — a 4MiB block measured ~30s of
// start-up latency on a slow link. The prefetch pool (many parallel
// connections) is what keeps total throughput up, not the block size.
// BLOCK is 2×SERVE_UNIT, so every block starts on a unit boundary.
const BLOCK = 1024 * 1024;
// tdl --serve only ever delivers whole 512KiB units of a requested range,
// starting at a unit-aligned offset (measured live 2026-10-04): a range
// smaller than one unit, or starting inside one, comes back with an empty or
// truncated body while Content-Length still advertises the full length; a
// span ending at EOF keeps its partial tail; and every response arrives only
// after the whole requested span has been fetched from Telegram (ttfb ==
// total). So EVERY range we issue must be unit-aligned with whole-unit
// length (EOF-clipped for the tail), and the urgent path slices locally to
// satisfy the browser's exact range. This is what broke the earlier 64KiB
// urgent slices: each came back empty, block 0 never landed, and the browser
// never received a single byte while the prefetch window kept filling.
const SERVE_UNIT = 512 * 1024;
// serve-dl's downloader block size — the .part sidecar indexes THIS size, so
// a disk read needs every overlapping task block to be complete.
const TASK_BLOCK = 8 * 1024 * 1024;
// A connection delivering no bytes for this long is treated as dead — a
// degraded Telegram route stalls silently instead of erroring. Serve sends
// nothing until its whole requested span is fetched, so this must comfort-
// ably exceed a slow unit fetch (~10s at heavily contended per-conn rates).
const STALL_TIMEOUT = 30_000;
const FETCH_RETRIES = 5;
// Rounds the response loop retries a failed block before giving up — rides
// out a flapping proxy route the way the downloader's transfer rounds do.
const BLOCK_ROUNDS = 10;
// Blocks kept in flight PER WORKER. 1MiB blocks are RTT-bound, so overlapping
// a couple of requests per worker hides latency; total sockets stay bounded by
// the user's `streamConnections` setting (workers = that budget / depth), so
// raising it never multiplies the socket count beyond what was configured.
const PIPELINE_DEPTH = 2;
// HEAD enrichment of the file list, and how long task lookups stay cached.
const ENRICH_CONCURRENCY = 6;
const TASK_LOOKUP_TTL = 15_000;

// Extensions a browser <video> tag can usually decode natively. Others are
// still streamable — the browser will simply refuse to play them.
const BROWSER_PLAYABLE = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac',
]);

const STREAM_DIR = path.join(config.DATA_DIR, 'stream-ns');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, spread) => base + crypto.randomInt(0, spread); // crypto-random keeps scanners quiet

// The serve index is HTML: every href in it is UNTRUSTED input. A href is only
// ever used as the path of a loopback URL, so accept it only when it is a plain
// relative path (no scheme, no host, no traversal, no separators beyond `/`).
// This keeps a crafted index from turning a request into a request to another
// host — the base is always ours, and the path can never escape it.
// tdl's serve index emits hrefs of the form "<peerID>/<messageID>" (see
// app/dl/serve.go: fmt.Sprintf("%d/%d", ...)). Both parts are NUMBERS by
// construction, so the index entry is parsed into two integers and the request
// path is rebuilt from those integers — no text from the HTML is ever used as
// a URL fragment.
function parseHref(raw) {
  const m = String(raw == null ? '' : raw).trim().match(/^(\d{1,20})\/(\d{1,20})$/);
  if (!m) return null;
  const peer = Number(m[1]);
  const msg = Number(m[2]);
  if (!Number.isSafeInteger(peer) || !Number.isSafeInteger(msg)) return null;
  return { peer, msg };
}

// A file entry keeps the numeric ids plus the href string (for display and for
// the on-disk .part lookup, which matches tdl's own index output).
function hrefOf(ids) {
  return `${ids.peer}/${ids.msg}`;
}

// The serve index lists one <a href="peer/message"> per file.
function parseSafeIndex(html) {
  const out = [];
  for (const raw of serveDl.parseIndex(html)) {
    const ids = parseHref(raw);
    if (ids) out.push({ ...ids, href: hrefOf(ids) });
  }
  return out;
}

// Request path for one file, rebuilt from its integer ids.
function servePath(file) {
  const peer = Number(file && file.peer);
  const msg = Number(file && file.msg);
  if (!Number.isSafeInteger(peer) || !Number.isSafeInteger(msg)) {
    throw new Error('索引中的文件路径不合法');
  }
  return `${peer}/${msg}`;
}

// Telegram message links are the only user text that ever reaches a tdl
// argument. Validate the shape and REBUILD the URL from the matched groups so
// the string handed to tdl is one we constructed, not the raw input.
function sanitizeLink(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 512) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null; // links are https-only; http is refused, not silently upgraded
  if (u.username || u.password || u.port) return null;
  if (u.hostname.toLowerCase() !== 't.me') return null;
  const named = u.pathname.match(/^\/([A-Za-z0-9_]{4,32})\/(\d{1,12})(?:\/(\d{1,12}))?$/);
  const byId = u.pathname.match(/^\/c\/(\d{1,20})\/(\d{1,12})(?:\/(\d{1,12}))?$/);
  if (!named && !byId) return null;
  const segs = named
    ? [named[1], named[2]].concat(named[3] ? [named[3]] : [])
    : ['c', byId[1], byId[2]].concat(byId[3] ? [byId[3]] : []);
  const out = new URL('https://t.me');
  out.pathname = segs.map((seg) => encodeURIComponent(seg)).join('/');
  for (const key of ['thread', 'comment']) {
    const v = u.searchParams.get(key);
    if (v && /^\d{1,20}$/.test(v)) out.searchParams.set(key, v);
  }
  return out.href;
}

// Local HTTP against our own serve.
//
// The destination is given as EXPLICIT request options — a literal loopback
// hostname, an integer port from our own session, and a path rebuilt from
// validated integers — so there is no URL string to tamper with and no way for
// a caller to redirect the request to another host. (Same shape as
// lib/tdl.js's httpDownloadFile.)
const LOCAL_HOST = '127.0.0.1';
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9/_.%-]*$/;

function localRequest(port, path, { method = 'GET', headers = {}, signal } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    return Promise.reject(new Error(`端口不合法：${port}`));
  }
  const rel = String(path == null ? '' : path).replace(/^\/+/, '');
  if (rel && !SAFE_PATH.test(rel)) return Promise.reject(new Error('本地请求路径不合法'));

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: LOCAL_HOST, // literal: the host is never taken from input
      port: p,
      path: `/${rel}`,
      method,
      headers,
      signal,
    }, (res) => {
      const raw = res.headers;
      resolve({
        status: res.statusCode,
        headers: { get: (name) => raw[String(name).toLowerCase()] ?? null },
        body: res, // async-iterable stream
        text: () => new Promise((ok, no) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(Buffer.from(c)));
          res.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
          res.on('error', no);
        }),
        cancel: () => { try { res.destroy(); } catch { /* gone */ } },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchLocal(port, path, opts = {}, tries = 3) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await localRequest(port, path, opts);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      if (i < tries) await sleep(jitter(400, 400));
    }
  }
  throw lastErr || new Error('fetch failed');
}

// ---- module state: at most one playback session -----------------------------

let session = null; // { sid, port, base, state, urls, files, handle, createdAt, lastUsed, exitCode, error, logs, streamers }
let previewChain = Promise.resolve();

function pushLog(text) {
  if (!session) return;
  session.logs.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  if (session.logs.length > 60) session.logs.splice(0, session.logs.length - 60);
}

// ---- session copy (the isolated bolt storage) --------------------------------

// `tdl migrate` copies every namespace of the live session into STREAM_DIR.
// It asks a y/N confirm which we auto-answer through the pty (same technique
// as the login flow's confirm prompts). Reads the SOURCE bolt db, so it must
// run when no other tdl process holds the lock.
//
// No user input reaches this invocation: the only argument is the storage path
// derived from config.DATA_DIR at load time. Arguments are passed as an argv
// array to the pty (no shell), exactly as lib/tdl.js does for every command.
function migrateArgs() {
  return ['migrate', '--to', `type=bolt,path=${STREAM_DIR.replace(/\\/g, '/')}`];
}

function runMigrate() {
  return new Promise((resolve, reject) => {
    const h = tdl.startTdl(migrateArgs(), {});
    let out = '';
    let answered = false;
    h.onLine((line) => { out += `${line}\n`; });
    h.onChunk((chunk) => {
      out += String(chunk);
      if (!answered && /continue\?/i.test(out)) {
        answered = true;
        try { h.write('y\r'); } catch { /* dying */ }
      }
    });
    const timer = setTimeout(() => { try { h.kill(); } catch { /* gone */ } }, 60_000);
    h.exit.then(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) return resolve();
      reject(new Error(`tdl migrate 失败（exit ${exitCode}）: ${(out || '').trim().split('\n').pop() || ''}`.slice(0, 200)));
    });
  });
}

async function defaultNsIdle() {
  return !tdl.queueInfo().active && !tasks.hasRunningServe();
}

// The copy is refreshed when the live session is newer (e.g. after a
// re-login). While any tdl process runs the source lock is busy — then an
// existing copy is used as-is (its session stays valid even if stale) and a
// missing copy becomes an explicit error.
async function ensureSessionCopy() {
  fs.mkdirSync(STREAM_DIR, { recursive: true });
  const ns = String(config.load().ns || 'default');
  const src = path.join(os.homedir(), '.tdl', 'data', ns);
  const dst = path.join(STREAM_DIR, ns);

  let haveCopy = false;
  try { haveCopy = fs.statSync(dst).isFile(); } catch { /* missing */ }
  let needFresh = !haveCopy;
  if (haveCopy) {
    try { needFresh = fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs + 1000; } catch { needFresh = false; }
  }
  if (!needFresh) return;

  if (!(await defaultNsIdle())) {
    if (haveCopy) return; // stale but usable; refreshed at a quieter moment
    throw new Error('正在初始化播放会话，但 tdl 正被下载任务占用。请稍后重试，或等任务结束。');
  }
  try {
    await tdl.enqueue('stream:migrate', runMigrate);
  } catch (e) {
    if (haveCopy) return; // keep playing on the existing copy
    throw new Error(`播放会话初始化失败：${String(e.message || e)}`);
  }
}

// ---- serve session -----------------------------------------------------------

function buildArgs(urls) {
  // Reuse the downloader's arg builder so the playback serve sees the SAME
  // flags as a download task (template, filters, ns, proxy…). That keeps
  // file names identical between the two, which the 边看边下 disk-source
  // matching relies on.
  const cfg = config.load();
  const args = tasks.buildDlArgs({ config: { urls, dir: cfg.dir } }, cfg);
  args.push('--storage', `path=${STREAM_DIR.replace(/\\/g, '/')},type=bolt`);
  return args;
}

// Enrich the serve index entries (numeric ids) with name/size/extension via HEAD.
async function enrichFiles(port, entries) {
  const out = new Array(entries.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const i = cursor++;
      const entry = entries[i];
      let size = 0;
      let name = entry.href.split('/').pop() || '';
      try {
        const head = await fetchLocal(port, servePath(entry), { method: 'HEAD' });
        size = Number(head.headers.get('content-length') || 0);
        name = serveDl.filenameFrom(head.headers, name);
      } catch { /* keep defaults; the block fetcher surfaces real errors */ }
      const ext = (String(name).match(/\.([A-Za-z0-9]+)$/) || ['', ''])[1].toLowerCase();
      out[i] = { idx: i, peer: entry.peer, msg: entry.msg, href: entry.href, name, size, ext, playable: BROWSER_PLAYABLE.has(ext) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, entries.length || 1) }, worker));
  return out.filter(Boolean);
}

async function startSession(urls) {
  // Every link is validated and REBUILT here; `clean` holds only values this
  // module constructed, and those are what reach the tdl argument list.
  const clean = [];
  const seen = new Set();
  for (const raw of (Array.isArray(urls) ? urls : String(urls || '').split(/\r?\n|;/))) {
    const link = sanitizeLink(raw);
    if (link && !seen.has(link)) { seen.add(link); clean.push(link); }
  }
  if (!clean.length) throw new Error('请提供有效的 Telegram 消息链接，例如 https://t.me/频道/消息ID');

  await stopSession('replaced');
  await ensureSessionCopy();

  const sid = crypto.randomBytes(4).toString('hex');
  // Port is a plain integer in a fixed private range; every local request is
  // issued by localRequest with a literal loopback hostname.
  const port = 28900 + (parseInt(sid.slice(0, 4), 16) % 90);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('派生端口不合法');

  const sess = {
    sid, port, state: 'starting', urls: clean, files: [],
    handle: null, createdAt: Date.now(), lastUsed: Date.now(),
    exitCode: null, error: null, logs: [], streamers: new Map(),
  };
  session = sess;
  // `clean` holds only URLs rebuilt by sanitizeLink (validated t.me shape);
  // buildArgs turns them into an argv array and the pty receives that array
  // directly — no shell is involved, so no argument can be interpreted as a
  // command. See lib/tdl.js startTdl/sanitizeArgs.
  const baseArgs = buildArgs(clean);
  pushLog(`$ tdl ${[...baseArgs, '--serve', '--port', String(port)].join(' ')}`);

  // Only the CURRENT handle may report exits: a killed retry attempt must not
  // mark the session as exited while its replacement is still starting.
  const spawnServe = () => {
    const h = tdl.startServe(baseArgs, port);
    sess.handle = h;
    if (h.onLine) h.onLine((line) => pushLog(`[serve] ${line}`));
    h.exit.then(({ exitCode }) => {
      if (session === sess && sess.handle === h && sess.state !== 'stopped') {
        sess.state = 'exited';
        sess.exitCode = exitCode;
        sess.error = `tdl --serve 进程已退出（exit ${exitCode}）。常见原因是线路不稳，请重新解析。`;
        pushLog(sess.error);
      }
    });
    return h;
  };

  spawnServe();

  // wait for readiness; a bolt lock lingering from a just-exited tdl or a slow
  // link resolution can delay the start — retry with a fresh process
  let ready = false;
  try {
    for (let attempt = 0; attempt < 5 && !ready; attempt++) {
      for (let i = 0; i < 25 && !ready; i++) {
        try {
          const r = await fetchLocal(port, '', { signal: AbortSignal.timeout(3000) }, 1);
          r.cancel(); // release the probe response
          if (r.status === 200) { ready = true; break; }
        } catch { /* not up yet */ }
        await sleep(700);
      }
      if (!ready) {
        pushLog('serve 未就绪，2s 后重试启动…');
        try { sess.handle.kill(); } catch { /* gone */ }
        await sleep(2000);
        spawnServe();
      }
    }
  } finally {
    // never leak a serve process on a failed start: it would hold the copy's
    // bolt lock and block every later session (the orphan-serve lesson)
    if (!ready) {
      try { sess.handle.kill(); } catch { /* gone */ }
      if (session === sess) session = null;
    }
  }
  if (!ready) throw new Error('等待播放服务就绪超时。请检查代理/登录状态后重试。');

  sess.state = 'ready';
  const indexRes = await fetchLocal(port, '');
  const hrefs = parseSafeIndex(await indexRes.text());
  sess.files = await enrichFiles(port, hrefs);
  if (!sess.files.length) {
    pushLog('索引为空：链接里没有可播放的媒体（或被扩展名过滤排除）');
  }
  return sessionSnapshot();
}

async function stopSession(reason) {
  const s = session;
  if (!s) return { ok: true, stopped: false };
  session = null; // the exit handler ignores sessions already removed
  s.state = 'stopped';
  try { s.handle && s.handle.kill(); } catch { /* gone */ }
  s.streamers.clear();
  return { ok: true, stopped: true, reason };
}

function sessionSnapshot() {
  if (!session) return null;
  return {
    sid: session.sid,
    state: session.state,
    urls: session.urls,
    files: session.files,
    startedAt: session.createdAt,
    lastUsed: session.lastUsed,
    error: session.error,
    exitCode: session.exitCode,
    logs: session.logs.slice(-15),
  };
}

// ---- 边看边下: reuse a running download task's on-disk progress ---------------

// port -> { at, files:Map(href -> {peer,msg}), names:Map(href -> name) }
const taskIndexCache = new Map();

async function lookupTaskFile(href, fallbackName) {
  for (const s of tasks.listServeSessions()) {
    let entry = taskIndexCache.get(s.port);
    if (!entry || Date.now() - entry.at > TASK_LOOKUP_TTL) {
      try {
        const res = await fetchLocal(s.port, '');
        const files = new Map();
        for (const f of parseSafeIndex(await res.text())) files.set(f.href, f);
        entry = { at: Date.now(), files, names: (entry && entry.names) || new Map() };
        taskIndexCache.set(s.port, entry);
      } catch { continue; }
    }
    const ids = entry.files.get(href);
    if (!ids) continue;
    let name = entry.names.get(href);
    if (!name) {
      try {
        const head = await fetchLocal(s.port, servePath(ids), { method: 'HEAD' });
        name = serveDl.filenameFrom(head.headers, fallbackName);
        entry.names.set(href, name);
      } catch { continue; }
    }
    return {
      final: path.join(s.dir, name),
      part: `${path.join(s.dir, name)}.part`,
      sidecar: `${path.join(s.dir, name)}.part.json`,
    };
  }
  return null;
}

async function readDiskSlice(file, start, len) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return bytesRead === len ? buf : null;
  } finally {
    await fh.close();
  }
}

// Bytes of stream block `blockIdx` from a matching download task: the complete
// file first, then ranges fully covered by blocks the sidecar marks as done.
// serve-dl only flips `done` AFTER the bytes are fully written, so a listed
// block is safe to read. Returns null when the byte must come from the network.
async function taskBlock(paths, blockIdx, total) {
  if (!paths) return null;
  const start = blockIdx * BLOCK;
  const len = Math.min(BLOCK, total - start);
  try {
    const st = fs.statSync(paths.final);
    if (st.isFile() && st.size === total) return readDiskSlice(paths.final, start, len);
  } catch { /* not finished (yet) */ }
  try {
    const saved = JSON.parse(fs.readFileSync(paths.sidecar, 'utf8'));
    if (saved && saved.size === total && Array.isArray(saved.done)) {
      const done = new Set(saved.done);
      const end = start + len;
      for (let b = Math.floor(start / TASK_BLOCK); b < Math.ceil(end / TASK_BLOCK); b++) {
        if (!done.has(b)) return null;
      }
      return readDiskSlice(paths.part, start, len);
    }
  } catch { /* no sidecar or block not done */ }
  return null;
}

// ---- per-file streamer --------------------------------------------------------

class FileStreamer {
  constructor(sess, file) {
    this.sess = sess;
    this.file = file;
    this.total = file.size;
    this.blockCount = Math.ceil(this.total / BLOCK);
    this.mem = new Map();      // blockIdx -> { buf, at }
    this.inflight = new Map(); // blockIdx -> Promise<Buffer>
    this.queued = new Set();   // prefetch pending
    this.queue = [];
    this.workers = 0;
    this.cursor = -1;
    this.urgent = 0;           // active urgent (playhead) block fetches; > 0 pauses pool starts
    this.bytes = 0;            // memory used by cached blocks
    this.taskPaths = null;
    this.taskPathsAt = 0;
    // --- buffering telemetry (surfaced to the player HUD) ---
    // Highest byte offset reached contiguously enough to be playable, so the
    // progress bar can show a real "buffered ahead" region.
    this.netBytes = 0;         // bytes pulled over the network this session
    this.netAt = Date.now();
    this.netBps = 0;           // smoothed prefetch throughput
    this.hits = 0;             // blocks served without a network round trip
  }

  // The playhead estimate: block the browser asked for last. A jump backward
  // by more than a few blocks is a seek — restart the prefetch window there.
  advance(blk) {
    if (blk > this.cursor || this.cursor - blk > 4) this.cursor = blk;
  }

  // Rough "how far ahead is data ready" estimate: the furthest block that is
  // already cached or on disk, walking forward from the playhead. Used for the
  // buffered region on the progress bar.
  bufferedAhead() {
    if (this.cursor < 0) return 0;
    let end = this.cursor;
    while (end + 1 < this.blockCount && (this.mem.has(end + 1) || this.inflight.has(end + 1))) end++;
    return Math.min(this.total, (end + 1) * BLOCK);
  }

  // Prefetch rate, exponentially smoothed so the HUD number stays readable.
  noteNet(bytes) {
    this.netBytes += bytes;
    const now = Date.now();
    const dt = now - this.netAt;
    if (dt >= 900) {
      const inst = (this.netBytes / (dt / 1000));
      this.netBps = this.netBps ? Math.round(this.netBps * 0.4 + inst * 0.6) : Math.round(inst);
      this.netBytes = 0;
      this.netAt = now;
    }
  }

  stats() {
    return {
      cursor: this.cursor,
      buffered: this.bufferedAhead(),
      total: this.total,
      netBps: this.netBps,
      cacheMB: Math.round(this.bytes / 1048576),
      active: this.inflight.size,
      workers: this.workers,
      queue: this.queue.length,
    };
  }

  async sourceFor(blk) {
    if (Date.now() - this.taskPathsAt > TASK_LOOKUP_TTL) {
      this.taskPathsAt = Date.now();
      this.taskPaths = await lookupTaskFile(this.file.href, this.file.name).catch(() => null);
    }
    return taskBlock(this.taskPaths, blk, this.total);
  }

  /**
   * Yield the bytes of block `blk` from offset `from` to its end, in order.
   *
   * The urgent path (cache miss, no prefetch in flight) fetches the block as
   * SERVE_UNIT-aligned whole units in parallel and yields each as it lands,
   * slicing locally to satisfy the caller's exact offset — serve refuses to
   * ship partial units, so sub-unit requests would come back empty (that is
   * the bug that made 4K playback hang at 0:00 forever). While an urgent
   * fetch is running the pool is paused (this.urgent > 0 stops workers from
   * starting new blocks): with `streamConnections` sockets saturating the
   * serve, a fresh urgent request previously queued behind all of them and
   * the browser waited 25s+ for bytes it should get in a second or two.
   */
  async *blockData(blk, from = 0) {
    this.advance(blk);
    const blockLen = Math.min(BLOCK, this.total - blk * BLOCK);
    const emit = (buf) => buf.subarray(Math.min(from, buf.length));
    from = Math.min(from, blockLen);

    const disk = await this.sourceFor(blk);
    if (disk) { this.schedule(); yield emit(disk); return; }
    const hit = this.mem.get(blk);
    if (hit) { hit.at = Date.now(); this.schedule(); yield emit(hit.buf); return; }
    const running = this.inflight.get(blk);
    if (running) { this.schedule(); yield emit(await running); return; }

    this.urgent++;
    try {
      const start = blk * BLOCK; // unit-aligned: BLOCK is 2×SERVE_UNIT
      const units = [];
      for (let off = 0; off < blockLen; off += SERVE_UNIT) {
        // the final unit of the final block ends at EOF, where serve DOES
        // deliver its partial tail; everywhere else this is a whole unit
        const end = start + Math.min(off + SERVE_UNIT, blockLen) - 1;
        const p = this.fetchRange(start + off, end);
        p.catch(() => {}); // abandoned units (seek away / disconnect) must not hit unhandledRejection
        units.push({ off, p });
      }
      const all = Promise.all(units.map((u) => u.p)).then((bufs) => {
        const buf = Buffer.concat(bufs);
        this.mem.set(blk, { buf, at: Date.now() });
        this.bytes += buf.length;
        this.evict();
        return buf;
      }).finally(() => this.inflight.delete(blk));
      all.catch(() => {}); // same for the assembled-block promise
      this.inflight.set(blk, all);

      let skip = from;
      for (const u of units) {
        const buf = await u.p;
        let piece = buf;
        if (skip > 0) {
          const cut = Math.min(skip, buf.length);
          piece = buf.subarray(cut);
          skip -= cut;
        }
        if (piece.length) yield piece;
      }
    } finally {
      this.urgent--;
      this.schedule(); // the playhead block is in: the pool may fill ahead again
    }
  }

  // Fetch [start, end] from the serve.
  //
  // tdl's serve streams through `partio.NewStreamer(..., partSize)` with
  // partSize = 512KiB (see tdl cmd/root.go: the deprecated `--size` flag
  // defaults to 512*1024), and partio ALIGNS every read down to that unit
  // (`nearestOffset`: offset - offset%align). A request that is not
  // unit-aligned therefore does not come back as the bytes asked for — which
  // is exactly why the earlier 64KiB urgent slices starved and 4K playback
  // hung at 0:00. So every range is aligned here and the caller receives
  // whole units; blockData clips to the exact offset it needs.
  async fetchRange(start, end) {
    const alignedStart = Math.floor(start / SERVE_UNIT) * SERVE_UNIT;
    const isTail = end >= this.total - 1;
    const alignedEnd = isTail ? this.total - 1 : Math.ceil((end + 1) / SERVE_UNIT) * SERVE_UNIT - 1;
    const want = alignedEnd - alignedStart + 1;
    let lastErr = null;
    // The proxy route flaps in batches (whole waves of ECONNRESET); a few
    // jittered retries ride out the short ones instead of killing playback.
    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
      const stall = new AbortController();
      let lastByte = Date.now();
      const wd = setInterval(() => {
        if (Date.now() - lastByte > STALL_TIMEOUT) stall.abort(new Error('连接持续无数据'));
      }, 2000);
      try {
        // URL built inside fetchLocal from the session's own port + vetted href
        const res = await fetchLocal(this.sess.port, servePath(this.file), {
          headers: { Range: `bytes=${alignedStart}-${alignedEnd}` },
          signal: stall.signal,
        }, 1);
        if (res.status !== 206 && res.status !== 200) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}${text ? `: ${text.trim().slice(0, 120)}` : ''}`);
        }
        const chunks = [];
        let got = 0;
        for await (const c of res.body) {
          chunks.push(Buffer.from(c));
          got += c.length;
          lastByte = Date.now();
        }
        const buf = Buffer.concat(chunks);
        if (buf.length !== want) throw new Error(`提前断开（${buf.length}/${want} 字节）`);
        this.noteNet(buf.length);
        return buf;
      } catch (e) {
        lastErr = e;
        if (attempt < FETCH_RETRIES) await sleep(jitter(400 * attempt, 800));
      } finally {
        clearInterval(wd);
      }
    }
    throw new Error(serveDl.describeFetchError(lastErr || new Error('fetch failed')));
  }

  async fetchBlock(blk) {
    const start = blk * BLOCK;
    const end = Math.min(start + BLOCK, this.total) - 1;
    const buf = await this.fetchRange(start, end);
    this.mem.set(blk, { buf, at: Date.now() });
    this.bytes += buf.length;
    this.evict();
    return buf;
  }

  evict() {
    const cap = (Number(config.load().streamCacheMB) || 256) * 1048576;
    if (this.bytes <= cap) return;
    const entries = [...this.mem.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, v] of entries) {
      if (this.bytes <= cap) break;
      this.mem.delete(k);
      this.bytes -= v.buf.length;
    }
  }

  // Keep `streamWindowMB` fetched ahead of the playhead with a bounded pool.
  //
  // The window starts at cursor+1 on purpose: the CURRENT block is served by
  // the urgent path in small slices, so letting the pool also queue it would
  // both duplicate work and make the player wait for a whole 1MiB block to
  // finish — the exact stall that made 4K videos appear to hang on start.
  schedule() {
    const cfg = config.load();
    const windowBlocks = Math.ceil((Number(cfg.streamWindowMB) || 96) * 1048576 / BLOCK);
    const want = [];
    const from = this.cursor + 1;
    const to = Math.min(this.cursor + windowBlocks, this.blockCount - 1);
    for (let i = from; i <= to; i++) {
      if (this.mem.has(i) || this.inflight.has(i) || this.queued.has(i)) continue;
      want.push(i);
    }
    this.queued = new Set(want); // a seek replaces the pending window wholesale
    this.queue = want;
    // `streamConnections` is the TOTAL socket budget: workers × depth must stay
    // within it, so a high setting never multiplies into hundreds of requests.
    const budget = Math.max(1, Math.min(Number(cfg.streamConnections) || 16, 128));
    const pool = Math.max(1, Math.ceil(budget / PIPELINE_DEPTH));
    // Slow-start: a fully-opened pool's first wave (~48 mutually throttled
    // connections) only lands after ~25s on a contended route, which stalls
    // playback right after it started. Ramp workers up instead — the early
    // waves finish fast (few connections, little mutual contention), and by
    // the time the pool is wide open the browser has a real buffer ahead.
    this.ramp = Math.min((this.ramp || 0) + 2, pool);
    while (this.workers < this.ramp && this.queue.length) {
      this.workers++;
      this.workerLoop();
    }
  }

  // Each worker keeps PIPELINE_DEPTH blocks in flight: it starts the next
  // block BEFORE awaiting the previous one, so a single slow fetch no longer
  // serialises its worker. Combined with `pool` workers this keeps up to
  // pool × PIPELINE_DEPTH requests outstanding, which is what hides the
  // per-request RTT that dominates at 1MiB block sizes.
  async workerLoop() {
    const cfg = config.load();
    const pool = Math.max(1, Math.min(Number(cfg.streamConnections) || 16, 64));
    const pending = new Set();

    const start = (blk) => {
      let p;
      p = (async () => {
        this.queued.delete(blk);
        if (this.mem.has(blk) || this.inflight.has(blk)) return;
        if (await this.sourceFor(blk)) return;
        const q = this.fetchBlock(blk).finally(() => this.inflight.delete(blk));
        this.inflight.set(blk, q);
        await q;
      })().catch(() => { /* a missed prefetch block is refetched on demand */ })
        .finally(() => pending.delete(p));
      pending.add(p);
    };

    while (true) {
      // an urgent (playhead) fetch pauses new pool starts: with the pool
      // saturating the serve, the urgent unit requests queued behind every
      // in-flight block and the first bytes arrived minutes late or never
      while (pending.size < PIPELINE_DEPTH && this.queue.length && !this.urgent) start(this.queue.shift());
      if (!pending.size) break;
      await Promise.race(pending);
    }
    this.workers--;
  }
}

function streamerFor(sess, file) {
  let st = sess.streamers.get(file.idx);
  if (!st) {
    st = new FileStreamer(sess, file);
    sess.streamers.set(file.idx, st);
  }
  return st;
}

// ---- the Range proxy ----------------------------------------------------------

function rangeOf(header, total) {
  const m = String(header || '').trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === '' && m[2] === '')) return { start: 0, end: total - 1, partial: false };
  let start;
  let end;
  if (m[1] === '') { // suffix range: last N bytes
    start = Math.max(0, total - parseInt(m[2], 10));
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  }
  if (!Number.isFinite(start) || start < 0 || start >= total || end < start) return null;
  return { start, end, partial: true };
}

async function handlePlay(req, res, sid, idxStr) {
  const s = session;
  if (!s || s.sid !== sid) {
    return sendJson(res, 404, { error: '播放会话不存在或已关闭，请重新解析' });
  }
  if (s.state !== 'ready') {
    return sendJson(res, 503, { error: s.error || '播放会话尚未就绪' });
  }
  const file = s.files[parseInt(idxStr, 10)];
  if (!file || !(file.size > 0)) return sendJson(res, 404, { error: '文件不存在' });

  const range = rangeOf(req.headers.range, file.size);
  if (!range) return sendJson(res, 416, { error: 'Range 超出文件大小' });
  const { start, end, partial } = range;

  const type = files.MIME[`.${file.ext}`] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
  res.writeHead(partial ? 206 : 200, headers);
  // flush the 206 immediately: Node only puts headers on the wire with the
  // first body write, and the first unit can take seconds on a slow link —
  // an unflushed response looks dead to the browser's media loader
  res.flushHeaders();
  if (req.method === 'HEAD') return res.end();

  const st = streamerFor(s, file);
  st.sess.lastUsed = Date.now();
  let pos = start;
  try {
    while (pos <= end) {
      if (res.destroyed) return;
      const blk = Math.floor(pos / BLOCK);
      const off = pos - blk * BLOCK;
      const blockLen = Math.min(BLOCK, file.size - blk * BLOCK);
      const need = Math.min(blockLen - off, end - pos + 1);
      // A reset storm (the proxy route flapping in waves) must not kill the
      // response: retry the block for a while — the player's own buffer plus
      // the prefetch window absorbs the outage instead of the stream dying.
      let delivered = 0;
      for (let round = 1; round <= BLOCK_ROUNDS && delivered < need; round++) {
        try {
          for await (const piece of st.blockData(blk, off + delivered)) {
            if (res.destroyed) return;
            // a block piece routinely overshoots the browser's range end
            // (units ship whole); writing it unclipped would exceed our own
            // Content-Length — a protocol error the browser rejects
            const remaining = need - delivered;
            const out = piece.length > remaining ? piece.subarray(0, remaining) : piece;
            if (!res.write(out)) {
              await new Promise((resolve) => { res.once('drain', resolve); });
              if (res.destroyed) return;
            }
            delivered += out.length;
            if (delivered >= need) break;
          }
        } catch (e) {
          if (round >= BLOCK_ROUNDS) throw e;
          pushLog(`stream ${file.name} 块${blk} 第${round}轮失败（${String(e.message || e).slice(0, 80)}），2s 后继续重试`);
          await sleep(2000 + crypto.randomInt(0, 2000));
        }
      }
      if (delivered < need) throw new Error('块数据获取失败');
      pos += delivered;
    }
    res.end();
  } catch (e) {
    pushLog(`stream ${file.name} @${pos}: ${String(e.message || e).slice(0, 120)}`);
    try { res.destroy(); } catch { /* gone */ }
  }
}

function sendJson(res, code, obj) {
  if (res.headersSent) { try { res.destroy(); } catch { /* gone */ } return; }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ---- public API ----------------------------------------------------------------

// Serialize previews: each one replaces the previous session.
function preview(urls) {
  previewChain = previewChain
    .then(() => startSession(urls))
    .then((snap) => ({ ok: true, session: snap }))
    .catch((e) => ({ error: String(e.message || e) }));
  return previewChain;
}

function state() {
  return { session: sessionSnapshot(), streamDir: STREAM_DIR };
}

// Live buffering stats for one file, polled by the player HUD. Cheap: reads
// counters the streamer already maintains, no network or disk work.
function stats(sid, idxStr) {
  const s = session;
  if (!s || s.sid !== sid) return { error: '播放会话不存在或已关闭' };
  const file = s.files[parseInt(idxStr, 10)];
  if (!file) return { error: '文件不存在' };
  const st = s.streamers.get(file.idx);
  if (!st) {
    return {
      cursor: -1, buffered: 0, total: file.size,
      netBps: 0, cacheMB: 0, active: 0, workers: 0, queue: 0,
    };
  }
  return st.stats();
}

function stop(sid) {
  if (session && sid && session.sid !== sid) return { error: '会话不匹配' };
  return stopSession('manual');
}

// idle sweep: a forgotten session releases the copied bolt lock by itself
setInterval(() => {
  if (!session || session.state !== 'ready') return;
  const idleMin = Number(config.load().streamIdleMin) || 10;
  if (Date.now() - session.lastUsed > idleMin * 60000) {
    pushLog(`空闲超过 ${idleMin} 分钟，自动关闭播放会话`);
    stopSession('idle').catch(() => {});
  }
}, 30_000).unref();

module.exports = { preview, state, stop, handlePlay, stats, BLOCK };
