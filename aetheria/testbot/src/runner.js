// AETHERIA AUDIT RUNNER — executes the user's leveling sequence step-by-step.
// Usage: node src/runner.js [--upto N] [--char NAME] [--fresh]
// State cursor persisted to out/run-state.json so we can iterate and resume.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// command-center spawns one runner per bot — each gets its own data dir (state/logs/control/status)
const OUT = process.env.AETHERIA_DATA ? path.resolve(process.env.AETHERIA_DATA) : path.join(root, 'out');
const MAPS = path.join(root, 'maps');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(MAPS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const UPTO = parseInt(arg('--upto', '999'), 10);
const CHAR_NAME = arg('--char', null);
const FRESH = argv.includes('--fresh');

// ---------------- external control (command center) ----------------
// control.json {cmd:'run'|'pause'|'stop'} polled by loops; status.json mirrors the latest snapshot for the UI
const CONTROL_FILE = path.join(OUT, 'control.json');
const STATUS_FILE = path.join(OUT, 'status.json');
const readControl = () => { try { return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')); } catch { return null; } };
const writeStatus = (obj) => { try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...obj, ts: Date.now(), pid: process.pid })); } catch {} };
let _ctrlState = 'running';
async function controlWait(bot) {
  for (;;) {
    const cmd = readControl()?.cmd ?? 'run';
    if (cmd === 'stop') {
      try { if (bot?.char?.auto?.enabled) bot.c.autoEnabled(false); } catch {}
      await sleep(700);
      try { await bot?.c?.leaveGraceful?.(600); } catch {}
      try { bot?.c?.close(); } catch {}
      process.exit(0);
    }
    if (cmd !== 'pause') {
      if (_ctrlState === 'paused') { _ctrlState = 'running'; if (bot?.log) bot.log('control_resumed', {}); writeStatus({ state: 'running' }); }
      return;
    }
    if (_ctrlState !== 'paused') {
      _ctrlState = 'paused';
      if (bot?.log) bot.log('control_paused', {});
      try { if (bot?.char?.auto?.enabled) bot.c.autoEnabled(false); } catch {}
      writeStatus({ state: 'paused' });
    }
    await sleep(3000);
  }
}

// ---------------- map/exit routing ----------------
const exitCache = {};
async function loadExits(mapId) {
  if (exitCache[mapId]) return exitCache[mapId];
  const file = path.join(MAPS, `${mapId}.json`);
  let j;
  if (fs.existsSync(file)) j = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    const r = await fetch(`https://www.aetheria-online.in.th/maps/${mapId}.json`);
    if (!r.ok) throw new Error(`map ${mapId}: HTTP ${r.status}`);
    j = await r.json(); fs.writeFileSync(file, JSON.stringify(j));
  }
  const exits = [];
  for (const layer of j.layers ?? []) {
    if (layer.type !== 'objectgroup') continue;
    for (const o of layer.objects ?? []) {
      const toMap = (o.properties ?? []).find((p) => p.name === 'toMap')?.value;
      if (toMap) exits.push({ toMap, cx: o.x + (o.width ?? 0) / 2, cy: o.y + (o.height ?? 0) / 2, name: o.name });
    }
  }
  exitCache[mapId] = exits;
  return exits;
}
async function routePath(from, to) {
  if (from === to) return [];
  const q = [[from, []]]; const seen = new Set([from]);
  while (q.length) {
    const [cur, p] = q.shift();
    let exits = [];
    try { exits = await loadExits(cur); } catch (e) { continue; }
    for (const ex of exits) {
      if (ex.toMap === to) return [...p, ex.toMap];
      if (!seen.has(ex.toMap)) { seen.add(ex.toMap); q.push([ex.toMap, [...p, ex.toMap]]); }
    }
  }
  throw new Error(`no route ${from} -> ${to}`);
}

// ---------------- Bot ----------------
let _atlas = null;
const loadAtlas = () => {
  _atlas ??= JSON.parse(fs.readFileSync(path.join(root, '..', 'world_atlas.json'), 'utf8'));
  return _atlas;
};
class Bot {
  constructor(client, log) {
    this.c = client; this.log = log;
    this.combat = { hp: null, sp: null, maxHp: null, maxSp: null };
    this.stepId = null; this.kills = 0; this.hitsIn = 0; this._loggedIncoming = false;
    this.lastTargets = []; this.weaves = 0; this._lastWeave = 0;
    this.charId = null;
    this.bind();
  }
  bind() {
    this.s = {
      map: null, character: null, inventory: null, dialog: null, dialogSeq: 0,
      shop: null, market: null, refine: null, travel: null, chats: [], unknownDumped: new Set(),
      charSeq: 0, lastAutoOff: null,
    };
    this.c.on('message', (type, data) => {
      const s = this.s;
      if (type === 'character') {
        const p = s.character;
        if (!p || p.baseLevel !== data.baseLevel || p.jobLevel !== data.jobLevel || p.skillPoints !== data.skillPoints || p.statusPoints !== data.statusPoints || p.zeny !== data.zeny) {
          this.log('CHARACTER', { base: data.baseLevel, job: data.jobLevel, skillPts: data.skillPoints, statPts: data.statusPoints, zeny: data.zeny, classId: data.classId });
        }
        const cb = this.combat;
        if (data.derived) { cb.maxHp = data.derived.maxHp ?? cb.maxHp; cb.maxSp = data.derived.maxSp ?? cb.maxSp; }
        if (cb.hp == null) cb.hp = cb.maxHp;
        if (cb.sp == null) cb.sp = cb.maxSp;
        s.character = data; s.charSeq++; return;
      }
      if (type === 'exp_gain') { this.onKill(data); this.log('kill', { m: data.monster, base: data.base, job: data.job }); return; }
      if (type === 'item_gain') { this.log('drop', { name: data.name, qty: data.qty }); return; }
      if (type === 'levelup') {
        // level-ups fully restore HP/SP in this game — resets our estimate (otherwise it drifts low from unseen auto-heals)
        if (data && data.sessionId === this.selfId()) { this.combat.hp = this.combat.maxHp; this.combat.sp = this.combat.maxSp; }
        this.log('levelup', data); return;
      }
      if (type === 'hit') { this.onHit(data); return; }
      if (type === 'b') {
        for (const it of (Array.isArray(data) ? data : [])) {
          const [n, d] = Array.isArray(it) ? it : [];
          if (n === 'hit') this.onHit(d);
          else if (n === 'exp_gain') this.onKill(d);
        }
        return;
      }
      if (type === 'item_fx') { this.onItemFx(data); return; }
      if (type === 'skill_fx') {
        if (data?.casterId === this.selfId()) {
          this._ownFx = (this._ownFx || 0) + 1;
          this.log('skill_fx_self', { s: data.skillId, t: (data.targets ?? [])[0] ?? null, n: (data.targets ?? []).length });
        }
        return;
      }
      if (type === 'cast') {
        if (data?.casterId === this.selfId()) {
          this._ownCast = (this._ownCast || 0) + 1;
          if (this._ownCast <= 5) this.log('own_cast', { skillId: data.skillId, targetId: data.targetId });
        }
        return;
      }
      if (type === 'notice') { if ((this._notices = (this._notices || 0) + 1) <= 8) this.log('notice', data); return; }
      if (type === 'inventory') { s.inventory = data; return; }
      if (type === 'npc_dialog') { s.dialog = data; s.dialogSeq++; this.log('npc_dialog', data); return; }
      if (type === 'shop') { s.shop = data; this.log('shop', data); return; }
      if (type === 'market') { s.market = data; this.log('market', data); return; }
      if (type === 'market_results') {
        s.market = data; s.marketSeq = (s.marketSeq || 0) + 1;
        this.log('market_results', {
          total: data.total ?? data.listings?.length ?? null,
          listings: (data.listings ?? []).slice(0, 6).map((l) => ({ id: l.listingId, item: l.item?.name ?? l.itemId, price: l.price, qty: l.qty, refine: l.refine })),
        });
        return;
      }
      if (type === 'market_done') { s.marketDone = data; s.marketSeq = (s.marketSeq || 0) + 1; this.log('market_done', data); return; }
      if (type === 'refine') {
        s.refine = data; s.refineSeq = (s.refineSeq || 0) + 1;
        this.log('refine', { mode: data.mode, items: (data.items ?? []).map((x) => `${x.item.name}->+${x.to} (${x.material.name} ${x.material.have}, ${x.zeny}z)`) });
        return;
      }
      if (type === 'travel') { s.travel = data; return; }
      if (type === 'death') { s.death = data; this.combat.hp = 0; this.log('DEATH', data); return; }
      if (type === 'respawned') { s.death = null; this.combat.hp = this.combat.maxHp; this.combat.sp = this.combat.maxSp; this.log('respawned', data); return; }
      if (type === 'chat') { s.chats.push(data); if (s.chats.length > 300) s.chats.shift(); return; }
      if (type === 'collection') { s.collection = data; return; }
      if (type === 'skill_catalog') return;
      if (!s.unknownDumped.has(type)) { s.unknownDumped.add(type); this.log('message:' + type, data); }
    });
    this.c.on('error', (e) => this.log('client_error', e));
    this.c.on('close', (code, reason) => this.log('ws_close', { code, reason }));
  }
  get char() { return this.s.character; }
  selfId() { return this.c.reservation?.sessionId ?? null; }

  // Re-sync current map from REST (characters list mapName) — used after death/reconnect.
  async syncMapFromRest() {
    const cl = await this.c.listCharacters();
    const me = cl.characters?.find((x) => x.characterId === this.charId) ?? cl.characters?.[0];
    if (!me?.mapName) return;
    const zone = loadAtlas().zones.find((z) => z.mapName === me.mapName);
    if (zone?.mapId && zone.mapId !== this.c.mapId) {
      this.log('map_resync', { from: this.c.mapId, to: zone.mapId, mapName: me.mapName });
      this.c.mapId = zone.mapId;
    }
  }

  async deathRecover() {
    this.log('death_recover', this.s.death);
    this.c.send('respawn', { to: 'save' });
    await this.waitFor(() => !this.s.death, 'respawned', 20000).catch(() => {});
    await sleep(2000);
    // fresh session = server-side ground truth. (same-session resume leaves auto_set refused —
    // verified live 12:10-12:13: char alive but setAuto rejected, zero combat for minutes)
    try { await this.reconnect(); this.log('death_recovered', { map: this.c.mapId, via: 'reconnect' }); }
    catch (e) { this.log('death_recover_reconnect_fail', String((e && e.message) || e)); }
    // we're in town anyway — sell whatever junk we have, then restock HP potions
    try { await this.sellJunk(); } catch (e) { this.log('death_recover_sell_fail', String((e && e.message) || e)); }
    try { await this.buyPotions(45); } catch (e) { this.log('pot_buy_fail', String((e && e.message) || e)); }
  }

  potCount() {
    return (this.s.inventory?.items ?? [])
      .filter((i) => i.autoPotion === 'HP')
      .reduce((s, i) => s + (i.qty || 0), 0);
  }

  // Egg -> pet: game rule = item with equipType&&!usable → equip, else inv_use. Collection hint says “ใช้” (use).
  // After hatch, pet_set {petId} activates the pet (follows + fetches drops within 15 tiles).
  async hatchEgg() {
    const ownedBefore = (this.char?.pets?.owned ?? []).length;
    const findEgg = () => (this.s.inventory?.items ?? []).find((x) => /orc|baby/i.test(x.name) && /egg|ไข่/i.test(x.name));
    const eqEgg = Object.entries(this.char?.equipment ?? {}).find(([, v]) => /orc|baby/i.test(v?.name ?? ''));
    let egg = findEgg();
    this.log('pet_hatch_probe', { inBag: egg ? { slot: egg.slot, name: egg.name } : null, equipped: eqEgg ? { slot: eqEgg[0], name: eqEgg[1]?.name } : null, ownedBefore });
    if (!egg && eqEgg) {
      // an earlier equip attempt may have parked it in a slot — unequip so we can use it
      this.c.send('unequip', { slot: eqEgg[0] });
      await sleep(1500);
      egg = findEgg();
    }
    if (egg) {
      this.c.invUse(egg.slot);
      this.log('pet_hatch_use', { slot: egg.slot, name: egg.name });
      try { await this.waitFor(() => (this.char?.pets?.owned ?? []).length > ownedBefore || !findEgg(), 'hatch', 9000); } catch { }
      if ((this.char?.pets?.owned ?? []).length === ownedBefore && findEgg()) {
        this.c.send('equip', { slot: findEgg().slot });
        this.log('pet_hatch_equip_attempt', {});
        await sleep(2500);
      }
    }
    const ownedNow = this.char?.pets?.owned ?? [];
    this.log('pet_hatch_result', { ownedBefore, owned: ownedNow, active: this.char?.pets?.active ?? null });
    if (ownedNow.length && !this.char?.pets?.active) {
      const cat = (this.s.collection?.pets ?? []).find((p) => /orc|baby/i.test(`${p.name ?? ''} ${p.thai ?? ''} ${p.eggName ?? ''}`)) ?? null;
      const petId = cat?.id ?? ownedNow[ownedNow.length - 1];
      if (petId != null) {
        this.c.petSet(petId);
        this.log('pet_set_sent', { petId, catFound: !!cat, cat: cat ? { id: cat.id, name: cat.name, eggName: cat.eggName } : null });
        await sleep(1500);
        this.log('pet_set_readback', { active: this.char?.pets?.active ?? null });
      }
    }
  }

  // n2 Bor "General Goods": Red Potion (90301) 50z. Sells junk first if broke, buys as many as budget allows.
  async buyPotions(target = 25) {
    const have = this.potCount();
    if (have >= target) { this.log('pot_ok', { have }); return have; }
    await this.ensureMap('capital').catch(() => {});
    let zeny = this.char?.zeny ?? 0;
    if (zeny < 600) {
      try { await this.sellJunk(); } catch {}
      await sleep(600);
      zeny = this.char?.zeny ?? 0;
    }
    const budget = Math.max(0, zeny - 200); // keep a small reserve
    const want = Math.min(target - have, Math.floor(budget / 50));
    if (want <= 0) { this.log('pot_no_budget', { have, zeny }); return have; }
    await this.walkToNpc(NPCS.n2);
    await this.talk('n2');
    this.s.shop = null;
    await this.chooseByKeyword('ซื้อของหน่อย', { timeout: 6000 });
    try { await this.waitFor(() => this.s.shop, 'shop', 8000); } catch {}
    const shop = this.s.shop;
    const red = (shop?.items ?? []).find((x) => x.name === 'Red Potion');
    if (red) { this.c.send('shop_buy', { itemId: red.itemId, qty: want }); this.log('buy_potions', { want, have, zeny }); await sleep(2500); }
    else this.log('pot_no_shop', { items: (shop?.items ?? []).slice(0, 6).map((x) => x.name) });
    this.c.npcClose(); await sleep(400);
    this.c.invSort(); await sleep(900);
    const after = this.potCount();
    this.log('pot_restocked', { before: have, after });
    return after;
  }

  // ---- combat/vitals estimate ----
  onHit(h) {
    if (!h || h.miss) return;
    const me = this.selfId();
    if (h.targetId === me) {
      this.hitsIn++;
      // hits on us carry OUR position — the only live position feed we get (move_to only echoes our own sends)
      if (h.x != null && h.y != null) this.selfPos = { x: h.x, y: h.y, t: Date.now() };
      const cb = this.combat;
      cb.hp = Math.max(0, (cb.hp ?? cb.maxHp ?? 0) - (h.damage || 0));
    } else {
      // a mob was hit by someone — candidate for our own skill weaving (see weaveTick)
      if (typeof h.targetId === 'string' && /^m/.test(h.targetId)) {
        if ((this._mobHits = (this._mobHits || 0) + 1) <= 8) this.log('mob_hit_seen', { id: h.targetId, x: h.x, y: h.y, dmg: h.damage });
        this.lastTargets.push({ id: h.targetId, x: h.x, y: h.y, t: Date.now() });
        if (this.lastTargets.length > 40) this.lastTargets.shift();
      }
      if (h.onPlayer && !this._loggedIncoming) {
        this._loggedIncoming = true;
        this.log('incoming_hit_sample', h); // learn the exact shape of player-target hits
      }
    }
  }

  // Our own combat skill usage — the server's auto-skill engine proved unreliable, so we
  // weave casts ourselves at mobs that were just hit near us (hits carry target pos, no attackerId).
  weaveTick(skills) {
    if (!skills?.length || this.s.death || !this.isConnected()) return;
    const ch = this.char; if (!ch || ch.auto?.enabled === false) return;
    const now = Date.now();
    if (now - this._lastWeave < 1350) return;
    const lm = this.c.lastMove;
    const spPos = this.selfPos && (now - this.selfPos.t < 10000) ? this.selfPos : null;
    const ref = spPos || lm; // self-hit position is live; lastMove is stale during auto-farm
    const pick = [...this.lastTargets].reverse().find((t) => {
      if (now - t.t > 2200) return false;
      if (t.x == null || !ref) return true; // can't check range — trust melee proximity
      return Math.hypot(t.x - ref.x, t.y - ref.y) < 160; // within ~5 tiles of us
    });
    if (!pick) {
      this._weaveIdle = (this._weaveIdle || 0) + 1;
      if (this._weaveIdle % 90 === 1) this.log('weave_idle', { mobHitsSeen: this._mobHits || 0, buffered: this.lastTargets.length, selfPos: !!spPos });
      return;
    }
    const sp = this.combat.sp;
    if (sp != null && sp < 30) return; // keep SP margin for the auto engine + regen
    this._lastWeave = now;
    const sid = skills[this.weaves % skills.length];
    this.weaves++;
    this.c.cast(sid, pick.id);
    this.log('skill_use', { s: sid, t: pick.id, sp });
  }
  onKill(g) { if (g && g.monster) this.kills++; }
  onItemFx(d) {
    if (!d || d.sessionId !== this.selfId()) return;
    const cb = this.combat;
    if (d.hp > 0 && cb.maxHp != null) cb.hp = Math.min(cb.maxHp, (cb.hp ?? cb.maxHp) + d.hp);
    if (d.sp > 0 && cb.maxSp != null) cb.sp = Math.min(cb.maxSp, (cb.sp ?? cb.maxSp) + d.sp);
  }

  snap() {
    const c = this.c, s = this.s, ch = s.character, cb = this.combat;
    const lm = c.lastMove;
    const an = ch?.auto?.anchor;
    const inv = s.inventory;
    const used = inv?.items?.length ?? null;
    const free = (inv && inv.slots != null && used != null) ? inv.slots - used : null;
    return {
      step: this.stepId,
      selfId: this.selfId(),
      weapon: ch?.equipment?.['main-hand']?.name ?? null,
      map: c.mapId,
      lastMoveTile: lm ? [+(lm.x / 32).toFixed(1), +(lm.y / 32).toFixed(1)] : null,
      lastMoveAgeSec: lm ? Math.round((Date.now() - lm.t) / 1000) : null,
      anchorTile: an ? [+(an.x / 32).toFixed(1), +(an.y / 32).toFixed(1)] : null,
      hp: cb.hp != null ? Math.round(cb.hp) : null, maxHp: cb.maxHp,
      sp: cb.sp != null ? Math.round(cb.sp) : null, maxSp: cb.maxSp,
      bashLv: ch?.skills?.bash ?? null, hpItems: (ch?.auto?.config?.hpItems ?? []).length, weaves: this.weaves, pots: this.potCount(),
      mobHits: this._mobHits || 0,
      pets: ch?.pets ? { owned: (ch.pets.owned ?? []).length, active: ch.pets.active ? (ch.pets.active.name ?? ch.pets.active.id ?? 'yes') : null } : null,
      stats: ch?.stats ? { STR: ch.stats.STR, AGI: ch.stats.AGI, VIT: ch.stats.VIT, INT: ch.stats.INT, DEX: ch.stats.DEX, LUK: ch.stats.LUK } : null,
      bag: { used, free, weight: inv?.weight ?? null, weightLimit: inv?.weightLimit ?? null },
      zeny: ch?.zeny ?? null, base: ch?.baseLevel ?? null, job: ch?.jobLevel ?? null, classId: ch?.classId ?? null,
      auto: ch?.auto?.enabled ?? null, dead: !!s.death,
      killsTotal: this.kills, hitsInTotal: this.hitsIn,
    };
  }
  startHeartbeat(intervalMs = 20000) {
    const tick = () => { try { this.log('HEARTBEAT', this.snap()); writeStatus({ ...this.snap(), state: _ctrlState }); } catch (e) { try { this.log('HEARTBEAT_ERR', String(e)); } catch {} } };
    tick();
    if (this._hbTimer) clearInterval(this._hbTimer);
    this._hbTimer = setInterval(tick, intervalMs);
  }

  isConnected() { try { return !!(this.c.ws && this.c.ws.readyState === 1); } catch { return false; } }

  // Full re-login/rejoin — used by the turn-key retry loop whenever the session drops.
  async reconnect() {
    this.log('reconnect_start', {});
    await this.relogin(); // tokens expire after hours — refresh before rejoining
    try { await this.c.leaveGraceful(600); } catch {} // free the seat so rejoin succeeds 1st try
    try { this.c.close(); } catch {}
    await sleep(1500);
    for (let i = 1; i <= 12; i++) {
      try {
        await this.c.connect(this.charId);
        const ok = await this.c.waitJoin(12000);
        if (!ok) throw new Error('no join frame');
        this.c.arrived();
        await sleep(2000);
        await this.syncMapFromRest().catch(() => {});
        this.log('reconnect_done', { map: this.c.mapId, attempt: i });
        return true;
      } catch (e) {
        this.log('reconnect_attempt_fail', { attempt: i, err: String((e && e.message) || e) });
        try { this.c.close(); } catch {}
        const msg = String((e && e.message) || e);
        if (/token/i.test(msg)) await this.relogin(); // stale token → refresh and retry
        await sleep(/ออนไลน์อยู่แล้ว|already online|429|too many/i.test(msg) ? 45000 : 5000);
      }
    }
    throw new Error('reconnect failed after 12 attempts');
  }

  // Refresh the session token with env credentials (tokens expire after hours;
  // without this, any death/reconnect after expiry would fail forever).
  async relogin() {
    const u = process.env.AETHERIA_USER, p = process.env.AETHERIA_PASS;
    if (!u || !p) { this.log('relogin_skip', { reason: 'no env credentials' }); return false; }
    try {
      const res = await fetch('https://www.aetheria-online.in.th/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u, password: p }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.token) { this.log('relogin_fail', { status: res.status, err: j && (j.error || j.err) || null }); return false; }
      this.c.token = j.token;
      try { fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify({ token: j.token, createdAt: new Date().toISOString() })); } catch {}
      this.log('relogin_ok', {});
      return true;
    } catch (e) { this.log('relogin_fail', { err: String((e && e.message) || e) }); return false; }
  }

  // items to sell at the vendor: sellPrice>0, not protected (cards/enchants), keep consumables & refine mats & gems
  sellableLines() {
    const inv = this.s.inventory;
    if (!inv?.items) return [];
    const keepRe = /gem|card|enchant|rune|butterfly|carrot|potion|phracon|elunium/i;
    return inv.items
      .filter((it) => (it.sellPrice ?? 0) > 0 && !['Card', 'Enchantment'].includes(it.type) && !keepRe.test(it.name))
      .map((it) => ({ slot: it.slot, qty: it.qty }));
  }
  async waitFor(pred, desc, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (pred()) return true; await sleep(250); }
    throw new Error(`timeout waiting: ${desc}`);
  }

  // -------- actions --------
  async setAuto(patch) {
    const base = this.char?.auto?.config ?? {};
    const cfg = { ...base, ...(patch ?? {}) };
    // the game stores auto skills as an array of skill-id STRINGS (auto panel code); normalize objects too
    if (Array.isArray(cfg.skills)) cfg.skills = cfg.skills.map((s) => (typeof s === 'string' ? s : (s?.id ?? s?.skillId))).filter(Boolean);
    // auto-potion lists = arrays of itemIds; derive from inventory items flagged autoPotion:'HP'|'SP'
    const inv = this.s.inventory?.items ?? [];
    const hpIds = [...new Set([
      ...inv.filter((i) => i.autoPotion === 'HP').map((i) => i.itemId),
      ...inv.filter((i) => /potion|ยา/i.test(i.name || '') && !/(sp|blue|ฟ้า)/i.test(i.name || '')).map((i) => i.itemId),
    ])].slice(0, 4);
    const spIds = [...new Set(inv.filter((i) => i.autoPotion === 'SP').map((i) => i.itemId))].slice(0, 4);
    if (hpIds.length) cfg.hpItems = hpIds;
    if (spIds.length) cfg.spItems = spIds;
    this.c.autoConfig(cfg);
    await sleep(600);
    this.c.autoEnabled(true);
    await this.waitFor(() => this.char?.auto?.enabled === true, 'auto enabled', 6000).catch(() => {});
    const rb = this.char?.auto?.config;
    this.log('setAuto', { skills: rb?.skills ?? cfg.skills, radius: rb?.huntRadiusTiles, monsters: (rb?.monsters ?? []).length, hpItems: (rb?.hpItems ?? []).length, hpPercent: rb?.hpPercent, bashLv: this.char?.skills?.bash ?? null, enabled: this.char?.auto?.enabled, map: this.c.mapId });
    if (this.char?.auto?.enabled !== true) this.log('auto_enable_failed', { map: this.c.mapId });
    return cfg;
  }

  async applyStats(targets, { strict = false, waitMs = 60000 } = {}) {
    const t0 = Date.now();
    let guard = 0;
    while (Date.now() - t0 < waitMs && guard++ < 400) {
      const ch = this.char;
      if (!ch) { await sleep(400); continue; }
      const missing = Object.entries(targets).filter(([k, v]) => (ch.stats?.[k] ?? 0) < v);
      if (!missing.length) return true;
      if ((ch.statusPoints ?? 0) <= 0) {
        if (strict) throw new Error('no stat points but plan incomplete: ' + JSON.stringify(missing));
        return false; // will be applied on next call (levels give more points)
      }
      const [stat] = missing[0];
      this.c.statUp(stat, 1);
      await sleep(350);
    }
    if (strict) throw new Error('stat plan timeout');
    return false;
  }

  async dumpStat(stat, { waitMs = 60000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      const ch = this.char;
      if (!ch || (ch.statusPoints ?? 0) <= 0) return true;
      this.c.statUp(stat, 1);
      await sleep(350);
    }
    return true;
  }

  async applySkills(plan, { wait = false, waitMs = 90 * 60 * 1000, auto = null, farmMap = null } = {}) {
    const levelOf = (ch, id) => {
      const sk = ch.skills;
      if (!sk) return 0;
      if (Array.isArray(sk)) { const e = sk.find((x) => x.id === id || x.skillId === id); return e?.level ?? 0; }
      const v = sk[id]; return typeof v === 'object' ? (v?.level ?? 0) : (v ?? 0);
    };
    const t0 = Date.now();
    const fails = {}; // consecutive no-progress sends per skill (server rejections, e.g. unmet prerequisites)
    while (Date.now() - t0 < waitMs) {
      await controlWait(this);
      const ch = this.char;
      if (!ch) { await sleep(500); continue; }
      if (this.s.death) {
        this.log('skills_death_recover', {});
        await this.deathRecover();
        continue;
      }
      const missing = Object.entries(plan).filter(([id, lv]) => levelOf(ch, id) < lv);
      if (!missing.length) return true;
      if ((ch.skillPoints ?? 0) > 0) {
        // rotate away from skills that keep getting rejected (unmet prereq) so the rest still spend
        const pick = missing.find(([id]) => (fails[id] ?? 0) < 10) ?? missing[0];
        const id = pick[0];
        const before = levelOf(ch, id);
        this.c.skillUp(id);
        this.log('skill_up', { id, target: pick[1] });
        await sleep(500);
        const after = levelOf(this.char ?? { skills: {} }, id);
        if (after > before) fails[id] = 0;
        else {
          fails[id] = (fails[id] ?? 0) + 1;
          if (fails[id] === 10) this.log('skill_up_stuck', { id, at: after, target: pick[1], points: this.char?.skillPoints, missing: missing.map(([i2, l2]) => `${i2}:${levelOf(ch, i2)}/${l2}`) });
        }
        if (missing.every(([i2]) => (fails[i2] ?? 0) >= 10)) {
          this.log('skills_all_blocked', { missing: missing.map(([i2, l2]) => `${i2}:${levelOf(ch, i2)}/${l2}`), points: this.char?.skillPoints });
          await sleep(20000); // back off — likely unmet prereq or points pending; fresh retry follows
          for (const k of Object.keys(fails)) fails[k] = 0;
        }
        continue;
      }
      if (!wait) return false;
      // waiting for job points — keep farming the intended map (and recover if we died meanwhile)
      if (auto) {
        if (farmMap && this.c.mapId !== farmMap) {
          this.log('skills_wait_return', { from: this.c.mapId, to: farmMap });
          await this.ensureMap(farmMap).catch(() => {});
        } else if (this.char?.auto?.enabled === false && Date.now() - (this._lastAutoTry || 0) > 45000) {
          this._lastAutoTry = Date.now();
          this.log('skills_wait_enable_auto', {});
          await this.setAuto(auto);
        }
      }
      await sleep(4000); // farming gives more job levels
    }
    return false;
  }

  async walkToNpc(npcPx) {
    this.c.moveToPx(npcPx[0], npcPx[1]);
    await sleep(1200);
  }

  async sellJunk() {
    // vendor lives in the capital — route there if we're elsewhere (death recovery may leave us in the field)
    await this.ensureMap('capital').catch(() => {});
    await this.walkToNpc(NPCS.n2);
    await this.talk('n2');
    const opt = this.findOption(this.s.dialog, 'ซื้อ') ?? { index: 0 };
    this.s.shop = null;
    this.c.npcOption(opt.index);
    await this.waitFor(() => this.s.shop, 'shop', 8000).catch(() => {});
    const lines = this.sellableLines();
    if (lines.length) { this.c.shopSellMany(lines); this.log('auto_sold', { count: lines.length }); await sleep(1800); }
    this.c.npcClose(); await sleep(400);
  }

  async bankProtected() {
    const inv = this.s.inventory;
    const prot = (inv?.items ?? []).filter((it) => /card|rune|gem/i.test(it.name) && !/phracon|elunium/i.test(it.name));
    if (!prot.length) return 0;
    await this.walkToNpc(NPCS.n6);
    await this.talk('n6');
    const opt = this.findOption(this.s.dialog, 'คลัง');
    if (!opt) { this.c.npcClose(); return 0; }
    this.c.npcOption(opt.index);
    await sleep(1500);
    let n = 0;
    for (const it of prot) { this.c.storagePut(it.slot, it.qty); n++; await sleep(600); }
    this.log('banked', { count: n, items: prot.map((x) => x.name) });
    this.c.npcClose(); await sleep(400);
    return n;
  }

  // Turn-key budget rule: if zeny is short, go farm until the bag fills, sell, repeat.
  async ensureBudget(need, { farmMap = null, auto = null, label = 'budget' } = {}) {
    let guard = 0;
    while ((this.char?.zeny ?? 0) < need && guard++ < 30) {
      this.log('budget_short', { zeny: this.char?.zeny ?? 0, need, farm: farmMap });
      const where = farmMap ?? this.c.mapId;
      await this.ensureMap(where);
      await this.farm({
        until: () => { const w = this.s.inventory; return !!w && w.weight >= w.weightLimit * 0.7; },
        map: where,
        auto: auto ?? { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 60, spPercent: 40 },
        label, timeoutMin: 45,
      });
      await this.ensureMap('capital');
      await this.sellJunk();
    }
    this.log('budget_ok', { zeny: this.char?.zeny ?? 0, need });
    return (this.char?.zeny ?? 0) >= need;
  }

  async talk(npcKey, { timeout = 8000 } = {}) {
    const seq = this.s.dialogSeq;
    this.c.npcTalk(npcKey);
    await this.waitFor(() => this.s.dialogSeq > seq, `dialog from ${npcKey}`, timeout);
    return this.s.dialog;
  }

  optionEntry(o, i) {
    if (typeof o === 'string') return { index: i, text: o };
    return { index: o.index ?? o.id ?? o.key ?? i, text: o.text ?? o.label ?? o.name ?? '' };
  }
  findOption(dialog, keyword) {
    const opts = dialog?.options ?? dialog?.choices ?? [];
    for (let i = 0; i < opts.length; i++) {
      const e = this.optionEntry(opts[i], i);
      if (e.text.includes(keyword)) return e;
    }
    return null;
  }

  async chooseByKeyword(keyword, { timeout = 8000, optional = false } = {}) {
    const d = this.s.dialog;
    const opt = this.findOption(d, keyword);
    if (!opt) {
      if (optional) return false;
      throw new Error(`option "${keyword}" not found in: ` + JSON.stringify(d).slice(0, 500));
    }
    const seq = this.s.dialogSeq;
    this.c.npcOption(opt.index);
    this.log('chose', { keyword, index: opt.index, text: opt.text });
    await this.waitFor(() => this.s.dialogSeq > seq, `dialog update after "${keyword}"`, timeout).catch(() => {});
    return true;
  }

  async ensureMap(target) {
    if (!this.isConnected()) await this.reconnect();
    if (this.s.death) await this.deathRecover();
    await this.syncMapFromRest().catch(() => {});
    if (this.c.mapId === target) return;
    const route = await routePath(this.c.mapId, target);
    this.log('route', { from: this.c.mapId, to: target, route });
    for (const hop of route) await this.travelHop(hop);
  }

  async travelHop(nextMap) {
    if (!this.isConnected()) throw new Error('disconnected before travel hop');
    // the game client disables auto-combat before routing (else it fights instead of walking)
    if (this.char?.auto?.enabled) { this.c.autoEnabled(false); await sleep(800); this.log('auto_off_for_travel', {}); }
    const exits = await loadExits(this.c.mapId);
    const exit = exits.find((e) => e.toMap === nextMap);
    if (!exit) throw new Error(`no exit ${this.c.mapId} -> ${nextMap}`);
    this.s.travel = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 90 * 1000) {
      if (this.s.death) throw new Error('died en route — will recover and retry');
      this.c.moveToPx(exit.cx, exit.cy);
      try { await this.waitFor(() => this.s.travel, 'travel message', 6500); } catch { continue; }
      const tr = this.s.travel;
      this.log('travel_msg', { mapId: tr.mapId, roomId: tr.roomId, channel: tr.channel, endpoint: tr.endpoint, displayName: tr.displayName });
      await this.c.rejoinRoom(tr);
      await sleep(1200);
      this.log('traveled', { now: this.c.mapId });
      return;
    }
    throw new Error(`travel ${this.c.mapId}->${nextMap} timeout`);
  }

  async farm({ until, auto = {}, timeoutMin = 600, label = '', map = null, statPlan = null, weave = null }) {
    await this.setAuto(auto);
    // inventory arrives ~right after join; re-apply once it's here so auto-potion itemIds fill in
    if (!this.s.inventory) await this.waitFor(() => !!this.s.inventory, 'inventory', 20000).catch(() => {});
    if (this.s.inventory) await this.setAuto(auto);
    // potions are the difference between grinding and a death loop — restock before starting
    if (map && this.potCount() < 8) await this.buyPotions(45).catch(() => {});
    const t0 = Date.now();
    let last = 0, lastStat = 0;
    while (Date.now() - t0 < timeoutMin * 60 * 1000) {
      await controlWait(this);
      if (!this.isConnected()) {
        this.log('farm_disconnected', {});
        await this.reconnect();
        if (map && this.c.mapId !== map) await this.ensureMap(map);
        await this.setAuto(auto);
      }
      // turn-key: if we're on the wrong map (e.g. after death respawn or any drift), go back and resume
      if (map && this.c.mapId !== map && !this.s.death) {
        this.log('wrong_map_return', { at: this.c.mapId, target: map });
        await this.ensureMap(map);
        await this.setAuto(auto);
      }
      const ch = this.char;
      if (ch && until(ch)) { this.log('farm_done', { label, baseLevel: ch.baseLevel, jobLevel: ch.jobLevel }); return; }
      if (Date.now() - last > 30000) {
        last = Date.now();
        this.log('farm_status', { label, baseLevel: ch?.baseLevel, jobLevel: ch?.jobLevel, exp: `${ch?.baseExp}/${ch?.baseExpNext}`, job: `${ch?.jobExp}/${ch?.jobExpNext}`, weight: this.s.inventory ? `${this.s.inventory.weight}/${this.s.inventory.weightLimit}` : null, autoEnabled: ch?.auto?.enabled, dead: !!this.s.death, statPts: ch?.statusPoints });
      }
      // keep allocating stats while grinding (user's interleaved stat plan)
      if (statPlan && Date.now() - lastStat > 6000) {
        lastStat = Date.now();
        const c2 = this.char;
        if ((c2?.statusPoints ?? 0) > 0) {
          const missing = Object.entries(statPlan.fixed ?? {}).filter(([k, v]) => (c2.stats?.[k] ?? 0) < v);
          if (missing.length) await this.applyStats({ [missing[0][0]]: missing[0][1] }, { strict: false, waitMs: 2500 });
          else if (statPlan.dump) await this.dumpStat(statPlan.dump, { waitMs: 2500 });
        }
      }
      if (this.s.death) {
        await this.deathRecover();
        if (map && this.c.mapId !== map) await this.ensureMap(map);
        await this.setAuto(auto);
      } else if (ch && ch.auto?.enabled === false) {
        const w = this.s.inventory; const pct = w ? (w.weight / w.weightLimit) * 100 : 0;
        this.log('auto_off', { weightPct: Math.round(pct) });
        if (pct > 70) {
          // bag filling → bank protected items, sell the rest, restock potions, come back
          this.c.autoEnabled(false); await sleep(700);
          await this.ensureMap('capital');
          await this.bankProtected();
          await this.sellJunk();
          await this.buyPotions(45).catch(() => {});
          await this.ensureMap(map ?? this.c.mapId);
          await this.setAuto(auto);
        } else {
          await this.setAuto(auto); // transient stop → just re-enable
        }
      }
      if (weave?.length) {
        // faster inner cadence so bash (1.2s cd) can actually land between map-heartbeat ticks
        this.weaveTick(weave); await sleep(1000);
        this.weaveTick(weave); await sleep(1000);
        this.weaveTick(weave); await sleep(1000);
      } else {
        await sleep(3000);
      }
    }
    throw new Error('farm timeout: ' + label);
  }
}

// ---------------- main ----------------
const sessionFile = path.join(OUT, 'session.json');
if (process.env.AETHERIA_USER && process.env.AETHERIA_PASS) {
  // command-center mode: log in with credentials and cache a fresh token
  let res = { ok: false, status: 0 }, j = {};
  try {
    res = await fetch('https://www.aetheria-online.in.th/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: process.env.AETHERIA_USER, password: process.env.AETHERIA_PASS }),
    });
    j = await res.json().catch(() => ({}));
  } catch (e) { j = { err: String(e?.message || e) }; }
  if (!res.ok || !j.token) {
    console.error('[login] failed', res.status, JSON.stringify(j).slice(0, 160));
    await sleep(20000);
    process.exit(3); // manager will surface the error state
  }
  fs.writeFileSync(sessionFile, JSON.stringify({ token: j.token, createdAt: new Date().toISOString() }));
}
const sess = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(OUT, `run-${stamp}.jsonl`);
const QUIET = !!process.env.AETHERIA_QUIET;
const log = (evt, data) => {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), evt, data });
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
  if (!QUIET) {
    try {
      const d = data === undefined ? '' : JSON.stringify(data);
      console.log(`[${evt}] ${d.length > 220 ? d.slice(0, 220) + '…' : d}`);
    } catch {}
  }
};
// crash guards: never die silently — always record to the run log
process.on('uncaughtException', (e) => { try { fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), evt: 'UNCAUGHT', data: String((e && e.stack) || e) }) + '\n'); } catch {} process.exit(3); });
process.on('unhandledRejection', (e) => { try { fs.appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), evt: 'UNHANDLED_REJECTION', data: String((e && e.stack) || e) }) + '\n'); } catch {} process.exit(3); });
const stateFile = path.join(OUT, 'run-state.json');
let runState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { cursor: 0, characterId: null, charName: null };
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(runState, null, 1));

const client = new AetheriaClient({ token: sess.token });
const bot = new Bot(client, log);
log('run_start', { upto: UPTO, logFile, cursor: runState.cursor, char: runState.charName });

// ---- character bootstrap (idempotent, survives server outages) ----
async function fetchCharactersRetry() {
  for (let i = 1; ; i++) {
    try {
      const cl = await client.listCharacters();
      if (cl && Array.isArray(cl.characters)) return cl;
      throw new Error('bad characters payload: ' + JSON.stringify(cl).slice(0, 120));
    } catch (e) {
      log('chars_retry', { attempt: i, err: String((e && e.message) || e).slice(0, 160) });
      await sleep(10000);
    }
  }
}
const chars = await fetchCharactersRetry();
let ch = runState.characterId && chars.characters?.find((x) => x.characterId === runState.characterId);
if (FRESH || !ch) {
  ch = chars.characters?.[0];
}
if (!ch) {
  const name = CHAR_NAME || ('FarmS' + String(Math.floor(Math.random() * 9000) + 1000));
  const cr = await client.createCharacter(name);
  log('created_char', cr);
  ch = { characterId: cr.characterId, name };
}
runState.characterId = ch.characterId; runState.charName = ch.name; saveState();
bot.charId = ch.characterId;
log('character', { id: ch.characterId, name: ch.name });

// Connect with retry-forever: a hard-killed previous session leaves the character marked
// "character already online" server-side until it expires — wait it out, don't crash.
async function connectWithRetry(characterId) {
  for (let i = 1; ; i++) {
    try {
      await client.connect(characterId);
      const ok = await client.waitJoin(12000);
      if (!ok) throw new Error('no join frame');
      client.arrived();
      await sleep(2500);
      return;
    } catch (e) {
      const msg = String((e && e.message) || e);
      log('connect_retry', { attempt: i, err: msg.slice(0, 200) });
      try { client.close(); } catch {}
      const long = /ออนไลน์อยู่แล้ว|already online|429|too many/i.test(msg);
      await sleep(long ? 60000 : 8000);
    }
  }
}
await connectWithRetry(ch.characterId);
log('joined', { map: client.mapId });
await bot.syncMapFromRest().catch(() => {});
bot.startHeartbeat(20000);

const NPCS = { n1: [2288, 1168], n2: [880, 1520], n3: [2480, 1552], n5: [1664, 960], n6: [1808, 1616], n9: [2032, 1626] };

// ---------------- PLAN ----------------
const PLAN = [
  { id: '01-stats-initial', run: async () => { await bot.applyStats({ STR: 10, DEX: 10 }, { strict: true }); } },
  { id: '02-travel-east-meadow', run: async () => { await bot.ensureMap('field_01'); } },
  { id: '03-farm-job10', run: async () => { await bot.farm({ until: (c) => c.jobLevel >= 10, map: 'field_01', auto: { huntRadiusTiles: 'all', monsters: [], pickupLoot: true, hpPercent: 75, spPercent: 40 }, label: 'field_01 job10' }); } },
  { id: '04-basic-skill-9', run: async () => { await bot.applySkills({ 'basic-skill': 9 }, { wait: false }); } },
  { id: '05-back-to-capital', run: async () => { await bot.ensureMap('capital'); } },
  { id: '06-valkyrie-swordsman', run: async () => { await bot.walkToNpc(NPCS.n5); await bot.talk('n5'); await bot.chooseByKeyword('พร้อมเปลี่ยนอาชีพ'); await bot.chooseByKeyword('นักดาบ'); await bot.chooseByKeyword('ยืนยัน', { optional: true }); await bot.waitFor(() => bot.char?.classId === 'swordsman', 'class swordsman', 15000); } },
  { id: '07-stats-dex10-rest-str', run: async () => { await bot.applyStats({ DEX: 10 }, { strict: false }); await bot.dumpStat('STR'); } },
  { id: '08-travel-willow-road', run: async () => { await bot.ensureMap('willow_road'); } },
  { id: '09-farm-lv12', run: async () => { await bot.farm({ until: (c) => c.baseLevel >= 12, map: 'willow_road', auto: { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75 }, label: 'willow lv12' }); } },
  { id: '10-skills-bash-sword', run: async () => { await bot.applySkills({ bash: 10, 'sword-mastery': 10 }, { wait: true, auto: { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75, spPercent: 40 }, weave: ['bash'] }); } },
  { id: '11-auto-bash', run: async () => { await bot.setAuto({ skills: [{ id: 'bash', level: 10 }] }); await sleep(800); log('auto_readback', bot.char?.auto); } },
  { id: '12-travel-capital', run: async () => { await bot.ensureMap('capital'); } },
  { id: '13-market-probe', run: async () => {
      for (const term of ['Ring pommel Saber', 'Rough Elunium', 'Phracon']) {
        const seq = bot.s.marketSeq || 0;
        bot.c.send('market', { op: 'search', filters: { q: term, sort: 'price_asc', page: 0 } });
        try { await bot.waitFor(() => (bot.s.marketSeq || 0) > seq, `market ${term}`, 12000); log('market_ok:' + term, bot.s.market ? { total: bot.s.market.total ?? bot.s.market.listings?.length } : 'no-results'); }
        catch (e) { log('market_fail', { term, err: String(e.message) }); }
        await sleep(800);
      }
    } },
  { id: '14-blacksmith-probe', run: async () => {
      await bot.walkToNpc(NPCS.n3);
      const d1 = await bot.talk('n3');
      log('n3_dialog', d1);
      const o = bot.findOption(bot.s.dialog, 'ตีบวก');
      if (o) { log('n3_choose', o); bot.c.npcOption(o.index); await sleep(2000); log('n3_after_refine', { refine: bot.s.refine, shop: bot.s.shop, dialog: bot.s.dialog }); }
      else { log('n3_no_refine_option', bot.s.dialog); }
    } },
  { id: '15-capital-npc-scan', run: async () => {
      const spots = { n1: [2288, 1168], n2: [880, 1520], n3: [2480, 1552], n4: [2384, 1552], n5: [1664, 960], n6: [1808, 1616], n7: [816, 1050], n8: [896, 2234], n9: [2032, 1626], n10: [2480, 2310], n11: [1904, 2128], n12: [2048, 2144] };
      for (const [k, px] of Object.entries(spots)) {
        try {
          await bot.walkToNpc(px);
          bot.s.dialog = null;
          bot.c.npcTalk(k);
          await sleep(1100);
          log('scan:' + k, bot.s.dialog ? { npcKey: bot.s.dialog.npcKey, name: bot.s.dialog.name, text: bot.s.dialog.text, options: bot.s.dialog.options } : 'no-dialog');
          bot.c.npcClose(); await sleep(400);
        } catch (e) { log('scan_fail:' + k, String(e.message)); }
      }
    } },
  // ---- v3 continuation: gear up + refine (user flow steps 10-13) ----
  { id: '16-extra-npc-hunt', run: async () => {
      for (let k = 13; k <= 24; k++) {
        try {
          bot.s.dialog = null;
          bot.c.npcTalk(`n${k}`);
          await sleep(900);
          if (bot.s.dialog) { log('hunt:n' + k, { name: bot.s.dialog.name, text: bot.s.dialog.text, options: bot.s.dialog.options }); bot.c.npcClose(); await sleep(300); }
        } catch (e) { /* ignore */ }
      }
    } },
  { id: '17-sell-junk', run: async () => {
      await bot.walkToNpc(NPCS.n2);
      const d = await bot.talk('n2');
      log('n2_dialog', d);
      const opt = bot.findOption(bot.s.dialog, 'ขาย') ?? bot.findOption(bot.s.dialog, 'ซื้อ') ?? { index: 0 };
      bot.s.shop = null;
      bot.c.npcOption(opt.index);
      await bot.waitFor(() => bot.s.shop, 'n2 shop open', 8000);
      log('n2_shop', { npc: bot.s.shop?.npcName ?? bot.s.shop?.name, count: (bot.s.shop?.items ?? []).length, sample: (bot.s.shop?.items ?? []).slice(0, 6).map((i) => `${i.name} ${i.price}z`) });
      const lines = bot.sellableLines();
      if (lines.length) { bot.c.shopSellMany(lines); log('sold_lines', { count: lines.length, lines: lines.slice(0, 12) }); await sleep(1800); }
      else log('sell_none', {});
      bot.c.npcClose(); await sleep(500);
    } },
  { id: '18-buy-saber', run: async () => {
      const owned = (bot.s.inventory?.items ?? []).some((x) => /Pommel Saber/i.test(x.name)) || JSON.stringify(bot.char?.equipment ?? {}).includes('Pommel Saber');
      if (owned) { log('saber_already_owned', {}); return; }
      // turn-key rule: farm up money first if short (saber + ores + 4 refines ≈ 6.5k)
      await bot.ensureBudget(6500, { farmMap: 'willow_road', auto: { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 60, spPercent: 40, skills: [{ id: 'bash', level: 10 }] }, label: 'saber budget' });
      await bot.ensureMap('capital');
      await bot.walkToNpc(NPCS.n3);
      await bot.talk('n3');
      bot.s.shop = null;
      await bot.chooseByKeyword('ซื้ออุปกรณ์ผจญภัย', { timeout: 6000 });
      try { await bot.waitFor(() => bot.s.shop, 'n3 gear shop', 8000); } catch {}
      const items = bot.s.shop?.items ?? [];
      log('n3_gear_shop', { count: items.length, sample: items.slice(0, 12).map((i) => ({ id: i.itemId, name: i.name, price: i.price, lvl: i.levelReq })) });
      const saber = items.find((i) => /Pommel Saber/i.test(i.name));
      const zeny = bot.char?.zeny ?? 0;
      if (saber && zeny >= saber.price) {
        bot.c.send('shop_buy', { itemId: saber.itemId, qty: 1 });
        log('bought_saber_shop', { itemId: saber.itemId, price: saber.price, zeny });
        await sleep(1600);
        bot.c.npcClose(); await sleep(400);
      } else {
        log('saber_not_in_shop', { found: !!saber, price: saber?.price, zeny });
        bot.c.npcClose(); await sleep(400);
        const seq = bot.s.marketSeq || 0;
        bot.c.send('market', { op: 'search', filters: { q: 'Ring Pommel Saber', sort: 'price_asc', page: 0 } });
        await bot.waitFor(() => (bot.s.marketSeq || 0) > seq, 'market saber', 10000);
        const ls = (bot.s.market?.listings ?? []).filter((l) => (l.auctionEndsAt ?? 0) < Date.now() && l.price <= (bot.char?.zeny ?? 0)).sort((a, b) => a.price - b.price);
        if (!ls.length) throw new Error('no affordable saber (shop or market)');
        bot.c.send('market', { op: 'buy', listingId: ls[0].listingId, price: ls[0].price });
        log('bought_saber_market', { listingId: ls[0].listingId, price: ls[0].price });
        await sleep(1600);
      }
      bot.c.invSort(); await sleep(900);
      const inv = (bot.s.inventory?.items ?? []).find((x) => /Pommel Saber/i.test(x.name));
      log('saber_in_bag', inv ? { slot: inv.slot, refine: inv.refine ?? 0 } : 'NOT FOUND');
    } },
  { id: '19-buy-ores', run: async () => {
      const cnt = (nm) => (bot.s.inventory?.items ?? []).filter((x) => x.name === nm).reduce((s, x) => s + x.qty, 0);
      if (cnt('Phracon') >= 4 && cnt('Rough Elunium') >= 12) { log('ores_already_have', {}); return; }
      await bot.ensureBudget(3500, { farmMap: 'willow_road', auto: { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 60, spPercent: 40, skills: [{ id: 'bash', level: 10 }] }, label: 'ore budget' });
      await bot.ensureMap('capital');
      await bot.talk('n3');
      bot.s.shop = null;
      await bot.chooseByKeyword('ซื้อแร่ตีบวก', { timeout: 6000 });
      try { await bot.waitFor(() => bot.s.shop, 'n3 ore shop', 8000); } catch {}
      const items = bot.s.shop?.items ?? [];
      log('n3_ore_shop', { count: items.length, sample: items.slice(0, 8).map((i) => ({ id: i.itemId, name: i.name, price: i.price })) });
      let budget = bot.char?.zeny ?? 0;
      for (const [nm, want] of [['Rough Elunium', 12], ['Phracon', 4]]) {
        const it = items.find((i) => i.name === nm) ?? items.find((i) => i.name.startsWith(nm));
        if (!it) { log('ore_missing', { nm }); continue; }
        const needQty = Math.max(0, want - cnt(nm));
        const qty = Math.max(0, Math.min(needQty, Math.floor(budget / (it.price || 1))));
        if (qty > 0) { bot.c.send('shop_buy', { itemId: it.itemId, qty }); log('buy_ore', { name: it.name, qty, price: it.price }); budget -= qty * it.price; await sleep(1400); }
        else log('ore_unaffordable', { nm, price: it.price, budget });
      }
      bot.c.npcClose(); await sleep(400);
      bot.c.invSort(); await sleep(900);
    } },
  { id: '20-refine-saber', run: async () => {
      const willowAuto = { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 60, spPercent: 40, skills: [{ id: 'bash', level: 10 }] };
      for (let round = 0; round < 5; round++) {
        await bot.ensureMap('capital');
        await bot.walkToNpc(NPCS.n3);
        await bot.talk('n3');
        bot.s.refine = null;
        await bot.chooseByKeyword('ตีบวกอุปกรณ์', { timeout: 6000 });
        try { await bot.waitFor(() => bot.s.refine, 'refine mode', 8000); } catch { log('refine_mode_fail', {}); }
        let blocked = false;
        for (let i = 0; i < 8; i++) {
          const r = bot.s.refine;
          const entry = (r?.items ?? []).find((x) => x.item?.itemId === 91016);
          if (!entry) { log('refine_entry_missing', { items: (r?.items ?? []).map((x) => x.item?.name) }); break; }
          if (entry.to > 4) { log('refine_done', { nextTo: entry.to }); bot.c.npcClose(); await sleep(400); bot.c.invSort(); await sleep(800); return; }
          if ((entry.material?.have ?? 0) < 1 || (bot.char?.zeny ?? 0) < entry.zeny) { log('refine_blocked', { mat: entry.material?.have, zeny: bot.char?.zeny, cost: entry.zeny }); blocked = true; break; }
          const seq = bot.s.refineSeq;
          bot.c.send('refine', { source: entry.source, blessing: false });
          log('refine_send', { source: entry.source, to: entry.to, cost: entry.zeny, mat: `${entry.material.name} ${entry.material.have}` });
          await sleep(2200);
          if ((bot.s.refineSeq ?? 0) === seq) log('refine_no_update', { after: entry.to });
        }
        bot.c.npcClose(); await sleep(500);
        // turn-key rule: short on zeny/materials → farm + restock ores, then come back to refine
        await bot.ensureMap('capital');
        await bot.sellJunk();
        await bot.ensureBudget((bot.char?.zeny ?? 0) + 4000, { farmMap: 'willow_road', auto: willowAuto, label: 'refine budget' });
        await bot.walkToNpc(NPCS.n3);
        await bot.talk('n3');
        bot.s.shop = null;
        await bot.chooseByKeyword('ซื้อแร่ตีบวก', { timeout: 6000 });
        try { await bot.waitFor(() => bot.s.shop, 'ore shop', 8000); } catch {}
        const items = bot.s.shop?.items ?? [];
        for (const [nm, want] of [['Phracon', 8], ['Rough Elunium', 12]]) {
          const it = items.find((x) => x.name === nm);
          const have = (bot.s.inventory?.items ?? []).filter((x) => x.name === nm).reduce((s, x) => s + x.qty, 0);
          const qty = Math.max(0, Math.min(want - have, Math.floor((bot.char?.zeny ?? 0) / ((it?.price || 1) * 2))));
          if (it && qty > 0) { bot.c.send('shop_buy', { itemId: it.itemId, qty }); log('buy_ore', { name: nm, qty }); await sleep(1400); }
        }
        bot.c.npcClose(); await sleep(500);
      }
    } },
  { id: '21-equip-saber', run: async () => {
      bot.c.invSort(); await sleep(900);
      const it = (bot.s.inventory?.items ?? []).find((x) => /Pommel Saber/i.test(x.name));
      if (!it) throw new Error('saber not in bag — cannot equip');
      bot.c.send('equip', { slot: it.slot });
      log('equip_send', { slot: it.slot, refine: it.refine ?? 0 });
      await sleep(1400);
    } },
  // ---- v3 leg 2: goblin grind -> Job 50 -> Knight ----
  { id: '22-travel-goblin', run: async () => { await bot.ensureMap('goblin_trail'); } },
  { id: '23-farm-j50-stats', run: async () => {
      const autoCfg = { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75, spPercent: 40, skills: [{ id: 'bash', level: 10 }] };
      await bot.farm({ until: (c) => c.jobLevel >= 50, map: 'goblin_trail', auto: autoCfg, statPlan: { fixed: { DEX: 20, AGI: 20 }, dump: 'STR' }, label: 'goblin j50', timeoutMin: 600, weave: ['bash'] });
    } },
  { id: '23b-gems-refine-equip', run: async () => {
      // gems come from field drops now (market purchase step removed). Refine up to 3 gems to +4 and equip.
      const gems = (bot.s.inventory?.items ?? []).filter((x) => /gem/i.test(x.name)).slice(0, 3);
      if (!gems.length) { log('gem_skip', { reason: 'no gems in bag' }); return; }
      log('gem_plan', { gems: gems.map((g) => `${g.name}(${g.itemId})`) });
      const gemIds = new Set(gems.map((g) => g.itemId));
      await bot.ensureMap('capital');
      await bot.walkToNpc(NPCS.n3);
      await bot.talk('n3');
      bot.s.refine = null;
      await bot.chooseByKeyword('ตีบวกอุปกรณ์', { timeout: 6000 });
      try { await bot.waitFor(() => bot.s.refine, 'refine mode', 8000); } catch { log('gem_refine_mode_fail', {}); }
      let restocks = 0;
      for (let round = 0; round < 30; round++) {
        const entry = (bot.s.refine?.items ?? []).find((x) => gemIds.has(x.item?.itemId) && x.to <= 4);
        if (!entry) { log('gem_refine_done', { round }); break; }
        if ((entry.material?.have ?? 0) < 1 || (bot.char?.zeny ?? 0) < entry.zeny) {
          log('gem_refine_blocked', { mat: entry.material?.have, zeny: bot.char?.zeny, cost: entry.zeny, item: entry.item?.name });
          if (++restocks > 2) { log('gem_refine_giveup', {}); break; }
          bot.c.npcClose(); await sleep(500);
          await bot.talk('n3');
          bot.s.shop = null;
          await bot.chooseByKeyword('ซื้อแร่ตีบวก', { timeout: 6000 });
          try { await bot.waitFor(() => bot.s.shop, 'ore shop', 8000); } catch {}
          const el = (bot.s.shop?.items ?? []).find((x) => x.name === 'Rough Elunium');
          const need = Math.max(1, 12 - (entry.material?.have ?? 0));
          const qty = Math.min(need, Math.max(0, Math.floor(((bot.char?.zeny ?? 0) - 300) / ((el?.price || 200)))));
          if (el && qty > 0) { bot.c.send('shop_buy', { itemId: el.itemId, qty }); log('gem_buy_elunium', { qty }); await sleep(1600); }
          bot.c.npcClose(); await sleep(500);
          await bot.talk('n3');
          bot.s.refine = null;
          await bot.chooseByKeyword('ตีบวกอุปกรณ์', { timeout: 6000 });
          try { await bot.waitFor(() => bot.s.refine, 'refine mode retry', 8000); } catch {}
          continue;
        }
        const seq = bot.s.refineSeq;
        bot.c.send('refine', { source: entry.source, blessing: false });
        log('gem_refine_send', { item: entry.item?.name, to: entry.to, cost: entry.zeny });
        await sleep(2200);
        if ((bot.s.refineSeq ?? 0) === seq) log('gem_refine_no_update', {});
      }
      bot.c.npcClose(); await sleep(500);
      bot.c.invSort(); await sleep(800);
      // equip the gems (user flow: ใส่ไอเท็มดาบและ Gem — sword already equipped in 21)
      for (const g of gems) {
        const it = (bot.s.inventory?.items ?? []).find((x) => x.itemId === g.itemId);
        if (!it) { log('gem_equip_missing', { itemId: g.itemId }); continue; }
        bot.c.send('equip', { slot: it.slot });
        log('gem_equip', { name: it.name, slot: it.slot, refine: it.refine ?? 0 });
        await sleep(1300);
      }
      bot.c.invSort(); await sleep(600);
    } },
  { id: '23c-orc-egg', run: async () => {
      // Event Lily (n9 @2032,1626): free Orc Baby Egg at base ≥15 — once per character. Equip to hatch it.
      if ((bot.char?.baseLevel ?? 0) < 15) { log('orc_egg_low_level', { base: bot.char?.baseLevel }); return; }
      // char.pets shape = { owned: [...], active: {...}|null }
      const petsRaw = bot.char?.pets;
      const owned = Array.isArray(petsRaw?.owned) ? petsRaw.owned : [];
      const hasOrcPet = [...owned, petsRaw?.active].filter(Boolean).some((p) => /orc|baby/i.test(JSON.stringify(p)));
      if (hasOrcPet) { log('orc_egg_already_hatched', {}); return; }
      let egg = (bot.s.inventory?.items ?? []).find((x) => /orc|baby/i.test(x.name) && /egg|ไข่/i.test(x.name));
      if (!egg) {
        await bot.ensureMap('capital');
        await bot.walkToNpc(NPCS.n9);
        await bot.talk('n9');
        log('orc_egg_dialog', { name: bot.s.dialog?.name, text: bot.s.dialog?.text, options: bot.s.dialog?.options });
        const opt = bot.findOption(bot.s.dialog, 'ไข่') ?? bot.findOption(bot.s.dialog, 'egg') ?? bot.findOption(bot.s.dialog, 'Orc');
        if (!opt) { log('orc_egg_option_missing', {}); bot.c.npcClose(); await sleep(400); return; } // soft skip — full options in orc_egg_dialog above
        bot.s.dialog = null;
        bot.c.npcOption(opt.index);
        await sleep(2000);
        log('orc_egg_claim', { option: opt, followup: bot.s.dialog ? { name: bot.s.dialog.name, text: bot.s.dialog.text, options: bot.s.dialog.options } : null });
        bot.c.npcClose(); await sleep(400);
        bot.c.invSort(); await sleep(800);
        egg = (bot.s.inventory?.items ?? []).find((x) => /orc|baby/i.test(x.name) && /egg|ไข่/i.test(x.name));
      }
      if (!egg) { log('orc_egg_not_in_bag', {}); return; }
      await bot.hatchEgg();
    } },
  { id: '24-skills-j50', run: async () => {
      const autoCfg = { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75, spPercent: 40, skills: [{ id: 'bash', level: 10 }] };
      const ok = await bot.applySkills({ 'sword-mastery': 10, bash: 10, provoke: 3, 'hp-recovery': 10, endure: 10, 'magnum-break': 6 }, { wait: true, auto: autoCfg, waitMs: 60 * 60 * 1000 });
      log('skills_j50_done', { ok, skills: bot.char?.skills });
    } },
  { id: '25-knight-change', run: async () => {
      await bot.ensureMap('capital');
      await bot.walkToNpc(NPCS.n5);
      await bot.talk('n5');
      await bot.chooseByKeyword('พร้อมเปลี่ยนอาชีพ');
      const pick = bot.findOption(bot.s.dialog, 'Knight') ?? bot.findOption(bot.s.dialog, 'อัศวิน') ?? bot.findOption(bot.s.dialog, 'ไนท์');
      if (!pick) throw new Error('knight option not found: ' + JSON.stringify(bot.s.dialog?.options));
      bot.c.npcOption(pick.index);
      log('chose', pick);
      await sleep(900);
      await bot.chooseByKeyword('ยืนยัน', { optional: true });
      await bot.waitFor(() => bot.char?.classId === 'knight', 'class knight', 20000);
      log('knight_done', { classId: bot.char?.classId });
    } },
  { id: '26-stats-knight', run: async () => {
      await bot.applyStats({ DEX: 30, AGI: 30, VIT: 20 }, { strict: false });
      await bot.dumpStat('STR');
    } },
  // ---- v3 leg 3: Knight -> gale highland -> Peco -> frost pass (final user sequence) ----
  { id: '27a-pet-hatch', run: async () => { await bot.hatchEgg(); } },
  { id: '27-travel-gale', run: async () => { await bot.ensureMap('gale_high'); } },
  { id: '28-farm-gale-job27', run: async () => {
      const autoCfg = { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75, spPercent: 40, skills: [{ id: 'bash', level: 10 }] };
      // knight kit = bowling 10 + 2h-sword-mastery 1 (quicken's prereq!) + quicken 10 + ride 1 + master 5 = 27 pts → job 28
      await bot.farm({ until: (c) => c.jobLevel >= 28, map: 'gale_high', auto: autoCfg, statPlan: { fixed: { DEX: 30, AGI: 30, VIT: 20 }, dump: 'STR' }, label: 'gale knight-job28', timeoutMin: 600, weave: ['bash'] });
    } },
  { id: '29-skills-gale', run: async () => {
      const autoCfg = { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75, spPercent: 40, skills: [{ id: 'bash', level: 10 }] };
      const ok = await bot.applySkills({ 'two-hand-sword-mastery': 1, 'bowling-bash': 10, 'two-hand-quicken': 10, 'peco-peco-ride': 1, 'peco-peco-master': 5 }, { wait: true, auto: autoCfg, waitMs: 90 * 60 * 1000, farmMap: 'gale_high' });
      log('skills_gale_done', { ok, skills: bot.char?.skills });
      if (!ok) throw new Error('gale skills incomplete — points pending, will retry');
    } },
  { id: '30-peco-rental', run: async () => {
      // Healer Mira (n1 @2288,1168) = the 'top-right NPC' with the peco-standing prop.
      // Option 0: 'เช่า Peco Peco (2,500 z · requires Peco Peco Ride)'
      await bot.ensureMap('capital');
      await bot.walkToNpc(NPCS.n1);
      await bot.talk('n1');
      const rent = bot.findOption(bot.s.dialog, 'เช่า Peco Peco');
      if (!rent) throw new Error('peco rent option not found: ' + JSON.stringify(bot.s.dialog?.options));
      bot.s.dialog = null;
      bot.c.npcOption(rent.index);
      await sleep(1800);
      log('peco_rent_clicked', { option: rent, followup: bot.s.dialog ? { name: bot.s.dialog.name, text: bot.s.dialog.text, options: bot.s.dialog.options } : null });
      bot.c.npcClose(); await sleep(400);
    } },
  { id: '31-frost-farm', run: async () => {
      const autoCfg = { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75, spPercent: 40, skills: [{ id: 'bash', level: 10 }] };
      // final goal: base 65 (user guide: เก็บ LV จน 60-65)
      await bot.farm({ until: (c) => c.baseLevel >= 65, map: 'frost_pass', auto: autoCfg, label: 'frost lv65', timeoutMin: 900, weave: ['bash', 'bowling-bash'] });
    } },
];

// ---------------- execute (turn-key: never abort — retry forever with reconnect) ----------------
for (let i = runState.cursor; i < PLAN.length && i < UPTO; i++) {
  const step = PLAN[i];
  bot.stepId = step.id;
  log('STEP_START', { step: step.id });
  let attempt = 0;
  for (;;) {
    await controlWait(bot);
    try { await step.run(); break; }
    catch (e) {
      attempt++;
      log('STEP_FAIL', { step: step.id, attempt, err: String((e && e.message) || e) });
      if (bot.s.death) { try { await bot.deathRecover(); } catch (e2) { log('DEATH_RECOVER_FAIL', String((e2 && e2.message) || e2)); } }
      if (!bot.isConnected() || attempt % 3 === 0) {
        try { await bot.reconnect(); } catch (e2) { log('RECONNECT_FAIL', String((e2 && e2.message) || e2)); }
      }
      await sleep(Math.min(120000, 8000 + attempt * 7000));
    }
  }
  runState.cursor = i + 1; saveState(); log('STEP_DONE', { step: step.id });
}
log('run_end', { cursor: runState.cursor, char: runState.charName, map: client.mapId, upto: UPTO });
try { client.close(); } catch {}
process.exit(0);
