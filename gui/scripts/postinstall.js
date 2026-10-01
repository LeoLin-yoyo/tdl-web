// node-pty ships prebuilt binaries under prebuilds/<platform>/ but its install
// script may be blocked by npm allow-scripts policies. Copy them into place.
const fs = require('node:fs');
const path = require('node:path');

const platformDir = `win32-x64`; // this GUI targets Windows (tdl.exe)
const src = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', platformDir);
const dst = path.join(__dirname, '..', 'node_modules', 'node-pty', 'build', 'Release');

if (!fs.existsSync(src)) {
  console.log(`[postinstall] no prebuilds for ${platformDir}, skipping (native build may be required)`);
  process.exit(0);
}
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (f.endsWith('.node')) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
    console.log(`[postinstall] copied ${f}`);
  }
}
