// mtproto-harness: measure real download throughput through the MTProto bridge.
//
// Usage (links/urls come from the environment — no credentials in source):
//   MTPROTO_LINKS="https://t.me/proxy?...,https://t.me/proxy?..." \
//   TEST_URL="https://t.me/<channel>/<msg>" SECONDS=30 node tools/mtproto-harness.cjs
// Negative-control mode (a corrupted secret must FAIL, proving the handshake
// crypto is really validated by the proxy):
//   CORRUPT_SECRET=1 node tools/mtproto-harness.cjs ...
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const mtproto = require('../lib/mtproto');

const PORT = Number(process.env.PORT) || 18565;
const SECONDS = Number(process.env.SECONDS) || 30;
const TEST_URL = process.env.TEST_URL || 'https://t.me/FanRenXiuXianZhuan_TRJ/419';

function findTdl() {
  const cands = [
    process.env.TDL_BIN,
    path.join(__dirname, '..', 'tdl', 'tdl.exe'),
    path.join(__dirname, '..', '..', 'tdl_Windows_64bit', 'tdl.exe'),
    'tdl',
  ].filter(Boolean);
  for (const c of cands) {
    if (c === 'tdl') return c;
    try { if (fs.existsSync(c)) return c; } catch { /* next */ }
  }
  throw new Error('tdl.exe not found');
}

function fmtMB(n) { return (n / 1048576).toFixed(1); }

async function main() {
  const rawLinks = String(process.env.MTPROTO_LINKS || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  if (!rawLinks.length) { console.error('MTPROTO_LINKS env is required'); process.exit(2); }
  const links = rawLinks.map((l) => mtproto.parseLink(l)); // throws on bad input
  if (process.env.CORRUPT_SECRET) {
    for (const l of links) l.secret16[3] ^= 0xa5; // break the key, keep the shape
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtp-harness-'));
  const tdlBin = findTdl();

  await mtproto.startBridge(PORT, links);
  console.log(`bridge on socks5://127.0.0.1:${PORT} (${links.length} link(s)) → tdl: ${tdlBin}`);

  const args = [
    `--proxy`, `socks5://127.0.0.1:${PORT}`,
    '--ns', 'default',
    '--reconnect-timeout', '60s',
    'dl', '-u', TEST_URL,
    '--dir', tmp,
    '--storage', `path=${tmp.replace(/\\/g, '/')},type=bolt`,
    '--threads', process.env.THREADS || '26',
  ];
  const t0 = Date.now();
  const child = spawn(tdlBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let tdlErr = '';
  child.stdout.on('data', (c) => { const s = c.toString(); if (/error|fail|Error/i.test(s)) tdlErr += s.slice(0, 300); });
  child.stderr.on('data', (c) => { tdlErr += c.toString().slice(0, 300); });

  const started = Date.now();
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  child.kill('SIGINT');
  await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
  const st = mtproto.stats();
  const secs = (Date.now() - started) / 1000;

  console.log('--- result ---');
  console.log(`elapsed: ${secs.toFixed(1)}s`);
  console.log(`bridge: conns=${st.total} active(at end)=${st.active} up=${st.up}B down=${st.down}B`);
  console.log(`throughput (down): ${fmtMB(st.down / secs)} MB/s`);
  if (st.lastError) console.log(`last bridge error: ${st.lastError}`);
  if (tdlErr.trim()) console.log(`tdl stderr: ${tdlErr.trim().slice(0, 400)}`);
  console.log(process.env.CORRUPT_SECRET
    ? (st.down > 0 ? 'UNEXPECTED: data flowed with a corrupted secret!' : 'negative control OK: no data with corrupted secret')
    : '');
  mtproto.stopBridge();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
