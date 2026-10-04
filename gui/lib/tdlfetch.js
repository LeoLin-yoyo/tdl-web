// Auto-download the tdl release for this machine from GitHub.
//
// The GUI ships no tdl binary, and the prebuilt release is OS/arch specific
// (upstream's goreleaser names them `tdl_<Os>_<Arch>` with Windows→Windows,
// darwin→MacOS, amd64→64bit, 386→32bit; Windows assets are .zip, others
// .tar.gz). This module resolves the right asset for the running machine,
// downloads it over https from GitHub only, and unpacks it under gui/tdl/.
//
// Network safety: every request target is validated to be https on an
// allow-listed GitHub host, and the resolved address must be a public one —
// localhost/loopback/private/reserved ranges are refused. Redirect targets
// are re-validated before being followed, so a hostile redirect cannot
// steer the download at an internal address.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { execFile } = require('node:child_process');
const dns = require('node:dns').promises;

const config = require('./config');

// Only these hosts may be contacted, and only over https.
const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'release-assets.githubusercontent.com',
]);

const MAX_BYTES = 200 * 1024 * 1024; // a tdl release is ~30MB; hard cap anyway
const RELEASE_API = 'https://api.github.com/repos/iyear/tdl/releases/latest';

// ---- target validation -----------------------------------------------------

// Refuse anything that is not a public unicast address: loopback, private,
// link-local, unique-local, and reserved ranges are all rejected so a
// malicious/incorrect hostname cannot make us fetch an internal service.
function isPublicAddress(ip) {
  if (!ip) return false;
  const v = ip.toLowerCase();
  if (v.includes(':')) {
    // IPv6
    if (v === '::1' || v === '::') return false;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return false; // link/unique-local
    if (v.startsWith('ff')) return false; // multicast
    // IPv4-mapped ::ffff:a.b.c.d — validate the embedded v4
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPublicAddress(m[1]);
    return true;
  }
  const parts = v.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;          // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false;          // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false;                         // multicast/reserved
  return true;
}

// Validate a URL: https + allow-listed host + all resolved addresses public.
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`下载地址不合法：${raw}`); }
  if (u.protocol !== 'https:') throw new Error(`仅允许 https 下载地址：${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error(`不允许的下载主机：${u.hostname}`);
  }
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`无法解析主机：${u.hostname}`);
  for (const a of addrs) {
    if (!isPublicAddress(a.address)) throw new Error(`主机解析到非公网地址，已拒绝：${u.hostname} → ${a.address}`);
  }
  return u;
}

// ---- http helpers ----------------------------------------------------------

// One request with redirects re-validated at each hop.
function requestOnce(u, { accept, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: u.hostname,
      port: 443,
      path: `${u.pathname}${u.search}`,
      headers: { 'User-Agent': 'tdl-web-gui', Accept: accept || '*/*' },
      timeout: timeoutMs,
    }, (res) => resolve(res));
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

async function getWithRedirects(rawUrl, { accept, timeoutMs } = {}) {
  let url = rawUrl;
  for (let hop = 0; hop < 5; hop++) {
    const u = await assertSafeUrl(url);           // validate EVERY hop
    const res = await requestOnce(u, { accept, timeoutMs });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, u).href;
      continue;
    }
    return { res, url };
  }
  throw new Error('重定向次数过多');
}

function collect(res, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    res.on('data', (c) => {
      n += c.length;
      if (n > limit) { res.destroy(new Error(`响应超过上限 ${limit} 字节`)); return; }
      chunks.push(Buffer.from(c));
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

// ---- asset selection -------------------------------------------------------

// Map this machine to upstream's asset suffix (see .goreleaser.yaml).
function targetAssetSuffix(platform = process.platform, arch = process.arch) {
  const osName = { win32: 'Windows', linux: 'Linux', darwin: 'MacOS' }[platform];
  const archName = { x64: '64bit', ia32: '32bit', arm64: 'arm64', arm: 'armv7' }[arch];
  if (!osName) throw new Error(`暂不支持的系统：${platform}`);
  if (!archName) throw new Error(`暂不支持的架构：${arch}`);
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  return `tdl_${osName}_${archName}${ext}`;
}

async function fetchLatestRelease() {
  const { res, url } = await getWithRedirects(RELEASE_API, { accept: 'application/vnd.github+json' });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`获取 tdl 版本信息失败（HTTP ${res.statusCode}，${url}）`);
  }
  const json = JSON.parse((await collect(res, 5 * 1024 * 1024)).toString('utf8'));
  return json;
}

// ---- extraction ------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} 失败：${String(stderr || err.message).slice(0, 300)}`));
      else resolve({ stdout, stderr });
    });
  });
}

// Unpack an archive into destDir using tools present on the platform.
async function extractArchive(archivePath, destDir, platform = process.platform) {
  fs.mkdirSync(destDir, { recursive: true });
  if (platform === 'win32') {
    if (archivePath.endsWith('.zip')) {
      // Windows ships bsdtar (System32\tar.exe) which reads zip; fall back to
      // PowerShell's Expand-Archive if that is unavailable.
      const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      try {
        await run(sysTar, ['-xf', archivePath, '-C', destDir]);
        return;
      } catch {
        await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${destDir}" -Force`]);
        return;
      }
    }
    await run('tar', ['-xzf', archivePath, '-C', destDir]);
    return;
  }
  await run('tar', ['-xzf', archivePath, '-C', destDir]);
}

// Find the executable inside an extracted release tree.
function findBinary(dir, exeName) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name === exeName) return full;
    }
  }
  return null;
}

// ---- public API ------------------------------------------------------------

function autoDir() { return config.TDL_AUTO_DIR; }

function exeName(platform = process.platform) {
  return platform === 'win32' ? 'tdl.exe' : 'tdl';
}

// Current state for the settings page.
function status() {
  const dir = autoDir();
  const bin = findBinary(dir, exeName()) || null;
  let installed = null;
  try { installed = fs.existsSync(bin) ? bin : null; } catch { /* ignore */ }
  return {
    autoDir: dir,
    target: (() => { try { return targetAssetSuffix(); } catch (e) { return String(e.message); } })(),
    installed,
    hasTdl: !!config.locateTdl(),
  };
}

/**
 * Download and unpack the matching tdl release into gui/tdl/.
 * onProgress({ phase, received, total }) reports coarse progress.
 * Returns { path, version, asset }.
 */
async function downloadLatest({ onProgress = () => {} } = {}) {
  const suffix = targetAssetSuffix();
  onProgress({ phase: 'query', message: '正在获取最新版本…' });
  const rel = await fetchLatestRelease();
  const asset = (rel.assets || []).find((a) => a.name === suffix)
    || (rel.assets || []).find((a) => a.name && a.name.endsWith(suffix));
  if (!asset || !asset.browser_download_url) {
    throw new Error(`未找到适配本机的发布包（${suffix}）`);
  }

  onProgress({ phase: 'download', message: `正在下载 ${asset.name}…`, total: asset.size || 0 });
  const { res, url } = await getWithRedirects(asset.browser_download_url, { timeoutMs: 120_000 });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`下载失败（HTTP ${res.statusCode}，${url}）`);
  }
  const buf = await collect(res);
  onProgress({ phase: 'extract', message: '正在解压…', received: buf.length });

  const dir = autoDir();
  fs.mkdirSync(dir, { recursive: true });
  // write to a temp file first, then unpack, then clean up
  const tmp = path.join(os.tmpdir(), `tdl-dl-${Date.now()}${path.extname(asset.name) === '.zip' ? '.zip' : '.tar.gz'}`);
  fs.writeFileSync(tmp, buf);
  try {
    // extract into a fresh subfolder so we never litter the auto dir root
    const dest = path.join(dir, suffix.replace(/\.(zip|tar\.gz)$/, ''));
    fs.rmSync(dest, { recursive: true, force: true });
    await extractArchive(tmp, dest);
    const bin = findBinary(dest, exeName());
    if (!bin) throw new Error('解压后未找到 tdl 可执行文件');
    if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ } }
    onProgress({ phase: 'done', message: '安装完成', path: bin });
    return { path: bin, version: rel.tag_name || '', asset: asset.name };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

module.exports = {
  downloadLatest, status, targetAssetSuffix, isPublicAddress, assertSafeUrl,
  findBinary, extractArchive, autoDir, exeName,
  ALLOWED_HOSTS, RELEASE_API,
};
