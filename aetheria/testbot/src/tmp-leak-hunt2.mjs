// tmp-leak-hunt2.mjs — follow-ups: class kits, iconless skills, hidden boss art scan, unreleased downloads.
import fs from 'node:fs';
const BASE = 'https://www.aetheria-online.in.th';
const R = 'E:/GitHub/lumivaraonline/aetheria/recon';
const W = 'E:/GitHub/lumivaraonline/aetheria/wiki';
const wiki = JSON.parse(fs.readFileSync(R + '/wiki-data-2026-10-15.json', 'utf8'));
const p = console.log;

p('=== SKILLS PER CLASS (classes with ZERO skills = unreleased kits) ===');
const byClass = {};
for (const s of wiki.skills ?? []) (byClass[s.classId] ??= []).push(s.id);
for (const c of wiki.classes ?? []) {
  const ids = byClass[c.id] ?? [];
  p(`   ${String(c.id).padEnd(22)} ${String(ids.length).padStart(3)} skills  ${ids.length ? '' : '  ← no skills'}`);
}
p('\n=== iconless skills → class ===');
for (const id of ['whirlwind', 'starfall', 'angel-starfall', 'focus-shooting', 'earthquake']) {
  const s = (wiki.skills ?? []).find((x) => x.id === id);
  if (s) p(`   ${id} — ${s.name} · class=${s.classId} kind=${s.kind} maxLv=${s.maxLevel}`);
}
p('\n=== HIDDEN BOSS ART SCAN (9000-9100) ===');
const liveMon = new Map(wiki.monsters.map((m) => [String(m.id), m]));
const hits = [];
for (let id = 9000; id <= 9100; id++) {
  const r = await fetch(`${BASE}/art/bosses/${id}.webp`, { method: 'HEAD' });
  if (r.ok) hits.push(id);
}
for (const id of hits) {
  const m = liveMon.get(String(id));
  p(`   /art/bosses/${id}.webp  ${m ? `= ${m.name} (Lv${m.level})` : '← NO monster data (fully unreleased?)'}`);
  const buf = Buffer.from(await (await fetch(`${BASE}/art/bosses/${id}.webp`)).arrayBuffer());
  fs.mkdirSync(W + '/assets/art/bosses', { recursive: true });
  fs.writeFileSync(`${W}/assets/art/bosses/${id}.webp`, buf);
}
p(`   downloaded ${hits.length} boss arts → wiki/assets/art/bosses/`);

p('\n=== download unreleased monster sheets → recon/leaks ===');
fs.mkdirSync(R + '/leaks', { recursive: true });
for (const id of [1, 3, 4, 5, 6, 7, 8, 9, 10]) {
  const buf = Buffer.from(await (await fetch(`${BASE}/art/monsters/${id}.webp`)).arrayBuffer());
  fs.writeFileSync(`${R}/leaks/monster-${id}.webp`, buf);
}
p('   saved monster-1..10.webp (Crab, Baby Bee, Young Crab, Wild Goat, Rotten Zombie, Giant Crab, Savage Brute, AsGard Warrior, Elder Goat)');

p('\n=== unreleased monster thumbnails → wiki ===');
const sharp = (await import('sharp')).default;
fs.mkdirSync(W + '/assets/thumbs/leaks', { recursive: true });
for (const id of [1, 3, 4, 5, 6, 7, 8, 9, 10]) {
  try {
    const src = `${R}/leaks/monster-${id}.webp`;
    const meta = await sharp(src).metadata();
    const w = meta.width ?? 0, h = meta.height ?? 0;
    const buf = (w % h === 0 && w / h >= 2)
      ? await sharp(src).extract({ left: 0, top: 0, width: h, height: h }).resize({ height: 96 }).webp().toBuffer()
      : await sharp(src).resize({ height: 96 }).webp().toBuffer();
    fs.writeFileSync(`${W}/assets/thumbs/leaks/${id}.webp`, buf);
  } catch (e) { p('   thumb fail ' + id + ': ' + e.message); }
}
p('   thumbs → wiki/assets/thumbs/leaks/');
