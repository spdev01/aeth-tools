// tmp-bundle-probe.mjs — dump contexts around key terms in the game bundle (safe to delete)
import fs from 'fs';
const f = process.env.TEMP + '\\aetheria-bundle.js';
const s = fs.readFileSync(f, 'utf8');
const pats = ['answerHumanCheck', 'humanCheck', 'items/', '.webp', '.png', 'items.json', 'itemData', 'ItemData', 'icon'];
for (const p of pats) {
  let i = -1, n = 0;
  console.log(`\n===== ${p} =====`);
  while ((i = s.indexOf(p, i + 1)) !== -1) {
    n++;
    if (n <= 10) console.log('@', i, '::', JSON.stringify(s.slice(Math.max(0, i - 130), i + 170)));
  }
  console.log('total:', n);
}
