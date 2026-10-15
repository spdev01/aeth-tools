import fs from 'node:fs';

const WIKI = 'E:/GitHub/lumivaraonline/aetheria/recon/wiki-data.json';
const DIR = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/213';

// ---- price map (merge both DB arrays) ----
const wiki = JSON.parse(fs.readFileSync(WIKI, 'utf8'));
const priceByName = new Map();
const conflicts = [];
for (const arr of [wiki.items, wiki.ragnarokItems]) {
  for (const it of (arr ?? [])) {
    if (!it || !it.name) continue;
    const p = it.sellPrice ?? 0;
    if (priceByName.has(it.name)) {
      const old = priceByName.get(it.name);
      if (old.p !== p) conflicts.push(`${it.name}: ${old.p} vs ${p}`);
      if (p > old.p) priceByName.set(it.name, { p, id: it.id });
    } else priceByName.set(it.name, { p, id: it.id });
  }
}
console.log(`price entries: ${priceByName.size}  conflicts: ${conflicts.length}`);
if (conflicts.length) console.log('  ' + conflicts.slice(0, 8).join('\n  '));

// ---- control (keep list) ----
const ctl = JSON.parse(fs.readFileSync(DIR + '/control.json', 'utf8'));
const keep = new Set((ctl.keep ?? []).map(Number));
console.log(`ctl keys: ${Object.keys(ctl).join(',')}`);
console.log(`keep ids: ${keep.size}  farm.keep: ${JSON.stringify(ctl.farm?.keep)}  buffItems: ${JSON.stringify(ctl.auto?.buffItems)}`);
const EXCLUDE_EXTRA = new Set([90041, 90311]); // fire converter, butterfly wing

// ---- scan logs ----
const files = [
  'run-2026-10-09T16-37-59-055Z.jsonl',
  'run-2026-10-10T03-09-14-339Z.jsonl',
  'run-2026-10-10T03-09-45-203Z.jsonl',
  'run-2026-10-10T03-19-18-864Z.jsonl',
  'run-2026-10-10T03-23-31-726Z.jsonl',
  'run-2026-10-10T03-28-16-641Z.jsonl',
  'run-2026-10-10T04-58-28-912Z.jsonl',
];

const CARD = /(?:\bcard\b|การ์ด)/i;
const SCROLL = /weight\s*limit|น้ำหนัก/i;
const POTION = /potion|ยา/i;

const drops = [];
const hbs = [];
let lineCount = 0;

for (const fn of files) {
  const raw = fs.readFileSync(`${DIR}/${fn}`, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    lineCount++;
    const parts = line.includes('}{') ? line.split('}{') : [line];
    for (const p of parts) {
      const t = p.match(/"t":"([^"]+)"/);
      if (!t) continue;
      if (p.includes('"evt":"drop"')) {
        const n = p.match(/"name":"((?:[^"\\]|\\.)*)"/);
        const q = p.match(/"qty":(\d+)/);
        if (n) drops.push({ t: t[1], name: JSON.parse(`"${n[1]}"`), qty: q ? Number(q[1]) : 1 });
      } else if (p.includes('"evt":"HEARTBEAT"')) {
        const z = p.match(/"zeny":(\d+)/);
        if (z) hbs.push({ t: t[1], zeny: Number(z[1]) });
      }
    }
  }
}
hbs.sort((a, b) => (a.t < b.t ? -1 : 1));
console.log(`lines: ${lineCount}  drops: ${drops.length}  heartbeats: ${hbs.length}`);

// ---- valuation ----
function valueOf(name) {
  const it = priceByName.get(name);
  if (!it) return { p: 0, id: null, found: false };
  return { p: it.p, id: it.id, found: true };
}
function isSellable(name) {
  const { p, id, found } = valueOf(name);
  if (!found || !(p > 0)) return false;
  if (CARD.test(name)) return false;
  if (SCROLL.test(name)) return false;
  if (POTION.test(name)) return false;
  if (id != null && (keep.has(id) || EXCLUDE_EXTRA.has(id))) return false;
  return true;
}

function summarize(label, t0, t1, actual) {
  const sel = drops.filter((d) => d.t >= t0 && d.t <= t1);
  let sellVal = 0, allVal = 0, unmatchedQty = 0, totalQty = 0, matchedVal = 0;
  const byItem = new Map();
  for (const d of sel) {
    const { p, found } = valueOf(d.name);
    totalQty += d.qty;
    if (!found) unmatchedQty += d.qty;
    if (p > 0) allVal += p * d.qty;
    if (isSellable(d.name)) {
      sellVal += p * d.qty;
      matchedVal += p * d.qty;
      const e = byItem.get(d.name) ?? { qty: 0, val: 0, p };
      e.qty += d.qty; e.val += p * d.qty;
      byItem.set(d.name, e);
    }
  }
  console.log(`\n=== ${label} ===`);
  console.log(`  drops: ${sel.length} events, qty=${totalQty}, unmatched-qty=${unmatchedQty} (${((unmatchedQty / Math.max(1, totalQty)) * 100).toFixed(1)}%)`);
  console.log(`  sellable value: ${sellVal.toLocaleString()}   (all-value incl kept/cards: ${allVal.toLocaleString()})`);
  if (actual != null) console.log(`  ACTUAL sale:    ${actual.toLocaleString()}   ratio=${(actual / Math.max(1, sellVal)).toFixed(3)}`);
  const top = [...byItem.entries()].sort((a, b) => b[1].val - a[1].val).slice(0, 16);
  for (const [n, e] of top) console.log(`    ${String(e.val).padStart(11)}  ${n} x${e.qty} @${e.p}`);
  return { sellVal, allVal };
}

// intervals (UTC)
summarize('Sale2 interval 06:25:31Z -> 07:06:27Z', '2026-10-10T06:25:31', '2026-10-10T07:06:28', 1778591);
summarize('Sale1 interval file-start -> 06:25:30Z', '2026-10-09T00:00:00', '2026-10-10T06:25:30', 10044941);
const win = summarize('Window 03:30:08Z -> 07:32Z', '2026-10-10T03:30:08', '2026-10-10T07:32:05', 11819432);

// ---- per-hour accrual vs actual zeny deltas ----
console.log('\n=== per-hour (UTC): est sellable value / actual zeny delta ===');
const hours = new Map();
for (const d of drops) {
  const h = d.t.slice(0, 13);
  if (!hours.has(h)) hours.set(h, { v: 0, q: 0 });
  const e = hours.get(h);
  if (isSellable(d.name)) e.v += valueOf(d.name).p * d.qty;
  e.q += d.qty;
}
const zenyByHour = new Map();
for (let i = 1; i < hbs.length; i++) {
  const dh = hbs[i].zeny - hbs[i - 1].zeny;
  if (!dh) continue;
  const h = hbs[i].t.slice(0, 13);
  zenyByHour.set(h, (zenyByHour.get(h) ?? 0) + dh);
}
const allH = [...new Set([...hours.keys(), ...zenyByHour.keys()])].sort();
for (const h of allH) {
  const e = hours.get(h) ?? { v: 0, q: 0 };
  const z = zenyByHour.get(h) ?? 0;
  console.log(`  ${h}Z  est=${String(e.v).padStart(12)}  actualΔ=${String(z).padStart(12)}  dropQty=${e.q}`);
}

// unmatched names (top qty)
const un = new Map();
for (const d of drops) { if (!valueOf(d.name).found) un.set(d.name, (un.get(d.name) ?? 0) + d.qty); }
console.log('\nunmatched names:', un.size);
for (const [n, q] of [...un.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${q}  ${n}`);
