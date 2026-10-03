// File browser over the download root. Every path is resolved and required
// to stay inside the configured root — no escaping the sandbox.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo', '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t', '.3gp': 'video/3gpp', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.apk': 'application/vnd.android.package-archive',
};

function root() { return path.resolve(config.load().dir); }

/** Resolve a user-supplied relative path inside the root. Returns null if it escapes. */
function safeResolve(sub) {
  const base = root();
  const target = path.resolve(base, String(sub || '.').replace(/^([A-Za-z]:)?[\\/]+/, './'));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function list(sub) {
  const target = safeResolve(sub);
  if (!target) return { error: '路径越界' };
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (e) {
    return { error: `读取目录失败: ${e.message}` };
  }
  const files = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(target, ent.name);
    let size = 0, mtime = 0;
    try {
      const st = fs.statSync(full);
      mtime = st.mtimeMs;
      size = st.isDirectory() ? 0 : st.size;
    } catch { /* unreadable entry */ }
    files.push({ name: ent.name, dir: ent.isDirectory(), size, mtime });
  }
  files.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
  return {
    path: path.relative(root(), target) || '.',
    root: root(),
    parent: target === root() ? null : path.relative(root(), path.dirname(target)) || '.',
    files,
  };
}

function statSafe(sub) {
  const target = safeResolve(sub);
  if (!target) return null;
  try { return { target, st: fs.statSync(target) }; } catch { return null; }
}

module.exports = { root, safeResolve, list, statSafe, MIME };
