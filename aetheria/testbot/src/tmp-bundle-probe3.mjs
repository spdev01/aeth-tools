// tmp-bundle-probe3.mjs — deviceId & new-flow forensics in old vs new bundle (safe to delete)
import fs from 'fs';
const oldF = 'E:/GitHub/lumivaraonline/aetheria/index-main.js';
const newF = process.env.TEMP + '\\aetheria-bundle.js';
const A = fs.existsSync(oldF) ? fs.readFileSync(oldF, 'utf8') : '';
const B = fs.readFileSync(newF, 'utf8');
const show = (label, src, pat, ctx = 200, max = 6) => {
  let i = -1, n = 0;
  console.log(`\n===== ${label}: "${pat}" =====`);
  while ((i = src.indexOf(pat, i + 1)) !== -1) { n++; if (n <= max) console.log('@', i, '::', JSON.stringify(src.slice(Math.max(0, i - ctx), i + ctx))); }
  console.log('count:', n);
};
for (const [label, src] of [['OLD', A], ['NEW', B]]) {
  show(label, src, 'deviceId');
  show(label, src, 'aetheria.device', 140);
}
show('NEW', B, 'suspect', 150);
show('NEW', B, 'joinById', 260);
for (const [label, src] of [['OLD', A], ['NEW', B]]) show(label, src, 'inspect_privacy', 160);
for (const [label, src] of [['OLD', A], ['NEW', B]]) show(label, src, 'gm_panel', 120, 3);
