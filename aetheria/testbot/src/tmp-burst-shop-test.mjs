// tmp-burst-shop-test.mjs — RACE THE PULL: burst npc_talk → npc_option → shop_sell from the fountain.
// The server auto-walks you to the NPC after npc_talk; if its sell validation is session-based (not
// distance-based), the burst lands the sell before the walk completes — "selling without walking".
// Then the same for storage (talk+option+storage_put) and warp (talk+option+npc_warp). [RESULT] lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log('[burst]', ...a);
const R = (...a) => console.log('[RESULT]', ...a);

const jpost = async (p, body = {}, token = null) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const jget = async (p, token) => {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const WORDS_A = ['Swift', 'Brave', 'Calm', 'Sharp', 'Loyal', 'Quiet', 'Merry', 'Deft'];
const WORDS_B = ['Finch', 'Osprey', 'Magpie', 'Linnet', 'Kestrel', 'Plover', 'Sparrow', 'Martin'];

const trail = [];
let client = null;
try {
  let acct = null, chr = null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(here, '..', 'out', 'pull2-account.json'), 'utf8'));
    const lo = await jpost('/auth/login', { userId: s.userId, password: s.password });
    if (lo.status === 200 && lo.json.token) {
      acct = { userId: s.userId, token: lo.json.token };
      const list = await jget('/characters', acct.token);
      const chars = Array.isArray(list.json) ? list.json : (list.json?.characters ?? []);
      if (chars.length) chr = { name: chars[0].name, characterId: chars[0].characterId };
    }
  } catch {}
  if (!acct || !chr) {
    for (let i = 0; i < 3 && !acct; i++) {
      const userId = 'zzburst' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
      const password = 'P!' + Math.random().toString(36).slice(2, 10) + 'x9';
      const reg = await jpost('/auth/register', { userId, password });
      if (reg.status === 200 && reg.json.token) acct = { userId, password, token: reg.json.token };
      else await sleep(7000);
    }
    const name = WORDS_A[Math.floor(Math.random() * WORDS_A.length)] + WORDS_B[Math.floor(Math.random() * WORDS_B.length)] + (10 + Math.floor(Math.random() * 89));
    const ch = await jpost('/characters', { name }, acct.token);
    chr = { name, characterId: ch.json.characterId };
  }
  L('account', acct.userId, chr?.name);

  client = new AetheriaClient({ token: acct.token });
  client.on('message', (type, data) => {
    trail.push({ at: Date.now(), type });
    if (type === 'travel') { client.rejoinRoom(data).then(() => L('rejoined · map', client.mapId)).catch(() => {}); }
  });
  client.on('error', (e) => L('client error:', JSON.stringify(e).slice(0, 140)));

  await client.connect(chr.characterId);
  await sleep(5000);
  if (client.mapId === 'jail') { R('FATAL', 'jailed'); throw new Error('jail'); }
  if (client.mapId !== 'capital') { R('FATAL', 'not capital: ' + client.mapId); throw new Error('map'); }
  await sleep(2000);

  const P = () => (client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null);
  const STA = () => {
    const c = client.msgs.get('character')?.data ?? {};
    const inv = (client.msgs.get('inventory')?.data?.items ?? []);
    const carrot = inv.find((x) => /carrot/i.test(x.name ?? ''));
    return { zeny: c.zeny ?? null, carrotQty: carrot?.qty ?? 0, carrotSlot: carrot?.slot ?? null, invCount: inv.reduce((a, x) => a + (x.qty ?? 1), 0) };
  };
  const trailSince = (t0) => [...new Set(trail.filter((x) => x.at >= t0).map((x) => x.type))].join(',');
  const FOUNTAIN = { x: 1664, y: 1837 }, BOR = { x: 880, y: 1520 }, ALICE = { x: 1808, y: 1616 };
  const dist = (p, b) => Math.round(Math.hypot((p?.x ?? 0) - b.x, (p?.y ?? 0) - b.y));

  const park = async (pt) => {
    for (let i = 0; i < 30; i++) {
      const lv = client.live;
      if (lv && Math.hypot(lv.x - pt.x, lv.y - pt.y) < 60) break;
      client.moveToPx(pt.x, pt.y);
      await sleep(900);
    }
    try { client.arrived(); } catch {}
    await sleep(500);
  };

  // ================= TEST 1: BURST SELL from the fountain =================
  await park(FOUNTAIN);
  let st = STA();
  R('t1_setup', 'pos=' + JSON.stringify(P()) + ' dist_bor=' + dist(P(), BOR) + ' ' + JSON.stringify(st));
  if (st.carrotSlot == null) { R('t1_burst_sell', 'SKIP (no carrot)'); }
  else {
    const before = st; const t0 = Date.now();
    client.npcTalk('n2');
    await sleep(110);
    client.npcOption(0);
    await sleep(110);
    client.shopSellMany([{ slot: before.carrotSlot, qty: 1 }]);
    const traj = [];
    for (let i = 0; i < 10; i++) { await sleep(600); if (i % 2 === 0) traj.push(JSON.stringify(P())); }
    const after = STA();
    R('t1_burst_sell', `before=${JSON.stringify(before)} after=${JSON.stringify(after)} pos_traj=${traj.join(' ')} msgs=[${trailSince(t0)}]`);
    R('t1_burst_sell_verdict', (after.carrotQty < before.carrotQty || (after.zeny ?? 0) > (before.zeny ?? 0)) ? '🎉 ACCEPTED — SOLD FROM AFAR' : 'REJECTED — no sale');
    try { client.npcClose(); } catch {}
    await sleep(700);
  }

  // back to the fountain for a clean t2
  await park(FOUNTAIN);

  // ================= TEST 2: BURST STORAGE =================
  st = STA();
  R('t2_setup', 'pos=' + JSON.stringify(P()) + ' dist_alice=' + dist(P(), ALICE) + ' carrotQty=' + st.carrotQty + ' slot=' + st.carrotSlot);
  if (st.carrotSlot == null) { R('t2_burst_storage', 'SKIP (no item)'); }
  else {
    const before = st; const t0 = Date.now();
    client.npcTalk('n7');
    await sleep(110);
    client.npcOption(2); // storage
    await sleep(110);
    client.storagePut(before.carrotSlot, 1);
    const traj = [];
    for (let i = 0; i < 8; i++) { await sleep(600); if (i % 2 === 0) traj.push(JSON.stringify(P())); }
    const after = STA();
    R('t2_burst_storage', `before=${JSON.stringify(before)} after=${JSON.stringify(after)} pos_traj=${traj.join(' ')} msgs=[${trailSince(t0)}]`);
    R('t2_burst_storage_verdict', after.invCount < before.invCount ? '🎉 ACCEPTED — STORED FROM AFAR' : 'REJECTED — nothing moved');
    try { client.npcClose(); } catch {}
    await sleep(700);
  }

  // ================= TEST 3: BURST WARP =================
  await park(FOUNTAIN);
  R('t3_setup', 'pos=' + JSON.stringify(P()) + ' map=' + client.mapId);
  {
    const t0 = Date.now(); const map0 = client.mapId;
    client.npcTalk('n7');
    await sleep(110);
    client.npcOption(1); // warp
    await sleep(110);
    client.warp('novice_garden');
    let moved = false;
    for (let i = 0; i < 20 && !moved; i++) { await sleep(600); if (client.mapId !== map0) moved = true; }
    R('t3_burst_warp', `map=${map0}->${client.mapId} pos=${JSON.stringify(P())} msgs=[${trailSince(t0)}] => ${client.mapId !== map0 ? '🎉 WARPED (from ' + map0 + '!)' : 'no warp'}`);
    try { client.npcClose(); } catch {}
  }

  R('DONE', {});
} catch (e) {
  R('FATAL', String((e && e.message) || e).slice(0, 300));
} finally {
  try { await client?.leaveGraceful(400); } catch {}
  try { client?.close(); } catch {}
}
process.exit(0);
