// refine feedback scanner
import fs from 'node:fs';
const f = 'e:/GitHub/lumivaraonline/aetheria/testbot/out/run-2026-10-04T11-21-30-563Z.jsonl';
const evs = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
for (const e of evs) {
  if (/refine_fx|client_error|server_error|socket|send/i.test(e.evt)) console.log(e.t.slice(11, 19), e.evt, JSON.stringify(e.data).slice(0, 240));
}
console.log('--- all evt names in run:');
const names = {};
for (const e of evs) names[e.evt] = (names[e.evt] || 0) + 1;
console.log(JSON.stringify(names));
