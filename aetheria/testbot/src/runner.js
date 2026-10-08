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
// ops: expose this runner's pid so it can be hard-killed deliberately (ghost-session / recovery tests, debugging)
try { fs.writeFileSync(path.join(OUT, 'runner.pid'), String(process.pid)); } catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const UPTO = parseInt(arg('--upto', '999'), 10);
// the sell policy everywhere protects exactly three things: whitelist items, cards, and the bot's own potions.
// cards are matched by NAME (inventory snapshots carry no `type` field): "Snowman Card" yes, "Cardigan" no.
const CARD_RE = /(?:\bcard\b|การ์ด)/i;
const WING_BUTTERFLY = 90311; // instant farm→capital ticket — Bor sells them for 300z (verified live 2026-10-08)
const CHAR_NAME = arg('--char', null);
const FRESH = argv.includes('--fresh');
const MODE = arg('--mode', process.env.AETHERIA_MODE || 'leveling'); // leveling | farming | collector

// ---------------- external control (command center) ----------------
// control.json {cmd:'run'|'pause'|'stop'} polled by loops; status.json mirrors the latest snapshot for the UI
const CONTROL_FILE = path.join(OUT, 'control.json');
const STATUS_FILE = path.join(OUT, 'status.json');
const readControl = () => { try { return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')); } catch { return null; } };
const writeStatus = (obj) => { try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...obj, ts: Date.now(), pid: process.pid })); } catch {} };
let _ctrlState = 'running';

// ---- runtime directives (command center): control.json {cmd, rev, auto, weave, autoChannel, collect, grant, farm} ----
let _dirRev = -1;
function applyDirectives(bot) {
  const ctl = readControl();
  if (!ctl) return null;
  if (ctl.rev != null && ctl.rev !== _dirRev) {
    _dirRev = ctl.rev;
    bot.autoOverride = ctl.auto ?? null;
    const seq = (Array.isArray(ctl.weave) && ctl.weave.length) ? ctl.weave.filter(Boolean).slice(0, 9) : null;
    bot.weaveOverride = seq;
    // live-apply config pushes: setAuto() reads _weaveSeq/autoOverride, so refresh here and let the farm loop
    // re-arm once (covers skill-sequence AND auto-config changes like the monster list)
    if (seq && JSON.stringify(seq) !== JSON.stringify(bot._weaveSeq)) { bot._weaveSeq = seq; bot._seqDirty = true; }
    const autoStr = JSON.stringify(ctl.auto ?? null);
    if (autoStr !== JSON.stringify(bot._lastAutoCtl ?? null)) { bot._lastAutoCtl = ctl.auto ?? null; bot._seqDirty = true; }
    bot.autoChannel = ctl.autoChannel !== false;
    bot.collectCfg = ctl.collect ?? null;
    if (Array.isArray(ctl.keep)) bot.keepItemIds = ctl.keep;
    bot.errandCfg = ctl.errand ?? null;
    bot.wingCfg = ctl.wings ?? null;
    // arm collect grants once per revision — the server clears the grant only after the collectDone
    // heartbeat (~20s), and re-reading it would trigger a duplicate empty collect in that window.
    // A fresh process starts at _dirRev = -1, so a pending grant still fires after a crash/restart.
    if (ctl.grant) bot.pendingGrant = ctl.grant;
    if (bot.log) bot.log('directives_applied', { rev: ctl.rev, auto: !!ctl.auto, weave: bot.weaveOverride, autoChannel: bot.autoChannel, collect: !!ctl.collect, keep: (ctl.keep ?? []).length, errand: !!ctl.errand?.enabled, grant: !!ctl.grant });
  }
  return ctl;
}

async function controlWait(bot) {
  for (;;) {
    applyDirectives(bot);
    try { bot.checkSuspectedDeath?.(); } catch {}
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
      if (type === 'exp_gain') { this._lastLifeAt = Date.now(); this.onKill(data); this.log('kill', { m: data.monster, base: data.base, job: data.job }); return; }
      if (type === 'item_gain') { this._lastLifeAt = Date.now(); this.log('drop', { name: data.name, qty: data.qty }); return; }
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
          this._lastLifeAt = Date.now(); // our own skill fx — we're alive
          this._ownFx = (this._ownFx || 0) + 1;
          this.log('skill_fx_self', { s: data.skillId, t: (data.targets ?? [])[0] ?? null, n: (data.targets ?? []).length });
        }
        return;
      }
      if (type === 'cast') {
        if (data?.casterId === this.selfId()) {
          this._lastLifeAt = Date.now(); // our own cast went through — we're alive
          this._ownCast = (this._ownCast || 0) + 1;
          if (this._ownCast <= 5) this.log('own_cast', { skillId: data.skillId, targetId: data.targetId });
        }
        return;
      }
      if (type === 'notice') { if ((this._notices = (this._notices || 0) + 1) <= 8) this.log('notice', data); return; }
      if (type === 'inventory') {
        // Server pushes vary: full snapshots are flat; some updates omit items; trade-style payloads nest them
        // ({slot,qty,item:{...}}). Replace only on a real item list (normalizing nested → flat), else merge —
        // a wholesale replace on a partial push made the bag go blind (items invisible to sell/keep/trade logic).
        if (data && Array.isArray(data.items)) {
          const items = data.items.map((it) => {
            if (!it || !it.item || it.itemId != null) return it;
            const { item, slot, qty, refine } = it;
            return { ...item, slot, qty, refine: refine ?? item.refine ?? null };
          });
          s.inventory = { ...(s.inventory ?? {}), ...data, items };
        } else {
          s.inventory = { ...(s.inventory ?? {}), ...(data ?? {}), items: (s.inventory?.items ?? []) };
        }
        return;
      }
      if (type === 'npc_dialog') { this._lastLifeAt = Date.now(); s.dialog = data; s.dialogSeq++; this.log('npc_dialog', data); return; }
      if (type === 'shop') { this._lastLifeAt = Date.now(); s.shop = data; this.log('shop', data); return; }
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
      if (type === 'travel') { this._lastLifeAt = Date.now(); s.travel = data; return; }
      if (type === 'death') {
        const live0 = this.c.live;
        if (live0 && !live0.dead) {
          // WORLD-VERIFIED (2026-10-08): the death broadcast carries no identity and can be for ANY player in
          // the room. If the real room state says we are alive, this is not ours — re-verify once after 1.5s
          // (a state patch for our own death may lag the message by milliseconds) and then ignore it.
          this._deathMsgAt = Date.now();
          setTimeout(() => {
            try {
              if (this.s.death) return; // a real death was handled in the meantime
              const lv = this.c.live;
              if (lv && !lv.dead) { this.log('death_ignored', { how: 'world-alive', hp: lv.hp, maxHp: lv.maxHp, msAfterMsg: Date.now() - this._deathMsgAt }); return; }
              s.death = data; this.combat.hp = 0; this.log('DEATH', { ...data, how: 'world-dead-after-delay' });
              this.deathRecover({ real: true }).catch((e) => this.log('death_park_fail', String((e && e.message) || e)));
            } catch (e) { this.log('death_check_err', String((e && e.message) || e)); }
          }, 1500);
          return;
        }
        s.death = data; this._deathMsgAt = Date.now(); this.combat.hp = 0;
        this.log('DEATH', { ...data, how: live0 ? 'world-dead' : 'no-world' });
        this.deathRecover({ real: !!live0 }).catch((e) => this.log('death_park_fail', String((e && e.message) || e)));
        return;
      }
      if (type === 'respawned') {
        this._lastRespawnedAt = Date.now(); // deathRecoverReal waits on this (in-session revive proof)
        s.death = null; this.combat.hp = this.combat.maxHp; this.combat.sp = this.combat.maxSp;
        if (this._sus) {
          if (this._sus.real) { this._sus = null; this.log('respawned', data); return; }
          const ageMs = Date.now() - this._sus.at;
          this._sus = null;
          if (ageMs < 30000) { this.log('death_ignored', { how: 'early-respawned-pair' }); }
          else {
            // a release arriving after the corpse window = OUR parked death was real → recover now (reconnect + restock)
            this.log('death_confirmed', { how: 'respawned', afterSec: Math.round(ageMs / 1000) });
            this.deathRecoverReal({ already: true }).catch((e) => this.log('death_recover_fail', String((e && e.message) || e)));
          }
        }
        this.log('respawned', data); return;
      }
      if (type === 'chat') { s.chats.push(data); if (s.chats.length > 300) s.chats.shift(); return; }
      if (type === 'collection') { s.collection = data; return; }
      if (type === 'channels') { s.channels = data; if (!this._chLogged) { this._chLogged = true; this.log('channels_probe', data); } return; }
      if (type === 'warp_menu') { s.warpMenu = data; s.warpMenuSeq = (s.warpMenuSeq || 0) + 1; return; }
      if (type === 'invite') { s.invite = data; this.log('invite', data); return; }
      if (type === 'trade') { s.trade = data; s.tradeSeq = (s.tradeSeq || 0) + 1; this.log('trade_msg', data); return; }
      if (type === 'storage') {
        this._lastLifeAt = Date.now(); // a dead character cannot open storage
        // same payload-shape variants as inventory — replace only on a real item list (normalizing nested), else merge
        const src = s.storage ?? {};
        if (data && Array.isArray(data.items)) {
          const items = data.items.map((it) => {
            if (!it || !it.item || it.itemId != null) return it;
            const { item, slot, qty, refine } = it;
            return { ...item, slot, qty, refine: refine ?? item.refine ?? null };
          });
          s.storage = { ...src, ...data, items };
        } else {
          s.storage = { ...src, ...(data ?? {}), items: src.items ?? [] };
        }
        this._storeSnapAt = Date.now(); // "storage last seen" timestamp — carried in status for the command center
        this.log('storage_msg', { slots: data?.slots ?? null, items: (s.storage.items ?? []).length, zeny: data?.zeny ?? null });
        return;
      }
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

  // DEATH MODEL (updated 2026-10-07, verified live): `death`{savePointName,capitalName,autoReleaseSeconds:300}
  // carries no identity; the official client only shows the death UI when the room-state `dead` flag is true.
  // Live capture confirmed the release sequence: respawned{} → travel{ticket,roomId,...} → rejoin (hp restored).
  // Parked-suspicion flow: life signals within the window clear it; a 'respawned' arriving AFTER the corpse
  // window confirms a real death (recovery runs immediately); total silence for 6 min = fallback recovery.
  async deathRecover(opts = {}) {
    this.log('death_recover', { data: this.s.death, real: !!opts.real });
    if (!this._sus) this._sus = { at: this._deathMsgAt ?? Date.now(), real: !!opts.real };
    this.s.death = null; this.combat.hp = this.combat.maxHp; this.combat.sp = this.combat.maxSp;
    if (opts.real) {
      // verified against the real room state (hp 0 / dead flag) — no guessing: release + fresh session now
      this.log('death_verified_world', {});
      this.deathRecoverReal().catch((e) => this.log('death_recover_fail', String((e && e.message) || e)));
      return;
    }
    this.log('death_unverified', { note: 'death parked — life signals clear it; respawned-after-window or 6 min silence = real' });
  }

  // resolved from controlWait (runs every farm-loop iteration) — decides what a parked suspicion means
  checkSuspectedDeath() {
    try {
      const lv = this.c.live;
      if (lv && lv.dead && !this.s.death) {
        this.log('DEATH_WORLD', { hp: lv.hp, via: 'farmloop' });
        this.s.death = { autoReleaseSeconds: 300, how: 'world' }; this._deathMsgAt = Date.now(); this.combat.hp = 0;
        this.deathRecover({ real: true }).catch((e) => this.log('death_park_fail', String((e && e.message) || e)));
      }
    } catch {}
    const sus = this._sus; if (!sus) return;
    if ((this._lastLifeAt ?? 0) > sus.at) { this._sus = null; this.log('death_ignored', { how: 'life-signals' }); return; }
    if (Date.now() - sus.at > 6 * 60 * 1000) {
      this._sus = null;
      this.log('death_recovery_start', { afterMin: 6 });
      this.deathRecoverReal().catch((e) => this.log('death_recover_fail', String((e && e.message) || e)));
    }
  }

  async deathRecoverReal(opts = {}) {
    const mark = this._lastRespawnedAt ?? 0;
    const aliveNow = () => (this._lastRespawnedAt ?? 0) > mark || (this.c.live && !this.c.live.dead);
    this.c.send('respawn', { to: 'save' });
    let revived = !!opts.already || await this.waitFor(aliveNow, 'respawned', 20000).catch(() => false);
    if (!revived) {
      // the dead body sits for autoReleaseSeconds (300) before release. Wait it out in the CURRENT session.
      const releaseS = Math.min(330, 320);
      this.log('death_await_autorelease', { seconds: releaseS });
      revived = await this.waitFor(aliveNow, 'auto-release', releaseS * 1000).catch(() => false);
      this.log('death_await_done', { ok: revived });
    }
    // consume the release travel (respawned → travel to the save point → rejoin) — all IN-SESSION
    let tr = null;
    await this.waitFor(() => { tr = this.s.travel; return !!tr; }, 'release travel', 6000).catch(() => {});
    if (tr) {
      this.s.travel = null;
      try { await this.c.rejoinRoom(tr); await sleep(1200); this.log('death_rejoin', { map: this.c.mapId }); }
      catch (e) { this.log('death_rejoin_fail', String((e && e.message) || e)); }
    }
    await sleep(800);
    // 2026-10-07 v2 — NO blind relogin: right after the respawn the character is alive on the CURRENT session;
    // an immediate reconnect fights its own just-revived seat (kick-409 storms, 60–90s outages) and the
    // sell/buy restock fails mid-storm → half-HP, zero-potion returns → endless death↔relogin loop (the
    // verdant_farm incident). Stay in-session; the farm loop's rescue ladder (channel hop first) handles
    // the rare "auto refused" case.
    let via = 'in-session';
    if (!revived) {
      try { await this.reconnect(); via = 'reconnect'; }
      catch (e) { this.log('death_recover_reconnect_fail', String((e && e.message) || e)); via = 'reconnect-fail'; }
    }
    this.log('death_recovered', { map: this.c.mapId, via });
    try { await this.sellJunk(); } catch (e) { this.log('death_recover_sell_fail', String((e && e.message) || e)); }
    try { await this.buyPotions(45); } catch (e) { this.log('pot_buy_fail', String((e && e.message) || e)); }
    // re-arm auto so the engine's hpItems list picks up the restocked potions (stale empty list = no healing)
    if (!this.s.death && this._lastFarmAuto) {
      try { await this.setAuto(this._lastFarmAuto); } catch (e) { this.log('death_rearm_fail', String((e && e.message) || e)); }
    }
  }

  // Auto-rescue (2026-10-07): post-update, some sessions refuse auto_set until the room/session is refreshed.
  // Cheap path FIRST: hop to another channel of the SAME map (rejoin = fresh room, no relogin → NO capital
  // re-home, no 3-map walk-back). Only if the hop still refuses: full relogin (works, but the char re-homes
  // to the save point → ensureMap walks it back through 3 maps — the waste users saw on NimbleNewt/badger).
  async autoRescue() {
    try {
      const cur = this.s.channels?.current ?? null;
      const target = cur == null ? 2 : cur >= 12 ? 1 : cur + 1;
      this.log('auto_rescue_start', { from: cur, to: target });
      const hopped = await this.switchToChannel(target, { tries: 1 }).catch(() => false);
      await sleep(1000);
      await this.setAuto({});
      if (this.char?.auto?.enabled === true) { this.log('auto_rescue_done', { via: 'channel', channel: target, hopped }); return; }
      this.log('auto_rescue_channel_miss', { hopped });
    } catch (e) { this.log('auto_rescue_channel_err', String((e && e.message) || e)); }
    this.log('auto_rescue_relogin', { map: this.c.mapId });
    await this.reconnect();
    this.log('auto_rescue_done', { via: 'relogin', map: this.c.mapId });
    if (this._farmMap && this.c.mapId !== this._farmMap) {
      try {
        await this.ensureMap(this._farmMap); this._mapRetryAt = 0;
        await this.setAuto({});
        this.log('auto_rescue_returned', { map: this.c.mapId, enabled: this.char?.auto?.enabled ?? null });
      } catch (e) { this._mapRetryAt = Date.now() + 2 * 60 * 1000; this.log('auto_rescue_map_fail', String((e && e.message) || e)); }
    }
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
  async buyPotions(target = 25, itemName = 'Red Potion') {
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
    const unit = itemName === 'Orange Potion' ? 200 : itemName === 'White Potion' ? 1200 : 50;
    const want = Math.min(target - have, Math.floor(budget / unit));
    if (want <= 0) { this.log('pot_no_budget', { have, zeny }); return have; }
    await this.walkToNpc(NPCS.n2);
    await this.talk('n2');
    this.s.shop = null;
    await this.chooseByKeyword('ซื้อของหน่อย', { timeout: 6000 });
    try { await this.waitFor(() => this.s.shop, 'shop', 8000); } catch {}
    const shop = this.s.shop;
    const red = (shop?.items ?? []).find((x) => x.name === itemName);
    if (red) { this.c.send('shop_buy', { itemId: red.itemId, qty: want }); this.log('buy_potions', { item: itemName, want, have, zeny }); await sleep(2500); }
    else this.log('pot_no_shop', { items: (shop?.items ?? []).slice(0, 6).map((x) => x.name) });
    this.c.npcClose(); await sleep(400);
    this.c.invSort(); await sleep(900);
    const after = this.potCount();
    this.log('pot_restocked', { before: have, after });
    return after;
  }

  // ---- weight-limit scrolls (Shopkeeper Bor = n2, capital 880,1520) ----
  // 5,000z per scroll · max 10 consumptions per character · ≥2s between uses. Progress persists per bot dir.
  scrollCount() {
    try { return JSON.parse(fs.readFileSync(path.join(OUT, 'scrolls.json'), 'utf8')).n ?? 0; } catch { return 0; }
  }
  setScrollCount(n) { try { fs.writeFileSync(path.join(OUT, 'scrolls.json'), JSON.stringify({ n })); } catch {} }
  isScrollName(name) { return /weight\s*limit|น้ำหนัก/i.test(name ?? ''); }
  async buyWeightScrolls() {
    const have = this.scrollCount();
    if (have >= 10) return have;
    await this.ensureMap('capital').catch(() => {});
    await this.walkToNpc(NPCS.n2);
    await this.talk('n2');
    this.s.shop = null;
    await this.chooseByKeyword('ซื้อของหน่อย', { timeout: 6000 });
    try { await this.waitFor(() => this.s.shop, 'shop', 8000); } catch {}
    const shop = this.s.shop;
    const item = (shop?.items ?? []).find((x) => this.isScrollName(x.name));
    if (!item) { this.log('scroll_no_shop', { items: (shop?.items ?? []).map((x) => `${x.name}:${x.price}`).slice(0, 14) }); this.c.npcClose(); await sleep(400); return have; }
    const price = item.price || 5000;
    const zeny = this.char?.zeny ?? 0;
    const want = Math.min(10 - have, Math.floor(Math.max(0, zeny - 5000) / price));
    if (want <= 0) { this.log('scroll_no_budget', { have, zeny, price }); this.c.npcClose(); await sleep(400); return have; }
    this.c.send('shop_buy', { itemId: item.itemId, qty: want });
    this.log('scroll_buy', { item: item.name, price, qty: want, zeny });
    await sleep(2500);
    this.c.npcClose(); await sleep(400);
    this.c.invSort(); await sleep(900);
    let used = have;
    const wl0 = this.s.inventory?.weightLimit ?? null;
    for (let i = have; i < 10; i++) {
      const it = (this.s.inventory?.items ?? []).find((x) => this.isScrollName(x.name));
      if (!it) break;
      const wl = this.s.inventory?.weightLimit ?? 0;
      const q0 = it.qty ?? 1;
      this.c.invUse(it.slot);
      const okUse = await this.waitFor(() => {
        const inv = this.s.inventory; if (!inv) return false;
        const same = (inv.items ?? []).find((x) => x.slot === it.slot);
        return (inv.weightLimit ?? 0) !== wl || !same || (same.qty ?? 1) < q0;
      }, 'scroll use', 4000).catch(() => false);
      if (!okUse) { this.log('scroll_use_fail', { n: used, weightLimit: this.s.inventory?.weightLimit ?? null }); break; }
      used = i + 1;
      this.setScrollCount(used);
      await sleep(2400); // ≥2s required between consumptions
    }
    this.log('scroll_done', { count: used, weightLimitBefore: wl0, weightLimitAfter: this.s.inventory?.weightLimit ?? null });
    return used;
  }

  // ---- butterfly wings: farm → capital fast-lane (verified live 2026-10-08: use = warp to the capital
  // save point from ANY map — travel msg + room rejoin). Bor restocks them for 300z; the collect/errand
  // flows top up while in town, and every capital-bound ensureMap() rides one when stocked.
  wingEnabled() { return (this.wingCfg?.enabled ?? true) !== false; }
  wingKeep() { return Math.max(0, this.wingCfg?.keep ?? 10); }
  wingCount() { return (this.s.inventory?.items ?? []).filter((x) => x.itemId === WING_BUTTERFLY).reduce((n, x) => n + (x.qty ?? 1), 0); }
  async useButterflyWing() {
    // async flows can race (death recovery vs farm-loop restock) — share ONE in-flight attempt so a single
    // trip never consumes two wings or leaves a duplicate traveler behind
    if (this._wingTask) return this._wingTask;
    this._wingTask = this._useButterflyWingInner().finally(() => { this._wingTask = null; });
    return this._wingTask;
  }
  async _useButterflyWingInner() {
    if (this.c.mapId === 'capital') return { ok: false, reason: 'already-in-capital' };
    if (this.s.death) return { ok: false, reason: 'dead' };
    const it = (this.s.inventory?.items ?? []).find((x) => x.itemId === WING_BUTTERFLY);
    if (!it) return { ok: false, reason: 'no-wing' };
    this.s.travel = null;
    try { this.c.npcClose(); } catch {}
    this.log('wing_use', { from: this.c.mapId, left: this.wingCount() });
    this.c.invUse(it.slot);
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      if (this.c.mapId === 'capital') return { ok: true, ms: Date.now() - t0 };
      const tr = this.s.travel;
      if (tr && tr.mapId === 'capital') {
        this.log('travel_msg', { mapId: tr.mapId, roomId: tr.roomId, channel: tr.channel, endpoint: tr.endpoint, displayName: tr.displayName, wing: true });
        await this.c.rejoinRoom(tr).catch(() => {});
        await sleep(1500);
        if (this.c.mapId === 'capital') return { ok: true, ms: Date.now() - t0 };
      }
      await sleep(500);
    }
    return { ok: false, reason: 'timeout' };
  }
  // restock at Bor (n2, capital). Only runs while ALREADY in capital — never adds a trip by itself.
  async buyButterflyWings(target = null) {
    const want0 = target ?? this.wingKeep();
    if (!this.wingEnabled() || want0 <= 0) return this.wingCount();
    const have = this.wingCount();
    if (have >= want0) return have;
    if (this.c.mapId !== 'capital') return have;
    await this.walkToNpc(NPCS.n2);
    await this.talk('n2');
    this.s.shop = null;
    await this.chooseByKeyword('ซื้อของหน่อย', { timeout: 6000 });
    try { await this.waitFor(() => this.s.shop, 'shop', 8000); } catch {}
    const item = (this.s.shop?.items ?? []).find((x) => x.itemId === WING_BUTTERFLY);
    if (!item) { this.log('wing_no_shop', {}); this.c.npcClose(); await sleep(400); return have; }
    const zeny = this.char?.zeny ?? 0;
    const want = Math.min(want0 - have, Math.floor(Math.max(0, zeny - 5000) / (item.price || 300)));
    if (want <= 0) { this.log('wing_no_budget', { have, zeny }); this.c.npcClose(); await sleep(400); return have; }
    this.c.send('shop_buy', { itemId: WING_BUTTERFLY, qty: want });
    this.log('wing_buy', { qty: want, price: item.price, zeny, have });
    await sleep(2000);
    this.c.npcClose(); await sleep(400);
    this.c.invSort(); await sleep(900);
    return this.wingCount();
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

  // RETIRED 2026-10-07 — no longer called. The configured sequence now rides the AUTO config and the game's
  // own engine casts it server-side (works even on sessions that silently ignore client casts). Kept for
  // reference only. (Historical note: it cast at mobs that were just hit near us — hits carry target pos.)
  weaveTick(skills) {
    const use = this.weaveOverride ?? skills;
    if (!use?.length || this.s.death || !this.isConnected()) return;
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
    const sid = use[this.weaves % use.length];
    this.weaves++;
    this.c.cast(sid, pick.id);
    this.log('skill_use', { s: sid, t: pick.id, sp });
  }
  onKill(g) { if (g && g.monster) this.kills++; }
  onItemFx(d) {
    if (!d || d.sessionId !== this.selfId()) return;
    this._lastLifeAt = Date.now(); // our potion/heal fx — we're alive
    const cb = this.combat;
    if (d.hp > 0 && cb.maxHp != null) cb.hp = Math.min(cb.maxHp, (cb.hp ?? cb.maxHp) + d.hp);
    if (d.sp > 0 && cb.maxSp != null) cb.sp = Math.min(cb.maxSp, (cb.sp ?? cb.maxSp) + d.sp);
  }

  snap() {
    const c = this.c, s = this.s, ch = s.character, cb = this.combat;
    let live = null; try { live = c.live; } catch {}
    const lm = c.lastMove;
    const an = ch?.auto?.anchor;
    const inv = s.inventory;
    const used = inv?.items?.length ?? null;
    const free = (inv && inv.slots != null && used != null) ? inv.slots - used : null;
    return {
      step: this.stepId,
      selfId: this.selfId(),
      weapon: ch?.equipment?.['main-hand']?.name ?? null,
      // full equipment map for the dashboard detail modal — gear 12 slots + costume + gem-1..4; values are the
      // same item objects the game's equipment panel renders (2026-10-07)
      equipment: ch?.equipment
        ? Object.entries(ch.equipment).filter(([, it]) => it && it.name).map(([slot, it]) => ({ slot, itemId: it.itemId ?? null, name: it.name, refine: it.refine ?? 0 }))
        : null,
      map: c.mapId,
      lastMoveTile: lm ? [+(lm.x / 32).toFixed(1), +(lm.y / 32).toFixed(1)] : null,
      lastMoveAgeSec: lm ? Math.round((Date.now() - lm.t) / 1000) : null,
      anchorTile: an ? [+(an.x / 32).toFixed(1), +(an.y / 32).toFixed(1)] : null,
      hp: live ? live.hp : (cb.hp != null ? Math.round(cb.hp) : null), maxHp: live ? live.maxHp : cb.maxHp,
      sp: live ? live.sp : (cb.sp != null ? Math.round(cb.sp) : null), maxSp: live ? live.maxSp : cb.maxSp,
      bashLv: ch?.skills?.bash ?? null, hpItems: (ch?.auto?.config?.hpItems ?? []).length, weaves: this.weaves, pots: this.potCount(),
      mobHits: this._mobHits || 0,
      pets: ch?.pets ? { owned: (ch.pets.owned ?? []).length, active: ch.pets.active ? (ch.pets.active.name ?? ch.pets.active.id ?? 'yes') : null } : null,
      stats: ch?.stats ? { STR: ch.stats.STR, AGI: ch.stats.AGI, VIT: ch.stats.VIT, INT: ch.stats.INT, DEX: ch.stats.DEX, LUK: ch.stats.LUK } : null,
      statusPoints: ch?.statusPoints ?? null, skillPoints: ch?.skillPoints ?? null, skills: ch?.skills ?? null,
      weightScrolls: this.scrollCount(),
      bag: { used, free, weight: inv?.weight ?? null, weightLimit: inv?.weightLimit ?? null },
      zeny: ch?.zeny ?? null, base: ch?.baseLevel ?? null, job: ch?.jobLevel ?? null, classId: ch?.classId ?? null,
      auto: ch?.auto?.enabled ?? null, dead: live ? live.dead : !!s.death, sus: !!this._sus,
      world: live ? { hp: live.hp, maxHp: live.maxHp, dead: live.dead, x: live.x != null ? Math.round(live.x) : null, y: live.y != null ? Math.round(live.y) : null, ch: live.channel, ageSec: live.at ? Math.round((Date.now() - live.at) / 1000) : null } : null,
      killsTotal: this.kills, hitsInTotal: this.hitsIn,
    };
  }
  startHeartbeat(intervalMs = 20000) {
    const tick = () => {
      try {
        try {
          const lv = this.c.live;
          if (lv && lv.dead && !this.s.death) {
            this.log('DEATH_WORLD', { hp: lv.hp, via: 'heartbeat' });
            this.s.death = { autoReleaseSeconds: 300, how: 'world' }; this._deathMsgAt = Date.now(); this.combat.hp = 0;
            this.deathRecover({ real: true }).catch((e) => this.log('death_park_fail', String((e && e.message) || e)));
          }
        } catch {}
        this.log('HEARTBEAT', this.snap());
        const api = (inv) => (inv?.items ?? []).slice(0, 120).map((it) => ({ slot: it.slot, itemId: it.itemId, name: it.name, qty: it.qty, refine: it.refine ?? null }));
        const st = this.s.storage;
        if (st) this._storeSnap = { slots: st.slots ?? null, zeny: st.zeny ?? null, items: (st.items ?? []).slice(0, 300).map((it) => ({ slot: it.slot, itemId: it.itemId, name: it.name, qty: it.qty, refine: it.refine ?? null })) };
        writeStatus({
          ...this.snap(), state: _ctrlState, mode: MODE,
          channel: this.s.channels?.current ?? null,
          connected: this.isConnected(),
          inventory: api(this.s.inventory), storage: this._storeSnap ?? null, storageAt: this._storeSnapAt ?? null,
          wantCollect: !!this.wantCollect, pendingGrant: !!this.pendingGrant, collectDone: this.lastCollectDone ?? null,
        });
      } catch (e) { try { this.log('HEARTBEAT_ERR', String(e)); } catch {} }
    };
    this._hbTick = tick; // pushStatus() can force an immediate heartbeat (fast UI feedback)
    tick();
    if (this._hbTimer) clearInterval(this._hbTimer);
    this._hbTimer = setInterval(tick, intervalMs);
  }
  pushStatus() { try { this._hbTick?.(); } catch {} }

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
        if (/ออนไลน์อยู่แล้ว|already online/i.test(msg)) {
          await this.kickPreviousSession(); // force-online: kick the stale session out, then retry fast
          await sleep(2500);
        } else {
          await sleep(/429|too many/i.test(msg) ? 45000 : 5000);
        }
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

  // Force-online: kick this character's previous (stale) session offline — the exact call the game's
  // character-select "kick" button makes (POST /characters/:id/kick). A hard-killed runner leaves the
  // character marked "ตัวละครในบัญชีนี้ออนไลน์อยู่แล้ว" (already online) and joins fail until it expires;
  // kicking frees the seat immediately. Retries once with a fresh token when the cached one has expired.
  async kickPreviousSession() {
    const url = `https://www.aetheria-online.in.th/characters/${this.charId}/kick`;
    const call = async () => {
      const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${this.c.token}` } });
      let j = null; try { j = await res.json(); } catch {}
      return { status: res.status, ok: res.ok, err: (j && (j.error ?? j.err)) || null };
    };
    try {
      let r = await call();
      if (r.status === 401) { await this.relogin(); r = await call(); } // expired token → refresh once and retry
      this.log(r.ok ? 'kick_session_ok' : 'kick_session_fail', { status: r.status, err: r.err });
      return r.ok;
    } catch (e) { this.log('kick_session_fail', { err: String((e && e.message) || e) }); return false; }
  }

  // items to sell at the vendor: everything sellable that is NOT whitelisted, not a card and not one of the
  // bot's own potions — same policy as sellJunkExcept
  sellableLines() {
    const inv = this.s.inventory;
    if (!inv?.items) return [];
    const keep = this.keepIds();
    const base = inv.items
      .filter((it) => (it.sellPrice ?? 0) > 0
        && !keep.has(it.itemId)
        && !CARD_RE.test(it.name ?? '')
        && !this.isScrollName(it.name)
        && it.autoPotion !== 'HP' && it.autoPotion !== 'SP'
        && !/(potion|ยา)/i.test(it.name ?? ''))
      .map((it) => ({ slot: it.slot, qty: it.qty }));
    return [...base, ...this._consumablePolicyLines()]; // surplus consumables ride along
  }
  // Consumables policy (2026-10-06, user rule): keep ONLY the configured potion (farm.potItem) up to the
  // refill threshold (farm.restockQty); every other potion-like item (carrots, event potions, other tiers) is sold.
  // Whitelisted items are never touched. Items the vendor refuses (sellPrice 0) stay in the bag.
  _consumablePolicyLines() {
    const keep = this.keepIds();
    const keepName = (this.potItemName ?? 'Red Potion').toLowerCase();
    let keepLeft = Math.max(0, this.restockQty ?? 45);
    const out = [];
    for (const it of (this.s.inventory?.items ?? [])) {
      const consumable = it.autoPotion === 'HP' || it.autoPotion === 'SP' || /(potion|ยา)/i.test(it.name ?? '');
      if (!consumable || keep.has(it.itemId)) continue;
      let sellN = it.qty ?? 1;
      if ((it.name ?? '').toLowerCase() === keepName && keepLeft > 0) {
        const keepN = Math.min(sellN, keepLeft);
        keepLeft -= keepN;
        sellN -= keepN;
      }
      if (sellN > 0 && (it.sellPrice ?? 0) > 0) out.push({ slot: it.slot, qty: sellN });
    }
    return out;
  }
  async waitFor(pred, desc, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (pred()) return true; await sleep(250); }
    throw new Error(`timeout waiting: ${desc}`);
  }

  // Monster templateIds that spawn on `mapId` — the live room roster first (every spawn of the current
  // room), the wiki spawn index (monster.spawns[].mapId) as fallback for maps we're not standing on.
  _mapSpawnIds(mapId = this.c.mapId) {
    if (mapId === this.c.mapId) {
      const ids = [...new Set([...(this.c.world?.roster ?? [])].map((r) => Number(r?.templateId)).filter(Number.isFinite))];
      if (ids.length) return ids;
    }
    try {
      if (!this._wikiMonsters) {
        const p = new URL('../../recon/wiki-data.json', import.meta.url);
        this._wikiMonsters = JSON.parse(fs.readFileSync(p, 'utf8')).monsters ?? [];
      }
      return [...new Set(this._wikiMonsters.filter((m) => (m.spawns ?? []).some((s) => s.mapId === mapId)).map((m) => m.id))];
    } catch { return []; }
  }

  // -------- actions --------
  async setAuto(patch) {
    const base = this.char?.auto?.config ?? {};
    const cfg = { ...base, ...(patch ?? {}) };
    if (this.autoOverride) for (const [k, v] of Object.entries(this.autoOverride)) if (v !== null && v !== undefined) cfg[k] = v;
    // 2026-10-07: feed the configured sequence to the game's AUTO engine (this is exactly the auto panel's
    // checked-skills list, in tick order = priority, max 9)
    if (this._weaveSeq?.length) cfg.skills = [...this._weaveSeq].slice(0, 9);
    // monsters: the engine matches TEMPLATE IDS against THIS ROOM's monsters. A list authored for another
    // map matches nothing → the engine IDLES (bots stand, drain potions, die — the verdant_farm incident,
    // 2026-10-07). Resolve at SEND TIME against the target map so plan switches / map moves self-heal:
    //   • no monsters selected → all spawns of this map   • some selected → keep only the ones that spawn here
    //   • selection matches nothing here (stale plan list) → all spawns too (never idle again)
    {
      const roster = this.c.world?.roster ?? [];
      const byName = new Map([...roster].map((r) => [String(r?.name ?? '').toLowerCase(), r?.templateId]));
      const sel = (Array.isArray(cfg.monsters) ? cfg.monsters : [])
        .map((m) => (typeof m === 'number' ? m : (/^\d+$/.test(String(m)) ? Number(String(m)) : (byName.get(String(m).toLowerCase()) ?? null))))
        .filter((m) => Number.isFinite(m));
      const mapId = this._farmMap ?? this.c.mapId;
      const spawns = this._mapSpawnIds(mapId);
      if (spawns.length) {
        const inMap = sel.filter((id) => spawns.includes(id));
        cfg.monsters = inMap.length ? inMap : spawns.slice(0, 60);
        const mode = sel.length === 0 ? 'all-map-spawns' : inMap.length ? 'filtered' : 'stale->all-map-spawns';
        const key = mode + JSON.stringify(cfg.monsters);
        if (key !== this._monKey) {
          this._monKey = key;
          this.log('monster_resolve', { map: mapId, selected: sel.length, onMap: inMap.length, spawns: spawns.length, sent: cfg.monsters.length, mode });
        }
      } else {
        cfg.monsters = sel; // no spawn data for this map (e.g. capital) — pass through as-is
      }
    }
    // the game stores auto skills as an array of skill-id STRINGS (auto panel code); normalize objects too
    if (Array.isArray(cfg.skills)) cfg.skills = cfg.skills.map((s) => (typeof s === 'string' ? s : (s?.id ?? s?.skillId))).filter(Boolean);
    // auto-potion lists = arrays of itemIds; derive from inventory items flagged autoPotion:'HP'|'SP'
    const inv = this.s.inventory?.items ?? [];
    const hpIds = [...new Set([
      ...inv.filter((i) => i.autoPotion === 'HP').map((i) => i.itemId),
      ...inv.filter((i) => /potion|ยา/i.test(i.name || '') && !/(sp|blue|ฟ้า)/i.test(i.name || '')).map((i) => i.itemId),
    ])].slice(0, 4);
    const spIds = [...new Set(inv.filter((i) => i.autoPotion === 'SP').map((i) => i.itemId))].slice(0, 4);
    // 2026-10-07 (post-update): enable can be refused when the stored config references items the character
    // no longer owns (dead potion/SP refs accumulate after recoveries). Always prune to what is actually carried.
    cfg.hpItems = hpIds;
    cfg.spItems = spIds;
    this.c.autoConfig(cfg);
    await sleep(600);
    this.c.autoEnabled(true);
    await this.waitFor(() => this.char?.auto?.enabled === true, 'auto enabled', 6000).catch(() => {});
    let how = this.char?.auto?.enabled === true ? 'prune+split' : null;
    if (!how) {
      // self-diagnosing ladder: B = single combined {config+enabled} message, C = enabled-only retry
      try { this.c.send('auto_set', { ...cfg, enabled: true }); } catch {}
      await sleep(1500);
      if (this.char?.auto?.enabled === true) how = 'combined';
    }
    if (!how) {
      this.c.autoEnabled(true);
      await sleep(1500);
      if (this.char?.auto?.enabled === true) how = 'enabled-only';
    }
    const rb = this.char?.auto?.config;
    const invPots = inv.filter((i) => /potion|ยา/i.test(i.name || '')).reduce((s2, i) => s2 + (i.qty || 1), 0);
    this.log('setAuto', { skills: rb?.skills ?? cfg.skills, radius: rb?.huntRadiusTiles, monsters: (Array.isArray(cfg.monsters) ? cfg.monsters.length : 0), monsterIds: Array.isArray(cfg.monsters) ? cfg.monsters.slice(0, 9) : [], hpItems: (rb?.hpItems ?? []).length, hpPercent: rb?.hpPercent, bashLv: this.char?.skills?.bash ?? null, enabled: this.char?.auto?.enabled, how, potions: invPots, map: this.c.mapId });
    if (this.char?.auto?.enabled !== true) {
      this._autoFails = (this._autoFails || 0) + 1;
      this.log('auto_enable_failed', { map: this.c.mapId, hpItems: cfg.hpItems?.length ?? 0, spItems: cfg.spItems?.length ?? 0, invPots, fails: this._autoFails });
      // 2026-10-07: some post-update sessions refuse enable until a FRESH login (manual bounce always cleared it).
      // If we're on the farm map and 3 attempts in a row failed, self-heal with a reconnect (90s cooldown).
      if (this._autoFails >= 3 && this._farmMap && this.c.mapId === this._farmMap && Date.now() > (this._autoRescueAt ?? 0)) {
        this._autoRescueAt = Date.now() + 90 * 1000;
        this._autoFails = 0;
        this.autoRescue().catch((e) => this.log('auto_rescue_fail', String((e && e.message) || e)));
      }
    } else {
      this._autoFails = 0;
    }
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

  // Cap-aware dump (2026-10-07): the server silently refuses stat_up once a stat hits its cap (STR=99 observed
  // — 445 pts/bot were stuck because this retried STR forever) AND refuses everything the bank can't afford
  // (costs escalate: VIT 86 costs several points per +1). Strategy: sweep the candidates until one moves or the
  // WHOLE list refuses; when nothing can move, log once and stay quiet until the bank grows (recheck ≤10 min).
  // The old version re-swept every farm checkpoint (2.5s windows truncated the sweep → the give-up path never
  // fired → dump_stat_switch spam every ~8s per bot: the "pts:2" flood, 2026-10-07).
  async dumpStat(stat, { waitMs = 60000 } = {}) {
    const order = [...new Set([stat, 'VIT', 'AGI', 'DEX', 'LUK', 'INT'])];
    const ch0 = this.char;
    if (!ch0 || (ch0.statusPoints ?? 0) <= 0) return true;
    // same point bank as the last exhausted sweep → pointless to retry now (unless the 10-min recheck is due)
    if ((ch0.statusPoints ?? 0) === this._statDumpBlockedPts && Date.now() < (this._statDumpRetryAt ?? 0)) return true;
    const t0 = Date.now();
    const deadline = t0 + Math.max(waitMs, 45000); // enough to FINISH a full sweep (6 stats × 2 × 400ms ≈ 5s)
    let ci = 0, stalls = 0, movedAny = false;
    while (Date.now() < deadline) {
      const ch = this.char;
      if (!ch || (ch.statusPoints ?? 0) <= 0) { if (movedAny) { this._statDumpBlockedPts = 0; this._statDumpRetryAt = 0; } return true; }
      const cur = order[Math.min(ci, order.length - 1)];
      const pts0 = ch.statusPoints;
      const val0 = ch.stats?.[cur] ?? 0;
      this.c.statUp(cur, 1);
      await sleep(400);
      const ch2 = this.char;
      const moved = (ch2?.statusPoints ?? 0) < pts0 || (ch2?.stats?.[cur] ?? 0) > val0;
      if (moved) { movedAny = true; stalls = 0; continue; }
      stalls++;
      if (stalls >= 2 && ci < order.length - 1) {
        ci++;
        stalls = 0;
        this.log('dump_stat_switch', { from: cur, to: order[ci], pts: ch2?.statusPoints ?? 0 });
      } else if (stalls >= 2 && ci >= order.length - 1) {
        // full sweep, zero movement: every stat is capped or unaffordable — stop churning until the bank grows
        const pts = ch2?.statusPoints ?? 0;
        if (pts !== this._statDumpBlockedPts) this.log('dump_stat_idle', { pts, note: 'no stat moved (capped or unaffordable) — waiting for more points' });
        this._statDumpBlockedPts = pts;
        this._statDumpRetryAt = Date.now() + 10 * 60 * 1000;
        return true;
      }
    }
    if (movedAny) { this._statDumpBlockedPts = 0; this._statDumpRetryAt = 0; }
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
    const prot = (inv?.items ?? []).filter((it) => CARD_RE.test(it.name ?? ''));
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

  // ---- storage (farming mode): deposit configured keep-items, never sell them ----
  async depositKeepItems(keepIds, { npcKey = 'n6' } = {}) {
    return this.depositItemsWhere((it) => keepIds.has(it.itemId), { npcKey });
  }
  async depositItemsWhere(pred, { npcKey = 'n6', label = 'storage' } = {}) {
    const all = (this.s.inventory?.items ?? []).filter(pred);
    if (!all.length) return 0;
    await this.ensureMap('capital');
    const npcPx = NPCS[npcKey] ?? NPCS.n6;
    await this.walkToNpc(npcPx);
    await this.talk(npcKey);
    const opt = this.findOption(this.s.dialog, 'คลัง') ?? this.findOption(this.s.dialog, 'ฝาก') ?? this.findOption(this.s.dialog, 'storage');
    if (!opt) { this.log('storage_npc_probe', { npc: npcKey, options: this.s.dialog?.options ?? null }); this.c.npcClose(); await sleep(400); return 0; }
    this.s.storage = null;
    this.c.npcOption(opt.index);
    try { await this.waitFor(() => !!this.s.storage, 'storage window', 9000); } catch { this.log('storage_open_fail', { npc: npcKey }); return 0; }
    let moved = 0, misses = 0, skipped = 0;
    const stoQty = () => (this.s.storage?.items ?? []).reduce((s, it) => s + (it.qty ?? 1), 0);
    const list = all.slice();
    for (let guard = 0; guard < 140 && list.length; guard++) {
      const it = list[0];
      const invBefore = this.s.inventory?.items?.length ?? 0;
      const stoBefore = stoQty();
      this.c.storagePut(it.slot, it.qty);
      const okPut = await this.waitFor(() => {
        const invNow = this.s.inventory?.items?.length ?? 0;
        return stoQty() > stoBefore || invNow < invBefore;
      }, 'storage put', 3000).catch(() => false);
      if (okPut) { moved++; misses = 0; list.shift(); }
      else {
        misses++;
        this.log('storage_put_miss', { item: it?.name ?? null, qty: it?.qty ?? null });
        if (misses >= 2) { this.log('storage_put_skip', { item: it?.name ?? null, note: 'item not depositable — skipping' }); list.shift(); misses = 0; skipped++; }
      }
      await sleep(300);
    }
    this.c.npcClose(); await sleep(500);
    this.c.invSort(); await sleep(700);
    this.log('storage_deposit_done', { moved, skipped, label });
    return moved;
  }

  // after selling: get everything left that is neither whitelist nor one of the bot's own potions out of the bag
  // (shop-refused / unsellable items) so the bag stays lean for grinding
  async depositJunkToStorage(keepIds, { npcKey = 'n6' } = {}) {
    return this.depositItemsWhere((it) => !keepIds.has(it.itemId)
      && it.autoPotion !== 'HP' && it.autoPotion !== 'SP'
      && !/(potion|ยา)/i.test(it.name ?? ''), { npcKey, label: 'junk' });
  }

  async sellJunkExcept(keepIds = new Set()) {
    await this.ensureMap('capital').catch(() => {});
    await this.walkToNpc(NPCS.n2);
    await this.talk('n2');
    const opt = this.findOption(this.s.dialog, 'ซื้อ') ?? { index: 0 };
    this.s.shop = null;
    this.c.npcOption(opt.index);
    await this.waitFor(() => this.s.shop, 'shop', 8000).catch(() => {});
    // sell EVERYTHING sellable that is not whitelisted (cards are protected; potions are kept up to a reserve)
    const lines = (this.s.inventory?.items ?? [])
      .filter((it) => (it.sellPrice ?? 0) > 0
        && !keepIds.has(it.itemId)
        && !CARD_RE.test(it.name ?? '')
        && !this.isScrollName(it.name ?? '')
        && it.autoPotion !== 'HP' && it.autoPotion !== 'SP'
        && !/(potion|ยา)/i.test(it.name ?? ''))
      .map((it) => ({ slot: it.slot, qty: it.qty }));
    // consumables: keep ONLY the configured potion up to the refill threshold; sell every other potion-like item
    lines.push(...this._consumablePolicyLines());
    const before = this.char?.zeny ?? 0;
    if (lines.length) { this.c.shopSellMany(lines); this.log('sold_except_keep', { lines: lines.length }); await sleep(2000); }
    this.c.npcClose(); await sleep(400);
    return (this.char?.zeny ?? 0) - before;
  }

  // ---- channels ----
  async channelsSnapshot({ refresh = true, since = 0 } = {}) {
    if (refresh) this.c.channelList();
    try { await this.waitFor(() => { const m = this.c.msgs.get('channels'); return m && Date.now() - m.at < 9000 && m.at >= since; }, 'channels msg', 9000); } catch { return null; }
    return this.c.msgs.get('channels')?.data ?? null;
  }
  // channel_switch works like a travel: the server pushes a travel msg for the SAME map with a new room;
  // the client must leave + rejoin that room to land on the new channel.
  async applyChannelTravel({ timeout = 9000 } = {}) {
    const got = await this.waitFor(() => { const t = this.s.travel; return t && t.mapId === this.c.mapId; }, 'channel travel msg', timeout).catch(() => false);
    if (!got) return false;
    const tr = this.s.travel; this.s.travel = null;
    this.log('channel_travel_rejoin', { mapId: tr.mapId, roomId: tr.roomId, endpoint: tr.endpoint ?? null });
    await this.c.rejoinRoom(tr);
    await sleep(1500);
    return true;
  }
  async switchToChannel(target, { tries = 3 } = {}) {
    for (let i = 1; i <= tries; i++) {
      // the server silently ignores channel_switch while a post-switch cooldown is active → wait it out
      await this.waitChannelCooldown();
      const snap = await this.channelsSnapshot();
      if (!snap) return false;
      if (snap.current === target) { this.log('channel_ok', { channel: target }); return true; }
      this.log('channel_switch_to', { channel: target, from: snap.current, attempt: i });
      const tSwitch = Date.now();
      this.s.travel = null; // drop any stale travel (e.g. left over from entering the map) — wait for THIS switch's response
      this.c.channelSwitch(target);
      await sleep(1200);
      const rejoined = await this.applyChannelTravel();
      if (rejoined) {
        const snap2 = await this.channelsSnapshot({ since: tSwitch });
        if (snap2?.current === target) { this.log('channel_ok', { channel: target, via: 'travel' }); return true; }
        this.log('channel_switch_mismatch', { want: target, now: snap2?.current ?? null });
      } else {
        this.log('channel_no_travel', { attempt: i });
      }
      await sleep(1500);
    }
    const snap = await this.channelsSnapshot();
    const ok = !!(snap && snap.current === target);
    this.log('channel_switch_result', { ok, now: snap?.current ?? null });
    return ok;
  }
  // the channels msg carries cooldownUntil — switching during cooldown is a silent no-op
  async waitChannelCooldown(maxMs = 15000) {
    try {
      const cd = this.c.msgs.get('channels')?.data?.cooldownUntil ?? 0;
      const left = cd - Date.now();
      if (left > 0 && left <= maxMs) { this.log('channel_cd_wait', { ms: Math.round(left) }); await sleep(left + 700); }
    } catch {}
  }
  // collect-side channel targeting: a bot that walks into capital ALREADY on the collector's channel
  // lands in a portal-assigned room where `trade request <name>` is silently dropped (the collector is
  // not resolvable there → 15s timeouts, endless retries = trade spam, 2026-10-08). A channel switch
  // re-instances the player into the channel's room — the same room the collector keeps alive. So when
  // we're already ON the target channel, hop out (least-populated other) and back to force the rejoin.
  async rejoinCollectorRoom(target) {
    if (target == null) return false;
    const snap = await this.channelsSnapshot();
    if (snap && snap.current === target) {
      const cands = (snap.channels ?? []).filter((c) => c.channel !== target && c.players < (snap.hardCap ?? 1e9));
      cands.sort((a, b) => a.players - b.players);
      const other = cands[0];
      if (!other) { this.log('collect_hop_no_target', {}); return this.switchToChannel(target).catch(() => false); }
      this.log('collect_channel_hop', { target, via: other.channel });
      await this.switchToChannel(other.channel, { tries: 2 }).catch(() => {});
      await sleep(800);
    }
    return this.switchToChannel(target, { tries: 3 }).catch(() => false);
  }
  async ensureLeastPopulatedChannel() {
    this._lastChanCheck = Date.now(); // any check resets the periodic 10-min timer (spawn/return/periodic share it)
    const snap = await this.channelsSnapshot();
    if (!snap || !Array.isArray(snap.channels)) { this.log('channel_no_data', {}); return false; }
    if (snap.cooldownUntil && snap.cooldownUntil > Date.now()) { this.log('channel_cooldown', { until: snap.cooldownUntil }); return false; }
    const here = snap.channels.find((c) => c.channel === snap.current) ?? null;
    // steer farm channels OFF the collector's channel: the butterfly wing preserves the current channel, so
    // arriving off-channel + ONE switch = direct rejoin into the collector's room (no out-and-back hop)
    const skip = this.collectCfg?.channel ?? this._collectorChannel ?? null;
    const cands = snap.channels.filter((c) => c.channel !== snap.current && c.players < (snap.hardCap ?? 1e9) && c.channel !== skip);
    cands.sort((a, b) => a.players - b.players);
    const best = cands[0];
    if (!best || (here && best.players >= here.players)) { this.log('channel_keep', { current: snap.current, players: here?.players ?? null, best: best ? [best.channel, best.players] : null }); return false; }
    this.log('channel_switch_to', { channel: best.channel, players: best.players, from: snap.current, fromPlayers: here?.players ?? null });
    const tSwitch = Date.now();
    this.s.travel = null; // drop any stale travel (e.g. left over from entering the map) — wait for THIS switch's response
    this.c.channelSwitch(best.channel);
    await sleep(1200);
    const rejoined = await this.applyChannelTravel();
    const snap2 = rejoined ? await this.channelsSnapshot({ since: tSwitch }) : null;
    const ok = !!(snap2 && snap2.current === best.channel);
    this.log('channel_switch_result', { ok, now: snap2?.current ?? null, rejoined });
    return ok;
  }

  // farm-return channel policy: after ANY town trip (errand / collect / death), the FIRST thing a farm bot
  // does once it's back on its grinding map is hop to the least-populated channel. Also resets the periodic
  // 10-minute channel check so the two never double-fire.
  async channelOnReturn() {
    if (!this.autoChannel) return;
    this._lastChanCheck = Date.now();
    await this.ensureLeastPopulatedChannel().catch(() => {});
  }

  // ---- collector trade (slot granted by the command-center queue) ----
  // butterfly wings are ALWAYS protected: never sold at vendors, never handed to the collector (fast-lane ticket)
  keepIds() { return new Set([...(this.keepItemIds ?? this.collectCfg?.keepItemIds ?? []), WING_BUTTERFLY]); }
  isKeepItem(it) { return !!it && this.keepIds().has(it.itemId); }

  // open the storage window at n6 (walk + dialog). Returns true when s.storage is live.
  async openStorage({ npcKey = 'n6' } = {}) {
    await this.ensureMap('capital');
    await this.walkToNpc(NPCS[npcKey] ?? NPCS.n6);
    if (this.s.storage) return true;
    await this.talk(npcKey);
    const opt = this.findOption(this.s.dialog, 'คลัง') ?? this.findOption(this.s.dialog, 'ฝาก') ?? this.findOption(this.s.dialog, 'storage');
    if (!opt) { this.log('storage_npc_probe', { npc: npcKey, options: this.s.dialog?.options ?? null }); this.c.npcClose(); await sleep(400); return false; }
    this.s.storage = null;
    this.c.npcOption(opt.index);
    try { await this.waitFor(() => !!this.s.storage, 'storage window', 9000); } catch { this.log('storage_open_fail', { npc: npcKey }); return false; }
    return true;
  }

  // manual storage refresh (command-center ⟳): drop the in-memory snapshot so openStorage truly re-reads,
  // open → read → close, then push an immediate status so the dashboard updates without waiting a heartbeat
  async refreshStorageSnapshot() {
    this.s.storage = null; // a stale snapshot would make openStorage() return instantly with old data
    const ok = await this.openStorage().catch(() => false);
    this.c.npcClose(); await sleep(400);
    this.pushStatus();
    return ok;
  }

  // pull whitelist items out of storage into the bag (chunked). Returns stacks moved.
  async withdrawKeepFromStorage(keepIds, { maxStacks = 24, npcKey = 'n6' } = {}) {
    this.s.storage = null; // force a fresh walk + window open (stale snapshots make the takes silently fail)
    const ok = await this.openStorage({ npcKey });
    if (!ok) return 0;
    let moved = 0, misses = 0;
    const stoKeep = () => (this.s.storage?.items ?? []).filter((it) => keepIds.has(it.itemId));
    const stoQty = () => stoKeep().reduce((s, it) => s + (it.qty ?? 1), 0);
    const invQty = () => (this.s.inventory?.items ?? []).reduce((s, it) => s + (it.qty ?? 1), 0);
    while (moved < maxStacks) {
      const cand = stoKeep();
      if (!cand.length) break;
      if ((this.s.inventory?.items?.length ?? 0) >= 90) break; // bag full guard
      const inv = this.s.inventory;
      if (inv && inv.weightLimit && (inv.weight ?? 0) >= inv.weightLimit * 0.85) { this.log('withdraw_weight_guard', { weight: inv.weight, limit: inv.weightLimit }); break; }
      const it = cand[0];
      const q0 = stoQty(); const i0 = invQty();
      this.c.storageTake(it.slot, it.qty);
      const okTake = await this.waitFor(() => stoQty() < q0 || invQty() > i0, 'storage take', 3000).catch(() => false);
      if (okTake) { moved++; misses = 0; } else { misses++; this.log('storage_take_miss', { item: it?.name ?? null }); if (misses >= 2) { this.log('storage_take_skip', { item: it?.name ?? null }); break; } }
      await sleep(300);
    }
    this.c.npcClose(); await sleep(400);
    this.log('storage_withdraw_done', { moved, remaining: Math.max(0, stoKeep().length) });
    return moved;
  }

  // one-shot: empty non-whitelist items out of a storage (collector cleanup) — withdraw in chunks, sell at the NPC, repeat
  async cleanupStorageNonKeep(keepIds, { maxRounds = 10, maxStacksPerRound = 24 } = {}) {
    let moved = 0;
    for (let r = 1; r <= maxRounds; r++) {
      this.s.storage = null; // force a fresh window
      const ok = await this.openStorage();
      if (!ok) { this.log('cleanup_storage_fail', {}); break; }
      const nonKeep = () => (this.s.storage?.items ?? []).filter((it) => !keepIds.has(it.itemId) && !CARD_RE.test(it.name ?? ''));
      const stoQty = () => nonKeep().reduce((a, x) => a + (x.qty ?? 1), 0);
      const invQty = () => (this.s.inventory?.items ?? []).reduce((a, x) => a + (x.qty ?? 1), 0);
      let took = 0, misses = 0;
      for (let guard = 0; guard < maxStacksPerRound; guard++) {
        const cand = nonKeep();
        if (!cand.length) break;
        if ((this.s.inventory?.items?.length ?? 0) >= 90) break;
        const it = cand[0];
        const q0 = stoQty(); const i0 = invQty();
        this.c.storageTake(it.slot, it.qty);
        const okTake = await this.waitFor(() => stoQty() < q0 || invQty() > i0, 'cleanup take', 3000).catch(() => false);
        if (okTake) { took++; misses = 0; } else { misses++; if (misses >= 2) break; }
        await sleep(300);
      }
      this.c.npcClose(); await sleep(400);
      moved += took;
      this.log('cleanup_withdrew', { round: r, took, remaining: nonKeep().length });
      if (took === 0) break;
      await this.sellJunkExcept(keepIds).catch(() => {});
      if (!nonKeep().length) break;
    }
    return { moved };
  }

  // step 0 of a collect turn: pull non-whitelist junk out of THIS bot's own storage, sell what sells at the
  // vendor, stow whatever the shop refuses back into storage. Exact sellability is unknown until an item is in
  // the bag (storage snapshots carry no sellPrice), so this withdraws → sells → stows back in bounded rounds
  // and remembers vendor-refused itemIds so they are not churned again in the same run.
  async sweepStorageJunk(keepIds, { maxRounds = 3, maxStacksPerRound = 20 } = {}) {
    let total = 0;
    const balky = new Set(); // itemIds the vendor refused this run — never re-withdraw them
    const isJunk = (it) => !keepIds.has(it.itemId)
      && !CARD_RE.test(it.name ?? '')
      && it.autoPotion !== 'HP' && it.autoPotion !== 'SP'
      && !/(potion|ยา)/i.test(it.name ?? '')
      && !balky.has(it.itemId);
    for (let r = 1; r <= maxRounds; r++) {
      this.s.storage = null; // fresh window each round — stale snapshots make takes silently fail
      const ok = await this.openStorage().catch(() => false);
      if (!ok) { this.log('junk_sweep_storage_fail', { round: r }); break; }
      let took = 0, misses = 0;
      for (let guard = 0; guard < maxStacksPerRound; guard++) {
        const cand = (this.s.storage?.items ?? []).filter(isJunk);
        if (!cand.length) break;
        if ((this.s.inventory?.items?.length ?? 0) >= 88) break; // keep a little bag room
        const inv = this.s.inventory;
        if (inv && inv.weightLimit && (inv.weight ?? 0) >= inv.weightLimit * 0.8) { this.log('junk_sweep_weight_guard', {}); break; }
        const it = cand[0];
        const q0 = cand.reduce((a, x) => a + (x.qty ?? 1), 0);
        const i0 = (this.s.inventory?.items ?? []).reduce((a, x) => a + (x.qty ?? 1), 0);
        this.c.storageTake(it.slot, it.qty);
        const okTake = await this.waitFor(() => {
          const q1 = (this.s.storage?.items ?? []).filter(isJunk).reduce((a, x) => a + (x.qty ?? 1), 0);
          const i1 = (this.s.inventory?.items ?? []).reduce((a, x) => a + (x.qty ?? 1), 0);
          return q1 < q0 || i1 > i0;
        }, 'junk take', 3000).catch(() => false);
        if (okTake) { took++; misses = 0; } else { misses++; this.log('junk_sweep_take_miss', { item: it?.name ?? null }); if (misses >= 2) break; }
        await sleep(300);
      }
      this.c.npcClose(); await sleep(400);
      if (took === 0) break;
      total += took;
      this.log('junk_sweep_withdrew', { round: r, took });
      await this.sellJunkExcept(keepIds).catch(() => {});
      // everything non-keep left in the bag was refused by the vendor — exclude it from further rounds
      for (const it of (this.s.inventory?.items ?? [])) if (isJunk(it)) balky.add(it.itemId);
      await this.depositJunkToStorage(keepIds).catch(() => {});
    }
    return total;
  }

  async collectToCollector(g) {
    const t0 = Date.now();
    if (g.channel != null) this._collectorChannel = g.channel; // remembered: farm channels steer clear of it
    const keep = this.keepIds();
    // 50k reserve (was 10k): every bot must afford 10× weight-limit scrolls (5,000z each) at Shopkeeper Bor
    const RESERVE = 50000;
    const RUN_LIMIT_MS = 25 * 60 * 1000;
    this.log('collect_start', { collector: g.collector, channel: g.channel, whitelist: [...keep] });
    try { this.c.autoEnabled(false); } catch {}
    await this.ensureMap('capital');
    if (g.channel != null) await this.rejoinCollectorRoom(g.channel).catch(() => {});
    const spot = (g.spot && g.spot.x != null) ? g.spot : { x: 880, y: 1520 };
    this.c.moveToPx(spot.x, spot.y);
    await sleep(2200);
    // NEW POLICY (2026-10-06): bots NEVER touch storage (no deposits, no withdrawals, no sweeps).
    // Everything travels: bag → vendor (sellables) → collector (whitelist + zeny, batched trades).
    // 1) dump junk at the vendor so only whitelist + zeny travel (potions/gems are protected by sellableLines)
    try {
      const sellable = (this.s.inventory?.items ?? []).filter((it) => (it.sellPrice ?? 0) > 0 && !keep.has(it.itemId) && !CARD_RE.test(it.name ?? '') && it.autoPotion !== 'HP' && it.autoPotion !== 'SP' && !/(potion|ยา)/i.test(it.name ?? ''));
      if (sellable.length) { await this.sellJunkExcept(keep); this.c.moveToPx(spot.x, spot.y); await sleep(1800); }
    } catch (e) { this.log('collect_sell_fail', String((e && e.message) || e)); }
    // town trip → top up weight-limit scrolls (Bor stands on this exact spot) — also done on errands
    if (this.scrollCount() < 10) { try { await this.buyWeightScrolls(); this.c.moveToPx(spot.x, spot.y); await sleep(1200); } catch (e) { this.log('scroll_fail', String((e && e.message) || e)); } }
    await this.buyButterflyWings().catch(() => {}); // keep the farm→capital fast-lane stocked while we're in town
    let rounds = 0, offered = 0, zenyMoved = 0, stacksMoved = 0, noProgAt = 0;
    let openStreak = 0, hopUsed = false;
    const bagKeep = () => (this.s.inventory?.items ?? []).filter((it) => keep.has(it.itemId) && it.itemId !== WING_BUTTERFLY);
    while (Date.now() - t0 < RUN_LIMIT_MS && rounds < 80) {
      // the server can drop sockets (4001/1006 bursts) — recover instead of spinning on a dead connection
      if (!this.isConnected()) {
        this.log('collect_disconnected', { round: rounds });
        try { await this.reconnect(); this.log('collect_reconnected', { map: this.c.mapId }); }
        catch (e) { this.log('collect_reconnect_fail', String((e && e.message) || e)); await sleep(5000); continue; }
        if (this.c.mapId !== 'capital') await this.ensureMap('capital').catch(() => {});
        if (g.channel != null) await this.rejoinCollectorRoom(g.channel).catch(() => {});
        this.c.moveToPx(spot.x, spot.y);
        await sleep(1800);
        continue;
      }
      const zeny = this.char?.zeny ?? 0;
      const giveZeny = Math.max(0, zeny - RESERVE);
      const items = bagKeep();
      if (!items.length && giveZeny < 500) break; // everything handed over
      // recipient bag full? collector deposits on its side; give it a moment before retrying
      if (noProgAt && Date.now() - noProgAt < 60000) { await sleep(5000); continue; }
      noProgAt = 0;
      rounds++;
      const seq = this.s.tradeSeq || 0;
      this.log('trade_request_send', { round: rounds, collector: g.collector, stacks: items.length, zeny: giveZeny });
      this.c.tradeRequest(g.collector);
      const opened = await this.waitFor(() => (this.s.tradeSeq || 0) > seq, 'trade open', 15000).catch(() => false);
      if (!opened) {
        openStreak++;
        this.log('trade_open_timeout', { round: rounds, invite: this.s.invite ?? null, streak: openStreak });
        if (openStreak >= 6) {
          if (!hopUsed) {
            // window never opens = the collector isn't resolvable from this room (see rejoinCollectorRoom).
            // one repair attempt: force the channel rejoin, then reset the streak.
            hopUsed = true;
            this.log('collect_room_repair', { round: rounds, note: 'no trade window for 6 rounds — forcing channel rejoin' });
            await this.rejoinCollectorRoom(g.channel).catch(() => {});
            this.c.moveToPx(spot.x, spot.y); await sleep(2000); openStreak = 0;
          } else {
            // still nothing after a repair: give up cleanly instead of spamming the collector for 80 rounds
            this.log('collect_room_unreachable', { round: rounds });
            throw new Error('trade window never opens — collector not resolvable (wrong room?)');
          }
        }
        await sleep(3000); continue;
      }
      openStreak = 0;
      const offer = items.slice(0, 10).map((it) => ({ slot: it.slot, qty: it.qty }));
      this.c.tradeOffer(offer, giveZeny);
      offered += offer.length;
      await sleep(1500);
      this.c.tradeLock();
      this.log('trade_locked_mine', { round: rounds, offer: offer.length, zeny: giveZeny });
      const bothLocked = await this.waitFor(() => { const t = this.s.trade; return !!(t && t.mine?.locked && t.theirs?.locked); }, 'both locked', 30000).catch(() => false);
      if (bothLocked) { this.c.tradeConfirm(); this.log('trade_confirm_sent', { round: rounds }); }
      else this.log('trade_lock_timeout', { round: rounds, state: this.s.trade ?? null });
      const bag0 = bagKeep().reduce((s, it) => s + (it.qty ?? 1), 0);
      const zeny0 = this.char?.zeny ?? 0;
      const done = await this.waitFor(() => {
        const t = this.s.trade;
        const cleared = !t || t.closed === true || t.done === true;
        const shrunk = bagKeep().reduce((s, it) => s + (it.qty ?? 1), 0) < bag0 || (this.char?.zeny ?? 0) < zeny0;
        return cleared || shrunk;
      }, 'trade done', 45000).catch(() => false);
      const bagNow = bagKeep().reduce((s, it) => s + (it.qty ?? 1), 0);
      const zenyNow = this.char?.zeny ?? 0;
      const movedNow = bagNow < bag0 || zenyNow < zeny0;
      if (movedNow) { stacksMoved += Math.max(0, offer.length); zenyMoved += Math.max(0, zeny0 - zenyNow); }
      else { this.log('collect_no_progress', { round: rounds, note: 'collector bag full — waiting for it to store' }); noProgAt = Date.now(); }
      this.log('trade_round_end', { round: rounds, done, moved: movedNow });
      if (!done) { this.c.tradeCancel(); await sleep(2000); }
      else this.s.trade = null;
      await sleep(1500);
    }
    try { this.c.npcClose(); } catch {}
    // 3) no storage pass — leftover unsellables stay in the bag by policy (bots never touch storage)
    this.log('collect_done', { rounds, offered, stacks: stacksMoved, zeny: zenyMoved, ms: Date.now() - t0 });
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

  // Alice teleport (VERIFIED live 2026-10-07): talk n6 → option 'วาร์ป' → `warp_menu` reply carries the
  // visited destinations + zeny costs (the world-map UI) → `npc_warp {mapId}` → travel message → rejoin.
  // ~0.2s + zeny (venom 1250z) vs the 3-map walk (~45s). Falls back to walking on any failure.
  async aliceWarp(target, { alts = [] } = {}) {
    const t0 = Date.now();
    if (this.c.mapId !== 'capital') return { ok: false, reason: 'not-in-capital' };
    try { this.c.npcClose(); } catch {}
    for (let i = 0; i < 10; i++) {
      const lv = this.c.live;
      if (lv && Math.hypot((lv.x ?? 0) - NPCS.n6[0], (lv.y ?? 0) - NPCS.n6[1]) < 70) break;
      this.c.moveToPx(NPCS.n6[0], NPCS.n6[1]);
      await sleep(600);
    }
    const d = await this.talk('n6').catch(() => null);
    if (!d) return { ok: false, reason: 'no-dialog' };
    const opt = this.findOption(d, 'วาร์ป') ?? { index: 1, text: 'วาร์ป' };
    this.s.warpMenu = null;
    this.c.npcOption(opt.index);
    await this.waitFor(() => !!this.s.warpMenu, 'warp menu', 8000).catch(() => {});
    const menu = this.s.warpMenu;
    if (!menu) { this.c.npcClose(); await sleep(300); return { ok: false, reason: 'no-warp-menu' }; }
    const dests = menu.destinations ?? [];
    // warp to the target if it has been visited; otherwise to the deepest VISITED waypoint on the rest of
    // the route (alts, nearest-to-target first) and walk the remaining hops from there
    const dest = [target, ...alts].filter((m) => m && m !== 'capital').find((m) => dests.includes(m));
    if (!dest) { this.c.npcClose(); await sleep(300); return { ok: false, reason: 'unvisited' }; }
    const cost = menu.costs?.[dest] ?? 0;
    if ((this.char?.zeny ?? 0) < cost) { this.c.npcClose(); await sleep(300); return { ok: false, reason: 'no-zeny', cost }; }
    this.s.travel = null;
    this.c.send('npc_warp', { mapId: dest });
    try { await this.waitFor(() => this.s.travel || this.c.mapId === dest, 'warp travel', 12000); } catch {}
    if (this.c.mapId === dest) return { ok: true, to: dest, cost, ms: Date.now() - t0 };
    const tr = this.s.travel;
    if (!tr) { this.c.npcClose(); await sleep(300); return { ok: false, reason: 'no-travel' }; }
    this.log('travel_msg', { mapId: tr.mapId, roomId: tr.roomId, channel: tr.channel, endpoint: tr.endpoint, displayName: tr.displayName, warp: true });
    await this.c.rejoinRoom(tr);
    await sleep(1200);
    return { ok: this.c.mapId === dest, to: dest, cost, ms: Date.now() - t0 };
  }

  async ensureMap(target) {
    if (!this.isConnected()) await this.reconnect();
    if (this.s.death) await this.deathRecover();
    await this.syncMapFromRest().catch(() => {});
    if (this.c.mapId === target) return;
    // CAPITAL FAST-LANE (verified live 2026-10-08): a butterfly wing returns the char to the capital save
    // point from any map — every capital-bound trip (collect / errand / restock) rides one when stocked.
    if (target === 'capital' && this.wingEnabled()) {
      const wFrom = this.c.mapId;
      const w = await this.useButterflyWing().catch(() => ({ ok: false }));
      if (w.ok) { this.log('travel_via', { via: 'wing', from: wFrom, to: target, ms: w.ms ?? null }); return; }
      if (w.reason !== 'no-wing') this.log('travel_via', { via: 'walk', from: wFrom, to: target, wingFail: w.reason ?? null });
    }
    const from = this.c.mapId;
    const t0 = Date.now();
    const route = await routePath(from, target);
    // WARP-FIRST POLICY (2026-10-07): walking is the LAST resort. Alice warps from the capital to any map the
    // char has visited — so whenever the walking route crosses the capital (it's the hub), walk only up to
    // the capital and warp the rest. If the target (or any deeper waypoint) was never visited → walk on.
    const capIdx = route.indexOf('capital');
    if (target !== 'capital' && (from === 'capital' || capIdx >= 0)) {
      if (this.char?.auto?.enabled) { this.c.autoEnabled(false); await sleep(600); }
      if (capIdx >= 0) {
        const legs = route.slice(0, capIdx + 1);
        this.log('travel_approach_capital', { from, to: target, legs });
        for (const hop of legs) await this.travelHop(hop);
      }
      const afterCap = route.slice(capIdx + 1); // waypoints after the capital, in walking order (incl. target)
      const alts = afterCap.filter((m) => m !== target).reverse(); // deepest (closest to target) first
      const w = await this.aliceWarp(target, { alts }).catch((e) => ({ ok: false, reason: String((e && e.message) || e).slice(0, 90) }));
      if (w.ok) {
        this.log('travel_via', { via: 'warp', from, to: target, landed: w.to ?? target, cost: w.cost ?? null, ms: Date.now() - t0 });
        if (w.to && w.to !== target) {
          try { const rest = await routePath(w.to, target); for (const hop of rest) await this.travelHop(hop); }
          catch (e) { this.log('warp_waypoint_route_fail', { landed: w.to, to: target, err: String((e && e.message) || e).slice(0, 90) }); }
        }
        return;
      }
      this.log('travel_via', { via: 'walk', from, to: target, warpFail: w.reason ?? null });
      for (const hop of afterCap) await this.travelHop(hop);
      return;
    }
    this.log('route', { from, to: target, route, warp: false });
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
    const arrived = () => this.c.mapId === nextMap;
    while (Date.now() - t0 < 90 * 1000) {
      // the server sometimes moves us without (or after) a travel msg — landing IS the success condition
      if (arrived()) { this.log('traveled_landed', { now: this.c.mapId }); return; }
      if (this.s.death) throw new Error('died en route — will recover and retry');
      this.c.moveToPx(exit.cx, exit.cy);
      try { await this.waitFor(() => this.s.travel || arrived(), 'travel message', 6500); } catch { continue; }
      if (!this.s.travel && arrived()) { this.log('traveled_landed', { now: this.c.mapId }); return; }
      const tr = this.s.travel;
      if (tr) {
        this.log('travel_msg', { mapId: tr.mapId, roomId: tr.roomId, channel: tr.channel, endpoint: tr.endpoint, displayName: tr.displayName });
        await this.c.rejoinRoom(tr);
        await sleep(1200);
      }
      this.log('traveled', { now: this.c.mapId });
      return;
    }
    throw new Error(`travel ${this.c.mapId}->${nextMap} timeout`);
  }

  async farm({ until, auto = {}, timeoutMin = 600, label = '', map = null, statPlan = null, skillPlan = null, weave = null, errand = null }) {
    // 2026-10-07: the skill sequence (CC weave picker / plan) now rides the AUTO config — the game's own
    // engine runs it server-side (buff upkeep, attacks in tick order, up to 9 skills). Manual client-side
    // weaving is retired: flagged sessions silently ignore client casts, while the engine's casts always work.
    if (weave?.length) {
      this._weaveSeq = (this.weaveOverride ?? weave).filter(Boolean).slice(0, 9);
      if (!this._seqLogged) { this._seqLogged = true; this.log('auto_skill_seq', { seq: this._weaveSeq }); }
    }
    await this.setAuto(auto);
    // inventory arrives ~right after join; re-apply once it's here so auto-potion itemIds fill in
    if (!this.s.inventory) await this.waitFor(() => !!this.s.inventory, 'inventory', 20000).catch(() => {});
    if (this.s.inventory) await this.setAuto(auto);
    // potions are the difference between grinding and a death loop — restock before starting.
    // RE-ARM after the purchase so the engine's hpItems list actually references what we just bought
    // (2026-10-07: a stale/empty hpItems list = no auto-heal despite a full potion bag → death loop)
    if (map && this.potCount() < 8) {
      await this.buyPotions(45).catch(() => {});
      await this.buyButterflyWings().catch(() => {});
      if (this.s.inventory) await this.setAuto(auto).catch(() => {});
    }
    this._lastFarmAuto = auto;
    const t0 = Date.now();
    let last = 0, lastStat = 0, lastSkill = 0;
    while (Date.now() - t0 < timeoutMin * 60 * 1000) {
      await controlWait(this);
      // a freshly-applied skill sequence (plan/config push) re-arms the auto config right away
      if (this._seqDirty && !this.s.death && (!map || this.c.mapId === map)) {
        this._seqDirty = false;
        try { await this.setAuto(auto); this.log('auto_cfg_sync', { seq: this._weaveSeq }); }
        catch (e) { this.log('auto_cfg_sync_fail', String((e && e.message) || e)); }
      }
      if (this.pendingGrant) {
        const g = this.pendingGrant; this.pendingGrant = null;
        this.log('collect_granted', g);
        try { await this.collectToCollector(g); this.lastCollectDone = { at: Date.now(), collector: g.collector }; this.wantCollect = false; }
        catch (e) { this.log('collect_fail', String((e && e.message) || e)); this.lastCollectDone = { at: Date.now(), error: true }; }
        if (map && this.c.mapId !== map) await this.ensureMap(map);
        if (map) await this.channelOnReturn(); // back at the grind spot → least-populated channel first
        await this.setAuto(auto);
      }
      // bag-full errand (sell non-whitelist, restock) — runs even while a collector turn is queued,
      // so the bot keeps farming while it waits. NEW POLICY (2026-10-06): errands never touch storage.
      if (this.errandCfg?.enabled && !this.pendingGrant) {
        const w3 = this.s.inventory;
        const pctE = w3 ? (w3.weight / w3.weightLimit) * 100 : 0;
        const usedE = w3?.items?.length ?? 0;
        if ((pctE >= (this.errandCfg.atWeightPct ?? 70) || usedE >= 90) && Date.now() - (this._lastErrandAt || 0) > 90000 && Date.now() > (this._errandGateAt ?? 0)) {
          this._lastErrandAt = Date.now();
          const keep = this.keepIds();
          this.log('errand_bag_full', { weightPct: Math.round(pctE), used: usedE });
          try {
            this.c.autoEnabled(false);
            await this.ensureMap('capital');
            await this.sellJunkExcept(keep); // whitelist stays in the bag — it travels to the collector, never to storage
            await this.buyPotions(45).catch(() => {});
            await this.buyButterflyWings().catch(() => {});
            this.log('errand_done', {});
          } catch (e) { this.log('errand_fail', String((e && e.message) || e)); }
          // if the errand couldn't get weight back under control, give it 6 min before retrying (breaks errand storms)
          const wA = this.s.inventory; const pctA = wA ? (wA.weight / wA.weightLimit) * 100 : 0;
          this._errandGateAt = pctA >= (this.errandCfg.atWeightPct ?? 70) - 5 ? Date.now() + 6 * 60 * 1000 : 0;
          if (map && this.c.mapId !== map) await this.ensureMap(map);
          if (map) await this.channelOnReturn(); // errand trip done → least-populated channel first
          await this.setAuto(auto);
        }
      }
      if (this.collectCfg?.enabled && !this.wantCollect) {
        const w2 = this.s.inventory;
        const pctW = w2 ? (w2.weight / w2.weightLimit) * 100 : 0;
        const usedW = w2?.items?.length ?? 0;
        if (pctW >= (this.collectCfg.atWeightPct ?? 70) || usedW >= 90) { this.wantCollect = true; this.log('collect_wanted', { weightPct: Math.round(pctW), used: usedW }); }
      }
      if (this.autoChannel && Date.now() - (this._lastChanCheck || 0) > 10 * 60 * 1000) {
        this._lastChanCheck = Date.now();
        await this.ensureLeastPopulatedChannel().catch(() => {});
      }
      this._farmMap = map ?? this._farmMap;
      if (!this.isConnected()) {
        this.log('farm_disconnected', {});
        await this.reconnect();
        if (map && this.c.mapId !== map) await this.ensureMap(map);
        await this.setAuto(auto);
      }
      // turn-key: if we're on the wrong map (e.g. after death respawn or any drift), go back and resume.
      // Backoff: when transfers are congested a failed return must NOT retry every loop pass — that
      // hammers the server's transfer pipeline and keeps every stranded bot in an idle travel loop.
      if (map && this.c.mapId !== map && !this.s.death) {
        if (Date.now() < (this._mapRetryAt ?? 0)) { /* travel backoff — letting the pipeline drain */ }
        else {
          this.log('wrong_map_return', { at: this.c.mapId, target: map });
          try { await this.ensureMap(map); this._mapRetryAt = 0; await this.setAuto(auto); }
          catch (e) { this._mapRetryAt = Date.now() + 2 * 60 * 1000; this.log('map_return_fail', String((e && e.message) || e)); }
        }
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
      // keep allocating skill points while grinding (knight kit top-ups, e.g. two-hand-sword-mastery → 10)
      if (skillPlan && Date.now() - lastSkill > 6000) {
        lastSkill = Date.now();
        const c3 = this.char;
        if ((c3?.skillPoints ?? 0) > 0 && c3?.classId === 'knight') {
          await this.applySkills(skillPlan, { wait: false, waitMs: 3000 });
        }
      }
      if (this.s.death) {
        await this.deathRecover();
        if (map && this.c.mapId !== map) await this.ensureMap(map);
        if (map) await this.channelOnReturn(); // death respawn → walk of shame → best channel
        await this.setAuto(auto);
      } else if (ch && ch.auto?.enabled === false) {
        const w = this.s.inventory; const pct = w ? (w.weight / w.weightLimit) * 100 : 0;
        this.log('auto_off', { weightPct: Math.round(pct) });
        if (pct >= (this.errandCfg?.atWeightPct ?? 70) && Date.now() > (this._errandGateAt ?? 0)) {
          // bag filling → errand (farming mode supplies its own), else bank/sell/restock, come back
          this.c.autoEnabled(false); await sleep(700);
          if (errand) {
            try { await errand(this); } catch (e) { this.log('errand_fail', String((e && e.message) || e)); }
          } else {
            await this.ensureMap('capital');
            await this.sellJunk(); // no banking — storage is off-limits for bots (policy 2026-10-06)
            await this.buyPotions(45).catch(() => {});
            await this.buyWeightScrolls().catch(() => {});
          }
          // same gate as the main errand path — a non-draining trip must not immediately repeat
          const wA = this.s.inventory; const pctA = wA ? (wA.weight / wA.weightLimit) * 100 : 0;
          this._errandGateAt = pctA >= (this.errandCfg?.atWeightPct ?? 70) - 5 ? Date.now() + 6 * 60 * 1000 : 0;
          try { await this.ensureMap(map ?? this.c.mapId); this._mapRetryAt = 0; }
          catch (e) { this._mapRetryAt = Date.now() + 2 * 60 * 1000; this.log('errand_return_fail', String((e && e.message) || e)); }
          if (!map || this.c.mapId === map) {
            if (map) await this.channelOnReturn(); // back at the grind spot → least-populated channel first
            await this.setAuto(auto);
          }
        } else {
          await this.setAuto(auto); // transient stop → just re-enable
        }
      }
      // manual weaving retired 2026-10-07 — the sequence now rides the auto config (server-side engine casts it)
      await sleep(3000);
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
// "character already online" (ตัวละครในบัญชีนี้ออนไลน์อยู่แล้ว) — force it out with the same kick the game's
// character-select button uses, then retry fast instead of waiting for the seat to expire.
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
      if (/ออนไลน์อยู่แล้ว|already online/i.test(msg)) {
        await bot.kickPreviousSession(); // force-online (kick the stale session) — retry immediately after
        await sleep(2500);
      } else {
        await sleep(/429|too many/i.test(msg) ? 60000 : 8000);
      }
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
  // REMOVED per operator 2026-10-05 — gems are no longer refined/equipped during leveling.
  // No-op stub kept so existing per-bot plan cursors (index-based positions) stay aligned.
  { id: '23b-gems-refine-equip', run: async () => { log('gem_step_removed', {}); } },
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
      // knight kit = bowling 10 + 2h-sword-mastery 10 (great-sword mastery maxed) + quicken 10 + ride 1 + master 5 + charge-attack 1 = 37 pts → job 38
      await bot.farm({ until: (c) => c.jobLevel >= 38, map: 'gale_high', auto: autoCfg, statPlan: { fixed: { DEX: 30, AGI: 30, VIT: 20 }, dump: 'STR' }, label: 'gale knight-job38', timeoutMin: 600, weave: ['bash'] });
    } },
  { id: '29-skills-gale', run: async () => {
      const autoCfg = { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: 75, spPercent: 40, skills: [{ id: 'bash', level: 10 }] };
      const ok = await bot.applySkills({ 'two-hand-sword-mastery': 10, 'bowling-bash': 10, 'two-hand-quicken': 10, 'peco-peco-ride': 1, 'peco-peco-master': 5, 'charge-attack': 1 }, { wait: true, auto: autoCfg, waitMs: 90 * 60 * 1000, farmMap: 'gale_high' });
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

// ---------------- modes ----------------
async function runFarmingMode() {
  let cfg = null;
  for (;;) {
    await controlWait(bot);
    const ctl = applyDirectives(bot);
    if (ctl?.farm) cfg = ctl.farm;
    const f = cfg ?? { map: 'frost_pass', keep: [], hpPercent: 75, restockQty: 45, potItem: 'Red Potion' };
    bot.restockQty = f.restockQty ?? 45; // consumables policy: keep only this potion, and only up to this count
    bot.potItemName = f.potItem ?? 'Red Potion';
    // union with the bot's own whitelist (ctl.keep, card-expanded) — the whitelist travels to the collector
    const keepIds = new Set([...(f.keep ?? []), ...bot.keepIds()]);
    bot.stepId = 'farm-mode:' + f.map;
    bot.log('farm_mode_start', { map: f.map, keep: [...keepIds] });
    // NEW POLICY (2026-10-06): errands never touch storage — sell sellable non-whitelist, restock,
    // whitelist stays in the bag for the next collect turn (batched trade to the collector)
    const errand = async (b) => {
      b.log('farm_errand_start', {});
      await b.ensureMap('capital');
      await b.sellJunkExcept(keepIds);
      await b.buyPotions(f.restockQty ?? 45, f.potItem ?? 'Red Potion').catch(() => {});
      if (b.scrollCount() < 10) await b.buyWeightScrolls().catch(() => {}); // Bor: 10× weight-limit scrolls
      b.log('farm_errand_done', {});
    };
    try {
      if (Date.now() < (bot._mapRetryAt ?? 0)) { await sleep(15000); continue; } // travel backoff — don't spam congestion
      await bot.ensureMap(f.map);
      bot._mapRetryAt = 0;
      if (bot.autoChannel) await bot.ensureLeastPopulatedChannel().catch(() => {});
      await bot.farm({
        until: () => false, timeoutMin: 24 * 60, map: f.map, label: 'farm-mode', errand,
        auto: { huntRadiusTiles: 'all', pickupLoot: true, hpPercent: f.hpPercent ?? 75, spPercent: 40, skills: [{ id: 'bash', level: 10 }] },
        statPlan: { fixed: { DEX: 30, AGI: 30, VIT: 20 }, dump: 'STR' }, // the guide: DEX30 → AGI30 → VIT20 → STR forever
        skillPlan: { 'two-hand-sword-mastery': 10, 'charge-attack': 1 }, // knight kit: Greatsword Mastery 10 + Valiant Charge (its max = 1)
        weave: bot.weaveOverride ?? ['bash', 'bowling-bash'],
      });
    } catch (e) {
      bot.log('STEP_FAIL', { step: 'farm-mode', err: String((e && e.message) || e) });
      if (bot.s.death) { try { await bot.deathRecover(); } catch {} }
      await sleep(10000);
    }
  }
}

async function runCollectorMode() {
  bot.stepId = 'collector';
  await bot.ensureMap('capital').catch(() => {});
  bot.log('collector_mode_ready', {});
  for (;;) {
    await controlWait(bot);
    const ctl = applyDirectives(bot);
    const cc = ctl?.collect;
    // storage is WRITE-ONLY by policy (2026-10-06): the collector deposits but never withdraws — cleanup disabled.
    if (ctl?.cleanup?.at && ctl.cleanup.at !== bot._cleanupAt) {
      bot._cleanupAt = ctl.cleanup.at;
      bot.log('collector_cleanup_disabled', { note: 'storage is write-only (deposits only) by policy' });
    }
    // the collector MUST stay connected — unlike the farm loop, collector mode has no other recovery path
    if (!bot.isConnected()) {
      bot.log('collector_disconnected', {});
      try { await bot.reconnect(); bot.log('collector_reconnected', {}); } catch (e) { bot.log('collector_reconnect_fail', String((e && e.message) || e)); }
      bot._colChan = null; bot._lastSpotAt = 0; // re-assert channel + spot after reconnect
      await sleep(2000);
      continue;
    }
    if (cc?.channel != null && bot._colChan !== cc.channel && Date.now() - (bot._lastChanTry || 0) > 60000) {
      bot._lastChanTry = Date.now();
      const ok = await bot.switchToChannel(cc.channel).catch(() => false);
      if (ok) bot._colChan = cc.channel;
    }
    const spot = (cc?.spot && cc.spot.x != null) ? cc.spot : null;
    if (spot && Date.now() - (bot._lastSpotAt || 0) > 60000) { bot._lastSpotAt = Date.now(); bot.c.moveToPx(spot.x, spot.y); }
    // weight-limit scrolls: consume the 10 permanent +weight upgrades while idle (Bor = n2 is at this very spot)
    if (!bot.s.trade && !bot.s.invite && bot.scrollCount() < 10 && Date.now() - (bot._lastScrollAt || 0) > 90000) {
      bot._lastScrollAt = Date.now();
      try { await bot.buyWeightScrolls(); } catch (e) { bot.log('scroll_fail', String((e && e.message) || e)); }
      if (spot) { bot.c.moveToPx(spot.x, spot.y); bot._lastSpotAt = Date.now(); }
    }
    // manual storage refresh (command-center ⟳): one-shot per request, deferred while a trade is in flight
    const rfReq = readControl()?.refreshStorage;
    if (rfReq && rfReq !== bot._rfAt && !bot.s.trade && !bot.s.invite) {
      bot._rfAt = rfReq;
      if (Date.now() - rfReq < 10 * 60 * 1000) { // stale flags survive restarts — only honor fresh clicks
        bot.log('storage_refresh_start', {});
        try {
          const ok = await bot.refreshStorageSnapshot();
          bot.log('storage_refresh_done', { ok, stacks: (bot.s.storage?.items ?? []).length });
        } catch (e) { bot.log('storage_refresh_fail', String((e && e.message) || e)); }
      }
      if (spot) { bot.c.moveToPx(spot.x, spot.y); bot._lastSpotAt = Date.now(); }
    }
    if (bot.s.invite && bot.s.invite.kind === 'trade') { bot.c.trade({ action: 'accept' }); bot.log('trade_accept', bot.s.invite); bot.s.invite = null; }
    const t = bot.s.trade;
    if (t && t.mine && !t.mine.locked && bot._lockSeq !== bot.s.tradeSeq) {
      bot.c.tradeOffer([], 0); await sleep(700); bot.c.tradeLock();
      bot._lockSeq = bot.s.tradeSeq;
      bot.log('collector_locked', { seq: bot.s.tradeSeq });
    } else if (t && t.mine?.locked && t.theirs?.locked && bot._confirmSeq !== bot.s.tradeSeq) {
      bot.c.tradeConfirm();
      bot._confirmSeq = bot.s.tradeSeq;
      bot.log('collector_confirmed', { seq: bot.s.tradeSeq, zeny: bot.char?.zeny ?? 0 });
    }
    // bag nearly full → empty it into storage so donors can keep transferring
    const invc = bot.s.inventory;
    const usedNow = invc?.items?.length ?? 0;
    const capNow = invc?.slots ?? invc?.capacity ?? 100;
    const wPct = invc ? (invc.weight / invc.weightLimit) * 100 : 0;
    if (!bot.s.trade && !bot.s.invite && (usedNow >= capNow - 20 || wPct >= 85) && Date.now() - (bot._lastEmpty || 0) > 120000) {
      bot._lastEmpty = Date.now();
      bot.log('collector_bag_full', { used: usedNow, cap: capNow, weightPct: Math.round(wPct) });
      try { await bot.depositItemsWhere(() => true, { npcKey: 'n6', label: 'collector' }); }
      catch (e) { bot.log('collector_empty_fail', String((e && e.message) || e)); }
      bot.c.moveToPx(spot?.x ?? 880, spot?.y ?? 1520);
      await sleep(1500);
    }
    await sleep(1500);
  }
}

// ---------------- execute (turn-key: never abort — retry forever with reconnect) ----------------
if (MODE === 'collector') { await runCollectorMode(); }
else if (MODE === 'farming') { await runFarmingMode(); }
// pending collect grant: handle before starting the plan (don't trek to the grind map first)
{
  await controlWait(bot);
  applyDirectives(bot);
  if (bot.pendingGrant) {
    const g = bot.pendingGrant; bot.pendingGrant = null;
    bot.log('collect_granted', g);
    try { await bot.collectToCollector(g); bot.lastCollectDone = { at: Date.now(), collector: g.collector }; bot.wantCollect = false; }
    catch (e) { bot.log('collect_fail', String((e && e.message) || e)); bot.lastCollectDone = { at: Date.now(), error: true }; }
  }
}
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
