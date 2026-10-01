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
