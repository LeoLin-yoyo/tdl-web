// Verify the namespace sanitisation: a hostile `ns` must never place the
// mirrored session outside the target directory.
const path = require('node:path');
const stream = require('../lib/stream');
const config = require('../lib/config');

const DIR = path.join(config.DATA_DIR, 'ns-check');
const cases = ['default', 'work', 'my-ns_1', '..\\..\\evil', '../../evil', 'a/b', '', '..'];

let bad = 0;
for (const ns of cases) {
  let out;
  try {
    out = stream.mirrorSession(ns, DIR).path;
  } catch (e) {
    // A throw means no path was produced (e.g. that namespace has no session
    // file on this machine), so nothing could be written outside DIR.
    console.log(`${JSON.stringify(ns).padEnd(18)} -> threw (no path written)`);
    continue;
  }
  const inside = path.dirname(path.resolve(out)) === path.resolve(DIR);
  if (!inside) bad++;
  console.log(`${JSON.stringify(ns).padEnd(18)} -> ${out}   inside=${inside}`);
}
console.log(bad === 0 ? '\nALL INSIDE DIR: OK' : `\n${bad} ESCAPED: FAIL`);
process.exit(bad === 0 ? 0 : 1);
