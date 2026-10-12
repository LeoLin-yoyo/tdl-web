// Office 文档在线预览：把 doc/xls/ppt/pdf 等转成 PDF，交给浏览器内置阅读器渲染。
//
// 为什么走「服务端转 PDF」而不是纯前端解析：
//   纯前端方案（docx.js / SheetJS / pptxjs）对复杂排版、图表、公式的支持都很有限，
//   PPT 基本渲染不出来；LibreOffice 转出来的 PDF 是所见即所得的，保真度最高。
//
// 转换有三条原则：
//   1. **按需转换 + 落盘缓存**：同一文件只转一次（用 源文件大小+mtime 做缓存键），
//      否则每次打开都要等好几秒。
//   2. **串行执行**：soffice 同时开多个实例会互相抢配置目录而失败，
//      用一条队列把并发收成 1。
//   3. **没装 soffice 时明确说清楚**，让前端能降级，而不是抛一个看不懂的错。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const config = require('./config');
const files = require('./files');

// 可转换的扩展名 → LibreOffice 能识别的类型（这里只用来做「能不能转」的判断）
const OFFICE_EXT = new Set([
  'doc', 'docx', 'odt', 'rtf',
  'xls', 'xlsx', 'ods', 'csv',
  'ppt', 'pptx', 'odp',
]);

// 缓存目录必须落在**文件操作根目录内部**。
//
// 曾经放在 config.DATA_DIR（data/office-cache），结果是转出来的 PDF 在
// files.root() 之外，/api/files/raw 的 safeResolve 会把 `..` 直接判为越界
// → 400 → 预览框一片空白（接口返回 ok:true 但前端什么也看不到）。
// 放进 root 内部的隐藏目录（.office-cache，list() 会跳过点开头的条目），
// 既能被 raw 接口正常读到，又不会出现在文件列表里。
function cacheDir() { return path.join(files.root(), '.office-cache'); }
function logDir() { return path.join(config.DATA_DIR, 'office-profile'); }

let sofficePath;   // undefined = 还没探测过；null = 探测过但没找到

// 找 soffice。Windows/macOS/Linux 的常见位置都查一遍，再退回 PATH。
function findSoffice() {
  if (sofficePath !== undefined) return sofficePath;
  const candidates = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/opt/libreoffice/program/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
  for (const c of candidates) {
    try { if (c && fs.statSync(c).isFile()) { sofficePath = c; return c; } } catch { /* 继续找 */ }
  }
  // 退回 PATH（由 spawn 解析裸名）
  sofficePath = null;
  return null;
}

// 探测是否可用（设置页/状态接口用）
function available() {
  const p = findSoffice();
  return { ok: !!p, path: p, hint: p ? '' : '未检测到 LibreOffice，Office 文档无法在线预览（可下载后本地查看）' };
}

function cacheKey(target, st) {
  const h = crypto.createHash('sha1');
  h.update(path.resolve(target));
  h.update(String(st.size));
  h.update(String(Math.round(st.mtimeMs)));
  return h.digest('hex').slice(0, 20);
}

// 串行队列：soffice 多实例并行会因共享用户配置目录而失败
let chain = Promise.resolve();
function enqueue(fn) {
  const next = chain.then(fn, fn);
  // 无论成功失败都要让队列继续
  chain = next.catch(() => {});
  return next;
}

function runSoffice(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, stderr: String(e.message), stdout: '' });
    }
    let out = '', err = '';
    const cap = (s) => (s.length > 8000 ? s.slice(-8000) : s);
    child.stdout.on('data', (d) => { out = cap(out + d); });
    child.stderr.on('data', (d) => { err = cap(err + d); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ code: -1, stderr: `转换超时（${Math.round(timeoutMs / 1000)}秒）`, stdout: out });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: e.message, stdout: out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err, stdout: out }); });
  });
}

/**
 * 把受管目录里的一个 Office 文件转成 PDF 并返回相对路径。
 * 返回 { ok:true, pdfPath } 或 { ok:false, error }，不抛异常。
 */
async function convert(sub) {
  const info = files.statSafe(sub);
  if (!info || !info.st.isFile()) return { ok: false, error: '文件不存在' };

  const ext = path.extname(info.target).slice(1).toLowerCase();
  if (!OFFICE_EXT.has(ext)) {
    return { ok: false, error: `不支持的预览类型：.${ext}` };
  }

  const bin = findSoffice();
  if (!bin) {
    return {
      ok: false,
      error: '未安装 LibreOffice，无法在线转换预览。可在服务器上安装 libreoffice-core 后启用。',
      needLibreOffice: true,
    };
  }

  const st = info.st;
  // 受管目录配额可能拦住缓存写入，所以先按「转出来的 PDF 大概多大」估一下。
  // PDF 通常比源文件小或相当，用源文件大小做保守估计。
  const chk = config.checkWritable(st.size);
  if (!chk.ok) return { ok: false, error: `容量不足，无法生成预览缓存：${chk.message}` };

  const key = cacheKey(info.target, st);
  const CACHE_DIR = cacheDir();
  const outPdf = path.join(CACHE_DIR, `${key}.pdf`);
  const relCache = path.relative(files.root(), outPdf);

  // 命中缓存直接返回（相对路径可能算不到 root 内，那就回退成绝对路径查找）
  try {
    const cached = fs.statSync(outPdf);
    if (cached.isFile() && cached.size > 0) {
      return { ok: true, pdfPath: relCache, cached: true, abs: outPdf };
    }
  } catch { /* 没缓存，继续转 */ }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(logDir(), { recursive: true });

  const result = await enqueue(() => runSoffice(bin, [
    '--headless', '--norestore', '--invisible',
    // 独立的用户配置目录：避免与用户自己开的 LibreOffice 抢锁
    `-env:UserInstallation=file://${logDir()}`,
    '--convert-to', 'pdf',
    '--outdir', CACHE_DIR,
    info.target,
  ], 120000));

  if (result.code !== 0) {
    const msg = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    return { ok: false, error: `转换失败：${msg || `soffice 退出码 ${result.code}`}` };
  }

  // soffice 以源文件主名命名产物，可能与我们期望的缓存名不同 —— 归位
  const produced = path.join(CACHE_DIR, `${path.basename(info.target, path.extname(info.target))}.pdf`);
  try {
    if (produced !== outPdf && fs.existsSync(produced)) fs.renameSync(produced, outPdf);
  } catch { /* 归位失败就用原产物 */ }
  const finalPath = fs.existsSync(outPdf) ? outPdf : produced;

  if (!fs.existsSync(finalPath)) {
    return { ok: false, error: '转换结束但没有生成 PDF（源文件可能已损坏或受密码保护）' };
  }
  return { ok: true, pdfPath: path.relative(files.root(), finalPath), cached: false, abs: finalPath };
}

// 定期清理过期缓存（默认保留 7 天），避免一直堆积占空间
function pruneCache(maxAgeMs = 7 * 24 * 3600 * 1000) {
  let removed = 0, freed = 0;
  try {
    const now = Date.now();
    const CACHE_DIR = cacheDir();
    for (const ent of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const full = path.join(CACHE_DIR, ent.name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) { freed += st.size; fs.unlinkSync(full); removed++; }
      } catch { /* 跳过 */ }
    }
  } catch { /* 目录还不存在 */ }
  return { removed, freed };
}

module.exports = { convert, available, findSoffice, pruneCache, OFFICE_EXT, cacheDir, logDir };
