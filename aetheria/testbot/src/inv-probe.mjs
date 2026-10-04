// inv-probe: connect the SPARE account (ScoutA92391) and dump inventory item shape + auto config defaults
import { AetheriaClient } from './client.js';

const res = await fetch('https://www.aetheria-online.in.th/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: 'g_fa4b74a890', password: 'MkReDWuUO0twmNDVzNIFSrc-UXciFVdE' }),
});
const auth = await res.json();
console.log('login status:', res.status, '| token?', !!auth.token);
const c = new AetheriaClient({ token: auth.token });
const cl = await c.listCharacters();
const ch = cl.characters?.[0];
console.log('char:', JSON.stringify({ id: ch?.characterId, name: ch?.name, map: ch?.mapName }));
await c.connect(ch.characterId);
await c.waitJoin();
c.arrived();

let inv = null, charMsg = null;
c.on('message', (type, data) => {
  if (type === 'inventory') inv = data;
  if (type === 'character') charMsg = data;
});

await new Promise((r) => setTimeout(r, 6000));
if (charMsg) {
  console.log('\n--- character.auto (defaults) ---');
  console.log(JSON.stringify(charMsg.auto, null, 1).slice(0, 1200));
}
if (inv) {
  console.log('\n--- inventory (n=', inv.items?.length, ') ---');
  for (const i of (inv.items ?? []).slice(0, 20)) console.log(JSON.stringify({ slot: i.slot, id: i.itemId, name: i.name, qty: i.qty, autoPotion: i.autoPotion, sellPrice: i.sellPrice }));
  const potions = (inv.items ?? []).filter((i) => /potion|ยา/i.test(i.name || ''));
  console.log('\npotions found:', potions.length);
  for (const p of potions) console.log('  ', JSON.stringify({ id: p.itemId, name: p.name, autoPotion: p.autoPotion, qty: p.qty }));
} else {
  console.log('no inventory message received in 6s');
}
c.close();
process.exit(0);
