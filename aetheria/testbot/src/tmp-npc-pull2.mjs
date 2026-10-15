// tmp-npc-pull2.mjs — DEFINITIVE: does the server move the character when npc_talk opens a remote dialog?
// Fresh throwaway account (the previous one got jailed). Park at the fountain → record position every
// 600ms → remote npc_talk (Alice n7, then Bor n2) → did the position drift toward the NPC? [RESULT] lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log('[pull2]', ...a);
const R = (...a) => console.log('[RESULT]', ...a);

const jpost = async (p, body = {}, token = null) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const jget = async (p, token) => {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const CREDS_FILE = path.join(here, '..', 'out', 'pull2-account.json');
const WORDS_A = ['Swift', 'Brave', 'Calm', 'Sharp', 'Loyal', 'Quiet', 'Merry', 'Deft', 'Bold', 'Keen'];
const WORDS_B = ['Finch', 'Osprey', 'Magpie', 'Linnet', 'Kestrel', 'Plover', 'Sparrow', 'Martin', 'Rook', 'Wren'];

async function getAccount() {
  try {
    const s = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    const lo = await jpost('/auth/login', { userId: s.userId, password: s.password });
    if (lo.status === 200 && lo.json.token) { L('reusing', s.userId); return { ...s, token: lo.json.token }; }
  } catch {}
  for (let i = 0; i < 3; i++) {
    const userId = 'zzpull' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
    const password = 'P!' + Math.random().toString(36).slice(2, 10) + 'x9';
    const reg = await jpost('/auth/register', { userId, password });
    if (reg.status === 200 && reg.json.token) { const acc = { userId, password, token: reg.json.token }; fs.writeFileSync(CREDS_FILE, JSON.stringify(acc, null, 1)); L('registered', userId); return acc; }
    L('register failed', reg.status, JSON.stringify(reg.json).slice(0, 100));
    await sleep(7000);
  }
  throw new Error('register failed');
}
async function getChar(acct) {
  const list = await jget('/characters', acct.token);
  const chars = Array.isArray(list.json) ? list.json : (list.json?.characters ?? []);
  if (chars.length) return { name: chars[0].name, characterId: chars[0].characterId };
  for (let i = 0; i < 5; i++) {
    const name = WORDS_A[Math.floor(Math.random() * WORDS_A.length)] + WORDS_B[Math.floor(Math.random() * WORDS_B.length)] + (10 + Math.floor(Math.random() * 89));
    const ch = await jpost('/characters', { name }, acct.token);
    if (ch.status === 200 && ch.json.characterId) return { name, characterId: ch.json.characterId };
    await sleep(1800);
  }
  throw new Error('char create failed');
}

let client = null;
try {
  const acct = await getAccount();
  const chr = await getChar(acct);
  L('account', acct.userId, 'char', chr.name);

  client = new AetheriaClient({ token: acct.token });
  client.on('message', (type, data) => {
    if (type === 'travel') { client.rejoinRoom(data).then(() => L('rejoined · map', client.mapId)).catch(() => {}); }
  });
  client.on('error', (e) => L('client error:', JSON.stringify(e).slice(0, 160)));

  await client.connect(chr.characterId);
  await sleep(5000);
  L('connected · map', client.mapId, 'pos', JSON.stringify(client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null));

  const RETURNS = { field_01: { x: 128, y: 1328 }, novice_garden: { x: 3456, y: 1424 } };
  if (client.mapId !== 'capital') {
    if (client.mapId === 'jail') { R('FATAL', 'already jailed (fresh account!)'); throw new Error('jailed'); }
    const back = RETURNS[client.mapId];
    if (back) {
      L('walking back to capital from', client.mapId);
      for (let i = 0; i < 30 && client.mapId !== 'capital'; i++) { client.moveToPx(back.x, back.y); await sleep(900); }
      for (let i = 0; i < 12 && client.mapId !== 'capital'; i++) await sleep(900);
    }
    if (client.mapId !== 'capital') { R('FATAL', 'not in capital (map=' + client.mapId + ')'); throw new Error('not capital'); }
    await sleep(2500);
  }

  const P = () => (client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null);
  const ALICE = { x: 1808, y: 1616 }, BOR = { x: 880, y: 1520 }, FOUNTAIN = { x: 1664, y: 1837 };
  const dist = (a, b) => Math.round(Math.hypot((a?.x ?? 0) - b.x, (a?.y ?? 0) - b.y));

  for (let i = 0; i < 30; i++) {
    const lv = client.live;
    if (lv && Math.hypot(lv.x - FOUNTAIN.x, lv.y - FOUNTAIN.y) < 60) break;
    client.moveToPx(FOUNTAIN.x, FOUNTAIN.y);
    await sleep(900);
  }
  try { client.arrived(); } catch {}
  await sleep(800);
  const p0 = P();
  R('parked', 'pos=' + JSON.stringify(p0) + ' dist_alice=' + dist(p0, ALICE) + ' dist_bor=' + dist(p0, BOR));

  // TEST 1 — Alice n7
  client.msgs.delete('npc_dialog');
  client.npcTalk('n7');
  for (let i = 1; i <= 12; i++) {
    await sleep(600);
    const p = P();
    if (i % 3 === 0 || i === 12) L(`t1 +${(i * 0.6).toFixed(1)}s pos=${JSON.stringify(p)} dist_alice=${dist(p, ALICE)}`);
  }
  const p1 = P();
  R('t1_alice_talk', 'dialog=' + (client.msgs.get('npc_dialog') ? 'ARRIVED' : 'NONE') + ' dist_alice: ' + dist(p0, ALICE) + ' -> ' + dist(p1, ALICE) + ' (moved ' + Math.round(Math.hypot((p1?.x ?? 0) - (p0?.x ?? 0), (p1?.y ?? 0) - (p0?.y ?? 0))) + 'px)');
  try { client.npcClose(); } catch {}
  await sleep(1200);

  // TEST 2 — Bor n2
  const p2 = P();
  client.msgs.delete('npc_dialog');
  client.npcTalk('n2');
  for (let i = 1; i <= 14; i++) {
    await sleep(600);
    const p = P();
    if (i % 4 === 0 || i === 14) L(`t2 +${(i * 0.6).toFixed(1)}s pos=${JSON.stringify(p)} dist_bor=${dist(p, BOR)}`);
  }
  const p3 = P();
  R('t2_bor_talk', 'dialog=' + (client.msgs.get('npc_dialog') ? 'ARRIVED' : 'NONE') + ' dist_bor: ' + dist(p2, BOR) + ' -> ' + dist(p3, BOR) + ' (moved ' + Math.round(Math.hypot((p3?.x ?? 0) - (p2?.x ?? 0), (p3?.y ?? 0) - (p2?.y ?? 0))) + 'px)');
  try { client.npcClose(); } catch {}
  R('DONE', {});
} catch (e) {
  R('FATAL', String((e && e.message) || e).slice(0, 300));
} finally {
  try { await client?.leaveGraceful(400); } catch {}
  try { client?.close(); } catch {}
}
process.exit(0);
