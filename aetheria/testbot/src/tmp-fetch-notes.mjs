// tmp-fetch-notes.mjs — fetch /patch-notes + /world/events (from the live bundle's own endpoints).
import fs from 'node:fs';
const R = 'E:/GitHub/lumivaraonline/aetheria/recon';

const j = async (u) => { const r = await fetch(u); const t = await r.text(); let p = null; try { p = JSON.parse(t); } catch {} return { status: r.status, text: t, json: p }; };

const notes = await j('https://www.aetheria-online.in.th/patch-notes');
fs.writeFileSync(R + '/patch-notes.json', notes.text);
console.log('=== /patch-notes ===', notes.status, 'bytes', notes.text.length);
if (notes.json) {
  const n = notes.json;
  const arr = Array.isArray(n) ? n : Array.isArray(n.notes) ? n.notes : Array.isArray(n.patches) ? n.patches : null;
  console.log('shape:', Array.isArray(n) ? `array[${n.length}]` : Object.keys(n).join(','));
  if (arr) {
    for (const x of arr.slice(-4)) console.log('---\n' + JSON.stringify(x).slice(0, 600));
    console.log('total entries:', arr.length);
  } else console.log(JSON.stringify(n).slice(0, 900));
} else console.log('non-JSON head:', notes.text.slice(0, 300));

const ev = await j('https://www.aetheria-online.in.th/world/events');
fs.writeFileSync(R + '/world-events.json', ev.text);
console.log('=== /world/events ===', ev.status, 'bytes', ev.text.length);
console.log(ev.text.slice(0, 500));

// full new-monster list from the scan report
const md = fs.readFileSync('E:/GitHub/lumivaraonline/aetheria/testbot/out/wiki-update-report.md', 'utf8').split('\n');
const i = md.findIndex((l) => l.includes('monsters: 58'));
const jj = md.findIndex((l) => l.includes('skills: 137'));
console.log('=== NEW MONSTERS (54) ===');
console.log(md.slice(i, jj).join('\n'));
