// tmp-midflight2.mjs — rigorous mid-flight sell probe v2 (freshness-checked message waits).
// talk n2 → wait for a FRESH npc_dialog (retry talk once if needed) → note position/distance →
// option 0 → wait for a FRESH shop push (note position/distance) → sell immediately, recording the
// distance at sell time. Verdict: can a sell ever land while far from the NPC? [RESULT] lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log('[mf2]', ...a);
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
  if (lo.status !== 200 || !lo.json.token) throw new Error('login failed');
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
  await sleep(6000);
  if (client.mapId !== 'capital') { R('FATAL', 'map=' + client.mapId); throw new Error('map'); }
  await sleep(2500); // let the join settle fully

  const P = () => (client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null);
  const BOR = { x: 880, y: 1520 }, FOUNTAIN = { x: 1664, y: 1837 };
  const distTo = (b) => Math.round(Math.hypot((client.live?.x ?? 0) - b.x, (client.live?.y ?? 0) - b.y));
  const STA = () => {
    const c = client.msgs.get('character')?.data ?? {};
    const inv = client.msgs.get('inventory')?.data?.items ?? [];
    const carrot = inv.find((x) => /carrot/i.test(x.name ?? ''));
    return { zeny: c.zeny ?? null, carrotQty: carrot?.qty ?? 0, slot: carrot?.slot ?? null };
  };
  const fresh = (type, t0) => { const m = client.msgs.get(type); return m && m.at >= t0 ? m : null; };

  for (let i = 0; i < 30; i++) {
    const lv = client.live;
    if (lv && Math.hypot(lv.x - FOUNTAIN.x, lv.y - FOUNTAIN.y) < 60) break;
    client.moveToPx(FOUNTAIN.x, FOUNTAIN.y);
    await sleep(900);
  }
  try { client.arrived(); } catch {}
  await sleep(800);
  const before = STA();
  R('setup', 'pos=' + JSON.stringify(P()) + ' dist_bor=' + distTo(BOR) + ' ' + JSON.stringify(before));

  let dlg = null, dlgAt = 0, dlgPos = null;
  for (let attempt = 1; attempt <= 2 && !dlg; attempt++) {
    const t0 = Date.now();
    client.npcTalk('n2');
    for (let i = 0; i < 60; i++) { await sleep(100); const m = fresh('npc_dialog', t0); if (m) { dlg = m; dlgAt = Date.now() - t0; dlgPos = P(); break; } }
    L('talk attempt', attempt, dlg ? `dialog in ${dlgAt}ms` : 'no dialog in 6s');
  }
  R('dialog', dlg ? `in ${dlgAt}ms · pos=${JSON.stringify(dlgPos)} dist_bor=${distTo(BOR)}` : 'NEVER (2 attempts)');
  if (!dlg) throw new Error('no dialog — aborting');

  const tOpt = Date.now();
  client.npcOption(0);
  let shop = null, shopAt = 0, shopPos = null;
  for (let i = 0; i < 50; i++) { await sleep(100); const m = fresh('shop', tOpt); if (m) { shop = m; shopAt = Date.now() - tOpt; shopPos = P(); break; } }
  R('shop_push', shop ? `in ${shopAt}ms · pos=${JSON.stringify(shopPos)} dist_bor=${distTo(BOR)}` : `NO shop push in 5s (pos=${JSON.stringify(P())} dist_bor=${distTo(BOR)})`);

  const sellDist = distTo(BOR);
  const b2 = STA();
  client.shopSellMany([{ slot: before.slot, qty: 1 }]);
  await sleep(2500);
  const a2 = STA();
  const dNow = distTo(BOR);
  R('sell', `at_sell_dist=${sellDist} shop_push=${shop ? 'yes' : 'no'} before=${JSON.stringify(b2)} after=${JSON.stringify(a2)} now_dist=${dNow} => ${(a2.zeny ?? 0) > (b2.zeny ?? 0) ? 'SOLD' : 'not sold'}`);
  if (shop && sellDist > 150) R('verdict', '🔥 SOLD WHILE FAR — distance gate bypassable mid-flight');
  else if (!shop) R('verdict', 'option refused / no shop while ' + sellDist + 'px away — proximity gate at shop-open too');
  else R('verdict', 'shop only opened when close — nothing new');

  try { client.npcClose(); } catch {}
  R('DONE', {});
} catch (e) {
  R('FATAL', String((e && e.message) || e).slice(0, 300));
} finally {
  try { await client?.leaveGraceful(400); } catch {}
  try { client?.close(); } catch {}
}
process.exit(0);
