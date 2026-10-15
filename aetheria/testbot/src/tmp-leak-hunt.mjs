// tmp-leak-hunt.mjs — datamine the live game for leaked/unreleased content.
// 1) diffs: monsters/items/skills/spirits manifests vs live wiki-data
// 2) probes: unreleased card art, boss art, loading screens, extra manifests (gacha/title/events)
// 3) bundle teases ("เร็วๆ นี้" = coming soon) → recon/leak-hunt.json + console report
import fs from 'node:fs';
const BASE = 'https://www.aetheria-online.in.th';
const R = 'E:/GitHub/lumivaraonline/aetheria/recon';
const out = [];
const p = (s) => { out.push(s); console.log(s); };
const jget = async (u) => { try { const r = await fetch(u); if (!r.ok) return null; return r.json(); } catch { return null; } };

const wiki = JSON.parse(fs.readFileSync(R + '/wiki-data-2026-10-15.json', 'utf8'));
const ico = JSON.parse(fs.readFileSync(R + '/manifest-icons.json', 'utf8'));
const mon = JSON.parse(fs.readFileSync(R + '/manifest-monsters.json', 'utf8'));
const cls = JSON.parse(fs.readFileSync(R + '/manifest-classes.json', 'utf8'));
const spr = JSON.parse(fs.readFileSync(R + '/manifest-spirits.json', 'utf8'));

p('=== 1. MONSTERS: manifest vs live ===');
const liveMon = new Map(wiki.monsters.map((m) => [String(m.id), m]));
const manOnly = Object.entries(mon).filter(([id]) => !liveMon.has(id));
const liveOnly = [...liveMon.keys()].filter((id) => !mon[id]);
p(`manifest=${Object.keys(mon).length} live=${liveMon.size} | art-without-data=${manOnly.length} data-without-art=${liveOnly.length}`);
for (const [id, m] of manOnly) p(`   [art only] #${id} "${m.name}" file=${m.file} sheetHeight=${m.sheetHeight}`);
for (const id of liveOnly) p(`   [data only] #${id} "${liveMon.get(id).name}"`);

p('\n=== 2. ITEM ICONS: itemKeys slugs vs live items ===');
const liveIconRel = new Set(wiki.items.map((i) => ico.items?.[String(i.id)]).filter(Boolean));
const keyRels = new Set(Object.values(ico.itemKeys ?? {}));
const orphanKeys = [...keyRels].filter((r) => !liveIconRel.has(r));
p(`itemKeys icons not referenced by any live item: ${orphanKeys.length}`);
for (const r of orphanKeys.slice(0, 60)) p('   ' + r);

p('\n=== 3. SKILL ICONS vs live skills ===');
const liveSkillIds = new Set(wiki.skills.map((s) => String(s.id)));
const skillIconOnly = Object.keys(ico.skills ?? {}).filter((k) => !liveSkillIds.has(k));
const skillNoIcon = wiki.skills.filter((s) => !ico.skills?.[String(s.id)]).map((s) => `${s.id} (${s.name})`);
p(`icons=${Object.keys(ico.skills ?? {}).length} live=${liveSkillIds.size} | icon-without-skill=${skillIconOnly.length} skill-without-icon=${skillNoIcon.length}`);
for (const k of skillIconOnly) p('   [icon only] ' + k);
for (const k of skillNoIcon) p('   [no icon] ' + k);

p('\n=== 4. SPIRITS (pets) vs bag items ===');
const bagItems = wiki.items.filter((i) => /^bag-/.test(ico.items?.[String(i.id)] ?? '') || /bag/i.test(ico.items?.[String(i.id)] ?? ''));
const spiritKeys = new Set(Object.keys(spr));
const bagSlugs = new Set(wiki.items.map((i) => (ico.items?.[String(i.id)] ?? '').replace('items/', '').replace('.webp', '')).filter((s) => s.startsWith('bag-')));
const spiritOrphans = [...spiritKeys].filter((k) => !bagSlugs.has(k));
p(`spirits=${spiritKeys.size} live bag slugs=${bagSlugs.size} | spirit-without-bag=${spiritOrphans.length}`);
for (const k of spiritOrphans) p('   [spirit only] ' + k);

p('\n=== 5. Ragnarok item set (imported RO database) ===');
const liveIds = new Set(wiki.items.map((i) => String(i.id)));
const roOnly = (wiki.ragnarokItems ?? []).filter((i) => !liveIds.has(String(i.id)));
p(`ragnarokItems=${wiki.ragnarokItems?.length ?? 0} not-in-live=${roOnly.length}`);
p('   sample: ' + roOnly.slice(0, 25).map((i) => `${i.id} ${i.name}`).join(' · '));

p('\n=== 6. UNRELEASED / EXTRA ART PROBES ===');
// card art beyond live card ids
const liveCardIds = new Set(wiki.items.filter((i) => i.type === 'Card').map((i) => String(i.id)));
const extraCards = [];
for (let id = 94000; id <= 94200; id++) {
  const r = await fetch(`${BASE}/art/cards/${id}.webp`, { method: 'HEAD' });
  if (r.ok && !liveCardIds.has(String(id))) extraCards.push(id);
}
p(`card art in 94000-94200 not tied to live card items: ${extraCards.length}`);
if (extraCards.length) p('   ids: ' + extraCards.join(', '));
// boss art for known + unreleased monster ids
const bossIds = [
  ...manOnly.map(([id]) => id),
  ...wiki.monsters.filter((m) => /Thalassa|Morvath|Nekh|Warlord|Grukk|Golem/i.test(m.name)).map((m) => String(m.id)),
];
const bossHits = [];
for (const id of bossIds) {
  const r = await fetch(`${BASE}/art/bosses/${id}.webp`, { method: 'HEAD' });
  if (r.ok) bossHits.push(id);
}
p(`boss art hits among ${bossIds.length} ids: ${bossHits.length ? bossHits.join(', ') : 'none'}`);
// loading screens for future continents
const loadProbes = ['jade', 'sky', 'sky-kingdom', 'demon', 'demon-realm', 'jade-continent', 'aetheria', 'world2', 'world3', 'world4', 'inferno', 'arena', 'tower', 'guild'];
const loadHits = [];
for (const n of loadProbes) {
  const r = await fetch(`${BASE}/art/loading/${n}.webp`, { method: 'HEAD' });
  if (r.ok) loadHits.push(n);
}
p(`extra loading art: ${loadHits.length ? loadHits.join(', ') : 'none'}`);
// extra manifests
for (const g of ['gacha', 'events', 'costume-box', 'title', 'cards', 'pets', 'bosses', 'loading', 'world', 'bags']) {
  const j = await jget(`${BASE}/art/${g}/manifest.json`);
  if (j) p(`   /art/${g}/manifest.json → ${Object.keys(j).length} keys: ${Object.keys(j).slice(0, 14).join(', ')}${Object.keys(j).length > 14 ? '…' : ''}`);
}

p('\n=== 7. BUNDLE TEASES (coming-soon strings) ===');
const b = fs.readFileSync(R + '/bundle-2026-10-15.js', 'utf8');
const seen = new Set();
for (const kw of ['เร็วๆ นี้', 'กำลังพัฒนา', 'จะเปิด', 'ยังไม่เปิด', 'รอประกาศ']) {
  let i = -1, n = 0;
  while (n < 6 && (i = b.indexOf(kw, i + 1)) >= 0) {
    const ctx = b.slice(Math.max(0, i - 130), i + 220).replace(/\s+/g, ' ');
    const h = ctx.slice(60, 140);
    if (!seen.has(h)) { seen.add(h); p('   …' + ctx.slice(0, 330)); n++; }
  }
}

fs.writeFileSync(R + '/leak-hunt.json', JSON.stringify({
  manOnly: manOnly.map(([id, m]) => ({ id, name: m.name, file: m.file })),
  liveOnlyMonsters: liveOnly.map((id) => ({ id, name: liveMon.get(id).name })),
  orphanItemIcons: orphanKeys, skillIconOnly, skillNoIcon, spiritOrphans,
  roOnlyCount: roOnly.length, roOnlySample: roOnly.slice(0, 60).map((i) => ({ id: i.id, name: i.name })),
  extraCards, bossHits, loadHits,
}, null, 1));
p('\nsaved → recon/leak-hunt.json');
