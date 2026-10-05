// check knight skill prerequisites in the catalog
import fs from 'node:fs';
const cat = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/testbot/out/skill-catalog.json', 'utf8'));
const arr = cat.skills ?? cat;
for (const id of ['bowling-bash', 'two-hand-quicken', 'peco-peco-ride', 'peco-peco-master', 'two-hand-sword-mastery', 'magnum-break', 'provoke', 'bash', 'sword-mastery']) {
  const s = arr.find((x) => x.id === id);
  if (!s) { console.log(id, ': NOT IN CATALOG'); continue; }
  console.log(JSON.stringify({ id: s.id, classId: s.classId, max: s.learnMaxLevel, prereq: s.prerequisites, requiresBaseLevel: s.requiresBaseLevel, spCost: s.spCost }));
}
