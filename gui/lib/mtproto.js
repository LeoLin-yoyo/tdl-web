// MTProto proxy bridge.
//
// tdl (gotd) only speaks socks5/http, but MTProto proxies need the Telegram
// obfuscated transport. This module exposes a LOCAL SOCKS5 server; every
// CONNECT is tunneled through a user-configured MTProto proxy.
//
// Two client modes, per the reference server implementation
// (TelegramMessenger/MTProxy net-tcp-rpc-ext-server.c):
//
// * plain (dd/no-domain secrets): client sends a 64-byte header
//     init(56 random) || CTR(init[56:64])
//     init[0] not in {0xef,0xdd,0xee,0x16}, init[4:8] != 0
//     plaintext tail: [56:60]=tag 0xeeeeeeee, [60:62]=int16LE target DC, 2 rand
//
// * faketls (ee-prefixed secrets with a domain): the proxy sits behind a
//   SNI-routing front (everything unrecognized is relayed to the REAL domain —
//   perfect camouflage), and only a crafted TLS hello reaches the MTProto
//   backend:
//     1. ClientHello with SNI = secret domain, whose random field is
//        HMAC-SHA256(secret16, hello-with-random-zeroed)[0:28] || (mac[28:32]
//        XOR unix-time-BE32) — byte-exact per ext.c:1141-1167
//     2. wait for the server response burst (ServerHello+CCS+junk record)
//     3. send dummy CCS (14 03 03 00 01 01) + one application-data record
//        whose payload STARTS with the plain 64-byte obfuscated header
//     4. from then on the CTR-obfuscated stream rides inside 17 03 03
//        record framing both ways (ext.c:1073-1107,1219-1243)
//
//   send key = SHA256(init[8:40] || secret16), send iv = init[40:56]
//   recv key = SHA256(rev(init[24:56]) || secret16), recv iv = rev(init[8:24])
//   (rev(x)[i] = x[len-1-i] over the noted ranges)
//
// The bridge connects DIRECTLY to the MTProto server — that is the point of
// the protocol: it is disguised as TLS and reachable without a VPN.
//
// No credentials live in this file: links always arrive at runtime from the
// user's settings or the test/harness entry points.

'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

// MTPROTO_DEBUG=1 logs per-connection lifecycle + first bytes each way.
const DEBUG = !!process.env.MTPROTO_DEBUG;
const dbg = (...a) => { if (DEBUG) console.log('[mtp]', ...a); };

// ---- link parsing -----------------------------------------------------------

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().trim();
  if (!h || h === 'localhost' || h === '*' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0 || a >= 224) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  return false; // public DNS name
}

function decodeSecret(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('缺少 secret');
  let buf = null;
  if (/^[0-9a-f]+$/i.test(s) && s.length >= 34) {
    buf = Buffer.from(s, 'hex'); // dd- or ee-prefixed hex secret
  } else {
    try { buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice((s.length + 3) % 4), 'base64'); }
    catch { /* fallthrough */ }
  }
  if (!buf || buf.length < 16) throw new Error('secret 无法解码');
  // 0xee (faketls domain) / 0xdd (random padding) prefixes carry 16 key bytes
  // after the marker byte. The ee tail is the SNI domain for faketls.
  const off = (buf[0] === 0xdd || buf[0] === 0xee) ? 1 : 0;
  if (buf.length - off < 16) throw new Error('secret 长度不足');
  const domain = buf[0] === 0xee ? buf.subarray(off + 16).toString('ascii').replace(/[^\x20-\x7e]/g, '') : '';
  return { secret16: buf.subarray(off, off + 16), domain };
}

// Accepts https://t.me/proxy?server=&port=&secret= and tg://proxy?...
function parseLink(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('空链接');
  let u = null;
  try { u = new URL(raw); } catch { throw new Error('链接格式无法解析'); }
  const okHost = /(^|\.)t\.me$/i.test(u.hostname) || /^tg$/i.test(u.protocol.replace(':', ''));
  if (!okHost || !/^(proxy|socks)$/i.test(u.pathname.replace(/^\//, ''))) {
    throw new Error('不是 t.me/proxy 或 tg://proxy 链接');
  }
  const server = (u.searchParams.get('server') || '').trim();
  const port = parseInt(u.searchParams.get('port') || '', 10);
  if (!server) throw new Error('链接缺少 server');
  if (isPrivateHost(server) && !process.env.MTPROTO_ALLOW_PRIVATE) {
    throw new Error('代理服务器地址不允许是内网/本地地址');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('链接缺少合法 port');
  const { secret16, domain } = decodeSecret(u.searchParams.get('secret'));
  return { server, port, secret16, domain, raw };
}

function parseLinks(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(parseLink(t)); } catch { /* skip invalid lines silently */ }
  }
  return out;
}

// ---- DC routing --------------------------------------------------------------

// The proxy picks the Telegram DC by the int16 target in the handshake. gotd
// dials the canonical DC addresses below (same list tdlib ships). Anything
// else gets logged once and routed to DC2, the usual entry DC.
const DC_IPS = new Map([
  ['149.154.175.53', 1], ['149.154.175.50', 1],
  // gotd dials the whole 149.154.167.4x block for DC2 (observed: .41)
  ['149.154.167.51', 2], ['149.154.167.50', 2],
  ['149.154.167.40', 2], ['149.154.167.41', 2], ['149.154.167.42', 2], ['149.154.167.43', 2],
  ['149.154.167.44', 2], ['149.154.167.45', 2], ['149.154.167.46', 2],
  // DC2 IPv6 (observed in a DC2-first connection)
  ['2001:67c:4e8:f002::a', 2], ['2001067c04e8f002000000000000000a', 2],
  ['149.154.175.100', 3], ['149.154.175.109', 3],
  ['149.154.167.91', 4], ['149.154.167.90', 4],
  ['91.108.56.130', 5], ['91.108.56.135', 5],
]);
const unknownDcIps = new Set();
function dcIdFor(host) {
  const id = DC_IPS.get(String(host));
  if (id) return id;
  if (!unknownDcIps.has(host)) {
    unknownDcIps.add(host);
    console.warn(`[mtproto] 未知 DC 地址 ${host}，按 DC2 路由（如任务异常请反馈此地址）`);
  }
  return 2;
}

// ---- obfuscated handshake (shared by both modes) -----------------------------

function buildObfuscatedHeader(secret16, dcId) {
  const init = Buffer.alloc(56);
  do {
    crypto.randomFillSync(init);
    // must not collide with the plain transport headers the server sniffs
  } while ([0xef, 0xdd, 0xee, 0x16].includes(init[0]) ||
           init[4] === 0 && init[5] === 0 && init[6] === 0 && init[7] === 0);

  const sendKey = crypto.createHash('sha256').update(Buffer.concat([init.subarray(8, 40), secret16])).digest();
  const sendIv = Buffer.from(init.subarray(40, 56));

  const revKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) revKey[i] = init[55 - i];
  const recvKey = crypto.createHash('sha256').update(Buffer.concat([revKey, secret16])).digest();
  const recvIv = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) recvIv[i] = init[23 - i];

  const tail = Buffer.alloc(8);
  // transport tag inside the obfuscated header. "ee"=intermediate, "dd"=padded
  // (dd is what faketls/ee-secret deployments in the wild expect), "ef"=abridged.
  // MTPROTO_TAG overrides for experiments.
  const tag = { ee: 0xee, dd: 0xdd, ef: 0xef }[process.env.MTPROTO_TAG || 'dd'] || 0xdd;
  tail[0] = tail[1] = tail[2] = tail[3] = tag;
  tail.writeInt16LE(dcId, 4);
  crypto.randomFillSync(tail.subarray(6));

  // One CTR stream for the whole client->proxy direction: burn 56 keystream
  // bytes (header stays plaintext), encrypt the tail with bytes 56..64, then
  // the same cipher continues at offset 64 for the session data.
  const cipher = crypto.createCipheriv('aes-256-ctr', sendKey, sendIv);
  cipher.update(Buffer.alloc(56));
  const header = Buffer.concat([init, cipher.update(tail)]);
  const decipher = crypto.createDecipheriv('aes-256-ctr', recvKey, recvIv);
  return { header, cipher, decipher };
}

// ---- faketls (ee secrets) ----------------------------------------------------

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);

// TLS record header + payload. v3.3 like every faketls implementation.
function tlsRecord(type, payload) {
  return Buffer.concat([Buffer.from([type, 3, 3]), u16(payload.length), payload]);
}

// ClientHello whose random field authenticates us to the MTProto backend
// (ext.c:1141-1167). The HMAC covers the WHOLE record with random zeroed.
//
// Shape requirements distilled from ext.c + TDLib TlsInit.cpp:
//  * record length MUST be >= 512 bytes — `(packet_len >> 24) >= 2` is the
//    gate for the faketls branch, so the hello is padded to 517 bytes via a
//    padding extension exactly like TDLib does
//  * 32-byte session id (the server echoes it from offset 44)
//  * cipher suites starting with 0x13 0x01..0x03 after optional GREASE
//  * SNI = the secret domain; random = HMAC(secret, zeroed hello) with the
//    last 4 bytes XORed by the unix time in LITTLE-endian layout
function buildClientHello(secret16, domain) {
  const random = Buffer.alloc(32);
  const sessionId = crypto.randomBytes(32);
  const suites = Buffer.from([
    0x0a, 0x0a, // GREASE, skipped by the server's suite scanner
    0x13, 0x01, 0x13, 0x02, 0x13, 0x03,
    0xc0, 0x2b, 0xc0, 0x2f, 0xc0, 0x2c, 0xc0, 0x30, 0x00, 0x9c, 0x00, 0x9d, 0x00, 0x2f, 0x00, 0x35,
  ]);

  // SNI extension: [00 00][ext_len][list_len][type=0][name_len][name] — the
  // list-length prefix is mandatory; without it the server's SNI parser
  // fails and the connection is relayed to the camouflage domain.
  const name = Buffer.from(domain, 'ascii');
  const entry = Buffer.concat([Buffer.from([0x00]), u16(name.length), name]);
  const sniList = Buffer.concat([u16(entry.length), entry]);
  const sniExt = Buffer.concat([Buffer.from([0x00, 0x00]), u16(sniList.length), sniList]);

  const groups = Buffer.from([0x00, 0x1d, 0x00, 0x17, 0x00, 0x18]); // x25519 secp256r1 secp384r1
  const groupsList = Buffer.concat([u16(groups.length), groups]);
  const groupsExt = Buffer.concat([Buffer.from([0x00, 0x0a]), u16(groupsList.length), groupsList]);

  const sigs = Buffer.from([0x04, 0x03, 0x08, 0x04, 0x04, 0x01, 0x05, 0x03, 0x08, 0x05, 0x08, 0x05, 0x05, 0x01, 0x08, 0x06, 0x06, 0x01]);
  const sigsExt = Buffer.concat([Buffer.from([0x00, 0x0d]), u16(sigs.length), sigs]);

  const versions = Buffer.from([0x03, 0x04]); // TLS 1.3
  const versionsList = Buffer.concat([Buffer.from([0x02]), versions]);
  const versionsExt = Buffer.concat([Buffer.from([0x00, 0x2b]), u16(versionsList.length), versionsList]);

  const pskModes = Buffer.from([0x01]); // psk_dhe_ke
  const pskExt = Buffer.concat([Buffer.from([0x00, 0x2d]), u16(pskModes.length), pskModes]);

  // key_share with a REAL x25519 public key — the hello must survive a real
  // TLS parser if any fronting box peeks deeper than SNI
  let x25519 = Buffer.alloc(32);
  try {
    const { publicKey } = crypto.generateKeyPairSync('x25519');
    x25519 = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  } catch { /* keep zeros: the MTProto parsers do not validate the point */ }
  const ksEntry = Buffer.concat([Buffer.from([0x00, 0x1d]), u16(x25519.length), x25519]);
  const ksList = Buffer.concat([u16(ksEntry.length), ksEntry]);
  const keyShareExt = Buffer.concat([Buffer.from([0x00, 0x33]), u16(ksList.length), ksList]);

  const noPad = [sniExt, groupsExt, sigsExt, versionsExt, pskExt, keyShareExt];
  const base = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    random,
    Buffer.from([sessionId.length]),
    sessionId,
    u16(suites.length), suites,
    Buffer.from([0x01, 0x00]), // one compression method: null
    u16(noPad.reduce((s, e) => s + e.length, 0)),
    ...noPad.map((e) => e),
  ]);
  const hsLen = 4 + base.length;
  const recLen = 5 + hsLen;
  // padding extension (0x0015) so the whole record reaches 517 bytes
  const padNeeded = 517 - recLen - 4; // 4 = padding ext header
  const padding = padNeeded > 0
    ? Buffer.concat([Buffer.from([0x00, 0x15]), u16(padNeeded), Buffer.alloc(padNeeded)])
    : Buffer.alloc(0);
  const body2 = Buffer.concat([
    Buffer.from([0x03, 0x03]), random, Buffer.from([sessionId.length]), sessionId,
    u16(suites.length), suites, Buffer.from([0x01, 0x00]),
    u16(noPad.reduce((s, e) => s + e.length, 0) + padding.length),
    ...noPad.map((e) => e), padding,
  ]);
  // handshake header: type(1) + 24-bit BE length — exactly 4 bytes, no padding
  const bodyLen = body2.length;
  const hs2 = Buffer.concat([
    Buffer.from([0x01, (bodyLen >> 16) & 0xff, (bodyLen >> 8) & 0xff, bodyLen & 0xff]),
    body2,
  ]);
  const hello = Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs2.length), hs2]);
  if (hello.length < 513) throw new Error('ClientHello 太短，无法触发 faketls 分支');

  // random = mac[0:28] || mac[28:32] ^ time — patched after the MAC so
  // the digest covers the zeroed form exactly like the server recomputes it.
  // The 4 timestamp bytes are laid out LITTLE-endian: the reference server
  // reads them with a native *(int*) cast (ext.c:1164).
  const mac = crypto.createHmac('sha256', secret16).update(hello).digest(); // random is all-zero here
  mac.subarray(0, 28).copy(random, 0);
  const t = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 4; i++) random[28 + i] = mac[28 + i] ^ ((t >>> (8 * i)) & 0xff);
  random.copy(hello, 11); // record(5)+handshake(4)+version(2) = offset 11
  return hello;
}

// Stateful downlink parser is NOT needed: per the mtg reference the
// proxy→client direction is the raw CTR stream (no TLS records downlink).

// Wraps CTR output in application-data records (max 8KiB like real TLS).
class TlsFramer {
  constructor() { this.buf = Buffer.alloc(0); }
  wrap(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (this.buf.length >= 8192) {
      out.push(tlsRecord(0x17, this.buf.subarray(0, 8192)));
      this.buf = this.buf.subarray(8192);
    }
    if (this.buf.length) { out.push(tlsRecord(0x17, this.buf)); this.buf = Buffer.alloc(0); }
    return Buffer.concat(out);
  }
}

// Open one authenticated tunnel to the DC behind the proxy. Resolves with the
// socket + CTR streams once the proxy has ACCEPTED us (for faketls that is
// after the hello response arrived; plain mode accepts immediately).
function connectTunnel(link, dcId) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: link.server, port: link.port });
    const fail = (e) => { try { sock.destroy(); } catch { /* gone */ } reject(e); };
    sock.setTimeout(15000, () => fail(new Error('连接 MTProto 服务器超时')));
    sock.once('error', (e) => fail(e));
    sock.connecting || setImmediate(() => {});
    sock.once('connect', () => {
      sock.setTimeout(0);
      const tun = buildObfuscatedHeader(link.secret16, dcId);
      if (!link.domain) {
        sock.write(tun.header);
        resolve({ sock, tunnel: tun, tls: null });
        return;
      }
      // faketls: hello → WAIT for the complete 3-record response burst
      // (ServerHello + CCS + one junk app-data record) — it routinely arrives
      // across several TCP segments, and any leftover junk leaking into the
      // tunnel reads as garbage MTProto to the client. Only then send CCS +
      // the first record; sending early would also trip the server's "too
      // much data in ClientHello" check (ext.c:1132).
      sock.write(buildClientHello(link.secret16, link.domain));
      let burst = Buffer.alloc(0);
      const onHelloReply = (chunk) => {
        burst = Buffer.concat([burst, chunk]);
        // [16 rec 5+122][14 rec 5+1][17 rec 5+N]
        if (burst.length < 5) return;
        if (burst[0] !== 0x16) return failEarly('faketls 响应异常');
        let p = 5 + burst.readUInt16BE(3);
        if (burst.length < p + 6) return;
        if (burst[p] !== 0x14) return failEarly('faketls 缺少 CCS');
        p += 6;
        if (burst.length < p + 5) return;
        if (burst[p] !== 0x17) return failEarly('faketls 缺少应用数据记录');
        p += 5 + burst.readUInt16BE(p + 3);
        if (burst.length < p) return;
        sock.off('data', onHelloReply);
        sock.off('close', onEarlyClose);
        const first = Buffer.concat([
          Buffer.from([0x14, 3, 3, 0, 1, 0x01]),            // dummy ChangeCipherSpec
          tlsRecord(0x17, tun.header),                       // ≥64B, starts with the obfuscated header
        ]);
        sock.write(first);
        resolve({ sock, tunnel: tun, tls: true });
      };
      const failEarly = (msg) => {
        sock.off('data', onHelloReply);
        fail(new Error(msg));
      };
      const onEarlyClose = () => fail(new Error('faketls 握手被关闭（secret 或域名不符）'));
      sock.on('data', onHelloReply);
      sock.once('close', onEarlyClose);
    });
  });
}

// ---- bridge ------------------------------------------------------------------

const state = {
  server: null, port: 0, links: [], rr: 0,
  active: 0, total: 0, up: 0, down: 0,
  lastError: '', startedAt: 0,
};

function pickLink() {
  if (!state.links.length) return null;
  const link = state.links[state.rr % state.links.length];
  state.rr = (state.rr + 1) % Math.max(state.links.length, 1);
  return link;
}

function handleSocksClient(sock) {
  state.total++;
  let phase = 'greeting';
  let proxySock = null;
  let closed = false;
  // bytes the client sends while the tunnel is still being established —
  // gotd fires its first MTProto packet immediately after the CONNECT reply,
  // which is routinely BEFORE the faketls handshake finishes
  const pending = [];

  const fail = (msg) => {
    if (closed) return;
    state.lastError = msg;
    try { sock.destroy(); } catch { /* gone */ }
    if (proxySock) { try { proxySock.destroy(); } catch { /* gone */ } }
  };

  sock.on('error', () => fail('本地连接异常'));
  sock.on('close', () => {
    closed = true;
    if (state.active > 0) state.active--;
    if (proxySock) { try { proxySock.destroy(); } catch { /* gone */ } }
  });

  sock.on('data', (chunk) => {
    if (phase === 'greeting') {
      // [VER NMETHODS METHODS...]; we only offer NO AUTH
      if (chunk.length < 2 || chunk[0] !== 5) return fail('非 SOCKS5 握手');
      sock.write(Buffer.from([5, 0]));
      phase = 'request';
      if (chunk.length > 2 + chunk[1]) setImmediate(() => sock.unshift(chunk.subarray(2 + chunk[1])));
      return;
    }
    if (phase !== 'request') {
      if (phase === 'connecting') pending.push(chunk); // flushed once the tunnel is up
      return; // tunnel already owns the socket
    }

    if (chunk.length < 7 || chunk[0] !== 5 || chunk[1] !== 1) return fail('仅支持 SOCKS5 CONNECT');
    let host = '';
    let pos = 3;
    const atyp = chunk[pos++];
    if (atyp === 1) { host = [...chunk.subarray(pos, pos + 4)].join('.'); pos += 4; }
    else if (atyp === 3) { const n = chunk[pos++]; host = chunk.subarray(pos, pos + n).toString(); pos += n; }
    else if (atyp === 4) { host = chunk.subarray(pos, pos + 16).toString('hex'); pos += 16; }
    else return fail('SOCKS5 地址类型不支持');
    const port = chunk.readUInt16BE(pos);
    if (!port) return fail('SOCKS5 请求缺少端口');
    pos += 2;
    // gotd piggybacks its first MTProto bytes on the CONNECT request chunk —
    // every byte past the request belongs to the tunnel stream
    if (pos < chunk.length) pending.push(chunk.subarray(pos));

    const link = pickLink();
    if (!link) return fail('没有可用的 MTProto 链接');
    const dc = dcIdFor(host);
    phase = 'connecting';

    connectTunnel(link, dc).then(({ sock: ps, tunnel, tls }) => {
      proxySock = ps;
      dbg(`tunnel ${host}:${port} → ${link.server}:${link.port} dc=${dc}${tls ? ' (faketls)' : ''}`);
      // CONNECT success reply, then splice with the CTR transforms
      sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      state.active++;
      phase = 'tunnel';

      let sawC2P = false, sawP2C = false, sawPlain = false;
      // Framing is ASYMMETRIC per the mtg reference (proxy.go:218
      // tls.New(conn, read=true, write=false)): the client→proxy direction
      // rides in TLS application-data records, the proxy→client direction is
      // the RAW CTR-obfuscated stream.
      const framer = tls ? new TlsFramer() : null;
      const sendObf = (c) => {
        try {
          const enc = tunnel.cipher.update(c);
          ps.write(framer ? framer.wrap(enc) : enc);
        } catch { fail('加密流已关闭'); }
      };
      const onDownlink = (c) => {
        state.down += c.length;
        try {
          const plain = tunnel.decipher.update(c);
          if (!sawPlain) { sawPlain = true; dbg('downlink deciphered', plain.subarray(0, 32).toString('hex')); }
          sock.write(plain);
        } catch { fail('解密流已关闭'); }
      };

      sock.removeAllListeners('data');
      sock.on('data', (c) => {
        if (!sawC2P) { sawC2P = true; dbg('client→proxy first', c.subarray(0, 24).toString('hex')); }
        state.up += c.length;
        sendObf(c);
      });
      // anything the client sent during the handshake goes first, in order
      for (const c of pending) { state.up += c.length; sendObf(c); }
      pending.length = 0;
      ps.on('data', (c) => {
        if (!sawP2C) { sawP2C = true; dbg('proxy→client first', c.subarray(0, 24).toString('hex')); }
        onDownlink(c);
      });
      ps.on('error', (e) => { dbg('proxy err', e.message); fail('MTProto 服务器连接异常'); });
      ps.on('close', () => { dbg('proxy closed'); try { sock.destroy(); } catch { /* gone */ } });
    }).catch((e) => {
      dbg('tunnel fail', e.message);
      fail(`MTProto 隧道建立失败: ${e.message}`);
    });
  });
}

function startBridge(port, links) {
  return new Promise((resolve, reject) => {
    stopBridge();
    state.links = links;
    state.rr = 0;
    state.active = 0; state.total = 0; state.up = 0; state.down = 0;
    state.lastError = ''; state.port = port;
    const srv = net.createServer(handleSocksClient);
    srv.on('error', (e) => {
      state.server = null;
      reject(new Error(`桥接端口 ${port} 监听失败: ${e.message}`));
    });
    srv.listen(port, '127.0.0.1', () => {
      state.server = srv;
      state.startedAt = Date.now();
      resolve();
    });
  });
}

function stopBridge() {
  if (state.server) {
    try { state.server.close(); } catch { /* gone */ }
    state.server = null;
  }
}

function stats() {
  return {
    running: !!state.server, port: state.port, links: state.links.length,
    active: state.active, total: state.total,
    up: state.up, down: state.down, lastError: state.lastError,
    startedAt: state.startedAt,
  };
}

// ---- connectivity probe ------------------------------------------------------

// Full handshake probe: for faketls links this goes through hello + CCS, so
// a wrong secret really is refused (the backend closes; only the fronting
// relay keeps the socket by handing us to the camouflage domain, and that
// shows up as no MTProto response). "ok" = the tunnel got established.
function testLink(link, watchMs = 2500) {
  const t0 = Date.now();
  return connectTunnel(link, 2).then(({ sock }) => new Promise((resolve) => {
    const connectMs = Date.now() - t0;
    let settled = false;
    const done = (ok, note) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* gone */ }
      resolve({ ok, connectMs, note });
    };
    sock.on('error', (e) => done(false, e.message));
    sock.on('close', () => done(false, '连接被代理关闭（secret 错误，或代理无法连接 Telegram）'));
    setTimeout(() => done(true, link.domain ? '握手通过（代理可达；实际速度取决于代理到 Telegram 的线路）' : '握手未被拒绝'), watchMs);
  })).catch((e) => ({ ok: false, connectMs: Date.now() - t0, note: e.message }));
}

module.exports = { parseLink, parseLinks, startBridge, stopBridge, stats, testLink, _buildClientHello: buildClientHello };
