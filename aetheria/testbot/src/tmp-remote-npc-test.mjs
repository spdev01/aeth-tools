// tmp-remote-npc-test.mjs — THE three-question probe (throwaway account, throw THIS away after):
//   Q1 sell    — can Shopkeeper Bor's shop open WITHOUT walking to him?      (shop_sell then rides the open shop)
//   Q2 storage — can Alice's storage window open WITHOUT walking to her?
//   Q3 warp    — can Alice's warp menu open + npc_warp fire WITHOUT walking to her?
// Phases: P0 sanity at the NPCs (learn live npc keys + dialog options) → A from the FOUNTAIN (1664,1837 —
// the butterfly-wing landing spot) → B cross-map. All results greppable as [RESULT].
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
const jget = async (p, token) => {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

// reuse the throwaway creds from the earlier storage probe if still valid
const CREDS_FILE = path.join(here, '..', 'out', 'remote-npc-test-account.json');
const LEGACY_CREDS = path.join(here, '..', 'out', 'remote-storage-test-account.json');
const WORDS_A = ['Sunny', 'Cozy', 'Misty', 'Amber', 'Quiet', 'Mellow', 'Brisk', 'Lucky', 'Velvet', 'Crimson'];
const WORDS_B = ['Otter', 'Falcon', 'Badger', 'Willow', 'Heron', 'Thistle', 'Ember', 'Marten', 'Osprey', 'Pebble'];
async function makeAccount() {
  for (const f of [CREDS_FILE, LEGACY_CREDS]) {
    try {
      const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (saved?.userId && saved?.password) {
        const lo = await jpost('/auth/login', { userId: saved.userId, password: saved.password });
        if (lo.status === 200 && lo.json.token) { L('reusing throwaway account', saved.userId); return { userId: saved.userId, password: saved.password, token: lo.json.token, character: saved.character ?? null }; }
      }
    } catch {}
  }
  for (let i = 0; i < 4; i++) {
    const userId = 'zzprobe' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
    const password = 'P!' + Math.random().toString(36).slice(2, 10) + 'x9';
    const reg = await jpost('/auth/register', { userId, password });
    if (reg.status === 200 && reg.json.token) return { userId: reg.json.user?.userId ?? userId, password, token: reg.json.token };
    L('register attempt', i + 1, 'failed:', reg.status, JSON.stringify(reg.json).slice(0, 120));
    await sleep(6500);
  }
  throw new Error('register failed repeatedly (rate limit?)');
}
async function makeCharacter(token, saved) {
  try {
    const list = await jget('/characters', token);
    const chars = Array.isArray(list.json) ? list.json : (list.json?.characters ?? []);
    if (chars.length) { const c = chars[0]; L('reusing character', c.name, '#' + c.characterId); return { name: c.name, characterId: c.characterId }; }
  } catch {}
  for (let i = 0; i < 6; i++) {
    const name = (saved?.name ?? WORDS_A[Math.floor(Math.random() * WORDS_A.length)] + WORDS_B[Math.floor(Math.random() * WORDS_B.length)] + (10 + Math.floor(Math.random() * 89)));
    const ch = await jpost('/characters', { name }, token);
    if (ch.status === 200 && ch.json.characterId) return { name, characterId: ch.json.characterId };
    await sleep(1600);
  }
  throw new Error('character creation failed');
}

const optEntries = (dialog) => {
  const opts = dialog?.options ?? dialog?.choices ?? [];
  return opts.map((o, i) => (typeof o === 'string' ? { index: i, text: o } : { index: o.index ?? o.id ?? o.key ?? i, text: String(o.text ?? o.label ?? o.name ?? JSON.stringify(o)) }));
};
const pick = (dialog, needles) => optEntries(dialog).find((e) => needles.some((n) => e.text.includes(n))) ?? null;
const dist = (a, b) => Math.round(Math.hypot((a?.x ?? 0) - b.x, (a?.y ?? 0) - b.y));

async function parkAt(c, x, y, { tol = 60, iters = 30 } = {}) {
  for (let i = 0; i < iters; i++) {
    const lv = c.live;
    if (lv && Math.hypot(lv.x - x, lv.y - y) < tol) break;
    c.moveToPx(x, y);
    await sleep(900);
  }
  try { c.arrived(); } catch {}
  await sleep(400);
  return c.live ? { x: Math.round(c.live.x), y: Math.round(c.live.y) } : null;
}
async function waitMsg(c, type, ms, since = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = c.msgs.get(type); if (m && m.at >= Math.max(t0 - 300, since)) return m.data; await sleep(250); }
  return null;
}

// ---------- the three interactions ----------
async function talkTo(c, key, ms = 10000) {
  c.msgs.delete('npc_dialog');
  c.npcTalk(key);
  const d = await waitMsg(c, 'npc_dialog', ms);
  return d;
}
async function resolveAlice(c, label) {
  for (const k of ['n7', 'n6', 'n8', 'n5']) {
    const d = await talkTo(c, k, 9000);
    if (d && (/alice/i.test(String(d.name ?? '')) || String(d.art ?? '') === 'npc/kafra' || (Array.isArray(d.options) && d.options.some((o) => String(o).includes('วาร์ป'))))) {
      L(label, 'Alice key =', k, 'name=', d.name);
      return { key: k, dlg: d };
    }
    if (d) c.npcClose();
    await sleep(400);
  }
  return { key: null, dlg: null };
}
async function resolveBor(c, label) {
  for (const k of ['n2', 'n3', 'n1', 'n4']) {
    const d = await talkTo(c, k, 9000);
    if (d && (/bor/i.test(String(d.name ?? '')) || (Array.isArray(d.options) && d.options.some((o) => /ซื้อ|ขาย/.test(String(o)))))) {
      L(label, 'Bor key =', k, 'name=', d.name);
      return { key: k, dlg: d };
    }
    if (d) c.npcClose();
    await sleep(400);
  }
  return { key: null, dlg: null };
}
async function tryStorage(c, { key = null, label }) {
  const al = key ? { key, dlg: null } : await resolveAlice(c, label);
  if (!al.key) { R(label, 'storage=FAIL reason=alice-not-found'); return false; }
  let d = al.dlg ?? (await talkTo(c, al.key, 9000));
  if (!d) { R(label, 'storage=FAIL reason=no-dialog (key=' + al.key + ')'); return false; }
  const opt = pick(d, ['คลัง', 'ฝาก', 'storage']);
  if (!opt) { R(label, 'storage=FAIL reason=no-storage-option options=' + JSON.stringify(optEntries(d)).slice(0, 300)); c.npcClose(); return false; }
  c.msgs.delete('storage');
  c.npcOption(opt.index);
  const sto = await waitMsg(c, 'storage', 9000);
  R(label, 'storage=' + (sto ? 'OK' : 'FAIL reason=no-storage-window') + ' (key=' + al.key + ' opt=' + JSON.stringify(opt.text).slice(0, 60) + ')');
  c.npcClose(); await sleep(500);
  return !!sto;
}
async function tryShop(c, { key = null, label }) {
  const bo = key ? { key, dlg: null } : await resolveBor(c, label);
  if (!bo.key) { R(label, 'shop=FAIL reason=bor-not-found'); return false; }
  let d = bo.dlg ?? (await talkTo(c, bo.key, 9000));
  if (!d) { R(label, 'shop=FAIL reason=no-dialog (key=' + bo.key + ')'); return false; }
  const opt = pick(d, ['ซื้อ']) ?? pick(d, ['ขาย']) ?? optEntries(d)[0] ?? null;
  if (!opt) { R(label, 'shop=FAIL reason=no-shop-option options=' + JSON.stringify(optEntries(d)).slice(0, 300)); c.npcClose(); return false; }
  c.msgs.delete('shop');
  c.npcOption(opt.index);
  const shop = await waitMsg(c, 'shop', 8000);
  R(label, 'shop=' + (shop ? 'OK' : 'FAIL reason=no-shop-window') + ' (key=' + bo.key + ' opt=' + JSON.stringify(opt.text).slice(0, 60) + ')');
  c.npcClose(); await sleep(500);
  return !!shop;
}
async function tryWarpMenu(c, { key = null, label }) {
  const al = key ? { key, dlg: null } : await resolveAlice(c, label);
  if (!al.key) { R(label, 'warpmenu=FAIL reason=alice-not-found'); return null; }
  let d = al.dlg ?? (await talkTo(c, al.key, 9000));
  if (!d) { R(label, 'warpmenu=FAIL reason=no-dialog (key=' + al.key + ')'); return null; }
  const opt = pick(d, ['วาร์ป']);
  if (!opt) { R(label, 'warpmenu=FAIL reason=no-warp-option options=' + JSON.stringify(optEntries(d)).slice(0, 300)); c.npcClose(); return null; }
  c.msgs.delete('warp_menu');
  c.npcOption(opt.index);
  const wm = await waitMsg(c, 'warp_menu', 8000);
  R(label, 'warpmenu=' + (wm ? 'OK' : 'FAIL reason=no-warp-menu') + ' dests=' + JSON.stringify(wm?.destinations ?? null).slice(0, 200) + ' costs=' + JSON.stringify(wm?.costs ?? null).slice(0, 200));
  if (!wm) return null;
  return wm;
}

let client = null, acct = null, chr = null;
let travelCount = 0;

try {
  L('getting throwaway account…');
  acct = await makeAccount();
  chr = await makeCharacter(acct.token, acct.character);
  L('account', acct.userId, '· character', chr.name, '#' + chr.characterId);
  try { fs.writeFileSync(CREDS_FILE, JSON.stringify({ userId: acct.userId, password: acct.password, character: chr }, null, 1)); } catch {}

  client = new AetheriaClient({ token: acct.token });
  client.on('message', (type, data) => {
    if (type === 'travel') {
      travelCount++;
      L('travel msg ->', data?.mapId, '(auto-rejoin)');
      client.rejoinRoom(data).then(() => L('rejoined · map', client.mapId)).catch((e) => L('rejoin err', String((e && e.message) || e).slice(0, 100)));
    }
    if (type === 'npc_dialog') L('npc_dialog peek:', JSON.stringify(data).slice(0, 220));
  });
  client.on('error', (e) => L('client error:', JSON.stringify(e).slice(0, 200)));

  await client.connect(chr.characterId);
  await sleep(5000);
  L('connected · map', client.mapId, '· pos', client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null);

  // positions persist across sessions — get back to capital first
  const RETURNS = { field_01: { x: 128, y: 1328 }, novice_garden: { x: 3456, y: 1424 } };
  if (client.mapId !== 'capital') {
    const back = RETURNS[client.mapId];
    if (back) {
      L('starting on', client.mapId, '— walking back to capital');
      for (let i = 0; i < 30 && client.mapId !== 'capital'; i++) { client.moveToPx(back.x, back.y); await sleep(900); }
      for (let i = 0; i < 12 && client.mapId !== 'capital'; i++) await sleep(900);
    }
    if (client.mapId !== 'capital') { R('FATAL', 'cannot return to capital (map=' + client.mapId + ')'); throw new Error('not in capital'); }
    await sleep(2500);
  }
  const zeny0 = client.msgs.get('character')?.data?.zeny ?? null;
  L('zeny =', zeny0);

  const BOR = { x: 880, y: 1520 }, ALICE = { x: 1808, y: 1616 }, FOUNTAIN = { x: 1664, y: 1837 };

  // ---------- P0: sanity at the NPCs ----------
  await parkAt(client, BOR.x, BOR.y);
  R('P0_site', 'bor dist=' + dist(client.live, BOR));
  await tryShop(client, { label: 'P0_at_bor' });

  await parkAt(client, ALICE.x, ALICE.y);
  R('P0_site', 'alice dist=' + dist(client.live, ALICE));
  await tryStorage(client, { label: 'P0_at_alice' });

  // ---------- visit novice_garden so the warp menu unlocks a destination ----------
  L('walking out west to novice_garden (unlock a warp destination)…');
  let visited = client.mapId === 'novice_garden';
  for (let i = 0; i < 40 && !visited; i++) { if (client.mapId === 'novice_garden') { visited = true; break; } client.moveToPx(48, 1728); await sleep(900); }
  for (let i = 0; i < 14 && !visited; i++) { await sleep(900); if (client.mapId === 'novice_garden') visited = true; }
  R('visit_novice_garden', 'map=' + client.mapId);
  if (client.mapId === 'novice_garden') {
    // walk back east into capital
    for (let i = 0; i < 40 && client.mapId !== 'capital'; i++) { client.moveToPx(3456, 1424); await sleep(900); }
    for (let i = 0; i < 14 && client.mapId !== 'capital'; i++) { await sleep(900); }
    R('back_to_capital', 'map=' + client.mapId);
    await sleep(2000);
  }

  // ---------- A: from the FOUNTAIN (the butterfly-wing landing spot) ----------
  await parkAt(client, FOUNTAIN.x, FOUNTAIN.y);
  const dAlice = dist(client.live, ALICE), dBor = dist(client.live, BOR);
  R('A_site', 'fountain pos=' + JSON.stringify(client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null) + ' dist_alice=' + dAlice + ' dist_bor=' + dBor);

  await tryStorage(client, { key: null, label: 'A_fountain_storage' });
  await tryShop(client, { key: null, label: 'A_fountain_shop' });
  const wmA = await tryWarpMenu(client, { key: null, label: 'A_fountain_warpmenu' });

  // actually warp remotely to prove the full chain (novice_garden is visited; cost may be 0–300z)
  if (wmA) {
    const dests = wmA.destinations ?? [];
    const dest = ['novice_garden', 'field_01', 'venom_swamp'].find((m) => dests.includes(m)) ?? dests[0] ?? null;
    const cost = wmA.costs?.[dest] ?? 0;
    const zenyNow = client.msgs.get('character')?.data?.zeny ?? 0;
    L('warp target:', dest, 'cost', cost, 'zeny', zenyNow);
    if (dest && zenyNow >= cost) {
      client.msgs.delete('travel');
      const tc = travelCount;
      client.send('npc_warp', { mapId: dest });
      let ok = false;
      for (let i = 0; i < 30 && !ok; i++) { await sleep(600); if (client.mapId === dest || travelCount > tc) ok = true; }
      await sleep(3000);
      R('A_warp_full', 'dest=' + dest + ' cost=' + cost + ' map_now=' + client.mapId + ' travels=' + (travelCount - tc));
    } else {
      R('A_warp_full', 'SKIPPED (dest=' + dest + ' cost=' + cost + ' zeny=' + zenyNow + ')');
    }
  } else {
    R('A_warp_full', 'SKIPPED (no remote warp menu)');
  }
  client.npcClose(); await sleep(400);

  // ---------- B: cross-map remote talk (wherever we ended up) ----------
  await sleep(1500);
  R('B_site', 'map=' + client.mapId);
  const dB1 = await talkTo(client, 'n7', 9000);
  R('B_offmap_alice_talk', 'map=' + client.mapId + ' dialog=' + (dB1 ? JSON.stringify(dB1).slice(0, 200) : 'NONE'));
  if (dB1) client.npcClose();
  await sleep(400);
  const dB2 = await talkTo(client, 'n2', 9000);
  R('B_offmap_bor_talk', 'map=' + client.mapId + ' dialog=' + (dB2 ? JSON.stringify(dB2).slice(0, 200) : 'NONE'));
  if (dB2) client.npcClose();

  client.npcClose();
  R('DONE', 'travels=' + travelCount);
} catch (e) {
  R('FATAL', String((e && e.stack) || e).slice(0, 500));
} finally {
  try { await client?.leaveGraceful(500); } catch {}
  try { client?.close(); } catch {}
  L('finished — throwaway account:', acct?.userId ?? '(none)');
}
process.exit(0);
