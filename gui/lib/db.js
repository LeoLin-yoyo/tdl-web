// SQLite persistence for the GUI (node:sqlite — built into Node, no native deps).
//
// Three things live here:
//   form_state     - draft values of each task form, so a page refresh keeps them
//   recent_values  - value history per kind (e.g. previously used download dirs)
//   tasks          - finished task records (migrated from the old JSON file)

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const DB_FILE = path.join(config.DATA_DIR, 'tdl-gui.db');
let db = null;

function get() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  // DDL is issued one statement at a time via prepare().run().
  const ddl = [
    'PRAGMA journal_mode = WAL',
    `CREATE TABLE IF NOT EXISTS form_state (
      form_key   TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS recent_values (
      kind      TEXT NOT NULL,
      value     TEXT NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 1,
      last_used INTEGER NOT NULL,
      PRIMARY KEY (kind, value)
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    // Original request of every task (links / files / paths). Kept separately so
    // a task can always be re-run or resumed even after the GUI restarts.
    `CREATE TABLE IF NOT EXISTS task_source (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      config     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ];
  for (const stmt of ddl) db.prepare(stmt).run();
  migrateLegacyHistory(db);
  return db;
}

// One-time import of the pre-SQLite tasks-history.json, so nothing is lost.
function migrateLegacyHistory(database) {
  const already = database.prepare('SELECT COUNT(*) AS n FROM tasks').get();
  if (already && already.n > 0) return;
  let legacy = [];
  try { legacy = JSON.parse(fs.readFileSync(config.HISTORY_FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(legacy) || !legacy.length) return;
  const stmt = database.prepare('INSERT OR REPLACE INTO tasks (id, data, created_at) VALUES (?, ?, ?)');
  for (const t of legacy) {
    if (!t || !t.id) continue;
    stmt.run(String(t.id), JSON.stringify(t), Number(t.createdAt) || Date.now());
  }
  console.log(`[db] migrated ${legacy.length} task record(s) from tasks-history.json`);
}

// ---- form drafts ---------------------------------------------------------

function getForm(key) {
  const row = get().prepare('SELECT data FROM form_state WHERE form_key = ?').get(String(key));
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function setForm(key, data) {
  get().prepare(`
    INSERT INTO form_state (form_key, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(form_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(String(key), JSON.stringify(data || {}), Date.now());
  return data;
}

// ---- recent values (dropdown history) ------------------------------------

function addRecent(kind, value) {
  const v = String(value || '').trim();
  if (!v) return;
  get().prepare(`
    INSERT INTO recent_values (kind, value, use_count, last_used) VALUES (?, ?, 1, ?)
    ON CONFLICT(kind, value) DO UPDATE SET use_count = use_count + 1, last_used = excluded.last_used
  `).run(String(kind), v, Date.now());
}

function listRecent(kind, limit = 20) {
  return get()
    .prepare('SELECT value, use_count, last_used FROM recent_values WHERE kind = ? ORDER BY last_used DESC LIMIT ?')
    .all(String(kind), Number(limit) || 20);
}

// ---- task records --------------------------------------------------------

function listTasks(limit = 200) {
  const rows = get()
    .prepare('SELECT data FROM tasks ORDER BY created_at DESC LIMIT ?')
    .all(Number(limit) || 200);
  const out = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.data)); } catch { /* skip corrupt row */ }
  }
  return out;
}

function upsertTask(task) {
  if (!task || !task.id) return;
  get().prepare('INSERT OR REPLACE INTO tasks (id, data, created_at) VALUES (?, ?, ?)')
    .run(String(task.id), JSON.stringify(task), Number(task.createdAt) || Date.now());
}

function deleteTask(id) {
  get().prepare('DELETE FROM tasks WHERE id = ?').run(String(id));
}

// ---- generic app state (settings mirror, last login, ...) ----------------

function getState(key, fallback = null) {
  const row = get().prepare('SELECT value FROM app_state WHERE key = ?').get(String(key));
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function setState(key, value) {
  get().prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(key), JSON.stringify(value ?? null), Date.now());
  return value;
}

// ---- task sources (original links, so a task can be resumed any time) -----

function saveTaskSource(task) {
  if (!task || !task.id) return;
  get().prepare(`
    INSERT INTO task_source (id, type, config, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, config = excluded.config
  `).run(String(task.id), String(task.type || ''), JSON.stringify(task.config || {}), Number(task.createdAt) || Date.now());
}

function getTaskSource(id) {
  const row = get().prepare('SELECT id, type, config, created_at FROM task_source WHERE id = ?').get(String(id));
  if (!row) return null;
  let config = {};
  try { config = JSON.parse(row.config); } catch { /* keep empty */ }
  return { id: row.id, type: row.type, config, createdAt: row.created_at };
}

function deleteTaskSource(id) {
  get().prepare('DELETE FROM task_source WHERE id = ?').run(String(id));
}

// keep the table bounded, mirroring the previous in-memory cap
function trimTasks(keep = 200) {
  get().prepare(`
    DELETE FROM tasks WHERE id NOT IN (
      SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?
    )
  `).run(Number(keep) || 200);
}

module.exports = {
  DB_FILE, get,
  getForm, setForm,
  addRecent, listRecent,
  getState, setState,
  listTasks, upsertTask, deleteTask, trimTasks,
  saveTaskSource, getTaskSource, deleteTaskSource,
};
