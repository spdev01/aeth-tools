// tmp-bundle-cap2.mjs — find the image-match captcha renderer (uses `image` field) + pick semantics.
import fs from 'node:fs';
const b = fs.readFileSync(process.env.TEMP + '/aetheria-bundle.js', 'utf8');
for (const p of ['human-check', 'humanCheck', 'human-check-image', 'ตรวจสอบ']) {
  const idx = [];
  let i = b.indexOf(p);
  while (i >= 0 && idx.length < 6) { idx.push(i); i = b.indexOf(p, i + 1); }
  console.log('===== ' + p + ' (' + idx.length + ' shown) =====');
  for (const j of idx) {
    const ctx = b.slice(Math.max(0, j - 500), j + 500).replace(/\n/g, ' ');
    if (/image|grid|pick|answerHumanCheck/.test(ctx)) console.log(ctx + '\n-----');
  }
}
