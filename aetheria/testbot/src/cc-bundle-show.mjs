// Print code regions from the game bundle for analysis
import fs from 'node:fs';
const t = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (needle, w) => {
  const i = t.indexOf(needle);
  if (i < 0) { console.log('NOT FOUND:', needle); return; }
  console.log('=== ' + needle + ' @' + i + ' ===');
  console.log(t.slice(Math.max(0, i - w), i + w));
  console.log();
};
show('death-overlay', 1700);
show('autoReleaseSeconds??0', 900);
