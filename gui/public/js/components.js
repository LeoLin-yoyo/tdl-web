// Shared UI components: task cards, chat picker.

import { api, esc, fmtBytes, fmtDur, fmtTime, modal, toast, notify, store, loadChats, TYPE_META, STATUS_NAME } from './app.js';

// ---- task card ---------------------------------------------------------------

function itemRow(it) {
  // The card already carries a progress bar, so the row shows the numbers that
  // the bar cannot: current speed while running, and the final size when done.
  const right = it.state === 'done'
    ? fmtBytes(it.size || it.total)
    : `${fmtBytes(it.done)}${it.total ? ' / ' + fmtBytes(it.total) : ''}`;
  const speed = it.state === 'active'
    ? `<span class="item-speed">${esc(it.speed || '—')}</span>`
    : '';
  // tdl reports the absolute destination path in its progress line
  const pathLine = it.path
    ? `<div class="item-path mono" title="${esc(it.path)}">${esc(it.path)}</div>`
    : '';
  return `
    <div class="item-row state-${esc(it.state)}">
      <div class="name" title="${esc(it.label || it.name)}">${esc(it.label || it.name)}</div>
      <div class="meta">${esc(right)}</div>
      <div class="meta">${speed}</div>
      ${pathLine}
    </div>`;
}

function statsHtml(t) {
  const c = t.counters || {};
  const parts = [];
  parts.push(`文件 <b>${c.done || 0}</b>${c.failed ? ` <span style="color:var(--fail)">失败 ${c.failed}</span>` : ''}${c.active ? ` · 进行 ${c.active}` : ''}`);
  if (c.totalBytes) parts.push(`${fmtBytes(c.doneBytes || 0)} / ${fmtBytes(c.totalBytes)}`);
  if (c.speed) parts.push(`<b>${esc(String(c.speed))}</b>`);
  if (t.finishedAt && t.startedAt) parts.push(`耗时 <b>${fmtDur(t.finishedAt - t.startedAt)}</b>`);
  return parts.map((x) => `<span>${x}</span>`).join('');
}

// The original request the card was created from: message link(s) first, then
// any export-JSON files. Links open the web preview in a new tab.
function sourceHtml(t) {
  const urls = (Array.isArray(t.urls) ? t.urls : []).filter(Boolean);
  const files = (Array.isArray(t.files) ? t.files : []).filter(Boolean);
  if (!urls.length && !files.length) return '';
  const links = urls.map((u) =>
    `<a class="task-source-link" href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(u)}</a>`);
  const fileTags = files.map((f) =>
    `<span class="task-source-file" title="${esc(f)}">📄 ${esc(f)}</span>`);
  return `<div class="task-source">${[...links, ...fileTags].join(' ')}</div>`;
}

export function taskCard(t, { showLogs } = {}) {
  const meta = TYPE_META[t.type] || { ico: '•', name: t.type };
  const c = t.counters || {};
  const pct = c.totalBytes > 0
    ? Math.round(((c.doneBytes || 0) / c.totalBytes) * 100)
    : (c.itemsKnown ? Math.round(((c.done || 0) / c.itemsKnown) * 100) : 0);
  const running = t.status === 'running';
  const items = (t.items || []).slice(0, 30);
  return `
  <div class="card task-card" data-task="${esc(t.id)}">
    <div class="task-head">
      <div class="type-ico">${meta.ico}</div>
      <div>
        <div class="task-title">${meta.name} <span class="muted small">#${esc(t.id)}</span> <span class="muted small">ns:${esc(t.ns || '')}</span></div>
        <div class="task-sub">${fmtTime(t.createdAt)}${t.dir ? ` · ${esc(t.dir)}` : ''}</div>
      </div>
      <div class="task-head-right">
        <span class="badge ${esc(t.status)}">${STATUS_NAME[t.status] || t.status}</span>
        ${t.resumed ? '<span class="badge" title="本次为续传">续传</span>' : ''}
        ${t.canPause ? `<button class="btn sm" data-act="pause">暂停</button>` : ''}
        ${t.canResume ? `<button class="btn sm primary" data-act="resume">继续</button>` : ''}
        ${running ? `<button class="btn sm danger" data-act="cancel">取消</button>` : ''}
        ${t.status !== 'running' && t.status !== 'queued' ? `<button class="btn sm" data-act="del">删除</button>` : ''}
        <button class="btn sm" data-act="toggle-args">命令</button>
      </div>
    </div>
    ${sourceHtml(t)}
    <div class="task-args">$ tdl ${esc(t.args || '')}</div>
    ${t.error ? `<div class="task-sub" style="color:var(--fail);margin-top:8px">⚠ ${esc(t.error)}</div>` : ''}
    <div class="task-stats">${statsHtml(t)}</div>
    <div class="progress ${t.status === 'success' ? 'ok' : ''}"><div style="width:${running || t.status === 'success' ? pct : pct}%"></div></div>
    ${items.length ? `<div class="task-items" style="margin-top:8px">${items.map(itemRow).join('')}</div>` : ''}
    <div class="task-logs"></div>
    <div style="margin-top:8px;text-align:right">
      <button class="btn sm" data-act="toggle-logs">${showLogs ? '隐藏日志' : '日志'}</button>
    </div>
  </div>`;
}

export function bindTaskCardEvents(rootEl, rerender) {
  rootEl.querySelectorAll('[data-task]').forEach((card) => {
    const id = card.getAttribute('data-task');
    card.querySelectorAll('[data-act]').forEach((btn) => {
      const act = btn.getAttribute('data-act');
      btn.onclick = async (e) => {
        e.stopPropagation();
        try {
          if (act === 'cancel') {
            await api(`/api/tasks/${id}/cancel`, { method: 'POST' });
            toast('已发送取消请求', 'ok');
          } else if (act === 'pause') {
            btn.disabled = true;
            btn.textContent = '暂停中…';
            await api(`/api/tasks/${id}/pause`, { method: 'POST' });
            toast('已暂停，进度已保存，可随时继续', 'ok');
          } else if (act === 'resume') {
            btn.disabled = true;
            btn.textContent = '启动中…';
            await api(`/api/tasks/${id}/resume`, { method: 'POST' });
            toast('已继续下载（自动续传）', 'ok');
          } else if (act === 'del') {
            await api(`/api/tasks/${id}`, { method: 'DELETE' });
            store.tasks.delete(id);
            rerender();
          } else if (act === 'toggle-args') {
            const el = card.querySelector('.task-args');
            el.style.display = el.style.display === 'block' ? 'none' : 'block';
          } else if (act === 'toggle-logs') {
            const box = card.querySelector('.task-logs');
            if (box.style.display === 'block') { box.style.display = 'none'; btn.textContent = '日志'; return; }
            const r = await api(`/api/tasks/${id}`);
            box.textContent = (r.task.logs || []).join('\n') || '（暂无日志）';
            box.style.display = 'block';
            btn.textContent = '隐藏日志';
          }
        } catch (err) { toast(err.message, 'error'); }
      };
    });
  });
}

export function renderTaskList(container, filterType) {
  container.dataset.filterType = filterType || '';
  const list = [...store.tasks.values()]
    .filter((t) => !filterType || t.type === filterType)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  container.innerHTML = list.length
    ? list.map((t) => taskCard(t)).join('')
    : `<div class="card"><div class="empty">暂无任务，在上方创建一个吧</div></div>`;
  bindTaskCardEvents(container, () => renderTaskList(container, filterType));
}

// ---- chat picker -------------------------------------------------------------

export async function pickChat({ title = '选择会话', onPick } = {}) {
  const m = modal(title, `<div class="chat-pick" id="chat-pick-box"><div class="empty"><span class="spin">◐</span> 正在加载会话列表…</div></div>`);
  const box = m.el.querySelector('#chat-pick-box');
  const { data, error } = await loadChats();
  if (error || !data) {
    box.innerHTML = `<div class="empty">加载失败：${esc(error || '未知错误')}<br><br>
      <button class="btn sm" id="chat-retry">重试</button>
      <span class="small muted">需已登录；列表通过 tdl chat ls 获取</span></div>`;
    box.querySelector('#chat-retry').onclick = () => { m.close(); pickChat({ title, onPick }); };
    return;
  }
  const render = (kw) => {
    const kwLc = (kw || '').toLowerCase();
    const rows = data.filter((c) => !kwLc
      || (c.visible_name || '').toLowerCase().includes(kwLc)
      || (c.username || '').toLowerCase().includes(kwLc)
      || String(c.id).includes(kwLc));
    box.innerHTML = `
      <input type="text" id="chat-search" placeholder="搜索名称 / 用户名 / ID" style="width:100%;margin-bottom:10px">
      <div class="chat-pick" style="max-height:320px">
        ${rows.length ? rows.map((c) => `
          <div class="chat-row" data-id="${esc(c.id)}" data-username="${esc(c.username || '')}">
            <div class="avatar">${esc((c.visible_name || '?')[0] || '?')}</div>
            <div style="min-width:0">
              <div class="t">${esc(c.visible_name || c.username || c.id)} <span class="badge">${esc(c.type)}</span></div>
              <div class="s">${c.username ? '@' + esc(c.username) + ' · ' : ''}ID: ${esc(c.id)}${c.topics && c.topics.length ? ' · ' + c.topics.length + ' 个话题' : ''}</div>
            </div>
          </div>`).join('') : '<div class="empty">没有匹配的会话</div>'}
      </div>`;
    box.querySelector('#chat-search').oninput = (e) => render(e.target.value);
    box.querySelectorAll('.chat-row').forEach((row) => {
      row.onclick = () => {
        onPick({
          id: row.getAttribute('data-id'),
          username: row.getAttribute('data-username'),
          chat: data.find((c) => String(c.id) === row.getAttribute('data-id')),
        });
        m.close();
      };
    });
  };
  render('');
}

// form value helpers
export function val(id) { const el = document.getElementById(id); return el ? String(el.value).trim() : ''; }
export function checked(id) { const el = document.getElementById(id); return !!(el && el.checked); }
export function numVal(id, dflt = 0) { const n = Number(val(id)); return Number.isFinite(n) ? n : dflt; }
export function lines(id) {
  return val(id).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// ---- 通用小播放器（文件页预览用）--------------------------------------------
//
// 与「在线播放」页的播放器刻意分开：那个是和 tdl serve 会话、预取池、
// 进度条 HUD 绑在一起的复杂组件；这里只需要把一个已经能直接读的 URL 放出来。
// 但保留用户要的两个能力：**浮动窗**（可拖动、可缩放）与**网页内最大化**。
//
// 关键约束同 play.js：全程只切 class，不重建 DOM —— 重新挂载 <video> 会
// 让浏览器卸载并重载视频源，播放中断、进度归零。

export function openMiniPlayer(mount, { src, title = '' } = {}) {
  if (!mount) throw new Error('缺少挂载点');
  mount.innerHTML = `
    <div class="mini-player" id="mp-shell">
      <div class="mp-dragbar" id="mp-dragbar">
        <span class="mp-dots">⋮⋮</span>
        <span class="mp-title">${esc(title)}</span>
        <span class="mp-hint">拖标题移动 · 拖右下角缩放</span>
        <button class="mp-x" id="mp-close" title="退出浮动窗">✕</button>
      </div>
      <video id="mp-video" playsinline preload="metadata" src="${esc(src)}"></video>
      <div class="mp-bar" id="mp-bar">
        <button class="btn xs" id="mp-toggle">▶</button>
        <span class="mp-time" id="mp-time">0:00 / 0:00</span>
        <input type="range" class="mp-seek" id="mp-seek" min="0" max="1000" value="0">
        <button class="btn xs" id="mp-mute">🔊</button>
        <input type="range" class="mp-vol" id="mp-vol" min="0" max="1" step="0.05" value="1">
        <button class="btn xs" id="mp-float" title="浮动窗（可拖动、可缩放）">⧉</button>
        <button class="btn xs" id="mp-max" title="网页内最大化">⛶</button>
      </div>
      <div class="mp-resize" id="mp-resize" title="拖动调整大小"></div>
    </div>`;

  const shell = mount.querySelector('#mp-shell');
  const video = mount.querySelector('#mp-video');
  const seek = mount.querySelector('#mp-seek');
  const timeEl = mount.querySelector('#mp-time');
  const toggle = mount.querySelector('#mp-toggle');
  const muteBtn = mount.querySelector('#mp-mute');
  const volEl = mount.querySelector('#mp-vol');
  const floatBtn = mount.querySelector('#mp-float');
  const maxBtn = mount.querySelector('#mp-max');
  const dragbar = mount.querySelector('#mp-dragbar');
  const grip = mount.querySelector('#mp-resize');

  // ---- 基础播放控制 ----
  const fmt = (s) => {
    if (!Number.isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const sync = () => {
    timeEl.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
    if (video.duration) seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
  };
  const setIcon = () => { toggle.textContent = video.paused ? '▶' : '❚❚'; };

  toggle.onclick = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
  video.onclick = () => toggle.onclick();
  video.onplay = setIcon;
  video.onpause = setIcon;
  video.ontimeupdate = sync;
  video.onloadedmetadata = sync;
  video.ondurationchange = sync;
  seek.oninput = () => {
    if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration;
  };
  muteBtn.onclick = () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
  };
  volEl.oninput = () => { video.volume = Number(volEl.value); };

  // ---- 尺寸模式：内嵌 / 浮动 / 网页内最大化 ----
  const MARGIN = 8, MIN_W = 280, MIN_H = 180;
  let mode = 'inline';
  let geom = null;

  const clamp = (g) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(Math.max(g.w, MIN_W), Math.max(MIN_W, vw - MARGIN * 2));
    const h = Math.min(Math.max(g.h, MIN_H), Math.max(MIN_H, vh - MARGIN * 2));
    const x = Math.min(Math.max(g.x, MARGIN), Math.max(MARGIN, vw - w - MARGIN));
    const y = Math.min(Math.max(g.y, MARGIN), Math.max(MARGIN, vh - h - MARGIN));
    return { x, y, w, h };
  };
  const apply = (g) => {
    shell.style.left = `${g.x}px`; shell.style.top = `${g.y}px`;
    shell.style.width = `${g.w}px`; shell.style.height = `${g.h}px`;
  };
  const read = () => {
    const x = parseFloat(shell.style.left), y = parseFloat(shell.style.top);
    const w = parseFloat(shell.style.width), h = parseFloat(shell.style.height);
    return [x, y, w, h].every(Number.isFinite) ? clamp({ x, y, w, h }) : null;
  };
  const defaultGeom = () => {
    const w = Math.min(560, window.innerWidth - MARGIN * 2);
    const h = Math.round((w * 9) / 16) + 40;
    return clamp({ x: window.innerWidth - w - 24, y: window.innerHeight - h - 24, w, h });
  };

  const setMode = (next) => {
    if (mode === 'floating' && next !== 'floating') {
      const g = read(); if (g) geom = g;
    }
    mode = next;
    shell.classList.toggle('mp-floating', next === 'floating');
    shell.classList.toggle('mp-maximized', next === 'maximized');
    if (next === 'floating') { apply(clamp(geom || defaultGeom())); }
    else {
      shell.style.left = ''; shell.style.top = '';
      shell.style.width = ''; shell.style.height = '';
    }
    floatBtn.classList.toggle('pl-on', next === 'floating');
    maxBtn.classList.toggle('pl-on', next === 'maximized');
    maxBtn.textContent = next === 'maximized' ? '❐' : '⛶';
    maxBtn.title = next === 'maximized' ? '还原播放器' : '网页内最大化';
  };

  floatBtn.onclick = () => setMode(mode === 'floating' ? 'inline' : 'floating');
  maxBtn.onclick = () => setMode(mode === 'maximized' ? 'inline' : 'maximized');
  mount.querySelector('#mp-close').onclick = (e) => { e.stopPropagation(); setMode('inline'); };

  // ---- 拖动 / 缩放（pointer 事件，鼠标与触摸同一套）----
  function bindDrag(handle, kind) {
    let active = null;
    handle.addEventListener('pointerdown', (e) => {
      if (mode !== 'floating') return;
      if (kind === 'drag' && e.target.closest && e.target.closest('button')) return;
      const g = read(); if (!g) return;
      e.preventDefault();
      active = { sx: e.clientX, sy: e.clientY, g, ratio: g.h / g.w };
      try { handle.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
      shell.classList.add(kind === 'resize' ? 'mp-resizing' : 'mp-dragging');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - active.sx, dy = e.clientY - active.sy, g0 = active.g;
      let g;
      if (kind === 'resize') {
        // 默认锁比例；按住 Shift 自由变形
        if (e.shiftKey) g = { x: g0.x, y: g0.y, w: g0.w + dx, h: g0.h + dy };
        else {
          const r = active.ratio || 9 / 16;
          const w = g0.w + dx;
          g = { x: g0.x, y: g0.y, w, h: Math.round(w * r) };
        }
        // 贴边时按比例回缩，避免右下角顶出视口
        if (g.x + g.w > window.innerWidth - MARGIN || g.y + g.h > window.innerHeight - MARGIN) {
          const cw = Math.min(g.w, window.innerWidth - g.x - MARGIN);
          const ch = Math.min(g.h, window.innerHeight - g.y - MARGIN);
          const s = Math.min(cw / g.w, ch / g.h);
          if (s < 1) g = { x: g.x, y: g.y, w: Math.round(g.w * s), h: Math.round(g.h * s) };
        }
      } else {
        g = { x: g0.x + dx, y: g0.y + dy, w: g0.w, h: g0.h };
      }
      apply(clamp(g));
    });
    const end = (e) => {
      if (!active) return;
      active = null;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      shell.classList.remove('mp-dragging', 'mp-resizing');
      const g = read(); if (g) geom = g;
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  bindDrag(dragbar, 'drag');
  bindDrag(grip, 'resize');

  // 视口变化时把浮动窗夹回可见区域
  const reclamp = () => { if (mode === 'floating') { const g = read(); if (g) apply(clamp(g)); } };
  window.addEventListener('resize', reclamp);

  // 关闭时解绑，避免监听器泄漏
  const origRemove = mount.remove.bind(mount);
  mount.remove = () => { window.removeEventListener('resize', reclamp); origRemove(); };

  video.play().catch(() => { /* 自动播放可能被拦，用户点一下即可 */ });
  setIcon();
  return { video, setMode };
}
