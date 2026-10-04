// raw tail: all interesting events from newest run
import fs from 'node:fs';
const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const f = runs[runs.length - 1];
const es = fs.readFileSync(`${OUT}/${f}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log('RUN:', f, '| events:', es.length);
const show = /buy_potions|pot_restocked|pot_no|pot_ok|traveled|travel_msg|wrong_map|ensure|buy_ore|shop|weave_idle|mob_hit_seen|weave|DEATH|death_recover|setAuto|levelup|kill|drop|item_used/;
for (const e of es.filter((x) => show.test(x.evt))) console.log(e.t.slice(11, 19), e.evt.padEnd(14), JSON.stringify(e.data).slice(0, 170));
