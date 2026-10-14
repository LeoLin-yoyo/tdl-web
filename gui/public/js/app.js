// Core: store, api, SSE, router, helpers.

export const store = {
  tasks: new Map(),      // id -> task snapshot (latest)
  login: { active: false, state: 'idle' },
  config: null,
  version: '',
  chats: null,           // {data: [...], error}
  queue: { active: null },
};

export const listeners = new Set();
export function notify(what) { for (const cb of listeners) cb(what); }

// ---- helpers --------------------------------------------------------------

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(2)} ${units[i]}`;
}

export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const TYPE_META = {
  dl: { ico: '↓', name: '下载' },
  forward: { ico: '⇄', name: '转发' },
  up: { ico: '↑', name: '上传' },
  export: { ico: '▣', name: '导出' },
};

// Human-readable label for a logged-in account: display name first, then
// @username, then the numeric id.
export function accountLabel(user) {
  if (!user) return '';
  if (user.name) return user.username ? `${user.name} (@${user.username})` : user.name;
  if (user.username) return `@${user.username}`;
  return user.id ? `ID ${user.id}` : '';
}

export const STATUS_NAME = {
  queued: '排队中', running: '运行中', success: '已完成', failed: '失败',
  canceled: '已取消', interrupted: '上次中断', nomatch: '无匹配文件', paused: '已暂停',
};

// ---- api ------------------------------------------------------------------

// CSRF 令牌：服务端对写操作（非 GET/HEAD）校验双提交令牌，
// 前端必须带上，否则一律 403。登录成功后由 /api/auth/login 返回并缓存于此。
let csrfToken = '';

// 是否需要登录认证（由 /api/auth/status 告知）。未启用时后端不拦截，前端也不显示登录入口。
let authRequired = false;

export function setCsrfToken(t) {
  csrfToken = t || '';
}

export function getCsrfToken() {
  return csrfToken;
}

export function isAuthRequired() { return authRequired; }

// 启动时先向服务端要一次令牌（已登录的情况下 /api/auth/status 会返回）。
// 同时把「是否需要登录」记下来：认证未启用时后端不拦截，前端也不该显示登录入口。
export async function initCsrf() {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const data = await res.json();
    if (data) {
      authRequired = data.required !== false;
      if (data.csrf) csrfToken = data.csrf;
    }
  } catch { /* 未登录或网络异常，保持空值 */ }
  return csrfToken;
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

export async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  // 写操作补上 CSRF 头
  if (!SAFE_METHODS.includes(method) && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    // 会话过期（认证已启用时）：回登录页，而不是抛一个看不懂的 HTTP 401
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      location.replace('/login.html');
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ---- toasts & modal --------------------------------------------------------

export function toast(msg, kind = '', durationMs = 4000) {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  // Multi-line diagnostics (e.g. why a link could not be resolved) need to be
  // readable, so honour the requested duration and keep line breaks visible.
  t.style.whiteSpace = 'pre-line';
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, Math.max(0, durationMs - 400));
  setTimeout(() => t.remove(), durationMs);
}

export function modal(title, bodyHtml) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" title="关闭">✕</button></div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const onKey = (e) => {
    // 输入框里按 Esc 交给输入框自己处理（如取消编辑），不顺手关掉整个弹窗
    if (e.key !== 'Escape') return;
    // 退出浏览器原生全屏的那次 Esc 不应连带关掉弹窗（用户只是退出全屏）。
    // 只判断「此刻确实处于全屏中」—— 这是唯一可靠、也无副作用的信号。
    if (document.fullscreenElement) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    close();
  };
  const closeBtn = wrap.querySelector('.modal-close');
  if (closeBtn) closeBtn.onclick = close;
  document.addEventListener('keydown', onKey);
  root.appendChild(wrap);
  return { el: wrap, close };
}

// ---- SSE -------------------------------------------------------------------

function connectSSE() {
  const es = new EventSource('/api/events');
  const dot = document.getElementById('conn-dot');
  es.onopen = () => dot.classList.add('on');
  es.onerror = () => dot.classList.remove('on');
  es.addEventListener('task', (e) => {
    const t = JSON.parse(e.data);
    store.tasks.set(t.id, t);
    notify('task');
  });
  es.addEventListener('tasks-changed', () => { loadTasks(); });
  es.addEventListener('login', (e) => {
    store.login = JSON.parse(e.data);
    notify('login');
  });
}

// ---- initial load -----------------------------------------------------------

export async function loadTasks() {
  const r = await api('/api/tasks');
  store.tasks.clear();
  for (const t of r.tasks) store.tasks.set(t.id, t);
  notify('task');
}

export async function loadStatus() {
  const r = await api('/api/status');
  store.config = r.config;
  // 生效值（服务器模式下会把下载目录换成受管目录）。表单用它做默认值。
  store.downloadDefaults = r.downloadDefaults || null;
  store.version = r.version;
  store.login = r.login;
  store.queue = r.queue;
  document.getElementById('nav-version').textContent = `tdl ${r.version}`;
  notify('status');
}

export async function loadChats(refresh = false) {
  try {
    store.chats = await api(`/api/chats${refresh ? '?refresh=1' : ''}`);
  } catch (e) {
    store.chats = { data: null, error: String(e.message || e) };
  }
  notify('chats');
  return store.chats;
}

// ---- router -----------------------------------------------------------------

const routes = {};
export function registerRoute(path, page) { routes[path] = page; }

let currentPath = '';
export async function navigate() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  const page = routes[hash] || routes['/dashboard'];
  currentPath = hash;
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === `#${hash}`);
  });
  document.getElementById('page-title').textContent = page.title;
  const view = document.getElementById('view');
  // pages flagged `fit` manage their own inner scrolling (cards scroll, not the page)
  view.classList.toggle('view--fit', !!page.fit);
  view.innerHTML = '';
  try {
    await page.render(view);
  } catch (e) {
    view.innerHTML = `<div class="card"><div class="empty">页面加载失败：${esc(e.message)}</div></div>`;
  }
  if (location.hash.replace(/^#/, '') !== currentPath) return; // navigated away while loading
}

window.addEventListener('hashchange', navigate);

// ---- 移动端导航抽屉 ----------------------------------------------------------
// 手机上侧边栏是抽屉：点汉堡滑出，选完页面自动收起。
// 只在窄屏生效；桌面端侧边栏常驻，这些操作等于空转。
function setNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  const btn = document.getElementById('nav-toggle');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function initNavDrawer() {
  const btn = document.getElementById('nav-toggle');
  const scrim = document.getElementById('nav-scrim');
  if (!btn) return;
  btn.addEventListener('click', () => {
    setNavOpen(!document.body.classList.contains('nav-open'));
  });
  // 点遮罩关闭
  scrim?.addEventListener('click', () => setNavOpen(false));
  // 选中任一导航项后收起，免得挡住刚打开的页面
  document.querySelectorAll('#nav a').forEach((a) => {
    a.addEventListener('click', () => setNavOpen(false));
  });
  // Esc 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setNavOpen(false);
  });
  // 转屏或拉宽到桌面时，兜底清掉抽屉状态，避免残留遮罩挡住页面
  window.addEventListener('resize', () => {
    if (window.innerWidth > 640) setNavOpen(false);
  });
}

// ---- boot --------------------------------------------------------------------

export async function boot() {
  if (typeof window !== 'undefined') window.__store = store; // debug handle
  initNavDrawer();
  // 先取 CSRF 令牌：服务端对写操作校验双提交令牌，
  // 不先拿到它，扫码登录等所有写操作都会 403。
  await initCsrf();
  connectSSE();
  await Promise.all([loadStatus(), loadTasks()]);
  // account chip reflects login state
  listeners.add((what) => {
    if (what === 'status' || what === 'login') renderAccountChip();
    if (what === 'status') renderQueueChip();
  });
  renderAccountChip();
  renderQueueChip();
  await navigate();
  // refresh queue chip periodically
  setInterval(() => { loadStatus().catch(() => {}); }, 15000);
}

function renderAccountChip() {
  const chip = document.getElementById('account-chip');
  const l = store.login;
  if (l.state === 'success' && l.user) {
    chip.className = 'chip ok';
    chip.textContent = `已登录：${accountLabel(l.user)}（${l.ns}）`;
  } else if (l.state === 'success') {
    chip.className = 'chip ok';
    chip.textContent = `已登录（${l.ns}）`;
  } else if (l.state === 'stale') {
    chip.className = 'chip warn';
    chip.textContent = `登录已失效（${l.ns}）— 点此重新登录`;
    chip.onclick = () => { location.hash = '#/login'; };
  } else if (l.active) {
    chip.className = 'chip warn';
    chip.textContent = `登录中（${l.kind === 'code' ? '验证码' : '扫码'}）`;
  } else {
    chip.className = 'chip';
    chip.textContent = '未登录';
    chip.onclick = () => { location.hash = '#/login'; };
  }
}

function renderQueueChip() {
  const el = document.getElementById('nav-queue');
  const q = store.queue || {};
  if (q.active) {
    const [kind] = String(q.active).split(':');
    el.classList.remove('hidden');
    el.textContent = `串行队列：${kind === 'task' ? '任务执行中' : q.active}…`;
  } else {
    el.classList.add('hidden');
  }
}

export { currentPath };
