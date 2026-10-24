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
    ? `<span class="item-speed">${esc(it.speed || '—')}${it.etaMs > 0 ? ` · 剩 ${fmtDur(it.etaMs)}` : ''}</span>`
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
  if (c.etaMs > 0) parts.push(`<span title="预计 ${fmtTime(Date.now() + c.etaMs)} 完成">剩余 <b>${fmtDur(c.etaMs)}</b></span>`);
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

export function openMiniPlayer(mount, { src, title = '', floating = false, onClose = null, downloadUrl = '' } = {}) {
  if (!mount) throw new Error('缺少挂载点');
  mount.innerHTML = `
    <div class="mini-player" id="mp-shell">
      <div class="mp-dragbar" id="mp-dragbar">
        <span class="mp-dots">⋮⋮</span>
        <span class="mp-title">${esc(title)}</span>
        <span class="mp-actions">
          ${downloadUrl ? `<a class="mp-dl" href="${esc(downloadUrl)}" download title="下载原文件">⤓</a>` : ''}
          <button class="mp-x" id="mp-close" title="关闭播放器">✕</button>
        </span>
      </div>
      <video id="mp-video" playsinline preload="metadata" src="${esc(src)}"></video>
      <div class="mp-bar" id="mp-bar">
        <button class="btn xs" id="mp-toggle">▶</button>
        <span class="mp-time" id="mp-time">0:00 / 0:00</span>
        <input type="range" class="mp-seek" id="mp-seek" min="0" max="1000" value="0">
        <button class="btn xs" id="mp-mute">🔊</button>
        <input type="range" class="mp-vol" id="mp-vol" min="0" max="1" step="0.05" value="1">
        <button class="btn xs" id="mp-fit" title="铺满 / 完整显示">⤡</button>
        <button class="btn xs" id="mp-max" title="网页内最大化">⛶</button>
        <button class="btn xs" id="mp-fs" title="全屏（显示器全屏）">⤢</button>
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
  const maxBtn = mount.querySelector('#mp-max');
  const fsBtn = mount.querySelector('#mp-fs');
  const fitBtn = mount.querySelector('#mp-fit');
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
  // 点画面：
  //   · 手机/最大化/全屏 → 切换控制条显隐（主流 App 的做法；播放交给中间按钮，
  //     避免想看一眼控制条却把视频暂停了）
  //   · 桌面普通浮动窗 → 沿用原行为「切播放/暂停」，不改桌面习惯
  // 拖动窗口结束时不能误触发（拖动会把 click 一起送上来），用 suppressClick 挡一次。
  //
  // ⚠️ 铁律：收起控制条绝不能变成「死路」。
  //   用户反馈「操作栏隐藏之后就不能再呼出了，我不能退出播放了」——
  //   因为控制条 pointer-events:none，✕ 也一起没了，唯一的出路就是点画面唤出。
  //   所以：**只要当前是隐藏态，任何一次点画面都必须唤出，永远不做「再收起」**。
  //   只有在「已经显示」的状态下点画面，才允许收起。
  //   另加 hideAt 时间戳：自动隐藏后 300ms 内的点击一定算「唤出」，
  //   避免同一次触摸自带的 move/click 序列被误判成「再收起」。
  let suppressClick = false;
  video.onclick = () => {
    if (suppressClick) { suppressClick = false; return; }
    if (isImmersive()) {
      hoveringUI = false;                                       // 点画面 = 离开控制条
      // 手机上「点画面」只有一个职责：切换控制条显隐（和 YouTube/抖音一致）。
      // 播放/暂停只由中间的按钮负责，免得想看一眼进度却把视频暂停了。
      // 铁律：隐藏态下点一下**必须**唤出 —— 否则 ✕ 被 pointer-events:none 挡住，
      //       又没有键盘，用户就彻底退不出去了（这是用户报过的真实故障）。
      if (shell.classList.contains('mp-ui-hidden')) {
        kickIdle();                                             // 隐藏 → 唤出
      } else if (Date.now() - hideState.at < 300) {
        kickIdle();                                             // 刚收起 → 也算唤出，别来回抖
      } else {
        forceHide();                                            // 显示 → 收起（用户主动，任何时候都照做）
      }
      return;
    }
    toggle.onclick();                                           // 桌面浮动窗：沿用原来「点画面切播放」
  };
  video.onplay = setIcon;
  video.onpause = setIcon;
  video.ontimeupdate = sync;
  video.ondurationchange = sync;

  // ---- 画幅自适应：视频是横是竖，决定手机全屏怎么放 --------------------------
  // 用户原话：「你不能判断视频是 16:9 还是 9:16 吗？做出对应的全屏化处理，
  //            16:9 就自动横向全屏呀」—— 完全正确。以前一律 object-fit:contain，
  // 于是横屏视频塞进竖屏手机只剩一小条（实测 960×720 → 390×292，仅占屏高 35%）。
  //
  // 做法：读 video 自身的 videoWidth/videoHeight 判断画幅，再结合当前屏幕朝向：
  //   · 竖屏视频（9:16）配竖屏手机  → contain 天然就满屏，不用管
  //   · 横屏视频（16:9）配竖屏手机  → 改用 cover 铺满（左右裁边），
  //                                  这正是 YouTube/抖音「填充屏幕」的效果
  //   · 横屏视频配横屏手机          → contain 也满，不用管
  // 同时给用户一个 ⤡ 按钮手动在「铺满 / 完整显示」之间切换 —— 自动判断可能不合心意，
  // 比如你想看全整幅画面（宁可留黑边）时，一键切回。
  let videoAR = 0;            // 视频宽高比（w/h），0 = 未知
  let fillMode = 'auto';      // 'auto' | 'fill'(铺满) | 'fit'(完整显示)

  const isPortraitScreen = () => window.innerHeight > window.innerWidth;
  const videoIsLandscape = () => videoAR > 1.05;   // 留一点容差，接近方形的当竖屏处理

  // 该不该铺满：横屏视频 + 竖屏屏幕 → 铺满最合理
  const wantsFill = () => {
    if (!videoAR) return false;
    if (fillMode === 'fill') return true;
    if (fillMode === 'fit') return false;
    return videoIsLandscape() && isPortraitScreen();
  };

  const applyFit = () => {
    const fill = wantsFill();
    shell.classList.toggle('mp-fill', fill);
    if (fitBtn) {
      fitBtn.classList.toggle('pl-on', fill);
      fitBtn.title = fill ? '当前：铺满（裁边）— 点按改为完整显示' : '当前：完整显示（留黑边）— 点按改为铺满';
      fitBtn.textContent = fill ? '⤢' : '⤡';
    }
  };

  video.onloadedmetadata = () => {
    sync();
    if (video.videoWidth && video.videoHeight) {
      videoAR = video.videoWidth / video.videoHeight;
      shell.dataset.videoAr = videoAR.toFixed(3);
      shell.dataset.videoOrient = videoIsLandscape() ? 'landscape' : 'portrait';
    }
    applyFit();      // 拿到真实画幅后再决定铺满与否
  };
  if (fitBtn) {
    fitBtn.onclick = (e) => {
      e.stopPropagation();
      // 点一下在「铺满 / 完整显示」之间来回；手动选择后就固定，不再被自动判定覆盖
      fillMode = wantsFill() ? 'fit' : 'fill';
      applyFit();
      kickIdle();          // 操作后重置自动隐藏计时
    };
  }
  seek.oninput = () => {
    if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration;
  };
  muteBtn.onclick = () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
  };
  volEl.oninput = () => { video.volume = Number(volEl.value); };

  // ---- 保命出口 -------------------------------------------------------------
  // 控制条收起后它 pointer-events:none，✕ 也就点不到了，手机上又没有键盘。
  // 所以除了「点画面唤出」，再给两条后路，保证任何情况下都退得出去：
  //   1) Esc 键（桌面），
  //   2) 返回键 / 手机侧滑返回手势 —— 手机上这是最自然、最不需要教的退出方式。
  const closePlayer = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (typeof onClose === 'function') onClose();
    else { geom = null; setMode('floating'); }
  };
  // 返回键/返回手势：先压一条历史占位，让「返回」落到我们手里而不是直接离开页面
  let popHandled = false;
  const onPop = () => { popHandled = true; closePlayer(); };
  try {
    history.pushState({ mp: 1 }, '');
    window.addEventListener('popstate', onPop);
  } catch (e) { /* 某些环境不允许 pushState，忽略即可 */ }
  // 关闭时清理：若是点 ✕／Esc／返回 之外的正常关闭，把那条占位历史回吐掉
  const cleanupBack = () => {
    window.removeEventListener('popstate', onPop);
    if (!popHandled) { popHandled = true; try { history.back(); } catch (e) {} }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') closePlayer();
  };
  window.addEventListener('keydown', onKeyDown);

  // ---- 尺寸模式：浮动 / 网页内最大化 / 显示器全屏 ----
  // 桌面：打开就是浮动窗，可拖可缩 —— 大屏上「窗口」是有意义的。
  // 手机：浮动窗毫无意义（屏本来就小，还要你拖动、还要你缩放），
  //       改成「沉浸式全屏」—— 打开即铺满整屏，只有 ✕ 关闭。
  //       判定按视口宽度 + 是否粗指针，和 CSS 的 ≤640px 断点保持一致。
  const isMobile = () => window.innerWidth <= 640
    || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches
        && window.innerWidth <= 900);
  const MARGIN = 8, MIN_W = 280, MIN_H = 180;
  let mode = isMobile() ? 'mobile' : 'floating';
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
    // 离开浮动态前先记住几何：最大化、全屏、还原都要用到它。
    // 这一句必须在 mode 被改写之前跑，否则从浮动进全屏时几何会丢，
    // 退出全屏就只能落回内嵌（而不是原来的浮动窗）。
    if (mode === 'floating' && next !== 'floating') {
      const g = read(); if (g) geom = g;
    }
    mode = next;
    shell.classList.toggle('mp-floating', next === 'floating');
    shell.classList.toggle('mp-maximized', next === 'maximized');
    shell.classList.toggle('mp-fullscreen', next === 'fullscreen');
    shell.classList.toggle('mp-mobile', next === 'mobile');
    if (next === 'floating') { apply(clamp(geom || defaultGeom())); }
    else {
      // mobile / maximized / fullscreen 都靠 CSS 定位，清掉内联几何
      shell.style.left = ''; shell.style.top = '';
      shell.style.width = ''; shell.style.height = '';
    }
    // 手机上不需要「网页内最大化」和「缩放手柄」，按钮也随之隐藏（见 CSS）
    maxBtn.classList.toggle('pl-on', next === 'maximized');
    maxBtn.textContent = next === 'maximized' ? '❐' : '⛶';
    maxBtn.title = next === 'maximized' ? '还原播放器' : '网页内最大化';
    fsBtn.classList.toggle('pl-on', next === 'fullscreen');
    // 切模式后重置自动隐藏计时：进全屏/最大化时先显示一会儿，随后自己淡出。
    // 用 setTimeout 让它跑在 kickIdle 定义之后（同一个闭包里，函数提升可用，但
    // 消息队列能确保不早于首次渲染就隐藏，用户看不到「一闪即隐」）。
    setTimeout(kickIdle, 0);
  };

  // 进入/退出全屏：显式驱动，不依赖 fullscreenchange 的时序差异。
  // 事件监听只做兜底（比如用户用 F11 或浏览器 UI 退出）。
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      // 退出由 onFsChange 兜底同步；这里不抢先改，避免事件顺序打架
      return;
    }
    if (mode === 'floating') { const g = read(); if (g) geom = g; } // 记住浮动几何
    shell.requestFullscreen()
      .then(() => setMode('fullscreen'))
      .catch(() => toast('无法进入全屏（浏览器限制）', 'error'));
  };
  // 从最大化/全屏「还原」时的落点：如果用户是从浮动窗过去的，就回浮动窗；
  // 只有在用户主动把浮动窗关掉（✕）之后，才落到内嵌。用 geom 是否为空判断。
  // 还原落点：这个播放器只有「浮动窗」一种常态，最大化/全屏退出后一律回浮动窗
  const restoreMode = () => 'floating';
  // 浏览器全屏状态由事件驱动，不在点击处改 mode —— 用户按 Esc 也要能同步。
  // 注意：靠 fullscreenElement 判断「谁在全屏」在退出时并不可靠（各家浏览器
  // 清空它的时机不同，Esc 退出时可能已经把 fullscreenElement 置空，
  // 于是这里的第一个分支不成立、第二个分支又因 mode 还是 'fullscreen' 而
  // 落回 floating —— 但更糟的情况是事件早于 DOM 更新，导致类卡在全屏态）。
  // 所以这里不看 fullscreenElement，只看「当前是否还是这台 shell 在占全屏」。
  const onFsChange = () => {
    const stillFs = document.fullscreenElement === shell
      || (document.fullscreenElement && shell.contains(document.fullscreenElement));
    if (mode === 'fullscreen' && !stillFs) {
      setMode('floating');
    }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // 兜底轮询：部分环境（无头浏览器、某些 webkit 版本）在 Esc 退出全屏时
  // 不派发 fullscreenchange，或派发时机早于 fullscreenElement 更新。
  // 每 300ms 对账一次 —— 只在处于全屏模式时做，成本可忽略，但能让
  // 「按 Esc 退出后卡在全屏态」这种卡死状态自动恢复。
  const fsWatch = setInterval(() => {
    if (mode !== 'fullscreen') return;
    if (!document.fullscreenElement && !shell.matches(':fullscreen')) {
      setMode('floating');
    }
  }, 300);
  mount.__fsWatch = fsWatch;

  // 没有「浮动/内嵌」开关了：这个播放器打开就是浮动的唯一窗口。
  maxBtn.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setMode(mode === 'maximized' ? restoreMode() : 'maximized');
  };
  fsBtn.onclick = () => toggleFullscreen();
  mount.querySelector('#mp-close').onclick = (e) => {
    e.stopPropagation();
    // ✕ ＝ 关掉这次预览。调用方（文件页）负责移除容器。
    closePlayer();
  };

  // ---- 控制条的自动隐藏 ------------------------------------------------------
  // 手机上（以及桌面真全屏时）控制条常显会一直挡着画面 —— 播放视频时尤其碍事。
  // 规则（与主流播放器一致）：
  //   · 播放中无操作 N 秒 → 淡出（只留画面）
  //   · 触摸/点击画面、移动鼠标 → 立刻淡入，并重新计时
  //   · 暂停时永不隐藏（要让你看得见进度）
  //   · 指针停在控制条/标题栏上时不隐藏（免得想点却消失）
  const IDLE_MS = 3000;
  let idleTimer = null;
  let hoveringUI = false;
  // hideState.at ＝ 上次「收起控制条」的时刻。点画面时若距此刻不到 300ms，
  // 一律按「唤出」处理 —— 防止同一次触摸自带的 move/click 序列把它误判成再收起。
  const hideState = { at: 0 };

  // 这些模式下才自动隐藏：手机沉浸态、桌面最大化、真全屏。
  // 桌面普通浮动窗是「窗口」，常显才符合桌面直觉，不动它。
  const autoHideApplies = () =>
    mode === 'mobile' || mode === 'maximized' || mode === 'fullscreen'
    || !!document.fullscreenElement;

  const showControls = () => { shell.classList.remove('mp-ui-hidden'); };
  // hideControls：自动隐藏用（暂停时不隐藏 —— 要让你看得见进度条）。
  const hideControls = () => {
    if (video.paused) return;          // 暂停时保持可见
    if (hoveringUI) return;            // 手正放在控制条上
    forceHide();
  };
  // forceHide：手动点画面时用 —— 用户主动要收起，任何状态都照做（随时能点回来）。
  const forceHide = () => {
    hideState.at = Date.now();         // 记录「刚刚收起」，供点画面时判断
    shell.classList.add('mp-ui-hidden');
  };
  const kickIdle = () => {
    showControls();
    if (idleTimer) clearTimeout(idleTimer);
    if (!autoHideApplies()) return;    // 普通浮动窗不自动隐藏
    idleTimer = setTimeout(hideControls, IDLE_MS);
  };
  const stopIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    showControls();
  };

  // 画面上的交互：单击切换控制条显隐（不切播放，避免误触）；
  // 参考主流 App —— 手机上「点画面 = 显示/隐藏控制条」，播放在中间按钮上。
  // 但保留原有「点画面切播放/暂停」在桌面浮动窗的行为，免得改变桌面习惯。
  // 是否「真有 hover」的设备（鼠标）。触摸屏上没有 hover，
  // 悬停相关的逻辑一律不启用，改用 touch 事件显式配对。
  const canHover = () => !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  const isImmersive = () => mode === 'mobile' || mode === 'maximized' || mode === 'fullscreen';
  // 显隐的权威入口只有 video.onclick 一处。
  // 踩过的坑：点击前浏览器会先派发 pointermove/pointerdown。若在那里也调 kickIdle()
  // （它会 removeClass），紧接着的 video.onclick 就会看到「已经显示」而执行「收起」，
  // 两次翻转互相抵消 —— 表现为「点画面没反应 / 隐藏后唤不出来」。
  // 因此指针移动只做一件事：重置计时器，绝不改变当前显隐状态。
  const refreshIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!autoHideApplies()) return;
    if (shell.classList.contains('mp-ui-hidden')) return;  // 已隐藏就别偷偷又弹出来
    idleTimer = setTimeout(hideControls, IDLE_MS);
  };
  shell.addEventListener('pointermove', refreshIdle, { passive: true });
  // 鼠标用户在全屏里想唤出控制条：只认「隐藏之后」发生的、且真的移动了一段距离的移动，
  // 避免同一次点击自带的 move 事件把刚刚收起的控制条又顶出来。
  let lastX = null, lastY = null;
  shell.addEventListener('pointermove', (e) => {
    if (!shell.classList.contains('mp-ui-hidden')) { lastX = e.clientX; lastY = e.clientY; return; }
    if (!canHover()) return;                       // 触摸设备不靠移动唤出
    if (lastX === null) { lastX = e.clientX; lastY = e.clientY; return; }
    const moved = Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
    if (moved >= 6) kickIdle();
  }, { passive: true });
  // 鼠标悬停在控制条/标题栏上时不要隐藏（否则手要按的按钮半路消失）。
  // 只对「真正有 hover 的设备」启用这条 —— 触摸屏上 pointerenter 会随手指落下触发，
  // 而 pointerleave 在手指抬起后往往不再派发，hoveringUI 会被永久卡在 true，
  // 结果是控制条再也不自动隐藏。触摸设备改用 touchstart/touchend 显式配对。
  ['#mp-bar', '#mp-dragbar'].forEach((sel) => {
    const el = mount.querySelector(sel);
    if (!el) return;
    el.addEventListener('pointerenter', () => {
      if (!canHover()) return;                 // 触摸设备忽略，交给 touch 事件
      hoveringUI = true; showControls();
    });
    el.addEventListener('pointerleave', () => {
      if (!canHover()) return;
      hoveringUI = false; kickIdle();
    });
    // 触摸：按下时暂停计时，抬起后恢复计时（并显式清掉 hoveringUI）
    el.addEventListener('touchstart', () => { hoveringUI = true; stopIdle(); }, { passive: true });
    el.addEventListener('touchend', () => { hoveringUI = false; kickIdle(); });
    el.addEventListener('touchcancel', () => { hoveringUI = false; kickIdle(); });
  });
  video.addEventListener('play', kickIdle);
  video.addEventListener('pause', stopIdle);   // 暂停 → 一直显示
  video.addEventListener('ended', stopIdle);

  // 清理定时器，避免播放器移除后回调还在跑
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };

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
  // 浮动窗下，画面本身也是拖动区（抓哪儿都能拖）。用 capture 阶段先于
  // video 自己的 click 拿到 pointerdown，判断是否真的移动过。
  video.addEventListener('pointerdown', (e) => {
    if (mode !== 'floating') return;
    const g = read(); if (!g || e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return; // 4px 死区，避免手抖当拖动
      moved = true;
      apply(clamp({ x: g.x + dx, y: g.y + dy, w: g.w, h: g.h }));
    };
    const up = (ev) => {
      video.removeEventListener('pointermove', move);
      video.removeEventListener('pointerup', up);
      video.removeEventListener('pointercancel', up);
      if (moved) {
        suppressClick = true; // 拖过了，这次 pointerup 带来的 click 不算「点画面」
        const ng = read(); if (ng) geom = ng;
      }
      try { video.releasePointerCapture(ev.pointerId); } catch { /* 未捕获 */ }
    };
    video.addEventListener('pointermove', move);
    video.addEventListener('pointerup', up);
    video.addEventListener('pointercancel', up);
    try { video.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
  });

  // 视口变化时把浮动窗夹回可见区域；手机转屏时还要重新决定「全屏 or 浮动」。
  // 不做这一步的话，竖屏打开再转横屏就会留下一个错误的几何（或反过来）。
  const onResize = () => {
    // 屏幕朝向变了（竖屏↔横屏），横屏视频是否需要铺满也会跟着变，重新判定一次
    applyFit();
    const shouldMobile = isMobile();
    if (shouldMobile && mode !== 'mobile') {
      // 拉窄到手机尺寸（或从横屏转回竖屏）→ 切沉浸式全屏
      setMode('mobile');
      return;
    }
    if (!shouldMobile && mode === 'mobile') {
      // 拉宽到桌面尺寸 → 回到浮动窗
      setMode('floating');
      return;
    }
    // 模式不变：浮动窗夹回可见区域即可
    if (mode === 'floating') { const g = read(); if (g) apply(clamp(g)); }
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // 关闭时解绑，避免监听器泄漏
  const origRemove = mount.remove.bind(mount);
  mount.remove = () => {
    clearIdle();                                   // 别让定时器在移除后还跑
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    window.removeEventListener('keydown', onKeyDown);
    cleanupBack();                                 // 撤掉返回键占用 + 回吐历史占位
    if (mount.__fsWatch) clearInterval(mount.__fsWatch);
    origRemove();
  };

  // 打开即浮动态：给它一个合理的初始几何（右下角、16:9），随后可拖可缩。
  // 手机上是沉浸式全屏，不需要几何，由 setMode('mobile') 走 CSS 铺满。
  setMode(isMobile() ? 'mobile' : 'floating');

  video.play().catch(() => { /* 自动播放可能被拦，用户点一下即可 */ });
  setIcon();
  return { video, setMode };
}
