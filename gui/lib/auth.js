// 访问认证（管理员登录）—— 为公网暴露提供访问控制
//
// 设计要点：
//   1. 密码用 Node 内置 crypto.scrypt 加盐哈希，不引入 bcrypt（避免原生模块，
//      否则 Pod 重建后要重编译，node-pty 已经吃过这个亏）
//   2. 会话用 HMAC-SHA256 签名的无状态令牌；服务重启后仍有效（密钥持久化在库中）
//   3. Cookie 一律 HttpOnly + SameSite=Lax；HTTPS 下追加 Secure
//   4. 登录失败按 IP + 全局双维度限速，防暴力破解
//   5. 提供 CSRF 双提交令牌校验（写操作）
//   6. 所有状态存 app_state 表（lib/db.js 已有），不引入新存储
//
// 配置来源（优先级从高到低）：
//   - 环境变量 TDL_GUI_ADMIN_USER / TDL_GUI_ADMIN_PASS（明文，仅用于首次引导）
//   - 数据库 app_state 中的 admin 记录（存哈希，运行时以它为准）

const crypto = require('node:crypto');
const db = require('./db');

const ADMIN_KEY = 'admin_account';
const SECRET_KEY = 'auth_secret';
const REVOKED_KEY = 'auth_revoked_before';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;   // 会话有效期 12 小时
const MAX_FAILS = 5;                            // 单 IP 连续失败上限
const FAIL_WINDOW_MS = 15 * 60 * 1000;          // 失败计数窗口 15 分钟
const LOCKOUT_MS = 15 * 60 * 1000;              // 触发后锁定 15 分钟

// ---- 密钥与账号存储 ----------------------------------------------------------

// 会话签名密钥：首次生成后持久化，服务重启不会导致所有人被踢下线
function getSecret() {
  let s = db.getState(SECRET_KEY, null);
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    db.setState(SECRET_KEY, s);
  }
  return s;
}

function getAccount() {
  return db.getState(ADMIN_KEY, null);
}

// 是否已设置管理员账号
function isConfigured() {
  const acc = getAccount();
  return !!(acc && acc.username && acc.hash);
}

// ---- 密码哈希（scrypt，加盐） -------------------------------------------------

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), s, 64, { N: 16384, r: 8, p: 1 });
  return { salt: s, hash: derived.toString('hex') };
}

// 恒定时间比较，防时序攻击
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyPassword(password) {
  const acc = getAccount();
  if (!acc || !acc.hash || !acc.salt) return false;
  const derived = crypto.scryptSync(String(password), acc.salt, 64, { N: 16384, r: 8, p: 1 });
  return safeEqual(derived.toString('hex'), acc.hash);
}

// 校验用户名是否就是已设置的那个管理员账号。
//
// 此前 server.js 只做了 `username.length > 0` —— 等于「用户名非空就放行」，
// 于是任何用户名配正确密码都能登录（实测 admin / 随便什么 / xxx 全部 200），
// 密码校验再严密也形同虚设。这里按真实账号比对，并用恒定时间比较避免
// 通过响应时间逐字符猜用户名。
function verifyUsername(username) {
  const acc = getAccount();
  const want = (acc && acc.username) || '';
  if (!want) return false;
  const got = String(username == null ? '' : username).trim();
  if (!got) return false;
  return safeEqual(got, want);
}

// 已设置的管理员用户名（签发会话时用它，避免把用户输入的原样存进令牌）
function accountUsername() {
  const acc = getAccount();
  return (acc && acc.username) || '';
}

// 设置（或重设）管理员账号
function setAccount(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u) throw new Error('用户名不能为空');
  if (p.length < 8) throw new Error('密码至少 8 位');
  const { salt, hash } = hashPassword(p);
  db.setState(ADMIN_KEY, { username: u, salt, hash, updatedAt: Date.now() });
  // 改密码即吊销所有旧会话：防止旧会话在改密后仍能访问
  try { revokeAllSessions(); } catch { /* 首次建号时库可能尚未就绪，忽略 */ }
  return true;
}

// 首次启动引导：若库里没有账号，则尝试用环境变量创建
function bootstrapFromEnv() {
  if (isConfigured()) return false;
  const u = process.env.TDL_GUI_ADMIN_USER;
  const p = process.env.TDL_GUI_ADMIN_PASS;
  if (!u || !p) return false;
  try {
    setAccount(u, p);
    console.log('[auth] 已根据环境变量创建管理员账号，建议随后清理环境变量');
    return true;
  } catch (e) {
    console.error('[auth] 环境变量创建账号失败：' + e.message);
    return false;
  }
}

// ---- 会话令牌（HMAC 签名，无状态） -------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

// 生成会话令牌：载荷 = 用户名 + 签发时间 + 过期时间 + 随机数
function issueSession(username) {
  const now = Date.now();
  const exp = now + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = b64url(JSON.stringify({ u: username, iat: now, exp, n: nonce }));
  const mac = sign(payload);
  return { token: `${payload}.${mac}`, exp };
}

// 会话吊销：记录一个时间戳，早于它的会话全部作废
// 无状态令牌的登出必须靠这个，否则旧 Cookie 在过期前一直有效
function revokeAllSessions() {
  db.setState(REVOKED_KEY, Date.now());
}

function getRevokedBefore() {
  const v = db.getState(REVOKED_KEY, 0);
  return Number(v) || 0;
}

// 校验会话令牌，返回 { ok, username }，失败给原因
function verifySession(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  // 恒定时间比较签名，防伪造探测
  if (!safeEqual(mac, sign(payload))) return { ok: false, reason: 'bad-signature' };
  let data;
  try {
    data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }
  if (!data || !data.exp || Date.now() > data.exp) return { ok: false, reason: 'expired' };
  // 已被吊销（登出或改密码之后签发的都作废）
  if (data.iat && Number(data.iat) <= getRevokedBefore()) {
    return { ok: false, reason: 'revoked' };
  }
  const acc = getAccount();
  if (!acc || acc.username !== data.u) return { ok: false, reason: 'stale' };
  return { ok: true, username: data.u, exp: data.exp };
}

// ---- 登录限速（按 IP + 全局） ------------------------------------------------

const fails = new Map();   // ip -> { count, first, lockedUntil }

function clientIp(req) {
  // 信任来自 Cloudflare 隧道/代理的真实 IP 头（仅用于限速，不用于鉴权）
  const h = req.headers || {};
  const cf = h['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = h['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isLockedOut(ip) {
  const rec = fails.get(ip);
  if (!rec) return 0;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    fails.delete(ip);
    return 0;
  }
  return 0;
}

function recordFail(ip) {
  const now = Date.now();
  let rec = fails.get(ip);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) {
    rec = { count: 0, first: now, lockedUntil: 0 };
  }
  rec.count += 1;
  if (rec.count >= MAX_FAILS) rec.lockedUntil = now + LOCKOUT_MS;
  fails.set(ip, rec);
  return rec;
}

function clearFails(ip) {
  fails.delete(ip);
}

// ---- CSRF 双提交令牌 ---------------------------------------------------------

function csrfTokenFor(token) {
  // 由会话令牌派生，无需额外存储；会话变了令牌即变
  return crypto.createHmac('sha256', getSecret()).update('csrf:' + String(token || '')).digest('hex');
}

function verifyCsrf(sessionToken, provided) {
  if (!provided) return false;
  return safeEqual(String(provided), csrfTokenFor(sessionToken));
}

// ---- 对外接口：认证门禁 -------------------------------------------------------

const PUBLIC_PATHS = new Set([
  '/api/auth/status',
  '/api/auth/login',
  '/api/auth/logout',
]);

// 登录页自身所需的静态资源必须放行，否则未登录时样式与脚本加载被拦，
// 登录页会退化成裸 HTML 且表单脚本失效（等于登不进去）。
// 注意：这里只放行登录页用到的通用资源与登录页专属脚本，
// 不放行任何业务接口或业务页面。
const PUBLIC_STATIC_PREFIXES = [
  '/css/',        // 样式表（登录页与主应用共用，本身不含敏感数据）
  '/js/auth.js',  // 登录页逻辑
  '/favicon',     // 图标
];

function isPublicStatic(pathname) {
  if (pathname === '/login.html') return true;
  for (const p of PUBLIC_STATIC_PREFIXES) {
    if (pathname === p || pathname.startsWith(p)) return true;
  }
  return false;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// 解析 Cookie 头
function parseCookies(req) {
  const raw = (req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookieName() {
  return 'tdlgui_session';
}

function buildSessionCookie(token, exp, secure) {
  const bits = [
    `${sessionCookieName()}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(exp).toUTCString()}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function buildLogoutCookie(secure) {
  const bits = [
    `${sessionCookieName()}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

// 是否走 HTTPS（决定是否加 Secure 标记）
function isSecureRequest(req) {
  const h = req.headers || {};
  if (h['x-forwarded-proto']) return String(h['x-forwarded-proto']).split(',')[0].trim() === 'https';
  if (h['cf-visitor']) {
    try { return JSON.parse(h['cf-visitor']).scheme === 'https'; } catch { /* ignore */ }
  }
  return false;
}

// 门禁：返回 null 表示放行；返回对象表示应拦截并回写响应
function guard(req, res, pathname, method) {
  if (PUBLIC_PATHS.has(pathname)) return null;
  if (isPublicStatic(pathname)) return null;

  const cookies = parseCookies(req);
  const token = cookies[sessionCookieName()];
  const v = verifySession(token);

  if (!v.ok) {
    return {
      status: 401,
      body: { error: 'unauthorized', reason: v.reason },
    };
  }

  // 写操作要求 CSRF 令牌（双提交）
  if (!SAFE_METHODS.has(method)) {
    const provided = (req.headers && (req.headers['x-csrf-token'] || req.headers['x-xsrf-token'])) || '';
    if (!verifyCsrf(token, provided)) {
      return { status: 403, body: { error: 'csrf failed' } };
    }
  }

  return null;
}

module.exports = {
  isConfigured, setAccount, verifyUsername, verifyPassword, accountUsername, bootstrapFromEnv,
  issueSession, verifySession, revokeAllSessions, csrfTokenFor, verifyCsrf,
  clientIp, isLockedOut, recordFail, clearFails,
  sessionCookieName, buildSessionCookie, buildLogoutCookie, isSecureRequest,
  parseCookies, guard, isPublicStatic,
  SESSION_TTL_MS, MAX_FAILS, LOCKOUT_MS,
};
