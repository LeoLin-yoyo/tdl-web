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

export function setCsrfToken(t) {
  csrfToken = t || '';
}

export function getCsrfToken() {
  return csrfToken;
}

// 启动时先向服务端要一次令牌（已登录的情况下 /api/auth/status 会返回）
export async function initCsrf() {
  try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const data = await res.json();
    if (data && data.csrf) csrfToken = data.csrf;
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
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- toasts & modal --------------------------------------------------------

export function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => t.remove(), 4000);
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
  const close = () => wrap.remove();
  wrap.querySelector('.modal-close').onclick = close;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
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

// ---- boot --------------------------------------------------------------------

export async function boot() {
  if (typeof window !== 'undefined') window.__store = store; // debug handle
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
