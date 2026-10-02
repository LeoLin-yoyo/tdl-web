// Task engine: dl / forward / upload / export tasks backed by tdl.exe runs.
// Every run goes through the global queue in lib/tdl.js (bolt single-writer).

const crypto = require('node:crypto');
const path = require('node:path');
const tdl = require('./tdl');
const config = require('./config');
const db = require('./db');
const serveDl = require('./serve-dl');

const tasks = new Map(); // id -> task (insertion ordered)
let listeners = new Set();

// history from SQLite: finished tasks of previous sessions
const history = db.listTasks().map((t) => ({
  ...t,
  status: t.status === 'running' || t.status === 'queued' ? 'interrupted' : t.status,
}));

function onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit(event, data) { for (const cb of listeners) { try { cb(event, data); } catch { /* ignore */ } } }

function newId() { return crypto.randomBytes(6).toString('hex'); }

function strList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
  return [];
}
function str(v, dflt = '') { return (v === undefined || v === null) ? dflt : String(v).trim(); }
function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

// Human-readable transfer rate, e.g. 1536 -> "1.50 KB/s".
function fmtBps(bps) {
  const n = Number(bps);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(2)} ${units[i]}`;
}
function num(v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : dflt; }

// tdl matches --include/--exclude extensions with a case-sensitive comparison
// against the raw file extension, so a file named IMG_7710.MP4 is NOT matched
// by "--include mp4" and gets silently skipped (tdl still exits 0). Windows
// users naturally type lowercase, so we emit both cases for every extension.
function extArgs(list) {
  const out = new Set();
  for (const raw of list) {
    const e = String(raw).trim().replace(/^\./, '');
    if (!e) continue;
    out.add(e.toLowerCase());
    out.add(e.toUpperCase());
  }
  return [...out].join(',');
}

// ---- arg builders (global flags first, then the subcommand) --------------

function commonArgs(t, cfg) {
  const args = config.globalArgs(config.load());
  const ns = str(t.config.ns);
  if (ns && ns !== config.load().ns) args.push('--ns', ns); // override when task picks another namespace
  const threads = num(t.config.threads, cfg.threads);
  const limit = num(t.config.limit, cfg.limit);
  const delay = num(t.config.delay, cfg.delay);
  if (threads > 0) args.push('--threads', String(threads));
  if (limit > 0) args.push('--limit', String(limit));
  if (delay > 0) args.push('--delay', `${delay}s`);
  return args;
}

function buildDlArgs(t, cfg) {
  const c = t.config;
  // Task config wins; anything the task did not specify falls back to the
  // download defaults on the settings page.
  const d = config.downloadDefaults();
  const pick = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v);
  const args = commonArgs(t, cfg);
  args.push('dl');
  for (const u of strList(c.urls)) args.push('-u', u);
  for (const f of strList(c.files)) args.push('-f', f);
  const dir = str(pick(c.dir, d.dir)) || d.dir;
  args.push('--dir', path.resolve(dir));
  const inc = strList(c.include).length ? strList(c.include) : d.include;
  const exc = strList(c.exclude).length ? strList(c.exclude) : d.exclude;
  if (inc.length) args.push('--include', extArgs(inc));
  if (exc.length) args.push('--exclude', extArgs(exc));
  args.push('--template', str(pick(c.template, d.template)));
  if (bool(c.desc) || (c.desc === undefined && d.desc)) args.push('--desc');
  if (bool(c.group) || (c.group === undefined && d.group)) args.push('--group');
  if (bool(c.takeout) || (c.takeout === undefined && d.takeout)) args.push('--takeout');
  if (bool(c.skipSame) || (c.skipSame === undefined && d.skipSame)) args.push('--skip-same');
  if (bool(c.rewriteExt) || (c.rewriteExt === undefined && d.rewriteExt)) args.push('--rewrite-ext');
  if (bool(c.restart)) args.push('--restart');
  else args.push('--continue'); // resume by default; never hang on the confirm prompt
  return args;
}

function buildForwardArgs(t, cfg) {
  const c = t.config;
  const args = commonArgs(t, cfg);
  args.push('forward');
  for (const f of strList(c.from)) args.push('--from', f);
  args.push('--to', str(c.to, 'me'));
  const mode = str(c.mode, 'clone').toLowerCase();
  if (mode === 'direct' || mode === 'clone') args.push('--mode', mode);
  if (str(c.edit)) args.push('--edit', str(c.edit));
  if (bool(c.silent)) args.push('--silent');
  if (bool(c.dryRun)) args.push('--dry-run');
  if (bool(c.single)) args.push('--single');
  if (bool(c.desc)) args.push('--desc');
  return args;
}

function buildUpArgs(t, cfg) {
  const c = t.config;
  const args = commonArgs(t, cfg);
  args.push('upload');
  for (const p of strList(c.paths)) args.push('-p', p);
  if (str(c.chat)) {
    args.push('--chat', str(c.chat));
    if (num(c.topic, 0) > 0) args.push('--topic', String(num(c.topic, 0)));
  } else if (str(c.to)) {
    args.push('--to', str(c.to));
  }
  const inc = strList(c.include);
  const exc = strList(c.exclude);
  if (inc.length) args.push('--include', extArgs(inc));
  if (exc.length) args.push('--exclude', extArgs(exc));
  if (bool(c.remove)) args.push('--rm');
  if (bool(c.photo)) args.push('--photo');
  if (str(c.caption)) args.push('--caption', str(c.caption));
  return args;
}

function buildExportArgs(t, cfg) {
  const c = t.config;
  const args = commonArgs(t, cfg);
  args.push('chat', 'export');
  const type = str(c.type, 'last').toLowerCase();
  if (['time', 'id', 'last'].includes(type)) args.push('--type', type);
  if (str(c.chat)) args.push('--chat', str(c.chat));
  if (num(c.topic, 0) > 0) args.push('--topic', String(num(c.topic, 0)));
  const input = (Array.isArray(c.input) ? c.input : strList(c.input)).map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n));
  for (const n of input) args.push('--input', String(n));
  args.push('--filter', str(c.filter, 'true'));
  const out = str(c.output) || path.join(cfg.dir, `tdl-export-${Date.now()}.json`);
  args.push('--output', path.resolve(out));
  if (bool(c.withContent)) args.push('--with-content');
  if (bool(c.raw)) args.push('--raw');
  if (bool(c.all)) args.push('--all');
  return args;
}

const TYPES = {
  dl: { build: buildDlArgs, validate(t) { return strList(t.config.urls).length + strList(t.config.files).length > 0 ? null : '需要至少一条消息链接或导出文件'; } },
  forward: {
    build: buildForwardArgs,
    validate(t) {
      if (strList(t.config.from).length === 0) return '需要至少一条来源（链接或导出文件）';
      if (!str(t.config.to)) return '需要目标会话';
      return null;
    },
  },
  up: { build: buildUpArgs, validate(t) { return strList(t.config.paths).length > 0 ? null : '需要至少一个上传路径'; } },
  export: { build: buildExportArgs, validate() { return null; } },
};

// ---- progress tracking ----------------------------------------------------

function ensureItem(t, name) {
  let it = t.items.get(name);
  if (!it) {
    it = {
      name, label: name, path: '', done: 0, total: 0, pct: 0,
      speed: '', speedBps: 0, etaMs: 0, state: 'active', updatedAt: Date.now(),
    };
    t.items.set(name, it);
  }
  return it;
}

// tdl prints rates as text ("376.30KB/s"); parse them so the card can total
// them numerically alongside the HTTP-path numbers.
function parseBps(s) {
  const m = String(s || '').match(/([\d.]+)\s*([KMG]?B)\/s/i);
  if (!m) return 0;
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function handleLine(t, line) {
  const ev = tdl.classifyLine(line);
  switch (ev.kind) {
    case 'itemProgress': {
      const it = ensureItem(t, ev.name);
      Object.assign(it, {
        label: ev.label || it.label, path: ev.path || it.path,
        done: ev.doneBytes, total: ev.total, pct: ev.pct,
        speed: ev.speed, speedBps: parseBps(ev.speed),
        etaMs: ev.etaMs, state: 'active', updatedAt: Date.now(),
      });
      break;
    }
    case 'itemDone': {
      const it = ensureItem(t, ev.name);
      Object.assign(it, {
        label: ev.label || it.label, path: ev.path || it.path,
        done: ev.size, total: ev.size || it.total, pct: 100, etaMs: 0, state: 'done', updatedAt: Date.now(),
      });
      break;
    }
    case 'itemFailed': {
      const it = ensureItem(t, ev.name);
      Object.assign(it, {
        label: ev.label || it.label, path: ev.path || it.path,
        state: 'failed', updatedAt: Date.now(),
      });
      t.failedItems++;
      break;
    }
    case 'log':
      // tdl prints "Found unfinished download, continue from 'N/M'" when it
      // resumes — surface that so the user can see the pause worked.
      if (/Found unfinished download/.test(ev.text)) {
        t.resumed = true;
        pushLog(t, `续传：${ev.text.trim()}`);
      } else {
        pushLog(t, ev.text);
      }
      break;
    default:
      break;
  }
  t.dirty = true;
}

function pushLog(t, text) {
  t.logs.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  if (t.logs.length > 400) t.logs.splice(0, t.logs.length - 400);
  t.dirty = true;
}

// ---- snapshot -------------------------------------------------------------

// A task can be resumed only when it stopped WITHOUT finishing: paused by the
// user, failed, canceled, interrupted by a restart, or matched no files (the
// filters may have been fixed since). A task that completed successfully has
// nothing left to do, so offering "continue" would be misleading.
const RESUMABLE_STATUSES = ['paused', 'failed', 'canceled', 'interrupted', 'nomatch'];

// human-readable status, for backend error messages
const STATUS_LABEL = {
  queued: '排队中', running: '运行中', success: '已完成', failed: '失败',
  canceled: '已取消', interrupted: '上次中断', nomatch: '无匹配文件', paused: '已暂停',
};

function canResumeTask(type, status, id) {
  if (type !== 'dl') return false;
  if (!RESUMABLE_STATUSES.includes(status)) return false;
  return !!db.getTaskSource(id); // needs the original links to re-run
}

function snapshot(t, { withLogs = false } = {}) {
  const items = [...t.items.values()]
    .sort((a, b) => (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1) || b.updatedAt - a.updatedAt)
    .slice(0, 150);
  const doneCount = [...t.items.values()].filter((i) => i.state === 'done').length;
  const totalBytes = items.reduce((s, i) => s + (i.total || 0), 0);
  const doneBytes = items.reduce((s, i) => s + (i.done || 0), 0);
  // sum the numeric rates (not the label strings) for an accurate card total
  const totalBps = items.reduce((s, i) => s + (i.state === 'active' ? (i.speedBps || 0) : 0), 0);
  return {
    id: t.id, type: t.type, title: t.title, ns: t.config.ns || config.load().ns,
    status: t.status, error: t.error, exitCode: t.exitCode,
    createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    args: t.displayArgs,
    // lets the UI offer 暂停 / 继续 and show that a resume is happening
    canPause: t.status === 'running' && !!t.handle,
    canResume: canResumeTask(t.type, t.status, t.id),
    resumed: !!t.resumed,
    dir: t.dir || '',
    counters: {
      itemsKnown: t.items.size, done: doneCount, failed: t.failedItems,
      active: [...t.items.values()].filter((i) => i.state === 'active').length,
      totalBytes, doneBytes,
      speed: fmtBps(totalBps),
    },
    items,
    logs: withLogs ? t.logs.slice(-120) : undefined,
  };
}

function publicList() {
  const live = [...tasks.values()].map((t) => snapshot(t));
  const histIds = new Set(live.map((t) => t.id));
  // finished tasks keep their item list (with destination paths) so the UI can
  // still show where each file landed; canResume reflects the saved source.
  const hist = history
    .filter((t) => !histIds.has(t.id))
    .map((t) => ({
      ...t,
      items: t.items || [],
      logs: [],
      canPause: false,
      canResume: canResumeTask(t.type, t.status, t.id),
    }));
  return [...live, ...hist].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// ---- lifecycle -------------------------------------------------------------

function persistFinished(t) {
  const snap = snapshot(t);
  delete snap.logs;
  // keep items (name/label/path/size/state) — they are what the UI shows after
  // the task is done, capped so the history stays small
  snap.items = (snap.items || []).slice(0, 200);
  history.push(snap);
  if (history.length > 200) history.splice(0, history.length - 200);
  db.upsertTask(snap);
  db.trimTasks(200);
}

// ---- download via serve + HTTP Range ---------------------------------------
//
// tdl's own downloader truncates the target (os.Create) and cannot resume a
// partial file, so a paused download would start over. For download tasks we
// therefore run `tdl dl --serve` and pull the bytes over HTTP Range, writing to
// <name>.part. Pausing keeps the .part; resuming continues from its size.
// Other task types (forward/upload/export) still run tdl directly.

function serveArgsFor(t, cfg) {
  // same args as the direct run, minus --serve (added by startServe)
  return TYPES[t.type].build(t, cfg);
}

// Network-family failures that a fresh transfer round can plausibly survive:
// stalled connections, resets, early disconnects, serve-side 5xx/429. Structural
// errors (Range unsupported, disk full, bad link) are deliberately excluded so
// they fail fast instead of burning through the retry budget.
function isTransientTransferError(e) {
  return e.name === 'IncompleteError' || e.name === 'StallError' ||
    /fetch failed|ECONN|ETIMEDOUT|socket hang up|UND_ERR|HTTP 5\d\d|HTTP 429|连接提前断开|无数据|假死|timeout/i
      .test(String(e.message || e));
}

async function runDownloadTask(t, cfg) {
  const baseArgs = serveArgsFor(t, cfg);
  // a stable port per task keeps concurrent GUI instances from colliding
  const port = 18900 + (parseInt(t.id.slice(0, 4), 16) % 90);
  const base = `http://127.0.0.1:${port}`;
  t.displayArgs = [...baseArgs, '--serve'].map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');

  return tdl.enqueue(`task:${t.type}:${t.id}`, async () => {
    t.status = 'running';
    t.startedAt = Date.now();
    pushLog(t, `$ tdl ${t.displayArgs}`);
    emit('task', snapshot(t));

    // pause = abort the in-flight HTTP transfer (the .part stays on disk)
    const ac = new AbortController();
    t.abortDownload = () => ac.abort();

    // Bolt allows a single writer: if a previous tdl just exited, its lock can
    // linger for a moment. Retry startup a few times on that specific error
    // instead of failing the task outright.
    const startServeSession = async () => {
      let ready = false;
      let dbLocked = false;
      let session = null;
      // 10 attempts x 2s: the usual lock holder is the startup login-detect
      // (`tdl chat ls`), which can run slow on a degraded Telegram route
      for (let attempt = 0; attempt < 10 && !ready; attempt++) {
        if (t.cancelRequested || t.pauseRequested) throw Object.assign(new Error('stopped'), { name: 'AbortError' });

        const h = tdl.startServe(baseArgs, port);
        t.handle = h;
        let hitDbLock = false;
        if (h.onLine) {
          h.onLine((line) => {
            if (/database is used by another process/i.test(line)) hitDbLock = true;
            pushLog(t, `[serve] ${line}`);
          });
        }
        session = h;

        for (let i = 0; i < 20 && !ready; i++) {
          if (t.cancelRequested || t.pauseRequested) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
          if (hitDbLock) break; // no point waiting; restart below
          try {
            const r = await fetch(`${base}/`);
            if (r.status === 200) { r.body?.cancel?.(); ready = true; break; }
          } catch { /* not up yet */ }
          await new Promise((r) => setTimeout(r, 700));
        }

        if (!ready) {
          dbLocked = hitDbLock;
          try { h.kill(); } catch { /* gone */ }
          t.handle = null;
          if (!hitDbLock) break; // a different failure: stop retrying
          pushLog(t, `tdl 数据库被占用，2s 后重试启动…`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!ready) {
        throw new Error(dbLocked
          ? 'tdl 数据库被其他进程占用，无法启动下载（请关闭其他 tdl 后重试）'
          : '等待 tdl --serve 就绪超时');
      }
      return session;
    };

    // tdl --serve can die mid-transfer (an unstable proxy node / Telegram route
    // takes the whole process down). Restart it and continue from the sidecar
    // offsets instead of failing the whole task. The same outer loop also
    // re-runs the transfer itself when a degraded route exhausts the per-block
    // retries — every round resumes from the sidecar, so nothing is refetched.
    const MAX_SERVE_RESTARTS = 5;
    const MAX_TRANSFER_RETRIES = 10;
    let restarts = 0;
    let transferRetries = 0;
    let outcome = null; // { status, error? }

    while (outcome === null) {
      // On a fully dead route the serve process cannot even resolve the link,
      // so startup itself times out. Ride it out with the same retry budget as
      // the transfer rounds instead of failing the task.
      let session;
      try {
        session = await startServeSession();
      } catch (e) {
        if (t.cancelRequested || t.pauseRequested || e.name === 'AbortError') throw e;
        if (transferRetries < MAX_TRANSFER_RETRIES) {
          transferRetries += 1;
          pushLog(t, `tdl --serve 启动失败（${String(e.message || e).slice(0, 80)}），15s 后自动重试（第 ${transferRetries}/${MAX_TRANSFER_RETRIES} 次）…`);
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }
        outcome = {
          status: 'failed',
          error: `${String(e.message || e)}。线路可能持续不可用，请检查代理节点后点「继续」；进度已保存在 .part 文件中。`,
        };
        break;
      }
      let serveExitCode = null;
      session.exit.then(({ exitCode }) => { serveExitCode = exitCode; }).catch(() => {});
      // progress made by THIS round: a round that moved real bytes should not
      // consume the no-progress retry budget
      const bytesAtRoundStart = snapshot(t).counters.doneBytes || 0;

      try {
        await serveDl.downloadAll({
          base,
          dir: t.dir,
          signal: ac.signal,
          connections: Number(t.config.connections) || config.load().connections,
          fileConcurrency: Number(t.config.fileConcurrency) || config.load().fileConcurrency,
          onFile: (info) => {
            const it = ensureItem(t, info.name);
            Object.assign(it, {
              label: info.name, path: info.path, total: info.size, state: info.state,
              // keep the offset we already have so a resumed task does not look
              // like it restarted from zero
              done: it.done || 0, pct: it.pct || 0, updatedAt: Date.now(),
            });
            t.dirty = true;
          },
          onProgress: (done, total, info) => {
            const it = ensureItem(t, info.name);
            // speed = bytes gained since the previous sample / elapsed time.
            // Smoothed over ~1s so the number stays readable.
            const now = Date.now();
            if (it.speedAt && now > it.speedAt) {
              const dt = now - it.speedAt;
              const db = done - (it.speedBytes || 0);
              if (dt >= 900 && db >= 0) {
                const inst = db / (dt / 1000);
                // exponential smoothing keeps brief stalls from flickering the value
                it.speedBps = it.speedBps ? Math.round(it.speedBps * 0.4 + inst * 0.6) : Math.round(inst);
                it.speedAt = now;
                it.speedBytes = done;
              }
            } else {
              it.speedAt = now;
              it.speedBytes = done;
            }
            Object.assign(it, {
              label: info.name, path: info.path, done, total,
              pct: total ? Math.round((done / total) * 100) : 0,
              speed: it.speedBps ? fmtBps(it.speedBps) : '',
              state: 'active', updatedAt: now,
            });
            t.dirty = true;
          },
        });

        t.exitCode = 0;
        if (t.cancelRequested) outcome = { status: 'canceled' };
        else if (t.pauseRequested) outcome = { status: 'paused' };
        else {
          const c = snapshot(t).counters;
          if (c.itemsKnown === 0) {
            outcome = {
              status: 'nomatch',
              error: '没有任何文件被处理：链接里没有可下载的媒体，或扩展名过滤把所有文件都排除了。',
            };
          } else {
            outcome = { status: 'success' };
          }
        }
      } catch (e) {
        t.exitCode = 1;
        if (t.cancelRequested) {
          outcome = { status: 'canceled' };
        } else if (t.pauseRequested || e.name === 'AbortError') {
          outcome = { status: 'paused' };
          pushLog(t, '已暂停（已下载部分保留在 .part 文件中，继续时从断点接续）');
        } else if (e.name === 'ServeDeadError') {
          // give the pty a moment to flush tdl's dying output into the log,
          // then tear the session down and decide whether to restart
          await new Promise((r) => setTimeout(r, 1500));
          try { session.kill(); } catch { /* gone */ }
          t.handle = null;
          if (restarts < MAX_SERVE_RESTARTS) {
            restarts += 1;
            pushLog(t, `tdl --serve 进程中途退出（退出码 ${serveExitCode ?? '未知'}），自动重启并从断点续传（第 ${restarts}/${MAX_SERVE_RESTARTS} 次）…`);
            continue;
          }
          outcome = {
            status: 'failed',
            error: `tdl --serve 连续退出（已自动重启 ${MAX_SERVE_RESTARTS} 次）。常见原因是代理节点到 Telegram 的线路不稳定，请检查代理后重试；进度已保存在 .part 文件中。`,
          };
        } else if (isTransientTransferError(e)) {
          const gained = (snapshot(t).counters.doneBytes || 0) - bytesAtRoundStart;
          const madeProgress = gained > 1048576; // a round that moved real bytes buys another one
          if (!madeProgress) transferRetries += 1;
          try { session.kill(); } catch { /* gone */ }
          t.handle = null;
          if (!madeProgress && transferRetries > MAX_TRANSFER_RETRIES) {
            outcome = {
              status: 'failed',
              error: `代理线路持续不稳（连续 ${MAX_TRANSFER_RETRIES} 轮传输均无进展）。请检查代理节点到 Telegram 的线路后点「继续」，进度已保存在 .part 文件中。`,
            };
          } else {
            pushLog(t, madeProgress
              ? `线路不稳，本轮仍推进了约 ${Math.round(gained / 1048576)}MB，10s 后自动从断点续传…`
              : `线路不稳导致传输中断（${String(e.message || e).slice(0, 60)}），10s 后自动重试（无进展第 ${transferRetries}/${MAX_TRANSFER_RETRIES} 次）…`);
            await new Promise((r) => setTimeout(r, 10000));
            continue;
          }
        } else {
          // unexpected failure: flush any late tdl output into the log first
          await new Promise((r) => setTimeout(r, 800));
          outcome = { status: 'failed', error: t.error || String(e.message || e) };
        }
      }

      // non-restart paths: tear the session down
      try { session.kill(); } catch { /* gone */ }
      t.handle = null;
    }

    if (outcome.error) t.error = outcome.error;
    t.status = outcome.status;

    t.abortDownload = null;
    t.finishedAt = Date.now();
    pushLog(t, `→ ${t.status}`);
    emit('task', snapshot(t, { withLogs: true }));
    persistFinished(t);
  });
}

async function runTask(t) {
  const cfg = config.load();
  t.dir = t.type === 'dl' ? path.resolve(str(t.config.dir) || cfg.dir) : '';

  // downloads go through the resumable serve/HTTP path
  if (t.type === 'dl') return runDownloadTask(t, cfg);

  const builder = TYPES[t.type];
  const args = builder.build(t, cfg);
  t.displayArgs = args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');

  await tdl.enqueue(`task:${t.type}:${t.id}`, () => new Promise((resolve) => {
    t.status = 'running';
    t.startedAt = Date.now();
    pushLog(t, `$ tdl ${t.displayArgs}`);
    emit('task', snapshot(t));

    const h = tdl.startTdl(args, { cwd: path.dirname(tdl.TDL_PATH) });
    t.handle = h;
    h.onLine((line) => handleLine(t, line));
    h.exit.then(({ exitCode }) => {
      t.handle = null;
      t.exitCode = exitCode;
      if (t.cancelRequested) {
        t.status = 'canceled';
      } else if (t.pauseRequested) {
        // graceful Ctrl+C: tdl saved its resume progress before exiting
        t.status = 'paused';
        pushLog(t, '已暂停（进度已保存，可随时继续）');
      } else if (exitCode === 0) {
        // tdl exits 0 even when its include/exclude filters dropped every
        // candidate, so a "success" with zero items is not a real download.
        // Report it distinctly instead of implying files were fetched.
        const c = snapshot(t).counters;
        if (t.type !== 'export' && c.itemsKnown === 0 && c.done === 0 && c.failed === 0) {
          t.status = 'nomatch';
          t.error = '没有任何文件被处理：链接里没有可下载的媒体，或扩展名过滤把所有文件都排除了'
            + '（tdl 的 --include/--exclude 按原始大小写匹配）。请检查链接与过滤条件。';
        } else {
          t.status = 'success';
        }
      } else {
        t.status = 'failed';
        t.error = t.error || `tdl 退出码 ${exitCode}（详情见日志）`;
      }
      t.finishedAt = Date.now();
      pushLog(t, `→ ${t.status} (exit ${exitCode})`);
      emit('task', snapshot(t, { withLogs: true }));
      persistFinished(t);
      resolve();
    });
  }));
}

// Remember values worth offering again later (download dir, target chat, ...).
function rememberValues(type, cfg) {
  if (!cfg) return;
  if (type === 'dl' && cfg.dir) db.addRecent('dl.dir', cfg.dir);
  if (type === 'export' && cfg.chat) db.addRecent('export.chat', cfg.chat);
  if (type === 'up' && cfg.chat) db.addRecent('up.chat', cfg.chat);
  if (type === 'forward' && cfg.to) db.addRecent('forward.to', cfg.to);
}

// Freeze the effective download settings into the task at creation time.
//
// tdl keys its saved resume progress on a fingerprint derived from the message
// list AND its order (which --desc changes). A later resume must therefore use
// exactly the same flags, otherwise the saved progress cannot be found and the
// whole job starts over. Snapshotting the resolved values here makes resume
// deterministic even if the user edits the settings page in between.
function freezeDlConfig(cfg) {
  const d = config.downloadDefaults();
  const pick = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v);
  const list = (v, dflt) => (strList(v).length ? strList(v) : dflt);
  return {
    ...cfg,
    dir: str(pick(cfg.dir, d.dir)) || d.dir,
    template: str(pick(cfg.template, d.template)),
    include: list(cfg.include, d.include),
    exclude: list(cfg.exclude, d.exclude),
    threads: num(cfg.threads, d.threads),
    limit: num(cfg.limit, d.limit),
    delay: num(cfg.delay, d.delay),
    ns: str(cfg.ns) || d.ns,
    group: cfg.group === undefined ? d.group : bool(cfg.group),
    skipSame: cfg.skipSame === undefined ? d.skipSame : bool(cfg.skipSame),
    rewriteExt: cfg.rewriteExt === undefined ? d.rewriteExt : bool(cfg.rewriteExt),
    takeout: cfg.takeout === undefined ? d.takeout : bool(cfg.takeout),
    desc: cfg.desc === undefined ? d.desc : bool(cfg.desc),
    connections: num(cfg.connections, d.connections),
    fileConcurrency: num(cfg.fileConcurrency, d.fileConcurrency),
  };
}

// Create one task. Kept internal so `create` can fan a multi-link request out
// into one task per link.
function createOne(type, rawConfig) {
  const builder = TYPES[type];
  if (!builder) return { error: '未知任务类型' };
  // resolve download defaults now so the stored source is complete and a later
  // resume reproduces the identical tdl invocation (same fingerprint)
  const config_ = type === 'dl' ? freezeDlConfig(rawConfig || {}) : (rawConfig || {});
  const t = {
    id: newId(), type,
    title: config_.title || type,
    config: config_,
    status: 'queued', items: new Map(), failedItems: 0, logs: [],
    error: null, exitCode: null, handle: null,
    cancelRequested: false, pauseRequested: false, resumed: false,
    createdAt: Date.now(), startedAt: null, finishedAt: null,
    displayArgs: '', dirty: false, dir: '',
  };
  const verr = builder.validate(t);
  if (verr) return { error: verr };
  rememberValues(type, t.config);
  // Persist the original request so the task can be resumed or re-run later,
  // even after a GUI restart.
  db.saveTaskSource(t);
  tasks.set(t.id, t);
  emit('task', snapshot(t));
  runTask(t).catch((e) => {
    t.status = 'failed';
    t.error = String(e && e.message || e);
    t.finishedAt = Date.now();
    emit('task', snapshot(t, { withLogs: true }));
  });
  return { task: snapshot(t) };
}

// A download request may carry several links / export files. Each one becomes
// its own task card, so the list reads "one row per link" instead of a single
// card containing many nested files.
function create(type, rawConfig) {
  const builder = TYPES[type];
  if (!builder) return { error: '未知任务类型' };

  if (type === 'dl') {
    const cfg = rawConfig || {};
    const urls = strList(cfg.urls);
    const files = strList(cfg.files);

    // Nothing to split when there is at most one source in total.
    if (urls.length + files.length > 1) {
      const made = [];
      // one task per link, and one task per export file
      for (const u of urls) made.push(createOne(type, { ...cfg, urls: [u], files: [] }));
      for (const f of files) made.push(createOne(type, { ...cfg, urls: [], files: [f] }));

      const failed = made.filter((r) => r.error);
      if (!made.length || failed.length === made.length) {
        return { error: failed[0]?.error || '创建任务失败' };
      }
      return {
        task: made[0].task,             // kept for callers that read a single task
        tasks: made.filter((r) => r.task).map((r) => r.task),
        count: made.filter((r) => r.task).length,
      };
    }
  }

  return createOne(type, rawConfig);
}

function cancel(id) {
  const t = tasks.get(id);
  if (!t) return { error: '任务不存在' };
  if (t.status !== 'running' && t.status !== 'queued') return { error: '任务已结束' };
  t.cancelRequested = true;
  if (t.handle) t.handle.kill();
  else { t.status = 'canceled'; t.finishedAt = Date.now(); emit('task', snapshot(t)); }
  return { ok: true };
}

// Pause a running task.
//
// For downloads this aborts the in-flight HTTP transfer; the partially written
// .part file stays on disk, and resuming continues from its exact byte offset.
// Other task types are interrupted with Ctrl+C (tdl saves its own progress).
async function pause(id) {
  const t = tasks.get(id);
  if (!t) return { error: '任务不存在' };
  if (t.status === 'queued') {
    // never started: just take it out of the queue
    t.cancelRequested = true;
    t.status = 'paused';
    t.finishedAt = Date.now();
    emit('task', snapshot(t));
    return { ok: true };
  }
  if (t.status !== 'running' || !t.handle) return { error: '任务当前不可暂停' };
  t.pauseRequested = true;

  if (t.abortDownload) {
    pushLog(t, '正在暂停（已下载部分会保留）…');
    emit('task', snapshot(t, { withLogs: true }));
    t.abortDownload();
  } else {
    pushLog(t, '正在暂停（等待 tdl 保存进度）…');
    emit('task', snapshot(t, { withLogs: true }));
    await t.handle.interrupt();
  }
  return { ok: true };
}

// Resume = start the same request again with --continue, which makes tdl pick
// up the saved progress.
function resume(id) {
  const t = tasks.get(id);
  if (t && (t.status === 'running' || t.status === 'queued')) return { error: '任务已在运行' };

  // a finished task has nothing to continue — reject instead of silently
  // re-downloading everything
  const known = t || history.find((x) => x.id === id);
  if (known && !canResumeTask(known.type, known.status, id)) {
    if (known.status === 'success') return { error: '该任务已完成，无需继续' };
    return { error: `当前状态（${STATUS_LABEL[known.status] || known.status}）不支持继续` };
  }

  const src = db.getTaskSource(id) || (t && { id: t.id, type: t.type, config: t.config, createdAt: t.createdAt });
  if (!src) return { error: '找不到该任务的原始链接，无法继续' };
  if (src.type !== 'dl') return { error: '仅下载任务支持继续' };

  // Reuse the ORIGINAL request verbatim (plus --continue). Re-resolving from the
  // settings page here would change the flag set, which changes tdl's resume
  // fingerprint and makes the saved progress unfindable.
  const base = { ...src.config };
  delete base.restart;
  delete base.continueLast;
  const cfg = { ...base, continueLast: true, restart: false };
  const nt = {
    id, type: src.type,
    title: src.config.title || src.type,
    config: cfg,
    status: 'queued', items: new Map(), failedItems: 0, logs: [],
    error: null, exitCode: null, handle: null,
    cancelRequested: false, pauseRequested: false, resumed: true,
    createdAt: src.createdAt || Date.now(), startedAt: null, finishedAt: null,
    displayArgs: '', dirty: false, dir: '',
  };
  db.saveTaskSource(nt);
  tasks.set(id, nt);
  const idx = history.findIndex((x) => x.id === id);
  if (idx >= 0) history.splice(idx, 1);
  emit('task', snapshot(nt));
  runTask(nt).catch((e) => {
    nt.status = 'failed';
    nt.error = String(e && e.message || e);
    nt.finishedAt = Date.now();
    emit('task', snapshot(nt, { withLogs: true }));
  });
  return { task: snapshot(nt) };
}

function remove(id) {
  const t = tasks.get(id);
  if (t && (t.status === 'running' || t.status === 'queued')) return { error: '任务仍在进行，请先暂停或取消' };
  tasks.delete(id);
  const idx = history.findIndex((x) => x.id === id);
  if (idx >= 0) history.splice(idx, 1);
  db.deleteTask(id);
  db.deleteTaskSource(id);
  emit('tasks-changed', {});
  return { ok: true };
}

function get(id) {
  const t = tasks.get(id);
  if (t) return snapshot(t, { withLogs: true });
  // finished tasks from a previous run: still resumable via the saved source
  const h = history.find((x) => x.id === id);
  if (!h) return null;
  return { ...h, items: [], logs: [], canResume: canResumeTask(h.type, h.status, id) };
}

// periodic tick for running tasks (progress deltas)
setInterval(() => {
  for (const t of tasks.values()) {
    if (t.status === 'running' && t.dirty) {
      t.dirty = false;
      emit('task', snapshot(t));
    }
  }
}, 500).unref();

module.exports = { create, cancel, pause, resume, remove, get, publicList, snapshot, onEvent };
