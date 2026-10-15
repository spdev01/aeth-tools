// tmp-cold-shop-test.mjs — THE direct-command tests: can we sell/store/warp WITHOUT opening anything?
// Cold-fire each command with no session (no shop, no storage window, no warp menu) and diff the state:
//   working  = inventory shrinks / zeny rises / map changes / travel arrives
//   ignored  = nothing happens (server validates session state)
// Then a LEGIT baseline: walk to Bor, open the shop normally, sell — control group. [RESULT] lines.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log('[cold]', ...a);
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
async function freshAccount() {
  for (let i = 0; i < 3; i++) {
    const userId = 'zzcold' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
    const password = 'P!' + Math.random().toString(36).slice(2, 10) + 'x9';
    const reg = await jpost('/auth/register', { userId, password });
    if (reg.status === 200 && reg.json.token) return { userId, password, token: reg.json.token };
    await sleep(7000);
  }
  throw new Error('register failed');
}

const trail = [];
let client = null;
try {
  // prefer the existing pull2 account; fall back to a fresh registration
  let acct = null, chr = null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(here, '..', 'out', 'pull2-account.json'), 'utf8'));
    const lo = await jpost('/auth/login', { userId: s.userId, password: s.password });
    if (lo.status === 200 && lo.json.token) {
      acct = { userId: s.userId, token: lo.json.token };
      const list = await jget('/characters', acct.token);
      const chars = Array.isArray(list.json) ? list.json : (list.json?.characters ?? []);
      if (chars.length) chr = { name: chars[0].name, characterId: chars[0].characterId };
      L('reusing', s.userId, chr?.name);
    }
  } catch {}
  if (!acct || !chr) {
    acct = await freshAccount();
    L('registered', acct.userId);
    const name = WORDS_A[Math.floor(Math.random() * WORDS_A.length)] + WORDS_B[Math.floor(Math.random() * WORDS_B.length)] + (10 + Math.floor(Math.random() * 89));
    const ch = await jpost('/characters', { name }, acct.token);
    chr = { name, characterId: ch.json.characterId };
  }

  client = new AetheriaClient({ token: acct.token });
  client.on('message', (type, data) => {
    trail.push({ at: Date.now(), type });
    if (type === 'travel') { client.rejoinRoom(data).then(() => L('rejoined · map', client.mapId)).catch(() => {}); }
  });
  client.on('error', (e) => L('client error:', JSON.stringify(e).slice(0, 160)));

  L('connecting…');
  await client.connect(chr.characterId);
  await sleep(5000);
  L('map', client.mapId, 'pos', JSON.stringify(client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null));
  if (client.mapId === 'jail') { R('FATAL', 'account is jailed'); throw new Error('jailed'); }

  const ch0 = client.msgs.get('character')?.data ?? {};
  const inv0 = client.msgs.get('inventory')?.data ?? null;
  const items = (inv0?.items ?? []).map((it) => ({ slot: it.slot, name: it.name, qty: it.qty, sellPrice: it.sellPrice ?? 0 }));
  L('zeny', ch0.zeny, '· items', items.length);
  for (const it of items.slice(0, 10)) L(`  slot ${it.slot}: ${it.name} x${it.qty} (sell ${it.sellPrice})`);
  const sellable = items.find((it) => it.sellPrice > 0 && !/potion|ยา/i.test(it.name ?? '')) ?? items.find((it) => it.sellPrice > 0) ?? items[0] ?? null;
  const RZ = () => {
    const c = client.msgs.get('character')?.data ?? {};
    const inv = client.msgs.get('inventory')?.data ?? {};
    return { zeny: c.zeny ?? null, invCount: (inv.items ?? []).reduce((a, x) => a + (x.qty ?? 1), 0) };
  };
  const trailSince = (t0) => [...new Set(trail.filter((x) => x.at >= t0).map((x) => x.type))].join(',');

  // ---------- COLD 1: storage_put with NO storage window ----------
  if (sellable) {
    const b = RZ(); const t0 = Date.now();
    client.storagePut(sellable.slot, 1);
    await sleep(2500);
    const a = RZ();
    R('cold_storage_put', `slot=${sellable.slot} before=${JSON.stringify(b)} after=${JSON.stringify(a)} msgs=[${trailSince(t0)}] => ${a.invCount < b.invCount ? 'ACCEPTED (item moved!)' : 'IGNORED'}`);
  } else {
    R('cold_storage_put', 'SKIP (no items)');
  }

  // ---------- COLD 2: shop_sell with NO shop ----------
  if (sellable) {
    const b = RZ(); const t0 = Date.now();
    client.shopSell(sellable.slot, 1);
    await sleep(2500);
    const a = RZ();
    R('cold_shop_sell', `slot=${sellable.slot} before=${JSON.stringify(b)} after=${JSON.stringify(a)} msgs=[${trailSince(t0)}] => ${(a.zeny ?? 0) > (b.zeny ?? 0) || a.invCount < b.invCount ? 'ACCEPTED (SOLD!)' : 'IGNORED'}`);
  } else {
    R('cold_shop_sell', 'SKIP (no items)');
  }

  // ---------- COLD 3: shop_sell_many with NO shop ----------
  if (sellable) {
    const b = RZ(); const t0 = Date.now();
    client.shopSellMany([{ slot: sellable.slot, qty: 1 }]);
    await sleep(2500);
    const a = RZ();
    R('cold_shop_sell_many', `slot=${sellable.slot} before=${JSON.stringify(b)} after=${JSON.stringify(a)} msgs=[${trailSince(t0)}] => ${(a.zeny ?? 0) > (b.zeny ?? 0) || a.invCount < b.invCount ? 'ACCEPTED (SOLD!)' : 'IGNORED'}`);
  } else {
    R('cold_shop_sell_many', 'SKIP (no items)');
  }

  // ---------- COLD 4: npc_warp with NO warp menu ----------
  for (const dest of ['novice_garden', 'field_01']) {
    const t0 = Date.now(); const mapBefore = client.mapId; const zBefore = RZ().zeny;
    client.warp(dest);
    let moved = false;
    for (let i = 0; i < 14 && !moved; i++) { await sleep(600); if (client.mapId !== mapBefore) moved = true; }
    R('cold_npc_warp', `dest=${dest} map=${mapBefore}->${client.mapId} zeny=${zBefore}->${RZ().zeny} msgs=[${trailSince(t0)}] => ${client.mapId === dest ? 'ACCEPTED (WARPED!)' : 'IGNORED'}`);
    if (client.mapId === dest) break;
  }
  if (client.mapId !== 'capital') {
    // walked-away? just report; the legit test needs capital
    L('not in capital anymore — skipping legit baseline');
  } else {
    // ---------- LEGIT baseline: walk to Bor, open shop normally, sell ----------
    const BOR = { x: 880, y: 1520 };
    for (let i = 0; i < 30; i++) {
      const lv = client.live;
      if (lv && Math.hypot(lv.x - BOR.x, lv.y - BOR.y) < 60) break;
      client.moveToPx(BOR.x, BOR.y);
      await sleep(900);
    }
    try { client.arrived(); } catch {}
    client.msgs.delete('npc_dialog');
    client.npcTalk('n2');
    await sleep(1500);
    const dlg = client.msgs.get('npc_dialog')?.data ?? null;
    R('legit_bor_dialog', dlg ? 'ARRIVED' : 'NONE');
    if (dlg) {
      client.msgs.delete('shop');
      client.npcOption(0);
      await sleep(2000);
      const shopUp = !!client.msgs.get('shop');
      R('legit_shop_open', shopUp ? 'OK' : 'FAIL');
      if (shopUp && sellable) {
        const b = RZ();
        client.shopSellMany([{ slot: sellable.slot, qty: 1 }]);
        await sleep(2500);
        const a = RZ();
        R('legit_sell', `before=${JSON.stringify(b)} after=${JSON.stringify(a)} => ${(a.zeny ?? 0) > (b.zeny ?? 0) ? 'SOLD (control OK)' : 'no-change?'}`);
        // ---------- BONUS: walk AWAY, sell again while shop may still be open ----------
        const sell2 = (client.msgs.get('inventory')?.data?.items ?? []).find((it) => it.slot === sellable.slot && (it.qty ?? 1) >= 1);
        if (sell2) {
          for (const wx of [1300, 1600, 1664]) { client.moveToPx(wx, 1837); await sleep(1100); }
          await sleep(800);
          const b2 = RZ();
          client.shopSell({ slot: sellable.slot, qty: 1 });
          await sleep(2500);
          const a2 = RZ();
          R('far_sell_after_open', `dist_now=${Math.round(Math.hypot((client.live?.x ?? 0) - 880, (client.live?.y ?? 0) - 1520))} before=${JSON.stringify(b2)} after=${JSON.stringify(a2)} => ${(a2.zeny ?? 0) > (b2.zeny ?? 0) ? 'SOLD FROM AFAR (no distance check at sell time!)' : 'REJECTED/ignored'}`);
        }
      }
    }
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
