// Settings: proxy / ns / dir / perf defaults, server info.

import { api, esc, store, registerRoute, toast, fmtTime } from '../app.js';

async function render(view) {
  const cfg = store.config || {};
  view.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h2>连接与存储</h2>
        <div class="field"><label>代理 --proxy（socks5/http，改后保存即对后续任务生效）</label>
          <input type="text" id="s-proxy" value="${esc(cfg.proxy || '')}" placeholder="socks5://127.0.0.1:7890"></div>
        <div class="field"><label>默认命名空间 --ns</label>
          <input type="text" id="s-ns" value="${esc(cfg.ns || 'default')}"></div>
        <div class="field"><label>NTP 服务器 --ntp（可空）</label>
          <input type="text" id="s-ntp" value="${esc(cfg.ntp || '')}"></div>
        <div class="field"><label>重连退避上限（秒）--reconnect-timeout</label>
          <input type="number" id="s-reconnect" value="${cfg.reconnectTimeout ?? 300}" min="0"></div>
      </div>

      <div class="card">
        <h2>tdl 可执行文件</h2>
        <div class="hint muted small" style="margin-bottom:10px">
          留空则自动查找（gui/tdl/ → 项目目录 → 同级发布目录 → PATH）。装在其他位置、或不是 Windows 时，在这里填可执行文件的完整路径。
        </div>
        <div class="field"><label>tdl 路径（可执行文件完整路径，留空=自动查找）</label>
          <input type="text" id="s-tdlpath" value="${esc(cfg.tdlPath || '')}" placeholder="例如 D:\\tools\\tdl\\tdl.exe">
          <span class="hint">当前使用：<span class="mono" id="s-tdlcur">检测中…</span></span></div>
        <div style="margin-top:6px">
          <button class="btn primary" id="s-save-tdl">保存路径</button>
          <button class="btn" id="s-tdl-dl">自动下载 tdl</button>
          <button class="btn" id="s-tdl-refresh">重新检测</button>
        </div>
        <div class="hint muted small" id="s-tdl-info" style="margin-top:8px">—</div>
      </div>

      <div class="card">
        <h2>性能默认值</h2>
        <div class="grid c3">
        <div class="field"><label>单文件线程 -t</label>
          <input type="number" id="s-threads" value="${cfg.threads ?? 4}" min="1" max="64">
          <span class="hint">tdl 自身的分块数</span></div>
        <div class="field"><label>并发任务 -l</label><input type="number" id="s-limit" value="${cfg.limit ?? 2}" min="1" max="32"></div>
        <div class="field"><label>任务间隔(秒)</label><input type="number" id="s-delay" value="${cfg.delay ?? 0}" min="0"></div>
      </div>
      <div class="grid c2">
        <div class="field"><label>下载并发连接数（每文件）</label>
          <input type="number" id="s-connections" value="${cfg.connections ?? 48}" min="1" max="64">
          <span class="hint">决定单文件速度，越大越快（实测 1→0.1、8→1.2、16→2.8、48→5.4 MB/s）；建议 32–48</span></div>
        <div class="field"><label>同时下载的文件数</label>
          <input type="number" id="s-fileconc" value="${cfg.fileConcurrency ?? 3}" min="1" max="16">
          <span class="hint">多链接时多个文件同时下载，避免都排在第一个大文件后面；总连接数会分摊到这些文件</span></div>
      </div>
      <button class="btn primary" id="s-save">保存设置</button>
      <span class="hint muted small" style="margin-left:8px">保存到 SQLite（app_state）与 gui/data/gui-config.json</span>
      </div>
    </div>

    <div class="card">
      <h2>下载默认设置</h2>
      <div class="hint muted small" style="margin-bottom:12px">
        这些选项统一在这里配置，下载页不再重复出现；每次新建下载任务都会自动套用（任务本身仍可覆盖）。
      </div>
      <div class="grid c2">
        <div class="field"><label>文件名模板 --template</label>
          <input type="text" id="s-template" value="${esc(cfg.template || '')}"></div>
        <div class="field"><label>下载目录 --dir（默认值，也是文件页根目录）</label>
          <input type="text" id="s-dir" value="${esc(cfg.dir || '')}"></div>
      </div>
      <div class="grid c2">
        <div class="field"><label>仅包含扩展名 --include（逗号分隔，可空）</label>
          <input type="text" id="s-include" value="${esc(cfg.include || '')}" placeholder="mp4, mkv"></div>
        <div class="field"><label>排除扩展名 --exclude（可空）</label>
          <input type="text" id="s-exclude" value="${esc(cfg.exclude || '')}" placeholder="png, jpg"></div>
      </div>
      <div class="grid c2">
        <div>
          <label class="check-row"><input type="checkbox" id="s-group" ${cfg.group ? 'checked' : ''}> 自动识别相册/分组消息 --group</label>
          <label class="check-row"><input type="checkbox" id="s-skip-same" ${cfg.skipSame ? 'checked' : ''}> 跳过同名同大小文件 --skip-same</label>
          <label class="check-row"><input type="checkbox" id="s-rewrite-ext" ${cfg.rewriteExt ? 'checked' : ''}> 按文件头修正扩展名 --rewrite-ext</label>
        </div>
        <div>
          <label class="check-row"><input type="checkbox" id="s-takeout" ${cfg.takeout ? 'checked' : ''}> Takeout 会话（更低限流）--takeout</label>
          <label class="check-row"><input type="checkbox" id="s-desc" ${cfg.desc ? 'checked' : ''}> 从新到旧下载 --desc</label>
        </div>
      </div>
      <button class="btn primary" id="s-save-dl">保存下载默认设置</button>
    </div>

    <div class="card">
      <h2>在线播放</h2>
      <div class="hint muted small" style="margin-bottom:12px">
        播放由本地多连接预取池供流（单连接只有 ~0.1 MB/s，跑不动视频）。4K 码率远高于 1080p，默认值已按 4K 调大；线路带宽足够时可继续加大。
      </div>
      <div class="grid c2">
        <div class="field"><label>播放预取连接数（总预算）</label>
          <input type="number" id="s-streamconn" value="${cfg.streamConnections ?? 48}" min="1" max="128">
          <span class="hint">预取的总并发连接预算，越大越快；实际在途请求不会超过这个数</span></div>
        <div class="field"><label>预取窗口（MB）</label>
          <input type="number" id="s-streamwin" value="${cfg.streamWindowMB ?? 256}" min="8" max="4096">
          <span class="hint">保持播放头前方这么多数据已取回；4K 建议 256MB 以上</span></div>
        <div class="field"><label>内存缓存上限（MB）</label>
          <input type="number" id="s-streamcache" value="${cfg.streamCacheMB ?? 512}" min="32" max="8192">
          <span class="hint">已取块驻留内存的总量，拖回进度条时秒响应</span></div>
        <div class="field"><label>空闲自动关闭（分钟）</label>
          <input type="number" id="s-streamidle" value="${cfg.streamIdleMin ?? 10}" min="1" max="240">
          <span class="hint">无播放请求达到该时长后关闭播放会话并释放资源</span></div>
      </div>
      <button class="btn primary" id="s-save-stream">保存在线播放设置</button>
    </div>

    <div class="card">
      <h2>关于</h2>
      <div class="muted small" style="line-height:2.1">
        tdl 版本 <b style="color:var(--text)">${esc(store.version || '…')}</b>（CLI 单文件，GUI 不修改它）<br>
        tdl 路径 <b style="color:var(--text)" class="mono">${esc(store.config ? '' : '')}${esc((await api('/api/version')).tdlPath || '')}</b><br>
        会话/数据目录 <b style="color:var(--text)">~/.tdl</b>（与 CLI 共享，登录后所有任务可用）<br>
        执行模型：所有 tdl 调用经<strong>串行队列</strong>（bolt 数据库单写者）；下载/转发的内部并发由 -t/-l 控制<br>
        启动参数：环境变量 <span class="mono">TDL_GUI_PORT / TDL_GUI_HOST / TDL_GUI_TDL_PATH</span>
      </div>
    </div>`;

  async function saveConfig(patch, btn) {
    if (btn) { btn.disabled = true; }
    try {
      const r = await api('/api/config', { method: 'POST', body: { config: patch } });
      store.config = r.config;
      toast('已保存', 'ok');
      return r;
    } catch (e) {
      toast(e.message, 'error');
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- tdl path / auto-download -------------------------------------------
  const tdlCur = view.querySelector('#s-tdlcur');
  const tdlInfo = view.querySelector('#s-tdl-info');

  async function refreshTdlStatus() {
    try {
      const st = await api('/api/tdl/status');
      tdlCur.textContent = st.current || '未找到';
      tdlCur.style.color = st.hasTdl ? 'var(--text)' : '#e0a24a';
      tdlInfo.textContent = `自动下载目录：${st.autoDir}　目标包：${st.target}`
        + (st.installed ? `　已下载：${st.installed}` : '');
    } catch (e) {
      tdlInfo.textContent = `检测失败：${e.message}`;
    }
  }
  refreshTdlStatus();

  view.querySelector('#s-save-tdl').onclick = async () => {
    const r = await saveConfig({ tdlPath: view.querySelector('#s-tdlpath').value.trim() }, view.querySelector('#s-save-tdl'));
    if (r) {
      await refreshTdlStatus();
      // reload the status chip so the version/tdl path reflect the new binary
      toast(r.tdlFound ? `tdl 已切换：${r.tdlPath}` : '已保存，但该路径下没找到 tdl 可执行文件', r.tdlFound ? 'ok' : 'error');
    }
  };
  view.querySelector('#s-tdl-refresh').onclick = refreshTdlStatus;

  view.querySelector('#s-tdl-dl').onclick = async () => {
    const btn = view.querySelector('#s-tdl-dl');
    btn.disabled = true;
    btn.textContent = '下载中…';
    try {
      await api('/api/tdl/download', { method: 'POST', body: {} });
      // poll the job until it settles
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const job = await api('/api/tdl/download');
        if (job.phase === 'done') { toast(`tdl 下载完成：${job.path}`, 'ok'); break; }
        if (job.phase === 'error') { toast(`下载失败：${job.message}`, 'error'); break; }
        btn.textContent = job.phase === 'extract' ? '解压中…' : '下载中…';
        tdlInfo.textContent = job.message || '…';
      }
      await refreshTdlStatus();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '自动下载 tdl';
    }
  };

  view.querySelector('#s-save').onclick = () => saveConfig({
    proxy: view.querySelector('#s-proxy').value.trim(),
    ns: view.querySelector('#s-ns').value.trim() || 'default',
    ntp: view.querySelector('#s-ntp').value.trim(),
    reconnectTimeout: Number(view.querySelector('#s-reconnect').value) || 0,
    threads: Number(view.querySelector('#s-threads').value) || 4,
    limit: Number(view.querySelector('#s-limit').value) || 2,
    delay: Number(view.querySelector('#s-delay').value) || 0,
    connections: Number(view.querySelector('#s-connections').value) || 48,
    fileConcurrency: Number(view.querySelector('#s-fileconc').value) || 3,
  }, view.querySelector('#s-save'));

  view.querySelector('#s-save-stream').onclick = () => saveConfig({
    streamConnections: Number(view.querySelector('#s-streamconn').value) || 48,
    streamWindowMB: Number(view.querySelector('#s-streamwin').value) || 256,
    streamCacheMB: Number(view.querySelector('#s-streamcache').value) || 512,
    streamIdleMin: Number(view.querySelector('#s-streamidle').value) || 10,
  }, view.querySelector('#s-save-stream'));

  view.querySelector('#s-save-dl').onclick = () => saveConfig({
    dir: view.querySelector('#s-dir').value.trim(),
    template: view.querySelector('#s-template').value,
    include: view.querySelector('#s-include').value.trim(),
    exclude: view.querySelector('#s-exclude').value.trim(),
    group: view.querySelector('#s-group').checked,
    skipSame: view.querySelector('#s-skip-same').checked,
    rewriteExt: view.querySelector('#s-rewrite-ext').checked,
    takeout: view.querySelector('#s-takeout').checked,
    desc: view.querySelector('#s-desc').checked,
  }, view.querySelector('#s-save-dl'));
}

registerRoute('/settings', { title: '设置', render });
