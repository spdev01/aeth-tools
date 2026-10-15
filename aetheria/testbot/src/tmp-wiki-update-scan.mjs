// tmp-wiki-update-scan.mjs — (A) diff wiki-data 10-05 vs now = new update content,
// (B) diff game bundle Thai strings vs previous snapshots = UI-visible changes,
// (C) hunt patch-notes/events source + asset-path inventory for wiki-building feasibility.
import fs from 'node:fs';

const R = 'E:/GitHub/lumivaraonline/aetheria/recon';
const TMP = process.env.TEMP;
const full = []; // full report (uncapped) → out/wiki-update-report.md
const p = (s) => { full.push(s); console.log(s); };

// ---------- A. wiki-data diff ----------
const fresh = await (await fetch('https://www.aetheria-online.in.th/wiki-data')).json();
fs.writeFileSync(R + '/wiki-data-2026-10-15.json', JSON.stringify(fresh));
p('=== A. WIKI-DATA (server endpoint) ===');
p('fresh fetched  : ' + new Date().toISOString());
p('fresh generatedAt: ' + fresh.generatedAt);
const old = JSON.parse(fs.readFileSync(R + '/wiki-data.json', 'utf8'));
p('old copy (10-05) generatedAt: ' + old.generatedAt);
const cmp = (a = [], b = [], label) => {
  const O = new Map(a.map((x) => [String(x.id), x]));
  const A = new Map(b.map((x) => [String(x.id), x]));
  const added = [...A.keys()].filter((k) => !O.has(k)).map((k) => A.get(k));
  const removed = [...O.keys()].filter((k) => !A.has(k)).map((k) => O.get(k));
  p(`\n-- ${label}: ${a.length} -> ${b.length}   (+${added.length} / -${removed.length})`);
  for (const x of added.slice(0, 45)) p(`   + ${x.id}  ${x.name ?? ''}`);
  if (added.length > 45) p(`   ... +${added.length - 45} more (full list in report file)`);
  for (const x of added.slice(45)) p(`   + ${x.id}  ${x.name ?? ''}`); // full in file only? keep: file gets all, console already printed same...
  for (const x of removed.slice(0, 15)) p(`   - ${x.id}  ${x.name ?? ''}`);
};
cmp(old.items, fresh.items, 'items');
cmp(old.ragnarokItems, fresh.ragnarokItems, 'ragnarokItems');
cmp(old.monsters, fresh.monsters, 'monsters');
cmp(old.skills, fresh.skills, 'skills');
cmp(old.classes, fresh.classes, 'classes');
cmp(old.maps, fresh.maps, 'maps');

// ---------- B. bundle Thai-string diff ----------
p('\n=== B. BUNDLE ================');
let bundle = null, used = null;
try {
  const page = await (await fetch('https://www.aetheria-online.in.th/play')).text();
  const srcs = [...page.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  for (const s of srcs) {
    const url = s.startsWith('http') ? s : 'https://www.aetheria-online.in.th' + (s.startsWith('/') ? s : '/' + s);
    try { const t = await (await fetch(url)).text(); if (t.length > 500000 && /human_check/.test(t)) { bundle = t; used = url; break; } } catch {}
  }
} catch (e) { p('bundle fetch failed: ' + e.message); }
if (bundle) {
  fs.writeFileSync(R + '/bundle-2026-10-15.js', bundle);
  p('bundle: ' + used + '  ' + bundle.length + ' chars  (saved recon/bundle-2026-10-15.js)');
  const thai = (s) => /[\u0E00-\u0E7F]/.test(s);
  const strings = (js) => {
    const set = new Set();
    for (const re of [/`([^`]{2,300})`/g, /'([^'\\\n]{2,300})'/g, /"([^"\\\n]{2,300})"/g]) for (const m of js.matchAll(re)) if (thai(m[1])) set.add(m[1]);
    return set;
  };
  const sNew = strings(bundle);
  const candidates = [
    [R + '/live-1.js', '10-09'], [TMP + '/aetheria-bundle3.js', '10-14'], [TMP + '/aetheria-bundle.js', 'older'],
  ].filter(([f]) => fs.existsSync(f));
  for (const [f, tag] of candidates) {
    const sOld = strings(fs.readFileSync(f, 'utf8'));
    const added = [...sNew].filter((s) => !sOld.has(s));
    const removed = [...sOld].filter((s) => !sNew.has(s));
    p(`\n-- Thai strings vs ${tag} (${f.split(/[\\/]/).pop()}): old=${sOld.size} new=${sNew.size}   +${added.length} / -${removed.length}`);
    if (tag === '10-14' || candidates.length === 1) {
      for (const s of added.slice(0, 70)) p('   + ' + s.replace(/\s+/g, ' ').slice(0, 150));
      if (added.length > 70) p(`   ... +${added.length - 70} more (in report file)`);
      for (const s of removed.slice(0, 20)) p('   - ' + s.replace(/\s+/g, ' ').slice(0, 150));
    }
  }
}

// ---------- C. endpoints / patch notes / assets ----------
p('\n=== C. ENDPOINTS / PATCH NOTES / ASSET PATHS ================');
if (bundle) {
  // URL-ish literals
  const urls = new Set();
  for (const m of bundle.matchAll(/["'`](\/[a-zA-Z0-9_\-./]+(?:\?[^"'`]{0,60})?)["'`]/g)) {
    const u = m[1];
    if (!/\.(webp|png|jpe?g|gif|svg|mp3|ogg|wav|ttf|woff2?|css)$/i.test(u)) urls.add(u);
  }
  const interesting = [...urls].filter((u) => /wiki|patch|note|news|event|data|catalog|api|asset|config/i.test(u));
  p('interesting server paths:');
  for (const u of interesting.slice(0, 40)) p('   ' + u);
  // '/art/' group inventory
  const groups = new Map();
  for (const m of bundle.matchAll(/\/art\/([a-z0-9_\-]+)\//gi)) groups.set(m[1], (groups.get(m[1]) || 0) + 1);
  p('asset path groups: ' + [...groups.entries()].map(([k, v]) => `${k}(${v})`).join(' '));
  // patch notes mechanism
  const show = (kw, n = 3) => {
    let i = -1, c = 0;
    while (c < n && (i = bundle.indexOf(kw, i + 1)) >= 0) {
      p(`   [${kw}] ...` + bundle.slice(Math.max(0, i - 160), i + 200).replace(/\s+/g, ' '));
      c++;
    }
  };
  p('\npatch mechanism:');
  show('patchNotes', 2); show('onMessage(`patch', 2); show('`patch`', 2); show('webgame.patch', 2);
  p('wiki-data usage in client:');
  show('wiki-data', 3);
  p('events mechanism:');
  show('onMessage(`events', 2); show('`events`', 2);
}
fs.mkdirSync('E:/GitHub/lumivaraonline/aetheria/testbot/out', { recursive: true });
fs.writeFileSync('E:/GitHub/lumivaraonline/aetheria/testbot/out/wiki-update-report.md', full.join('\n'));
p('\nfull report -> testbot/out/wiki-update-report.md');
