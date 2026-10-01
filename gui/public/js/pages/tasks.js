// Task pages: download / forward / upload / export.
// Each page = create-form + live task list (filtered by type).

import { api, esc, store, notify, listeners, registerRoute, toast } from '../app.js';
import { renderTaskList, pickChat, val, checked, numVal, lines } from '../components.js';

const defaults = () => store.config || {};

function formCard(title, inner, submitLabel = '创建任务') {
  return `
  <div class="card">
    <h2>${title}</h2>
    ${inner}
    <div style="margin-top:6px"><button class="btn primary" id="create-btn">${submitLabel}</button>
    <span class="hint muted small" style="margin-left:10px">任务按队列串行执行（tdl 数据库为单写者）</span></div>
  </div>`;
}

function adv(details) {
  return `<details class="adv"><summary>高级选项</summary><div class="adv-body">${details}</div></details>`;
}

function perfFields() {
  const d = defaults();
  return `
    <div class="grid c3">
      <div class="field"><label>单文件线程 -t</label><input type="number" id="f-threads" value="${d.threads ?? 4}" min="1" max="64"></div>
      <div class="field"><label>并发任务数 -l</label><input type="number" id="f-limit" value="${d.limit ?? 2}" min="1" max="32"></div>
      <div class="field"><label>任务间隔(秒) --delay</label><input type="number" id="f-delay" value="${d.delay ?? 0}" min="0"></div>
    </div>`;
}

function nsField() {
  return `<div class="field"><label>命名空间 --ns（留空用默认）</label><input type="text" id="f-ns" placeholder="${esc((defaults().ns) || 'default')}"></div>`;
}

// ---- download ------------------------------------------------------------------
// The download form only holds what is specific to THIS task (what to download
// and where). Everything reusable — extensions, template, concurrency, group /
// takeout / skip-same behaviour — lives on the settings page and is applied
// automatically, so there is a single place to configure it.

function dlForm() {
  const d = defaults();
  return formCard('新建下载任务', `
    <div class="field">
      <label>消息链接（每行一条，如 https://t.me/tdl/1、https://t.me/c/1697797156/150/200）</label>
      <textarea id="f-urls" rows="4" placeholder="https://t.me/tdl/10"></textarea>
      <div><button class="btn sm" id="pick-chat-btn" type="button">从会话列表挑选 ↗</button>
      <span class="hint">选中后插入 https://t.me/用户名 链接，请自行补上 /消息ID（可加起止范围 /起/止）</span></div>
      <span class="hint">每行链接会生成一张独立的任务卡片，可单独暂停/继续</span>
    </div>
    <div class="field"><label>或：tdl export 生成的 JSON 文件（每行一个绝对路径）</label>
      <textarea id="f-files" rows="2" placeholder="D:\\data\\tdl-export.json"></textarea>
      <span class="hint">同样每个文件生成一张独立的任务卡片</span></div>
    <div class="field"><label>下载目录 --dir</label>
      <input type="text" id="f-dir" data-recent="dl.dir" list="dl-dir-list" autocomplete="off"
             value="${esc(d.dir || '')}" placeholder="选择或输入目录">
      <datalist id="dl-dir-list"></datalist>
      <span class="hint">可直接输入，也可从下拉选择用过的目录</span></div>
    <div class="hint muted small" style="margin-top:2px">
      扩展名过滤、文件名模板、并发、相册识别等选项已统一放在
      <a href="#/settings">设置</a> 页，此处不再重复。
    </div>
  `, '创建下载任务');
}

function submitDl() {
  const config = {
    urls: lines('f-urls'),
    files: lines('f-files'),
    dir: val('f-dir'),
  };
  return api('/api/tasks', { method: 'POST', body: { type: 'dl', config } });
}

// ---- forward --------------------------------------------------------------------

function forwardForm() {
  return formCard('新建转发任务', `
    <div class="field">
      <label>来源（消息链接或导出 JSON，每行一条）</label>
      <textarea id="f-from" rows="3" placeholder="https://t.me/tdl/10"></textarea>
      <div><button class="btn sm" id="pick-chat-btn" type="button">从会话列表挑选 ↗</button></div>
    </div>
    <div class="grid c2">
      <div class="field"><label>目标 --to（用户名 / Chat ID / me=收藏 / 表达式）</label>
        <input type="text" id="f-to" placeholder="me 或 @username 或 -100xxxx"></div>
      <div class="field"><label>转发模式 --mode</label>
        <select id="f-mode"><option value="clone">clone（复制，自动处理受保护内容）</option><option value="direct">direct（直接转发）</option></select></div>
    </div>
    <div class="field"><label>改写文本 --edit（HTML，可空）</label><input type="text" id="f-edit" placeholder="&quot;<b>&quot;+From.VisibleName+&quot;</b>: &quot;+Message.Text"></div>
    ${nsField()}
    ${adv(`
      ${perfFields()}
      <label class="check-row"><input type="checkbox" id="f-silent"> 静默发送 --silent</label>
      <label class="check-row"><input type="checkbox" id="f-dry-run"> 演练模式（不真发）--dry-run</label>
      <label class="check-row"><input type="checkbox" id="f-single"> 不合并分组消息 --single</label>
      <label class="check-row"><input type="checkbox" id="f-desc"> 倒序转发 --desc</label>
    `)}
  `);
}

function submitForward() {
  return api('/api/tasks', { method: 'POST', body: { type: 'forward', config: {
    from: lines('f-from'),
    to: val('f-to'),
    mode: val('f-mode'),
    edit: val('f-edit'),
    ns: val('f-ns'),
    threads: numVal('f-threads', 4),
    limit: numVal('f-limit', 2),
    delay: numVal('f-delay', 0),
    silent: checked('f-silent'),
    dryRun: checked('f-dry-run'),
    single: checked('f-single'),
    desc: checked('f-desc'),
  } } });
}

// ---- upload ----------------------------------------------------------------------

function upForm() {
  return formCard('新建上传任务', `
    <div class="field"><label>本地文件/目录（每行一个绝对路径）</label>
      <textarea id="f-paths" rows="3" placeholder="D:\\media\\movie.mp4"></textarea></div>
    <div class="grid c2">
      <div class="field"><label>目标会话 --chat（用户名/ID，留空=收藏）</label>
        <input type="text" id="f-chat" placeholder="@username 或 -100xxxx">
        <div><button class="btn sm" id="pick-chat-btn" type="button">从会话列表挑选 ↗</button></div></div>
      <div class="field"><label>话题 ID --topic（论坛群，可空）</label><input type="number" id="f-topic" value="0"></div>
    </div>
    <div class="grid c2">
      <div class="field"><label>仅包含扩展名 --include（可空）</label><input type="text" id="f-include" placeholder="mp4, jpg"></div>
      <div class="field"><label>排除扩展名 --exclude（可空）</label><input type="text" id="f-exclude" placeholder="txt"></div>
    </div>
    <div class="field"><label>说明文字 --caption（表达式，可空）</label>
      <input type="text" id="f-caption" value="&quot;<code>&quot;+FileName+&quot;</code> - <code>&quot;+MIME+&quot;</code>"></div>
    ${nsField()}
    ${adv(`
      ${perfFields()}
      <label class="check-row"><input type="checkbox" id="f-rm"> 上传后删除本地文件 --rm（谨慎！）</label>
      <label class="check-row"><input type="checkbox" id="f-photo"> 图片以照片形式发送 --photo</label>
    `)}
  `);
}

function submitUp() {
  return api('/api/tasks', { method: 'POST', body: { type: 'up', config: {
    paths: lines('f-paths'),
    chat: val('f-chat'),
    topic: numVal('f-topic', 0),
    include: val('f-include') ? val('f-include').split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    exclude: val('f-exclude') ? val('f-exclude').split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    caption: val('f-caption'),
    ns: val('f-ns'),
    threads: numVal('f-threads', 4),
    limit: numVal('f-limit', 2),
    delay: numVal('f-delay', 0),
    remove: checked('f-rm'),
    photo: checked('f-photo'),
  } } });
}

// ---- export ----------------------------------------------------------------------

function exportForm() {
  return formCard('导出消息为 JSON（供下载使用）', `
    <div class="grid c2">
      <div class="field"><label>会话 --chat（留空=收藏/Saved Messages）</label>
        <input type="text" id="f-chat" placeholder="@username 或 -100xxxx">
        <div><button class="btn sm" id="pick-chat-btn" type="button">从会话列表挑选 ↗</button></div></div>
      <div class="field"><label>话题/帖子 ID --topic（可空）</label><input type="number" id="f-topic" value="0"></div>
    </div>
    <div class="grid c3">
      <div class="field"><label>导出方式 --type</label>
        <select id="f-type">
          <option value="last">最近 N 条</option>
          <option value="id">按消息 ID 区间</option>
          <option value="time">按时间戳区间</option>
        </select></div>
      <div class="field"><label>区间参数 --input</label><input type="text" id="f-input" placeholder="100 或 100,200"></div>
      <div class="field"><label>过滤表达式 --filter</label><input type="text" id="f-filter" value="true"></div>
    </div>
    <div class="grid c2">
      <div class="field"><label>输出文件名 --output（留空自动命名到下载目录）</label>
        <input type="text" id="f-output" placeholder="tdl-export.json"></div>
      <div class="field"><label>&nbsp;</label>
        <label class="check-row"><input type="checkbox" id="f-with-content"> 附带消息文本 --with-content</label>
        <label class="check-row"><input type="checkbox" id="f-all"> 含非媒体消息 --all</label>
        <label class="check-row"><input type="checkbox" id="f-raw"> 原始 MTProto 结构 --raw</label></div>
    </div>
    ${nsField()}
    <div class="hint muted small">导出完成后，在「文件」页即可找到 JSON；下载页可直接引用该文件路径。</div>
  `);
}

function submitExport() {
  const input = val('f-input').split(/[,，]/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  return api('/api/tasks', { method: 'POST', body: { type: 'export', config: {
    chat: val('f-chat'),
    topic: numVal('f-topic', 0),
    type: val('f-type'),
    input,
    filter: val('f-filter') || 'true',
    output: val('f-output'),
    withContent: checked('f-with-content'),
    all: checked('f-all'),
    raw: checked('f-raw'),
    ns: val('f-ns'),
  } } });
}

// ---- page factory ------------------------------------------------------------------
// formHtml is a *function* evaluated at render time so that store.config
// (loaded asynchronously at boot) is available for default values.

// Form drafts are persisted per task type, so a page refresh (or a restart)
// keeps whatever the user had typed.
const draftTimers = new Map();

function collectForm(view) {
  const data = {};
  view.querySelectorAll('[id^="f-"]').forEach((el) => {
    const key = el.id.slice(2);
    data[key] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
  });
  return data;
}

function applyForm(view, data) {
  if (!data) return;
  for (const [key, value] of Object.entries(data)) {
    const el = view.querySelector(`#f-${key}`);
    if (!el) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!value;
    else el.value = value == null ? '' : String(value);
  }
}

function saveDraft(type, view) {
  if (draftTimers.has(type)) clearTimeout(draftTimers.get(type));
  draftTimers.set(type, setTimeout(() => {
    draftTimers.delete(type);
    api('/api/forms', { method: 'POST', body: { key: type, data: collectForm(view) } }).catch(() => {});
  }, 400));
}

// Fill <datalist> elements from previously used values (download dir, etc).
async function fillRecentLists(view) {
  for (const input of view.querySelectorAll('[data-recent]')) {
    const kind = input.getAttribute('data-recent');
    const listId = input.getAttribute('list');
    try {
      const { values } = await api(`/api/recent?kind=${encodeURIComponent(kind)}`);
      const dl = view.querySelector(`#${listId}`);
      if (!dl || !values) continue;
      dl.innerHTML = values.map((v) => `<option value="${esc(v.value)}"></option>`).join('');
    } catch { /* history is optional */ }
  }
}

// Fields cleared after a successful submit so a stray second click cannot
// re-create the same task. Only the "what to process" inputs are cleared —
// settings (dir, template, flags) stay for convenience.
const CLEAR_AFTER_SUBMIT = {
  dl: ['f-urls'],
  forward: ['f-from'],
  up: ['f-paths'],
  export: [],
};

function makeTaskPage({ type, form, submit }) {
  return async function render(view) {
    view.innerHTML = `
      <div class="task-layout">
        <div class="task-form-col">${form()}</div>
        <div class="card task-list-col">
          <h2>任务列表</h2>
          <div id="task-list"></div>
        </div>
      </div>`;

    // restore the persisted draft, then keep it in sync as the user types
    try {
      const { data } = await api(`/api/forms?key=${encodeURIComponent(type)}`);
      applyForm(view, data);
    } catch { /* no draft yet */ }
    fillRecentLists(view);

    const formCol = view.querySelector('.task-form-col');
    const onEdit = () => saveDraft(type, view);
    formCol.addEventListener('input', onEdit);
    formCol.addEventListener('change', onEdit);

    view.querySelector('#create-btn').onclick = async () => {
      const btn = view.querySelector('#create-btn');
      btn.disabled = true;
      try {
        const r = await submit();
        const n = (r && r.count) || 1;
        toast(n > 1 ? `已创建 ${n} 个任务（每条链接一个），排队执行` : '任务已创建，加入队列', 'ok');
        // clear the "source" inputs to prevent accidental duplicate creation
        for (const id of CLEAR_AFTER_SUBMIT[type] || []) {
          const el = view.querySelector(`#${id}`);
          if (el) el.value = '';
        }
        saveDraft(type, view);
        fillRecentLists(view);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        btn.disabled = false;
      }
    };

    const pickBtn = view.querySelector('#pick-chat-btn');
    if (pickBtn) {
      pickBtn.onclick = () => pickChat({
        onPick: ({ chat }) => {
          if (!chat) return;
          const target = view.querySelector('#f-urls') || view.querySelector('#f-from');
          const link = chat.username ? `https://t.me/${chat.username}` : `https://t.me/c/${chat.id}`;
          if (target) {
            target.value = target.value ? `${target.value.replace(/\s*$/, '')}\n${link}` : link;
            toast(`已插入 ${link}（请补消息 ID）`, 'ok');
          } else {
            const chatInput = view.querySelector('#f-chat');
            if (chatInput) {
              chatInput.value = chat.username ? `@${chat.username}` : String(chat.id);
              toast('已填入目标会话', 'ok');
            }
          }
          saveDraft(type, view);
        },
      });
    }
    const listEl = view.querySelector('#task-list');
    renderTaskList(listEl, type);
  };
}

registerRoute('/download', { title: '下载', fit: true, render: makeTaskPage({ type: 'dl', form: dlForm, submit: submitDl }) });
registerRoute('/forward', { title: '转发', fit: true, render: makeTaskPage({ type: 'forward', form: forwardForm, submit: submitForward }) });
registerRoute('/upload', { title: '上传', fit: true, render: makeTaskPage({ type: 'up', form: upForm, submit: submitUp }) });
registerRoute('/export', { title: '导出消息', fit: true, render: makeTaskPage({ type: 'export', form: exportForm, submit: submitExport }) });

// re-render task lists when data changes (only if a task page is visible)
listeners.add((what) => {
  if (what !== 'task') return;
  const listEl = document.getElementById('task-list');
  if (listEl) renderTaskList(listEl, listEl.dataset.filterType || '');
});
