// Find privacy/inspect-related needles in game bundles (Thai literals live here so the terminal never passes them).
import fs from 'node:fs';
const NEEDLES = ['ตรวจสอบอุปกรณ์', 'สเตตัสของฉัน', 'ให้ผู้เล่นอื่น', 'inspectable', 'privacy', 'inspect'];
for (const file of process.argv.slice(2)) {
  let t; try { t = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('skip ' + file + ': ' + String(e.message)); continue; }
  console.log('##### ' + file + ' len=' + t.length);
  for (const needle of NEEDLES) {
    let i = -1; const hits = [];
    while ((i = t.indexOf(needle, i + 1)) !== -1 && hits.length < 6) hits.push(i);
    if (!hits.length) continue;
    console.log('=== "' + needle + '" x' + hits.length);
    for (const h of hits.slice(0, 3)) console.log('  @' + h + ': ' + t.slice(Math.max(0, h - 320), h + 420).replace(/\s+/g, ' '));
  }
}
