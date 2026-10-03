// 在线播放: paste Telegram links → resolve the files through a playback
// session → play in the browser while a parallel prefetch pool feeds the
// player faster than real time. 边看边下 creates a regular download task for
// the same links, whose .part blocks the player reuses.

import { api, esc, fmtBytes, registerRoute, toast, store } from '../app.js';

const state = {
  session: null,          // last snapshot from the server
  playingIdx: -1,
  downloadFor: null,      // sid a 边看边下 task was already created for
  parsing: false,
  mediaOnly: false,
};

function urlsOf() {
  const el = document.getElementById('p-urls');
  return (el ? el.value : '').split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
}

function draftSave() {
  const urls = document.getElementById('p-urls') ? document.getElementById('p-urls').value : '';
  api('/api/forms', { method: 'POST', body: { key: 'stream', data: { urls, withDl: !!document.getElementById('p-withdl')?.checked } } }).catch(() => {});
}

async function draftLoad(view) {
  try {
    const { data } = await api(`/api/forms?key=${encodeURIComponent('stream')}`);
    if (!data) return;
    const urls = view.querySelector('#p-urls');
    if (urls && data.urls) urls.value = String(data.urls);
    const withDl = view.querySelector('#p-withdl');
    if (withDl) withDl.checked = !!data.withDl;
  } catch { /* no draft yet */ }
}

function badge(file) {
  if (!file.ext) return '<span class="tag">无扩展名</span>';
  const playable = `<span class="tag ${file.playable ? 'ok' : 'warn'}">${esc(file.ext)}</span>`;
  return playable;
}

function renderList(view) {
  const box = view.querySelector('#file-list');
  const sess = state.session;
  if (!sess) {
    box.innerHTML = '<div class="empty">解析后这里会列出链接中的媒体文件</div>';
    return;
  }
  if (sess.state === 'exited') {
    box.innerHTML = `<div class="empty">播放服务已退出：${esc(sess.error || '未知原因')}<br>请重新解析。</div>`;
    return;
  }
  const files = state.mediaOnly ? sess.files.filter((f) => f.playable) : sess.files;
  const totalSize = sess.files.reduce((s, f) => s + (f.size || 0), 0);
  const rows = files.slice(0, 500).map((f) => `
    <div class="file-row ${f.idx === state.playingIdx ? 'active' : ''}" data-idx="${f.idx}">
      <div class="file-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="file-meta">${badge(f)}<span class="muted small">${fmtBytes(f.size)}</span></div>
      <button class="btn sm play-btn" data-idx="${f.idx}">播放</button>
    </div>`).join('');
  box.innerHTML = `
    <div class="muted small" style="margin-bottom:8px">
      共 ${sess.files.length} 个文件 · ${fmtBytes(totalSize)} · 会话 <span class="mono">${esc(sess.sid)}</span>
      ${files.length !== sess.files.length ? `（已过滤，显示 ${files.length} 个）` : ''}
    </div>
    ${rows || '<div class="empty">没有可播放的媒体文件</div>'}
    <div class="hint muted small" style="margin-top:10px">
      空闲 ${esc(String((store.config && store.config.streamIdleMin) || 10))} 分钟的播放会话会自动关闭；重新解析会替换当前会话。
    </div>`;

  box.querySelectorAll('.play-btn').forEach((btn) => {
    btn.onclick = () => play(view, Number(btn.dataset.idx));
  });
}

async function play(view, idx) {
  const sess = state.session;
  if (!sess) return;
  const file = sess.files[idx];
  if (!file) return;
  const video = view.querySelector('#player');
  const wrap = view.querySelector('#player-card');
  wrap.classList.remove('hidden');
  state.playingIdx = idx;
  view.querySelector('#player-title').textContent = file.name;
  video.src = `/api/stream/${encodeURIComponent(sess.sid)}/${idx}`;
  video.play().catch(() => { /* autoplay may need a gesture; controls still work */ });
  renderList(view);

  // 边看边下: create download tasks for the session's links once per session —
  // they fill .part files in the background, and the player reads their
  // finished blocks from disk instead of re-fetching the bytes.
  const withDl = view.querySelector('#p-withdl');
  if (withDl && withDl.checked && state.downloadFor !== sess.sid) {
    try {
      const r = await api('/api/tasks', { method: 'POST', body: { type: 'dl', config: { urls: sess.urls } } });
      state.downloadFor = sess.sid;
      toast(`边看边下：已创建 ${r.count || 1} 个下载任务，播完即已落盘`, 'ok');
    } catch (e) {
      toast(`边看边下任务创建失败：${e.message}`, 'error');
    }
  }
}

async function parse(view) {
  if (state.parsing) return;
  const urls = urlsOf();
  if (!urls.length) { toast('请先粘贴消息链接', 'error'); return; }
  state.parsing = true;
  const btn = view.querySelector('#parse-btn');
  btn.disabled = true;
  btn.textContent = '解析中…（启动播放服务并读取文件列表）';
  try {
    const r = await api('/api/stream/preview', { method: 'POST', body: { urls } });
    if (r.error) { toast(r.error, 'error'); return; }
    state.session = r.session;
    state.playingIdx = -1;
    view.querySelector('#player-card').classList.add('hidden');
    renderList(view);
    toast(`解析完成：${r.session.files.length} 个文件`, 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.parsing = false;
    btn.disabled = false;
    btn.textContent = '解析并列出文件';
  }
}

async function render(view) {
  view.innerHTML = `
    <div class="task-layout">
      <div class="task-form-col">
        <div class="card">
          <h2>在线播放</h2>
          <div class="field">
            <label>消息链接（每行一条，可含范围 /起/止）</label>
            <textarea id="p-urls" rows="4" placeholder="https://t.me/tdl/10"></textarea>
            <span class="hint">解析后从列表中点播；播放由本地多连接预取池供流，不需要先下载完</span>
          </div>
          <label class="check-row"><input type="checkbox" id="p-withdl"> 边看边下（同时创建下载任务，看完的视频即已下载好）</label>
          <div style="margin-top:8px">
            <button class="btn primary" id="parse-btn">解析并列出文件</button>
            <button class="btn" id="stop-btn">关闭播放会话</button>
          </div>
          <div class="hint muted small" style="margin-top:6px">
            播放会话使用登录会话的独立副本，与下载任务互不占用；mkv/avi 等容器浏览器可能无法直接播放。
          </div>
        </div>
        <div class="card hidden" id="player-card">
          <h2 id="player-title">正在播放</h2>
          <video id="player" controls preload="auto" playsinline style="width:100%;max-height:60vh;background:#000;border-radius:8px"></video>
        </div>
      </div>
      <div class="card task-list-col">
        <h2>文件列表</h2>
        <label class="check-row" style="margin-bottom:8px"><input type="checkbox" id="p-mediaonly"> 只看可播放的音视频</label>
        <div id="file-list"></div>
      </div>
    </div>`;

  await draftLoad(view);
  try {
    const r = await api('/api/stream/state');
    if (r.session) { state.session = r.session; renderList(view); }
    else renderList(view);
  } catch { renderList(view); }

  view.querySelector('#parse-btn').onclick = () => parse(view);
  view.querySelector('#stop-btn').onclick = async () => {
    try { await api('/api/stream/stop', { method: 'POST', body: { sid: state.session ? state.session.sid : '' } }); } catch { /* ignore */ }
    state.session = null;
    state.playingIdx = -1;
    view.querySelector('#player-card').classList.add('hidden');
    renderList(view);
    toast('播放会话已关闭', 'ok');
  };
  view.querySelector('#p-mediaonly').onchange = (e) => { state.mediaOnly = e.target.checked; renderList(view); };
  view.querySelector('.task-form-col').addEventListener('input', draftSave);
  view.querySelector('.task-form-col').addEventListener('change', draftSave);
}

registerRoute('/play', { title: '在线播放', fit: true, render });
