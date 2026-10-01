// One-off repair: earlier tasks that tdl reported as exit 0 but which processed
// zero files were recorded as "success". They are actually "no files matched"
// (the include/exclude case-sensitivity bug). Re-label them so the history is
// not misleading. Run once; it is idempotent.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(__dirname, '..', 'data', 'tdl-gui.db');
const db = new DatabaseSync(DB_FILE);

const rows = db.prepare('SELECT id, data FROM tasks').all();
const update = db.prepare('UPDATE tasks SET data = ? WHERE id = ?');

let fixed = 0;
for (const row of rows) {
  let t;
  try { t = JSON.parse(row.data); } catch { continue; }
  if (t.status !== 'success') continue;
  const c = t.counters || {};
  // export tasks legitimately produce no "items"; only re-label others
  if (t.type === 'export') continue;
  if ((c.itemsKnown || 0) === 0 && (c.done || 0) === 0 && (c.failed || 0) === 0) {
    t.status = 'nomatch';
    t.error = '没有任何文件被处理：链接里没有可下载的媒体，或扩展名过滤把所有文件都排除了'
      + '（tdl 的 --include/--exclude 按原始大小写匹配）。';
    update.run(JSON.stringify(t), row.id);
    fixed++;
  }
}

console.log(`re-labeled ${fixed} task(s) from success -> nomatch`);
db.close();
