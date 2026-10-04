// find shop-ish NPC dialogs from all past scan logs
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const seen = new Set();
for (const f of runs) {
  const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const e of es) {
    if (/^(scan|hunt):/.test(e.evt) && e.data && e.data.options) {
      const key = e.evt;
      if (seen.has(key)) continue; seen.add(key);
      console.log(e.evt, '|', e.data.name, '| text:', String(e.data.text).slice(0, 60), '| options:', JSON.stringify(e.data.options));
    }
  }
}
console.log('\n--- dialog + shop events (all runs) ---');
for (const f of runs) {
  const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const e of es.filter((x) => x.evt === 'shop').slice(0, 2)) {
    console.log(f.slice(4, 24), '| shop items:', JSON.stringify((e.data.items ?? []).map((i) => `${i.name}:${i.price}`)).slice(0, 400));
  }
}
