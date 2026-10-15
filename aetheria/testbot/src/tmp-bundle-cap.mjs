// tmp-bundle-cap.mjs — how does the game CLIENT render/answer the image-match captcha? (safe to delete)
import fs from 'node:fs';
const b = fs.readFileSync(process.env.TEMP + '/aetheria-bundle.js', 'utf8');
for (const p of ['เหมือนกับรูปในกรอบ', 'human_check_answer', 'answerHumanCheck']) {
  const idx = [];
  let i = b.indexOf(p);
  while (i >= 0 && idx.length < 4) { idx.push(i); i = b.indexOf(p, i + 1); }
  console.log('===== ' + p + ' (' + idx.length + ') =====');
  for (const j of idx) {
    console.log(b.slice(Math.max(0, j - 700), j + 700).replace(/\n/g, ' '));
    console.log('-----');
  }
}
