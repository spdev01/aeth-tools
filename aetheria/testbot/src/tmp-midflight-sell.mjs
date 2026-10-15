// tmp-midflight-sell.mjs — airtight probe of the last hole: shop open + sell DURING the server's pull walk.
// talk n2 → wait for the npc_dialog push (session live, pull started) → option 0 (shop) → wait for shop push
// → shop_sell_many IMMEDIATELY while still mid-walk (hundreds of px from Bor). If a sell ever lands while
// far, it's a timing window worth knowing about. [RESULT] lines carry positions at each step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log('[midflight]', ...a);
const R = (...a) => console.log('[RESULT]', ...a);
const jpost = async (p, body = {}, token = null) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const jget = async (p, token) => {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const trail = [];
let client = null;
try {
  const s = JSON.parse(fs.readFileSync(path.join(here, '..', 'out', 'pull2-account.json'), 'utf8'));
  const lo = await jpost('/auth/login', { userId: s.userId, password: s.password });
  if (lo.status !== 200 || !lo.json.token) throw new Error('login failed (jailed?)');
  const acct = { userId: s.userId, token: lo.json.token };
  const list = await jget('/characters', acct.token);
  const chars = Array.isArray(list.json) ? list.json : (list.json?.characters ?? []);
  const chr = { name: chars[0]?.name, characterId: chars[0]?.characterId };

  client = new AetheriaClient({ token: acct.token });
  client.on('message', (type, data) => {
    trail.push({ at: Date.now(), type });
    if (type === 'travel') { client.rejoinRoom(data).then(() => L('rejoined · map', client.mapId)).catch(() => {}); }
  });
  client.on('error', (e) => L('client error:', JSON.stringify(e).slice(0, 140)));

  await client.connect(chr.characterId);
  await sleep(5000);
  if (client.mapId !== 'capital') { R('FATAL', 'map=' + client.mapId); throw new Error('map'); }

  const P = () => (client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null);
  const distTo = (b) => Math.round(Math.hypot((client.live?.x ?? 0) - b.x, (client.live?.y ?? 0) - b.y));
  const STA = () => {
    const c = client.msgs.get('character')?.data ?? {};
    const inv = client.msgs.get('inventory')?.data?.items ?? [];
    const carrot = inv.find((x) => /carrot/i.test(x.name ?? ''));
    return { zeny: c.zeny ?? null, carrotQty: carrot?.qty ?? 0, slot: carrot?.slot ?? null };
  };
  const BOR = { x: 880, y: 1520 }, FOUNTAIN = { x: 1664, y: 1837 };

  for (let i = 0; i < 30; i++) {
    const lv = client.live;
    if (lv && Math.hypot(lv.x - FOUNTAIN.x, lv.y - FOUNTAIN.y) < 60) break;
    client.moveToPx(FOUNTAIN.x, FOUNTAIN.y);
    await sleep(900);
  }
  try { client.arrived(); } catch {}
  await sleep(500);
  const before = STA();
  R('setup', 'pos=' + JSON.stringify(P()) + ' dist_bor=' + distTo(BOR) + ' ' + JSON.stringify(before));

  const t0 = Date.now();
  client.msgs.delete('npc_dialog'); client.msgs.delete('shop');
  client.npcTalk('n2');
  // wait for the dialog to actually arrive (session live; pull in progress)
  let dlgAt = 0;
  for (let i = 0; i < 40; i++) { await sleep(100); if (client.msgs.get('npc_dialog')) { dlgAt = Date.now() - t0; break; } }
  const posAtDialog = P(); const dAtDialog = distTo(BOR);
  R('dialog', `arrived after ${dlgAt}ms · pos=${JSON.stringify(posAtDialog)} dist_bor=${dAtDialog}`);

  client.npcOption(0); // open the shop while mid-walk
  let shopAt = 0;
  for (let i = 0; i < 30; i++) { await sleep(100); if (client.msgs.get('shop')) { shopAt = Date.now() - t0; break; } }
  const posAtShop = P(); const dAtShop = distTo(BOR);
  R('shop_open', shopAt ? `push after ${shopAt}ms · pos=${JSON.stringify(posAtShop)} dist_bor=${dAtShop}` : `NO shop push (pos=${JSON.stringify(posAtShop)} dist_bor=${dAtShop})`);

  if (shopAt && before.slot != null) {
    // sell right now — mid-walk, still far
    const dAtSell = distTo(BOR);
    client.shopSellMany([{ slot: before.slot, qty: 1 }]);
    await sleep(2500);
    const after = STA();
    const dNow = distTo(BOR);
    R('midflight_sell', `sold_at_dist=${dAtSell} · before=${JSON.stringify(before)} after=${JSON.stringify(after)} · now_dist=${dNow} => ${(after.zeny ?? 0) > (before.zeny ?? 0) ? '🎉 SOLD MID-FLIGHT' : 'REJECTED'}`);
  } else {
    // keep walking a bit and retry once we're close (sanity: the same command works when near)
    await sleep(4000);
    const dNear = distTo(BOR);
    const b2 = STA();
    client.shopSellMany([{ slot: before.slot, qty: 1 }]);
    await sleep(2500);
    const a2 = STA();
    R('near_sell_sanity', `dist=${dNear} before=${JSON.stringify(b2)} after=${JSON.stringify(a2)} => ${(a2.zeny ?? 0) > (b2.zeny ?? 0) ? 'SOLD (control ok)' : 'no change'}`);
  }
  try { client.npcClose(); } catch {}
  R('DONE', {});
} catch (e) {
  R('FATAL', String((e && e.message) || e).slice(0, 300));
} finally {
  try { await client?.leaveGraceful(400); } catch {}
  try { client?.close(); } catch {}
}
process.exit(0);
