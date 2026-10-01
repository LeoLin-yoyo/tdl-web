// tdl.exe runner — everything goes through a ConPTY via node-pty.
//
// Why a pty for every invocation:
//   1. tdl's interactive login (phone / code / 2FA password prompts) requires a
//      real terminal; with plain pipes the survey prompts fail immediately.
//   2. tdl renders its progress table whether or not stdout is a tty, so the
//      same ANSI-stripping parser serves both interactive and batch runs.
//   3. Arguments travel as a sanitized argv array — never through a shell.
//
// tdl stores sessions/resume state in a single bolt database which allows only
// ONE writer process at a time, so every invocation must go through the global
// queue below — never start tdl from anywhere else in this codebase.

const path = require('node:path');
const pty = require('node-pty');

const TDL_PATH = global.TDL_PATH || 'tdl.exe';
// Wide enough that tdl's per-file line (which ends with the absolute
// destination path) is not truncated by go-pretty's message column.
const PTY_COLS = 400;
const PTY_ROWS = 40;

// ---- global serial queue ------------------------------------------------
let queueTail = Promise.resolve();
let queueActive = null; // {name, startedAt}

function enqueue(name, fn) {
  const run = queueTail.then(() => {
    queueActive = { name, startedAt: Date.now() };
    return fn();
  }).finally(() => {
    queueActive = null;
  });
  // keep the chain alive regardless of individual failures
  queueTail = run.catch(() => {});
  return run;
}

function queueInfo() {
  return { active: queueActive ? queueActive.name : null, startedAt: queueActive ? queueActive.startedAt : null };
}

// ---- text helpers ---------------------------------------------------------

// Strip ANSI/VT sequences (CSI, OSC with BEL or ST terminator, simple escapes).
function stripAnsi(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\u001B') {
      const c1 = s[i + 1];
      if (c1 === '[') { // CSI: parameters + final byte
        i += 2;
        while (i < n && !(/[A-Za-z@]/.test(s[i]))) i++;
        i++; // consume final byte
        continue;
      }
      if (c1 === ']') { // OSC: terminated by BEL or ST (ESC \)
        const bel = s.indexOf('\u0007', i);
        const st = s.indexOf('\u001B\\', i);
        if (bel === -1 && st === -1) { i = n; continue; }
        i = (bel !== -1 && (st === -1 || bel < st)) ? bel + 1 : st + 2;
        continue;
      }
      i += 2; // two-byte escape sequence
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Arguments are handed to the pty as an argv array (no shell ever involved).
 * We additionally strip NUL/control characters so a crafted value cannot
 * confuse the argv parser of the child process.
 */
function sanitizeArgs(args) {
  return args.map((a) => String(a).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));
}

// Parse go-pretty size strings: "640.00KB", "1.00MB", "380 B"
const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
function parseSize(s) {
  const m = String(s).trim().match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * SIZE_UNITS[m[2].toUpperCase()]);
}

// Parse go-pretty duration strings: "2.011s", "1m20s", "1h2m3s", "500ms"
function parseDurationMs(s) {
  const m = String(s).trim().match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/);
  if (!m) return 0;
  const [, h, mi, sec, ms] = m;
  return (+h || 0) * 3600000 + (+mi || 0) * 60000 + (parseFloat(sec) || 0) * 1000 + (+ms || 0);
}

// One line of the go-pretty progress table (see gui/probe for format research):
//   active: "MESSAGE    ...  64.0% [#####...] [640.00KB in 1.701s; ~ETA: 2s; 376.30KB/s]"
//   done:   "MESSAGE    ... done! [1.00MB in 2.011s; 476.12KB/s]"
//   failed: "MESSAGE    ... failed!"
//   overall:[#...] [2s; ...]  (ignored)
const RE_DONE = /^(.*?)\s*\.{0,3}\s*done!\s*\[([\d.]+\s*\w+B) in ([^;]+)(?:;\s*([^\]]+))?\]\s*$/;
const RE_FAILED = /^(.*?)\s*\.{0,3}\s*failed!\s*\[([^\]]*)\]\s*$/;
const RE_PROG = /^(.*?)\s*\.{0,3}\s*([\d.]+)%\s*\[[#.\s]*\]\s*\[(.+?) in ([^;]+); ~ETA:\s*([^;]+);\s*([^\]]+)\]\s*$/;
const RE_PROG_NOETA = /^(.*?)\s*\.{0,3}\s*([\d.]+)%\s*\[[#.\s]*\]\s*\[(.+?) in ([^\];]+)(?:;\s*([^\]]+))?\]\s*$/;
const RE_OVERALL = /^\[[#.]+\]\s*\[/;

// tdl's per-file message is "<peer visible name>(<peer id>):<message id> -> <path>".
// The path is what we want to surface, so split it out of the label.
const RE_MSG_ARROW = /^(.*?)\s+->\s+(.+)$/;

function splitMessage(msg) {
  const m = msg.match(RE_MSG_ARROW);
  if (!m) return { label: msg, path: '' };
  return { label: m[1].trim(), path: m[2].trim() };
}

function classifyLine(raw) {
  const line = stripAnsi(raw).replace(/\r/g, '').trimEnd();
  if (!line.trim()) return { kind: 'empty' };
  if (RE_OVERALL.test(line)) return { kind: 'overall' };

  let m = line.match(RE_DONE);
  if (m) {
    const { label, path } = splitMessage(m[1].trim());
    return { kind: 'itemDone', name: m[1].trim(), label, path, size: parseSize(m[2]), elapsed: parseDurationMs(m[3]), tail: m[4] || '' };
  }
  m = line.match(RE_FAILED);
  if (m) {
    const { label, path } = splitMessage(m[1].trim());
    return { kind: 'itemFailed', name: m[1].trim(), label, path, tail: m[2] || '' };
  }
  m = line.match(RE_PROG);
  if (m) {
    const pct = parseFloat(m[2]);
    const doneBytes = parseSize(m[3]);
    const { label, path } = splitMessage(m[1].trim());
    return {
      kind: 'itemProgress', name: m[1].trim(), label, path, pct, doneBytes,
      total: pct > 0 ? Math.round(doneBytes / (pct / 100)) : 0,
      etaMs: parseDurationMs(m[4]), speed: m[5].trim(),
    };
  }
  m = line.match(RE_PROG_NOETA);
  if (m) {
    const pct = parseFloat(m[2]);
    const doneBytes = parseSize(m[3]);
    const { label, path } = splitMessage(m[1].trim());
    return {
      kind: 'itemProgress', name: m[1].trim(), label, path, pct, doneBytes,
      total: pct > 0 ? Math.round(doneBytes / (pct / 100)) : 0,
      etaMs: 0, speed: (m[5] || '').trim(),
    };
  }
  return { kind: 'log', text: line };
}

// ---- runner ---------------------------------------------------------------

/**
 * Start tdl.exe inside a ConPTY. Returns a handle:
 *   { write(str), kill(), exit: Promise<{exitCode, signal}>,
 *     onLine(cb), onChunk(cb) }
 * Lines are ANSI-stripped. Caller MUST eventually kill() or let the child exit.
 */
function startTdl(args, { cwd, env } = {}) {
  // The executable is referenced by bare name on purpose: server.js prepends
  // the tdl directory to this process's PATH at startup, so the pty resolves
  // it deterministically. Arguments travel as a sanitized argv array — never
  // through a shell — so no value can break out of the command.
  const proc = pty.spawn('tdl.exe', sanitizeArgs(args), {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: cwd || path.dirname(TDL_PATH),
    env: { ...process.env, ...env },
  });

  let lineBuf = '';
  const lineCbs = [];
  const chunkCbs = [];

  const feed = (chunk) => {
    for (const cb of chunkCbs) cb(chunk);
    lineBuf += chunk;
    const parts = lineBuf.split(/\r?\n/);
    lineBuf = parts.pop();
    for (const part of parts) {
      const clean = stripAnsi(part).replace(/\r/g, '').trimEnd();
      if (clean) for (const cb of lineCbs) cb(clean);
    }
  };

  proc.onData(feed);
  const exit = new Promise((resolve) => proc.onExit(({ exitCode, signal }) => {
    // flush any trailing partial line
    const rest = stripAnsi(lineBuf).replace(/\r/g, '').trimEnd();
    if (rest) for (const cb of lineCbs) cb(rest);
    resolve({ exitCode, signal });
  }));

  return {
    proc,
    write: (s) => { try { proc.write(s); } catch { /* pty closed */ } },
    kill: () => { try { proc.kill(); } catch { /* already gone */ } },
    // Graceful stop: Ctrl+C lets tdl save its resume progress and clean up,
    // which is what makes "pause then continue" work. Falls back to a hard
    // kill if tdl does not exit in time.
    interrupt: (graceMs = 8000) => new Promise((resolve) => {
      let done = false;
      const finish = (how) => { if (!done) { done = true; resolve(how); } };
      exit.then(() => finish('exited'));
      try { proc.write('\x03'); } catch { /* pty closed */ }
      setTimeout(() => {
        if (done) return;
        try { proc.kill(); } catch { /* already gone */ }
        finish('killed');
      }, graceMs);
    }),
    exit,
    onLine: (cb) => lineCbs.push(cb),
    onChunk: (cb) => chunkCbs.push(cb),
  };
}

/**
 * Start `tdl dl ... --serve` on the given port. Kept here (next to the other
 * pty spawn sites) so all process startup lives in one module.
 */
function startServe(baseArgs, port) {
  return startTdl([...baseArgs, '--serve', '--port', String(port)], {});
}

/**
 * Download one file over HTTP Range from a locally-running tdl --serve.
 * All the network and file work happens here so process spawning, HTTP and
 * disk writes stay in a single module.
 */
function httpDownloadFile({ url, size, dest, partFile, metaFile, onProgress, signal }) {
  const http = require('node:http');
  const fs = require('node:fs');

  const CHUNK = 4 * 1024 * 1024;
  const PARALLEL = 4;
  const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

  const abortErr = () => Object.assign(new Error('paused'), { name: 'AbortError' });

  const requestRange = (start, end) => new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:') return reject(new Error(`unsupported protocol: ${u.protocol}`));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!LOOPBACK.includes(host)) return reject(new Error(`refusing non-local host: ${host}`));
    const req = http.request({
      hostname: host, port: u.port || 80, path: u.pathname + u.search, method: 'GET',
      headers: { Range: `bytes=${start}-${end}` }, signal,
    }, (res) => resolve(res));
    req.on('error', reject);
    req.end();
  });

  return (async () => {
    let meta = { size, done: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (saved && saved.size === size) meta = saved;
    } catch { /* fresh */ }

    const total = size;
    const chunkCount = Math.ceil(total / CHUNK);
    const done = new Set(meta.done || []);

    if (!fs.existsSync(partFile) || fs.statSync(partFile).size !== total) {
      const f = fs.openSync(partFile, 'w');
      fs.ftruncateSync(f, total);
      fs.closeSync(f);
      done.clear();
    }

    const saveMeta = () => {
      try { fs.writeFileSync(metaFile, JSON.stringify({ size: total, done: [...done] })); } catch { /* best effort */ }
    };
    saveMeta();

    const bytesDone = () => [...done].reduce((s, i) => s + Math.min(CHUNK, total - i * CHUNK), 0);
    const fd = fs.openSync(partFile, 'r+');
    const partial = new Map();

    const report = () => {
      let extra = 0;
      for (const v of partial.values()) extra += v;
      if (onProgress) onProgress(Math.min(total, bytesDone() + extra), total);
    };
    report();

    const fetchChunk = async (idx) => {
      if (signal && signal.aborted) throw abortErr();
      const start = idx * CHUNK;
      const end = Math.min(start + CHUNK, total) - 1;
      const res = await requestRange(start, end);
      if (res.statusCode === 200 && total > CHUNK) {
        res.resume();
        throw new Error('服务器未支持 Range 请求');
      }
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode} for range ${start}-${end}`);
      }
      let offset = start;
      for await (const buf of res) {
        if (signal && signal.aborted) throw abortErr();
        fs.writeSync(fd, buf, 0, buf.length, offset);
        offset += buf.length;
        partial.set(idx, offset - start);
        report();
      }
      done.add(idx);
      partial.delete(idx);
      saveMeta();
      report();
    };

    try {
      const queue = [];
      for (let i = 0; i < chunkCount; i++) if (!done.has(i)) queue.push(i);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(PARALLEL, queue.length || 1) }, async () => {
        while (cursor < queue.length) {
          if (signal && signal.aborted) throw abortErr();
          await fetchChunk(queue[cursor++]);
        }
      });
      await Promise.all(workers);
    } finally {
      fs.closeSync(fd);
      saveMeta();
    }

    try { fs.renameSync(partFile, dest); } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'EPERM') {
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        fs.renameSync(partFile, dest);
      } else throw e;
    }
    try { fs.unlinkSync(metaFile); } catch { /* gone */ }
    return { dest, size: total };
  })();
}

/**
 * Run tdl and collect plain text output (ANSI stripped). For light commands:
 * version, chat ls, etc. Resolves { exitCode, stdout, timedOut } — ConPTY
 * merges stderr into the same stream, so everything lands in `stdout`.
 */
function collect(args, { timeoutMs = 180000, cwd } = {}) {
  return new Promise((resolve) => {
    let timedOut = false;
    const h = startTdl(args, { cwd });
    let out = '';
    h.onLine((l) => { out += l + '\n'; });
    const timer = setTimeout(() => { timedOut = true; h.kill(); }, timeoutMs);
    h.exit.then(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: out, timedOut });
    });
  });
}

module.exports = {
  TDL_PATH, PTY_COLS, enqueue, queueInfo, stripAnsi, sanitizeArgs,
  classifyLine, parseSize, parseDurationMs, startTdl, startServe, httpDownloadFile, collect,
};
