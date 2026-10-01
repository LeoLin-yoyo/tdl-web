// Backfill task_source for tasks created before the table existed, by parsing
// their recorded `tdl ...` argument string. Idempotent.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_FILE = path.join(__dirname, '..', 'data', 'tdl-gui.db');
const db = new DatabaseSync(DB_FILE);

// Parse the display args back into a task config (only the parts we can trust).
function parseArgs(args) {
  const cfg = {};
  const urls = [];
  const files = [];
  const toks = String(args || '').match(/"[^"]*"|\S+/g) || [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i].replace(/^"|"$/g, '');
    const next = () => (toks[i + 1] || '').replace(/^"|"$/g, '');
    if (t === '-u') { urls.push(next()); i++; }
    else if (t === '-f') { files.push(next()); i++; }
    else if (t === '--dir') { cfg.dir = next(); i++; }
    else if (t === '--template') { cfg.template = next(); i++; }
    else if (t === '--include') { cfg.include = next().split(','); i++; }
    else if (t === '--exclude') { cfg.exclude = next().split(','); i++; }
    else if (t === '--ns') { cfg.ns = next(); i++; }
    else if (t === '--threads') { cfg.threads = Number(next()); i++; }
    else if (t === '--limit') { cfg.limit = Number(next()); i++; }
    else if (t === '--group') cfg.group = true;
    else if (t === '--takeout') cfg.takeout = true;
    else if (t === '--skip-same') cfg.skipSame = true;
    else if (t === '--rewrite-ext') cfg.rewriteExt = true;
    else if (t === '--desc') cfg.desc = true;
    else if (t === '--restart') cfg.restart = true;
  }
  if (urls.length) cfg.urls = urls;
  if (files.length) cfg.files = files;
  return cfg;
}

const rows = db.prepare('SELECT data FROM tasks').all();
const insert = db.prepare(`
  INSERT INTO task_source (id, type, config, created_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING
`);

let added = 0;
for (const row of rows) {
  let t;
  try { t = JSON.parse(row.data); } catch { continue; }
  if (t.type !== 'dl') continue;
  const cfg = parseArgs(t.args);
  if (!cfg.urls && !cfg.files) continue; // nothing to resume with
  insert.run(t.id, t.type, JSON.stringify(cfg), Number(t.createdAt) || Date.now());
  added++;
}
console.log(`backfilled ${added} download task source(s)`);
db.close();
