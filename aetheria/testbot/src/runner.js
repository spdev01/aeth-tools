// AETHERIA AUDIT RUNNER — executes the user's leveling sequence step-by-step.
// Usage: node src/runner.js [--upto N] [--char NAME] [--fresh]
// State cursor persisted to out/run-state.json so we can iterate and resume.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AetheriaClient } from './client.js';
import { apiFetch, probeExitIp, hasProxy, proxyLabel } from './net.js';

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

// ---------------- humanization (H) ----------------
// Per-bot human-like behavior layer. Config: testbot/humanize.json { enabled, ids[] } (ids=[] ⇒ all bots).
// A bot gets its OWN stable personality (seeded by bot id) so the fleet doesn't move in mirror unison.
// Every branch falls back to the original exact behavior when H.on is false.
const H_CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'humanize.json'), 'utf8')); } catch { return { enabled: false, ids: [] }; } })();
const H_ID = parseInt(path.basename(OUT), 10) || 0;
const H = (() => {
  const on = !!H_CFG.enabled && (Array.isArray(H_CFG.ids) && H_CFG.ids.length ? H_CFG.ids.includes(H_ID) : true);
  let a = (H_ID * 2654435761) >>> 0; // deterministic seed → same personality every restart
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    on, rnd,
    jitterPx: 8 + Math.round(rnd() * 10),            // 8–18 px arrival scatter (user spec: ~10–20 px)
    sleepScale: 0.85 + rnd() * 0.4,                  // personal walking pace
    viaProb: 0.55 + rnd() * 0.35,                    // chance of a small mid-waypoint on long walks
    chatty: 0.15 + rnd() * 0.3,                      // chance to window-shop before a town chore
    stayBias: 0.15 + rnd() * 0.3,                    // chance to keep the current channel when near-tied
    errandBias: Math.round(rnd() * 10 - 5),          // ±5% personal bag-full threshold
    potTripN: 8 + Math.round(rnd() * 8),             // personal low-potion trip level (8–16)
    chanEveryMs: (7 + rnd() * 9) * 60 * 1000,        // 7–16 min channel re-check
    errandGateMs: (75 + rnd() * 50) * 1000,          // 75–125 s bag-full re-trip gate
    potGateMs: (200 + rnd() * 140) * 1000,           // 3.3–5.7 min pot-trip gate
    loiterGateMs: (6 + rnd() * 8) * 60 * 1000,       // loiter cooldown 6–14 min
  };
})();
const hSleep = (ms, spread = 0.35) => Math.round(ms * H.sleepScale * (1 - spread / 2 + H.rnd() * spread));

// ---------------- captcha (anti-cheat human check) ----------------
// The game's human check shows 4 item icons and asks e.g. "กดรูป Crown" (click the Crown picture).
// Answer protocol (verified in the game bundle): room msg `human_check_answer` { id, pick }
// where pick = 0-BASED INDEX in the message's items[] (bundle: onClick → answerHumanCheck(e.id, n)).
// Option -> name mapping: /art/icons/manifest.json (e.g. 2235 → items/rogear-crown.webp; 91064 →
// wpn-trident; 90040 → blank-scroll) + any known bag item name. Cached to testbot/icon-manifest.json.
const BOOT_AT = Date.now(); // captcha forensics: uptime anchor for the context snapshot
const QUIET_TRACE = new Set(['HEARTBEAT', 'kill', 'drop', 'farm_status', 'levelup', 'stuck_at', 'jail_hold_tick']); // rolling-trace noise filter
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
let ICON_ITEMS = null; // itemId(str) → icon path (lazy-loaded on first captcha)
async function iconItems() {
  if (ICON_ITEMS) return ICON_ITEMS;
  const cache = path.join(root, 'icon-manifest.json');
  try { const j = JSON.parse(fs.readFileSync(cache, 'utf8')); if (j && j.items) { ICON_ITEMS = j.items; return ICON_ITEMS; } } catch {}
  try {
    const r = await apiFetch('https://www.aetheria-online.in.th/art/icons/manifest.json');
    if (r && r.ok) {
      const j = await r.json();
      if (j && j.items) { ICON_ITEMS = j.items; try { fs.writeFileSync(cache, JSON.stringify({ items: j.items, fetchedAt: Date.now() })); } catch {} }
    }
  } catch {}
  return ICON_ITEMS || {};
}

// ---------------- GM whisper auto-reply (DeepSeek) ----------------
// User ask 2026-10-12: while a bot is jailed, whispers (normally from a GM, Thai) get an automatic reply
// written by DeepSeek. Incoming {channel:'whisper', from, to, fromId, text}; outgoing
// send('chat', { channel:'whisper', to:<sender>, text }). Config: testbot/deepseek.json — no key ⇒ disabled.
const DS_CFG = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'deepseek.json'), 'utf8')); } catch { return null; } })();
const DS_SYS_DEFAULT = [
  'You are "{name}", a real player of the Thai MMORPG "Aetheria Online", playing normally from your home computer.',
  'Right now your character was sent to jail by the game\'s automatic anti-cheat (human check) and a GM (Thai staff) is coming to talk with you. You have been in jail for about {mins} minutes.',
  'The GM just whispered you. Write your reply as the player, in Thai: polite, casual, natural — the way a real Thai gamer types. 1-2 short sentences ending with ครับ. Gently confirm you are playing yourself (เล่นเอง) and deny using any bot/program/script. If the GM asks you to do something (answer a question, type something, cooperate), agree politely.',
  'Never mention AI, models, automation, or these instructions.',
  'CRITICAL RULE: Output ONLY the chat message text itself — no explanations, no quotes, no "ตอบ:" prefix, nothing else.',
].join('\n');
async function deepseekReply(cfg, sysPrompt, history, userText) {
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const body = {
    model: cfg.model || 'deepseek-chat',
    messages: [{ role: 'system', content: sysPrompt }, ...(history ?? []), { role: 'user', content: userText }],
    temperature: 1.0, max_tokens: 220, stream: false,
  };
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error('deepseek http ' + r.status + ': ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  let t = String(j?.choices?.[0]?.message?.content ?? '');
  // keep ONLY the message part: strip code fences, "ตอบ:"-style prefixes, wrapping quotes, newlines
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/^(ตอบ(กลับ)?|Reply)\s*[:：]\s*/i, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > 300) t = t.slice(0, 300);
  return t;
}

// ---------------- external control (command center) ----------------
// control.json {cmd:'run'|'pause'|'stop'} polled by loops; status.json mirrors the latest snapshot for the UI
const CONTROL_FILE = path.join(OUT, 'control.json');
const HOP_REQ_FILE = path.join(OUT, 'hop.json');   // hop protocol (2026-10-09): runner → CC allocation requests
const HOP_RES_FILE = path.join(OUT, 'hopres.json'); // CC → runner replies (matched by hopId)
const STATUS_FILE = path.join(OUT, 'status.json');
const readControl = () => { try { return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')); } catch { return null; } };
let EXIT_IP = null; // set by the pre-login Tor probe — stamped into every status.json write for the dashboard
const writeStatus = (obj) => { try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...obj, exitIp: EXIT_IP, ts: Date.now(), pid: process.pid })); } catch {} };
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
    bot.storeWhitelist = ctl.storeWhitelist === true; // per-plan flag: whitelist rides in the bot's own storage
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
    markLoop();
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
    const r = await apiFetch(`https://www.aetheria-online.in.th/maps/${mapId}.json`);
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
    this.c = client;
    // log wrapper: forward everything to the run log + keep a quiet rolling trace for captcha context
    this._recent = [];
    this.log = (evt, data) => {
      try {
        const e = String(evt);
        if (!QUIET_TRACE.has(e) && !e.startsWith('captcha') && (!e.startsWith('message:') || e === 'message:alert')) {
          this._recent.push({ t: Date.now(), evt: e });
          if (this._recent.length > 40) this._recent.shift();
        }
      } catch {}
      log(evt, data);
    };
    // captcha forensics (2026-10-12): cumulative stats survive restarts (captcha-stats.json);
    // every prompt/resolve/attempt/outcome also appends to captcha.jsonl in the bot data dir.
    this._capStats = (() => { try { const st = JSON.parse(fs.readFileSync(path.join(OUT, 'captcha-stats.json'), 'utf8')); if (st && typeof st === 'object') return st; } catch {} return { prompts: 0, messages: 0, retries: 0, answered: 0, wrong: 0, success: 0, lastSeenAt: null, lastResult: null, ids: [] }; })();
    this._killTs = [];
    this._gmHistory = []; // GM whisper conversation history (multi-turn DeepSeek replies)
    this._gmReplies = []; // reply timestamps (hourly cap)
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
      // captcha forensics: after a prompt, log every inbound message for 3 min (full dialog capture)
      try { if (this._capWatchUntil && Date.now() < this._capWatchUntil && type !== 'character' && type !== 'inventory') this.capLog('msg', { type, data }); } catch {}
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
      if (type === 'item_gain') { this._lastLifeAt = Date.now(); this.log('drop', { name: data.name, qty: data.qty }); if (this.errandCfg?.discardEquip) { clearTimeout(this._discardT); this._discardT = setTimeout(() => this.discardEquipmentDrops().catch(() => {}), 1200); } return; }
      if (type === 'levelup') {
        // room broadcast — other players' level-ups arrive here too (verified 2026-10-08: a local
        // player's advance was logged with a sessionId that was NOT ours). Only ours count.
        if (data?.sessionId && data.sessionId !== this.selfId()) return;
        // level-ups fully restore HP/SP in this game — resets our estimate (otherwise it drifts low from unseen auto-heals)
        this.combat.hp = this.combat.maxHp; this.combat.sp = this.combat.maxSp;
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
      if (type === 'market_open') { s.marketOpen = true; s.marketSeq = (s.marketSeq || 0) + 1; this.log('market_open', {}); return; }
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
        // 'respawned' is also a room broadcast. The old "parked suspicion → respawned confirms" path
        // false-triggered FULL town recoveries whenever another player respawned (bots that never died
        // went on restock trips — 2026-10-08). Parked suspicions now resolve ONLY via identity-keyed
        // world state (DEATH_WORLD), life signals, or the 6-min silence fallback. A respawned only
        // clears a death we ALREADY know is real, and only when the world no longer sees us dead.
        if (data?.sessionId && data.sessionId !== this.selfId()) return;
        if (!this.s.death) { if (this._sus) this.log('respawned_noted', { parkedAgeSec: Math.round((Date.now() - this._sus.at) / 1000) }); return; }
        setTimeout(() => {
          try {
            const lv = this.c.live;
            if (lv && lv.dead) { this.log('respawned_ignored', { how: 'world-still-dead' }); return; }
            this._lastRespawnedAt = Date.now(); // deathRecoverReal waits on this (in-session revive proof)
            this.s.death = null; this.combat.hp = this.combat.maxHp; this.combat.sp = this.combat.maxSp;
            if (this._sus?.real) this._sus = null;
            this.log('respawned', data);
          } catch (e) { this.log('respawned_check_err', String((e && e.message) || e)); }
        }, 1500);
        return;
      }
      if (type === 'chat') { s.chats.push(data); if (s.chats.length > 300) s.chats.shift(); this.onChatMsg(data).catch(() => {}); return; }
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
      if (type === 'alert') {
        // logged EVERY time (was once-per-session): the jail alert also flips the stand-still flag instantly
        this.log('message:alert', data);
        const title = String(data?.title ?? '');
        if (title.includes('\u0e04\u0e38\u0e01') || /jail/i.test(title)) { this._jailedFlag = true; this.log('jail_detected', { title, map: this.c.mapId }); }
        return;
      }
      if (type === 'human_check') { this.log('message:human_check', data); this.onHumanCheck(data).catch((e) => this.log('captcha_err', String((e && e.message) || e))); return; } // auto-answer (onHumanCheck)
      if (!s.unknownDumped.has(type)) { s.unknownDumped.add(type); this.log('message:' + type, data); }
    });
    this.c.on('error', (e) => this.log('client_error', e));
    this.c.on('close', (code, reason) => {
      this.log('ws_close', { code, reason });
      // FAST RECOVERY (2026-10-10): scorch_dunes room deaths kill sessions mid-farm; the farm loop used to
      // notice up to ~45s later. A debounced auto-reconnect shaves recovery to ~10s. Guards: intentional
      // travel/rejoin in flight (client busyAt), already connected again, or a reconnect ladder running.
      if (this._fastRe) return;
      this._fastRe = setTimeout(() => {
        this._fastRe = null;
        try {
          const travelFresh = this.c.busyAt && Date.now() - this.c.busyAt < 60000;
          if (!travelFresh && !this.isConnected() && !this._reconnectP) {
            this.log('fast_reconnect', {});
            this.reconnect().catch(() => {});
          }
        } catch {}
      }, 10000);
    });
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
    if (this.isJailed()) { this._sus = null; return; } // JAIL POLICY: stand still — no death-recovery churn in jail
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

  // ---- captcha (anti-cheat human check) — systematic answer + deep forensics -------------------
  // Incoming: `human_check` {id, prompt:"กดรูป Crown", items:[4 itemIds], expiresAt, triesLeft}.
  // Outgoing: room msg `human_check_answer` {id, pick}; pick = 0-BASED INDEX in items[] (game bundle:
  // onClick → answerHumanCheck(e.id, n), n = items.map index).
  // Matching: normalize the prompt word (Thai stripped) and compare against each option's icon filename
  // (/art/icons/manifest.json: 2235 → items/rogear-crown.webp) + any known item name from the bag.
  // Forensics (user ask 2026-10-12): cumulative counters in captcha-stats.json (survive restarts, mirrored
  // into heartbeat status); every prompt/resolve/attempt/outcome appended to captcha.jsonl; all inbound
  // messages captured for 3 min after a prompt; wrong answers burn a try → server re-sends with
  // triesLeft-1 → we try the next-best option.
  capLog(evt, data) { try { fs.appendFileSync(path.join(OUT, 'captcha.jsonl'), JSON.stringify({ t: new Date().toISOString(), evt, ...(data ?? {}) }) + '\n'); } catch {} }
  capSave() { try { fs.writeFileSync(path.join(OUT, 'captcha-stats.json'), JSON.stringify(this._capStats, null, 1)); } catch {} }
  capContext() {
    const now = Date.now();
    const ago = (at) => (at ? Math.round((now - at) / 1000) : null);
    const inv = this.s.inventory;
    return {
      uptimeMin: Math.round((now - BOOT_AT) / 60000),
      killsTotal: this.kills,
      kills10min: (this._killTs ?? []).filter((t) => now - t < 10 * 60 * 1000).length,
      weightPct: inv ? Math.round((inv.weight / inv.weightLimit) * 100) : null,
      map: this.c.mapId, channel: this.s.channels?.current ?? null,
      lastSellAgoSec: ago(this._lastSellAt), lastErrandAgoSec: ago(this._lastErrandAt), lastPotTripAgoSec: ago(this._lastPotTripAt),
      lastCaptchaAgoSec: ago(this._capStats.lastSeenAt),
      recentAnchors: (this._recent ?? []).slice(-14).map((x) => `${x.evt}@${new Date(x.t).toISOString().slice(11, 19)}`),
    };
  }
  async onHumanCheck(d) {
    const id = d?.id ?? null;
    if (!id) { this.capLog('dismiss', {}); return; } // server dismissal (id:null = captcha resolved/expired) — NOT a prompt; must not inflate the 'seen' counters (user audit 2026-10-14)
    const items = Array.isArray(d?.items) ? d.items : [];
    const expiresInMs = d?.expiresAt ? Math.max(0, d.expiresAt - Date.now()) : null;
    const triesLeft = d?.triesLeft ?? null;
    const sid = String(id);
    const isRetry = !!(this._capInFlight && this._capInFlight.id === sid);
    const first = !(Array.isArray(this._capStats.ids) && this._capStats.ids.includes(sid));
    this._capStats.messages = (this._capStats.messages || 0) + 1;
    if (first) {
      this._capStats.prompts = (this._capStats.prompts || 0) + 1;
      if (!Array.isArray(this._capStats.ids)) this._capStats.ids = [];
      this._capStats.ids.push(sid);
      if (this._capStats.ids.length > 300) this._capStats.ids.splice(0, this._capStats.ids.length - 300);
    }
    if (isRetry) {
      // server re-sent the same captcha ⇒ our last pick was wrong
      this._capStats.retries = (this._capStats.retries || 0) + 1;
      this._capStats.wrong = (this._capStats.wrong || 0) + 1;
      this._capStats.lastResult = 'wrong';
      this._capRetryAt = Date.now();
      this.log('captcha_retry_received', { id, triesLeft, wrongPick: this._capInFlight?.pick ?? null });
      this.capLog('retry_received', { id, triesLeft, wrongPick: this._capInFlight?.pick ?? null, wrongItemId: this._capInFlight?.itemId ?? null });
    }
    this._capStats.lastSeenAt = Date.now();
    this.capSave();
    this._capWatchUntil = Date.now() + 3 * 60 * 1000; // capture the whole dialog (all messages) for 3 min
    const ctx = this.capContext();
    this.log('captcha_seen', { id, prompt: d?.prompt ?? null, items, triesLeft, expiresInMs, retry: !!isRetry });
    this.capLog('seen', { id, prompt: d?.prompt ?? null, items, triesLeft, expiresAt: d?.expiresAt ?? null, expiresInMs, retry: !!isRetry, ctx });
    const target = normName(d?.prompt);
    // NEW captcha type (2026-10-14): image-match puzzle — items:[] + `image` (webp data-url), prompt "กดรูปด้านล่างที่เหมือนกับรูปในกรอบ".
    // Live bundle: client renders the image and sends `human_check_answer` {id, x, y} = PIXEL coords of the click
    // (answerHumanCheck(e,t,n) → send {id, x:t, y:n}; t,n = round(frac*width), round(frac*height); defaults 480×330).
    // Solver: detect the yellow reference frame → multi-scale ZNCC template match the reference across the board
    // → click the center of the best match (retry ladder tries alternates if the server re-sends the id).
    if (!items.length && typeof d?.image === 'string' && d.image.startsWith('data:image/')) {
      await this.answerImageCaptcha(id, d, sid, expiresInMs, triesLeft, ctx, isRetry);
      return;
    }
    if (!target || !items.length) { this.log('captcha_no_match', { id, target, reason: 'empty' }); this.capLog('no_match', { id, target, reason: 'empty' }); return; }
    const icons = await iconItems();
    const nameOf = new Map((this.s.inventory?.items ?? []).map((x) => [String(x.itemId), x.name]));
    const scored = items.map((itemId, idx) => {
      const icon = icons[String(itemId)] ?? null;
      const base = normName(String(icon ?? '').split('/').pop().replace(/\.(webp|png|jpe?g|gif|svg)$/i, ''));
      const name = normName(nameOf.get(String(itemId)));
      const hit = (v) => (!v ? 0 : v === target ? 3 : v.endsWith(target) ? 2 : v.includes(target) ? 1 : 0);
      const si = hit(base), sn = hit(name);
      return { idx, itemId, icon, bag: nameOf.get(String(itemId)) ?? null, score: Math.max(si, sn), how: si >= sn && si > 0 ? 'icon' : sn > 0 ? 'name' : null };
    });
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const tied = !!(ranked[1] && best && ranked[1].score === best.score && best.score > 0);
    const bestInfo = best ? { idx: best.idx, itemId: best.itemId, icon: best.icon, score: best.score, how: best.how } : null;
    this.log('captcha_resolve', { id, target, table: scored, best: bestInfo, tied });
    this.capLog('resolve', { id, target, table: scored, best: bestInfo, tied });
    if (!best || !best.score) { this.log('captcha_no_match', { id, target, items }); this.capLog('no_match', { id, target, items }); return; }
    this._capTried ??= new Map();
    const tried = this._capTried.get(sid) ?? new Set();
    this._capTried.set(sid, tried);
    const pick = ranked.find((x) => x.score > 0 && !tried.has(x.idx));
    if (!pick) { this.log('captcha_give_up', { id, allTried: [...tried] }); this.capLog('give_up', { id, allTried: [...tried] }); return; }
    tried.add(pick.idx);
    const delayMs = 1500 + Math.floor((H.on ? H.rnd() : Math.random()) * 2000); // read-then-click delay
    await sleep(delayMs);
    if (!this.isConnected()) { this.log('captcha_answer_skip', { id, why: 'disconnected' }); this.capLog('answer_skip', { id, why: 'disconnected' }); return; }
    if (this.isJailed()) { this.log('captcha_answer_skip', { id, why: 'jailed' }); this.capLog('answer_skip', { id, why: 'jailed' }); return; }
    const attempt = tried.size;
    try {
      this.c.send('human_check_answer', { id, pick: pick.idx });
      this._capStats.answered = (this._capStats.answered || 0) + 1;
      this._capStats.lastResult = 'answered:' + pick.idx;
      const inflight = { id: sid, pick: pick.idx, itemId: pick.itemId, sentAt: Date.now(), attempt };
      this._capInFlight = inflight;
      this.capSave();
      this.log('captcha_answer', { id, pick: pick.idx, itemId: pick.itemId, icon: pick.icon, via: pick.how, score: pick.score, tied, attempt, delayMs });
      this.capLog('answer', { id, pick: pick.idx, itemId: pick.itemId, icon: pick.icon, via: pick.how, score: pick.score, tied, attempt, delayMs, target });
      // outcome probe: no retry for this id within 30 s ⇒ the answer passed (speculative success)
      setTimeout(() => {
        try {
          if ((this._capRetryAt ?? 0) > inflight.sentAt) return; // wrong — counted when the retry arrived
          if (this._capInFlight !== inflight) return; // a newer attempt took over
          this._capStats.success = (this._capStats.success || 0) + 1;
          this._capStats.lastResult = 'ok';
          this.capSave();
          this.log('captcha_outcome', { id, outcome: 'no-retry-30s', pick: inflight.pick });
          this.capLog('outcome', { id, outcome: 'no-retry-30s', pick: inflight.pick, itemId: inflight.itemId });
        } catch {}
      }, 30000);
    } catch (e) { this.log('captcha_answer_fail', String((e && e.message) || e)); this.capLog('answer_fail', { id, err: String((e && e.message) || e) }); }
  }

  // image-match captcha solver path (the new type) — see onHumanCheck for protocol notes.
  // solveImageCaptcha returns {x,y} in the payload's declared coordinate space + up to 3 alternate
  // positions (2nd/3rd-best match) used as a retry ladder: server re-send of the same id ⇒ next spot.
  async answerImageCaptcha(id, d, sid, expiresInMs, triesLeft, ctx, isRetry) {
    const t0 = Date.now();
    let res = null;
    try {
      const b64 = String(d.image).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
      const { solveImageCaptcha } = await import('./captcha-image.mjs');
      res = await solveImageCaptcha(Buffer.from(b64, 'base64'), d?.width ?? 480, d?.height ?? 330);
    } catch (e) { res = { ok: false, reason: 'solver:' + String((e && e.message) || e) }; }
    const solveMs = Date.now() - t0;
    this.log('captcha_image_solve', { id, ok: !!res?.ok, reason: res?.reason ?? null, x: res?.x ?? null, y: res?.y ?? null, score: res?.score ?? null, margin: res?.margin ?? null, ms: solveMs });
    this.capLog('image_solve', { id, ok: !!res?.ok, reason: res?.reason ?? null, x: res?.x ?? null, y: res?.y ?? null, score: res?.score ?? null, margin: res?.margin ?? null, ms: solveMs, alts: res?.alts ?? null, frame: res?.frame ?? null, cand: res?.cand ?? null, expiresInMs, triesLeft, retry: !!isRetry, ctx });
    if (!res?.ok) { this.log('captcha_no_match', { id, reason: 'image_' + (res?.reason ?? 'fail') }); this.capLog('no_match', { id, reason: 'image_' + (res?.reason ?? 'fail') }); return; }
    // retry ladder: same id re-delivered means our previous click missed — try the next-best spot
    this._capImgTried ??= new Map();
    const k = this._capImgTried.get(sid) ?? 0;
    const alt = k > 0 && res.alts?.[Math.min(k - 1, res.alts.length - 1)] ? res.alts[Math.min(k - 1, res.alts.length - 1)] : null;
    const x = alt?.x ?? res.x, y = alt?.y ?? res.y;
    this._capImgTried.set(sid, k + 1);
    if (this._capImgTried.size > 60) { const fk = this._capImgTried.keys().next().value; this._capImgTried.delete(fk); }
    const delayMs = 1200 + Math.floor((H.on ? H.rnd() : Math.random()) * 1800); // read-then-click delay
    await sleep(delayMs);
    if (!this.isConnected()) { this.log('captcha_answer_skip', { id, why: 'disconnected' }); this.capLog('answer_skip', { id, why: 'disconnected' }); return; }
    if (this.isJailed()) { this.log('captcha_answer_skip', { id, why: 'jailed' }); this.capLog('answer_skip', { id, why: 'jailed' }); return; }
    try {
      this.c.send('human_check_answer', { id, x, y });
      this._capStats.answered = (this._capStats.answered || 0) + 1;
      this._capStats.lastResult = 'answered:img';
      const inflight = { id: sid, pick: `img:${x},${y}`, itemId: null, sentAt: Date.now(), attempt: k + 1 };
      this._capInFlight = inflight;
      this.capSave();
      this.log('captcha_answer', { id, kind: 'image', x, y, score: res.score, margin: res.margin, attempt: k + 1, delayMs });
      this.capLog('answer', { id, kind: 'image', x, y, score: res.score, margin: res.margin, attempt: k + 1, delayMs });
      // outcome probe: no retry for this id within 30 s ⇒ the answer passed (speculative success)
      setTimeout(() => {
        try {
          if ((this._capRetryAt ?? 0) > inflight.sentAt) return; // wrong — counted when the retry arrived
          if (this._capInFlight !== inflight) return; // a newer attempt took over
          this._capStats.success = (this._capStats.success || 0) + 1;
          this._capStats.lastResult = 'ok';
          this.capSave();
          this.log('captcha_outcome', { id, outcome: 'no-retry-30s', pick: inflight.pick });
          this.capLog('outcome', { id, outcome: 'no-retry-30s', pick: inflight.pick });
        } catch {}
      }, 30000);
    } catch (e) { this.log('captcha_answer_fail', String((e && e.message) || e)); this.capLog('answer_fail', { id, err: String((e && e.message) || e) }); }
  }

  // single-flight guard (2026-10-08): the heartbeat watcher, the farm-loop death check AND the parked-death
  // timer can all fire at once — two concurrent recoveries raced (one travelled to the farm map while the
  // other was mid potion-buy) and left bots potion-less in capital with auto off, looping on death.
  // 2026-10-08 night: a flight that hung on a dead-socket await froze EVERY later recovery (bot stayed
  // 'dead' 79 min while its session was alive) — a flight older than 10 min is abandoned and restarted.
  deathRecoverReal(opts = {}) {
    if (this._deathRecoverP) {
      if (Date.now() - (this._recoverStartedAt ?? 0) < 10 * 60 * 1000) return this._deathRecoverP;
      this.log('death_recover_stuck_abandon', { min: Math.round((Date.now() - (this._recoverStartedAt ?? 0)) / 60000) });
      this._deathRecoverP = null;
    }
    this._recoverStartedAt = Date.now();
    this._deathRecoverP = this._deathRecoverRealInner(opts).finally(() => { this._deathRecoverP = null; });
    return this._deathRecoverP;
  }

  async _deathRecoverRealInner(opts = {}) {
    this.trace('deathRecover');
    const mark = this._lastRespawnedAt ?? 0;
    const aliveNow = () => (this._lastRespawnedAt ?? 0) > mark || (this.c.live && !this.c.live.dead);
    // INSTANT RESPAWN (2026-10-08 night): `respawn`{to:'save'} is byte-for-byte the call behind the in-game
    // death-screen button ("ฟื้นที่จุดเกิด") — the server releases the corpse right away. The personal
    // release `travel` (unicast — unlike the room-wide `respawned` broadcast) is our confirm, and it counts
    // even while the old room's `dead` flag still reads true, so an accepted respawn never eats the 300s
    // wait. Resend a few times (dropped/laggy WS) before EVER falling back to waiting the corpse out.
    const travel0 = this.s.travel; // a stale travel from before the death must not count as the release
    const released = () => !!this.s.travel && this.s.travel !== travel0;
    let revived = !!opts.already;
    for (let sent = 1; !revived && sent <= 3 && !released(); sent++) {
      this.c.send('respawn', { to: 'save' });
      this.log('death_respawn_send', { try: sent });
      await this.waitFor(() => aliveNow() || released(), 'respawned', 9000).catch(() => {});
      revived = aliveNow();
    }
    if (released()) this.log('death_release_travel', {});
    if (!revived && !released()) {
      // the server refused the early respawn (rare session state) — the body auto-releases at
      // autoReleaseSeconds (300). Tick every 60s: the log keeps the wedge clock fresh during this
      // legitimate 5-min wait (and the 4-min watchdog must not reap us mid-wait).
      const releaseS = Math.min(330, 320);
      this.log('death_await_autorelease', { seconds: releaseS });
      const waitUntil = Date.now() + releaseS * 1000;
      while (Date.now() < waitUntil && !aliveNow()) {
        await this.waitFor(aliveNow, 'auto-release-tick', Math.min(60000, waitUntil - Date.now())).catch(() => {});
        markLoop(); // legit multi-minute wait: keep the main-loop clock fresh (wedge watchdog exemption)
        if (!aliveNow() && Date.now() < waitUntil) this.log('death_await_tick', { leftSec: Math.round((waitUntil - Date.now()) / 1000) });
      }
      revived = aliveNow();
      this.log('death_await_done', { ok: revived });
    }
    // consume the release travel (respawned → travel to the save point → rejoin) — all IN-SESSION
    let tr = null;
    await this.waitFor(() => { tr = this.s.travel; return !!tr; }, 'release travel', 6000).catch(() => {});
    let rejoinedOk = false;
    if (tr) {
      this.s.travel = null;
      try { await this.c.rejoinRoom(tr); await sleep(1200); rejoinedOk = true; this.log('death_rejoin', { map: this.c.mapId }); }
      catch (e) { this.log('death_rejoin_fail', String((e && e.message) || e)); }
    }
    await sleep(800);
    if (rejoinedOk && !revived) revived = true; // a successful rejoin IS the release — hp is restored in the new room
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
    try { await this.maybeTownLoiter('after-death'); } catch {}
    try { await this.sellJunk(); } catch (e) { this.log('death_recover_sell_fail', String((e && e.message) || e)); }
    try { await this.buyPotions(this.restockQty ?? 45); } catch (e) { this.log('pot_buy_fail', String((e && e.message) || e)); }
    // re-arm auto — ONLY when on the farm map (the server refuses off-map configs; trying in town just
    // spams auto_enable_failed and used to wake the rescue ladder mid-town — user design rule 2026-10-08)
    if (!this.s.death && this._lastFarmAuto) {
      if (!this._farmMap || this.c.mapId === this._farmMap) {
        try { await this.setAuto(this._lastFarmAuto); } catch (e) { this.log('death_rearm_fail', String((e && e.message) || e)); }
      }
    }
    // WALK HOME (2026-10-08): the recovery ends in TOWN when auto was refused on capital (setAuto fails
    // off-farm — the server rejects enemy lists for the wrong map). Nothing else returns us to the farm
    // map in this path: the farm loop's wrong_map_return is gated by _deathRecoverP and stranded bots
    // showed it never fired. Return NOW, inside the recovery, so the bot can never end up stranded in town.
    if (!this.s.death && this._farmMap && this.c.mapId !== this._farmMap) {
      try {
        await this.ensureMap(this._farmMap);
        this._mapRetryAt = 0;
        await this.setAuto(this._lastFarmAuto ?? {});
        this.log('death_recover_returned', { map: this.c.mapId, auto: this.char?.auto?.enabled ?? null });
      } catch (e) {
        this._mapRetryAt = Date.now() + 2 * 60 * 1000;
        this.log('death_recover_return_fail', String((e && e.message) || e));
      }
    }
  }

  // Auto-rescue (2026-10-07): post-update, some sessions refuse auto_set until the room/session is refreshed.
  // Cheap path FIRST: hop to another channel of the SAME map (rejoin = fresh room, no relogin → NO capital
  // re-home, no 3-map walk-back). Only if the hop still refuses: full relogin (works, but the char re-homes
  // to the save point → ensureMap walks it back through 3 maps — the waste users saw on NimbleNewt/badger).
  async autoRescue() {
    if (this.isJailed()) { this.log('auto_rescue_skipped_jailed', {}); return; } // JAIL POLICY: no rescue churn in jail
    try {
      // off the farm map: setAuto can NEVER stick there — walk home FIRST (user design rule: no setAuto
      // in town). Only when we're already home do we use the channel-hop ladder below.
      if (this._farmMap && this.c.mapId !== this._farmMap) {
        try { await this.ensureMap(this._farmMap); this._mapRetryAt = 0; }
        catch (e) { this._mapRetryAt = Date.now() + 2 * 60 * 1000; this.log('auto_rescue_map_fail', String((e && e.message) || e)); return; }
        await this.setAuto({});
        if (this.char?.auto?.enabled === true) { this.log('auto_rescue_done', { via: 'map-return', map: this.c.mapId }); return; }
      }
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
    if (this.isJailed()) return { ok: false, reason: 'jailed' }; // JAIL POLICY: never use wings in jail
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
    // EMPTY-ONLY REFILL (user rule 2026-10-09): topping up below the keep target made every trip pay the
    // Bor vendor chore (~5-10s). A bot only ever reaches 0 AFTER flying into the capital, so refilling the
    // full batch exactly when empty (checked while in capital) keeps the fast lane alive with ~1/10th the chores.
    if (have > 0) return have;
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
  onKill(g) { if (!g || !g.monster) return; this.kills++; this._killTs.push(Date.now()); if (this._killTs.length > 600) this._killTs.shift(); }
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
      captchas: this._capStats ? { prompts: this._capStats.prompts ?? 0, answered: this._capStats.answered ?? 0, wrong: this._capStats.wrong ?? 0, success: this._capStats.success ?? 0, lastAt: this._capStats.lastSeenAt ?? null, lastResult: this._capStats.lastResult ?? null } : null,
    };
  }
  startHeartbeat(intervalMs = 20000) {
    const tick = () => {
      try {
        // wedged-loop watchdog (2026-10-08): if the main loop stopped producing ANY event for 10 min while
        // the bot is supposed to be running, it is parked on a promise that never settles (seen after
        // session-churn days: standing at the vendor in capital, auto off, heartbeats only, ~7s CPU in 30 min).
        // Self-exit → the command center's auto-restart brings us back with a fresh session.
        if (MODE !== 'collector' && _ctrlState === 'running') {
          const silentMs = Date.now() - LAST_REAL_ACTIVITY;
          // 4 min (was 10): legit long waits tick (death_await_tick); everything else that stays silent
          // for 4 min is parked — recover fast instead of leaving the bot idle for 10 (user ask 2026-10-08).
          if (silentMs > 4 * 60 * 1000) {
            this.log('loop_wedged_self_restart', { via: 'silent', silentMin: Math.round(silentMs / 60000), step: this.stepId ?? null, map: this.c.mapId });
            setTimeout(() => process.exit(3), 1500);
            return;
          }
          // main-loop tick rule (2026-10-09): message-driven traffic (kills/drops) and heartbeat-driven
          // death-recovery churn can keep the log busy for HOURS while the MAIN loop sits parked on an await
          // that never settles - the process then never applies control.json revisions (deaf: no directives,
          // no collect/shop grants; two knights looped dying + "unreachable" for hours like this). The main
          // loop must prove itself via LOOP_TICK (marked in controlWait + every long flow's iteration).
          const loopSilentMs = Date.now() - LOOP_TICK;
          if (loopSilentMs > 6 * 60 * 1000) {
            this.log('loop_wedged_self_restart', { via: 'loop-tick', silentMin: Math.round(loopSilentMs / 60000), step: this.stepId ?? null, map: this.c.mapId });
            setTimeout(() => process.exit(3), 1500);
            return;
          }
        }
        // parked-await tracer (2026-10-08): when the last stamped await site is >90s old the main loop is
        // parked — say WHERE. Site names come from this.trace(...) calls at the await sites; the marker
        // never refreshes the wedge clock (see log()) so the 10-min self-restart still fires as backstop.
        try {
          if (this._traceAt) {
            const tAge = Date.now() - this._traceAt;
            if (tAge > 90000 && Date.now() - (this._lastStuckLog ?? 0) > 120000) {
              this._lastStuckLog = Date.now();
              this.log('stuck_at', { site: this._trace ?? 'unknown', siteAgeSec: Math.round(tAge / 1000), step: this.stepId ?? null, map: this.c.mapId });
            }
          }
        } catch {}
        try {
          const lv = this.c.live;
          if (lv && lv.dead && !this.s.death && !this.isJailed()) {
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
          shopDone: this.lastShopDone ?? null,
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

  // ---- JAIL POLICY (2026-10-12, user rule): a character transferred to the jail map (anti-cheat
  // 'human check' escalation) must STAND STILL — no movement, no auto, no butterfly wing, no travel,
  // no rescue/relogin churn. The session stays alive (reconnects if dropped) and waits for a release
  // (GM or jail timer); the moment the map changes away from 'jail' we log jail_released and resume.
  isJailed() { return this.c.mapId === 'jail' || !!this._jailedFlag; }
  async jailHold() {
    const t0 = Date.now();
    if (!this._jailHoldOn) {
      this._jailHoldOn = true;
      this._jailSince = this._jailSince ?? Date.now();
      this.log('jail_hold_start', { map: this.c.mapId, 'auto': this.char?.auto?.enabled ?? null });
      try { if (this.char?.auto?.enabled === true) this.c.autoEnabled(false); } catch {} // stop auto — once, best effort
    }
    for (;;) {
      await controlWait(this); // Stop/Pause stay responsive while parked
      markLoop(); // standing still is intentional — keep the wedge watchdog clock fresh
      if (this.c.mapId === 'jail') {
        if (Date.now() - (this._jailTickAt ?? 0) > 60000) { this._jailTickAt = Date.now(); this.log('jail_hold_tick', { min: Math.round((Date.now() - t0) / 60000) }); }
      } else if (Date.now() - t0 > 15000) {
        // map left 'jail' (GM release / jail timer) — or the alert never turned into a transfer
        this._jailedFlag = false; this._jailHoldOn = false; this._jailTickAt = 0; this._jailSince = null;
        this.log('jail_released', { map: this.c.mapId, heldSec: Math.round((Date.now() - t0) / 1000) });
        return;
      }
      if (!this.isConnected()) { try { await this.reconnect(); } catch (e) { this.log('jail_reconnect_fail', String((e && e.message) || e)); } }
      await sleep(5000);
    }
  }

  // ---- GM whisper auto-reply (2026-10-12 user ask) ----------------------------------------------
  // While jailed, any whisper from another player (typically the GM, Thai) is answered automatically
  // with a DeepSeek-written Thai reply. Incoming shape (bundle): {channel:'whisper', from, to, fromId,
  // text, at}; reply = send('chat', { channel:'whisper', to:<sender>, text }). Config: testbot/deepseek.json
  // (apiKey, replyMode 'jailed'|'always'|'off', maxRepliesPerHour, fallbackReply, systemPrompt override).
  // Every whisper (in+out) is logged to the run log AND appended to whispers.jsonl in the bot data dir.
  whisperLog(dir, data) { try { fs.appendFileSync(path.join(OUT, 'whispers.jsonl'), JSON.stringify({ t: new Date().toISOString(), dir, ...data }) + '\n'); } catch {} }
  async onChatMsg(d) {
    try {
      if (!d || d.channel !== 'whisper') return;
      const mine = this.selfId();
      const myName = this.charName ?? null;
      if ((d.fromId && mine && d.fromId === mine) || (myName && d.from === myName)) return; // our own whisper echo
      const from = d.from ?? null;
      const text = String(d.text ?? '').trim();
      if (!from || !text) return;
      this.log('whisper_recv', { from, text: text.slice(0, 300) });
      this.whisperLog('in', { from, text, raw: d });
      const cfg = DS_CFG;
      const mode = cfg?.replyMode ?? 'jailed';
      if (!cfg || mode === 'off') return;
      if (mode === 'jailed' && !this.isJailed()) return;
      const now = Date.now();
      this._gmReplies = (this._gmReplies ?? []).filter((t) => now - t < 60 * 60 * 1000);
      if (this._gmReplies.length >= (cfg.maxRepliesPerHour ?? 20)) { this.log('gm_reply_capped', { from }); return; }
      if (now - (this._gmLastReplyAt ?? 0) < 3000) { this.log('gm_reply_throttled', { from }); return; }
      const key = from + '|' + text;
      this._gmSeen ??= new Set();
      if (this._gmSeen.has(key)) return;
      this._gmSeen.add(key); if (this._gmSeen.size > 100) this._gmSeen.delete(this._gmSeen.values().next().value);
      if (!cfg.apiKey) { this.log('gm_reply_no_key', { hint: 'fill apiKey in testbot/deepseek.json' }); return; }
      const mins = this._jailSince ? Math.round((now - this._jailSince) / 60000) : '?';
      const sys = String(cfg.systemPrompt || DS_SYS_DEFAULT).replaceAll('{name}', myName ?? '').replaceAll('{mins}', String(mins));
      let reply = '';
      try { reply = await deepseekReply(cfg, sys, this._gmHistory.slice(-8), `GM (${from}) whispered: ${text}`); }
      catch (e) { this.log('gm_reply_fail', String((e && e.message) || e)); }
      if (!reply && cfg.fallbackReply) reply = String(cfg.fallbackReply);
      if (!reply) return;
      await sleep(1200 + Math.floor((H.on ? H.rnd() : Math.random()) * 2600)); // human-ish typing delay
      if (!this.isConnected()) { this.log('gm_reply_skip_disconnected', { from }); return; }
      try {
        this.c.send('chat', { channel: 'whisper', to: from, text: reply });
        this._gmLastReplyAt = Date.now(); this._gmReplies.push(Date.now());
        this._gmHistory.push({ role: 'user', content: `GM (${from}): ${text}` });
        this._gmHistory.push({ role: 'assistant', content: reply });
        if (this._gmHistory.length > 24) this._gmHistory.splice(0, this._gmHistory.length - 24);
        this.log('gm_reply_sent', { to: from, reply, via: 'deepseek' });
        this.whisperLog('out', { to: from, text: reply, via: 'deepseek' });
      } catch (e) { this.log('gm_reply_send_fail', String((e && e.message) || e)); }
    } catch (e) { this.log('gm_chat_hook_err', String((e && e.message) || e)); }
  }
  // parked-await tracer: long/risky await sites stamp a name+time; the heartbeat tick reports the last
  // stamp when it grows stale (stuck_at) — every silent park self-identifies in the run log.
  trace(site) { this._trace = site; this._traceAt = Date.now(); }

  // Full re-login/rejoin — used by the turn-key retry loop whenever the session drops.
  // single-flight (2026-10-08): two flows called reconnect() concurrently and the log showed duplicated
  // attempt numbers, doubled kicks and kick/connect churn (bot 59) — one reconnect at a time now.
  reconnect() {
    if (this._reconnectP) return this._reconnectP;
    this._reconnectP = this._reconnectInner().finally(() => { this._reconnectP = null; });
    return this._reconnectP;
  }
  async _reconnectInner() {
    this.log('reconnect_start', {});
    await this.relogin(); // tokens expire after hours — refresh before rejoining
    try { await this.c.leaveGraceful(600); } catch {} // free the seat so rejoin succeeds 1st try
    try { this.c.close(); } catch {}
    await sleep(1500);
    for (let i = 1; i <= 12; i++) {
      try {
        await this.c.connect(this.charId, {
          // a server-side login queue is NOT a failed attempt: poll per pollMs until admitted, keep the
          // loop-proof fresh, and show live queue position/ETA on the dashboard (2026-10-10)
          onQueue: (q) => {
            markLoop();
            this.log('queue_wait', { position: q.position ?? null, waiting: q.waiting ?? null, etaSeconds: q.etaSeconds ?? null });
          },
          abort: () => { try { return readControl()?.cmd === 'stop'; } catch { return false; } },
        });
        const ok = await this.c.waitJoin(12000);
        if (!ok) throw new Error('no join frame');
        this.c.arrived();
        await sleep(2000);
        await this.syncMapFromRest().catch(() => {});
        this.log('reconnect_done', { map: this.c.mapId, attempt: i });
        return true;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/stop requested during login queue/i.test(msg)) {
          this.log('stop_during_login', {});
          return false; // dashboard stop landed mid-queue — the caller's next controlWait exits gracefully
        }
        this.log('reconnect_attempt_fail', { attempt: i, err: msg });
        try { this.c.close(); } catch {}
        if (/token/i.test(msg)) await this.relogin(); // stale token → refresh and retry
        if (/ออนไลน์อยู่แล้ว|already online/i.test(msg)) {
          if (MODE === 'collector') {
            // COLLECTOR POLICY (2026-10-08, user ask): collector accounts get played by hand from time to
            // time — NEVER kick that seat. Probe passively; recovery is automatic the moment the seat
            // frees, and the pool holds every donor grant meanwhile (collectorLiveFor gates on `connected`).
            // The only forced takeover is an explicit ▶/↻ in the command center (it kicks server-side first).
            this.log('collector_seat_held', { attempt: i, policy: 'probe', waitSec: i <= 3 ? 10 : 30 });
            await sleep(i <= 3 ? 10000 : 30000);
          } else {
            // ALREADY-ONLINE = a stale seat still held, not a transient blip: hammer the kick until the
            // server ACCEPTS it (repeat through 409/0), then retry the connect once the release lands.
            // The old flow kicked once then burned connect attempts that could only fail the same way —
            // the bot 59 kick/409/connect-fail churn loop. No meaningless connects while the seat is held.
            const k = await this.kickUntilFree({ budgetMs: 90000 });
            await sleep(k.ok ? 2500 : 5000);
          }
        } else if (/Proxy connection timed out|ECONNRESET|socket hang up|ETIMEDOUT/i.test(msg)) {
          // Tor jam backoff (2026-10-09): a proxy timeout means Tor could not finish the circuit build within
          // the client's window — the build keeps running daemon-side, so instantly retrying just piles
          // ANOTHER build onto a saturated queue (the fleet-wide feedback loop that kept the last jams alive
          // for 30+ minutes). Back off LONG and JITTERED so 120 bots stop arriving in synchronized pulses.
          const wait = Math.min(120000, 25000 + i * 10000) + Math.round(Math.random() * 30000);
          await sleep(wait);
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
      const res = await apiFetch('/auth/login', {
        method: 'POST', body: { userId: u, password: p },
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
  // character-select "kick" button makes (POST /characters/:id/kick). Retries once with a fresh token
  // when the cached one has expired.
  async kickOnce() {
    const url = `https://www.aetheria-online.in.th/characters/${this.charId}/kick`;
    const call = async () => {
      const res = await apiFetch(url, { method: 'POST', token: this.c.token });
      let j = null; try { j = await res.json(); } catch {}
      return { status: res.status, ok: res.ok, err: (j && (j.error ?? j.err)) || null };
    };
    try {
      let r = await call();
      if (r.status === 401) { await this.relogin(); r = await call(); } // expired token → refresh once and retry
      this.log(r.ok ? 'kick_session_ok' : 'kick_session_fail', { status: r.status, err: r.err });
      return r;
    } catch (e) { this.log('kick_session_fail', { status: -1, err: String((e && e.message) || e) }); return { status: -1, ok: false, err: String((e && e.message) || e) }; }
  }

  // Kick until the server ACCEPTS it (bot 59 lesson): 200 = accepted → seat is being freed; 409 = the
  // logout is still in flight ("ลองใหม่อีกครั้งในอีกสักครู่") → wait and kick again; status 0/other =
  // response lost or transient → retry (repeated kicks are harmless — a free seat re-acks with 200);
  // 404 = wrong character id → abort. This ladder REPLACES blind connect churn: while the seat is held,
  // connect attempts can only fail with "already online" again.
  async kickUntilFree({ budgetMs = 90000 } = {}) {
    const t0 = Date.now();
    let tries = 0, last = null;
    while (Date.now() - t0 < budgetMs) {
      tries++;
      last = await this.kickOnce();
      if (last.status === 404) break; // wrong id — hammering will never help
      if (last.ok) {
        this.log('kick_ladder_done', { ok: true, tries, status: last.status, sec: Math.round((Date.now() - t0) / 1000) });
        return { ok: true, tries, last };
      }
      await sleep(last.status === 409 ? 4000 : 3000);
    }
    this.log('kick_ladder_done', { ok: false, tries, status: last?.status ?? null, sec: Math.round((Date.now() - t0) / 1000) });
    return { ok: false, tries, last };
  }

  // compat wrapper (boot path callers): returns bool
  async kickPreviousSession(opts) { const k = await this.kickUntilFree(opts); return k.ok; }

  // items to sell at the vendor: everything sellable that is NOT whitelisted, not a card and not one of the
  // bot's own potions — same policy as sellJunkExcept
  // buff items the auto engine should consume (live control config / last farm config) - protected from
  // selling and storage; the plan/config is the source of truth, this is only the runtime set
  buffItemIds() {
    const set = new Set();
    for (const src of [this.autoOverride?.buffItems, this._lastFarmAuto?.buffItems]) {
      for (const x of (src ?? [])) { const n = parseInt(x, 10); if (Number.isFinite(n)) set.add(n); }
    }
    return set;
  }
  sellableLines() {
    const inv = this.s.inventory;
    if (!inv?.items) return [];
    const keep = this.keepIds();
    const buffs = this.buffItemIds();
    const base = inv.items
      .filter((it) => (it.sellPrice ?? 0) > 0
        && !keep.has(it.itemId)
        && !buffs.has(it.itemId)
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
  // confirmed sale summary for the earnings tracker: total NPC value of the lines about to be sold
  // (lines are [{slot, qty}]; sellPrice comes from the client's own inventory, so totals are exact)
  saleSummary(lines) {
    const want = new Map();
    for (const l of lines) want.set(l.slot, (want.get(l.slot) ?? 0) + (l.qty ?? 1));
    const items = [];
    let total = 0;
    for (const it of (this.s.inventory?.items ?? [])) {
      const q = want.get(it.slot);
      if (!q) continue;
      const p = it.sellPrice ?? 0;
      total += p * q;
      if (items.length < 20) items.push({ n: it.name, q, p });
    }
    return { total, items };
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
    this.trace('setAuto');
    // 2026-10-09: sends while the socket is CONNECTING/CLOSED silently no-op ("WebSocket is not open"
    // client_error) - the stale disabled readback was then counted as a REFUSAL (3 fake fails -> the rescue
    // ladder fired channel-hop -> relogin). Wait for an open socket first; never count a disconnected try.
    if (!this.isConnected()) {
      const ok = await this.waitFor(() => this.isConnected(), 'ws open for auto', 12000).catch(() => false);
      if (!ok) { this.log('auto_set_wait_open_timeout', {}); return; }
    }
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
    // buff items: prune to what is actually carried (same enable-refusal guard as potions) - the stored
    // config keeps the full list; restocking the items re-arms them on the next setAuto call
    {
      const owned = new Set(inv.map((i) => i.itemId));
      cfg.buffItems = (Array.isArray(cfg.buffItems) ? cfg.buffItems : []).map((x) => parseInt(x, 10)).filter((id) => Number.isFinite(id) && owned.has(id));
    }
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
    this.log('setAuto', { skills: rb?.skills ?? cfg.skills, buffItems: rb?.buffItems ?? cfg.buffItems ?? [], radius: rb?.huntRadiusTiles, monsters: (Array.isArray(cfg.monsters) ? cfg.monsters.length : 0), monsterIds: Array.isArray(cfg.monsters) ? cfg.monsters.slice(0, 9) : [], hpItems: (rb?.hpItems ?? []).length, hpPercent: rb?.hpPercent, bashLv: this.char?.skills?.bash ?? null, enabled: this.char?.auto?.enabled, how, potions: invPots, map: this.c.mapId });
    if (this.char?.auto?.enabled !== true) {
      if (!this.isConnected()) { this.log('auto_enable_skipped_disconnected', {}); return; }
      this._autoFails = (this._autoFails || 0) + 1;
      this.log('auto_enable_failed', { map: this.c.mapId, hpItems: cfg.hpItems?.length ?? 0, spItems: cfg.spItems?.length ?? 0, invPots, fails: this._autoFails });
      // 2026-10-07: some post-update sessions refuse enable until a FRESH login (manual bounce always cleared it).
      // If we're on the farm map and 3 attempts in a row failed, self-heal with a reconnect (90s cooldown).
      // 2026-10-08: was gated to the farm map only — bots stranded in TOWN after a death never rescued
      // (enable is refused on capital; the farm-map gate blocked the whole ladder). Rescue from anywhere:
      // autoRescue hops channel first, relogins if needed, and walks back to the farm map itself.
      if (this._autoFails >= 3 && this._farmMap && Date.now() > (this._autoRescueAt ?? 0)) {
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
      if (this.pendingGrant) { await this.consumeGrant({ backMap: farmMap ?? this._farmMap ?? null, auto: auto ?? null }); continue; }
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

  // ---- humanization helpers ----
  // Human walk = click a jittered point around the target (server paths the rest), optionally via a small
  // mid-waypoint so long walks don't retrace the exact same line for every bot, every trip.
  async humanWalkTo(x, y, { radius = null, via = null, pause = null } = {}) {
    if (!H.on) { this.c.moveToPx(x, y); await sleep(pause ?? 1200); return; }
    try {
      const rad = radius ?? H.jitterPx;
      const ang = H.rnd() * Math.PI * 2;
      const rr = rad * (0.5 + H.rnd() * 0.5);
      const live = this.c.live;
      const useVia = (via ?? H.rnd() < H.viaProb) && live && live.x != null && Math.hypot(x - live.x, y - live.y) > 260;
      if (useVia) {
        const t = 0.4 + H.rnd() * 0.25;
        const px = -(y - live.y), py = x - live.x;
        const len = Math.max(1, Math.hypot(px, py));
        const off = (H.rnd() * 2 - 1) * 20; // small lateral drift, not a detour
        this.c.moveToPx(live.x + (x - live.x) * t + (px / len) * off, live.y + (y - live.y) * t + (py / len) * off);
        await sleep(hSleep(750, 0.5));
      }
      this.c.moveToPx(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
      await sleep(pause != null ? hSleep(pause, 0.4) : hSleep(1200, 0.4));
    } catch { this.c.moveToPx(x, y); await sleep(pause ?? 1200); }
  }

  // Occasional idle detour before a town chore: wander near a random NPC / square, sometimes greet it.
  // Purely cosmetic — talk+close only, never selects options.
  async maybeTownLoiter(tag) {
    try {
      if (!H.on || this.c.mapId !== 'capital') return;
      if (this.s.trade || this.s.invite || this.s.death) return;
      if (Date.now() - (this._loiterAt || 0) < H.loiterGateMs) return;
      if (H.rnd() > H.chatty) return;
      this._loiterAt = Date.now();
      const spots = [
        { x: 2288, y: 1168, npc: 'n1', what: 'healer' },
        { x: 1664, y: 960, npc: 'n5', what: 'valkyrie' },
        { x: 2032, y: 1626, npc: null, what: 'event-square' },
        { x: 2440, y: 1520, npc: null, what: 'auctioneer-window' },
        { x: 900, y: 1080, npc: null, what: 'north-gate' },
        { x: 1400, y: 1500, npc: null, what: 'fountain' },
      ];
      const s = spots[Math.floor(H.rnd() * spots.length)];
      this.log('human_loiter', { tag, at: s.what, npc: s.npc ?? null });
      await this.humanWalkTo(s.x, s.y);
      await sleep(hSleep(900, 0.8));
      if (s.npc) {
        try {
          await this.talk(s.npc, { timeout: 5000 });
          await sleep(hSleep(500, 0.6));
          this.c.npcClose();
          await sleep(hSleep(350, 0.6));
        } catch {}
      }
    } catch {}
  }

  // Collector idle: short wander around the hold spot (≤60px so arriving donors still find us), then re-assert.
  async collectorSpotAssert(spot) {
    if (!spot) return;
    try {
      if (H.on && !this.s.trade && !this.s.invite && H.rnd() < 0.25 && Date.now() - (this._wanderAt || 0) > 90000) {
        this._wanderAt = Date.now();
        const ang = H.rnd() * Math.PI * 2, rr = 24 + H.rnd() * 36; // 24–60 px amble
        this.c.moveToPx(spot.x + Math.cos(ang) * rr, spot.y + Math.sin(ang) * rr);
        await sleep(hSleep(1100, 0.5));
        this.log('collector_wander', { spot: [Math.round(spot.x), Math.round(spot.y)], r: Math.round(rr) });
      }
      await this.humanWalkTo(spot.x, spot.y, { radius: 8 });
    } catch { this.c.moveToPx(spot.x, spot.y); }
  }

  async walkToNpc(npcPx) {
    await this.humanWalkTo(npcPx[0], npcPx[1]);
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
    if (lines.length) {
      const sum = this.saleSummary(lines);
      this.c.shopSellMany(lines);
      this.log('auto_sold', { count: lines.length, total: sum.total, items: sum.items });
      await sleep(1800);
    }
    this.c.npcClose(); await sleep(400);
  }

  async bankProtected() {
    const inv = this.s.inventory;
    const prot = (inv?.items ?? []).filter((it) => CARD_RE.test(it.name ?? ''));
    if (!prot.length) return 0;
    const d = await this.aliceTalk();
    const opt = this.findOption(d, 'คลัง');
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
  // wings stay OUT: they are the farm→capital travel ticket, not loot
  async depositKeepItems(keepIds, { npcKey = 'n6' } = {}) {
    return this.depositItemsWhere((it) => keepIds.has(it.itemId) && it.itemId !== WING_BUTTERFLY, { npcKey });
  }
  async depositItemsWhere(pred, { npcKey = 'n6', label = 'storage' } = {}) {
    const all = (this.s.inventory?.items ?? []).filter(pred);
    if (!all.length) return 0;
    await this.ensureMap('capital');
    const d = await this.aliceTalk(); // Alice resolved by dialog identity (legacy npcKey param kept for callers)
    const opt = this.findOption(d, 'คลัง') ?? this.findOption(d, 'ฝาก') ?? this.findOption(d, 'storage');
    if (!opt) { this.log('storage_npc_probe', { npc: npcKey, options: d?.options ?? null }); this.c.npcClose(); await sleep(400); return 0; }
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
    const buffs = this.buffItemIds();
    return this.depositItemsWhere((it) => !keepIds.has(it.itemId) && !buffs.has(it.itemId)
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
    const buffs = this.buffItemIds();
    const lines = (this.s.inventory?.items ?? [])
      .filter((it) => (it.sellPrice ?? 0) > 0
        && !keepIds.has(it.itemId) && !buffs.has(it.itemId)
        && !CARD_RE.test(it.name ?? '')
        && !this.isScrollName(it.name ?? '')
        && it.autoPotion !== 'HP' && it.autoPotion !== 'SP'
        && !/(potion|ยา)/i.test(it.name ?? ''))
      .map((it) => ({ slot: it.slot, qty: it.qty }));
    // consumables: keep ONLY the configured potion up to the refill threshold; sell every other potion-like item
    lines.push(...this._consumablePolicyLines());
    const before = this.char?.zeny ?? 0;
    if (lines.length) {
      const sum = this.saleSummary(lines);
      this.c.shopSellMany(lines);
      this.log('sold_except_keep', { lines: lines.length, total: sum.total, items: sum.items });
      this._lastSellAt = Date.now(); // captcha forensics: sell anchor
      await sleep(2000);
    }
    this.c.npcClose(); await sleep(400);
    return (this.char?.zeny ?? 0) - before;
  }

  // ---- equipment auto-discard (zeny plan 2026-10-13): "ทิ้ง" gear drops on pickup — never bank gear.
  // Verified from the client bundle: the discard UI confirmation sends `inv_destroy {slot, qty}`;
  // locked items refuse ("ขาย ทิ้ง ลงตลาด เทรดไม่ได้"), whitelisted items are never discarded.
  isEquipItem(it) { // gear OR cards (2026-10-13: cards are discarded too) — keepIds() still protects anything whitelisted
    if (!it) return false;
    if (it.equipType != null) return true;
    if (/^card$/i.test(String(it.type ?? ''))) return true;
    return /weapon|armor|shield|garment|footwear|footgear|headwear|headgear|accessory|costume|robe|hat/i.test(String(it.type ?? ''));
  }
  async discardEquipmentDrops() {
    if (!this.errandCfg?.discardEquip) return;
    if (this._discardP) return this._discardP;
    this._discardP = (async () => {
      for (let pass = 0; pass < 8; pass++) {
        const keep = this.keepIds();
        const list = (this.s.inventory?.items ?? []).filter((it) => this.isEquipItem(it) && !keep.has(it.itemId) && !it.locked);
        if (!list.length) break;
        for (const it of list.slice(0, 12)) {
          if (!this.isConnected() || this.isJailed() || this.s.death || !this.errandCfg?.discardEquip) return;
          const n0 = (this.s.inventory?.items ?? []).length;
          try { this.c.send('inv_destroy', { slot: it.slot, qty: it.qty ?? 1 }); } catch {}
          await this.waitFor(() => { const iv = this.s.inventory?.items ?? []; return iv.length < n0 || !iv.some((x) => x.slot === it.slot); }, 'inv_destroy', 2500).catch(() => {});
          this.log('equip_discarded', { name: it.name, itemId: it.itemId, slot: it.slot, qty: it.qty ?? 1 });
          await sleep(280);
        }
        await sleep(450);
      }
    })().finally(() => { this._discardP = null; });
    return this._discardP;
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
    this.trace('chan:switch:' + target);
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
    this.trace('chan:least');
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
    // human policy: pick among the top-3 least-loaded (50/30/20) instead of everyone stacking the strict min,
    // and sometimes just stay put even when a slightly better channel exists.
    let best = cands[0];
    if (H.on && best) {
      const top = cands.slice(0, 3);
      const r = H.rnd();
      best = top[r < 0.5 ? 0 : r < 0.8 ? 1 : 2] ?? best;
      if (here && best.players >= here.players - 1 && H.rnd() < H.stayBias) {
        this.log('channel_keep', { current: snap.current, players: here?.players ?? null, best: [best.channel, best.players], human: true });
        return false;
      }
    }
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
    this.trace('chan:onReturn');
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
    await this.walkToNpc(NPCS.n6); // Alice's position never moved — only her dialog key shifted (n6→n7)
    if (this.s.storage) return true;
    const d = await this.aliceTalk({ walk: false });
    const opt = this.findOption(d, 'คลัง') ?? this.findOption(d, 'ฝาก') ?? this.findOption(d, 'storage');
    if (!opt) { this.log('storage_npc_probe', { npc: npcKey, options: d?.options ?? null }); this.c.npcClose(); await sleep(400); return false; }
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

  // Consume a pending collect grant if one is queued — shared by plan-step boundaries and the skill-wait
  // loop. Plan-mode donors only used to check pendingGrant inside farm(); a grant landing while they sat in
  // a wait step (e.g. 24-skills-j50 waits up to 60 min inside applySkills) went unconsumed until the CC
  // timed the slot out after 10 min (observed on bots 112/114/118, 2026-10-08). Returns true when a collect ran.
  async consumeGrant({ backMap = null, auto = null } = {}) {
    if (!this.pendingGrant) return false;
    const g = this.pendingGrant; this.pendingGrant = null;
    this.log('collect_granted', g);
    this.trace('collect');
    await this.handleGrant(g);
    if (backMap) { try { await this.ensureMap(backMap); } catch {} }
    if (auto) { try { await this.setAuto(auto); } catch {} }
    try { this.pushStatus(); } catch {}
    return true;
  }

  // one entry point for both grant flavours (2026-10-08): collect (hand items TO the collector) vs
  // shopping (the collector BUYS gear and hands it TO us). Consumed from the same control.json `grant`.
  async handleGrant(g) {
    if (g?.shop) {
      try { await this.shoppingVisit(g); this.lastShopDone = { at: Date.now(), ok: true }; }
      catch (e) { this.log('shop_fail', String((e && e.message) || e)); this.lastShopDone = { at: Date.now(), ok: false, error: String((e && e.message) || e) }; }
      try { this.pushStatus(); } catch {}
      return;
    }
    try { await this.collectToCollector(g); this.lastCollectDone = { at: Date.now(), collector: g.collector }; this.wantCollect = false; }
    catch (e) { this.log('collect_fail', String((e && e.message) || e)); this.lastCollectDone = { at: Date.now(), error: true }; }
  }

  async collectToCollector(g) {
    if (g?.hop === true) return this.collectToCollectorHop(g); // hop mode (2026-10-09): just-in-time multi-collector trip
    const t0 = Date.now();
    // multi-collector (2026-10-08): the grant carries an ordered list of targets, each with an explicit
    // acceptance allowance (remaining capacity: zeny + per-item counts). We visit them in order; whatever
    // one collector can't take spills to the next. Legacy grants (no targets) behave exactly as before.
    const targets = (Array.isArray(g?.targets) && g.targets.length
      ? g.targets
      : [{ name: g.collector, channel: g.channel ?? null, spot: g.spot ?? null, acceptZeny: null, acceptItems: null }]
    ).filter((t) => t && t.name);
    if (g.channel != null) this._collectorChannel = g.channel; // remembered: farm channels steer clear of it
    const keep = this.keepIds();
    // 50k reserve (was 10k): every bot must afford 10× weight-limit scrolls (5,000z each) at Shopkeeper Bor
    const RESERVE = 50000;
    const RUN_LIMIT_MS = 25 * 60 * 1000;
    this.log('collect_start', { collector: targets.map((t) => t.name).join(' → '), channel: g.channel, whitelist: [...keep] });
    try { this.c.autoEnabled(false); } catch {}
    await this.ensureMap('capital');
    await this.maybeTownLoiter('collect');
    const bagKeep = () => (this.s.inventory?.items ?? []).filter((it) => keep.has(it.itemId) && it.itemId !== WING_BUTTERFLY);
    const bagMap = () => { const m = new Map(); for (const it of bagKeep()) m.set(it.itemId, (m.get(it.itemId) ?? 0) + (it.qty ?? 1)); return m; };
    const diffMoved = (m0, m1) => { const out = new Map(); for (const [id, q] of m0) { const n = m1.get(id) ?? 0; if (n < q) out.set(id, q - n); } return out; };
    let rounds = 0, offered = 0, zenyMoved = 0, stacksMoved = 0, totalReceipts = 0, failedOpen = 0;
    const targetSummary = [];
    let curChan = null; // unknown until the room placement below — NEVER assume the grant's channel is current
    let firstTarget = true;
    let storageLaps = 0;

    // pre-trade town chores only once (vendor / scrolls / wings / storage pull) — done at the FIRST target's spot
    const firstSpot = (targets[0]?.spot && targets[0].spot.x != null) ? targets[0].spot : (g.spot ?? { x: 880, y: 1520 });
    // ROOM PLACEMENT, ALWAYS (2026-10-08 fix): the donor arrives on its FARM channel (wings preserve the
    // channel; farm bots are steered OFF the collector's), but the old code compared the target channel
    // against the GRANT's channel and skipped this rejoin — the donor then sat in the wrong capital room
    // where `trade request` is silently dropped: 6×15s timeouts, ~90s dead time EVERY trip, "fixed" only
    // by the round-6 room repair. rejoinCollectorRoom reads a FRESH channel snapshot and does the right
    // thing either way: off-channel → one switch; already-on-channel (portal arrival = wrong room
    // instance) → hop out and back. Unconditional for the first target.
    const firstCh = targets[0]?.channel ?? null;
    if (firstCh != null) {
      const placed = await this.rejoinCollectorRoom(firstCh).catch(() => false);
      this.log('collect_room_placed', { target: firstCh, ok: placed });
      curChan = firstCh;
    }
    await this.humanWalkTo(firstSpot.x, firstSpot.y, { radius: 12, pause: 2200 });
    // NEW POLICY (2026-10-06): bots NEVER touch storage (no deposits, no withdrawals, no sweeps).
    // EXCEPTION (2026-10-08, storeWhitelist plans): the whitelist rides in the bot's OWN storage between
    // collects — pull it back into the bag before trading; later laps re-pull whenever the bag lightens up.
    try {
      const sellable = (this.s.inventory?.items ?? []).filter((it) => (it.sellPrice ?? 0) > 0 && !keep.has(it.itemId) && !CARD_RE.test(it.name ?? '') && it.autoPotion !== 'HP' && it.autoPotion !== 'SP' && !/(potion|ยา)/i.test(it.name ?? ''));
      if (sellable.length) { await this.sellJunkExcept(keep); await this.humanWalkTo(firstSpot.x, firstSpot.y, { radius: 12, pause: 1800 }); }
    } catch (e) { this.log('collect_sell_fail', String((e && e.message) || e)); }
    if (this.scrollCount() < 10) { try { await this.buyWeightScrolls(); await this.humanWalkTo(firstSpot.x, firstSpot.y, { radius: 12, pause: 1200 }); } catch (e) { this.log('scroll_fail', String((e && e.message) || e)); } }
    await this.buyButterflyWings().catch(() => {});
    if (this.storeWhitelist) {
      const moved0 = await this.withdrawKeepFromStorage(keep, { maxStacks: 40 }).catch(() => 0);
      this.log('collect_storage_pull', { lap: 0, moved: moved0 });
      await this.humanWalkTo(firstSpot.x, firstSpot.y, { radius: 12, pause: 2500 });
    }

    for (const t of targets) {
      markLoop();
      if (Date.now() - t0 >= RUN_LIMIT_MS) break;
      const spot = (t.spot && t.spot.x != null) ? t.spot : { x: 880, y: 1520 };
      const allowItems = t.acceptItems ? new Map(Object.entries(t.acceptItems).map(([k, v]) => [parseInt(k, 10), parseInt(v, 10) || 0])) : null;
      let allowZeny = t.acceptZeny != null ? Math.max(0, parseInt(t.acceptZeny, 10) || 0) : null;
      const targetMoved = new Map(); let targetZeny = 0;
      if (t.channel != null && t.channel !== curChan) {
        await this.rejoinCollectorRoom(t.channel).catch(() => {});
        curChan = t.channel;
        this._collectorChannel = t.channel;
      }
      await this.humanWalkTo(spot.x, spot.y, { radius: 10, pause: firstTarget ? 0 : 1800 });
      firstTarget = false;
      this.log('collect_target_start', { collector: t.name, spot, acceptZeny: allowZeny, acceptItems: allowItems ? allowItems.size : null });
      let openStreak = 0, hopUsed = false, noProgAt = 0;
      while (Date.now() - t0 < RUN_LIMIT_MS && rounds < 100) {
        // the server can drop sockets (4001/1006 bursts) — recover instead of spinning on a dead connection
        if (!this.isConnected()) {
          this.log('collect_disconnected', { round: rounds });
          try { await this.reconnect(); this.log('collect_reconnected', { map: this.c.mapId }); }
          catch (e) { this.log('collect_reconnect_fail', String((e && e.message) || e)); await sleep(5000); continue; }
          if (this.c.mapId !== 'capital') await this.ensureMap('capital').catch(() => {});
          if (t.channel != null) await this.rejoinCollectorRoom(t.channel).catch(() => {});
          await this.humanWalkTo(spot.x, spot.y, { radius: 10, pause: 1800 });
          continue;
        }
        const zeny = this.char?.zeny ?? 0;
        const giveZeny = Math.min(Math.max(0, zeny - RESERVE), allowZeny ?? Number.POSITIVE_INFINITY);
        // storage-fed plans: refill the bag from own storage while it is light and storage still holds whitelist
        if (this.storeWhitelist && storageLaps < 6) {
          const stHas = (this.s.storage?.items ?? []).some((it) => keep.has(it.itemId));
          const inv = this.s.inventory;
          const bagLight = (inv?.weight ?? 0) < (inv?.weightLimit ?? 1) * 0.55 && bagKeep().length < 20;
          if (stHas && bagLight) {
            storageLaps++;
            const moved = await this.withdrawKeepFromStorage(keep, { maxStacks: 40 }).catch(() => 0);
            this.log('collect_storage_pull', { lap: storageLaps, moved });
            if (moved === 0) storageLaps = 6;
            else { await this.humanWalkTo(spot.x, spot.y, { radius: 10, pause: 2000 }); }
          }
        }
        // allowance-trimmed offer: only what this collector can still accept
        const avail = bagKeep().filter((it) => !allowItems || (allowItems.get(it.itemId) ?? 0) > 0)
          .map((it) => ({ ...it, qty: allowItems ? Math.min(it.qty, allowItems.get(it.itemId) ?? 0) : it.qty }));
        if (!avail.length && giveZeny < 500) {
          const stMore = this.storeWhitelist && storageLaps < 6 && (this.s.storage?.items ?? []).some((it) => keep.has(it.itemId));
          if (!stMore) break; // everything this collector can take has been handed over
        }
        if (noProgAt && Date.now() - noProgAt < 60000) { await sleep(5000); continue; }
        noProgAt = 0;
        rounds++;
        const seq = this.s.tradeSeq || 0;
        this.log('trade_request_send', { round: rounds, collector: t.name, stacks: avail.length, zeny: giveZeny });
        this.c.tradeRequest(t.name);
        const opened = await this.waitFor(() => (this.s.tradeSeq || 0) > seq, 'trade open', 15000).catch(() => false);
        if (!opened) {
          openStreak++;
          this.log('trade_open_timeout', { round: rounds, collector: t.name, invite: this.s.invite ?? null, streak: openStreak });
          if (openStreak >= 6) {
            if (!hopUsed) {
              hopUsed = true;
              this.log('collect_room_repair', { round: rounds, collector: t.name, note: 'no trade window for 6 rounds — forcing channel rejoin' });
              await this.rejoinCollectorRoom(t.channel).catch(() => {});
              await this.humanWalkTo(spot.x, spot.y, { radius: 10, pause: 2000 }); openStreak = 0;
            } else {
              this.log('collect_target_unreachable', { collector: t.name, round: rounds });
              failedOpen++;
              break; // try the next collector instead of spamming this one for 100 rounds
            }
          }
          await sleep(3000); continue;
        }
        openStreak = 0;
        const offer = avail.slice(0, 10).map((it) => ({ slot: it.slot, qty: it.qty }));
        this.c.tradeOffer(offer, giveZeny);
        offered += offer.length;
        await sleep(1500);
        this.c.tradeLock();
        this.log('trade_locked_mine', { round: rounds, offer: offer.length, zeny: giveZeny });
        const bothLocked = await this.waitFor(() => { const tr = this.s.trade; return !!(tr && tr.mine?.locked && tr.theirs?.locked); }, 'both locked', 30000).catch(() => false);
        if (bothLocked) { this.c.tradeConfirm(); this.log('trade_confirm_sent', { round: rounds }); }
        else this.log('trade_lock_timeout', { round: rounds, state: this.s.trade ?? null });
        const m0 = bagMap();
        const zeny0 = this.char?.zeny ?? 0;
        const done = await this.waitFor(() => {
          const tr = this.s.trade;
          const cleared = !tr || tr.closed === true || tr.done === true;
          const shrunk = bagKeep().reduce((s, it) => s + (it.qty ?? 1), 0) < [...m0.values()].reduce((s, q) => s + q, 0) || (this.char?.zeny ?? 0) < zeny0;
          return cleared || shrunk;
        }, 'trade done', 45000).catch(() => false);
        const m1 = bagMap();
        const movedItems = diffMoved(m0, m1);
        const zenyNow = this.char?.zeny ?? 0;
        const movedZ = Math.max(0, zeny0 - zenyNow);
        const movedNow = movedItems.size > 0 || movedZ > 0;
        if (movedNow) {
          stacksMoved += Math.max(0, offer.length);
          zenyMoved += movedZ;
          targetZeny += movedZ;
          for (const [id, q] of movedItems) {
            targetMoved.set(id, (targetMoved.get(id) ?? 0) + q);
            if (allowItems) allowItems.set(id, Math.max(0, (allowItems.get(id) ?? 0) - q));
          }
          if (allowZeny != null) allowZeny = Math.max(0, allowZeny - movedZ);
        } else {
          this.log('collect_no_progress', { round: rounds, collector: t.name, note: 'collector bag full — waiting for it to store' });
          noProgAt = Date.now();
        }
        this.log('trade_round_end', { round: rounds, done, moved: movedNow });
        if (!done) { this.c.tradeCancel(); await sleep(2000); }
        else this.s.trade = null;
        await sleep(1500);
      }
      // per-collector receipt → the command center's holdings ledger consumes this event verbatim
      if (targetMoved.size || targetZeny) {
        totalReceipts++;
        this.log('collector_receipt', {
          collector: t.name,
          zeny: targetZeny,
          stacks: [...targetMoved.values()].reduce((a, b) => a + b, 0),
          items: [...targetMoved.entries()].map(([itemId, qty]) => ({ itemId, qty })),
        });
      }
      targetSummary.push({ collector: t.name, stacks: [...targetMoved.values()].reduce((a, b) => a + b, 0), zeny: targetZeny });
    }
    try { this.c.npcClose(); } catch {}
    // 3) no storage pass — leftover unsellables stay in the bag by policy (bots never touch storage)
    if (!totalReceipts && failedOpen >= targets.length) throw new Error('trade window never opens — collectors not resolvable (wrong room?)');
    this.log('collect_done', { rounds, offered, stacks: stacksMoved, zeny: zenyMoved, targets: targetSummary, ms: Date.now() - t0 });
  }

  // ---- hop mode (2026-10-09) -----------------------------------------------------------------
  // ONE trip to the collectors' lounge, then one allocation request per hop: the CC books a free collector
  // exactly when it answers, so no collector is held while we trade elsewhere. Items and zeny split across
  // as many collectors as it takes — the CC replies 'busy' (wait), a target (go trade), or nothing (done).
  hopWrite(want, payload = {}) {
    const hopId = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    try { fs.unlinkSync(HOP_RES_FILE); } catch {}
    fs.writeFileSync(HOP_REQ_FILE, JSON.stringify({ hopId, want, at: Date.now(), ...payload }));
    return hopId;
  }
  async hopAwait(hopId, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(700);
      try { const res = JSON.parse(fs.readFileSync(HOP_RES_FILE, 'utf8')); if (res && res.hopId === hopId) return res; } catch {}
      if (!this.isConnected()) return null;
    }
    return null;
  }
  hopBag() {
    const keep = this.keepIds();
    const m = new Map();
    for (const it of (this.s.inventory?.items ?? [])) if (keep.has(it.itemId) && it.itemId !== WING_BUTTERFLY) m.set(it.itemId, (m.get(it.itemId) ?? 0) + (it.qty ?? 1));
    return m;
  }
  async hopAlloc({ tripId, exclude }) {
    const bag = this.hopBag();
    const zeny = this.char?.zeny ?? 0;
    if (!bag.size && zeny <= 50050) return { none: 'done' };
    const hopId = this.hopWrite('alloc', { tripId, exclude, have: { zeny, items: Object.fromEntries(bag) } });
    this.log('hop_alloc_req', { hopId, stacks: bag.size, zeny, exclude });
    const res = await this.hopAwait(hopId);
    this.log('hop_alloc_res', { hopId, ok: !!res, target: res?.target?.name ?? null, none: res?.none ?? null, acceptZeny: res?.acceptZeny ?? null, acceptItems: res?.acceptItems ? Object.keys(res.acceptItems).length : 0 });
    return res;
  }
  // trade with ONE collector under a hop allowance (multi-round, same machinery as the legacy trip minus storage refills)
  async tradeHopWith(t, { allowItems = null, allowZeny = null, t0 = Date.now(), hop = 0 } = {}) {
    const keep = this.keepIds();
    const bagKeep = () => (this.s.inventory?.items ?? []).filter((it) => keep.has(it.itemId) && it.itemId !== WING_BUTTERFLY);
    const bagMap = () => { const m = new Map(); for (const it of bagKeep()) m.set(it.itemId, (m.get(it.itemId) ?? 0) + (it.qty ?? 1)); return m; };
    const diffMoved = (m0, m1) => { const out = new Map(); for (const [id, q] of m0) { const n = m1.get(id) ?? 0; if (n < q) out.set(id, q - n); } return out; };
    const spot = (t.spot && t.spot.x != null) ? t.spot : { x: 880, y: 1520 };
    this.c.moveToPx(spot.x, spot.y);
    await sleep(1500);
    const out = { movedItems: new Map(), zeny: 0, stacks: 0, rounds: 0, offered: 0 };
    let openStreak = 0, hopUsed = false, noProgAt = 0;
    while (out.rounds < 8 && Date.now() - t0 < 25 * 60 * 1000) {
      markLoop();
      if (!this.isConnected()) {
        this.log('collect_disconnected', { round: out.rounds, hop });
        try { await this.reconnect(); if (this.c.mapId !== 'capital') await this.ensureMap('capital').catch(() => {}); if (t.channel != null) await this.rejoinCollectorRoom(t.channel).catch(() => {}); this.c.moveToPx(spot.x, spot.y); await sleep(1800); continue; }
        catch (e) { this.log('collect_reconnect_fail', String((e && e.message) || e)); await sleep(5000); continue; }
      }
      const zeny = this.char?.zeny ?? 0;
      const giveZeny = Math.min(Math.max(0, zeny - 50000), allowZeny ?? Number.POSITIVE_INFINITY);
      const avail = bagKeep().filter((it) => !allowItems || (allowItems.get(it.itemId) ?? 0) > 0)
        .map((it) => ({ ...it, qty: allowItems ? Math.min(it.qty, allowItems.get(it.itemId) ?? 0) : it.qty }));
      if (!avail.length && giveZeny < 500) break;
      if (noProgAt && Date.now() - noProgAt < 30000) { await sleep(5000); continue; }
      noProgAt = 0;
      out.rounds++;
      const seq = this.s.tradeSeq || 0;
      this.log('trade_request_send', { round: out.rounds, collector: t.name, stacks: avail.length, zeny: giveZeny, hop });
      this.c.tradeRequest(t.name);
      const opened = await this.waitFor(() => (this.s.tradeSeq || 0) > seq, 'trade open', 15000).catch(() => false);
      if (!opened) {
        openStreak++;
        this.log('trade_open_timeout', { round: out.rounds, collector: t.name, invite: this.s.invite ?? null, streak: openStreak, hop });
        if (openStreak >= 4) {
          if (!hopUsed) { hopUsed = true; this.log('collect_room_repair', { round: out.rounds, collector: t.name, hop, note: 'no trade window — forcing channel rejoin' }); await this.rejoinCollectorRoom(t.channel).catch(() => {}); this.c.moveToPx(spot.x, spot.y); await sleep(2000); openStreak = 0; }
          else break;
        }
        await sleep(2500);
        continue;
      }
      openStreak = 0;
      const offer = avail.slice(0, 10).map((it) => ({ slot: it.slot, qty: it.qty }));
      this.c.tradeOffer(offer, giveZeny);
      await sleep(1500);
      this.c.tradeLock();
      this.log('trade_locked_mine', { round: out.rounds, offer: offer.length, zeny: giveZeny, hop });
      const bothLocked = await this.waitFor(() => { const tr = this.s.trade; return !!(tr && tr.mine?.locked && tr.theirs?.locked); }, 'both locked', 30000).catch(() => false);
      if (bothLocked) { this.c.tradeConfirm(); this.log('trade_confirm_sent', { round: out.rounds, hop }); }
      else this.log('trade_lock_timeout', { round: out.rounds, hop });
      const m0 = bagMap();
      const zeny0 = this.char?.zeny ?? 0;
      const done = await this.waitFor(() => {
        const tr = this.s.trade;
        const cleared = !tr || tr.closed === true || tr.done === true;
        const shrunk = bagKeep().reduce((s, it) => s + (it.qty ?? 1), 0) < [...m0.values()].reduce((s, q) => s + q, 0) || (this.char?.zeny ?? 0) < zeny0;
        return cleared || shrunk;
      }, 'trade done', 45000).catch(() => false);
      const moved = diffMoved(m0, bagMap());
      const movedZ = Math.max(0, zeny0 - (this.char?.zeny ?? 0));
      if (moved.size || movedZ > 0) {
        out.offered += offer.length;
        out.stacks += offer.length;
        out.zeny += movedZ;
        for (const [id, q] of moved) { out.movedItems.set(id, (out.movedItems.get(id) ?? 0) + q); if (allowItems) allowItems.set(id, Math.max(0, (allowItems.get(id) ?? 0) - q)); }
        if (allowZeny != null) allowZeny = Math.max(0, allowZeny - movedZ);
      } else {
        this.log('collect_no_progress', { round: out.rounds, collector: t.name, hop });
        noProgAt = Date.now();
      }
      this.log('trade_round_end', { round: out.rounds, done, moved: moved.size > 0 || movedZ > 0, hop });
      if (!done) { this.c.tradeCancel(); await sleep(2000); } else this.s.trade = null;
      await sleep(1200);
    }
    return out;
  }
  async collectToCollectorHop(g) {
    const t0 = Date.now();
    const RUN_LIMIT_MS = 25 * 60 * 1000;
    const keep = this.keepIds();
    const tripId = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const targets0 = Array.isArray(g?.targets) ? g.targets.filter((t) => t && t.name) : [];
    this.log('collect_start', { collector: 'hop-lounge', channel: g?.channel ?? null, hop: true, tripId, whitelist: [...keep] });
    try { this.c.autoEnabled(false); } catch {}
    let finished = false;
    let totalReceipts = 0;
    const finishTrip = () => {
      if (finished) return; finished = true;
      const bag = this.hopBag();
      const leftover = { zeny: Math.max(0, (this.char?.zeny ?? 0) - 50000), items: Object.fromEntries(bag) };
      const hopId = this.hopWrite('finish', { tripId, leftover, receipts: totalReceipts });
      this.log('hop_finish', { hopId, zeny: leftover.zeny, stackTypes: bag.size });
      try { this.c.npcClose(); } catch {}
    };
    try {
      await this.ensureMap('capital');
      let curChan = null;
      if (g?.channel != null) { const placed = await this.rejoinCollectorRoom(g.channel).catch(() => false); this.log('collect_room_placed', { target: g.channel, ok: placed, mode: 'hop' }); curChan = g.channel; }
      const lounge = (g?.spot && g.spot.x != null) ? g.spot : { x: 880, y: 1520 };
      this.c.moveToPx(lounge.x, lounge.y);
      await sleep(2200);
      try {
        const sellable = (this.s.inventory?.items ?? []).filter((it) => (it.sellPrice ?? 0) > 0 && !keep.has(it.itemId) && !CARD_RE.test(it.name ?? '') && it.autoPotion !== 'HP' && it.autoPotion !== 'SP' && !/(potion|ยา)/i.test(it.name ?? ''));
        if (sellable.length) { await this.sellJunkExcept(keep); this.c.moveToPx(lounge.x, lounge.y); await sleep(1800); }
      } catch (e) { this.log('collect_sell_fail', String((e && e.message) || e)); }
      if (this.scrollCount() < 10) { try { await this.buyWeightScrolls(); this.c.moveToPx(lounge.x, lounge.y); await sleep(1200); } catch (e) { this.log('scroll_fail', String((e && e.message) || e)); } }
      await this.buyButterflyWings().catch(() => {});
      if (this.storeWhitelist) {
        const moved0 = await this.withdrawKeepFromStorage(keep, { maxStacks: 40 }).catch(() => 0);
        this.log('collect_storage_pull', { lap: 0, moved: moved0 });
        this.c.moveToPx(lounge.x, lounge.y); await sleep(2500);
      }
      this.pushStatus(); // the CC sees the fresh bag while we hop
      let rounds = 0, offered = 0, stacksMoved = 0, zenyMoved = 0, hopCount = 0, zeroStreak = 0, fallback = false;
      const done = new Set();
      const targetSummary = [];
      while (Date.now() - t0 < RUN_LIMIT_MS && hopCount < 24) {
        markLoop();
        const alloc = await this.hopAlloc({ tripId, exclude: [...done] });
        if (!alloc) {
          if (!totalReceipts && targets0.length) { fallback = true; this.log('hop_fallback_legacy', { targets: targets0.length }); }
          else this.log('hop_alloc_fail', {});
          break;
        }
        if (alloc.none === 'busy') { this.log('hop_wait_busy', { hop: hopCount }); await sleep(4000); continue; }
        if (alloc.none === 'done' && !totalReceipts) { this.log('hop_nothing_to_do', {}); return; }
        if (!alloc.target) { this.log('hop_leftover_none', { none: alloc.none ?? null }); break; }
        hopCount++;
        const t = alloc.target;
        const allowItems = alloc.acceptItems && Object.keys(alloc.acceptItems).length ? new Map(Object.entries(alloc.acceptItems).map(([k, v]) => [+k, +v])) : null;
        const allowZeny = alloc.acceptZeny != null ? Math.max(0, +alloc.acceptZeny || 0) : null;
        this.log('hop_start', { hop: hopCount, collector: t.name, acceptZeny: allowZeny, acceptItems: allowItems ? allowItems.size : 0 });
        if (t.channel != null && t.channel !== curChan) { await this.rejoinCollectorRoom(t.channel).catch(() => {}); curChan = t.channel; }
        const r = await this.tradeHopWith(t, { allowItems, allowZeny, t0, hop: hopCount });
        rounds += r.rounds; offered += r.offered; stacksMoved += r.stacks; zenyMoved += r.zeny;
        if (r.movedItems.size || r.zeny > 0) {
          totalReceipts++; zeroStreak = 0;
          const stacks = [...r.movedItems.values()].reduce((a, b) => a + b, 0);
          targetSummary.push({ collector: t.name, stacks, zeny: r.zeny, hop: hopCount });
          this.log('collector_receipt', { collector: t.name, zeny: r.zeny, stacks, items: [...r.movedItems.entries()].map(([itemId, qty]) => ({ itemId, qty })), hop: hopCount });
        } else {
          zeroStreak++; done.add(t.name);
          this.log('hop_no_progress', { collector: t.name, streak: zeroStreak });
          if (zeroStreak >= 3) break;
        }
      }
      if (fallback) {
        this.log('hop_legacy_start', { targets: targets0.length });
        for (const t of targets0) {
          const allowItems = t.acceptItems && Object.keys(t.acceptItems).length ? new Map(Object.entries(t.acceptItems).map(([k, v]) => [+k, +v])) : null;
          const allowZeny = t.acceptZeny != null ? Math.max(0, +t.acceptZeny || 0) : null;
          if (t.channel != null && t.channel !== curChan) { await this.rejoinCollectorRoom(t.channel).catch(() => {}); curChan = t.channel; }
          const r = await this.tradeHopWith(t, { allowItems, allowZeny, t0, hop: hopCount + 1 });
          rounds += r.rounds; offered += r.offered; stacksMoved += r.stacks; zenyMoved += r.zeny;
          if (r.movedItems.size || r.zeny > 0) {
            totalReceipts++;
            const stacks = [...r.movedItems.values()].reduce((a, b) => a + b, 0);
            targetSummary.push({ collector: t.name, stacks, zeny: r.zeny });
            this.log('collector_receipt', { collector: t.name, zeny: r.zeny, stacks, items: [...r.movedItems.entries()].map(([itemId, qty]) => ({ itemId, qty })) });
          }
        }
      }
      this.log('collect_done', { rounds, offered, stacks: stacksMoved, zeny: zenyMoved, targets: targetSummary, ms: Date.now() - t0, hop: true });
    } finally {
      finishTrip();
    }
  }

  // ---- shopping visit (knight side, 2026-10-08) ----
  // The richest collector buys the missing gems (and refines our weapon when needed) and delivers everything.
  // We travel to its spot; when the weapon must be refined the collector first takes it off us (trade round 1),
  // then returns it refined together with the gems (trade round 2). We equip the goods and go back to farming.
  async shoppingVisit(g) {
    const t0 = Date.now();
    const shop = g.shop ?? {};
    const need = shop.need ?? {};
    const col = g.collector;
    const spot = (g.spot && g.spot.x != null) ? g.spot : { x: 880, y: 1520 };
    this.log('shop_visit_start', { jobId: shop.jobId ?? null, collector: col, need });
    try { this.c.autoEnabled(false); } catch {}
    await this.ensureMap('capital');
    if (g.channel != null) await this.rejoinCollectorRoom(g.channel).catch(() => false);
    this.c.moveToPx(spot.x, spot.y);
    await sleep(2200);
    const DEADLINE = Date.now() + 25 * 60 * 1000;
    let gaveWeapon = false;
    let rounds = 0;
    let equipped = false;
    while (Date.now() < DEADLINE && rounds < 4 && !equipped) {
      markLoop();
      // the command center clears our grant when the collector-side job fails — abort instead of waiting out the window
      if (Date.now() - t0 > 30000) {
        try { const ctlNow = readControl(); if (ctlNow && !ctlNow.grant) throw new Error('job cancelled by command center'); } catch (e) { if (String(e.message).includes('cancelled')) throw e; }
      }
      if (!this.isConnected()) {
        this.log('shop_disconnected', {});
        try { await this.reconnect(); await this.ensureMap('capital'); this.c.moveToPx(spot.x, spot.y); } catch {}
        await sleep(3000);
        continue;
      }
      const inv = this.s.invite;
      if (inv && inv.kind === 'trade' && (!inv.from || inv.from === col)) {
        this.c.trade({ action: 'accept' });
        this.log('shop_trade_accept', { from: inv.from ?? null });
        this.s.invite = null;
        const okOpen = await this.waitFor(() => !!this.s.trade, 'shop trade open', 20000).catch(() => false);
        if (!okOpen) { this.log('shop_trade_open_timeout', {}); await sleep(2000); continue; }
        rounds++;
        // handover round? (we still wear our Dawnbreaker and the collector must refine it)
        let offer = [];
        if (need.weapon?.mode === 'refine' && !gaveWeapon) {
          const eqName = String(this.char?.equipment?.['main-hand']?.name ?? this.char?.weapon ?? '');
          if (/dawnbreaker/i.test(eqName)) {
            try { this.c.send('unequip', { slot: 'main-hand' }); } catch {}
            await sleep(1500);
            const w = (this.s.inventory?.items ?? []).find((x) => /dawnbreaker/i.test(x.name ?? ''));
            if (w) { offer = [{ slot: w.slot, qty: 1 }]; this.log('shop_weapon_handover', { slot: w.slot, refine: w.refine ?? 0, unequipped: true }); }
            else this.log('shop_weapon_unequip_miss', { eq: eqName });
          } else this.log('shop_weapon_missing', { eq: eqName });
        }
        this.c.tradeOffer(offer, 0);
        await sleep(1300);
        this.c.tradeLock();
        const bothLocked = await this.waitFor(() => { const t = this.s.trade; return !!(t && t.mine?.locked && t.theirs?.locked); }, 'shop both locked', 40000).catch(() => false);
        if (!bothLocked) {
          this.log('shop_lock_timeout', { round: rounds, state: this.s.trade ?? null });
          try { this.c.tradeCancel(); } catch {}
          await sleep(2000);
          continue;
        }
        this.c.tradeConfirm();
        const done = await this.waitFor(() => { const t = this.s.trade; return !t || t.closed === true || t.done === true; }, 'shop trade done', 45000).catch(() => false);
        this.log('shop_trade_round_end', { round: rounds, done, gave: offer.length });
        this.s.trade = null;
        await sleep(1500);
        if (offer.length) gaveWeapon = true; // the collector owns our weapon — next round is the delivery
        else {
          // delivery round just completed → equip everything we were given
          await this.shopEquipGoods(need).catch((e) => this.log('shop_equip_fail', String((e && e.message) || e)));
          equipped = true;
        }
      } else {
        await sleep(2500);
      }
    }
    if (!equipped) throw new Error('shopping visit did not complete (no delivery trade)');
    this.c.moveToPx(spot.x, spot.y);
    this.log('shop_equip_done', { jobId: shop.jobId ?? null, ms: Date.now() - t0 });
    try { this.pushStatus(); } catch {}
  }

  // equip the delivered goods: best-matching gems (>=2%, highest % wins) + the best Dawnbreaker in the bag
  async shopEquipGoods(need) {
    const bag = () => (this.s.inventory?.items ?? []);
    const eq = () => (this.char?.equipment ?? {});
    const pct = (n) => { const m = String(n ?? '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? parseFloat(m[1]) : 0; };
    const REQ = ['lifesteal gem (attack)', 'lifesteal gem (skill)', 'mana gem (skill)'];
    const gemSlots = ['gem-1', 'gem-2', 'gem-3', 'gem-4'];
    for (const key of REQ) {
      const eqOk = gemSlots.some((sl) => String(eq()[sl]?.name ?? '').toLowerCase().startsWith(key) && pct(eq()[sl]?.name) >= 2);
      if (eqOk) { this.log('shop_gem_equipped', { name: key + ' already', slot: null }); continue; }
      // free a gem slot when all four are occupied by non-required gems
      if (gemSlots.every((sl) => eq()[sl])) {
        const victim = gemSlots.find((sl) => !REQ.some((k) => String(eq()[sl]?.name ?? '').toLowerCase().startsWith(k)));
        if (victim) { try { this.c.send('unequip', { slot: victim }); await sleep(1500); this.log('shop_gem_unequipped', { slot: victim }); } catch {} }
      }
      const pick = bag().filter((x) => String(x.name ?? '').toLowerCase().startsWith(key) && pct(x.name) >= 2).sort((a, b) => pct(b.name) - pct(a.name))[0];
      if (!pick) { this.log('shop_gem_absent', { key }); continue; }
      this.c.send('equip', { slot: pick.slot });
      await sleep(1700);
      this.log('shop_gem_equipped', { name: pick.name, slot: pick.slot });
    }
    const weps = bag().filter((x) => /dawnbreaker/i.test(x.name ?? '')).sort((a, b) => (b.refine ?? 0) - (a.refine ?? 0));
    const eqMain = eq()['main-hand'];
    if (weps.length && (!/dawnbreaker/i.test(String(eqMain?.name ?? '')) || (Number(eqMain?.refine) || 0) < (weps[0].refine ?? 0))) {
      this.c.send('equip', { slot: weps[0].slot });
      await sleep(1700);
      this.log('shop_weapon_equipped', { slot: weps[0].slot, refine: weps[0].refine ?? 0 });
    } else if (eqMain && /dawnbreaker/i.test(String(eqMain?.name ?? ''))) {
      this.log('shop_weapon_ok', { refine: eqMain.refine ?? 0 });
    }
  }

  // ---- collector shopping executor (2026-10-08) ----
  // open the auction house at the Auctioneer (n7). The dialog chain is probed live; an explicit market
  // option is preferred, otherwise the first option is taken.
  async shopOpenMarket() {
    if (this.s.marketOpen) return true;
    await this.ensureMap('capital');
    await this.walkToNpc(NPCS.n7);
    const d = await this.auctioneerTalk();
    const opts = d?.options ?? d?.choices ?? [];
    const opt = this.findOption(d, 'ตลาด') ?? this.findOption(d, 'ประมูล') ?? this.findOption(d, 'ซื้อ') ?? (opts.length ? this.optionEntry(opts[0], 0) : null);
    if (!opt) { this.log('shop_market_no_option', { dialog: d ?? null }); return false; }
    if (opts.length) { this.c.npcOption(opt.index); }
    const open = await this.waitFor(() => !!this.s.marketOpen, 'market open', 9000).catch(() => false);
    this.log('shop_market_open', { ok: open, option: opt.text ?? opt.index });
    return open;
  }
  // buy the cheapest immediate (non-auction) listing matching `query`; claims the delivery box afterwards
  async shopBuyFromAh(query) {
    await this.shopOpenMarket();
    const seq = this.s.marketSeq || 0;
    this.c.send('market', { op: 'search', filters: { q: query, sort: 'price_asc', page: 0 } });
    const okS = await this.waitFor(() => (this.s.marketSeq || 0) > seq, 'market results', 12000).catch(() => false);
    if (!okS) { this.log('shop_ah_search_fail', { query }); return null; }
    const now = Date.now();
    const ls = (this.s.market?.listings ?? [])
      .filter((l) => (l.auctionEndsAt ?? 0) < now && (l.price ?? Infinity) <= (this.char?.zeny ?? 0))
      .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    if (!ls.length) { this.log('shop_ah_no_listing', { query, total: this.s.market?.total ?? null }); return null; }
    const pick = ls[0];
    const seq2 = this.s.marketSeq || 0;
    this.c.send('market', { op: 'buy', listingId: pick.listingId, price: pick.price });
    const okB = await this.waitFor(() => (this.s.marketSeq || 0) > seq2, 'market buy ack', 12000).catch(() => false);
    const done = this.s.marketDone ?? {};
    this.log('shop_ah_buy', { query, listingId: pick.listingId, price: pick.price, qty: pick.qty ?? 1, ok: okB && done.ok !== false });
    if (!(okB && done.ok !== false)) return null;
    const seq3 = this.s.marketSeq || 0;
    this.c.send('market', { op: 'collect_all' });
    await this.waitFor(() => (this.s.marketSeq || 0) > seq3, 'collect_all ack', 12000).catch(() => false);
    await sleep(900);
    return { price: pick.price, qty: pick.qty ?? 1 };
  }
  // ensure the collector holds >= qty of a refine material: own bag → own storage (user rule) → n3 shop (Phracon/Rough Elunium only) → auction house
  async shopEnsureMaterial(name, qty) {
    const cnt = (nm) => (this.s.inventory?.items ?? []).filter((x) => String(x.name ?? '').startsWith(nm)).reduce((s, x) => s + (x.qty ?? 1), 0);
    if (cnt(name) >= qty) { this.log('shop_mat_ok', { name, have: cnt(name) }); return true; }
    try {
      this.s.storage = null;
      const ok = await this.openStorage({ npcKey: 'n6' }).catch(() => false);
      if (ok) {
        const stack = (this.s.storage?.items ?? []).find((it) => String(it.name ?? '').startsWith(name));
        if (stack) {
          const take = Math.min(stack.qty ?? 1, Math.max(1, qty - cnt(name)));
          const q0 = (this.s.storage?.items ?? []).filter((x) => String(x.name ?? '').startsWith(name)).reduce((s, x) => s + (x.qty ?? 1), 0);
          const i0 = cnt(name);
          this.c.storageTake(stack.slot, take);
          const okT = await this.waitFor(() => (this.s.storage?.items ?? []).filter((x) => String(x.name ?? '').startsWith(name)).reduce((s, x) => s + (x.qty ?? 1), 0) < q0 || cnt(name) > i0, 'storage take mat', 4000).catch(() => false);
          this.log('shop_ore_withdraw', { name, qty: take, ok: okT });
        } else this.log('shop_ore_no_stock', { name });
        this.c.npcClose(); await sleep(400);
        if (cnt(name) >= qty) return true;
      }
    } catch (e) { this.log('shop_ore_withdraw_fail', String((e && e.message) || e)); }
    if (/^(Phracon|Rough Elunium)$/i.test(name)) {
      try {
        await this.walkToNpc(NPCS.n3);
        this.s.dialog = null; this.s.shop = null;
        await this.talk('n3');
        await this.chooseByKeyword('ซื้อแร่ตีบวก', { timeout: 6000 });
        await this.waitFor(() => !!this.s.shop, 'ore shop', 8000).catch(() => false);
        const line = (this.s.shop?.items ?? []).find((i) => String(i.name ?? '').startsWith(name));
        const want = Math.max(1, qty - cnt(name) + 2);
        if (line && (this.char?.zeny ?? 0) >= line.price) {
          this.c.send('shop_buy', { itemId: line.itemId, qty: want });
          await sleep(1600);
          this.log('shop_ore_shopbuy', { name, qty: want, price: line.price });
        }
        this.c.npcClose(); await sleep(400);
        this.c.invSort(); await sleep(700);
        if (cnt(name) >= qty) return true;
      } catch (e) { this.log('shop_ore_shop_fail', String((e && e.message) || e)); }
    }
    for (let i = 0; i < 6 && cnt(name) < qty; i++) {
      const r = await this.shopBuyFromAh(name).catch(() => null);
      if (!r) break;
    }
    const okFin = cnt(name) >= qty;
    this.log('shop_mat_buy_done', { name, have: cnt(name), need: qty, ok: okFin });
    return okFin;
  }
  // refine the collector's Dawnbreaker to +7 — repeated until done (window-driven: material + zeny per attempt)
  async shopRefineWeaponTo7() {
    const TARGET = 7;
    let attempts = 0;
    let noProgress = 0;
    let lastCur = -1;
    for (;;) {
      await this.ensureMap('capital');
      this.s.dialog = null; this.s.refine = null;
      // walkToNpc is fire-and-forget (move + 1.2s) — n3 is a long walk from the auctioneer, so wait for the
      // walk to land and retry the talk a few times before deferring (each defer costs a 5-min retry cycle)
      let dlgOk = false;
      for (let t = 0; t < 3 && !dlgOk; t++) {
        await this.walkToNpc(NPCS.n3).catch(() => {});
        await sleep(t === 0 ? 2600 : 3800);
        dlgOk = await this.talk('n3').then(() => true).catch(() => false);
        if (!dlgOk) this.log('shop_refine_dialog_retry', { try: t + 1 });
      }
      if (!dlgOk) { this.log('shop_refine_dialog_fail', {}); throw this.deferJob('blacksmith dialog unreachable — retrying'); }
      const opt = this.findOption(this.s.dialog, 'ตีบวก');
      if (!opt) { this.log('shop_refine_no_option', { dialog: this.s.dialog ?? null }); throw this.deferJob('blacksmith refine option missing — retrying'); }
      this.c.npcOption(opt.index);
      const okW = await this.waitFor(() => !!this.s.refine, 'refine window', 9000).catch(() => false);
      if (!okW) { this.log('shop_refine_window_fail', {}); this.c.npcClose(); await sleep(400); throw this.deferJob('refine window did not open — retrying'); }
      for (let i = 0; ; i++) {
        const entry = (this.s.refine?.items ?? []).find((x) => /dawnbreaker/i.test(x.item?.name ?? ''));
        if (!entry) { this.log('shop_refine_entry_missing', { items: (this.s.refine?.items ?? []).map((x) => x.item?.name) }); this.c.npcClose(); await sleep(400); throw this.deferJob('weapon missing from the refine window — retrying'); }
        const cur = Number(entry.item?.refine) || 0;
        if (cur >= TARGET || entry.to > TARGET) { this.log('shop_refine_done', { refine: cur, nextTo: entry.to, attempts }); this.c.npcClose(); await sleep(400); this.c.invSort(); await sleep(600); return cur; }
        if (cur > lastCur) { lastCur = cur; noProgress = 0; } else noProgress++;
        if (noProgress > 30) { this.log('shop_refine_stuck', { attempts, cur }); this.c.npcClose(); await sleep(400); throw this.deferJob(`refine not progressing (${attempts} attempts at +${cur}) — retrying later`); }
        const matName = String(entry.material?.name ?? '');
        const matNeed = Math.max(1, Number(entry.material?.need ?? 1));
        if ((entry.material?.have ?? 0) < matNeed) {
          this.log('shop_refine_mat_short', { mat: matName, have: entry.material?.have ?? 0, need: matNeed });
          this.c.npcClose(); await sleep(400);
          const got = await this.shopEnsureMaterial(matName, matNeed + 2);
          if (!got) { this.log('shop_refine_material_fail', { mat: matName }); throw this.deferJob(`no supply of ${matName} — waiting for restock`); }
          break; // reopen the window with the new stock
        }
        if ((this.char?.zeny ?? 0) < (entry.zeny ?? 0)) { this.log('shop_refine_no_zeny', { zeny: this.char?.zeny ?? 0, need: entry.zeny }); this.c.npcClose(); await sleep(400); throw this.deferJob('not enough zeny for refine fees — waiting for funds'); }
        attempts++;
        const seq = this.s.refineSeq || 0;
        this.c.send('refine', { source: entry.source, blessing: false });
        this.log('shop_refine_attempt', { to: entry.to, mat: matName, have: entry.material?.have, zeny: entry.zeny, attempt: attempts });
        await this.waitFor(() => (this.s.refineSeq || 0) > seq, 'refine result', 7000).catch(() => false);
        await sleep(1700);
        if (i > 200) { this.c.npcClose(); await sleep(400); break; } // window hygiene — reopen every 200 attempts
      }
      this.c.npcClose(); await sleep(500);
    }
  }
  // collector-initiated trade round with a knight (mirrors the donor round, roles reversed).
  // tries=20 (~5.5-6 min): the knight usually rides a wing (arrives in ~1 min) but when its wing stash
  // is empty it WALKS from the farm map (3-5 min, sometimes through mobs) - the old 8-try window (~2.3 min)
  // kept deferring exactly as it arrived ("knight unreachable" loop, 2026-10-09). The knight's grant stays
  // live through this whole window and its visit waits ~25 min, so a longer wait loses nothing.
  async shopTradeOpen(name, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const seq = this.s.tradeSeq || 0;
      this.c.tradeRequest(name);
      const opened = await this.waitFor(() => (this.s.tradeSeq || 0) > seq, 'trade open', 15000).catch(() => false);
      if (opened) return true;
      this.log('shop_trade_open_timeout', { name, try: i + 1 });
      await sleep(2500);
    }
    return false;
  }
  async shopTradeRound(name, offerLines) {
    if (!(await this.shopTradeOpen(name))) return false;
    this.c.tradeOffer(offerLines, 0);
    await sleep(1300);
    this.c.tradeLock();
    const both = await this.waitFor(() => { const t = this.s.trade; return !!(t && t.mine?.locked && t.theirs?.locked); }, 'shop locked', 45000).catch(() => false);
    if (!both) { this.log('shop_lock_timeout', { name, state: this.s.trade ?? null }); try { this.c.tradeCancel(); } catch {} await sleep(1200); return false; }
    this.c.tradeConfirm();
    const done = await this.waitFor(() => { const t = this.s.trade; return !t || t.closed === true || t.done === true; }, 'shop trade done', 45000).catch(() => false);
    this.s.trade = null;
    await sleep(1200);
    return done;
  }
  // round 1 (refine jobs): the knight offers its weapon, we offer nothing
  async shopFetchWeaponFromKnight(shop) {
    const ok = await this.shopTradeRound(shop.botName, []);
    const w = (this.s.inventory?.items ?? []).find((x) => /dawnbreaker/i.test(x.name ?? ''));
    if (!ok || !w) { this.log('shop_weapon_fetch_fail', { ok, has: !!w }); return null; }
    return { slot: w.slot, refine: w.refine ?? 0 };
  }
  // round 2 (delivery): hand the required gems + the weapon over to the knight
  async shopDeliverToKnight(shop) {
    const need = shop.need ?? {};
    const gemNames = (need.gems ?? []).map((s) => s.toLowerCase());
    const bag = () => (this.s.inventory?.items ?? []);
    const lines = [];
    for (const g of gemNames) {
      const it = bag().find((x) => String(x.name ?? '').toLowerCase().startsWith(g));
      if (it) lines.push({ slot: it.slot, qty: 1 });
    }
    if (need.weapon) {
      const w = bag().filter((x) => /dawnbreaker/i.test(x.name ?? '')).sort((a, b) => (b.refine ?? 0) - (a.refine ?? 0))[0];
      if (w) lines.push({ slot: w.slot, qty: 1 });
    }
    if (!lines.length) { this.log('shop_deliver_nothing', { botName: shop.botName }); return false; }
    this.log('shop_deliver_start', { botName: shop.botName, lines: lines.length });
    return await this.shopTradeRound(shop.botName, lines.slice(0, 10));
  }
  // PRIVACY DEFAULT (user rule 2026-10-09): after every sign-in, hide gear/stats from other players.
  // The in-game settings checkbox ("ให้ผู้เล่นอื่นตรวจสอบอุปกรณ์และสเตตัสของฉันได้" OFF) sends exactly
  // `inspect_privacy {hidden:true}` (bundle: setInspectHidden(e)=>room.send('inspect_privacy',{hidden:e})).
  // Check the char state first (server exposes char.inspectHidden); send only when not already hidden.
  async ensureInspectHidden() {
    try {
      if (this.char?.inspectHidden === true) { this.log('inspect_privacy_ok', {}); return false; }
      this.c.send('inspect_privacy', { hidden: true });
      await sleep(700);
      this.log('inspect_privacy_sent', { hidden: this.char?.inspectHidden ?? null });
      return true;
    } catch (e) { this.log('inspect_privacy_fail', String((e && e.message) || e)); return false; }
  }

  // defer: a WAITING condition (market empty / not enough funds / transient hiccups) is not a failure —
  // the job goes back to the queue and retries in a few minutes until it completes (never compromise on +7)
  deferJob(reason) {
    const e = new Error(`DEFER: ${reason}`);
    e.defer = true;
    return e;
  }

  // full job: gems → weapon (fetch/buy) → refine to +7 → deliver. Logs shop_job_start / shop_job_done / shop_job_defer / shop_job_fail.
  async runShopJob(shop) {
    const need = shop.need ?? { gems: [], weapon: null };
    const t0 = Date.now();
    const jobId = shop.jobId ?? null;
    this._shopActive = true;
    const ctlSpot = readControl()?.collect?.spot ?? { x: 880, y: 1520 };
    try {
      this.log('shop_job_start', { jobId, botName: shop.botName, need });
      // phase 1 — refine jobs: take the knight's weapon first (it waits at our spot)
      if (need.weapon?.mode === 'refine') {
        const w = await this.shopFetchWeaponFromKnight(shop);
        if (!w) throw this.deferJob('weapon handover failed (knight not reachable) — retrying');
        this.log('shop_weapon_received', { refine: w.refine ?? 0 });
      }
      // phase 2 — gems (buy from the auction house unless already carried)
      for (const gem of need.gems ?? []) {
        const have = (this.s.inventory?.items ?? []).find((x) => String(x.name ?? '').startsWith(gem));
        if (have) { this.log('shop_gem_stock', { name: gem }); continue; }
        const r = await this.shopBuyFromAh(gem).catch(() => null);
        this.log('shop_gem_buy', { name: gem, price: r?.price ?? null, ok: !!r });
        if (!r) throw this.deferJob(`no auction listing for ${gem} — waiting for restock`);
      }
      // phase 3 — weapon: buy when none was handed over, then refine to +7
      if (need.weapon) {
        if (need.weapon.mode === 'buy') {
          const dbInBag = (this.s.inventory?.items ?? []).filter((x) => /dawnbreaker/i.test(x.name ?? ''));
          const bestRf = dbInBag.length ? Math.max(...dbInBag.map((x) => Number(x.refine) || 0)) : -1;
          if (dbInBag.length) this.log('shop_weapon_have', { refine: bestRf, note: bestRf >= 7 ? 'a +7 Dawnbreaker is already in the bag — reusing (leftover from an earlier job)' : 'a spare Dawnbreaker is in the bag — refining it instead of buying (leftover from an earlier job)' });
          else {
            const r = await this.shopBuyFromAh('Dawnbreaker').catch(() => null);
            this.log('shop_weapon_buy', { price: r?.price ?? null, ok: !!r });
            if (!r) throw this.deferJob('no Dawnbreaker listing on the auction house — waiting for restock');
          }
        }
        const refine = await this.shopRefineWeaponTo7();
        if (refine == null) throw this.deferJob('weapon did not reach +7 — retrying');
        this.log('shop_refine_final', { refine });
      }
      // phase 4 — deliver: back to our spot, hand everything to the knight (round 2)
      await this.ensureMap('capital');
      this.c.moveToPx(ctlSpot.x ?? 880, ctlSpot.y ?? 1520);
      await sleep(1800);
      const delivered = await this.shopDeliverToKnight(shop);
      if (!delivered) throw this.deferJob('delivery trade failed — knight unreachable; retrying');
      this.log('shop_trade_done', { jobId, botName: shop.botName });
      this.log('shop_job_done', { jobId, botName: shop.botName, ms: Date.now() - t0 });
    } catch (e) {
      if (e && e.defer) this.log('shop_job_defer', { jobId, reason: String(e.message).replace(/^DEFER:\s*/, '').slice(0, 140) });
      else this.log('shop_job_fail', { jobId, reason: String((e && e.message) || e).slice(0, 140) });
    } finally {
      this._shopActive = false;
      try { this.c.moveToPx(ctlSpot.x ?? 880, ctlSpot.y ?? 1520); } catch {}
    }
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

  // ---- NPC key resolution. Server dialog keys are 'n' + ordinal position in the map's NPC list — NOT
  // stable across content updates (2026-10-10: "Card Alchemist" was inserted before Valkyrie → every later
  // key shifted +1: Valkyrie n5→n6, Alice n6→n7, Auctioneer n7→n8, Event Lily n9→n10). Hardcoded keys made
  // every fleet warp fail as 'no-warp-menu' (bots talked to Valkyrie's class-change dialog) and walk
  // everywhere. Resolve identity at runtime: talk candidates, keep the key whose DIALOG is the NPC we want,
  // cache it for the session. Positions in NPCS are unchanged — only the talk keys shifted.
  isAliceDialog(d) {
    if (!d) return false;
    return /alice/i.test(String(d.name ?? '')) || String(d.art ?? '') === 'npc/kafra'
      || (Array.isArray(d.options) && d.options.some((o) => String(o).includes('วาร์ป')));
  }
  aliceCandidates() { return [...new Set([this._aliceKey, 'n7', 'n6', 'n8', 'n5', 'n9', 'n10'].filter(Boolean))]; }
  async aliceTalk({ walk = true } = {}) {
    if (walk) await this.walkToNpc(NPCS.n6); // Alice's position never moved ([1808,1616])
    for (const k of this.aliceCandidates()) {
      try { this.c.npcClose(); } catch {}
      this.s.dialog = null;
      const d = await this.talk(k).catch(() => null);
      if (d && this.isAliceDialog(d)) {
        if (this._aliceKey !== k) { this._aliceKey = k; this.log('alice_key', { key: k, name: d.name ?? null }); }
        return d;
      }
    }
    this.log('alice_not_found', { tried: this.aliceCandidates() });
    return null;
  }
  async auctioneerTalk() {
    for (const k of [...new Set([this._auctKey, 'n8', 'n7'].filter(Boolean))]) {
      try { this.c.npcClose(); } catch {}
      this.s.dialog = null;
      const d = await this.talk(k).catch(() => null);
      if (!d) continue;
      const market = (Array.isArray(d.options) ? d.options : []).some((o) => /ตลาด|ประมูล|ซื้อ/.test(String(o)));
      if (/auction/i.test(String(d.name ?? '')) || market || k === 'n8') {
        if (this._auctKey !== k) { this._auctKey = k; this.log('auct_key', { key: k, name: d.name ?? null }); }
        return d;
      }
    }
    this.log('auct_not_found', {});
    return null;
  }

  // Alice teleport (VERIFIED live 2026-10-07; key resolved at runtime since 2026-10-10): talk Alice → option
  // 'วาร์ป' → `warp_menu` reply carries the visited destinations + zeny costs (the world-map UI) →
  // `npc_warp {mapId}` → travel message → rejoin. ~0.2s + zeny (venom 1250z) vs the 3-map walk (~45s).
  // Falls back to walking on any failure.
  async aliceWarp(target, { alts = [] } = {}) {
    const t0 = Date.now();
    if (this.c.mapId !== 'capital') return { ok: false, reason: 'not-in-capital' };
    try { this.c.npcClose(); } catch {}
    for (let i = 0; i < 12; i++) {
      const lv = this.c.live;
      if (lv && Math.hypot((lv.x ?? 0) - NPCS.n6[0], (lv.y ?? 0) - NPCS.n6[1]) < 70) break;
      if (H.on) {
        const ang = H.rnd() * Math.PI * 2, rr = H.rnd() * 10; // stay well inside the 70px talk ring
        this.c.moveToPx(NPCS.n6[0] + Math.cos(ang) * rr, NPCS.n6[1] + Math.sin(ang) * rr);
        await sleep(hSleep(650, 0.5));
      } else {
        this.c.moveToPx(NPCS.n6[0], NPCS.n6[1]);
        await sleep(600);
      }
    }
    const d = await this.aliceTalk({ walk: false });
    if (!d) return { ok: false, reason: 'alice-not-found' };
    const opt = this.findOption(d, 'วาร์ป');
    if (!opt) { this.log('alice_probe', { options: d.options ?? null }); this.c.npcClose(); await sleep(300); return { ok: false, reason: 'no-warp-option' }; }
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
    this.trace('ensureMap:' + target);
    if (!this.isConnected()) await this.reconnect();
    if (this.isJailed() && target !== 'jail') await this.jailHold(); // JAIL POLICY: stand still — no travel out of jail
    if (this.s.death) await this.deathRecover();
    this.trace('ensureMap:rest');
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
    this.trace('ensureMap:route');
    const route = await routePath(from, target);
    // WARP-ALWAYS POLICY (user rule 2026-10-10): walking is the LAST resort — Alice warps from the capital
    // to any map the char has VISITED; unvisited targets (or waypoints she can't reach) still walk.
    // Getting to the capital is part of "warp always": ride the wing fast-lane when stocked, else walk.
    const capIdx = route.indexOf('capital');
    if (target !== 'capital' && (from === 'capital' || capIdx >= 0)) {
      if (this.char?.auto?.enabled) { this.c.autoEnabled(false); await sleep(600); }
      if (from !== 'capital') {
        const wFrom = this.c.mapId;
        let gotCap = false;
        if (this.wingEnabled()) {
          const w = await this.useButterflyWing().catch(() => ({ ok: false }));
          gotCap = !!w.ok;
          if (w.ok) this.log('travel_via', { via: 'wing', from: wFrom, to: 'capital', ms: w.ms ?? null });
        }
        if (!gotCap && this.c.mapId !== 'capital') {
          const legs = route.slice(0, capIdx + 1);
          this.log('travel_approach_capital', { from, to: target, legs });
          for (const hop of legs) await this.travelHop(hop);
        }
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
    if (target !== 'capital') {
      // route does not cross the capital — still warp-always: get to the capital (wing fast-lane, else walk
      // there), warp to the deepest visited waypoint, walk whatever remains; failures degrade to the direct
      // walk. This is the plan-switch / field-to-field case that used to walk every hop.
      let viaCap = null;
      try { viaCap = await routePath(from, 'capital'); } catch {}
      if (viaCap && viaCap.length) {
        if (this.char?.auto?.enabled) { this.c.autoEnabled(false); await sleep(600); }
        const wFrom = this.c.mapId;
        let gotCap = false;
        if (this.wingEnabled()) {
          const w = await this.useButterflyWing().catch(() => ({ ok: false }));
          gotCap = !!w.ok;
          if (w.ok) this.log('travel_via', { via: 'wing', from: wFrom, to: 'capital', ms: w.ms ?? null });
        }
        if (!gotCap && this.c.mapId !== 'capital') { for (const hop of viaCap) await this.travelHop(hop); }
        if (this.c.mapId === 'capital') {
          const back = await routePath('capital', target).catch(() => null);
          if (!back) { this.log('travel_via', { via: 'walk', from, to: target, warpFail: 'no-route-from-capital' }); return; }
          const alts = back.filter((m) => m !== target).reverse();
          const w2 = await this.aliceWarp(target, { alts }).catch((e) => ({ ok: false, reason: String((e && e.message) || e).slice(0, 90) }));
          if (w2.ok) {
            this.log('travel_via', { via: 'warp', from, to: target, landed: w2.to ?? target, cost: w2.cost ?? null, ms: Date.now() - t0 });
            if (w2.to && w2.to !== target) {
              try { const rest = await routePath(w2.to, target); for (const hop of rest) await this.travelHop(hop); }
              catch (e) { this.log('warp_waypoint_route_fail', { landed: w2.to, to: target, err: String((e && e.message) || e).slice(0, 90) }); }
            }
            return;
          }
          this.log('travel_via', { via: 'walk', from, to: target, warpFail: w2.reason ?? null });
          for (const hop of back) await this.travelHop(hop);
          return;
        }
      }
    }
    this.log('route', { from, to: target, route, warp: false });
    for (const hop of route) await this.travelHop(hop);
  }

  async travelHop(nextMap) {
    this.trace('travelHop:' + nextMap);
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
        this.trace('travelHop:rejoin');
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
      // restockQty 0 = the plan says stock none — skip the potion buy but still refresh wings + re-arm auto
      if ((this.restockQty ?? 45) > 0) await this.buyPotions(this.restockQty ?? 45).catch(() => {});
      await this.buyButterflyWings().catch(() => {});
      if (this.s.inventory) await this.setAuto(auto).catch(() => {});
    }
    this._lastFarmAuto = auto;
    const t0 = Date.now();
    let last = 0, lastStat = 0, lastSkill = 0;
    while (Date.now() - t0 < timeoutMin * 60 * 1000) {
      this.trace('farm:iter');
      await controlWait(this);
      if (this.isJailed()) { await this.jailHold(); continue; } // JAIL POLICY: hold still (user rule 2026-10-12)
      // a freshly-applied skill sequence (plan/config push) re-arms the auto config right away
      if (this._seqDirty && !this.s.death && (!map || this.c.mapId === map)) {
        this._seqDirty = false;
        try { await this.setAuto(auto); this.log('auto_cfg_sync', { seq: this._weaveSeq }); }
        catch (e) { this.log('auto_cfg_sync_fail', String((e && e.message) || e)); }
      }
      if (this.pendingGrant) {
        const g = this.pendingGrant; this.pendingGrant = null;
        this.log('collect_granted', g);
        this.trace('collect');
        await this.handleGrant(g);
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
        const everyMsE = (this.errandCfg.everyMin ?? 0) * 60000;
        const timedE = everyMsE > 0 && Date.now() - Math.max(this._lastErrandAt || 0, BOOT_AT) > everyMsE;
        if ((pctE >= ((this.errandCfg.atWeightPct ?? 70) + (H.on ? H.errandBias : 0)) || usedE >= 90 || timedE) && Date.now() - (this._lastErrandAt || 0) > (H.on ? H.errandGateMs : 90000) && Date.now() > (this._errandGateAt ?? 0)) {
          this._lastErrandAt = Date.now();
          const keep = this.keepIds();
          this.log('errand_bag_full', { weightPct: Math.round(pctE), used: usedE, timed: timedE });
          try {
            this.c.autoEnabled(false);
            await this.ensureMap('capital');
            await this.maybeTownLoiter('errand');
            await this.sellJunkExcept(keep); // whitelist stays in the bag — it travels to the collector, never to storage
            if ((this.restockQty ?? 45) > 0) await this.buyPotions(this.restockQty ?? 45).catch(() => {});
            await this.buyButterflyWings().catch(() => {});
            // storeWhitelist plans: bank the whitelist into the bot's own storage before leaving town
            if (this.storeWhitelist) { try { await this.depositKeepItems(keep); } catch (e) { this.log('keep_store_fail', String((e && e.message) || e)); } }
            this.log('errand_done', {});
            this._lastErrandAt = Date.now(); // captcha forensics: errand anchor
          } catch (e) { this.log('errand_fail', String((e && e.message) || e)); }
          // if the errand couldn't get weight back under control, give it 6 min before retrying (breaks errand storms)
          const wA = this.s.inventory; const pctA = wA ? (wA.weight / wA.weightLimit) * 100 : 0;
          this._errandGateAt = pctA >= ((this.errandCfg.atWeightPct ?? 70) + (H.on ? H.errandBias : 0)) - 5 ? Date.now() + 6 * 60 * 1000 : 0;
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
      if (this.autoChannel && Date.now() - (this._lastChanCheck || 0) > (H.on ? H.chanEveryMs : 10 * 60 * 1000)) {
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
      // A recovery in flight owns positioning — never race it with a map return.
      if (map && this.c.mapId !== map && !this.s.death && !this._deathRecoverP) {
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
      // potion monitor (2026-10-08): potions deplete fast on high-damage maps (venom/frost burn 45 in
      // ~2 min at threshold 20%) and NOTHING restocked mid-farm — every bag-empty moment was a death
      // (leveling fleet: 60-93 deaths/day each). Restock trip: town → buy → straight back → setAuto.
      if (map && !this.s.death && !this._sus && this.c.mapId === map && this.potCount() < (H.on ? H.potTripN : 12) && (this.restockQty ?? 45) > 0 && Date.now() > (this._potTripAt ?? 0)) {
        this._potTripAt = Date.now() + (H.on ? H.potGateMs : 4 * 60 * 1000); // personal re-trip gate
        this.log('pot_low_trip', { pots: this.potCount() });
        try {
          this.c.autoEnabled(false); await sleep(700);
          await this.ensureMap('capital');
          await this.buyPotions(this.restockQty ?? 45).catch(() => {});
          await this.ensureMap(map); this._mapRetryAt = 0;
          await this.setAuto(auto);
          this.log('pot_trip_done', { pots: this.potCount(), auto: this.char?.auto?.enabled ?? null });
          this._lastPotTripAt = Date.now(); // captcha forensics: restock anchor
        } catch (e) {
          this._mapRetryAt = Date.now() + 2 * 60 * 1000;
          this.log('pot_trip_fail', String((e && e.message) || e));
        }
      }
      // equipment auto-discard sweep (zeny plan): catches gear drops the pickup hook may have missed
      if (this.errandCfg?.discardEquip && Date.now() - (this._discardSweepAt ?? 0) > 30000) {
        this._discardSweepAt = Date.now();
        this.discardEquipmentDrops().catch(() => {});
      }
      if (this.s.death) {
        await this.deathRecover();
        if (map && this.c.mapId !== map) await this.ensureMap(map);
        if (map) await this.channelOnReturn(); // death respawn → walk of shame → best channel
        await this.setAuto(auto);
      } else if (ch && ch.auto?.enabled === false) {
        const w = this.s.inventory; const pct = w ? (w.weight / w.weightLimit) * 100 : 0;
        this.log('auto_off', { weightPct: Math.round(pct) });
        const everyMsA = (this.errandCfg?.everyMin ?? 0) * 60000;
        const timedA = everyMsA > 0 && Date.now() - Math.max(this._lastErrandAt || 0, BOOT_AT) > everyMsA;
        if ((pct >= ((this.errandCfg?.atWeightPct ?? 70) + (H.on ? H.errandBias : 0)) || timedA) && Date.now() > (this._errandGateAt ?? 0)) {
          // bag filling → errand (farming mode supplies its own), else bank/sell/restock, come back
          this.c.autoEnabled(false); await sleep(700);
          if (errand) {
            try { await errand(this); } catch (e) { this.log('errand_fail', String((e && e.message) || e)); }
          } else {
            await this.ensureMap('capital');
            await this.sellJunk(); // no banking — storage is off-limits for bots (policy 2026-10-06)
            if ((this.restockQty ?? 45) > 0) await this.buyPotions(this.restockQty ?? 45).catch(() => {});
            await this.buyWeightScrolls().catch(() => {});
          }
          // same gate as the main errand path — a non-draining trip must not immediately repeat
          const wA = this.s.inventory; const pctA = wA ? (wA.weight / wA.weightLimit) * 100 : 0;
          this._errandGateAt = pctA >= ((this.errandCfg?.atWeightPct ?? 70) + (H.on ? H.errandBias : 0)) - 5 ? Date.now() + 6 * 60 * 1000 : 0;
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(OUT, `run-${stamp}.jsonl`);
const QUIET = !!process.env.AETHERIA_QUIET;
let LOOP_TICK = Date.now(); // main-loop proof-of-life: marked in controlWait + every long flow's iteration
function markLoop() { LOOP_TICK = Date.now(); }
let LAST_REAL_ACTIVITY = Date.now(); // productive events refresh this — the wedged-loop watchdog reads it
const log = (evt, data) => {
  // heartbeats, ambient 'levelup' chatter AND the diagnostic 'stuck_at' marker must not refresh the
  // wedge clock (levelup defeated watchdog v1; stuck_at would defeat it the same way)
  // death churn is NOT productive activity: a wedged recovery flight used to keep the watchdog clock fresh
  // forever (bots sat 'dead' for up to 79 min) — but death_await_tick DOES keep it fresh (it is the legit
  // 5-min auto-release wait's progress signal; a wedged flight stops ticking and gets reaped)
  if (evt !== 'HEARTBEAT' && evt !== 'levelup' && evt !== 'stuck_at' && evt !== 'DEATH_WORLD' && evt !== 'death_recover' && evt !== 'death_verified_world') LAST_REAL_ACTIVITY = Date.now();
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

// Tor identity: log the exit IP BEFORE we touch the game server, so every restart proves which IP it rode.
// (The probe rides the same socks port + credentials as the bot, i.e. the same Tor circuit the login will use.)
if (hasProxy) {
  const ip = await probeExitIp();
  EXIT_IP = ip;
  log('proxy_exit', { proxy: proxyLabel, ip, phase: 'pre_login' });
  try { writeStatus({ state: 'starting', exitIp: ip }); } catch {}
}
// exit-IP backfill (2026-10-09): a cold Tor circuit can fail all 3 pre-login probe attempts (seen on
// bots 19/93 — ip:null) and the dashboard stayed blank for that bot forever. The circuit is obviously
// working once the bot is playing, so retry in the background — the log line + the next status write
// (heartbeat/pushStatus stamp EXIT_IP) deliver it to the command center either way.
if (hasProxy && !EXIT_IP) {
  (async () => {
    for (let i = 0; i < 6 && !EXIT_IP; i++) {
      await sleep(25000 + i * 15000);
      try { const ip = await probeExitIp(20000); if (ip) { EXIT_IP = ip; log('proxy_exit', { proxy: proxyLabel, ip, phase: 'backfill' }); } } catch {}
    }
  })();
}
if (process.env.AETHERIA_USER && process.env.AETHERIA_PASS) {
  // command-center mode: log in with credentials and cache a fresh token
  let res = { ok: false, status: 0 }, j = {};
  try {
    res = await apiFetch('/auth/login', {
      method: 'POST', body: { userId: process.env.AETHERIA_USER, password: process.env.AETHERIA_PASS },
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
const stateFile = path.join(OUT, 'run-state.json');
let runState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { cursor: 0, characterId: null, charName: null };
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(runState, null, 1));

const client = (() => {
  // device identity (2026-10-12 anti-bot forensics): the updated game client sends a persistent device UUID
  // in /world/enter (real client: localStorage 'aetheria.device' → crypto.randomUUID, kept forever).
  // Bots without it are trivially distinguishable from browser play. ONE stable UUID per bot, persisted
  // in its data dir so every relogin looks like the same trusted device returning.
  const file = path.join(OUT, 'device-id.json');
  let id = null;
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j && typeof j.deviceId === 'string' && j.deviceId.length >= 16) id = j.deviceId; } catch {}
  if (!id) {
    id = crypto.randomUUID();
    try { fs.writeFileSync(file, JSON.stringify({ deviceId: id, createdAt: new Date().toISOString() }, null, 1)); } catch {}
  }
  return new AetheriaClient({ token: sess.token, deviceId: id });
})();
const bot = new Bot(client, log);
if (H.on) log('human_init', { id: H_ID, jitterPx: H.jitterPx, sleepScale: +H.sleepScale.toFixed(2), viaProb: +H.viaProb.toFixed(2), chatty: +H.chatty.toFixed(2), errandBias: H.errandBias, potTripN: H.potTripN });
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
bot.charName = ch.name; // used by the GM whisper responder (echo guard + prompt context)
log('character', { id: ch.characterId, name: ch.name });

// Connect with retry-forever: a hard-killed previous session leaves the character marked
// "character already online" (ตัวละครในบัญชีนี้ออนไลน์อยู่แล้ว) — force it out with the same kick the game's
// character-select button uses, then retry fast instead of waiting for the seat to expire.
async function connectWithRetry(characterId) {
  for (let i = 1; ; i++) {
    try {
      await client.connect(characterId, {
        onQueue: (q) => {
          markLoop();
          log('queue_wait', { position: q.position ?? null, waiting: q.waiting ?? null, etaSeconds: q.etaSeconds ?? null });
        },
        abort: () => { try { return readControl()?.cmd === 'stop'; } catch { return false; } },
      });
      const ok = await client.waitJoin(12000);
      if (!ok) throw new Error('no join frame');
      client.arrived();
      await sleep(2500);
      return;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/stop requested during login queue/i.test(msg)) {
        log('stop_during_login', {});
        return;
      }
      log('connect_retry', { attempt: i, err: msg.slice(0, 200) });
      try { client.close(); } catch {}
      if (/ออนไลน์อยู่แล้ว|already online/i.test(msg)) {
        if (MODE === 'collector') {
          // collector seats yield to the USER (2026-10-08): probe passively, never kick — the explicit
          // ▶/↻ buttons in the command center do the claiming kick server-side (kickSession before spawn).
          bot.log('collector_seat_held', { attempt: i, policy: 'probe', waitSec: i <= 3 ? 10 : 30 });
          await sleep(i <= 3 ? 10000 : 30000);
        } else {
          // keep kicking until the server accepts (409 = logout in flight, 0/network = unknown) — then wait
          // for the release to land before the next connect; no blind connect churn while the seat is held.
          const k = await bot.kickUntilFree({ budgetMs: 120000 });
          await sleep(k.ok ? 2500 : 6000);
        }
      } else {
        await sleep(/429|too many/i.test(msg) ? 60000 : 8000);
      }
    }
  }
}
await connectWithRetry(ch.characterId);
log('joined', { map: client.mapId });
// privacy default: FIRST thing after sign-in — hide gear/stats from other players (user rule 2026-10-09)
await bot.ensureInspectHidden().catch(() => {});
await bot.syncMapFromRest().catch(() => {});
bot.startHeartbeat(20000);

const NPCS = { n1: [2288, 1168], n2: [880, 1520], n3: [2480, 1552], n5: [1664, 960], n6: [1808, 1616], n7: [816, 1050], n9: [2032, 1626] };

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
      // 2026-10-08: this step had NO statPlan — points banked since frost started (182+/bot stuck).
      // The guide continues here: DEX30 → AGI30 → VIT20 → STR forever (cap-aware sweep handles leftover at STR 99).
      await bot.farm({ until: (c) => c.baseLevel >= 65, map: 'frost_pass', auto: autoCfg, label: 'frost lv65', timeoutMin: 900, statPlan: { fixed: { DEX: 30, AGI: 30, VIT: 20 }, dump: 'STR' }, weave: ['bash', 'bowling-bash'] });
    } },
];

// ---------------- modes ----------------
async function runFarmingMode() {
  let cfg = null;
  for (;;) {
    await controlWait(bot);
    if (bot.isJailed()) { await bot.jailHold(); continue; } // JAIL POLICY: stand still — no travel/auto attempts
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
      await b.maybeTownLoiter('errand');
      await b.sellJunkExcept(keepIds);
      await b.buyPotions(f.restockQty ?? 45, f.potItem ?? 'Red Potion').catch(() => {});
      if (b.scrollCount() < 10) await b.buyWeightScrolls().catch(() => {}); // Bor: 10× weight-limit scrolls
      b.log('farm_errand_done', {});
      b._lastErrandAt = Date.now(); // captcha forensics: errand anchor
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
    if (bot.isJailed()) { await bot.jailHold(); continue; } // JAIL POLICY: stand still
    const ctl = applyDirectives(bot);
    const cc = ctl?.collect;
    // SHOPPING job (2026-10-08): priority over collection — run it fully, then resume the collector loop
    // (nonce-keyed so a DEFERRED job re-dispatched with the same id runs again)
    const shopJob = readControl()?.shop ?? null;
    if (shopJob && (shopJob.nonce ?? shopJob.jobId) !== bot._shopNonce) {
      if (!bot.isConnected()) { try { await bot.reconnect(); } catch {} }
      bot._shopNonce = shopJob.nonce ?? shopJob.jobId;
      await bot.runShopJob(shopJob);
      bot._colChan = null; bot._lastSpotAt = 0; // re-assert channel + spot after the shopping trip
      continue;
    }
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
    if (spot && Date.now() - (bot._lastSpotAt || 0) > 60000) { bot._lastSpotAt = Date.now(); bot.collectorSpotAssert(spot).catch(() => {}); }
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
    // wallet freshness (2026-10-08 user ask): a cleared trade means zeny just moved — push status so the
    // command center shows the post-handover balance within ~2s instead of up to a 20s heartbeat later.
    // (1.5s delay lets the server's character update carrying the new zeny land first.)
    if (bot._sawTrade && !bot.s.trade) { bot._sawTrade = false; setTimeout(() => { try { bot.pushStatus(); } catch {} }, 1500); }
    if (bot.s.trade) bot._sawTrade = true;
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
    await bot.handleGrant(g);
  }
}
for (let i = runState.cursor; i < PLAN.length && i < UPTO; i++) {
  const step = PLAN[i];
  bot.stepId = step.id;
  log('STEP_START', { step: step.id });
  let attempt = 0;
  for (;;) {
    await controlWait(bot);
    if (bot.isJailed()) { await bot.jailHold(); continue; } // JAIL POLICY: stand still
    await bot.consumeGrant(); // plan-mode donors: never sit on a grant across a step/retry boundary
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
