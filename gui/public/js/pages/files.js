// File browser over the configured download root.

import { api, esc, fmtBytes, fmtTime, registerRoute, toast, modal, store } from '../app.js';

let cwd = '.';

function crumbs(pathStr) {
  const parts = pathStr === '.' ? [] : pathStr.split(/[\\/]/).filter(Boolean);
  let acc = '';
  const items = [`<a href="javascript:void 0" data-go=".">下载目录</a>`];
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    items.push(`<span class="muted">/</span><a href="javascript:void 0" data-go="${esc(acc)}">${esc(p)}</a>`);
  }
  return items.join(' ');
}

async function render(view) {
  view.innerHTML = `
    <div class="card">
      <div class="task-head" style="margin-bottom:10px">
        <div class="breadcrumb" id="fb-crumbs"></div>
        <div class="task-head-right"><button class="btn sm" id="fb-refresh">刷新</button></div>
      </div>
      <div id="fb-body"><div class="empty"><span class="spin">◐</span> 加载中…</div></div>
    </div>`;

  const body = view.querySelector('#fb-body');
  const crumbsEl = view.querySelector('#fb-crumbs');

  async function draw() {
    let r;
    try {
      r = await api(`/api/files?path=${encodeURIComponent(cwd)}`);
    } catch (e) {
      body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
      return;
    }
    if (r.error) {
      body.innerHTML = `<div class="empty">${esc(r.error)}</div>`;
      return;
    }
    crumbsEl.innerHTML = crumbs(r.path);
    crumbsEl.querySelectorAll('[data-go]').forEach((a) => {
      a.onclick = () => { cwd = a.getAttribute('data-go'); draw(); };
    });
    if (!r.files.length) {
      body.innerHTML = `<div class="empty">空目录</div>`;
      return;
    }
    body.innerHTML = `
      <table class="table">
        <thead><tr><th>名称</th><th style="width:110px">大小</th><th style="width:150px">修改时间</th><th style="width:130px"></th></tr></thead>
        <tbody>
          ${r.files.map((f) => `
            <tr>
              <td><a href="javascript:void 0" data-name="${esc(f.name)}" data-dir="${f.dir ? 1 : 0}"
                     style="${f.dir ? '' : 'pointer-events:auto'}">${f.dir ? '📁' : '📄'} ${esc(f.name)}</a></td>
              <td class="muted">${f.dir ? '—' : fmtBytes(f.size)}</td>
              <td class="muted">${fmtTime(f.mtime)}</td>
              <td style="text-align:right">
                ${f.dir ? '' : `
                  ${isPreviewable(f.name) ? `<button class="btn sm" data-prev="${esc(f.name)}">预览</button>` : ''}
                  <a class="btn sm" href="/api/files/raw?path=${encodeURIComponent(joinPath(r.path, f.name))}">下载</a>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    body.querySelectorAll('a[data-name]').forEach((a) => {
      a.onclick = () => {
        if (a.getAttribute('data-dir') === '1') {
          cwd = joinPath(r.path, a.getAttribute('data-name'));
          draw();
        }
      };
    });
    body.querySelectorAll('[data-prev]').forEach((btn) => {
      btn.onclick = () => {
        const name = btn.getAttribute('data-prev');
        const p = joinPath(r.path, name);
        const ext = name.split('.').pop().toLowerCase();
        const isMedia = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mkv', 'mov', 'mp3', 'm4a', 'flac', 'wav', 'ogg'].includes(ext);
        modal(esc(name), isMedia
          ? (['mp4', 'webm', 'mkv', 'mov'].includes(ext)
            ? `<video controls style="width:100%;max-height:60vh" src="/api/files/raw?inline=1&path=${encodeURIComponent(p)}"></video>`
            : ext.match(/mp3|m4a|flac|wav|ogg/)
              ? `<audio controls style="width:100%" src="/api/files/raw?inline=1&path=${encodeURIComponent(p)}"></audio>`
              : `<img style="width:100%;max-height:60vh;object-fit:contain" src="/api/files/raw?inline=1&path=${encodeURIComponent(p)}">`)
          : `<pre class="task-logs" style="display:block">（文本预览不支持该类型）</pre>`);
      };
    });
  }

  view.querySelector('#fb-refresh').onclick = draw;
  await draw();
}

function joinPath(base, name) {
  if (!base || base === '.') return name;
  return `${base.replace(/[\\/]+$/, '')}/${name}`;
}

function isPreviewable(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mkv', 'mov', 'mp3', 'm4a', 'flac', 'wav', 'ogg'].includes(ext);
}

registerRoute('/files', { title: '文件', render });
