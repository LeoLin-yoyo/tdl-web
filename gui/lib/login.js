// Interactive login sessions (QR / phone+code) running tdl.exe under a ConPTY.
// Survey prompts don't emit trailing newlines, so prompt detection runs on the
// raw chunk stream while QR blocks / result lines are handled per-line.

const tdl = require('./tdl');
const config = require('./config');
const db = require('./db');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BLOCK_RE = /^[\u2580\u2584\u2588\u2592\u0020]+$/; // ▀ ▄ █ ▒ + spaces
const RE_SUCCESS = /Login successfully! ID: (\d+), Username: (\S*)/;
const RE_IMPORT_OK = /Import (\d+) successfully to '([^']+)' namespace/;
const RE_SELECT_USER = /Choose a user id/;
const RE_CONFIRM_LOGOUT = /logout existing desktop session/;
const RE_ERR_DB = /database is used by another process/;
const RE_TDL_ERR = /^Error: (.+)$/;

let session = null; // active or last finished session
// tdl/gotd 的多行错误链：收齐后再 emit，避免只露出 "callback:" 这种包装行
let pendingErr = null;
let errFlushTimer = null;
const listeners = new Set();
let qrFlushTimer = null;

// ---- persisted login state -----------------------------------------------
// tdl keeps its session in ~/.tdl, so an authorized session survives restarts.
// What did NOT survive was the GUI's knowledge of it: after a restart the page
// said "not logged in" and the user re-logged in for nothing. We persist the
// last successful login and re-verify it against tdl on startup.

function saveLoginRecord(rec) {
  try { db.setState('last_login', rec); } catch { /* persistence is best effort */ }
}

function loadLoginRecord() {
  try { return db.getState('last_login', null); } catch { return null; }
}

// The remembered account, with a freshness flag decided by detectLogin.
function persistedState() {
  const rec = loadLoginRecord();
  if (!rec) return { active: false, state: 'idle' };
  return {
    active: false,
    state: rec.verified === false ? 'stale' : 'success',
    id: 'persisted', kind: rec.kind, ns: rec.ns,
    user: rec.user || null, error: rec.error || '',
    restored: true,
    userIds: [], qrText: '', phone: rec.phone || '',
    startedAt: rec.at, finishedAt: rec.at, logs: [],
  };
}

function rememberLogin(sess, user) {
  const rec = loadLoginRecord() || {};
  saveLoginRecord({
    ...rec,
    ns: sess.ns,
    kind: sess.kind,
    user: user || rec.user || null,
    phone: sess.phone || rec.phone || '',
    at: Date.now(),
    verified: true,
    error: '',
  });
}

// Ask tools/tdlsession who the current tdl session belongs to. Read-only and
// independent of any record we saved, so it also covers sessions created by the
// CLI or a desktop import. Best effort: failures just leave the name blank.
function queryAccount() {
  return new Promise((resolve) => {
    const exe = path.join(config.GUI_ROOT, 'tools', 'tdlsession', 'tdlsession.exe');
    try {
      if (!fs.statSync(exe).isFile()) return resolve(null);
    } catch { return resolve(null); }

    const cfg = config.load();
    const dataDir = path.join(require('node:os').homedir(), '.tdl', 'data');
    const args = [dataDir, String(cfg.ns || 'default'), String(cfg.proxy || '')];
    execFile(exe, args, { timeout: 60000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      try {
        const r = JSON.parse(String(stdout).trim());
        if (r.error || !r.id) return resolve(null);
        resolve({ id: r.id, username: r.username || '', name: r.name || '' });
      } catch { resolve(null); }
    });
  });
}

// On startup, find out whether a usable tdl session already exists. This does
// not depend on a previously saved record: a session created by the CLI, by a
// desktop-client import, or by an earlier GUI run all live in ~/.tdl, so asking
// tdl for the chat list is the authoritative check. When it succeeds we
// remember the account, and a restart never looks "logged out" again.
let verifyPromise = null;
function detectLogin({ force = false } = {}) {
  if (verifyPromise && !force) return verifyPromise;
  const rec = loadLoginRecord();

  verifyPromise = (async () => {
    let ok = false;
    let err = '';
    try {
      const chats = require('./chats');
      const r = await chats.listChats({ refresh: force });
      ok = !r.error;
      err = r.error || '';
    } catch (e) {
      err = String((e && e.message) || e);
    }

    if (ok) {
      // resolve the account identity when we do not have one yet
      let user = (rec && rec.user) || null;
      if (!user || !user.id) user = await queryAccount();
      const next = {
        ns: (rec && rec.ns) || config.load().ns || 'default',
        kind: (rec && rec.kind) || 'existing',
        user,
        phone: (rec && rec.phone) || '',
        at: (rec && rec.at) || Date.now(),
        verified: true,
        error: '',
        checkedAt: Date.now(),
      };
      saveLoginRecord(next);
    } else if (rec) {
      saveLoginRecord({ ...rec, verified: false, error: err, checkedAt: Date.now() });
    }
    emitState();
    return publicState();
  })();
  return verifyPromise;
}

// Backwards-compatible alias used by the server.
function verifyPersistedLogin(opts) { return detectLogin(opts); }

function onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emitState() {
  const snap = publicState();
  for (const cb of listeners) { try { cb('login', snap); } catch { /* ignore */ } }
}

function publicState() {
  // no live session: fall back to the remembered account so a restart does not
  // look like "logged out"
  if (!session) return persistedState();
  return {
    active: !['success', 'failed', 'canceled'].includes(session.state),
    id: session.id, kind: session.kind, ns: session.ns,
    state: session.state, qrText: session.qrText || '',
    userIds: session.userIds || [],
    phone: session.phone || '', user: session.user || null,
    error: session.error || '', startedAt: session.startedAt, finishedAt: session.finishedAt,
    logs: session.logs.slice(-40),
  };
}

function analyzeChunk(s) {
  const clean = tdl.stripAnsi(s).replace(/\r/g, '');
  const sess = session;
  if (!sess) return;

  // prompts (no trailing newline) — detect on the rolling chunk text
  if (sess.state === 'starting' || sess.state === 'qr' || sess.state === 'code' || sess.state === 'password' || sess.state === 'select') {
    if (/Enter 2FA Password/.test(clean) && sess.state !== 'password') {
      sess.state = 'password';
      emitState();
    } else if (/Enter your phone number/.test(clean) && sess.kind === 'code' && !sess.phoneSent) {
      sess.phoneSent = true;
      sess.state = 'starting';
      sess.handle.write(`${sess.phone}\r`);
      sess.pushLog('→ 已提交手机号');
      emitState();
    } else if (/Enter Code/.test(clean) && sess.kind === 'code' && sess.state !== 'code') {
      sess.state = 'code';
      emitState();
    }
    if (RE_SELECT_USER.test(clean) && sess.state !== 'select') {
      // survey.Select prompt for choosing which tdata account to import
      sess.state = 'select';
      sess.userIds = [];
      emitState();
      // Prefer the account the user picked in the GUI (by name); otherwise
      // auto-commit when the tdata holds exactly one account.
      const pick = () => {
        if (session !== sess || sess.state !== 'select' || sess.selectSent) return;
        if (sess.desktopUserId) {
          sess.selectSent = true;
          sess.handle.write(`${sess.desktopUserId}\r`);
          sess.pushLog(`→ 已选择账号 ${sess.desktopUserId}，正在导入…`);
          sess.state = 'checking';
          emitState();
          return;
        }
        if (sess.userIds.length === 1) {
          sess.selectSent = true;
          sess.handle.write(`${sess.userIds[0]}\r`);
          sess.pushLog(`→ 已自动选择唯一账号 ${sess.userIds[0]}`);
          sess.state = 'checking';
          emitState();
        }
      };
      // give the account list a moment to stream in before deciding
      setTimeout(pick, 1800);
    }
    // survey.Confirm renders WITHOUT a trailing newline — chunk-level detection
    // is the only reliable way to see it. Auto-answer No so the user's desktop
    // client never gets logged out.
    if (RE_CONFIRM_LOGOUT.test(clean) && !sess.logoutAnswered) {
      sess.logoutAnswered = true;
      sess.handle.write('\r');
      sess.pushLog('→ 已自动选择“否”：保留桌面客户端登录状态');
      emitState();
    }
  }
}

function analyzeLine(line) {
  const sess = session;
  if (!sess) return;
  sess.lastOutputAt = Date.now();

  if (BLOCK_RE.test(line) && line.trim().length >= 8) {
    sess.qrLines.push(line);
    // the QR block may be the last thing printed (no trailing non-block line),
    // so flush it after a short silence instead of waiting for a terminator
    if (qrFlushTimer) clearTimeout(qrFlushTimer);
    qrFlushTimer = setTimeout(() => { qrFlushTimer = null; flushQr(); }, 600);
    return;
  }
  if (qrFlushTimer) { clearTimeout(qrFlushTimer); qrFlushTimer = null; }
  flushQr();

  // survey.Select option lines: bare user ids (with optional cursor prefix)
  if (sess.state === 'select') {
    const mOpt = line.match(/^[>\s]*0*(\d{4,})\s*$/);
    if (mOpt && !sess.userIds.includes(mOpt[1])) sess.userIds.push(mOpt[1]);
  }

  const mSuccess = line.match(RE_SUCCESS);
  if (mSuccess) {
    sess.user = { id: Number(mSuccess[1]), username: mSuccess[2] };
    sess.state = 'success';
    sess.pushLog(`登录成功：${mSuccess[2] || mSuccess[1]}`);
    rememberLogin(sess, sess.user);
    emitState();
    return;
  }
  const mImport = line.match(RE_IMPORT_OK);
  if (mImport) {
    sess.user = { id: Number(mImport[1]), username: '' };
    sess.state = 'success';
    sess.pushLog(`导入成功：账号 ${mImport[1]} → 命名空间 ${mImport[2]}`);
    rememberLogin(sess, sess.user);
    emitState();
    return;
  }
  // never log out the user's desktop client — auto-answered at chunk level
  if (RE_ERR_DB.test(line)) {
    sess.error = 'tdl 数据库被其他进程占用（可能有别的 tdl 正在运行），请关闭后重试';
    return;
  }
  const mErr = line.match(RE_TDL_ERR);
  if (mErr) {
    // gotd/td 的错误是**多行链**，形如：
    //   Error: callback:
    //       github.com/gotd/td/telegram.(*Client).Run.func3
    //           .../connect.go:180
    //     - not authorized. please login first
    // 真正的原因在**最后一行**（`- xxx`），第一行的 "callback:" 只是
    // 包装层。此前只取第一行，等于把真正错误丢掉、只露一个 "callback:"，
    // 让人完全无从判断。这里改为收集完整错误链，并提取最后一行实因。
    pendingErr = { head: mErr[1].trim(), detail: '', lines: [line.trim()] };
    return;
  }
  // 正在收集错误链：缩进行/`- ` 行都属于同一条错误
  if (pendingErr) {
    const t = line.trim();
    if (/^(-|\s+\S|\s*github\.com\/|\s*\.\.\.)/.test(line) || /^-\s+/.test(t)) {
      pendingErr.lines.push(t);
      const mDetail = t.match(/^-\s+(.+)$/);
      if (mDetail) pendingErr.detail = mDetail[1].trim();
      // 错误链通常紧跟若干行；给一个短定时器，收齐后一次性 emit
      if (errFlushTimer) clearTimeout(errFlushTimer);
      errFlushTimer = setTimeout(() => {
        errFlushTimer = null;
        if (!pendingErr) return;
        const e = pendingErr; pendingErr = null;
        // 优先用最后一行实因；没有再退回首行
        sess.error = (e.detail || e.head).slice(0, 300);
        sess.pushLog(`tdl 报错：${e.head}`);
        for (const l of e.lines.slice(1)) sess.pushLog(`  ${l}`);
        emitState();
      }, 400);
      return;
    }
    // 不是错误链的续行，先落盘再继续走正常逻辑
    if (errFlushTimer) { clearTimeout(errFlushTimer); errFlushTimer = null; }
    sess.error = (pendingErr.detail || pendingErr.head).slice(0, 300);
    pendingErr = null;
  }
  if (line.includes('Scan QR code')) {
    sess.pushLog('等待扫码…');
  } else if (line.trim() && !line.startsWith('WARN') && sess.state !== 'success') {
    sess.pushLog(line);
  }
  emitState();
}

function flushQr() {
  const sess = session;
  if (!sess) return;
  if (sess.qrLines.length >= 4) {
    sess.qrText = sess.qrLines.join('\n');
    sess.state = 'qr';
    sess.pushLog('收到二维码，请用 Telegram App 扫码');
    emitState();
  }
  sess.qrLines = [];
}

async function runLogin(sess) {
  const cfg = config.load();
  const args = config.globalArgs({ ...cfg, proxy: sess.proxy || cfg.proxy });
  if (sess.ns) args.push('--ns', sess.ns);
  if (sess.kind === 'desktop') {
    args.push('login', '-T', 'desktop');
    if (sess.desktopPath) args.push('-d', sess.desktopPath);
    if (sess.passcode) args.push('-p', sess.passcode);
  } else {
    args.push('login', '-T', sess.kind === 'code' ? 'code' : 'qr');
  }

  await tdl.enqueue('login', () => new Promise((resolve) => {
    const h = tdl.startTdl(args, {});
    sess.handle = h;
    h.onChunk(analyzeChunk);
    h.onLine(analyzeLine);

    const watchdog = setInterval(() => {
      // account-select state waits for a human decision — give it more slack
      const idleLimit = sess.state === 'select' ? 600000 : 120000;
      if (Date.now() - sess.lastOutputAt > idleLimit) {
        sess.error = sess.error || '长时间无响应，已终止';
        h.kill();
      }
    }, 5000);
    const overall = setTimeout(() => { sess.error = sess.error || '登录超时（15 分钟）'; h.kill(); }, 15 * 60 * 1000);

    h.exit.then(({ exitCode }) => {
      clearInterval(watchdog);
      clearTimeout(overall);
      sess.handle = null;
      sess.finishedAt = Date.now();
      if (sess.state !== 'success') {
        if (sess.cancelRequested) sess.state = 'canceled';
        else {
          sess.state = 'failed';
          sess.error = sess.error || `tdl 提前退出（exit ${exitCode}）`;
        }
      }
      sess.pushLog(`→ ${sess.state}`);
      emitState();
      resolve();
    });
  }));
}

function start({ kind, ns, phone, proxy, desktopPath, passcode, desktopUserId }) {
  if (session && !['success', 'failed', 'canceled'].includes(session.state)) {
    return { error: '已有登录会话进行中，请先取消或等待完成' };
  }
  kind = ['code', 'qr', 'desktop'].includes(kind) ? kind : 'qr';
  if (kind === 'code' && !String(phone || '').trim()) {
    return { error: '手机号登录需要填写手机号' };
  }
  session = {
    id: crypto.randomBytes(5).toString('hex'), kind,
    ns: String(ns || config.load().ns || 'default'),
    phone: String(phone || '').trim(), proxy: String(proxy || '').trim(),
    desktopPath: String(desktopPath || '').trim(),
    passcode: String(passcode || '').trim(),
    desktopUserId: String(desktopUserId || '').replace(/[^0-9]/g, ''),
    state: 'starting', qrText: '', qrLines: [], userIds: [], selectSent: false, logoutAnswered: false,
    user: null, error: '',
    logs: [], handle: null, cancelRequested: false, phoneSent: false,
    startedAt: Date.now(), finishedAt: null, lastOutputAt: Date.now(),
    pushLog: (t) => { session.logs.push(t); if (session.logs.length > 200) session.logs.shift(); },
  };
  emitState();
  runLogin(session).catch((e) => {
    session.state = 'failed';
    session.error = String(e && e.message || e);
    emitState();
  });
  return { state: publicState() };
}

function submitInput(value) {
  if (!session || !session.handle) return { error: '没有进行中的登录会话' };
  if (session.state === 'select') {
    const v = String(value).replace(/[^0-9]/g, '');
    if (!v) return { error: '请选择一个账号' };
    session.selectSent = true;
    session.handle.write(`${v}\r`);
    session.state = 'checking';
    session.pushLog(`→ 已选择账号 ${v}，正在导入…`);
    emitState();
    return { ok: true };
  }
  if (session.state !== 'password' && session.state !== 'code') return { error: '当前状态无需输入' };
  session.handle.write(`${String(value).replace(/[\r\n]/g, '')}\r`);
  session.state = 'checking';
  session.pushLog('→ 已提交输入，等待 Telegram 响应…');
  emitState();
  return { ok: true };
}

function cancel() {
  if (!session || !session.handle) {
    if (session) { session.state = 'canceled'; session.finishedAt = Date.now(); emitState(); }
    return { ok: true };
  }
  session.cancelRequested = true;
  session.handle.kill();
  return { ok: true };
}

module.exports = { start, submitInput, cancel, publicState, onEvent, detectLogin, loadLoginRecord };
