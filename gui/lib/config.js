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
  // real-time video, so playback is fed from a parallel prefetch pool. More
  // connections is NOT better past a point: on the flapping Mihomo route,
  // 8 streams ran a smooth ~1.5 MiB/s while 16+ burst-stalled for 10-60s at a
  // time (route/DC throttling of connection floods) and 48 stalled the first
  // wave for ~25s. 8 is the measured sweet spot; raise only if the route
  // improves.
  streamConnections: 8, // prefetch connections while playing
  streamWindowMB: 256,   // keep this much fetched ahead of the playhead
  streamCacheMB: 512,    // in-memory block cache cap (seek-back friendly)
  streamIdleMin: 10,     // close the playback session after this many idle minutes
};

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
    dir: c.dir,
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

module.exports = {
  GUI_ROOT, DATA_DIR, CONFIG_FILE, HISTORY_FILE, TDL_AUTO_DIR, TDL_EXE,
  locateTdl, load, save, globalArgs, loadHistory, saveHistory, downloadDefaults,
};
