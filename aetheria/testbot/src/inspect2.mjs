// inspect2: full inventory + controlled single-refine experiment
import fs from 'node:fs';
import { AetheriaClient } from './client.js';

const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
const sess = JSON.parse(fs.readFileSync(`${OUT}/session.json`, 'utf8'));
const client = new AetheriaClient({ token: sess.token });
const chars = await client.listCharacters();
const ch = chars.characters[0];
await client.connect(ch.characterId);

let inv = null, char = null, dialog = null, refineMsg = null;
const fx = [];
client.on('message', (t, d) => {
  if (t === 'character') char = d;
  if (t === 'inventory') inv = d;
  if (t === 'npc_dialog') dialog = d;
  if (t === 'refine') refineMsg = d;
  if (t === 'b') { for (const it of (Array.isArray(d) ? d : [])) { const [n, x] = Array.isArray(it) ? it : []; if (n === 'refine_fx') fx.push({ t: new Date().toISOString().slice(11, 19), x }); } }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);
client.invSort(); await sleep(1200);

const dump = (label) => {
  console.log(`\n=== ${label} ===`);
  console.log('zeny:', char?.zeny);
  for (const it of inv?.items ?? []) console.log(`  slot ${String(it.slot).padStart(2)} | ${(it.name + '    ').slice(0, 26)} | qty ${String(it.qty).padStart(3)} | refine ${it.refine ?? '-'} | ${it.type} | sell ${it.sellPrice}`);
  console.log('EQUIP main-hand:', JSON.stringify(char?.equipment?.['main-hand']));
};
dump('BEFORE');
console.log('selfId:', client.reservation.sessionId);
console.log('fx so far:', JSON.stringify(fx));

// 1) unequip saber into a free bag slot
const used = new Set((inv?.items ?? []).map((i) => i.slot));
let freeSlot = 0; while (used.has(freeSlot)) freeSlot++;
console.log(`\nunequip main-hand -> bag slot ${freeSlot}`);
client.send('unequip', { slot: 'main-hand', to: freeSlot });
await sleep(1500);
dump('AFTER UNEQUIP');

// 2) open refine window and refine ONCE
client.npcTalk('n3'); await sleep(1200);
client.npcOption(0); await sleep(1200);
console.log('refine mode:', refineMsg?.mode);
const saber = (inv?.items ?? []).find((x) => /Pommel Saber/i.test(x.name));
if (!saber) { console.log('!! saber not in bag, aborting test'); }
else {
  console.log(`\n>> refine send #1 (slot ${saber.slot})`);
  client.send('refine', { source: saber.slot, blessing: false });
  await sleep(3000);
  console.log('fx:', JSON.stringify(fx));
  dump('AFTER REFINE #1');
  console.log(`\n>> refine send #2 (slot ${(inv?.items ?? []).find((x) => /Pommel Saber/i.test(x.name))?.slot})`);
  client.send('refine', { source: (inv?.items ?? []).find((x) => /Pommel Saber/i.test(x.name))?.slot, blessing: false });
  await sleep(3000);
  console.log('fx:', JSON.stringify(fx));
  dump('AFTER REFINE #2');
}
client.npcClose();
client.close();
process.exit(0);
