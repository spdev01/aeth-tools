// tmp-make-digest.mjs — human-readable digest of everything found (proper UTF-8 file → read with read_file).
import fs from 'node:fs';
const R = 'E:/GitHub/lumivaraonline/aetheria/recon';
const out = [];

const notes = JSON.parse(fs.readFileSync(R + '/patch-notes.json', 'utf8'));
notes.sort((a, b) => String(b.id).localeCompare(String(a.id))); // newest first
out.push(`# Patch notes digest — ${notes.length} entries (source: GET /patch-notes)`);
out.push(notes.map((n) => `- ${n.date}  ${n.title}`).join('\n'));
for (const n of notes.slice(0, 5)) {
  out.push(`\n## ${n.date} — ${n.title}`);
  for (const it of n.items) out.push(`- [${it.tag}] ${it.text}`);
}

const ev = JSON.parse(fs.readFileSync(R + '/world-events.json', 'utf8'));
out.push('\n# World events (GET /world/events)');
for (const e of ev) out.push(`- ${e.title} · ${new Date(e.startsAt).toISOString().slice(0, 10)} → ${new Date(e.endsAt).toISOString().slice(0, 10)}  badge=${e.badge ?? ''}`);

const fresh = JSON.parse(fs.readFileSync(R + '/wiki-data-2026-10-15.json', 'utf8'));
const old = JSON.parse(fs.readFileSync(R + '/wiki-data.json', 'utf8'));
const oldM = new Set(old.monsters.map((m) => String(m.id)));
const newM = fresh.monsters.filter((m) => !oldM.has(String(m.id)));
out.push(`\n# New monsters since 10-05 (${newM.length})`);
for (const m of newM) out.push(`- ${m.id} ${m.name} · lv${m.level} hp${m.hp} atk${m.atk} el=${m.element ?? '-'}${m.elementLevel ?? ''} race=${m.race ?? '-'} exp=${m.exp ?? '-'}${m.trainingDummy ? ' [dummy]' : ''}`);

const oldS = new Set(old.skills.map((s) => String(s.id)));
out.push('\n# New skills since 10-05');
for (const s of fresh.skills.filter((s) => !oldS.has(String(s.id)))) out.push(`- ${s.id} — ${s.name} (class ${s.classId}, ${s.kind}, max Lv${s.maxLevel})`);

const oldI = new Set(old.items.map((i) => String(i.id)));
const newItems = fresh.items.filter((i) => !oldI.has(String(i.id)));
const byType = {};
for (const i of newItems) byType[i.type] = (byType[i.type] || 0) + 1;
out.push(`\n# New items since 10-05: ${newItems.length}`);
out.push('by type: ' + JSON.stringify(byType, null, 1));
const samples = {};
for (const i of newItems) { (samples[i.type] ??= []).push(`${i.id} ${i.name}`); }
for (const [t, arr] of Object.entries(samples)) out.push(`- ${t}: ${arr.slice(0, 12).join(' · ')}${arr.length > 12 ? ` …+${arr.length - 12}` : ''}`);

fs.writeFileSync(R + '/update-digest.md', out.join('\n'));
console.log('digest lines:', out.join('\n').split('\n').length);

// probe wiki raw endpoints (accessibility check for wiki-building)
for (const u of [
  'https://www.aetheria-online.in.th/wiki-data/raw?target=game&id=2101',
  'https://www.aetheria-online.in.th/wiki-data/raw?target=ragnarok&id=2101',
  'https://www.aetheria-online.in.th/wiki',
]) {
  try { const r = await fetch(u); const t = await r.text(); console.log(u, '->', r.status, t.slice(0, 160).replace(/\s+/g, ' ')); }
  catch (e) { console.log(u, '-> ERR', e.message); }
}
