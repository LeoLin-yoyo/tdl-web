// 在线播放: paste Telegram links → resolve the files through a playback
// session → play in the browser while a parallel prefetch pool feeds the
// player faster than real time. 边看边下 creates a regular download task for
// the same links, whose .part blocks the player reuses.

import { api, esc, fmtBytes, registerRoute, toast, store } from '../app.js';

// 播放器尺寸模式（三选一，互斥）：
//   'inline'    —— 嵌在卡片里（默认）
//   'floating'  —— 浮动窗：脱离文档流、可拖动、可缩放、右下角常驻
//   'maximized' —— 网页内最大化：铺满浏览器视口（不是显示器全屏）
//
// 注意与浏览器原生全屏（requestFullscreen）的区别：原生全屏会占用整块
// 显示器并拦截 Esc，是"离开网页"的行为；这里两种模式都仍在网页内，
// 只是改变播放器在页面中的占位。
const state = {
  session: null,          // last snapshot from the server
  playingIdx: -1,
  downloadFor: null,      // sid a 边看边下 task was already created for
  parsing: false,
  mediaOnly: false,
  sizeMode: 'inline',     // 播放器尺寸模式，见上
  floatGeom: null,        // 浮动窗几何 {x,y,w,h}，跨文件/跨页面切换保留
};

let hud = null;      // active player wiring (cleared when the page unmounts)
let hudTimer = null; // idle timer that hides the control overlay

// ---- 浏览器侧的真实接收速度 ------------------------------------------------
//
// 播放器右上角原先显示的 `netBps` 来自服务端，统计的是「服务器从 tdl serve
// 取到多少字节」——那是服务器与 Telegram 之间的速度，跟数据送到这台电脑的
// 快慢毫无关系。两者可以差一个数量级，于是出现「界面显示缓冲飞快、眼前却
// 一直卡」的错位。
//
// 这里改用浏览器自己的 `video.buffered` 增长量来估算真实送达速度：它量的
// 是「已经躺在这台机器上、随时可播」的字节，正是用户真正能感知的那一段。
//
// 注意作用域：这两个函数供 setupPlayer（建立 HUD）之外的 startStatsPoll
// （轮询）使用，所以必须放在模块级。早先误放在 setupPlayer 内，导致轮询时
// 抛 "sampleDl is not defined"，而空 catch 把它吞了，HUD 永远停在占位「—」。
const dlBufferedEnd = (video) => {
  try {
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) end = Math.max(end, video.buffered.end(i));
    return end;
  } catch { return 0; }
};

// 采样真实送达速度（字节/秒）。缓冲区间会因 seek 重置，故只在单调增长时取值。
const sampleDownloadRate = (video) => {
  const t = dlBufferedEnd(video);
  const now = Date.now();
  const prev = hud && hud.dl;
  if (hud) hud.dl = { t, at: now };
  if (!prev || now - prev.at < 900 || t <= prev.t) return null;
  return Math.round((t - prev.t) / ((now - prev.at) / 1000));
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
    // Only hide while the picture is actually flowing. Paused or stalled
    // (buffering / route hiccup) keeps the controls up — hiding them there
    // is how the play/pause button and buffered bar "disappeared".
    if (v && !v.paused && v.readyState >= 3) ui.classList.add('pl-hidden');
  }, 2600);
}

// ---- 尺寸模式：浮动窗 / 网页内最大化 ---------------------------------------
//
// 一段说明为什么不用 <dialog> 或拖拽库：播放器里有一个正在播放的 <video>，
// 任何"重建 DOM"的做法（innerHTML、移动节点到别处再放回）都会让浏览器
// 卸载并重新加载视频源，导致播放中断、进度归零。所以这里**只切换 class**
// 与内联样式，DOM 结构在会话期间始终不变，视频流不断。

const FLOAT_MIN_W = 280;
const FLOAT_MIN_H = 180;
const FLOAT_MARGIN = 8;   // 浮动窗与视口边缘至少留这么多像素

// 把浮动窗夹回视口内：拖到屏幕外就再也抓不回来的窗口是没法用的。
function clampFloat(g) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(g.w, FLOAT_MIN_W), Math.max(FLOAT_MIN_W, vw - FLOAT_MARGIN * 2));
  const h = Math.min(Math.max(g.h, FLOAT_MIN_H), Math.max(FLOAT_MIN_H, vh - FLOAT_MARGIN * 2));
  const x = Math.min(Math.max(g.x, FLOAT_MARGIN), Math.max(FLOAT_MARGIN, vw - w - FLOAT_MARGIN));
  const y = Math.min(Math.max(g.y, FLOAT_MARGIN), Math.max(FLOAT_MARGIN, vh - h - FLOAT_MARGIN));
  return { x, y, w, h };
}

// 默认位置：右下角，宽 480，按 16:9 推高
function defaultFloat() {
  const w = Math.min(480, window.innerWidth - FLOAT_MARGIN * 2);
  const h = Math.round((w * 9) / 16);
  return clampFloat({
    x: window.innerWidth - w - 24,
    y: window.innerHeight - h - 24,
    w,
    h,
  });
}

// 几何持久化：拖动/缩放后记住，播放会话内切换模式不丢。
const FLOAT_KEY = 'tdlweb.player.float';

function saveFloatGeom(g) {
  state.floatGeom = g;
  try { localStorage.setItem(FLOAT_KEY, JSON.stringify(g)); } catch { /* 隐私模式等 */ }
}

function loadFloatGeom() {
  try {
    const raw = localStorage.getItem(FLOAT_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (!g || !Number.isFinite(g.w) || !Number.isFinite(g.h)) return null;
    return g;
  } catch { return null; }
}

// 拖动 / 缩放：用 pointer 事件 + setPointerCapture，鼠标与触摸同一套代码。
// 只在用户真正按下拖动柄时才改坐标，不去监听视频区域的点击（那要留给播放/暂停）。
function makeDragHandle(shell, handle, mode, getGeom, onDone) {
  if (!handle) return;
  let active = null;
  handle.addEventListener('pointerdown', (e) => {
    if (state.sizeMode !== 'floating') return;
    // 拖动条里嵌着按钮（✕）：点在按钮上时不要开始拖动，
    // 否则 setPointerCapture 会把后续事件全抢走，按钮的 click 永远收不到
    // ——实测「点✕关不掉浮动窗」就是这个原因。
    if (mode === 'drag' && e.target && e.target.closest && e.target.closest('button')) return;
    const g = getGeom();
    if (!g) return;
    e.preventDefault();
    active = { startX: e.clientX, startY: e.clientY, g, ratio: g.h / g.w };
    try { handle.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    shell.classList.add(mode === 'resize' ? 'pl-resizing' : 'pl-dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - active.startX;
    const dy = e.clientY - active.startY;
    const g0 = active.g;
    let g;
    if (mode === 'resize') {
      // 默认锁定 16:9（跟随视频区域的常见比例），按住 Shift 可自由变形。
      // 锁定比例能避免用户随手一拖就把画面拉变形；需要精确控制时用 Shift。
      if (e.shiftKey) {
        g = { x: g0.x, y: g0.y, w: g0.w + dx, h: g0.h + dy };
      } else {
        // 以宽为准推算高，保持初始宽高比
        const ratio = active.ratio || (g0.h / g0.w) || 9 / 16;
        const w = g0.w + dx;
        g = { x: g0.x, y: g0.y, w, h: Math.round(w * ratio) };
      }
      // 缩放到与视口边缘贴合时，把窗口也拉回视口内（否则右下角会顶出去）
      if (g.x + g.w > window.innerWidth - FLOAT_MARGIN || g.y + g.h > window.innerHeight - FLOAT_MARGIN) {
        const clampedW = Math.min(g.w, window.innerWidth - g.x - FLOAT_MARGIN);
        const clampedH = Math.min(g.h, window.innerHeight - g.y - FLOAT_MARGIN);
        const shrink = Math.min(clampedW / g.w, clampedH / g.h);
        if (shrink < 1) {
          g = { x: g.x, y: g.y, w: Math.round(g.w * shrink), h: Math.round(g.h * shrink) };
        }
      }
    } else {
      g = { x: g0.x + dx, y: g0.y + dy, w: g0.w, h: g0.h };
    }
    const c = clampFloat(g);
    applyFloatGeometry(shell, c);
    onDone(c, false);
  });
  const end = (e) => {
    if (!active) return;
    active = null;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
    shell.classList.remove('pl-dragging', 'pl-resizing');
    const g = readFloatGeometry(shell);
    if (g) onDone(g, true);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function applyFloatGeometry(shell, g) {
  shell.style.left = `${g.x}px`;
  shell.style.top = `${g.y}px`;
  shell.style.width = `${g.w}px`;
  shell.style.height = `${g.h}px`;
}

function readFloatGeometry(shell) {
  const x = parseFloat(shell.style.left);
  const y = parseFloat(shell.style.top);
  const w = parseFloat(shell.style.width);
  const h = parseFloat(shell.style.height);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return clampFloat({ x, y, w, h });
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
  const floatBtn = view.querySelector('#pl-float');
  const maxBtn = view.querySelector('#pl-max');
  const dragBar = view.querySelector('#pl-dragbar');
  const resizeGrip = view.querySelector('#pl-resize');
  const wrapCard = view.querySelector('#player-card');

  hud = { shell, video, poll: null, idx: -1, sid: '', dl: null };

  // ---- 尺寸模式切换：浮动窗 / 网页内最大化 ----
  //
  // 三个按钮共用一个 setSizeMode，保证任意时刻只有一种模式生效。
  // 切模式时不碰 <video>：只改 class 与几何，播放不中断。
  const isFloat = () => state.sizeMode === 'floating';
  const isMax = () => state.sizeMode === 'maximized';

  const paintSizeButtons = () => {
    if (floatBtn) floatBtn.classList.toggle('pl-on', isFloat());
    if (maxBtn) maxBtn.classList.toggle('pl-on', isMax());
    if (floatBtn) floatBtn.title = isFloat() ? '退出浮动窗（P）' : '浮动窗：可拖动、可缩放，边看边做别的（P）';
    if (maxBtn) maxBtn.title = isMax() ? '还原播放器（Z）' : '网页内最大化：铺满浏览器窗口（Z）';
    if (maxBtn) maxBtn.textContent = isMax() ? '❐' : '⛶';
  };

  const setSizeMode = (mode) => {
    // 原生全屏与这两种模式互斥：从全屏里点浮动会先退出全屏，避免两层叠加。
    if (document.fullscreenElement && mode !== 'fullscreen') {
      document.exitFullscreen().catch(() => {});
    }
    if (mode === 'fullscreen') {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else shell.requestFullscreen().catch(() => toast('无法进入全屏（浏览器限制）', 'error'));
      return;
    }

    // 离开浮动模式前记下几何，回来时恢复（这也是"切到最大化再切回来不跳位置"的关键）
    if (isFloat() && mode !== 'floating') {
      const g = readFloatGeometry(shell);
      if (g) saveFloatGeom(g);
    }

    state.sizeMode = mode;
    shell.classList.toggle('pl-floating', mode === 'floating');
    shell.classList.toggle('pl-maximized', mode === 'maximized');
    view.classList.toggle('pl-has-max', mode === 'maximized');

    if (mode === 'floating') {
      const g = clampFloat(state.floatGeom || loadFloatGeom() || defaultFloat());
      applyFloatGeometry(shell, g);
      saveFloatGeom(g);
      // 浮动窗脱离了卡片，卡片本身收起，免得页面里留一块空白
      if (wrapCard) wrapCard.classList.add('pl-card-detached');
    } else {
      shell.style.left = '';
      shell.style.top = '';
      shell.style.width = '';
      shell.style.height = '';
      if (wrapCard) wrapCard.classList.remove('pl-card-detached');
    }

    paintSizeButtons();
    showUi(shell);
  };

  hud.setSizeMode = setSizeMode;
  hud.cycleFromFullscreen = () => { /* 由 fullscreenchange 填充 */ };

  makeDragHandle(shell, dragBar, 'drag',
    () => readFloatGeometry(shell),
    (g, done) => { if (done) saveFloatGeom(g); });
  makeDragHandle(shell, resizeGrip, 'resize',
    () => readFloatGeometry(shell),
    (g, done) => { if (done) saveFloatGeom(g); });

  // 缩放/拖动只改了内联样式，这里把边界约束同步回去，避免拖出视口后
  // 样式里的坐标和实际显示不一致（下一次读回来就会跳一下）。
  const reclamp = () => {
    if (!isFloat()) return;
    const g = readFloatGeometry(shell);
    if (!g) return;
    const c = clampFloat(g);
    applyFloatGeometry(shell, c);
    saveFloatGeom(c);
  };
  hud.reclamp = reclamp;
  window.addEventListener('resize', reclamp);
  hud.onWindowResize = reclamp;

  if (floatBtn) floatBtn.onclick = () => setSizeMode(isFloat() ? 'inline' : 'floating');
  if (maxBtn) maxBtn.onclick = () => setSizeMode(isMax() ? 'inline' : 'maximized');
  const dragX = view.querySelector('#pl-drag-x');
  if (dragX) dragX.onclick = (e) => { e.stopPropagation(); setSizeMode('inline'); };

  // （真实接收速度的采样函数见文件顶部 sampleDownloadRate —— 那里是模块级，
  //   因为轮询逻辑在另一个函数里，需要共用。）

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
  fsBtn.onclick = () => setSizeMode('fullscreen');
  hud.fsChangeHandler = () => {
    fsBtn.textContent = document.fullscreenElement ? '⤢' : '⛶';
    // 原生全屏与网页内最大化是两回事，进全屏时把最大化收掉，
    // 退出全屏后回到嵌入态，避免「全屏里套着一个最大化」的怪异层叠。
    if (document.fullscreenElement && isMax()) {
      state.sizeMode = 'inline';
      shell.classList.remove('pl-maximized');
      view.classList.remove('pl-has-max');
      if (wrapCard) wrapCard.classList.remove('pl-card-detached');
      paintSizeButtons();
    }
  };
  document.addEventListener('fullscreenchange', hud.fsChangeHandler);

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
  // Buffering is exactly when the user needs the controls (and wants to see
  // that something IS happening): keep the bar up and label it.
  video.addEventListener('waiting', () => {
    shell.classList.add('pl-waiting');
    showUi(shell);
    const badge = view.querySelector('#pl-speed');
    if (badge && !badge.dataset.userText) badge.dataset.stalled = '1';
  });
  video.addEventListener('playing', () => {
    shell.classList.remove('pl-waiting');
    const badge = view.querySelector('#pl-speed');
    if (badge) delete badge.dataset.stalled;
  });
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
      case 'f': setSizeMode('fullscreen'); break;
      case 'p': setSizeMode(isFloat() ? 'inline' : 'floating'); break;
      case 'z': setSizeMode(isMax() ? 'inline' : 'maximized'); break;
      case 'Escape':
        // Esc 在网页内退出最大化/浮动（原生全屏的 Esc 由浏览器自己处理）
        if (!document.fullscreenElement && (isMax() || isFloat())) { e.preventDefault(); setSizeMode('inline'); }
        break;
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
  const netEl = hud.shell.querySelector('#pl-net');
  const video = hud.shell.querySelector('video');
  // 排查用：HUD 的数值区若一直停在 HTML 初始占位「—」，多半是这里没查到位
  // 或 tick() 抛错。先确认取到的元素是真实存在的。
  console.info('[play] stats poll 启动', { sid, idx, hasSpeed: !!speedEl, hasNet: !!netEl, hasVideo: !!video });
  const tick = async () => {
    if (!hud || hud.sid !== sid || hud.idx !== idx) return;
    try {
      const s = await api(`/api/stream/${encodeURIComponent(sid)}/${idx}/stats`);
      if (!hud || hud.sid !== sid || hud.idx !== idx) return;
      if (s.error) { speedEl.textContent = '—'; return; }

      // Paint the proxy's own progress on the track: the browser only buffers
      // what it happens to need, but the proxy prefetches far ahead — that is
      // the real "how much is buffered" picture for a streaming source.
      if (netEl && s.total > 0) {
        const curBytes = Math.max(0, s.cursor * 1048576);
        const ready = Math.max(0, s.buffered - curBytes);
        netEl.style.left = `${Math.min(100, (curBytes / s.total) * 100)}%`;
        netEl.style.width = `${Math.min(100 - (curBytes / s.total) * 100, (ready / s.total) * 100)}%`;
      }

      const ahead = Math.max(0, s.buffered - (s.cursor >= 0 ? s.cursor * 1048576 : 0));
      // While the picture is stalled say so plainly — a silent frozen frame
      // reads as "broken" even when the proxy is retrying the route.
      const stalled = video && !video.paused && video.readyState < 3;

      // 两个速度各司其职，别再混为一谈：
      //   「下载」= 这台电脑真正收到的速度（浏览器 buffered 增长量）
      //   「服务器」= 服务器从 Telegram 取数的速度（仅作参考，不代表你能看到多快）
      // 卡顿几乎总是前者远小于后者，把两个数并排摆出来，问题一眼可见。
      const dl = sampleDownloadRate(video);
      if (dl !== null) hud.lastDl = dl;
      const dlRate = hud.lastDl;
      const srvTxt = s.netBps ? `服务器 ${fmtBytes(s.netBps)}/s` : '服务器 —';

      // 「下载速度」是缓冲区的增长速率。当播放头前方已经屯了足够多的数据
      // （或整个文件都缓冲完了），缓冲区不再增长，采样会趋近 0——此时显示
      // "1 B/s" 会被误读成"网速崩了"，其实恰恰相反。所以：够用就直说够用，
      // 把真实数值留给真正在追赶网络的时刻。
      const COMFY = 8 * 1048576; // 前方有 8MB 余量就不必报速度了
      const comfy = ahead >= COMFY;
      const dlTxt = comfy
        ? '下载 已充分缓冲'
        : (dlRate ? `下载 ${fmtBytes(dlRate)}/s` : '下载 —');

      speedEl.textContent = stalled
        ? `缓冲中 · ${dlTxt} · ${srvTxt}`
        : `${dlTxt} · ${srvTxt}${ahead > 0 ? ` · 领先 ${fmtBytes(ahead)}` : ''}`;
      // 告警条件改用「真实送达速度」：服务器再快，送不到这台电脑就是卡。
      // 4 MB/s 约合 32 Mbps，是 4K 顺畅播放的粗略下限。已充分缓冲时不告警。
      speedEl.classList.toggle('warn', stalled || (!comfy && !!dlRate && dlRate < 4 * 1048576));
    } catch (e) {
      // 这里原来是个空 catch。结果 tick() 一旦抛错，HUD 就永远停在 HTML 里的
      // 初始占位「—」，看起来像"没数据"，实际是脚本挂了——排查时因此白绕了
      // 一大圈（以为是接口出错，curl 却一路 200）。留个痕迹，至少能在控制台
      // 看见真因；顺带把状态显示出来，好和"正常但值为空"区分开。
      if (hud && hud.sid === sid) speedEl.textContent = `统计异常: ${String(e && e.message || e).slice(0, 60)}`;
      console.error('[play] stats tick 失败', e);
    }
  };
  tick();
  hud.poll = setInterval(tick, 1000);
}

function teardownPlayer() {
  if (!hud) return;
  if (hud.poll) clearInterval(hud.poll);
  if (hud.keyHandler) document.removeEventListener('keydown', hud.keyHandler);
  if (hud.fsChangeHandler) document.removeEventListener('fullscreenchange', hud.fsChangeHandler);
  if (hud.onWindowResize) window.removeEventListener('resize', hud.onWindowResize);
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
  const dragTitle = view.querySelector('#pl-drag-title');
  if (dragTitle) dragTitle.textContent = file.name;
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
            <div class="pl-dragbar" id="pl-dragbar" title="按住拖动浮动窗口">
              <span class="pl-drag-dots">⋮⋮</span>
              <span class="pl-drag-title" id="pl-drag-title">浮动窗</span>
              <span class="pl-drag-hint">拖动标题栏移动 · 拖右下角缩放</span>
              <button class="pl-drag-x" id="pl-drag-x" title="关闭浮动窗（回到页面内）">✕</button>
            </div>
            <div class="pl-ui pl-hidden">
              <div class="pl-badge pl-res" id="pl-res">—</div>
              <div class="pl-badge pl-speed" id="pl-speed">—</div>
              <button class="pl-center" id="pl-center" title="播放/暂停">▶</button>
              <div class="pl-bar">
                <div class="pl-track" id="pl-track" title="拖动跳转">
                  <div class="pl-net" id="pl-net"></div>
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
                  <button class="pl-btn" id="pl-float" title="浮动窗：可拖动、可缩放，边看边做别的（P）">⧉</button>
                  <button class="pl-btn" id="pl-max" title="网页内最大化：铺满浏览器窗口（Z）">⛶</button>
                  <button class="pl-btn" id="pl-fs" title="全屏（F）">⤢</button>
                </div>
              </div>
            </div>
            <div class="pl-resize" id="pl-resize" title="拖动调整窗口大小"></div>
          </div>
          <div class="hint muted small" style="margin-top:6px">
            移动鼠标显示控制条与信息；全屏后自动隐藏。快捷键：空格播放/暂停、←/→ 快退快进 5s、↑/↓ 音量、F 全屏、M 静音、P 浮动窗、Z 网页内最大化。
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
