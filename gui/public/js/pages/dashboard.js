// Dashboard: account, queue, shortcuts, recent tasks.

import { api, esc, store, notify, listeners, registerRoute, fmtTime, TYPE_META, STATUS_NAME, accountLabel } from '../app.js';
import { taskCard, bindTaskCardEvents } from '../components.js';

async function render(view) {
  const cfg = store.config || {};
  const login = store.login;

  const accountHtml = login.state === 'success' && login.user
    ? `<div><b style="color:var(--ok)">已登录</b> — ${esc(accountLabel(login.user))} <span class="muted small">ns: ${esc(login.ns)}</span>${login.restored ? '<div class="muted small">重启后自动恢复，无需重新登录</div>' : ''}</div>`
    : login.state === 'success'
      ? `<div><b style="color:var(--ok)">已登录</b> <span class="muted small">ns: ${esc(login.ns)}</span></div>`
      : login.state === 'stale'
        ? `<div><b style="color:var(--warn)">登录已失效</b><div class="muted small">${esc(login.error || '会话不可用')}，请重新登录</div></div>`
        : login.active
          ? `<div><b style="color:var(--warn)">登录进行中</b>（${login.kind === 'code' ? '验证码' : '扫码'}）</div>`
          : `<div><b style="color:var(--fail)">未登录</b><div class="muted small">tdl 会话保存在 ~/.tdl，登录一次后长期有效</div></div>`;

  view.innerHTML = `
    <div class="grid c3">
      <div class="card"><h2>账号</h2>${accountHtml}
        <div style="margin-top:12px"><a class="btn sm" href="#/login">去登录 / 切换账号</a></div></div>
      <div class="card"><h2>运行环境</h2>
        <div class="muted small" style="line-height:2">
          tdl 版本 <b style="color:var(--text)">${esc(store.version || '…')}</b><br>
          代理 <b style="color:var(--text)">${esc(cfg.proxy || '未设置')}</b><br>
          下载目录 <b style="color:var(--text)">${esc(cfg.dir || '')}</b>
        </div></div>
      <div class="card"><h2>执行队列</h2>
        <div id="dash-queue"></div></div>
    </div>

    <div class="card"><h2>快捷操作</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn primary" href="#/download">↓ 下载</a>
        <a class="btn" href="#/export">▣ 导出消息</a>
        <a class="btn" href="#/forward">⇄ 转发</a>
        <a class="btn" href="#/upload">↑ 上传</a>
        <a class="btn" href="#/files">▤ 浏览下载目录</a>
      </div>
    </div>

    <h2 style="font-size:14.5px;margin:20px 0 12px">最近任务</h2>
    <div id="dash-tasks"></div>`;

  const drawQueue = () => {
    const q = store.queue || {};
    view.querySelector('#dash-queue').innerHTML = q.active
      ? `<div><span class="badge running">${esc(q.active)}</span></div><div class="muted small" style="margin-top:8px">同一时间只运行一个 tdl 进程（bolt 数据库单写者约束）。</div>`
      : `<div><span class="badge">空闲</span></div><div class="muted small" style="margin-top:8px">同一时间只运行一个 tdl 进程（bolt 数据库单写者约束）。</div>`;
  };
  drawQueue();

  const drawTasks = () => {
    const box = view.querySelector('#dash-tasks');
    const list = [...store.tasks.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 4);
    box.innerHTML = list.length ? list.map((t) => taskCard(t)).join('')
      : `<div class="card"><div class="empty">暂无任务</div></div>`;
    bindTaskCardEvents(box, () => drawTasks());
  };
  drawTasks();

  listeners.add((what) => {
    if (what === 'task') drawTasks();
    if (what === 'status') drawQueue();
  });
}

registerRoute('/dashboard', { title: '仪表盘', render });
