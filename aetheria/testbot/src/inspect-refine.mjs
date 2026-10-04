// Inspect: full refine guide from last log + live saber item structure + dialog options
import fs from 'node:fs';
import { AetheriaClient } from './client.js';

const OUT = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';

// (a) full refine guide from the last run log
const runs = fs.readdirSync(OUT).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
const latest = runs[runs.length - 1];
const evs = fs.readFileSync(`${OUT}/${latest}`, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const refMsg = evs.find((e) => e.evt === 'refine');
console.log('=== refine guide (full) ===');
console.log(JSON.stringify(refMsg?.data, null, 1).slice(0, 2600));

// (b) live: saber item full + dialog + sessionId
const sess = JSON.parse(fs.readFileSync(`${OUT}/session.json`, 'utf8'));
const client = new AetheriaClient({ token: sess.token });
const chars = await client.listCharacters();
const ch = chars.characters[0];
await client.connect(ch.characterId);
let char = null, inv = null, dialog = null;
client.on('message', (t, d) => {
  if (t === 'character') char = d;
  if (t === 'inventory') inv = d;
  if (t === 'npc_dialog') dialog = d;
});
await new Promise((r) => setTimeout(r, 2500));
console.log('\nselfId:', client.reservation.sessionId);
client.invSort();
await new Promise((r) => setTimeout(r, 1500));
const saber = inv?.items?.find((x) => /Pommel Saber/i.test(x.name));
console.log('SABER ITEM FULL:');
console.log(JSON.stringify(saber, null, 1));
console.log('equipped?:', JSON.stringify(char?.equipment)?.slice(0, 300));
const phracon = (inv?.items ?? []).filter((x) => /Phracon|Elunium/i.test(x.name));
console.log('ores in bag:', phracon.map((x) => `${x.name} x${x.qty}`).join(', '));
client.npcTalk('n3');
await new Promise((r) => setTimeout(r, 1200));
console.log('n3 dialog options:', JSON.stringify(dialog?.options));
client.npcClose();
client.close();
process.exit(0);
