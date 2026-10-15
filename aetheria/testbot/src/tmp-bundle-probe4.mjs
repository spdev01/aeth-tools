// tmp-bundle-probe4.mjs — remaining login/session-flow diffs old vs new (safe to delete)
import fs from 'fs';
const oldF = 'E:/GitHub/lumivaraonline/aetheria/index-main.js';
const newF = process.env.TEMP + '\\aetheria-bundle.js';
const A = fs.existsSync(oldF) ? fs.readFileSync(oldF, 'utf8') : '';
const B = fs.readFileSync(newF, 'utf8');
const show = (label, src, pat, ctx = 220, max = 5) => {
  let i = -1, n = 0;
  console.log(`\n===== ${label}: "${pat}" =====`);
  while ((i = src.indexOf(pat, i + 1)) !== -1) { n++; if (n <= max) console.log('@', i, '::', JSON.stringify(src.slice(Math.max(0, i - ctx), i + ctx))); }
  console.log('count:', n);
};
show('NEW', B, 'auto_assist', 240);
show('NEW', B, '`/characters`', 240);
show('NEW', B, '/auth/', 200, 3);
show('NEW', B, 'x-request', 160);
show('NEW', B, 'zstd', 140, 3);
show('OLD', A, 'zstd', 140, 3);
show('NEW', B, 'onMessage(`welcome', 160, 2);
show('NEW', B, 'suspects', 120, 2);
