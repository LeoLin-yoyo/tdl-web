// 文件管理器：浏览 / 增删改查 / 文本编辑 / 图片视频预览 / Office 在线查看。
//
// 根目录由后端决定：服务器模式 → 受管目录；普通模式 → 下载目录。
// 前端不假设根在哪，一律用后端返回的 root 来显示。

import { api, esc, fmtBytes, fmtTime, registerRoute, toast, modal, store } from '../app.js';
import { openMiniPlayer } from '../components.js';

let cwd = '.';
let lastList = null;   // 最近一次列表结果，供工具栏（重命名/移动等）取上下文

// ---- 类型判定 --------------------------------------------------------------
// 与后端 lib/files.js 的 TEXT_EXT / MIME 保持一致的判断，用于决定「双击打开」的行为。

const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'];
const VID_EXT = ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'flv', 'wmv', 'ts', '3gp', 'ogv'];
const AUD_EXT = ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac', 'opus'];
const OFFICE_EXT = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
const PDF_EXT = ['pdf'];

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}
const isImg = (n) => IMG_EXT.includes(extOf(n));
const isVid = (n) => VID_EXT.includes(extOf(n));
const isAud = (n) => AUD_EXT.includes(extOf(n));
const isPdf = (n) => PDF_EXT.includes(extOf(n));
const isOffice = (n) => OFFICE_EXT.includes(extOf(n));
const isText = (n, entry) => (entry && entry.text) || (entry && entry.ext && entry.text);

// 单击/双击时按类型给出打开方式
function kindOf(name, entry) {
  if (entry && entry.dir) return 'dir';
  if (isImg(name)) return 'image';
  if (isVid(name)) return 'video';
  if (isAud(name)) return 'audio';
  if (isPdf(name)) return 'pdf';
  if (isOffice(name)) return 'office';
  const ext = extOf(name);
  // 后端标了 text 或扩展名属于常见文本类，就当文本打开
  if (entry && entry.text) return 'text';
  if (['txt', 'md', 'json', 'log', 'csv', 'yml', 'yaml', 'xml', 'ini', 'conf', 'js', 'py', 'sh', 'css', 'html', 'srt', 'vtt'].includes(ext)) return 'text';
  return 'binary';
}

const KIND_ICON = {
  dir: '📁', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕',
  office: '📊', text: '📝', binary: '📄',
};

// ---- 路径工具 --------------------------------------------------------------

function joinPath(base, name) {
  if (!base || base === '.') return name;
  return `${base.replace(/[\\/]+$/, '')}/${name}`;
}

function parentOf(p, root) {
  if (!p || p === '.') return null;
  const abs = p.replace(/\\/g, '/');
  const rel = root ? abs.replace(root.replace(/\\/g, '/') + '/', '') : abs;
  const parts = rel.split('/').filter(Boolean);
  if (parts.length <= 1) return '.';
  return parts.slice(0, -1).join('/');
}

function crumbs(pathStr) {
  const parts = pathStr === '.' ? [] : pathStr.split(/[\\/]/).filter(Boolean);
  let acc = '';
  const items = [`<a href="javascript:void 0" data-go=".">根目录</a>`];
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    items.push(`<span class="muted">/</span><a href="javascript:void 0" data-go="${esc(acc)}">${esc(p)}</a>`);
  }
  return items.join(' ');
}

const rawUrl = (p, inline = true) =>
  `/api/files/raw?${inline ? 'inline=1&' : ''}path=${encodeURIComponent(p)}`;

// ---- 主渲染 ----------------------------------------------------------------

async function render(view) {
  view.innerHTML = `
    <div class="card">
      <div class="fm-toolbar">
        <div class="breadcrumb" id="fb-crumbs"></div>
        <div class="fm-actions">
          <button class="btn sm" id="fm-up" title="返回上级">↑</button>
          <button class="btn sm" id="fm-newdir">新建文件夹</button>
          <button class="btn sm" id="fm-upload">上传文件</button>
          <button class="btn sm" id="fm-refresh">刷新</button>
        </div>
      </div>
      <div class="fm-filter">
        <input type="text" id="fm-search" placeholder="在当前目录中过滤（按名称）">
        <span class="hint muted small" id="fm-root"></span>
      </div>
      <div id="fb-body"><div class="empty"><span class="spin">◐</span> 加载中…</div></div>
    </div>
  `;

  const body = view.querySelector('#fb-body');
  const crumbsEl = view.querySelector('#fb-crumbs');
  const rootEl = view.querySelector('#fm-root');
  let filter = '';

  view.querySelector('#fm-search').oninput = (e) => {
    filter = e.target.value.trim().toLowerCase();
    paint();
  };

  view.querySelector('#fm-refresh').onclick = () => draw();
  view.querySelector('#fm-up').onclick = () => {
    if (!lastList) return;
    const up = parentOf(lastList.path, lastList.root);
    if (up === null) return toast('已在根目录', '');
    cwd = up; draw();
  };
  view.querySelector('#fm-newdir').onclick = () => promptNewDir();
  view.querySelector('#fm-upload').onclick = () => pickUpload();

  // ---- 绘制列表 ----
  function paint() {
    if (!lastList) return;
    crumbsEl.innerHTML = crumbs(lastList.path);
    crumbsEl.querySelectorAll('[data-go]').forEach((a) => {
      a.onclick = () => { cwd = a.getAttribute('data-go'); draw(); };
    });
    rootEl.textContent = `根目录：${lastList.root}`;

    const all = lastList.files || [];
    const files = filter
      ? all.filter((f) => f.name.toLowerCase().includes(filter))
      : all;

    if (!files.length) {
      body.innerHTML = `<div class="empty">${filter ? '没有匹配的项目' : '空目录'}</div>`;
      return;
    }

    body.innerHTML = `
      <table class="table fm-table">
        <thead><tr>
          <th>名称</th><th style="width:100px">大小</th><th style="width:150px">修改时间</th>
          <th style="width:210px"></th>
        </tr></thead>
        <tbody>
          ${files.map((f) => {
            const kind = kindOf(f.name, f);
            const icon = KIND_ICON[kind] || '📄';
            return `
            <tr data-name="${esc(f.name)}">
              <td>
                <a href="javascript:void 0" class="fm-name" data-open="${esc(f.name)}">
                  ${icon} ${esc(f.name)}
                </a>
              </td>
              <td class="muted">${f.dir ? '—' : fmtBytes(f.size)}</td>
              <td class="muted">${fmtTime(f.mtime)}</td>
              <td class="fm-row-actions">
                <button class="btn xs" data-act="rename" data-name="${esc(f.name)}">重命名</button>
                <button class="btn xs" data-act="move" data-name="${esc(f.name)}">移动</button>
                <button class="btn xs" data-act="copy" data-name="${esc(f.name)}">复制</button>
                <button class="btn xs danger" data-act="del" data-name="${esc(f.name)}">删除</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    // 双击 / 点击名称 = 打开；单击行不动作（避免误触）
    body.querySelectorAll('[data-open]').forEach((a) => {
      a.ondblclick = () => openEntry(a.getAttribute('data-open'));
      a.onclick = () => openEntry(a.getAttribute('data-open'));
    });
    body.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const name = btn.getAttribute('data-name');
        const act = btn.getAttribute('data-act');
        if (act === 'rename') promptRename(name);
        else if (act === 'move') promptMove(name, true);
        else if (act === 'copy') promptMove(name, false);
        else if (act === 'del') doRemove(name);
      };
    });
  }

  async function draw() {
    try {
      const r = await api(`/api/files?path=${encodeURIComponent(cwd)}`);
      if (r.error) { body.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
      lastList = r;
      paint();
    } catch (e) {
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // ---- 打开：按类型分派 ----
  function openEntry(name) {
    const entry = (lastList.files || []).find((f) => f.name === name);
    const kind = kindOf(name, entry);
    const p = joinPath(lastList.path, name);

    if (kind === 'dir') { cwd = p; draw(); return; }
    if (kind === 'image') return showImage(name, p);
    if (kind === 'video') return showVideo(name, p);
    if (kind === 'audio') return showAudio(name, p);
    if (kind === 'pdf') return showPdf(name, p);
    if (kind === 'office') return showOffice(name, p);
    if (kind === 'text') return showTextEditor(name, p);
    // 其他类型给出下载
    const m = modal(name, `
      <div class="empty" style="padding:20px 0">
        这个类型没法在线预览。<br><br>
        <a class="btn primary" href="${rawUrl(p, false)}" download>下载文件</a>
      </div>`);
    void m;
  }

  // ---- 图片预览 ----
  function showImage(name, p) {
    modal(name, `
      <div style="text-align:center;background:#000;border-radius:6px;padding:8px">
        <img src="${rawUrl(p)}" style="max-width:100%;max-height:70vh;object-fit:contain">
      </div>
      <div class="fm-modal-foot">
        <a class="btn sm" href="${rawUrl(p, false)}" download>下载</a>
      </div>`);
  }

  // ---- 音频预览 ----
  function showAudio(name, p) {
    modal(name, `
      <audio controls autoplay style="width:100%" src="${rawUrl(p)}"></audio>
      <div class="fm-modal-foot"><a class="btn sm" href="${rawUrl(p, false)}" download>下载</a></div>`);
  }

  // ---- 视频：内嵌播放，并带浮动窗 / 网页内最大化 ----
  function showVideo(name, p) {
    const m = modal(name, `
      <div id="fm-player-mount"></div>
      <div class="fm-modal-foot">
        <a class="btn sm" href="${rawUrl(p, false)}" download>下载</a>
      </div>`);
    try {
      openMiniPlayer(m.el.querySelector('#fm-player-mount'), {
        src: rawUrl(p),
        title: name,
      });
    } catch (e) {
      m.el.querySelector('#fm-player-mount').innerHTML =
        `<div class="empty">播放器初始化失败：${esc(e.message)}</div>`;
    }
  }

  // ---- PDF：浏览器内置阅读器（Chrome/Firefox 都自带）----
  function showPdf(name, p) {
    modal(name, `
      <iframe src="${rawUrl(p)}" style="width:100%;height:72vh;border:0;border-radius:6px;background:#fff"></iframe>
      <div class="fm-modal-foot"><a class="btn sm" href="${rawUrl(p, false)}" download>下载</a></div>`);
  }

  // ---- Office：默认走服务端转换（service 在后续步骤接入）；未就绪时降级 ----
  async function showOffice(name, p) {
    const m = modal(name, `<div class="empty"><span class="spin">◐</span> 正在准备预览…</div>`);
    const bodyEl = m.el.querySelector('.modal-body');
    try {
      const r = await api(`/api/files/office?path=${encodeURIComponent(p)}`);
      if (r && r.ok && r.pdfPath) {
        bodyEl.innerHTML = `
          <iframe src="${rawUrl(r.pdfPath)}" style="width:100%;height:72vh;border:0;border-radius:6px;background:#fff"></iframe>
          <div class="fm-modal-foot">
            <span class="hint muted small">由服务端转换预览</span>
            <a class="btn sm" href="${rawUrl(p, false)}" download>下载原文件</a>
          </div>`;
        return;
      }
      // 转换不可用：给清晰的出路，而不是一个空白框
      bodyEl.innerHTML = `
        <div class="empty" style="padding:16px 0">
          <div style="margin-bottom:10px">${esc((r && r.error) || '在线预览不可用')}</div>
          <a class="btn primary" href="${rawUrl(p, false)}" download>下载后本地查看</a>
        </div>`;
    } catch (e) {
      bodyEl.innerHTML = `
        <div class="empty" style="padding:16px 0">
          <div style="margin-bottom:10px">${esc(e.message)}</div>
          <a class="btn primary" href="${rawUrl(p, false)}" download>下载后本地查看</a>
        </div>`;
    }
  }

  // ---- 文本编辑 ----
  async function showTextEditor(name, p) {
    const m = modal(name, `<div class="empty"><span class="spin">◐</span> 读取中…</div>`);
    const bodyEl = m.el.querySelector('.modal-body');
    let r;
    try {
      r = await api(`/api/files/text?path=${encodeURIComponent(p)}`);
    } catch (e) {
      bodyEl.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (!r.ok) {
      bodyEl.innerHTML = `<div class="empty">${esc(r.error || '无法读取')}</div>`;
      return;
    }
    bodyEl.innerHTML = `
      <textarea class="fm-editor" id="fm-editor" spellcheck="false">${esc(r.content)}</textarea>
      <div class="fm-modal-foot">
        <span class="hint muted small" id="fm-editor-info">${fmtBytes(r.size)}　UTF-8</span>
        <span>
          <button class="btn sm" id="fm-editor-cancel">取消</button>
          <button class="btn sm primary" id="fm-editor-save">保存</button>
        </span>
      </div>`;
    const ta = bodyEl.querySelector('#fm-editor');
    bodyEl.querySelector('#fm-editor-cancel').onclick = () => m.close();
    bodyEl.querySelector('#fm-editor-save').onclick = async () => {
      const btn = bodyEl.querySelector('#fm-editor-save');
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        const res = await api('/api/files/text', {
          method: 'POST',
          body: { path: p, content: ta.value },
        });
        if (res.error) throw new Error(res.error);
        toast('已保存', 'ok');
        m.close();
        draw();
      } catch (e) {
        toast(e.message, 'error');
        btn.disabled = false; btn.textContent = '保存';
      }
    };
  }

  // ---- 新建目录 ----
  function promptNewDir() {
    const m = modal('新建文件夹', `
      <div class="field"><label>文件夹名称</label><input type="text" id="fm-nd-name" placeholder="新文件夹"></div>
      <div class="fm-modal-foot"><button class="btn primary" id="fm-nd-ok">创建</button></div>`);
    const inp = m.el.querySelector('#fm-nd-name');
    inp.focus();
    const go = async () => {
      const name = inp.value.trim();
      if (!name) return toast('请输入名称', 'error');
      try {
        const r = await api('/api/files/mkdir', { method: 'POST', body: { path: lastList.path, name } });
        if (r.error) throw new Error(r.error);
        toast('已创建', 'ok'); m.close(); draw();
      } catch (e) { toast(e.message, 'error'); }
    };
    m.el.querySelector('#fm-nd-ok').onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  // ---- 重命名 ----
  function promptRename(name) {
    const m = modal('重命名', `
      <div class="field"><label>新名称</label><input type="text" id="fm-rn-name" value="${esc(name)}"></div>
      <div class="fm-modal-foot"><button class="btn primary" id="fm-rn-ok">确定</button></div>`);
    const inp = m.el.querySelector('#fm-rn-name');
    inp.focus(); inp.select();
    const go = async () => {
      const nv = inp.value.trim();
      if (!nv || nv === name) return m.close();
      try {
        const r = await api('/api/files/rename', {
          method: 'POST',
          body: { path: joinPath(lastList.path, name), name: nv },
        });
        if (r.error) throw new Error(r.error);
        toast('已重命名', 'ok'); m.close(); draw();
      } catch (e) { toast(e.message, 'error'); }
    };
    m.el.querySelector('#fm-rn-ok').onclick = go;
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  }

  // ---- 移动 / 复制 ----
  // 目标目录用「当前目录下的子目录树」下拉选择，避免用户手打路径出错。
  function promptMove(name, isMove) {
    const dirs = ['(根目录)'].concat(
      (lastList.files || []).filter((f) => f.dir && f.name !== name).map((f) => f.name),
    );
    const m = modal(isMove ? '移动到' : '复制到', `
      <div class="field"><label>目标目录（当前目录下的子目录）</label>
        <select id="fm-mv-dir">${dirs.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')}</select>
        <span class="hint">要放到更深的目录，请先进入该目录再操作</span></div>
      <div class="fm-modal-foot"><button class="btn primary" id="fm-mv-ok">${isMove ? '移动' : '复制'}</button></div>`);
    m.el.querySelector('#fm-mv-ok').onclick = async () => {
      const sel = m.el.querySelector('#fm-mv-dir').value;
      const destDir = sel === '(根目录)' ? lastList.path : joinPath(lastList.path, sel);
      try {
        const r = await api(isMove ? '/api/files/move' : '/api/files/copy', {
          method: 'POST',
          body: { path: joinPath(lastList.path, name), dir: destDir },
        });
        if (r.error) throw new Error(r.error);
        toast(isMove ? '已移动' : '已复制', 'ok'); m.close(); draw();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  // ---- 删除（默认进回收站，可恢复）----
  function doRemove(name) {
    const isDir = (lastList.files || []).find((f) => f.name === name)?.dir;
    const m = modal('删除', `
      <div style="margin-bottom:12px">
        确定删除 <b>${esc(name)}</b>${isDir ? '（及其中全部内容）' : ''}？<br>
        <span class="hint muted small">默认移入回收站 <span class="mono">.trash/</span>，可以恢复；不会真的抹掉。</span>
      </div>
      <div class="fm-modal-foot">
        <button class="btn" id="fm-del-cancel">取消</button>
        <button class="btn danger" id="fm-del-ok">移入回收站</button>
      </div>`);
    m.el.querySelector('#fm-del-cancel').onclick = () => m.close();
    m.el.querySelector('#fm-del-ok').onclick = async () => {
      try {
        const r = await api('/api/files/delete', {
          method: 'POST',
          body: { path: joinPath(lastList.path, name) },
        });
        if (r.error) throw new Error(r.error);
        toast('已移入回收站', 'ok'); m.close(); draw();
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  // ---- 上传 ----
  function pickUpload() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.onchange = async () => {
      const files = [...(inp.files || [])];
      if (!files.length) return;
      let ok = 0, fail = 0;
      for (const f of files) {
        try {
          // base64 走 JSON，避免再引入 multipart 解析依赖。
          // 大文件（>64MB）不走这里 —— 提示用户用下载功能或放到受管目录。
          if (f.size > 64 * 1024 * 1024) {
            toast(`${f.name} 超过 64MB，请改用其他方式放入目录`, 'error');
            fail++; continue;
          }
          const data = await fileToBase64(f);
          const r = await api('/api/files/upload', {
            method: 'POST',
            body: { dir: lastList.path, name: f.name, data },
          });
          if (r.error) throw new Error(r.error);
          ok++;
        } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); fail++; }
      }
      if (ok) toast(`已上传 ${ok} 个文件${fail ? `，${fail} 个失败` : ''}`, 'ok');
      draw();
    };
    inp.click();
  }

  await draw();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

registerRoute('/files', { title: '文件', render });
