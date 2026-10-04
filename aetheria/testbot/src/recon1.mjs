// Bundle recon — all string searches in Node (UTF-8 safe).
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const probes = [
  'startRoute', 'route', 'huntRadiusTiles', 'คัดมอน', 'monsters',
  'op:`search`', 'mk-filters', 'data-travel', 'travelTo', 'enterMap',
];
const show = (m, back = 260, len = 760) => {
  const i = c.indexOf(m);
  console.log(`=== ${m} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
};
show('เดินทางไป');
show('startRoute', 300, 900);
show('travelTo', 300, 700);
show('enterMap', 300, 700);
show('huntRadiusTiles', 300, 1100);
show('op:`search`', 300, 900);

// catalog skills: two-hand / quicken
const cat = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/testbot/out/skill-catalog.json', 'utf8'));
console.log('=== catalog two-hand/quicken ===');
for (const s of cat.skills) if (/quicken|two|hand/i.test(s.id)) console.log(s.id, '|', s.classId, '|', s.name, '| max', s.maxLevel);
console.log('=== knight skills ===');
for (const s of cat.skills) if (s.classId === 'knight') console.log(s.id, '|', s.name, '|', s.kind, '| max', s.maxLevel);
