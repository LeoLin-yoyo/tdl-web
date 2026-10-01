// `tdl chat ls -o json` with caching — powers the account check and the
// chat picker in the download/export forms.

const tdl = require('./tdl');
const config = require('./config');

let cache = { at: 0, data: null, error: null };

async function listChats({ refresh = false } = {}) {
  const TTL = 10 * 60 * 1000;
  if (!refresh && cache.data && Date.now() - cache.at < TTL) {
    return { ...cache, cached: true };
  }
  const cfg = config.load();
  const res = await tdl.collect([...config.globalArgs(cfg), 'chat', 'ls', '-o', 'json'], { timeoutMs: 180000 });
  const out = res.stdout || '';
  const start = out.indexOf('[');
  if (res.exitCode !== 0 || start === -1) {
    const errText = (out || res.stderr || '').trim();
    cache = {
      at: Date.now(), data: null,
      error: /database is used by another process/i.test(errText)
        ? 'tdl 数据库被其他进程占用'
        : (errText.split('\n').filter(Boolean).pop() || `chat ls 失败（exit ${res.exitCode}）`),
    };
    return { ...cache, cached: false };
  }
  try {
    const end = out.lastIndexOf(']');
    const data = JSON.parse(out.slice(start, end + 1));
    cache = { at: Date.now(), data, error: null };
  } catch (e) {
    cache = { at: Date.now(), data: null, error: `解析会话列表失败: ${e.message}` };
  }
  return { ...cache, cached: false };
}

module.exports = { listChats };
