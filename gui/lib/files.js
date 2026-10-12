// File browser over the download root. Every path is resolved and required
// to stay inside the configured root — no escaping the sandbox.

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.tiff': 'image/tiff', '.tif': 'image/tiff',
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

// 文件操作的根目录。
// 服务器模式 → 受管目录（见 config.activeRoot）；普通模式 → 配置的下载目录。
// 两种模式下「文件」页与 /api/files/* 的一切路径都限定在这个根内。
function root() { return config.activeRoot(); }

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
    if (ent.name.startsWith('.')) continue; // 隐藏文件（含 .trash 回收站）不列出来
    const full = path.join(target, ent.name);
    let size = 0, mtime = 0;
    try {
      const st = fs.statSync(full);
      mtime = st.mtimeMs;
      size = st.isDirectory() ? 0 : st.size;
    } catch { /* unreadable entry */ }
    files.push({
      name: ent.name,
      dir: ent.isDirectory(),
      size,
      mtime,
      ext: ent.isDirectory() ? '' : path.extname(ent.name).toLowerCase().replace(/^\./, ''),
      text: !ent.isDirectory() && isTextFile(ent.name),
    });
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

// ---- 写操作 ----------------------------------------------------------------
//
// 所有写操作都遵守三条底线：
//   1. 路径必须落在 root 内（safeResolve / safeWriteResolve，越界一律拒绝）
//   2. 写入前过一遍容量检查（受管目录配额 + 机器剩余空间）
//   3. 删除走「移到回收站」而不是直接抹掉 —— 误删可救（AGENTS.md: trash > rm）

const TRASH_DIR = '.trash';

// 解析一个「将要被创建」的路径。safeResolve 只处理已存在的路径语义，
// 这里额外拒绝空段与以 .. 结尾的构造，并确保父目录也在 root 内。
function safeWriteResolve(sub) {
  const raw = String(sub == null ? '' : sub).trim();
  if (!raw) return null;
  const target = safeResolve(raw);
  if (!target) return null;
  if (target === root()) return null;           // 不允许对根目录本身动手
  if (path.basename(target) === '.' || path.basename(target) === '..') return null;
  return target;
}

// 文件名/目录名的合法性。拒绝分隔符与 ..（防目录穿越），也拒绝保留名。
function safeName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s || s === '.' || s === '..') return null;
  if (/[\\/]/.test(s)) return null;             // 不允许用名称夹带路径
  if (/[\x00-\x1f<>:"|?*]/.test(s)) return null; // 控制字符与 Windows 非法字符
  // 拒绝百分号：`%2f` 这类编码在静态/代理层有可能被再解一次，
  // 变成真正的 `/` 从而把「一个名字」变回「一条路径」。
  // 现在虽然不逃逸（见对抗测试），但让这种名字根本建不出来更干净，
  // 也省得用户困惑「为什么目录叫 ..%2f..%2fescape」。
  if (/%/.test(s)) return null;
  if (s.length > 255) return null;
  return s;
}

function joinSafe(base, name) {
  const n = safeName(name);
  if (!n) return null;
  return base === '.' || !base ? n : `${base.replace(/[\\/]+$/, '')}/${n}`;
}

function mkdir(sub) {
  const target = safeWriteResolve(sub);
  if (!target) return { error: '路径非法或越界' };
  if (fs.existsSync(target)) return { error: '目录已存在' };
  try {
    fs.mkdirSync(target, { recursive: false });
    return { ok: true, path: path.relative(root(), target) };
  } catch (e) { return { error: `创建目录失败: ${e.message}` }; }
}

function rename(sub, newName) {
  const target = safeResolve(sub);
  if (!target || target === root()) return { error: '路径非法或越界' };
  const n = safeName(newName);
  if (!n) return { error: '名称非法（不能含 / \\ 或特殊字符）' };
  const dest = path.join(path.dirname(target), n);
  if (!dest.startsWith(root() + path.sep) && dest !== root()) return { error: '路径越界' };
  if (fs.existsSync(dest)) return { error: '同名文件或目录已存在' };
  try {
    fs.renameSync(target, dest);
    return { ok: true, from: path.relative(root(), target), to: path.relative(root(), dest) };
  } catch (e) { return { error: `重命名失败: ${e.message}` }; }
}

// 移动/复制到另一个目录（within root）。move=false 时是复制。
function transfer(sub, destDir, move = false) {
  const src = safeResolve(sub);
  const dir = safeResolve(destDir);
  if (!src || !dir || src === root()) return { error: '路径非法或越界' };
  let st;
  try { st = fs.statSync(src); } catch { return { error: '源文件不存在' }; }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: '目标目录不存在' };
  const dest = path.join(dir, path.basename(src));
  if (dest === src) return { error: '源与目标相同' };
  if (!dest.startsWith(root() + path.sep)) return { error: '路径越界' };
  if (fs.existsSync(dest)) return { error: '目标目录已有同名项' };
  // 不允许把目录移进它自己的子目录（会造成无限递归）
  if (st.isDirectory() && (dest + path.sep).startsWith(src + path.sep)) {
    return { error: '不能把目录移动到它自己的子目录里' };
  }
  if (!move) {
    const need = st.isDirectory() ? config.dirUsage(src, { bytes: 0, files: 0 }).bytes : st.size;
    const chk = config.checkWritable(need);
    if (!chk.ok) return { error: chk.message };
  }
  try {
    if (move) fs.renameSync(src, dest);
    else fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
    config.invalidateUsage();
    return { ok: true, from: path.relative(root(), src), to: path.relative(root(), dest), moved: !!move };
  } catch (e) { return { error: `${move ? '移动' : '复制'}失败: ${e.message}` }; }
}

// 删除 = 移到 root/.trash/<时间戳>-<原名>，可恢复。
// 若回收站本身不可写（权限/配额），退回直接删除前会明确告知调用方。
function remove(sub, hard = false) {
  const target = safeResolve(sub);
  if (!target || target === root()) return { error: '路径非法或越界' };
  if (!fs.existsSync(target)) return { error: '文件或目录不存在' };
  // 不允许删掉回收站本身
  if (path.basename(target) === TRASH_DIR && path.dirname(target) === root()) {
    return { error: '不能删除回收站目录' };
  }
  try {
    if (hard) {
      fs.rmSync(target, { recursive: true, force: true });
      config.invalidateUsage();
      return { ok: true, hard: true };
    }
    const trash = path.join(root(), TRASH_DIR);
    fs.mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let dest = path.join(trash, `${stamp}__${path.basename(target)}`);
    // 极端情况下同一毫秒重名，加序号
    let i = 1;
    while (fs.existsSync(dest)) dest = path.join(trash, `${stamp}__${i++}__${path.basename(target)}`);
    fs.renameSync(target, dest);
    config.invalidateUsage();
    return { ok: true, trashPath: path.relative(root(), dest) };
  } catch (e) { return { error: `删除失败: ${e.message}` }; }
}

// ---- 文本读写 --------------------------------------------------------------

// 允许在线编辑的文本类扩展名
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.log', '.csv', '.tsv', '.ini', '.conf', '.cfg',
  '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.jsx', '.tsx', '.py', '.sh', '.bash', '.sql', '.env', '.srt', '.vtt', '.m3u',
]);

function isTextFile(name) {
  return TEXT_EXT.has(path.extname(String(name || '')).toLowerCase());
}

// 文本文件读取上限：超过就拒绝在线打开（避免把几百 MB 的日志灌进浏览器）
const TEXT_MAX = 4 * 1024 * 1024;

function readText(sub) {
  const info = statSafe(sub);
  if (!info || !info.st.isFile()) return { error: '文件不存在' };
  if (!isTextFile(path.basename(info.target))) return { error: '不是可编辑的文本文件' };
  if (info.st.size > TEXT_MAX) {
    return { error: `文件过大（${config.fmtGB(info.st.size)}），超过在线编辑上限 ${config.fmtGB(TEXT_MAX)}` };
  }
  try {
    const buf = fs.readFileSync(info.target);
    // 简单判定二进制：出现 NUL 字节就当二进制文件，不允许当文本编辑
    if (buf.includes(0)) return { error: '看起来是二进制文件，无法作为文本编辑' };
    return { ok: true, content: buf.toString('utf8'), size: info.st.size, mtime: info.st.mtimeMs };
  } catch (e) { return { error: `读取失败: ${e.message}` }; }
}

function writeText(sub, content) {
  const target = safeResolve(sub);
  if (!target || target === root()) return { error: '路径非法或越界' };
  if (!isTextFile(path.basename(target))) return { error: '只能写入文本类文件' };
  const body = String(content == null ? '' : content);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > TEXT_MAX) return { error: `内容过大，超过 ${config.fmtGB(TEXT_MAX)}` };
  // 覆盖写：只校验「新增」的那部分，避免已存在文件的自身大小把配额占死
  let existing = 0;
  try { existing = fs.statSync(target).size; } catch { /* 新文件 */ }
  const chk = config.checkWritable(Math.max(0, bytes - existing));
  if (!chk.ok) return { error: chk.message };
  try {
    fs.writeFileSync(target, body, 'utf8');
    config.invalidateUsage();
    return { ok: true, size: bytes, path: path.relative(root(), target) };
  } catch (e) { return { error: `写入失败: ${e.message}` }; }
}

// 保存上传内容。buf 为 Buffer，写入前做容量检查。
function saveUpload(sub, buf) {
  const target = safeResolve(sub);
  if (!target || !path.basename(target)) return { error: '路径非法或越界' };
  if (!safeName(path.basename(target))) return { error: '文件名非法' };
  const size = buf.length;
  const chk = config.checkWritable(size);
  if (!chk.ok) return { error: chk.message };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 先写临时文件再原子 rename：半成品文件不会被读到
    const tmp = `${target}.part-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    config.invalidateUsage();
    return { ok: true, size, path: path.relative(root(), target) };
  } catch (e) { return { error: `保存失败: ${e.message}` }; }
}

module.exports = {
  root, safeResolve, safeWriteResolve, safeName, joinSafe, list, statSafe, MIME,
  mkdir, rename, transfer, remove, readText, writeText, saveUpload,
  isTextFile, TEXT_EXT, TEXT_MAX, TRASH_DIR,
};
