// One-off dev check: prove the stream-namespace session copy works.
// Step 1: `tdl migrate --to type=bolt,path=<gui>/data/stream-ns` (auto-answer the y/N prompt)
// Step 2: `tdl chat ls -n default --storage path=<gui>/data/stream-ns` must list chats.
// Run: node gui/tools/check-stream-ns.cjs
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const GUI_ROOT = path.resolve(__dirname, '..');
const STREAM_DIR = path.join(GUI_ROOT, 'data', 'stream-ns').replace(/\\/g, '/');

async function main() {
  global.TDL_PATH = path.resolve(GUI_ROOT, '..', 'tdl_Windows_64bit', 'tdl.exe');
  const tdlDir = path.dirname(global.TDL_PATH);
  if (!process.env.PATH.includes(tdlDir)) process.env.PATH = `${tdlDir}${path.delimiter}${process.env.PATH}`;
  const tdl = require('../lib/tdl');
  const proxy = JSON.parse(fs.readFileSync(path.join(GUI_ROOT, 'data', 'gui-config.json'), 'utf8')).proxy;

  fs.rmSync(STREAM_DIR, { recursive: true, force: true });
  fs.mkdirSync(STREAM_DIR, { recursive: true });

  // step 1: migrate every namespace into the stream storage dir
  const migrateArgs = ['migrate', '--to', `type=bolt,path=${STREAM_DIR}`];
  console.log(`$ tdl ${migrateArgs.join(' ')}`);
  const mig = await new Promise((resolve) => {
    const h = tdl.startTdl(migrateArgs, {});
    let out = '';
    h.onChunk((chunk) => {
      out += chunk;
      if (/continue\?/i.test(out)) { try { h.write('y\r'); } catch { /* once */ } }
    });
    h.onLine((l) => console.log(`  [migrate] ${l}`));
    h.exit.then(({ exitCode }) => resolve({ exitCode, out }));
  });
  console.log(`migrate exit=${mig.exitCode}`);
  if (mig.exitCode !== 0) { console.log(mig.out.slice(-800)); return; }
  console.log('stream dir now:', fs.readdirSync(STREAM_DIR).join(', '));

  // step 2: the migrated copy must authorize in its own storage dir
  const lsArgs = [
    'chat', 'ls', '-o', 'json',
    '--proxy', proxy,
    '--ns', 'default',
    '--storage', `path=${STREAM_DIR},type=bolt`,
  ];
  console.log(`$ tdl ${lsArgs.join(' ')}`);
  const res = await tdl.collect(lsArgs, { timeoutMs: 120000 });
  console.log(`chat ls exit=${res.exitCode} timedOut=${res.timedOut}`);
  const out = res.stdout || '';
  const start = out.indexOf('[');
  if (res.exitCode === 0 && start !== -1) {
    const data = JSON.parse(out.slice(start, out.lastIndexOf(']') + 1));
    console.log(`OK: session recognized, ${data.length} chat(s) listed; first = ${JSON.stringify(data[0] && data[0].name)}`);
  } else {
    console.log('FAILED:', out.slice(0, 800));
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
