import { boot } from './app.js';
import './pages/dashboard.js';
import './pages/tasks.js';
import './pages/login.js';
import './pages/files.js';
import './pages/settings.js';

boot().catch((e) => {
  console.error(e);
  document.getElementById('view').innerHTML =
    `<div class="card"><div class="empty">初始化失败：${e.message}</div></div>`;
});
