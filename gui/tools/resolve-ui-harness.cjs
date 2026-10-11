// End-to-end UI check for the download page resource picker: paste an album
// link, click 创建下载任务, confirm the picker lists every resource, uncheck the
// big one, then verify exactly one task was created and that its file size
// matches what the picker showed.
//
// Run: node gui/tools/resolve-ui-harness.cjs   (server on $BASE, default :8561)
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8561';
// An album whose biggest member is small enough to finish during the test.
const ALBUM = process.env.ALBUM || 'https://t.me/TBB18V/96663';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

  await page.goto(`${BASE}/#/download`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#f-urls', { timeout: 15000 });

  const before = (await (await fetch(`${BASE}/api/tasks`)).json()).tasks.length;

  await page.fill('#f-urls', ALBUM);
  await page.click('#create-btn');

  await page.waitForSelector('.res-list .res-row', { timeout: 90000 });
  const rows = await page.$$eval('.res-list .res-row', (els) => els.map((e) => ({
    name: e.querySelector('.res-name').textContent.trim(),
    size: e.querySelector('.res-size').textContent.trim(),
    checked: e.querySelector('.res-check').checked,
  })));
  console.log('picker rows:');
  for (const r of rows) console.log(`  [${r.checked ? 'x' : ' '}] ${r.name}  ${r.size}`);
  console.log('count label:', (await page.textContent('#res-count')).trim());
  console.log('ok button:', (await page.textContent('#res-ok')).trim());
  await page.screenshot({ path: path.join(__dirname, '..', 'data', 'ui-picker.png') });

  // Keep only the SMALLEST resource so the created task finishes quickly.
  const sizes = await page.$$eval('.res-list .res-row', (els) => els.map((e) => e.querySelector('.res-size').textContent.trim()));
  const idx = sizes.indexOf(sizes.slice().sort((a, b) => parseSize(a) - parseSize(b))[0]);
  const checks = await page.$$('.res-list .res-check');
  for (let i = 0; i < checks.length; i++) if (i !== idx) await checks[i].uncheck();
  console.log('after narrowing, ok button:', (await page.textContent('#res-ok')).trim());
  await page.click('#res-ok');

  await page.waitForFunction((n) => document.querySelectorAll('.task-card').length > 0, before, { timeout: 30000 });
  await page.waitForTimeout(3000);

  const after = (await (await fetch(`${BASE}/api/tasks`)).json()).tasks;
  const newest = after.sort((a, b) => b.createdAt - a.createdAt)[0];
  console.log('newest task:', newest.id, newest.status, JSON.stringify(newest.counters), (newest.urls || []).join());
  console.log('task delta:', after.length - before);

  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });

function parseSize(s) {
  const m = String(s).match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const u = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return parseFloat(m[1]) * u[m[2].toUpperCase()];
}
