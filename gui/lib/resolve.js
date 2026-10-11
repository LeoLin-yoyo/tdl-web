// Resolve pasted Telegram links into the individual downloadable resources
// they point at, so the download page can offer a per-file selection.
//
// Why this is needed: `tdl dl -u <link>` treats ONE link as ONE message, so a
// link to an album member (t.me/<chan>/<msg>, or the `?single` variant Telegram
// hands out for grouped media) downloads a single file out of the group and
// silently drops the rest. `--group` exists, but it is a global switch, not a
// per-link selection, and it is not applied in `--serve` mode at all (the serve
// index emits one entry per message; verified against tdl 0.20.4).
//
// `tdl chat export --raw` is the only tdl surface that exposes GroupedID, so
// the resolver reads a small window of messages around each link and expands
// the target's group into its members. Everything else (a link to a single
// photo/video) resolves to exactly one resource.

const fs = require('node:fs');
const path = require('node:path');
const tdl = require('./tdl');
const config = require('./config');
const stream = require('./stream');

const RESOLVE_DIR = path.join(config.DATA_DIR, 'resolve-ns');
const EXPORT_DIR = path.join(config.DATA_DIR, 'resolve');
// Telegram caps an album at 10 items, so +/-9 around any member covers the
// whole group even when the link points at its first or last entry.
const WINDOW = 9;
const EXPORT_TIMEOUT_MS = 120000;

// ---- link parsing ----------------------------------------------------------
//
// Mirrors tdl's own ParseMessageLink (core/util/tutil): the middle number of a
// three/four-segment path is a TOPIC id, and the LAST number is the message.
// tdl validates the same shape before use, so a link accepted here is one tdl
// will accept too.

function parseLink(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 512) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null; // https only; http is refused, not upgraded
  if (u.username || u.password || u.port) return null;
  if (u.hostname.toLowerCase() !== 't.me') return null;

  // A discussion-comment link points at the channel's linked chat, which this
  // resolver does not model; hand it back unexpanded so the caller falls back
  // to the plain download path (tdl handles it correctly).
  if (u.searchParams.get('comment')) return null;

  const segs = u.pathname.split('/').filter(Boolean);
  const num = (v) => /^\d{1,12}$/.test(v);
  let peer = null;
  let msg = null;
  let topic = null;

  if (segs[0] === 'c' && /^\d{1,20}$/.test(segs[1] || '')) {
    // /c/<channelId>/<msg>  or  /c/<channelId>/<topic>/<msg>
    if (segs.length === 3 && num(segs[2])) { peer = segs[1]; msg = Number(segs[2]); }
    else if (segs.length === 4 && num(segs[2]) && num(segs[3])) { peer = segs[1]; topic = Number(segs[2]); msg = Number(segs[3]); }
  } else if (/^[A-Za-z0-9_]{4,32}$/.test(segs[0] || '')) {
    // /<name>/<msg>  or  /<name>/<topic>/<msg>
    if (segs.length === 2 && num(segs[1])) { peer = segs[0]; msg = Number(segs[1]); }
    else if (segs.length === 3 && num(segs[1]) && num(segs[2])) { peer = segs[0]; topic = Number(segs[1]); msg = Number(segs[2]); }
  }
  if (!peer || !Number.isSafeInteger(msg) || msg <= 0) return null;

  // `?single` is deliberately IGNORED. Telegram's clients append it to every
  // link copied from an album ("just this one"), so it says nothing about what
  // the user wants — and acting on it silently drops the album's other members
  // (a pasted album link downloaded only its cover photo, losing the video).
  // Expanding always is the safe direction: the picker is pre-checked, so a
  // user who really wants one item just unchecks the rest, while the reverse
  // mistake loses data with no way to recover it.
  return { peer, msg, topic, source: s };
}

// Split pasted text into links. Lines are the documented separator, but people
// also paste several links on one line (space/comma separated), so accept those
// too — that is itself a "text with several resources" case.
function splitLinks(text) {
  return String(text == null ? '' : text)
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- export window ---------------------------------------------------------

// tdl is single-writer only for its bolt store, and this resolver works on its
// own mirrored copy (see stream.mirrorSession), so it does not queue behind a
// running download. Serialize among resolver calls anyway: each one spawns a
// tdl process, and a burst of them buys nothing.
let chain = Promise.resolve();

function exportWindow(link, lo, hi) {
  const ns = String(config.load().ns || 'default');
  // tdl's bolt storage takes a DIRECTORY and stores the namespace as a file
  // inside it (`<dir>/<ns>`) — mirrorSession puts the copy at exactly that
  // path, so the two agree on where the session lives.
  stream.mirrorSession(ns, RESOLVE_DIR);
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const outPath = path.join(EXPORT_DIR, `w-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);

  const args = [...config.globalArgs(config.load()), 'chat', 'export',
    '--chat', link.peer,
    '--type', 'id',
    '--input', `${lo},${hi}`,
    '--raw',
    '--output', outPath,
    '--storage', `path=${RESOLVE_DIR.replace(/\\/g, '/')},type=bolt`,
  ];
  if (link.topic) args.push('--topic', String(link.topic));

  return tdl.collect(args, { timeoutMs: EXPORT_TIMEOUT_MS }).then((res) => {
    if (res.timedOut) throw new Error('解析超时（tdl chat export 无响应）');
    let text = '';
    try { text = fs.readFileSync(outPath, 'utf8'); } catch { /* missing below */ }
    try { fs.unlinkSync(outPath); } catch { /* best effort */ }
    if (!text) {
      const tail = String(res.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      throw new Error(tail || `导出消息失败（exit ${res.exitCode}）`);
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error(`解析导出结果失败：${e.message}`); }
    if (!parsed || !Array.isArray(parsed.messages)) throw new Error('导出结果中没有消息');
    return parsed;
  });
}

// ---- resource extraction ---------------------------------------------------

// Largest available rendition of a photo. A plain PhotoSize carries `Size`; a
// PhotoSizeProgressive carries a `Sizes` array whose LAST entry is the full
// file size (the earlier ones are the progressive stages) — summing them would
// overstate the download (verified against a real file: 112659 bytes).
function photoSize(photo) {
  let best = 0;
  for (const s of (photo && photo.Sizes) || []) {
    if (Number.isFinite(s.Size) && s.Size > best) best = s.Size;
    if (Array.isArray(s.Sizes) && s.Sizes.length) {
      const full = Number(s.Sizes[s.Sizes.length - 1]) || 0;
      if (full > best) best = full;
    }
  }
  return best;
}

// One exported message -> its media descriptor, or null when it carries none.
function mediaOf(message) {
  const raw = message && message.raw;
  const media = raw && raw.Media;
  if (!media) return null;
  if (media.Document) {
    return { name: message.file || 'file', size: Number(media.Document.Size) || 0, mime: media.Document.MimeType || '' };
  }
  if (media.Photo) {
    return { name: message.file || 'photo.jpg', size: photoSize(media.Photo), mime: 'image/jpeg' };
  }
  return null;
}

function toResource(peerId, message) {
  const media = mediaOf(message);
  if (!media) return null;
  const ext = (String(media.name).match(/\.([A-Za-z0-9]+)$/) || ['', ''])[1].toLowerCase();
  return {
    // A c/<peerId>/<msg> link addresses exactly this one message, which is what
    // makes "one task per checked resource" unambiguous.
    link: `https://t.me/c/${peerId}/${message.id}`,
    msgId: message.id,
    name: media.name,
    size: media.size,
    mime: media.mime,
    ext,
  };
}

// ---- public API ------------------------------------------------------------

async function expandOne(link) {
  const lo = Math.max(1, link.msg - WINDOW);
  const hi = link.msg + WINDOW;
  const data = await exportWindow(link, lo, hi);
  const peerId = data.id;
  const target = data.messages.find((m) => m.id === link.msg);
  if (!target) return { link: link.source, resources: [], note: '未找到该消息（可能已删除或无权访问）' };

  const targetMedia = mediaOf(target);
  if (!targetMedia) return { link: link.source, resources: [], note: '该消息不包含媒体文件' };

  const grouped = target.raw && target.raw.GroupedID;
  if (!grouped) return { link: link.source, resources: [toResource(peerId, target)], grouped: false };

  // Album: every member sharing the target's GroupedID, in message order.
  const members = data.messages
    .filter((m) => m.raw && m.raw.GroupedID === target.raw.GroupedID && mediaOf(m))
    .sort((a, b) => a.id - b.id);
  const resources = members.map((m) => toResource(peerId, m)).filter(Boolean);
  if (!resources.length) return { link: link.source, resources: [toResource(peerId, target)], grouped: false };
  return { link: link.source, resources, grouped: true };
}

// Resolve a batch of links. Each entry reports its own outcome so one bad link
// does not hide the others; `error` marks a link the resolver could not read.
async function resolveText(text) {
  const seen = new Set();
  const links = [];
  for (const raw of splitLinks(text)) {
    const parsed = parseLink(raw);
    if (!parsed || seen.has(parsed.source)) continue;
    seen.add(parsed.source);
    links.push(parsed);
  }
  if (!links.length) return { links: [], resources: [], total: 0, unparsed: true };

  const out = [];
  for (const link of links) {
    try {
      out.push(await expandOne(link));
    } catch (e) {
      out.push({ link: link.source, resources: [], error: String(e.message || e) });
    }
  }
  const resources = out.flatMap((g) => g.resources);
  return {
    links: out,
    resources,
    total: resources.length,
    // true when every link resolved to exactly one file: the caller can then
    // create the task directly instead of asking the user to choose.
    trivial: out.every((g) => g.resources.length === 1),
  };
}

function resolve(text) {
  const run = () => resolveText(text);
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

module.exports = { resolve, parseLink, splitLinks };
