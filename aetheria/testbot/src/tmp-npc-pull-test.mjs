// tmp-npc-pull-test.mjs — DOES THE SERVER WALK THE CHARACTER to the NPC when npc_talk opens a dialog?
// The browser audit showed ZERO client move frames yet the user SAW movement → server-side pull suspected.
// Protocol-level: park at the fountain, record live position, remote-talk, poll position for drift toward
// the NPC's coordinates. [RESULT] lines carry the numbers. Throwaway account.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log('[probe]', ...a);
const R = (...a) => console.log('[RESULT]', ...a);

const jpost = async (p, body = {}, token = null) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const CREDS_FILE = path.join(here, '..', 'out', 'remote-npc-test-account.json');
let client = null, acct = null;
try {
  const saved = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const lo = await jpost('/auth/login', { userId: saved.userId, password: saved.password });
  if (lo.status !== 200 || !lo.json.token) throw new Error('creds invalid');
  acct = { userId: saved.userId, token: lo.json.token };
  const chr = saved.character ?? { characterId: null };
  L('account', acct.userId, 'char', chr.name);

  client = new AetheriaClient({ token: acct.token });
  client.on('message', (type, data) => {
    if (type === 'travel') { client.rejoinRoom(data).then(() => L('rejoined · map', client.mapId)).catch(() => {}); }
  });
  client.on('error', (e) => L('client error:', JSON.stringify(e).slice(0, 160)));

  await client.connect(chr.characterId);
  await sleep(5000);

  const RETURNS = { field_01: { x: 128, y: 1328 }, novice_garden: { x: 3456, y: 1424 } };
  if (client.mapId !== 'capital') {
    const back = RETURNS[client.mapId];
    if (back) {
      L('walking back to capital from', client.mapId);
      for (let i = 0; i < 30 && client.mapId !== 'capital'; i++) { client.moveToPx(back.x, back.y); await sleep(900); }
      for (let i = 0; i < 12 && client.mapId !== 'capital'; i++) await sleep(900);
    }
    if (client.mapId !== 'capital') { R('FATAL', 'not in capital (map=' + client.mapId + ')'); throw new Error('not in capital'); }
    await sleep(2500);
  }

  const P = () => (client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null);
  const ALICE = { x: 1808, y: 1616 }, BOR = { x: 880, y: 1520 }, FOUNTAIN = { x: 1664, y: 1837 };
  const dist = (a, b) => Math.round(Math.hypot((a?.x ?? 0) - b.x, (a?.y ?? 0) - b.y));

  // park at the FOUNTAIN (the butterfly-wing landing spot)
  for (let i = 0; i < 30; i++) {
    const lv = client.live;
    if (lv && Math.hypot(lv.x - FOUNTAIN.x, lv.y - FOUNTAIN.y) < 60) break;
    client.moveToPx(FOUNTAIN.x, FOUNTAIN.y);
    await sleep(900);
  }
  try { client.arrived(); } catch {}
  await sleep(600);
  const p0 = P();
  R('parked', 'pos=' + JSON.stringify(p0) + ' dist_alice=' + dist(p0, ALICE) + ' dist_bor=' + dist(p0, BOR));

  // ---- TEST 1: remote talk to Alice (n7) — does the server pull us toward her? ----
  client.msgs.delete('npc_dialog');
  client.npcTalk('n7');
  for (let i = 1; i <= 12; i++) {
    await sleep(600);
    const p = P();
    const dAlice = dist(p, ALICE);
    L(`t1 +${(i * 0.6).toFixed(1)}s pos=${JSON.stringify(p)} dist_alice=${dAlice}`);
    if (i === 6) R('t1_midpoint', 'dist_alice=' + dAlice + ' dialog=' + !!client.msgs.get('npc_dialog'));
  }
  const p1 = P();
  const dlg1 = client.msgs.get('npc_dialog')?.data ?? null;
  R('t1_alice_talk', 'dialog=' + (dlg1 ? 'ARRIVED' : 'NONE') + ' start_dist=' + dist(p0, ALICE) + ' end_dist=' + dist(p1, ALICE) + ' moved=' + Math.round(Math.hypot((p1?.x ?? 0) - (p0?.x ?? 0), (p1?.y ?? 0) - (p0?.y ?? 0))) + 'px');

  // close, then ---- TEST 2: remote talk to Bor (n2) — ~850px away, more visible if pulled ----
  try { client.npcClose(); } catch {}
  await sleep(1200);
  const p2 = P();
  client.msgs.delete('npc_dialog');
  client.npcTalk('n2');
  for (let i = 1; i <= 16; i++) {
    await sleep(600);
    const p = P();
    if (i % 4 === 0) L(`t2 +${(i * 0.6).toFixed(1)}s pos=${JSON.stringify(p)} dist_bor=${dist(p, BOR)}`);
  }
  const p3 = P();
  const dlg2 = client.msgs.get('npc_dialog')?.data ?? null;
  R('t2_bor_talk', 'dialog=' + (dlg2 ? 'ARRIVED' : 'NONE') + ' start_dist=' + dist(p2, BOR) + ' end_dist=' + dist(p3, BOR) + ' moved=' + Math.round(Math.hypot((p3?.x ?? 0) - (p2?.x ?? 0), (p3?.y ?? 0) - (p2?.y ?? 0))) + 'px');
  try { client.npcClose(); } catch {}
  R('DONE', {});
} catch (e) {
  R('FATAL', String((e && e.message) || e).slice(0, 300));
} finally {
  try { await client?.leaveGraceful(400); } catch {}
  try { client?.close(); } catch {}
}
process.exit(0);
