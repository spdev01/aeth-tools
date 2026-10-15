// cc-snatch-test.mjs — live SNATCH-STRIKE accounting test, using Deed (213).
//
// Question: when Snatch Strike / Steal takes an item off a monster, does the server send `item_gain`
// (the message BOTH earnings trackers count as a drop), or does the item land silently — in which case
// the charts would MISS stolen loot?
//
// Flow: stop runner → connect as Deed → walk to the nearest monster → cast 'steal' then 'snatcher'
// (~2.5s apart, re-targeting as monsters die) → capture EVERY 0x0d message + bag/zeny/sp → summary
// → disconnect → restart the runner (normal farming resumes).
//
// usage: node src/cc-snatch-test.mjs [botId=213] [onlySkill]   e.g. … 213 snatcher
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const id = parseInt(process.argv[2] || '213', 10);
const CC = 'http://127.0.0.1:4310';
const API = 'https://www.aetheria-online.in.th';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTDIR = path.join(root, '..', 'out-grep');
const OUT = path.join(OUTDIR, `snatch-test-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jpost = async (p, body = '{}') => { try { const r = await fetch(CC + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); return await r.json().catch(() => ({})); } catch { return {}; } };
const jget = async (p) => { try { const r = await fetch(CC + p); return await r.json(); } catch { return null; } };

fs.mkdirSync(OUTDIR, { recursive: true });
const out = fs.createWriteStream(OUT, { flags: 'a' });
const capture = []; // {at,type,data}
const record = (type, data) => {
  let d = data;
  try { d = data === undefined ? null : JSON.parse(JSON.stringify(data)); } catch { d = String(data); }
  const rec = { at: Date.now(), type: String(type), data: d };
  capture.push(rec);
  try { out.write(JSON.stringify(rec) + '\n'); } catch {}
};

// ---- 1) stop the runner ----
console.log(`borrowing bot ${id} for the snatch test`);
await jpost(`/api/bots/${id}/stop`);
let stopped = false;
for (let i = 0; i < 60; i++) { const s = await jget('/api/state'); if (s?.bots?.find((x) => x.id === id)?.state === 'stopped') { stopped = true; break; } await sleep(1500); }
console.log('runner stopped:', stopped);
if (!stopped) { await jpost(`/api/bots/${id}/restart`); process.exit(1); }

// ---- 2) connect as the character ----
const base = `E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/${id}`;
const ses = JSON.parse(fs.readFileSync(base + '/session.json', 'utf8'));
const rs = JSON.parse(fs.readFileSync(base + '/run-state.json', 'utf8'));
const charId = rs.characterId;
const c = new AetheriaClient({ token: ses.token });
c.on('message', (type, data) => record(type, data));
c.on('error', (e) => record('ERR', e));
c.on('close', (code, reason) => record('CLOSE', { code, reason }));
const onlineNow = async () => {
  try {
    const r = await fetch(API + '/characters', { headers: { Authorization: `Bearer ${ses.token}` } });
    const j = await r.json().catch(() => null);
    const list = Array.isArray(j) ? j : (j?.characters ?? []);
    return list.find((x) => String(x.characterId) === String(charId))?.online ?? null;
  } catch { return null; }
};
const doKick = async () => { try { await fetch(`${API}/characters/${charId}/kick`, { method: 'POST', headers: { Authorization: `Bearer ${ses.token}` } }); } catch {} };

let on = await onlineNow();
for (let i = 0; i < 8 && on === true; i++) { await sleep(1500); on = await onlineNow(); }
if (on === true) { console.log('seat held — kicking'); await doKick(); for (let i = 0; i < 6 && (await onlineNow()) === true; i++) await sleep(1500); }
let connected = false;
for (let att = 0; att < 3 && !connected; att++) {
  try { await c.connect(charId); connected = true; }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (/ออนไลน์อยู่แล้ว|already online/.test(msg) && att < 2) { await doKick(); await sleep(2500); continue; }
    throw e;
  }
}
console.log('connected; waiting for world state…');
for (let i = 0; i < 30; i++) { if (c.live) break; await sleep(1000); }
const me0 = c.live;
console.log('live:', JSON.stringify(me0));
if (!me0) { console.log('no world state — aborting'); c.close(); await jpost(`/api/bots/${id}/restart`); process.exit(1); }

// ---- helpers ----
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function nearestMonster(exclude = null) {
  const w = c.world; if (!w?.monsters) return null;
  const me = c.live; if (!me) return null;
  const BOSS_RE = /king|queen|djinn|lord|titan|boss|demon|dragon/i;
  const all = [];
  for (const [mid, mo] of w.monsters) {
    if (mo.dead || (mo.hp ?? 1) <= 0) continue;
    if (exclude && exclude.has(mid)) continue;
    const d = dist({ x: me.x, y: me.y }, { x: mo.x, y: mo.y });
    all.push({ id: mid, x: mo.x, y: mo.y, hp: mo.hp, name: mo.name ?? null, d: Math.round(d), boss: BOSS_RE.test(String(mo.name ?? '')) || (mo.maxHp ?? mo.hp ?? 0) > 30000 });
  }
  if (!all.length) return null;
  const soft = all.filter((m) => !m.boss);
  const pool = soft.length ? soft : all;
  pool.sort((a, b) => a.d - b.d);
  return pool[0];
}
async function moveNear(target, want = 80) {
  for (let i = 0; i < 25; i++) {
    const me = c.live; if (!me) return false;
    const d = dist(me, target);
    if (d < want + 60) return true;
    const ux = (target.x - me.x) / d, uy = (target.y - me.y) / d;
    const step = Math.min(d - want, 260);
    c.moveToPx(me.x + ux * step, me.y + uy * step);
    await sleep(900);
  }
  return false;
}
const last = (type) => [...capture].reverse().find((r) => r.type === type)?.data ?? null;
const bagNow = () => { const ch = last('character'); return ch ? { bag: ch.bag ?? null, zeny: ch.zeny ?? null, sp: ch.sp ?? null } : null; };

// ---- 3) two cast phases: steal first (clean), then snatcher (the strike) ----
const onlySkill = process.argv[3] || null;
const phases = onlySkill ? [{ skill: onlySkill, casts: 14 }] : [{ skill: 'steal', casts: 20 }, { skill: 'snatcher', casts: 20 }];
const phaseResults = [];
const t0All = Date.now();
for (const ph of phases) {
  console.log(`\n===== phase: ${ph.skill} (${ph.casts} casts) =====`);
  const startIdx = capture.length;
  const startBag = bagNow();
  let done = 0, misses = 0;
  const tried = new Set();
  for (let n = 1; n <= ph.casts; n++) {
    const me = c.live;
    if (!me || me.dead) { console.log('me dead/gone — abort phase'); break; }
    if (me.hp < me.maxHp * 0.5) { console.log(`hp low (${me.hp}/${me.maxHp}) — fleeing, stopping phase`); record('TEST', { evt: 'flee', hp: me.hp, maxHp: me.maxHp }); break; }
    let mo = nearestMonster(tried);
    if (!mo || mo.d > 900) { console.log(`  #${n} no monster near — waiting/rescan`); await sleep(2500); mo = nearestMonster(); if (!mo || mo.d > 900) { misses++; if (misses > 6) break; continue; } }
    if (mo.d > 140) { await moveNear(mo); mo = nearestMonster(tried) ?? mo; }
    const probe = { at: Date.now(), meHp: me.hp, meSp: me.sp, mo: { ...mo } };
    record('TEST', { evt: 'cast_try', skill: ph.skill, n, ...probe });
    console.log(`  #${n} cast ${ph.skill} → ${mo.id} (${mo.name ?? '?'} hp=${mo.hp} d=${mo.d}) sp=${me.sp}/${me.maxSp}`);
    c.cast(ph.skill, mo.id);
    tried.add(mo.id);
    done++;
    await sleep(2400);
  }
  const endBag = bagNow();
  phaseResults.push({ skill: ph.skill, casts: done, startBag, endBag, startIdx, endIdx: capture.length });
  await sleep(600);
}

// ---- 4) summary ----
const during = (from, to, type) => capture.slice(from, to).filter((r) => r.type === type);
console.log('\n===== SUMMARY =====');
for (const pr of phaseResults) {
  const gains = during(pr.startIdx, pr.endIdx, 'item_gain');
  const fx = during(pr.startIdx, pr.endIdx, 'skill_fx');
  const myFx = fx.filter((r) => r.data?.casterId === c.reservation?.sessionId || r.data?.casterId === c.live?.selfId);
  const errs = during(pr.startIdx, pr.endIdx, 'ERR');
  const srvErrs = errs.filter((r) => r.data?.kind === 'server_error');
  console.log(`\n[${pr.skill}] casts=${pr.casts}  item_gain=${gains.length}  skill_fx=${fx.length} (mine≈${myFx.length})  server_errors=${srvErrs.length}`);
  console.log(`   bag before: ${JSON.stringify(pr.startBag)}`);
  console.log(`   bag after : ${JSON.stringify(pr.endBag)}`);
  for (const g of gains.slice(0, 10)) {
    const before = capture.filter((r) => r.at < g.at && r.at > g.at - 3000).map((r) => r.type).slice(-6);
    console.log(`   +${((g.at - t0All) / 1000).toFixed(1)}s item_gain ${JSON.stringify(g.data)}  (ctx: ${before.join(',')})`);
  }
  const allTypes = [...new Set(during(pr.startIdx, pr.endIdx, 'MSGALL').length ? [] : capture.slice(pr.startIdx, pr.endIdx).map((r) => r.type))];
  console.log('   message types seen:', allTypes.join(', '));
}

// ---- 5) leave + restart the runner ----
try { await c.leaveGraceful(); } catch {}
c.close();
console.log('\nleft the room. restarting bot', id, '…');
await jpost(`/api/bots/${id}/restart`);
for (let i = 0; i < 40; i++) { const s = await jget('/api/state'); const b = s?.bots?.find((x) => x.id === id); if (b && (b.state === 'running' || b.state === 'queued' || b.state === 'starting')) { console.log('bot state:', b.state); break; } await sleep(1500); }
console.log('\ncapture →', OUT, `(${capture.length} records)`);
process.exit(0);
