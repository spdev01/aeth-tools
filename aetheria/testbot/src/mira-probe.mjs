// spare-account probe: Healer Mira dialog (peco rental?) + Training Master key hunt
import { AetheriaClient } from './client.js';

const auth = await (await fetch('https://www.aetheria-online.in.th/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userId: 'g_fa4b74a890', password: 'MkReDWuUO0twmNDVzNIFSrc-UXciFVdE' }),
})).json();
const c = new AetheriaClient({ token: auth.token });
const cl = await c.listCharacters();
const ch = cl.characters?.[0];
console.log('spare char:', ch?.name, '| current map:', ch?.mapName);
await c.connect(ch.characterId);
await c.waitJoin();
c.arrived();
await new Promise((r) => setTimeout(r, 2500));
console.log('joined map:', c.mapId);

let dialog = null;
c.on('message', (type, data) => { if (type === 'npc_dialog') dialog = data; });

async function probe(key, walkPx) {
  dialog = null;
  if (walkPx) { c.moveToPx(walkPx[0], walkPx[1]); await new Promise((r) => setTimeout(r, 6000)); }
  c.npcTalk(key);
  await new Promise((r) => setTimeout(r, 1600));
  if (dialog) {
    console.log(`\n[${key}] ${dialog.name} :: ${String(dialog.text).slice(0, 90)}`);
    console.log('  options:', JSON.stringify(dialog.options));
    c.npcClose();
    await new Promise((r) => setTimeout(r, 400));
    return dialog;
  }
  console.log(`[${key}] no dialog`);
  return null;
}

// 1) Healer Mira (n1) at the peco-standing prop
const mira = await probe('n1', [2288, 1168]);
// 2) if a rent-ish option exists, click it and capture the follow-up
if (mira) {
  const idx = (mira.options ?? []).findIndex((o) => /เช่า|peco|Peco|ขี่|ขี่เปโก/i.test(o));
  if (idx >= 0) {
    dialog = null;
    c.npcOption(idx);
    await new Promise((r) => setTimeout(r, 1800));
    console.log('\n>>> rent option follow-up:', JSON.stringify(dialog, null, 1).slice(0, 900));
    c.npcClose();
  } else {
    console.log('\n(NO rent keyword option on Mira)');
  }
}
// 3) Training Master key hunt (npcId 210) — try likely keys near Mira's walk spot
await probe('n13');
await probe('n14');
c.close();
process.exit(0);
