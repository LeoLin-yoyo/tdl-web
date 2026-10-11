// Dev check for lib/resolve.js: resolve real links and print what the download
// page would show. Uses the isolated session copy, so it is safe to run while
// the GUI (and its downloads) are live.
//
// Run: node gui/tools/resolve-harness.cjs <link> [link...]
const resolve = require('../lib/resolve');

(async () => {
  const text = process.argv.slice(2).join('\n');
  const r = await resolve.resolve(text);
  console.log('total =', r.total, 'trivial =', r.trivial, 'unparsed =', r.unparsed);
  for (const g of r.links) {
    console.log(`\n[link] ${g.link}  grouped=${!!g.grouped} ${g.note ? 'note=' + g.note : ''} ${g.error ? 'ERROR=' + g.error : ''}`);
    for (const x of g.resources) console.log(`   ${x.msgId}  ${x.size}\t${x.name}\t${x.link}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
