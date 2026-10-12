// GUI configuration + data locations.
//
// gui/data/gui-config.json  — user preferences (proxy, ns, download dir, ...)
// gui/data/                 — runtime data (history snapshots)

const fs = require('node:fs');
const path = require('node:path');

const GUI_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(GUI_ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'gui-config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'tasks-history.json');

// The executable name differs per platform (and on Windows the shipped
// release folder is `tdl_Windows_64bit`, so a bare `tdl.exe` inside it).
const TDL_EXE = process.platform === 'win32' ? 'tdl.exe' : 'tdl';

// Where an auto-downloaded tdl is unpacked (see lib/tdlfetch.js).
const TDL_AUTO_DIR = path.join(GUI_ROOT, 'tdl');

// Locate the tdl executable. Order (first hit wins):
//   1. explicit path in settings (gui-config.json `tdlPath`)
//   2. TDL_GUI_TDL_PATH env var
//   3. an auto-downloaded copy under gui/tdl/
//   4. ./tdl.exe next to the GUI
//   5. a sibling release folder (tdl_Windows_64bit/, tdl_*/)
//   6. bare name, resolved through PATH by the caller
function locateTdl() {
  const candidates = [];
  const fromCfg = (() => {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).tdlPath; } catch { return ''; }
  })();
  if (fromCfg) candidates.push(fromCfg);
  if (process.env.TDL_GUI_TDL_PATH) candidates.push(process.env.TDL_GUI_TDL_PATH);
  // auto-downloaded copies (flat and inside an extracted release folder)
  candidates.push(path.join(TDL_AUTO_DIR, TDL_EXE));
  try {
    for (const ent of fs.readdirSync(TDL_AUTO_DIR, { withFileTypes: true })) {
      if (ent.isDirectory()) candidates.push(path.join(TDL_AUTO_DIR, ent.name, TDL_EXE));
    }
  } catch { /* not downloaded yet */ }
  candidates.push(path.join(GUI_ROOT, TDL_EXE));
  // sibling release folders: tdl_Windows_64bit/, tdl_Linux_64bit/, ...
  try {
    const parent = path.join(GUI_ROOT, '..');
    for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
      if (ent.isDirectory() && /^tdl[_-]/i.test(ent.name)) {
        candidates.push(path.join(parent, ent.name, TDL_EXE));
      }
    }
  } catch { /* ignore */ }
  for (const c of candidates) {
    try { if (c && fs.statSync(c).isFile()) return path.resolve(c); } catch { /* keep looking */ }
  }
  return null; // rely on PATH lookup with bare name
}

// tdl stores each namespace as a FILE named after it (`~/.tdl/data/<ns>`), so
// the value is a path segment: anything with separators or `..` would let a
// crafted setting read or write outside the session/data directories. Accept
// only the shape tdl itself produces — a short, plain token — and fall back to
// the default otherwise. Applied on save (below) and re-applied on load, so a
// hand-edited gui-config.json cannot smuggle a path either.
const NS_RE = /^[A-Za-z0-9_-]{1,32}$/;
function safeNs(v) {
  const s = String(v == null ? '' : v).trim();
  return NS_RE.test(s) ? s : DEFAULTS.ns;
}

const DEFAULTS = {
  proxy: '',            // tdl --proxy, e.g. socks5://127.0.0.1:7890
  ns: 'default',        // tdl --ns
  // Absolute path to the tdl executable. Empty = auto-discover (see
  // locateTdl). Users on another OS or with tdl elsewhere set this here.
  tdlPath: '',
  dir: path.join(GUI_ROOT, 'downloads'), // download root + file browser root
  threads: 4,           // tdl -t
  limit: 2,             // tdl -l
  delay: 0,             // tdl --delay (seconds)
  ntp: '',
  reconnectTimeout: 300, // seconds
  template: '{{ .DialogID }}_{{ .MessageID }}_{{ filenamify .FileName }}',
  // download behaviour defaults (moved here from the download form so there is
  // a single place to configure them)
  include: '',          // comma-separated extensions to keep
  exclude: '',          // comma-separated extensions to skip
  group: false,         // auto-detect grouped/album messages
  skipSame: false,      // skip files with same name+size
  rewriteExt: false,    // fix extension from the file header
  takeout: false,       // takeout session (lower flood limits)
  desc: false,          // newest first
  // Parallel HTTP connections used per file. Measured against a 1.7GB file:
  // 1 conn ~0.1 MB/s, 8 ~1.2, 16 ~2.8, 32 ~3.4, 48 ~5.4 MB/s.
  connections: 48,
  // How many files download at once. >1 keeps every pasted link progressing
  // instead of queueing behind a single large file.
  fileConcurrency: 3,
  // Online playback (lib/stream.js). A single serve connection is too slow for
  // real-time video, so playback is fed from a parallel prefetch pool. This is
  // the pool's CEILING, not a fixed width: the pool starts at 8 and adapts —
  // +1 worker per few healthy fetches, halving when fetches exhaust retries
  // (connection floods get throttled hard on a flapping route).
  streamConnections: 24,
  streamWindowMB: 256,   // keep this much fetched ahead of the playhead
  streamCacheMB: 512,    // in-memory block cache cap (seek-back friendly)
  streamIdleMin: 10,     // close the playback session after this many idle minutes

  // ---- 服务器模式 / 受管目录 ------------------------------------------------
  //
  // 「服务器模式」解决的问题：下载落在远端服务器上，用户碰不到那些文件。
  // 打开后，下载与文件管理都收拢到同一个受管目录里：
  //   - 下载表单里填的目录一律当成**相对受管目录**的路径（相对路径）
  //   - 「文件」页的一切增删改查都限定在这个目录内
  //   - 可对整个目录设容量上限，超限不再写入
  serverMode: false,
  // 受管目录的绝对路径。留空 = 自动创建 gui/data/managed。
  managedDir: '',
  // 受管目录的容量上限（GB）。0 = 不限制。
  managedQuotaGB: 0,
};

// 受管目录的默认位置：gui/data/managed。
// 放在 data/ 下是因为 data/ 已在 .gitignore 里，不会把用户的文件带进仓库。
const MANAGED_DEFAULT = path.join(DATA_DIR, 'managed');

// 解析受管目录的绝对路径。空值 → 默认目录；填了就用填的（自动 resolve + 建目录）。
// 创建失败时退回默认目录，避免整个服务起不来。
function managedRoot() {
  const cfg = load();
  const raw = String(cfg.managedDir || '').trim();
  const target = raw ? path.resolve(raw) : MANAGED_DEFAULT;
  try {
    fs.mkdirSync(target, { recursive: true });
    return target;
  } catch {
    try { fs.mkdirSync(MANAGED_DEFAULT, { recursive: true }); } catch { /* 交给调用方报错 */ }
    return MANAGED_DEFAULT;
  }
}

// 当前生效的「文件操作根目录」：
//   服务器模式 → 受管目录（文件操作与相对下载路径都基于它）
//   普通模式   → 用户配置的下载目录（保持原有行为）
function activeRoot() {
  const cfg = load();
  return cfg.serverMode ? managedRoot() : path.resolve(cfg.dir || DEFAULTS.dir);
}

// 把用户在下载表单里填的路径，按当前模式解成绝对路径。
//   服务器模式：填的路径一律当成**相对受管目录**的路径 —— 即使以 / 开头也
//              剥掉开头的分隔符再拼接。否则用户一句 /etc 就把文件写到系统
//              目录去了，受管目录的意义（和容量限制）会整个失效。
//   普通模式：维持原有行为。
function resolveDownloadDir(input) {
  const cfg = load();
  const base = activeRoot();
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return base;
  if (!cfg.serverMode) return path.resolve(base, raw);
  const rel = raw.replace(/^([A-Za-z]:)?[\\/]+/, '');
  const abs = path.resolve(base, rel);
  // 越界（例如 ../../）就退回受管目录根，绝不写到目录外
  if (abs !== base && !abs.startsWith(base + path.sep)) return base;
  return abs;
}

let cache = null;

// db.js requires this module for DATA_DIR, so require it lazily here to avoid
// a load-order cycle.
function stateDb() {
  try { return require('./db'); } catch { return null; }
}

function load() {
  if (cache) return cache;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // SQLite is the source of truth; the JSON file remains for CLI compatibility
  // and as a fallback when the DB is unavailable.
  let saved = null;
  const d = stateDb();
  if (d) saved = d.getState('settings', null);
  if (!saved) {
    try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { saved = {}; }
  }

  cache = { ...DEFAULTS, ...(saved || {}) };
  cache.ns = safeNs(cache.ns); // never trust a path segment from disk
  // keep working dir sane
  if (typeof cache.dir === 'string' && cache.dir) {
    try {
      cache.dir = path.resolve(cache.dir);
      fs.mkdirSync(cache.dir, { recursive: true }); // tdl export/create expect it to exist
    } catch { cache.dir = DEFAULTS.dir; }
  } else {
    cache.dir = DEFAULTS.dir;
  }
  return cache;
}

function save(patch) {
  const cur = load();
  const next = { ...cur, ...patch };
  // type coercion for numeric fields
  for (const k of ['threads', 'limit', 'delay', 'reconnectTimeout', 'connections', 'fileConcurrency']) {
    next[k] = Number(next[k]) >= 0 ? Number(next[k]) : DEFAULTS[k];
  }
  // playback knobs are bounded so a typo cannot exhaust memory or sockets
  const clamp = (v, dflt, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  next.streamConnections = clamp(next.streamConnections, DEFAULTS.streamConnections, 1, 128);
  next.streamWindowMB = clamp(next.streamWindowMB, DEFAULTS.streamWindowMB, 8, 4096);
  next.streamCacheMB = clamp(next.streamCacheMB, DEFAULTS.streamCacheMB, 32, 8192);
  next.streamIdleMin = clamp(next.streamIdleMin, DEFAULTS.streamIdleMin, 1, 240);
  for (const k of ['group', 'skipSame', 'rewriteExt', 'takeout', 'desc']) {
    next[k] = next[k] === true || next[k] === 'true';
  }
  for (const k of ['include', 'exclude']) {
    next[k] = String(next[k] == null ? '' : next[k]).trim();
  }
  next.dir = path.resolve(String(next.dir || DEFAULTS.dir));
  next.ns = safeNs(next.ns); // the namespace becomes a filename — never a path

  // ---- 服务器模式 / 受管目录 ----
  next.serverMode = next.serverMode === true || next.serverMode === 'true';
  // 受管目录允许留空（= 用默认目录），填了就必须是绝对路径。
  // 不在这里创建：目录创建带副作用，交给 managedRoot() 在真正用到时做。
  next.managedDir = String(next.managedDir == null ? '' : next.managedDir).trim();
  if (next.managedDir) next.managedDir = path.resolve(next.managedDir);
  // 容量上限：整数 GB，0 表示不限制，上限 1PB 防手滑多打几个零
  const quota = Math.round(Number(next.managedQuotaGB));
  next.managedQuotaGB = Number.isFinite(quota) && quota >= 0 ? Math.min(quota, 1024 * 1024) : 0;

  cache = next;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  const d = stateDb();
  if (d) d.setState('settings', next); // persist to the table as well
  return next;
}

// Download behaviour comes from settings unless the task overrides it, so the
// download form no longer needs to repeat these fields.
function downloadDefaults() {
  const c = load();
  const split = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  return {
    // 服务器模式下，默认下载目录就是受管目录 —— 否则用户在下载表单里
    // 留空路径时，会退回「下载目录」而绕过受管目录（受管与配额一起失效）。
    // 表单里填了值的走 buildDlArgs → resolveDownloadDir，同样落在受管目录内。
    dir: c.serverMode ? managedRoot() : c.dir,
    template: c.template,
    include: split(c.include),
    exclude: split(c.exclude),
    threads: c.threads,
    limit: c.limit,
    delay: c.delay,
    ns: c.ns,
    group: !!c.group,
    skipSame: !!c.skipSame,
    rewriteExt: !!c.rewriteExt,
    takeout: !!c.takeout,
    desc: !!c.desc,
    connections: Number(c.connections) > 0 ? Number(c.connections) : DEFAULTS.connections,
    fileConcurrency: Number(c.fileConcurrency) > 0 ? Number(c.fileConcurrency) : DEFAULTS.fileConcurrency,
  };
}

// Runtime knobs derived from config.
function globalArgs(cfg) {
  const args = [];
  if (cfg.proxy) args.push('--proxy', cfg.proxy);
  if (cfg.ns) args.push('--ns', cfg.ns);
  if (cfg.ntp) args.push('--ntp', cfg.ntp);
  if (cfg.reconnectTimeout) args.push('--reconnect-timeout', `${cfg.reconnectTimeout}s`);
  return args;
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}

function saveHistory(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(-200), null, 2));
}

// ---- 容量统计 --------------------------------------------------------------
//
// 「受管目录已用多少」用递归遍历来算。文件多时这会慢，所以结果缓存一小段时间
// （默认 5 秒），避免设置页每次刷新都全盘扫一遍。写入操作会让缓存立即失效。

const USAGE_TTL_MS = 5000;
let usageCache = { dir: '', at: 0, bytes: 0, files: 0 };
let usageDirty = true;

// 目录占用统计。跳过符号链接，避免链接成环时无限递归。
// 这些隐藏目录不计入「受管目录已用」：
//   .trash        回收站 —— 删除过的东西不该继续占用户的配额，
//                 否则「删了文件配额却没释放」会让人完全无法理解。
//   .office-cache Office 预览的 PDF 缓存 —— 是程序自己生成的中间产物，
//                 算进配额等于用户的预算被预览缓存悄悄吃掉。
const USAGE_SKIP = new Set(['.trash', '.office-cache']);

function dirUsage(dir, acc = { bytes: 0, files: 0 }, depth = 0) {
  if (depth > 64) return acc; // 防御异常深的目录树
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isSymbolicLink()) continue;
      if (USAGE_SKIP.has(ent.name)) continue;
      if (ent.isDirectory()) {
        dirUsage(full, acc, depth + 1);
      } else if (ent.isFile()) {
        acc.bytes += fs.statSync(full).size;
        acc.files += 1;
      }
    } catch { /* 读不到的条目跳过，不因单个文件失败中断统计 */ }
  }
  return acc;
}

// 让占用缓存失效（文件写入/删除后调用）
function invalidateUsage() { usageDirty = true; }

function managedUsage(force = false) {
  const dir = managedRoot();
  const now = Date.now();
  if (!force && !usageDirty && usageCache.dir === dir && now - usageCache.at < USAGE_TTL_MS) {
    return usageCache;
  }
  const acc = dirUsage(dir, { bytes: 0, files: 0 });
  usageCache = { dir, at: now, bytes: acc.bytes, files: acc.files };
  usageDirty = false;
  return usageCache;
}

// 机器层面的容量（整个文件系统）。statfs 在 Node 18+ 可用。
function diskSpace(targetPath) {
  const p = targetPath || activeRoot();
  try {
    const st = fs.statfsSync(p);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const used = total - st.bfree * st.bsize;
    return { ok: true, path: p, total, free, used };
  } catch (e) {
    return { ok: false, path: p, error: e.message, total: 0, free: 0, used: 0 };
  }
}

// 是否还能写入 needBytes 字节。
// 同时看两道闸：(1) 受管目录自己的配额；(2) 机器实际剩余空间。
// 两者取更严的那个 —— 只看配额可能写到磁盘满，只看磁盘则配额形同虚设。
function checkWritable(needBytes = 0) {
  const cfg = load();
  const quotaBytes = Math.max(0, Number(cfg.managedQuotaGB) || 0) * 1024 * 1024 * 1024;
  const need = Math.max(0, Number(needBytes) || 0);

  if (cfg.serverMode && quotaBytes > 0) {
    const used = managedUsage().bytes;
    if (used + need > quotaBytes) {
      return {
        ok: false,
        reason: 'quota',
        message: `受管目录容量不足：已用 ${fmtGB(used)}，限额 ${fmtGB(quotaBytes)}，本次还需 ${fmtGB(need)}`,
        used, quotaBytes, need,
      };
    }
  }
  const disk = diskSpace();
  if (disk.ok && disk.free < need) {
    return {
      ok: false,
      reason: 'disk',
      message: `机器可用空间不足：剩余 ${fmtGB(disk.free)}，本次还需 ${fmtGB(need)}`,
      used: 0, quotaBytes, need, diskFree: disk.free,
    };
  }
  return { ok: true, quotaBytes, need };
}

function fmtGB(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(2)} TB`;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// 设置页用的一份容量总览
function storageOverview() {
  const cfg = load();
  const rootDir = activeRoot();
  const managed = managedRoot();
  const usage = managedUsage(true);
  const disk = diskSpace(rootDir);
  const quotaBytes = Math.max(0, Number(cfg.managedQuotaGB) || 0) * 1024 * 1024 * 1024;
  return {
    serverMode: !!cfg.serverMode,
    managedDir: managed,
    activeRoot: rootDir,
    downloadDir: cfg.dir,
    managedUsed: usage.bytes,
    managedFiles: usage.files,
    quotaBytes,
    quotaGB: Number(cfg.managedQuotaGB) || 0,
    quotaUsedPct: quotaBytes > 0 ? Math.min(100, (usage.bytes / quotaBytes) * 100) : 0,
    disk,
  };
}

module.exports = {
  GUI_ROOT, DATA_DIR, CONFIG_FILE, HISTORY_FILE, TDL_AUTO_DIR, TDL_EXE,
  locateTdl, load, save, globalArgs, loadHistory, saveHistory, downloadDefaults, safeNs,
  MANAGED_DEFAULT, managedRoot, activeRoot, resolveDownloadDir,
  managedUsage, diskSpace, checkWritable, fmtGB, invalidateUsage, storageOverview, dirUsage,
};

