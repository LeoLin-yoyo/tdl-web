// Login page: QR scan or phone+code, with 2FA password handling.

import { api, esc, store, notify, listeners, registerRoute, toast, modal, accountLabel } from '../app.js';

let inputTimer = null;
let selectedDesktopUser = null;

// Login-page fields are persisted like the task forms, so a refresh or restart
// does not lose the client directory / namespace / phone you already typed.
const LOGIN_DRAFT_KEY = 'login';

function collectLoginDraft(view) {
  const get = (id) => view.querySelector(`#${id}`);
  return {
    ns: get('login-ns') ? get('login-ns').value : '',
    phone: get('login-phone') ? get('login-phone').value : '',
    desktopPath: get('login-desktop-path') ? get('login-desktop-path').value : '',
  };
}

async function saveLoginDraft(view) {
  try { await api('/api/forms', { method: 'POST', body: { key: LOGIN_DRAFT_KEY, data: collectLoginDraft(view) } }); } catch { /* best effort */ }
}

async function render(view) {
  const cfg = store.config || {};
  view.innerHTML = `
    <div class="grid c2">
      <div class="card">
        <h2>发起登录</h2>
        <div class="field"><label>命名空间 --ns</label>
          <input type="text" id="login-ns" value="${esc(cfg.ns || 'default')}">
          <span class="hint">不同命名空间互不影响；已有数据的命名空间会被覆盖</span></div>
        <div class="grid c2" style="margin-bottom:10px">
          <button class="btn primary" id="btn-qr">扫码登录</button>
          <button class="btn" id="btn-code">手机号登录</button>
        </div>
        <div id="code-extra" class="hidden">
          <div class="field"><label>手机号（国际格式）</label>
            <input type="text" id="login-phone" placeholder="+86 13800000000"></div>
          <button class="btn primary" id="btn-code-go">发送验证码并登录</button>
        </div>
        <details class="adv" style="margin-top:12px" id="desktop-section">
          <summary>⚡ 从本机 Telegram 桌面客户端导入（免扫码，秒完成）</summary>
          <div class="adv-body">
            <div class="field"><label>客户端目录（留空自动探测）</label>
              <input type="text" id="login-desktop-path" placeholder="D:\\Program Files (x86)\\64Gram">
              <span class="hint" id="desktop-detected"></span></div>
            <div class="field"><label>本地密码 passcode（未设置则留空）</label>
              <input type="password" id="login-desktop-pass" placeholder=""></div>
            <div class="grid c2" style="margin-bottom:10px">
              <button class="btn" id="btn-desktop-scan">① 读取账号列表</button>
              <button class="btn primary" id="btn-desktop" disabled>② 导入选中账号</button>
            </div>
            <div id="desktop-accounts" class="hidden" style="margin-top:8px"></div>
            <div class="hint">支持官方版及 64Gram/AyuGram 等 fork；导入后桌面端保持登录，互不影响。</div>
          </div>
        </details>
        <div class="hint muted small" style="margin-top:14px">
          登录会话使用虚拟终端运行 <b>tdl login</b>，与 CLI 登录完全等价；登录成功后所有任务共享该会话。
        </div>
      </div>

      <div class="card">
        <h2>登录状态</h2>
        <div id="login-state-box"><div class="empty">尚未发起登录</div></div>
        <div id="login-input-box" class="hidden" style="margin-top:12px">
          <div class="field"><label id="login-input-label">输入</label>
            <input type="text" id="login-input" placeholder=""></div>
          <button class="btn primary" id="login-input-btn">提交</button>
        </div>
        <div style="margin-top:12px" id="login-cancel-box"></div>
      </div>
    </div>

    <div class="card">
      <h2>会话日志</h2>
      <div class="task-logs" id="login-logs" style="display:block;max-height:200px"></div>
    </div>`;

  const stateBox = view.querySelector('#login-state-box');
  const inputBox = view.querySelector('#login-input-box');
  const inputLabel = view.querySelector('#login-input-label');
  const inputField = view.querySelector('#login-input');
  const logsBox = view.querySelector('#login-logs');
  const cancelBox = view.querySelector('#login-cancel-box');

  function draw() {
    const l = store.login;
    logsBox.textContent = (l.logs || []).join('\n') || '（暂无日志）';

    if (!l || l.state === 'idle') return;

    if (l.state === 'starting') {
      stateBox.innerHTML = `<div class="empty"><span class="spin">◐</span> 正在启动 tdl 并连接 Telegram…</div>`;
    } else if (l.state === 'qr') {
      // 二维码优先后端渲染的 PNG：方块字符靠客户端等宽字体显示时，
      // 字体缺失会导致矩阵错位、扫码失败；PNG 则与客户端字体无关。
      // 缓存键用 qrText 的简单哈希：内容变化（tdl 刷新二维码）时 URL 随之改变，
      // 避免浏览器复用旧图。
      const qrKey = l.qrText
        ? l.qrText.length + '_' + l.qrText.charCodeAt(0) + '_' + (l.qrText.charCodeAt(l.qrText.length - 1) || 0)
        : '';
      const qrBlock = l.qrText
        ? `<img class="qr-img" src="/api/login/qr.png?v=${qrKey}"
                alt="登录二维码"
                onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block';">
           <pre class="qr-pre" style="display:none">${esc(l.qrText)}</pre>`
        : '';
      stateBox.innerHTML = `
        <div style="text-align:center">
          <div class="muted small" style="margin-bottom:10px">用 Telegram App 扫描二维码<br>（Settings → Devices → Link Desktop Device）</div>
          ${qrBlock}
          <div class="muted small" style="margin-top:10px">二维码过期会自动刷新</div>
        </div>`;
    } else if (l.state === 'password') {
      stateBox.innerHTML = `<div class="empty">检测到两步验证（2FA），请在右侧输入密码</div>`;
      inputBox.classList.remove('hidden');
      inputLabel.textContent = '两步验证密码';
      inputField.type = 'password';
      inputField.focus();
    } else if (l.state === 'code') {
      stateBox.innerHTML = `<div class="empty">验证码已发送，请在右侧输入</div>`;
      inputBox.classList.remove('hidden');
      inputLabel.textContent = '验证码';
      inputField.type = 'text';
      inputField.focus();
    } else if (l.state === 'select') {
      stateBox.innerHTML = `
        <div>
          <div class="muted small" style="margin-bottom:8px">检测到桌面客户端的账号，选择要导入的账号：</div>
          ${(l.userIds || []).length
            ? l.userIds.map((id) => `<button class="btn" data-uid="${esc(id)}" style="margin:4px">账号 ${esc(id)}</button>`).join('')
            : '<div class="empty"><span class="spin">◐</span> 正在读取账号列表…</div>'}
        </div>`;
      stateBox.querySelectorAll('[data-uid]').forEach((b) => {
        b.onclick = () => api('/api/login/input', { method: 'POST', body: { value: b.getAttribute('data-uid') } })
          .catch((e) => toast(e.message, 'error'));
      });
      inputBox.classList.add('hidden');
    } else if (l.state === 'checking') {
      stateBox.innerHTML = `<div class="empty"><span class="spin">◐</span> 验证中…</div>`;
      inputBox.classList.add('hidden');
    } else if (l.state === 'success') {
      stateBox.innerHTML = `
        <div style="text-align:center;padding:10px 0">
          <div style="font-size:30px">✅</div>
          <div style="margin-top:8px">${l.restored ? '已登录（重启后自动恢复）' : '登录成功！'}</div>
          <div class="muted small">${l.user ? esc(accountLabel(l.user)) + ' · ' : ''}ID ${l.user ? esc(l.user.id) : ''} · ns: ${esc(l.ns)}</div>
          <div class="hint muted small" style="margin-top:8px">会话保存在 ~/.tdl，重启服务或电脑后无需重新登录。</div>
          <a class="btn sm" href="#/download" style="margin-top:10px">开始下载 →</a>
        </div>`;
      inputBox.classList.add('hidden');
    } else if (l.state === 'stale') {
      stateBox.innerHTML = `
        <div style="text-align:center;padding:10px 0">
          <div style="font-size:30px">⚠️</div>
          <div style="margin-top:8px;color:var(--warn)">上次的登录已失效</div>
          <div class="muted small">${l.user ? esc(accountLabel(l.user)) + ' · ' : ''}ID ${l.user ? esc(l.user.id) : ''} · ns: ${esc(l.ns)}</div>
          <div class="muted small" style="margin-top:6px">${esc(l.error || '会话不可用，请重新登录')}</div>
          <button class="btn sm" id="login-recheck" style="margin-top:10px">重新检测</button>
        </div>`;
      inputBox.classList.add('hidden');
      const recheck = view.querySelector('#login-recheck');
      if (recheck) recheck.onclick = () => {
        recheck.disabled = true;
        recheck.textContent = '检测中…';
        api('/api/login/verify?force=1', { method: 'POST' })
          .then((st) => { store.login = st; draw(); })
          .catch((e) => toast(e.message, 'error'));
      };
    } else if (l.state === 'failed') {
      stateBox.innerHTML = `<div class="empty" style="color:var(--fail)">登录失败<br><span class="small">${esc(l.error || '')}</span></div>`;
      inputBox.classList.add('hidden');
    } else if (l.state === 'canceled') {
      stateBox.innerHTML = `<div class="empty">已取消</div>`;
      inputBox.classList.add('hidden');
    }

    cancelBox.innerHTML = l.active ? `<button class="btn sm danger" id="login-cancel">取消登录</button>` : '';
    const cancelBtn = view.querySelector('#login-cancel');
    if (cancelBtn) cancelBtn.onclick = () => api('/api/login/cancel', { method: 'POST' }).catch((e) => toast(e.message, 'error'));
  }

  draw();
  if (inputTimer) clearInterval(inputTimer);
  inputTimer = setInterval(draw, 1200); // keep QR/state fresh even without SSE deltas

  // restore the saved login draft, then keep it updated as the user types
  api(`/api/forms?key=${LOGIN_DRAFT_KEY}`).then(({ data }) => {
    if (!data) return;
    const set = (id, v) => {
      const el = view.querySelector(`#${id}`);
      if (el && v) el.value = v;
    };
    set('login-ns', data.ns);
    set('login-phone', data.phone);
    set('login-desktop-path', data.desktopPath);
    if (data.desktopPath) {
      view.querySelector('#desktop-section')?.setAttribute('open', '');
    }
  }).catch(() => {});

  const loginFormCol = view.querySelector('.grid.c2');
  if (loginFormCol) {
    const onEdit = () => saveLoginDraft(view);
    loginFormCol.addEventListener('input', onEdit);
    loginFormCol.addEventListener('change', onEdit);
  }

  // show which desktop client directory was auto-detected
  api('/api/desktop?probe=1').then((r) => {
    if (r.detected) {
      const hint = view.querySelector('#desktop-detected');
      if (hint) hint.textContent = `已自动探测到：${r.detected}`;
      const input = view.querySelector('#login-desktop-path');
      if (input && !input.value) input.placeholder = r.detected;
    }
  }).catch(() => {});

  // login always starts a FRESH telegram session and overwrites whatever
  // session data the namespace already holds — same as `tdl login` in a CLI.
  // Make the user confirm before pulling that trigger.
  function confirmLogin(kind, ns, go) {
    const m = modal('确认发起登录？', `
      <div style="line-height:1.9;font-size:13.5px">
        即将在命名空间 <b class="mono">${esc(ns)}</b> 上发起<b>${kind === 'code' ? '手机号验证码' : '扫码'}</b>登录。
        <br><span style="color:var(--fail)">⚠ 该命名空间已有的登录数据将被覆盖（tdl login 的固有行为），原有会话无法找回。</span>
        <br>建议为不同账号使用不同命名空间。
      </div>
      <div style="margin-top:14px;text-align:right">
        <button class="btn" id="cf-cancel">取消</button>
        <button class="btn primary" id="cf-ok">确认登录</button>
      </div>`);
    m.el.querySelector('#cf-cancel').onclick = m.close;
    m.el.querySelector('#cf-ok').onclick = () => { m.close(); go(); };
  }

  view.querySelector('#btn-qr').onclick = () => {
    confirmLogin('qr', view.querySelector('#login-ns').value.trim() || 'default', async () => {
      try {
        await api('/api/login', { method: 'POST', body: { kind: 'qr', ns: view.querySelector('#login-ns').value } });
        toast('登录进程已启动', 'ok');
      } catch (e) { toast(e.message, 'error'); }
    });
  };
  view.querySelector('#btn-code').onclick = () => {
    view.querySelector('#code-extra').classList.toggle('hidden');
  };
  view.querySelector('#btn-code-go').onclick = () => {
    confirmLogin('code', view.querySelector('#login-ns').value.trim() || 'default', async () => {
      try {
        await api('/api/login', { method: 'POST', body: {
          kind: 'code', ns: view.querySelector('#login-ns').value, phone: view.querySelector('#login-phone').value,
        } });
        toast('已发起验证码登录', 'ok');
      } catch (e) { toast(e.message, 'error'); }
    });
  };
  view.querySelector('#btn-desktop-scan').onclick = async () => {
    const box = view.querySelector('#desktop-accounts');
    const scanBtn = view.querySelector('#btn-desktop-scan');
    const importBtn = view.querySelector('#btn-desktop');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="empty"><span class="spin">◐</span> 正在读取桌面端账号（需联网查询昵称）…</div>`;
    scanBtn.disabled = true;
    try {
      const q = new URLSearchParams({
        dir: view.querySelector('#login-desktop-path').value,
        passcode: view.querySelector('#login-desktop-pass').value,
      });
      const r = await api(`/api/desktop?${q}`);
      if (r.error) {
        box.innerHTML = `<div class="empty" style="color:var(--fail)">${esc(r.error)}</div>`;
        return;
      }
      if (!r.accounts || !r.accounts.length) {
        box.innerHTML = `<div class="empty">该目录下没有找到账号</div>`;
        return;
      }
      selectedDesktopUser = null;
      importBtn.disabled = true;
      box.innerHTML = `
        <div class="muted small" style="margin-bottom:6px">选择要导入的账号（点选后按「导入选中账号」）：</div>
        ${r.accounts.map((a) => {
          const label = a.name || a.username || `账号 ${a.id}`;
          const sub = [a.username ? '@' + a.username : '', `ID ${a.id}`].filter(Boolean).join(' · ');
          return `
          <div class="chat-row" data-uid="${esc(a.id)}" data-idx="${esc(a.idx)}">
            <div class="avatar">${esc((label || '?').trim()[0] || '?')}</div>
            <div style="min-width:0">
              <div class="t">${esc(label)}${a.error ? ' <span class="badge failed">信息获取失败</span>' : ''}</div>
              <div class="s">${esc(sub)}${a.error ? ' · ' + esc(a.error) : ''}</div>
            </div>
          </div>`;
        }).join('')}`;
      box.querySelectorAll('.chat-row').forEach((row) => {
        row.onclick = () => {
          box.querySelectorAll('.chat-row').forEach((x) => x.style.background = '');
          row.style.background = 'var(--accent-soft)';
          selectedDesktopUser = row.getAttribute('data-uid');
          importBtn.disabled = false;
        };
      });
      const det = r.detected;
      if (det && !view.querySelector('#login-desktop-path').value) {
        view.querySelector('#login-desktop-path').value = det;
      }
    } catch (e) {
      box.innerHTML = `<div class="empty" style="color:var(--fail)">${esc(e.message)}</div>`;
    } finally {
      scanBtn.disabled = false;
    }
  };
  view.querySelector('#btn-desktop').onclick = () => {
    if (!selectedDesktopUser) { toast('请先读取并选择一个账号', 'error'); return; }
    const picked = selectedDesktopUser;
    confirmLogin('desktop', view.querySelector('#login-ns').value.trim() || 'default', async () => {
      try {
        await api('/api/login', { method: 'POST', body: {
          kind: 'desktop',
          ns: view.querySelector('#login-ns').value,
          desktopPath: view.querySelector('#login-desktop-path').value,
          passcode: view.querySelector('#login-desktop-pass').value,
          desktopUserId: picked,
        } });
        toast('正在从桌面客户端导入会话…', 'ok');
      } catch (e) { toast(e.message, 'error'); }
    });
  };
  view.querySelector('#login-input-btn').onclick = async () => {
    try {
      await api('/api/login/input', { method: 'POST', body: { value: inputField.value } });
      inputField.value = '';
    } catch (e) { toast(e.message, 'error'); }
  };
  inputField.onkeydown = (e) => { if (e.key === 'Enter') view.querySelector('#login-input-btn').click(); };
}

registerRoute('/login', { title: '账号登录', render });
