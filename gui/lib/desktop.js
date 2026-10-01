// Desktop-client (tdata) discovery and account-name resolution.
//
// tdata stores account names encrypted, so names must be queried from
// Telegram. This shells out to tools/tdlinfo/tdlinfo.exe, which builds an
// in-memory session per account and performs a single read-only self lookup.
// It never touches tdl's database, so it cannot disturb the task queue.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const config = require('./config');

const TOOL = path.join(config.GUI_ROOT, 'tools', 'tdlinfo', 'tdlinfo.exe');

// Candidate locations, mirroring tdl's own detection (%APPDATA%) plus the
// portable installs found on this machine. Order matters: prefer the client
// that was touched most recently, so we don't pick a stale install.
function candidates() {
  const out = [];
  const appdata = process.env.APPDATA;
  if (appdata) {
    out.push(path.join(appdata, 'Telegram Desktop'));
    out.push(path.join(appdata, 'Telegram Desktop UWP'));
  }
  out.push('D:\\Program Files (x86)\\PC-AyuGram');
  out.push('D:\\Program Files (x86)\\64Gram');
  out.push('D:\\Program Files\\Telegram Desktop');
  out.push('C:\\Program Files\\Telegram Desktop');
  out.push('C:\\Program Files (x86)\\Telegram Desktop');
  return out;
}

// Recency of a client's data: newest mtime among its tdata root and the
// per-account data dirs (which is what the client writes while running).
function freshness(dir) {
  const tdata = path.join(dir, 'tdata');
  let newest = 0;
  const touch = (p) => {
    try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* missing */ }
  };
  touch(tdata);
  try {
    for (const ent of fs.readdirSync(tdata, { withFileTypes: true })) {
      if (ent.isDirectory()) touch(path.join(tdata, ent.name));
    }
  } catch { /* unreadable */ }
  return newest;
}

// Returns the directory that actually holds a tdata folder, preferring the
// most recently used client when several are installed.
function detect() {
  const found = [];
  for (const dir of candidates()) {
    try {
      if (fs.statSync(path.join(dir, 'tdata')).isDirectory()) found.push(dir);
    } catch { /* not here */ }
  }
  if (!found.length) return null;
  found.sort((a, b) => freshness(b) - freshness(a));
  return found[0];
}

function hasTool() {
  try { return fs.statSync(TOOL).isFile(); } catch { return false; }
}

/**
 * List accounts in a desktop client directory with resolved names.
 * Returns { accounts: [{idx,id,name,username}], error }.
 */
function listAccounts(desktopDir, passcode, proxy) {
  return new Promise((resolve) => {
    if (!hasTool()) {
      return resolve({ accounts: null, error: '缺少 tdlinfo 工具（tools/tdlinfo/tdlinfo.exe）' });
    }
    // default to the most recently used client when the caller gave no dir
    const dir = String(desktopDir || '').trim() || detect();
    if (!dir) return resolve({ accounts: null, error: '未找到 Telegram 桌面客户端目录，请手动填写' });

    // tdlinfo accepts the tdata dir; append it when the user gave the parent.
    const root = path.basename(dir).toLowerCase() === 'tdata' ? dir : path.join(dir, 'tdata');
    const args = [root, String(passcode || ''), String(proxy || '')];

    execFile(TOOL, args, { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) {
        return resolve({ accounts: null, error: `读取桌面端数据失败：${err.message}` });
      }
      try {
        const accounts = JSON.parse(stdout);
        resolve({ accounts, error: null, dir });
      } catch (e) {
        resolve({ accounts: null, error: `解析结果失败：${e.message}` });
      }
    });
  });
}

module.exports = { detect, hasTool, listAccounts, candidates };
