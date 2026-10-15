// tmp-build-leaks.mjs — assemble wiki/leaks.json from the leak hunt + wiki data.
import fs from 'node:fs';
const R = 'E:/GitHub/lumivaraonline/aetheria/recon';
const W = 'E:/GitHub/lumivaraonline/aetheria/wiki';
const hunt = JSON.parse(fs.readFileSync(R + '/leak-hunt.json', 'utf8'));
const wiki = JSON.parse(fs.readFileSync(R + '/wiki-data-2026-10-15.json', 'utf8'));

const pretty = (slug) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
  .replace(/\bOf\b/g, 'of').replace(/\bThe\b/g, 'the');

const leaks = {
  generatedAt: new Date().toISOString(),
  worlds: [
    { world: 2, name: 'ทวีปหยกโบราณ · Ancient Jade Continent', status: 'In development', img: 'assets/art/world/atlas-world2.webp' },
    { world: 3, name: 'อาณาจักรฟ้าแตก · Shattered Sky Kingdom', status: 'Coming soon', img: 'assets/art/world/atlas-world3.webp' },
    { world: 4, name: 'แดนปีศาจ · Demon Realm', status: 'Future', img: 'assets/art/world/atlas-world4.webp' },
  ],
  unreleasedMonsters: hunt.manOnly.map((m) => ({ id: m.id, name: m.name, thumb: `assets/thumbs/leaks/${m.id}.webp` })),
  cutItemIcons: hunt.orphanItemIcons.map((rel) => {
    const slug = rel.replace('items/', '').replace('.webp', '');
    return { slug, name: pretty(slug), icon: 'assets/art/icons/' + rel };
  }),
  unopenedClasses: [
    'paladin', 'revenant', 'stormweaver', 'frost-sage', 'sniper', 'high-priest', 'champion',
    'whitesmith', 'creator', 'assassin-cross', 'stalker', 'draken-paladin',
  ].map((id) => ({ id, name: pretty(id), face: `assets/art/classes/${id}-face.webp` })),
  inProgressClass: { id: 'dragon-knight', name: 'Dragon Knight', face: 'assets/art/classes/dragon-knight-face.webp', skills: 1 },
  bosses: [
    { id: 9040, name: 'Orc Warlord', level: 70 }, { id: 9041, name: 'Goblin Chieftain Grukk', level: 58 },
    { id: 9042, name: 'Prismatic Golem', level: 85 }, { id: 9044, name: 'Thalassa, Kraken Queen', level: 95 },
    { id: 9045, name: 'Morvath, the Lich King', level: 105 }, { id: 9046, name: 'Nekh-Amun, the Pharaoh', level: 135 },
  ].map((b) => ({ ...b, img: `assets/art/bosses/${b.id}.webp` })),
  iconlessSkills: (hunt.skillNoIcon ?? []).map((s) => {
    const [id, name] = s.split(' (');
    const ws = (wiki.skills ?? []).find((x) => x.id === id) ?? {};
    return { id, name: (name ?? '').replace(')', ''), classId: ws.classId, maxLevel: ws.maxLevel };
  }),
  spiritOrphans: hunt.spiritOrphans,
  roDb: { count: hunt.roOnlyCount, sample: hunt.roOnlySample },
  teases: [
    'Rune Stones (ศิลาปลุกพลัง) — full preview UI in the client: “Preview · not open yet”. 516 stone items already exist in the data (Chain / Fork / Piercing / …).',
    'World 2 Ancient Jade Continent — “In development” (map art complete).',
    'World 3 Shattered Sky Kingdom — “Coming soon”.',
    'World 4 Demon Realm — “Future content”.',
    'Class browser ships with unopened classes — “Not playable yet — being designed” (12 classes have art + 0 skills; Dragon Knight is in progress with 1 skill).',
    'Daily guild quests — “in progress, coming soon”. Guild shop — “not open yet”, donations accrue as points.',
    'Top-up (เติมเงิน) — “opens soon”.',
    'High-level monster land — “coming soon”.',
  ],
};
fs.writeFileSync(W + '/leaks.json', JSON.stringify(leaks, null, 1));
console.log('leaks.json written:', {
  worlds: leaks.worlds.length, monsters: leaks.unreleasedMonsters.length, cutIcons: leaks.cutItemIcons.length,
  classes: leaks.unopenedClasses.length + 1, bosses: leaks.bosses.length, skills: leaks.iconlessSkills.length, teases: leaks.teases.length,
});
