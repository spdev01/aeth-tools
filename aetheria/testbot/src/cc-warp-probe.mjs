// cc-warp-probe.mjs — discover Alice's (n6) warp dialog live and record the exact command sequence.
// usage: node src/cc-warp-probe.mjs <botId> [targetMapId]
// The bot MUST be stopped first (single seat). The script walks to Alice, talks, picks the warp option,
// dumps every dialog/message, selects the target map, and records how the transport completes (travel msg
// + rejoin, or instant room change). Prints a full trail and saves it to out/warp-probe-<ts>.json.
import fs from 'node:fs';
import { AetheriaClient } from './client.js';

const id = process.argv[2] || '38';
const target = process.argv[3] || 'venom_swamp';
const base = `E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/${id}`;
const ses = JSON.parse(fs.readFileSync(base + '/session.json', 'utf8'));
const rs = JSON.parse(fs.readFileSync(base + '/run-state.json', 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trail = [];
let dlgSeq = 0;
let lastDialog = null;

const c = new AetheriaClient({ token: ses.token });
c.on('message', (type, data) => {
  const at = Date.now();
  trail.push({ at, type, data });
  if (type === 'npc_dialog') { dlgSeq++; lastDialog = data; }
  const extra = type === 'npc_dialog' ? ' :: ' + JSON.stringify(data) : (type === 'travel' ? ' :: ' + JSON.stringify(data) : '');
  console.log(`[${new Date(at).toISOString().slice(11, 19)}] MSG ${type}${extra}`);
});
c.on('error', (e) => console.log('ERR', JSON.stringify(e).slice(0, 300)));

const wait = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(150); } return false; };

console.log(`connecting bot ${id} ${rs.charName} charId=${rs.characterId}`);
await c.connect(rs.characterId);
console.log('connected. map =', c.mapId, 'live =', JSON.stringify(c.live));
if (c.mapId !== 'capital') { console.log('NOT IN CAPITAL — abort'); process.exit(3); }

// walk to Alice n6 [1808,1616]
for (let i = 0; i < 25; i++) {
  const lv = c.live;
  if (lv && Math.hypot(lv.x - 1808, lv.y - 1616) < 70) break;
  c.moveToPx(1808, 1616);
  await sleep(900);
}
console.log('at Alice:', JSON.stringify(c.live));

// 1) talk
let s0 = dlgSeq;
c.npcTalk('n6');
await wait(() => dlgSeq > s0, 8000);
console.log('\n=== ALICE DIALOG 1 ===');
console.log(JSON.stringify(lastDialog, null, 1));
const opts1 = lastDialog?.options ?? [];
const warpIdx = opts1.findIndex((o) => /วาร์ป|วาป|warp|เทเลพอร์ต|teleport|ย้าย/i.test(String(o)));
console.log('warp option ->', warpIdx, JSON.stringify(opts1[warpIdx] ?? null));
if (warpIdx < 0) { console.log('NO WARP OPTION — abort'); try { c.npcClose(); } catch {} process.exit(4); }

// 2) choose warp -> map list
s0 = dlgSeq;
c.npcOption(warpIdx);
await wait(() => dlgSeq > s0, 8000);
console.log('\n=== ALICE DIALOG 2 (destinations) ===');
console.log(JSON.stringify(lastDialog, null, 1));

const atlas = JSON.parse(fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/world_atlas.json', 'utf8'));
const zone = atlas.zones.find((z) => z.mapId === target);
const names = [zone?.mapName, zone?.name, target].filter(Boolean);
const opts2 = lastDialog?.options ?? [];
let tIdx = opts2.findIndex((o) => names.some((n) => String(o).includes(n)));
console.log('target option ->', tIdx, JSON.stringify(opts2[tIdx] ?? null), '| zone names:', JSON.stringify(names));
if (tIdx < 0) { console.log('TARGET NOT LISTED — abort'); try { c.npcClose(); } catch {} process.exit(5); }

// 3) choose destination
s0 = dlgSeq;
const t1 = Date.now();
c.npcOption(tIdx);
await wait(() => dlgSeq > s0, 6000);
console.log('\n=== ALICE DIALOG 3 (after destination pick) ===');
console.log(JSON.stringify(lastDialog, null, 1));
// if a confirm-ish dialog appeared after the pick, confirm it
const opts3 = lastDialog?.options ?? [];
if (dlgSeq > s0 && opts3.length) {
  const confIdx = opts3.findIndex((o) => /ยืนยัน|ตกลง|ใช่|confirm|ok|ไป/i.test(String(o)));
  if (confIdx >= 0 && opts3.length <= 3) {
    const s1 = dlgSeq;
    c.npcOption(confIdx);
    console.log('confirmed via option', confIdx, JSON.stringify(opts3[confIdx]));
    await wait(() => dlgSeq > s1, 6000);
    console.log('dialog after confirm:', JSON.stringify(lastDialog));
  }
}

// 4) wait for transport: travel msg OR mapId change
let travelMsg = null; let landed = c.mapId === target;
const t0b = Date.now();
while (Date.now() - t0b < 25000) {
  travelMsg = [...trail].reverse().find((x) => x.type === 'travel') ?? null;
  if (travelMsg || c.mapId === target) { landed = true; break; }
  await sleep(400);
}
console.log('\n=== TRANSPORT ===');
console.log('travel msg:', travelMsg ? JSON.stringify(travelMsg.data) : 'none', '| mapId now:', c.mapId);
if (travelMsg && c.mapId !== target) {
  try { await c.rejoinRoom(travelMsg.data); console.log('rejoined. mapId now:', c.mapId); } catch (e) { console.log('rejoin failed:', String((e && e.message) || e)); }
}
await sleep(1200);
// 5) REST confirmation
try {
  const cl = await c.listCharacters();
  const list = Array.isArray(cl) ? cl : (cl?.characters ?? []);
  const me = list.find((x) => String(x.characterId) === String(rs.characterId));
  console.log('REST says mapName =', me?.mapName, '| online =', me?.online);
} catch (e) { console.log('REST check failed:', String((e && e.message) || e)); }

const outFile = `out/warp-probe-${Date.now()}.json`;
fs.writeFileSync(outFile, JSON.stringify({ id, target, totalMs: Date.now() - t1, trail }, null, 1));
console.log('trail saved ->', outFile);
try { await c.leaveGraceful(400); } catch {}
c.close();
process.exit(0);
