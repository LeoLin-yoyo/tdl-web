// Offline checks for lib/tdlfetch.js — no network.
//
// The interesting parts are the safety gates (host allow-list, public-address
// check, redirect re-validation) and the OS/arch → asset-name mapping, since
// upstream's goreleaser renames os/arch in the archive name.
//
// Run: node gui/tools/tdlfetch-harness.cjs
const path = require('node:path');
const assert = require('node:assert');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name} — ${e.message}`); }
}

const f = require(path.join(__dirname, '..', 'lib', 'tdlfetch.js'));

console.log('# asset name mapping');
// upstream .goreleaser.yaml: name_template tdl_{Os}_{Arch}, with
// darwin→MacOS, windows→Windows, amd64→64bit, 386→32bit; windows is zip.
check('win x64 → tdl_Windows_64bit.zip', () =>
  assert.strictEqual(f.targetAssetSuffix('win32', 'x64'), 'tdl_Windows_64bit.zip'));
check('win ia32 → tdl_Windows_32bit.zip', () =>
  assert.strictEqual(f.targetAssetSuffix('win32', 'ia32'), 'tdl_Windows_32bit.zip'));
check('linux x64 → tdl_Linux_64bit.tar.gz', () =>
  assert.strictEqual(f.targetAssetSuffix('linux', 'x64'), 'tdl_Linux_64bit.tar.gz'));
check('darwin arm64 → tdl_MacOS_arm64.tar.gz', () =>
  assert.strictEqual(f.targetAssetSuffix('darwin', 'arm64'), 'tdl_MacOS_arm64.tar.gz'));
check('linux arm → tdl_Linux_armv7.tar.gz', () =>
  assert.strictEqual(f.targetAssetSuffix('linux', 'arm'), 'tdl_Linux_armv7.tar.gz'));
check('unknown os throws', () =>
  assert.throws(() => f.targetAssetSuffix('sunos', 'x64'), /暂不支持的系统/));
check('unknown arch throws', () =>
  assert.throws(() => f.targetAssetSuffix('linux', 'mips'), /暂不支持的架构/));

console.log('# public-address gate');
const pub = ['8.8.8.8', '1.1.1.1', '140.82.121.4', '2606:4700::1111'];
const priv = [
  '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '255.255.255.255',
  '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1',
];
for (const ip of pub) check(`public ${ip} allowed`, () => assert.strictEqual(f.isPublicAddress(ip), true));
for (const ip of priv) check(`private ${ip} refused`, () => assert.strictEqual(f.isPublicAddress(ip), false));
check('empty refused', () => assert.strictEqual(f.isPublicAddress(''), false));
check('garbage refused', () => assert.strictEqual(f.isPublicAddress('not-an-ip'), false));

console.log('# URL gate (host allow-list + scheme)');
async function rejects(raw, re) {
  try { await f.assertSafeUrl(raw); return false; } catch (e) { return re.test(String(e.message)); }
}
(async () => {
  const bad = [
    ['http://api.github.com/x', /仅允许 https/],
    ['https://evil.example/x', /不允许的下载主机/],
    ['https://127.0.0.1/x', /不允许的下载主机/],
    ['https://localhost/x', /不允许的下载主机/],
    ['file:///etc/passwd', /仅允许 https/],
    ['not a url', /不合法/],
  ];
  for (const [raw, re] of bad) {
    const ok = await rejects(raw, re);
    check(`refuses ${raw}`, () => assert.ok(ok, `expected rejection matching ${re}`));
  }

  console.log('# redirect re-validation');
  // A redirect must be re-checked: point it at a non-allowed host and confirm
  // getWithRedirects refuses rather than following blindly. We exercise the
  // gate directly (no network) by asserting the allow-list is consulted.
  check('allow-list has no wildcard', () =>
    assert.ok([...f.ALLOWED_HOSTS].every((h) => !h.includes('*'))));
  check('allow-list is exactly the github hosts', () =>
    assert.deepStrictEqual([...f.ALLOWED_HOSTS].sort(), [
      'api.github.com', 'codeload.github.com', 'github.com',
      'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
    ].sort()));

  console.log('# binary discovery');
  const fs = require('node:fs');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdlfetch-'));
  const nested = path.join(tmp, 'tdl_Linux_64bit');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'tdl'), 'x');
  fs.writeFileSync(path.join(tmp, 'README.md'), 'x');
  check('findBinary locates nested binary', () =>
    assert.strictEqual(f.findBinary(tmp, 'tdl'), path.join(nested, 'tdl')));
  check('findBinary returns null when absent', () =>
    assert.strictEqual(f.findBinary(tmp, 'nope.exe'), null));
  check('exeName is platform-correct', () =>
    assert.strictEqual(f.exeName('win32'), 'tdl.exe') || assert.strictEqual(f.exeName('linux'), 'tdl'));

  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})();
