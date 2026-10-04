// find how the auto config stores skills (editor code in bundle)
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
// scan a broad region around the auto editor (~2290000-2325000)
const start = 2285000, end = 2328000;
let pos = start, n = 0;
while ((pos = c.indexOf('skills', pos)) >= 0 && pos < end && n < 24) {
  const ctx = c.substring(Math.max(0, pos - 220), pos + 260).replace(/\s+/g, ' ');
  if (/auto|skill(s)?\s*[:=]|toggle|maxLevel|learnMaxLevel/.test(ctx)) {
    console.log(`\n#${n} @ ${pos}:`);
    console.log(ctx);
    n++;
  }
  pos += 6;
}
console.log('\n=== search: auto-specific field mutations ===');
for (const m of ['skills: e', 'skills:e', 'skills: [', 'skills:[', 'useSkills', 'skillSet']) {
  let p = start; let k = 0;
  while ((p = c.indexOf(m, p)) >= 0 && p < end && k < 5) {
    console.log(`\n-- "${m}" @ ${p}:`, c.substring(Math.max(0, p - 260), p + 300).replace(/\s+/g, ' '));
    p += 4; k++;
  }
}
