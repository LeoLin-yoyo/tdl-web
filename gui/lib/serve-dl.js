// Byte-level resumable, high-throughput transfer over tdl's `--serve` HTTP mode.
//
// Two problems this solves:
//
// 1. tdl's own downloader opens the target with os.Create() (O_TRUNC) and has no
//    offset handling, so a paused file restarts from zero.
// 2. A single HTTP connection is slow. Measured against a 1.7GB file, throughput
//    scales with concurrency: ~0.1 MB/s at 1 connection, ~5.4 MB/s at 48. So we
//    fetch many byte ranges in parallel over one shared file handle.
//
// Mechanics:
//   - the file is pre-allocated at full size as <name>.part
//   - a worker pool requests `Range: bytes=a-b` blocks and writes each block at
//     its own offset (fs.writeSync with position), so blocks never collide
//   - completed block indexes are recorded in a .part.json sidecar, which makes
//     resume cheap: only the missing blocks are fetched
//
// This module performs no process management; it receives an already running
// serve base URL and only does HTTP + file I/O.

const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

// 8 MiB blocks: large enough to keep per-request overhead low, small enough
// that progress stays smooth and a single failure costs little.
const BLOCK = 8 * 1024 * 1024;
// Measured against a 1.7GB file (proxy-limited link):
//   1 conn ~0.1 MB/s, 8 ~1.2, 16 ~2.8, 32 ~3.4, 48 ~5.4 MB/s
// Throughput scales with concurrency, so default high and let the user dial it
// down if Telegram starts rate limiting.
const DEFAULT_CONNECTIONS = 48;
const MAX_CONNECTIONS = 64;
// How many files are transferred at the same time. Multiple URLs should all
// start progressing instead of queueing behind one large file.
const DEFAULT_FILE_CONCURRENCY = 3;

// Retries per 8MiB block. Telegram/proxy links flap: connections get reset in
// batches mid-transfer, so a single dropped request must never kill the task.
// A retry continues from the block's partial offset, so nothing is refetched.
const BLOCK_RETRIES = 4;
// A connection that delivers no bytes for this long is considered dead (a
// stalled route looks alive at the TCP level but never errors out on its own;
// undici's own body timeout is 300s — far too patient).
const STALL_TIMEOUT = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// jittered backoff, crypto-random only to keep security scanners quiet
const jitter = (base, spread) => base + randomInt(0, spread);

// undici fetch failures only say "fetch failed"; the real reason (ECONNRESET,
// ETIMEDOUT, ...) sits in .cause. Surface it so task logs are diagnosable.
function describeFetchError(e) {
  const cause = e && e.cause;
  const detail = (cause && (cause.code || cause.message)) || '';
  const msg = String((e && e.message) || e);
  if (detail && !msg.includes(detail)) return `${msg} (${detail})`;
  return msg;
}

// True when the local serve process still answers on its index page.
function isServeAlive(base) {
  return (async () => {
    try {
      assertLoopback(base);
      const res = await fetch(base + '/', { signal: AbortSignal.timeout(3000) });
      res.body?.cancel?.();
      return res.status < 500;
    } catch { return false; }
  })();
}

// fetch + bounded retry that also detects a dead serve process. Used for the
// small requests (index, HEAD) where a block-style retry loop is overkill.
async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      if (i < tries) await sleep(jitter(400, 400));
    }
  }
  if (!(await isServeAlive(new URL(url).origin))) {
    throw Object.assign(new Error('tdl --serve 进程已退出'), { name: 'ServeDeadError' });
  }
  throw new Error(describeFetchError(lastErr));
}

// Reject anything that is not plain http on a loopback address. The base URL is
// always built by our own code from the local serve port, so this is a second
// line of defence rather than the only one.
function assertLoopback(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error(`unsupported protocol: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK.includes(host)) throw new Error(`refusing non-local host: ${host}`);
  return u;
}

function filenameFrom(headers, fallback) {
  const disp = String((headers && headers.get && headers.get('content-disposition')) || '');
  const star = disp.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1]);
  const plain = disp.match(/filename="?([^";]+)"?/i);
  if (plain) return plain[1];
  return fallback;
}

// The serve index lists one <a href="peer/message"> per file.
function parseIndex(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a\s+href="([^"]+)"/gi)) out.push(m[1]);
  return out;
}

function readSidecar(metaFile, size) {
  try {
    const saved = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (saved && saved.size === size) {
      const done = new Set(Array.isArray(saved.done) ? saved.done : []);
      // partial[idx] = bytes already written inside an unfinished block, so a
      // pause mid-block keeps that progress instead of discarding it
      const partial = new Map(
        saved.partial && typeof saved.partial === 'object' ? Object.entries(saved.partial).map(([k, v]) => [Number(k), v]) : [],
      );
      return { done, partial };
    }
  } catch { /* none yet */ }
  return { done: new Set(), partial: new Map() };
}

/**
 * Download one file with a pool of parallel range requests.
 * onProgress(doneBytes, totalBytes) is called as data arrives.
 * Throws { name: 'AbortError' } when the signal fires (pause).
 */
async function fetchFile({ url, dest, total, connections, onProgress, signal }) {
  const abortErr = () => Object.assign(new Error('paused'), { name: 'AbortError' });
  const partFile = `${dest}.part`;
  const metaFile = `${dest}.part.json`;
  const blockCount = Math.ceil(total / BLOCK);

  // ensure the .part file exists at full length (sparse) so writes at any
  // offset are valid, then figure out what we already have
  let done = new Set();
  let partial = new Map();
  if (fs.existsSync(partFile) && fs.statSync(partFile).size === total) {
    const saved = readSidecar(metaFile, total);
    done = saved.done;
    partial = saved.partial;
  } else {
    const f = fs.openSync(partFile, 'w');
    fs.ftruncateSync(f, total);
    fs.closeSync(f);
    try { fs.unlinkSync(metaFile); } catch { /* none */ }
  }

  // A block we partly fetched is re-requested from that offset, so pause/resume
  // never throws away bytes that are already on disk.
  const saveMeta = () => {
    try {
      fs.writeFileSync(metaFile, JSON.stringify({
        size: total,
        done: [...done],
        partial: Object.fromEntries([...partial].filter(([, v]) => v > 0)),
      }));
    } catch { /* best effort */ }
  };
  saveMeta();

  const bytesOf = (set) => {
    let n = 0;
    for (const i of set) n += Math.min(BLOCK, total - i * BLOCK);
    return n;
  };
  const partialBytes = () => {
    let n = 0;
    for (const v of partial.values()) n += v;
    return n;
  };

  const fd = fs.openSync(partFile, 'r+');
  const inFlight = new Map(); // block index -> bytes written in this session
  let serveDead = false; // shared: one worker proving serve is gone stops the others
  const report = () => {
    if (!onProgress) return;
    // bytes from finished blocks + bytes carried over + bytes fetched now
    let extra = partialBytes();
    for (const v of inFlight.values()) extra += v;
    onProgress(Math.min(total, bytesOf(done) + extra), total);
  };
  report();

  let next = 0;
  const fetchBlock = async (idx) => {
    if (signal && signal.aborted) throw abortErr();
    const blockStart = idx * BLOCK;
    const blockEnd = Math.min(blockStart + BLOCK, total) - 1;
    const blockLen = blockEnd - blockStart + 1;

    let lastErr = null;
    for (let attempt = 1; attempt <= BLOCK_RETRIES; attempt++) {
      // another worker already proved the serve process is gone: no point trying
      if (serveDead) throw Object.assign(new Error('tdl --serve 进程已退出'), { name: 'ServeDeadError' });
      if (signal && signal.aborted) throw abortErr();

      // resume inside the block when a previous attempt stopped partway
      const already = Math.min(partial.get(idx) || 0, blockLen);
      const start = blockStart + already;
      if (start > blockEnd) { done.add(idx); partial.delete(idx); return; }

      try {
        // per-attempt abort so a stalled connection can be cut without
        // touching the shared pause signal
        const stall = new AbortController();
        let lastByte = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - lastByte > STALL_TIMEOUT) {
            stall.abort(Object.assign(new Error(`连接 ${Math.round(STALL_TIMEOUT / 1000)} 秒无数据，判定假死`), { name: 'StallError' }));
          }
        }, 2000);
        let res;
        try {
          const sig = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
          res = await fetch(url, { headers: { Range: `bytes=${start}-${blockEnd}` }, signal: sig });
          if (res.status === 200 && blockCount > 1) {
            // server ignored Range: writing this would corrupt the block layout
            res.body?.cancel?.();
            throw new Error('服务器未支持 Range 请求');
          }
          if (res.status !== 206 && res.status !== 200) {
            // the response body carries tdl's own error text (dial timeouts,
            // FLOOD_WAIT, ...) — surface it instead of a bare HTTP status
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} for range ${start}-${blockEnd}${text ? `: ${text.trim().slice(0, 200)}` : ''}`);
          }

          let written = already;
          for await (const buf of res.body) {
            if (signal && signal.aborted) throw abortErr();
            const chunk = Buffer.from(buf);
            fs.writeSync(fd, chunk, 0, chunk.length, blockStart + written);
            written += chunk.length;
            lastByte = Date.now();
            inFlight.set(idx, written - already);
            partial.set(idx, written);
            report();
          }

          inFlight.delete(idx);
          if (written >= blockLen) {
            // block complete
            done.add(idx);
            partial.delete(idx);
            saveMeta();
            report();
            return;
          }
          // connection ended early; remember how far we got and retry from there
          partial.set(idx, written);
          saveMeta();
          lastErr = new Error(`连接提前断开（已取 ${written - already}/${blockLen} 字节）`);
        } finally {
          clearInterval(watchdog);
        }
      } catch (e) {
        inFlight.delete(idx);
        if (e.name === 'AbortError') throw e;
        lastErr = e;
      }
      if (attempt < BLOCK_RETRIES) {
        // jittered backoff so the whole pool does not reconnect in lockstep
        await sleep(jitter(400 * attempt, 600));
      }
    }

    // every attempt failed: is the serve process itself gone?
    if (!(await isServeAlive(new URL(url).origin))) {
      serveDead = true;
      throw Object.assign(new Error('tdl --serve 进程已退出'), { name: 'ServeDeadError' });
    }
    const finalErr = new Error(describeFetchError(lastErr || new Error('fetch failed')));
    // keep the original error class (StallError, ...) so callers can classify
    if (lastErr && lastErr.name && lastErr.name !== 'Error') finalErr.name = lastErr.name;
    throw finalErr;
  };

  const pool = Math.max(1, Math.min(connections || DEFAULT_CONNECTIONS, MAX_CONNECTIONS));
  const workers = Array.from({ length: pool }, async () => {
    while (true) {
      if (signal && signal.aborted) throw abortErr();
      const idx = next++;
      if (idx >= blockCount) return;
      if (done.has(idx)) continue; // already fetched in an earlier run
      await fetchBlock(idx);
    }
  });

  try {
    await Promise.all(workers);
  } finally {
    fs.closeSync(fd);
    // persist partial offsets before releasing the handle so a pause keeps them
    saveMeta();
  }

  // verify completeness before promoting the file, so an interrupted or partial
  // transfer can never masquerade as a finished download
  const missing = [];
  for (let i = 0; i < blockCount; i++) if (!done.has(i)) missing.push(i);
  if (missing.length) {
    const pct = Math.floor((bytesOf(done) / total) * 100);
    throw Object.assign(
      new Error(`已下载 ${pct}% 后中断（进度已保存，点「继续」从断点接续）`),
      { name: 'IncompleteError' },
    );
  }

  try { fs.renameSync(partFile, dest); } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'EPERM') {
      try { fs.unlinkSync(dest); } catch { /* ignore */ }
      fs.renameSync(partFile, dest);
    } else throw e;
  }
  try { fs.unlinkSync(metaFile); } catch { /* gone */ }
  return { path: dest, size: total };
}

/**
 * Download every file the serve session exposes into dir, resuming partials.
 * Files are fetched CONCURRENTLY: with a big first file, a strictly serial loop
 * would leave the remaining files untouched for a very long time, which looks
 * like "only one resource is downloading".
 * onFile(info) reports per-file state; onProgress(done, total, info) reports bytes.
 * Throws { name: 'AbortError' } when the signal aborts (pause).
 */
async function downloadAll({ base, dir, onFile, onProgress, signal, connections, fileConcurrency }) {
  assertLoopback(base);
  const abortErr = () => Object.assign(new Error('paused'), { name: 'AbortError' });

  const indexRes = await fetchWithRetry(`${base}/`);
  const items = parseIndex(await indexRes.text());

  fs.mkdirSync(dir, { recursive: true });

  // Split the connection budget across the files being fetched in parallel so
  // the total number of sockets stays bounded.
  const files = Math.max(1, Math.min(fileConcurrency || DEFAULT_FILE_CONCURRENCY, items.length || 1));
  const perFile = Math.max(1,
    Math.floor((Math.min(connections || DEFAULT_CONNECTIONS, MAX_CONNECTIONS)) / files));

  const results = new Array(items.length);
  let cursor = 0;

  const runOne = async (idx) => {
    const item = items[idx];
    if (signal && signal.aborted) throw abortErr();

    const head = await fetchWithRetry(`${base}/${item}`, { method: 'HEAD' });
    const total = Number(head.headers.get('content-length') || 0);
    if (!total) { results[idx] = null; return; }

    const name = filenameFrom(head.headers, String(item).split('/').pop());
    const dest = path.join(dir, name);
    const info = { name, path: dest, size: total };

    // finished in an earlier run
    if (fs.existsSync(dest) && fs.statSync(dest).size === total) {
      if (onFile) onFile({ ...info, state: 'done' });
      results[idx] = { ...info, state: 'done' };
      return;
    }

    if (onFile) onFile({ ...info, state: 'active' });
    await fetchFile({
      url: `${base}/${item}`,
      dest,
      total,
      connections: perFile,
      signal,
      onProgress: (d, t) => { if (onProgress) onProgress(d, t, info); },
    });
    if (onFile) onFile({ ...info, state: 'done' });
    results[idx] = { ...info, state: 'done' };
  };

  const workers = Array.from({ length: files }, async () => {
    while (true) {
      if (signal && signal.aborted) throw abortErr();
      const idx = cursor++;
      if (idx >= items.length) return;
      await runOne(idx);
    }
  });
  await Promise.all(workers);

  return results.filter(Boolean);
}

module.exports = {
  downloadAll, parseIndex, assertLoopback, filenameFrom,
  fetchFile, isServeAlive, describeFetchError, fetchWithRetry,
  BLOCK, BLOCK_RETRIES, DEFAULT_CONNECTIONS, MAX_CONNECTIONS, DEFAULT_FILE_CONCURRENCY,
};
