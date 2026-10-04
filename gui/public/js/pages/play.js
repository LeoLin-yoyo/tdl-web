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

let hud = null;      // active player wiring (cleared when the page unmounts)
let hudTimer = null; // idle timer that hides the control overlay

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

// mm:ss (or h:mm:ss for long videos)
function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

function renderList(view) {
  const box = view.querySelector('#file-list');
  const sess = state.session;
  if (!box) return;
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

// ---- player HUD ----------------------------------------------------------
//
// Custom control layer over <video>: the native bar cannot show a buffered
// range together with our own badges (resolution top-left, prefetch speed
// top-right). Everything lives in one overlay that fades out after the mouse
// goes idle — including in fullscreen — so nothing lingers over the picture.

function showUi(shell, sticky = false) {
  const ui = shell.querySelector('.pl-ui');
  ui.classList.remove('pl-hidden');
  if (hudTimer) clearTimeout(hudTimer);
  if (sticky) return; // pointer is over the controls: keep them up
  hudTimer = setTimeout(() => {
    const v = shell.querySelector('video');
    if (v && !v.paused) ui.classList.add('pl-hidden'); // never hide while paused
  }, 2600);
}

function setupPlayer(view) {
  const shell = view.querySelector('#player-shell');
  const video = view.querySelector('#player');
  const ui = view.querySelector('.pl-ui');
  const track = view.querySelector('#pl-track');
  const bufEl = view.querySelector('#pl-buf');
  const playEl = view.querySelector('#pl-play');
  const thumbEl = view.querySelector('#pl-thumb');
  const timeEl = view.querySelector('#pl-time');
  const resEl = view.querySelector('#pl-res');
  const speedEl = view.querySelector('#pl-speed');
  const centerBtn = view.querySelector('#pl-center');
  const toggleBtn = view.querySelector('#pl-toggle');
  const muteBtn = view.querySelector('#pl-mute');
  const volEl = view.querySelector('#pl-vol');
  const fsBtn = view.querySelector('#pl-fs');

  hud = { shell, video, poll: null, idx: -1, sid: '' };

  const setPlayIcon = () => {
    // The centre button is an overlay affordance only: while playing it fades
    // out so it never sits on the picture. The in-bar button is the always
    // reachable control, so it keeps the real state.
    centerBtn.textContent = video.paused ? '▶' : '❚❚';
    centerBtn.classList.toggle('pl-fade', !video.paused);
    toggleBtn.textContent = video.paused ? '▶' : '❚❚';
    toggleBtn.title = video.paused ? '播放（空格）' : '暂停（空格）';
  };
  const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };

  // ---- progress bar: played + buffered ranges ----
  const paintBar = () => {
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) {
      playEl.style.width = '0%';
      bufEl.style.width = '0%';
      timeEl.textContent = '0:00 / 0:00';
      return;
    }
    const pct = (video.currentTime / dur) * 100;
    playEl.style.width = `${pct}%`;
    thumbEl.style.left = `${pct}%`;

    // Buffered ranges come as a TimeRanges list; merge them into one bar so
    // the user sees exactly how much is seekable ahead of the playhead.
    let covered = 0;
    try {
      const ranges = [];
      for (let i = 0; i < video.buffered.length; i++) {
        ranges.push([video.buffered.start(i), video.buffered.end(i)]);
      }
      ranges.sort((a, b) => a[0] - b[0]);
      let end = 0;
      for (const [s, e] of ranges) {
        if (s > end) break;         // gap: only count the contiguous head
        end = Math.max(end, e);
      }
      covered = end;
    } catch { /* not ready */ }
    bufEl.style.width = `${Math.min(100, (covered / dur) * 100)}%`;
    timeEl.textContent = `${fmtClock(video.currentTime)} / ${fmtClock(dur)}`;
  };

  const seekTo = (clientX) => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = ratio * video.duration;
    }
  };
  let dragging = false;
  track.addEventListener('pointerdown', (e) => {
    dragging = true;
    track.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  });
  track.addEventListener('pointermove', (e) => { if (dragging) seekTo(e.clientX); });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { track.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // ---- buttons ----
  centerBtn.onclick = togglePlay;
  toggleBtn.onclick = (e) => { e.stopPropagation(); togglePlay(); showUi(shell); };
  video.onclick = togglePlay;
  muteBtn.onclick = () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
  };
  volEl.oninput = () => { video.volume = Number(volEl.value); video.muted = video.volume === 0; muteBtn.textContent = video.muted ? '🔇' : '🔊'; };
  fsBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else shell.requestFullscreen().catch(() => toast('无法进入全屏（浏览器限制）', 'error'));
  };
  document.addEventListener('fullscreenchange', () => {
    fsBtn.textContent = document.fullscreenElement ? '⤢' : '⛶';
  });

  // ---- resolution badge ----
  const updateRes = () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    resEl.textContent = w && h ? `${w}×${h}${h >= 2000 ? ' 4K' : h >= 1000 ? ' 1080p' : ''}` : '—';
  };
  video.addEventListener('loadedmetadata', () => { updateRes(); paintBar(); });
  video.addEventListener('resize', updateRes);
  video.addEventListener('durationchange', paintBar);
  video.addEventListener('timeupdate', paintBar);
  video.addEventListener('progress', paintBar);
  video.addEventListener('seeked', paintBar);
  video.addEventListener('play', setPlayIcon);
  video.addEventListener('pause', () => { setPlayIcon(); showUi(shell); });
  video.addEventListener('waiting', () => shell.classList.add('pl-waiting'));
  video.addEventListener('playing', () => shell.classList.remove('pl-waiting'));
  video.addEventListener('canplay', () => shell.classList.remove('pl-waiting'));
  // a failed load used to leave the player spinning forever with no hint
  video.addEventListener('error', () => {
    shell.classList.remove('pl-waiting');
    const code = video.error && video.error.code;
    const msg = { 1: '加载被中断', 2: '网络错误', 3: '解码失败', 4: '格式或编码不受浏览器支持' }[code] || '未知错误';
    speedEl.textContent = `播放失败：${msg}`;
    toast(`视频无法播放：${msg}`, 'error');
  });

  // ---- mouse activity controls the whole overlay ----
  shell.addEventListener('pointermove', () => showUi(shell));
  shell.addEventListener('pointerenter', () => showUi(shell));
  ui.addEventListener('pointerenter', () => showUi(shell, true));
  ui.addEventListener('pointerleave', () => showUi(shell));
  shell.addEventListener('pointerleave', () => {
    if (hudTimer) clearTimeout(hudTimer);
    if (!video.paused) ui.classList.add('pl-hidden');
  });

  // ---- keyboard (space / arrows / f / m) ----
  hud.keyHandler = (e) => {
    if (!hud || hud.video !== video) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); showUi(shell); break;
      case 'ArrowRight': video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); showUi(shell); break;
      case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime - 5); showUi(shell); break;
      case 'ArrowUp': video.volume = Math.min(1, video.volume + 0.05); volEl.value = String(video.volume); break;
      case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.05); volEl.value = String(video.volume); break;
      case 'f': fsBtn.onclick(); break;
      case 'm': muteBtn.onclick(); break;
      default: break;
    }
  };
  document.addEventListener('keydown', hud.keyHandler);

  ui.classList.add('pl-hidden');
  setPlayIcon();
  updateRes();
}

// Poll the proxy for prefetch throughput while a file is loaded.
function startStatsPoll(sid, idx) {
  if (!hud) return;
  if (hud.poll) clearInterval(hud.poll);
  hud.sid = sid;
  hud.idx = idx;
  const speedEl = hud.shell.querySelector('#pl-speed');
  const tick = async () => {
    if (!hud || hud.sid !== sid || hud.idx !== idx) return;
    try {
      const s = await api(`/api/stream/${encodeURIComponent(sid)}/${idx}/stats`);
      if (!hud || hud.sid !== sid || hud.idx !== idx) return;
      if (s.error) { speedEl.textContent = '—'; return; }
      const rate = s.netBps ? `${fmtBytes(s.netBps)}/s` : '0 B/s';
      const ahead = Math.max(0, s.buffered - (s.cursor >= 0 ? s.cursor * 1048576 : 0));
      speedEl.textContent = `缓冲 ${rate}${ahead > 0 ? ` · 领先 ${fmtBytes(ahead)}` : ''}`;
      speedEl.classList.toggle('warn', !!s.netBps && s.netBps < 4 * 1048576);
    } catch { /* transient */ }
  };
  tick();
  hud.poll = setInterval(tick, 1000);
}

function teardownPlayer() {
  if (!hud) return;
  if (hud.poll) clearInterval(hud.poll);
  if (hud.keyHandler) document.removeEventListener('keydown', hud.keyHandler);
  hud = null;
  if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
}

async function play(view, idx) {
  const sess = state.session;
  if (!sess) return;
  const file = sess.files[idx];
  if (!file) return;
  const video = view.querySelector('#player');
  const shell = view.querySelector('#player-shell');
  const wrap = view.querySelector('#player-card');
  wrap.classList.remove('hidden');
  state.playingIdx = idx;
  view.querySelector('#player-title').textContent = file.name;
  video.src = `/api/stream/${encodeURIComponent(sess.sid)}/${idx}`;
  video.play().catch(() => { /* autoplay may need a gesture; controls still work */ });
  renderList(view);
  startStatsPoll(sess.sid, idx);
  if (shell) showUi(shell);

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
          <div class="player-shell" id="player-shell">
            <video id="player" playsinline preload="auto"></video>
            <div class="pl-ui pl-hidden">
              <div class="pl-badge pl-res" id="pl-res">—</div>
              <div class="pl-badge pl-speed" id="pl-speed">—</div>
              <button class="pl-center" id="pl-center" title="播放/暂停">▶</button>
              <div class="pl-bar">
                <div class="pl-track" id="pl-track" title="拖动跳转">
                  <div class="pl-buf" id="pl-buf"></div>
                  <div class="pl-play" id="pl-play"></div>
                  <div class="pl-thumb" id="pl-thumb"></div>
                </div>
                <div class="pl-row">
                  <button class="pl-btn pl-btn-play" id="pl-toggle" title="播放/暂停（空格）">▶</button>
                  <span class="pl-time" id="pl-time">0:00 / 0:00</span>
                  <span class="pl-grow"></span>
                  <button class="pl-btn" id="pl-mute" title="静音">🔊</button>
                  <input type="range" class="pl-vol" id="pl-vol" min="0" max="1" step="0.05" value="1" title="音量">
                  <button class="pl-btn" id="pl-fs" title="全屏">⛶</button>
                </div>
              </div>
            </div>
          </div>
          <div class="hint muted small" style="margin-top:6px">
            移动鼠标显示控制条与信息；全屏后自动隐藏。快捷键：空格播放/暂停、←/→ 快退快进 5s、↑/↓ 音量、F 全屏、M 静音。
          </div>
        </div>
      </div>
      <div class="card task-list-col">
        <h2>文件列表</h2>
        <label class="check-row" style="margin-bottom:8px"><input type="checkbox" id="p-mediaonly"> 只看可播放的音视频</label>
        <div id="file-list"></div>
      </div>
    </div>`;

  teardownPlayer();
  await draftLoad(view);
  setupPlayer(view);
  try {
    const r = await api('/api/stream/state');
    if (r.session) state.session = r.session;
  } catch { /* no session yet */ }
  renderList(view);

  view.querySelector('#parse-btn').onclick = () => parse(view);
  view.querySelector('#stop-btn').onclick = async () => {
    teardownPlayer();
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
