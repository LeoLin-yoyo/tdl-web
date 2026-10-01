// tdl Web GUI server — static SPA + JSON API + SSE events.
// Node built-ins only (plus node-pty via lib/tdl.js).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./lib/config');
const tdl = require('./lib/tdl');
const tasks = require('./lib/tasks');
const login = require('./lib/login');
const chats = require('./lib/chats');
const files = require('./lib/files');
const desktop = require('./lib/desktop');
const db = require('./lib/db');

// ---- resolve tdl.exe and make it resolvable by bare name ------------------
const tdlPath = config.locateTdl();
if (tdlPath) {
  global.TDL_PATH = tdlPath;
  const dir = path.dirname(tdlPath);
  // The pty starts `tdl.exe` by bare name; PATH of THIS process is what
  // CreateProcess searches, so prepend the tdl directory.
  if (!process.env.PATH.includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
  }
} else {
  global.TDL_PATH = 'tdl.exe';
  console.warn('[tdl-gui] 未找到 tdl.exe，将依赖 PATH 查找。可用环境变量 TDL_GUI_TDL_PATH 指定。');
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.TDL_GUI_HOST || '127.0.0.1';
const PORT = Number(process.env.TDL_GUI_PORT) || 8560;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

// ---- helpers ---------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Normalize a request path and pin it inside baseDir. Returns null on escape.
function pinPath(baseDir, rel) {
  if (typeof rel !== 'string') return null;
  const clean = rel.split(/[\\/]+/).filter((seg) => seg && seg !== '.' && seg !== '..');
  const target = path.resolve(baseDir, ...clean);
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) return null;
  return target;
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = pinPath(PUBLIC_DIR, rel);
  if (!target) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(target, (err, data) => {
    if (err) {
      // SPA fallback for extension-less routes
      if (!path.extname(target)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
          if (e2) return sendJson(res, 404, { error: 'not found' });
          res.writeHead(200, { 'Content-Type': STATIC_TYPES['.html'], 'Cache-Control': 'no-cache' });
          res.end(idx);
        });
      }
      return sendJson(res, 404, { error: 'not found' });
    }
    const type = STATIC_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// ---- SSE -------------------------------------------------------------------

const sseClients = new Set();

function sseBroadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

tasks.onEvent((event, data) => sseBroadcast(event, data));
login.onEvent((event, data) => sseBroadcast(event, data));

// ---- cached tdl version ----------------------------------------------------

let versionCache = { at: 0, text: '未知' };
async function tdlVersion(force = false) {
  if (!force && versionCache.text !== '未知' && Date.now() - versionCache.at < 3600000) return versionCache.text;
  const res = await tdl.collect(['version'], { timeoutMs: 30000 });
  const m = (res.stdout || '').match(/Version:\s*(\S+)/);
  versionCache = { at: Date.now(), text: m ? m[1] : `未知(${res.exitCode})` };
  return versionCache.text;
}
tdlVersion().catch(() => {});

// Re-verify the remembered login in the background so the UI can show the real
// account state right after a restart. Deferred: the queue is busy with the
// version call, and tdl is single-writer.
setTimeout(() => { login.detectLogin().catch(() => {}); }, 3000);

// ---- API router --------------------------------------------------------------

async function api(req, res, pathname, searchParams) {
  const p = pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/version') {
    return sendJson(res, 200, { version: versionCache.text, tdlPath: global.TDL_PATH });
  }
  if (method === 'GET' && p === '/api/status') {
    return sendJson(res, 200, {
      version: versionCache.text,
      config: config.load(),
      login: login.publicState(),
      queue: tdl.queueInfo(),
      sse: sseClients.size,
    });
  }
  if (method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, { config: config.load() });
  }
  if (method === 'POST' && p === '/api/config') {
    const body = await readBody(req);
    const next = config.save(body.config || {});
    return sendJson(res, 200, { config: next });
  }
  if (method === 'GET' && p === '/api/chats') {
    try {
      const r = await chats.listChats({ refresh: searchParams.get('refresh') === '1' });
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 200, { data: null, error: String(e.message || e) });
    }
  }

  if (method === 'GET' && p === '/api/tasks') {
    return sendJson(res, 200, { tasks: tasks.publicList() });
  }
  if (method === 'POST' && p === '/api/tasks') {
    const body = await readBody(req);
    const r = tasks.create(String(body.type || ''), body.config || {});
    return sendJson(res, r.error ? 400 : 200, r);
  }
  let m = p.match(/^\/api\/tasks\/([0-9a-f]+)\/cancel$/);
  if (method === 'POST' && m) return sendJson(res, 200, tasks.cancel(m[1]));
  m = p.match(/^\/api\/tasks\/([0-9a-f]+)\/pause$/);
  if (method === 'POST' && m) return sendJson(res, 200, await tasks.pause(m[1]));
  m = p.match(/^\/api\/tasks\/([0-9a-f]+)\/resume$/);
  if (method === 'POST' && m) return sendJson(res, 200, tasks.resume(m[1]));
  m = p.match(/^\/api\/tasks\/([0-9a-f]+)$/);
  if (method === 'GET' && m) {
    const t = tasks.get(m[1]);
    return t ? sendJson(res, 200, { task: t }) : sendJson(res, 404, { error: '任务不存在' });
  }
  if (method === 'DELETE' && m) return sendJson(res, 200, tasks.remove(m[1]));

  if (method === 'GET' && p === '/api/login') {
    return sendJson(res, 200, login.publicState());
  }
  if (method === 'POST' && p === '/api/login/verify') {
    // re-check the remembered session against tdl (used by the login page)
    const st = await login.detectLogin({ force: searchParams.get('force') === '1' });
    return sendJson(res, 200, st);
  }
  if (method === 'GET' && p === '/api/desktop') {
    // list desktop-client accounts with human-readable names (needs network)
    const cfg = config.load();
    const dir = searchParams.get('dir') || '';
    const passcode = searchParams.get('passcode') || '';
    const r = await desktop.listAccounts(dir, passcode, cfg.proxy);
    return sendJson(res, 200, { ...r, detected: desktop.detect(), hasTool: desktop.hasTool() });
  }

  // ---- persisted form drafts (survive page refresh) ----
  if (method === 'GET' && p === '/api/forms') {
    const key = searchParams.get('key');
    if (key) return sendJson(res, 200, { key, data: db.getForm(key) });
    return sendJson(res, 200, { error: 'missing key' });
  }
  if (method === 'POST' && p === '/api/forms') {
    const body = await readBody(req);
    const key = String(body.key || '');
    if (!key) return sendJson(res, 400, { error: 'missing key' });
    db.setForm(key, body.data || {});
    return sendJson(res, 200, { ok: true });
  }

  // ---- value history for dropdowns (e.g. previously used download dirs) ----
  if (method === 'GET' && p === '/api/recent') {
    const kind = searchParams.get('kind') || '';
    if (!kind) return sendJson(res, 400, { error: 'missing kind' });
    return sendJson(res, 200, { values: db.listRecent(kind, 30) });
  }
  if (method === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    const r = login.start(body);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (method === 'POST' && p === '/api/login/input') {
    const body = await readBody(req);
    return sendJson(res, 200, login.submitInput(String(body.value || '')));
  }
  if (method === 'POST' && p === '/api/login/cancel') {
    return sendJson(res, 200, login.cancel());
  }

  if (method === 'GET' && p === '/api/files') {
    return sendJson(res, 200, files.list(searchParams.get('path') || '.'));
  }
  if (method === 'GET' && p === '/api/files/raw') {
    const sub = String(searchParams.get('path') || '');
    if (sub.includes('..')) return sendJson(res, 400, { error: 'illegal path' });
    const info = files.statSafe(sub);
    if (!info || !info.st.isFile()) return sendJson(res, 404, { error: '文件不存在' });
    const ext = path.extname(info.target).toLowerCase();
    const type = files.MIME[ext] || 'application/octet-stream';
    const inline = searchParams.get('inline') === '1'
      && (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf');
    // header values must never contain CR/LF
    const fname = path.basename(info.target).replace(/[\r\n"\\]/g, '_');
    const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fname)}`;
    const size = info.st.size;
    const range = inline ? req.headers.range : null;
    if (typeof range === 'string' && /^\s*bytes=\d*-\d*\s*$/.test(range)) {
      const parts = range.replace(/bytes=/, '').split('-');
      let start = parts[0] ? parseInt(parts[0], 10) : 0;
      let end = parts[1] ? parseInt(parts[1], 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) { start = 0; end = size - 1; }
      res.writeHead(206, {
        'Content-Type': type, 'Content-Disposition': disposition,
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(info.target, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': type, 'Content-Disposition': disposition,
      'Content-Length': size, 'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(info.target).pipe(res);
    return;
  }

  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('event: hello\ndata: {"ok":true}\n\n');
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  return sendJson(res, 404, { error: 'unknown API' });
}

// ---- server ------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let pathname = '/';
  let searchParams = new URLSearchParams();
  try {
    // fixed base avoids trusting the Host header
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  if (pathname.startsWith('/api/')) {
    api(req, res, pathname, searchParams).catch((e) => {
      try { sendJson(res, 500, { error: String(e.message || e) }); } catch { /* headed out */ }
    });
    return;
  }
  serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  const cfg = config.load();
  console.log('==============================================');
  console.log('  tdl Web GUI 已启动');
  console.log(`  地址: http://${HOST}:${PORT}`);
  console.log(`  tdl:  ${global.TDL_PATH}`);
  console.log(`  代理: ${cfg.proxy || '（未设置，请在设置页配置）'}`);
  console.log(`  下载目录: ${cfg.dir}`);
  console.log('==============================================');
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

process.on('SIGINT', () => { console.log('\n[tdl-gui] bye'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
