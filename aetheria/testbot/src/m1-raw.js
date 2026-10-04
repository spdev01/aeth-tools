// M1-RAW: full headless session on the raw client — join, capture skill_catalog/character/inventory, test commands.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const sess = JSON.parse(fs.readFileSync(path.join(outDir, 'session.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(outDir, `m1raw-${stamp}.jsonl`);
const log = (o) => fs.appendFileSync(logFile, JSON.stringify(o) + '\n');
console.log('log ->', logFile);

const client = new AetheriaClient({ token: sess.token });
const chars = await client.listCharacters();
const ch = chars.characters?.[0];
console.log('characters:', JSON.stringify(chars.characters));
if (!ch) { console.log('no character'); process.exit(1); }

client.on('join', (j) => { log({ step: 'join', j }); console.log('JOIN ok, reflection bytes:', client.reflection.length); });
client.on('close', (c, r) => { log({ step: 'close', c, r }); console.log('CLOSE', c, r); });
client.on('error', (e) => { log({ step: 'error', e }); console.log('ERR', JSON.stringify(e).slice(0, 260)); });
client.on('state', (kind, buf) => log({ step: 'state', kind, len: buf.length }));

const counts = {}; let catalog = null, character = null;
client.on('message', (type, data) => {
  counts[type] = (counts[type] || 0) + 1;
  if (type === 'skill_catalog') { catalog = data; log({ step: 'msg', type, data }); }
  else if (type === 'character') { character = data; log({ step: 'msg', type, data }); console.log('CHARACTER:', JSON.stringify(data).slice(0, 360)); }
  else if (type === 'inventory') { log({ step: 'msg', type, data }); console.log('INVENTORY slots:', data?.slots, 'weight:', data?.weight, '/', data?.weightLimit, 'items:', data?.items?.length); }
  else log({ step: 'msg', type, data: JSON.stringify(data).slice(0, 600) });
});

await client.connect(ch.characterId);
console.log('connected — waiting 3s for join burst...');
await new Promise((r) => setTimeout(r, 3000));
client.invSort(); console.log('-> inv_sort');
client.moveTo(53, 32); console.log('-> move_to(53,32)');
await new Promise((r) => setTimeout(r, 5000));
client.moveTo(52, 32); console.log('-> move_to(52,32)');
await new Promise((r) => setTimeout(r, 5000));

console.log('MESSAGE TYPES:', JSON.stringify(counts));
if (catalog) {
  const list = Array.isArray(catalog) ? catalog : (catalog.skills || Object.values(catalog));
  console.log('catalog entries:', Array.isArray(list) ? list.length : typeof list);
  if (Array.isArray(list) && list[0]) console.log('sample entry:', JSON.stringify(list[0]).slice(0, 300));
  fs.writeFileSync(path.join(outDir, 'skill-catalog.json'), JSON.stringify(catalog, null, 2));
  console.log('saved skill-catalog.json');
}
if (character) { fs.writeFileSync(path.join(outDir, 'character-snapshot.json'), JSON.stringify(character, null, 2)); console.log('saved character-snapshot.json'); }
client.close();
process.exit(0);
