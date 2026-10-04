// M1-ACT: prove outgoing commands work from the raw Node client (stat allocation round-trip).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const sess = JSON.parse(fs.readFileSync(path.join(outDir, 'session.json'), 'utf8'));
const client = new AetheriaClient({ token: sess.token });
const chars = await client.listCharacters();
const ch = chars.characters[0];

let character = null;
client.on('message', (type, data) => {
  if (type === 'character') { character = data; console.log('character update:', JSON.stringify({ STR: data.stats?.STR, points: data.statusPoints, baseLevel: data.baseLevel, jobLevel: data.jobLevel })); }
});
client.on('error', (e) => console.log('ERR', JSON.stringify(e).slice(0, 200)));

await client.connect(ch.characterId);
await new Promise((r) => setTimeout(r, 2500));
console.log('BEFORE: STR', character?.stats?.STR, 'points', character?.statusPoints);
client.statUp('STR', 1);
console.log('-> sent stat_up STR +1');
await new Promise((r) => setTimeout(r, 3500));
console.log('AFTER : STR', character?.stats?.STR, 'points', character?.statusPoints);

// also fetch fresh inventory to confirm request/response commands
let inv = null;
client.on('message', (t, d) => { if (t === 'inventory') inv = d; });
client.invSort();
await new Promise((r) => setTimeout(r, 2500));
console.log('INVENTORY items:', inv?.items?.map((i) => `${i.name} x${i.qty} (sell ${i.sellPrice})`).join(' | '));

client.close();
process.exit(0);
