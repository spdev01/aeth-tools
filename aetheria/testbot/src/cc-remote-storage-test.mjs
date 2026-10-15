// cc-remote-storage-test.mjs — can the capital storage NPC (Alice, key 'n6') be talked to WITHOUT walking to it?
// Three scenarios, using a throwaway account (never enrolled in the roster):
//   P0  sanity   — walk to n6, talk, open storage (proves key + dialog option flow)
//   A   distance — stand FAR from n6 on the SAME map (capital), talk + try to open
//   B   crossmap — travel to venom_swamp (direct npc_warp first, warp-dialog fallback), talk 'n6' + try to open
// Result lines are prefixed [RESULT] for easy grepping.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const BASE = 'https://www.aetheria-online.in.th';
const here = path.dirname(fileURLToPath(import.meta.url));
const ATLAS = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'world_atlas.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const L = (...a) => console.log('[storage-test]', ...a);
const R = (...a) => console.log('[RESULT]', ...a);

const jpost = async (p, body = {}, token = null) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const jget = async (p, token) => {
  const res = await fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const WORDS_A = ['Sunny', 'Cozy', 'Misty', 'Amber', 'Quiet', 'Mellow', 'Brisk', 'Lucky', 'Velvet', 'Crimson', 'Silver', 'Thorny'];
const WORDS_B = ['Otter', 'Falcon', 'Badger', 'Willow', 'Heron', 'Thistle', 'Ember', 'Marten', 'Osprey', 'Pebble', 'Rowan', 'Sable'];

const CREDS_FILE = path.join(here, '..', 'out', 'remote-storage-test-account.json');
async function makeAccount() {
  try {
    const saved = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (saved?.userId && saved?.password) {
      const lo = await jpost('/auth/login', { userId: saved.userId, password: saved.password });
      if (lo.status === 200 && lo.json.token) { L('reusing throwaway account', saved.userId); return { userId: saved.userId, password: saved.password, token: lo.json.token }; }
      L('saved creds no longer valid — registering anew');
    }
  } catch {}
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

async function makeCharacter(token) {
  try {
    const list = await jget('/characters', token);
    const chars = Array.isArray(list.json) ? list.json : (list.json?.characters ?? []);
    if (chars.length) { const c = chars[0]; L('reusing character', c.name, '#' + c.characterId); return { name: c.name, characterId: c.characterId }; }
  } catch {}
  for (let i = 0; i < 6; i++) {
    const name = WORDS_A[Math.floor(Math.random() * WORDS_A.length)] + WORDS_B[Math.floor(Math.random() * WORDS_B.length)] + (10 + Math.floor(Math.random() * 89));
    const ch = await jpost('/characters', { name }, token);
    if (ch.status === 200 && ch.json.characterId) return { name, characterId: ch.json.characterId };
    L('char attempt', i + 1, 'rejected:', ch.status, JSON.stringify(ch.json).slice(0, 120));
    await sleep(1600);
  }
  throw new Error('character creation failed');
}

// dialog helpers — the server pushes type 'npc_dialog' ({ options: [...] }); the storage window is type 'storage'
const optEntries = (dialog) => {
  const opts = dialog?.options ?? dialog?.choices ?? [];
  return opts.map((o, i) => {
    if (typeof o === 'string') return { index: i, text: o };
    return { index: o.index ?? o.id ?? o.key ?? i, text: String(o.text ?? o.label ?? o.name ?? JSON.stringify(o)) };
  });
};
const pick = (dialog, needles) => optEntries(dialog).find((e) => needles.some((n) => e.text.includes(n))) ?? null;

const dist = (a, b) => Math.round(Math.hypot((a?.x ?? 0) - b.x, (a?.y ?? 0) - b.y));

// walk like the runner/probes do: re-issue move_to until at the target (or give up)
async function parkAt(c, x, y, { tol = 60, iters = 26 } = {}) {
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

async function waitMsg(c, type, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const m = c.msgs.get(type); if (m && m.at >= t0 - 300) return m.data; await sleep(300); }
  return null;
}

async function tryOpenStorage(c, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    c.msgs.delete('npc_dialog'); c.msgs.delete('storage');
    c.npcTalk('n6');
    const dlg = await waitMsg(c, 'npc_dialog', 12000);
    if (!dlg) { if (attempt === 2) { R(label, 'open=FAIL reason=no-npc_dialog-in-12s'); return { ok: false, dialog: null }; } L(label, 'no dialog on attempt', attempt, '— retrying'); await sleep(1500); continue; }
    L(label, 'npc_dialog:', JSON.stringify(optEntries(dlg)).slice(0, 400));
    const storageOpt = pick(dlg, ['คลัง', 'ฝาก', 'storage']);
    if (!storageOpt) { R(label, 'open=FAIL reason=no-storage-option (different NPC? see dialog above)'); c.npcClose(); await sleep(500); return { ok: false, dialog: dlg }; }
    c.npcOption(storageOpt.index);
    const sto = await waitMsg(c, 'storage', 9000);
    if (sto) R(label, 'open=OK storageMsg=' + JSON.stringify({ slots: sto?.slots, items: (sto?.items ?? []).length, zeny: sto?.zeny }));
    else R(label, 'open=FAIL reason=no-storage-window-after-option');
    c.npcClose(); await sleep(600);
    return { ok: !!sto, dialog: dlg };
  }
  return { ok: false, dialog: null };
}

let client = null;
let acct = null, chr = null;
let travelMsg = null;
let travelCount = 0;
const trail = []; // every message type w/ timestamp — makes silent failures diagnosable

try {
  L('getting throwaway account…');
  acct = await makeAccount();
  chr = await makeCharacter(acct.token);
  L('account', acct.userId, '· character', chr.name, '#' + chr.characterId);
  try { fs.writeFileSync(CREDS_FILE, JSON.stringify({ userId: acct.userId, password: acct.password, character: chr }, null, 1)); } catch {}

  client = new AetheriaClient({ token: acct.token });
  client.on('message', (type, data) => {
    trail.push({ at: Date.now(), type });
    if (type === 'travel') {
      travelCount++; travelMsg = { at: Date.now(), d: data };
      L('travel msg ->', data?.mapId, '(auto-rejoin)');
      client.rejoinRoom(data).then(() => L('rejoined · map', client.mapId)).catch((e) => L('rejoin err', String((e && e.message) || e).slice(0, 100)));
    }
    if (type === 'npc_dialog') L('npc_dialog peek:', JSON.stringify(data).slice(0, 260));
  });
  client.on('error', (e) => L('client error:', JSON.stringify(e).slice(0, 200)));

  await client.connect(chr.characterId);
  await sleep(5000);
  L('connected · map', client.mapId, '· pos', client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null);
  const N6 = { x: 1808, y: 1616 }; // Alice (storage + warp NPC) = NPCS.n6 in capital
  const trailSince = (t0) => trail.filter((x) => x.at >= t0).map((x) => x.type).join(',');

  // positions persist across sessions — a previous run may have parked us on another map; walk back first
  const RETURNS = { field_01: { x: 128, y: 1328 }, novice_garden: { x: 3456, y: 1424 } };
  if (client.mapId !== 'capital') {
    const back = RETURNS[client.mapId];
    if (back) {
      L('starting on', client.mapId, '— walking back to capital');
      for (let i = 0; i < 25 && client.mapId !== 'capital'; i++) { client.moveToPx(back.x, back.y); await sleep(900); }
      for (let i = 0; i < 12 && client.mapId !== 'capital'; i++) await sleep(900);
      L('now on', client.mapId);
    }
    if (client.mapId !== 'capital') { R('FATAL', 'cannot return to capital (map=' + client.mapId + ')'); throw new Error('not in capital'); }
    await sleep(2500);
  }

  // ---------- P0: sanity — at the NPC ----------
  R('P0_start', 'map=' + client.mapId);
  await parkAt(client, N6.x, N6.y);
  const d0 = dist(client.live, N6);
  L('P0 parked · dist', d0);
  let t1 = Date.now();
  const p0 = await tryOpenStorage(client, 'P0_at_npc');
  R('P0_at_npc', 'dist=' + d0, 'open=' + (p0.ok ? 'OK' : 'FAIL'), 'msgs=[' + trailSince(t1) + ']');

  // ---------- A: distant, same map — walk WEST along the market street (y≈1616 — the road the runners use daily) ----------
  for (const wx of [1600, 1400, 1200, 1000, 800, 600, 450]) { client.moveToPx(wx, 1616); await sleep(1100); }
  await sleep(1500);
  const dA = dist(client.live, N6);
  const liveAge = client.live ? Date.now() - (client.live.at || 0) : -1;
  L('A walked · live', JSON.stringify(client.live ? { x: Math.round(client.live.x), y: Math.round(client.live.y) } : null), '· dist', dA, '· liveAt age ms', liveAge, '· travels', travelCount);
  t1 = Date.now();
  const a = await tryOpenStorage(client, 'A_distant_same_map');
  R('A_distant_same_map', 'dist=' + dA, 'liveAge=' + liveAge, 'open=' + (a.ok ? 'OK' : 'FAIL'), 'msgs=[' + trailSince(t1) + ']');

  // ---------- B: cross-map — walk through the WEST exit (48,1728) to novice_garden (safe, no mobs), then try 'n6' there ----------
  const tB = travelCount;
  let arrived = false;
  for (let i = 0; i < 30 && !arrived; i++) {
    if (client.mapId === 'novice_garden') { arrived = true; break; }
    client.moveToPx(48, 1728);
    await sleep(900);
  }
  for (let i = 0; i < 12 && !arrived; i++) { await sleep(900); if (client.mapId === 'novice_garden') arrived = true; }
  R('B_travel', 'map=' + client.mapId, 'travels=' + (travelCount - tB));

  if (client.mapId === 'novice_garden') {
    await sleep(1200);
    L('B on novice_garden · dead=', client.live?.dead);
    t1 = Date.now();
    const b = await tryOpenStorage(client, 'B_offmap');
    R('B_offmap', 'map=novice_garden', 'dead=' + (client.live?.dead ?? '?'), 'open=' + (b.ok ? 'OK' : 'FAIL'), 'dialog=' + (b.dialog ? JSON.stringify(optEntries(b.dialog)).slice(0, 220) : 'none'), 'msgs=[' + trailSince(t1) + ']');
  } else {
    R('B_offmap', 'SKIPPED (never left capital — travel failed, map=' + client.mapId + ')');
  }

  R('DONE', 'P0=' + (p0.ok ? 'OK' : 'FAIL'), 'B_travel_map=' + client.mapId);
} catch (e) {
  R('FATAL', String(e && e.stack || e).slice(0, 500));
} finally {
  try { await client?.leaveGraceful(500); } catch {}
  try { client?.close(); } catch {}
  L('finished — throwaway account:', acct?.userId ?? '(none)');
}
process.exit(0);
