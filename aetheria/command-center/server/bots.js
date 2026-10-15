// Bot manager: spawns/kills one runner process per bot, drives play/pause/stop via control files,
// polls per-bot status.json for the UI, and tails per-bot JSONL logs into the live event stream.
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { cardItemIds } from './wiki.js';
import { EarningsTracker } from './earnings.js';
import { ensurePort as torEnsurePort } from './tor.js';
import { registerAccount, createCharacterFor, addCharacter } from './accounts.js';
import { accountUsername, strongPassword } from './namegen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORESNAP_FILE = path.join(here, '..', 'data', 'collector-storage.json');
const KILLLOG_FILE = path.join(here, '..', 'data', 'kill-log.json');
const EARN_FILE = path.join(here, '..', 'data', 'earnings.json');
const COLLEDGER_FILE = path.join(here, '..', 'data', 'collector-ledger.json');
// multi-collector defaults (user-set 2026-10-08): zeny cap deliberately non-round, 2,997 total per item
const DEF_ZENY_CAP = 297431629;
const DEF_ITEM_CAP = 4995;
const ZENY_RESERVE = 50000; // donors keep this much (matches the runner's collect reserve)
// Tor binary: env-overridable so the same checkout runs on the Debian server (AETHERIA_TOR_BIN=/usr/bin/tor)
const TOR_BIN = process.env.AETHERIA_TOR_BIN || 'C:\\Users\\schwi\\Desktop\\Tor Browser\\Browser\\TorBrowser\\Tor\\tor.exe';
// Tor canary probe (watchdog): raw SOCKS5 CONNECT (no auth) through a SocksPort — success proves the daemon
// can build/attach circuits right now. Never touches game traffic; completes in milliseconds to seconds.
function socks5Canary(port, host = 'api.ipify.org', destPort = 80, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false, stage = 0, buf = Buffer.alloc(0);
    const s = net.connect({ host: '127.0.0.1', port });
    const fin = (ok) => { if (done) return; done = true; clearTimeout(t); try { s.destroy(); } catch {} resolve(ok); };
    const t = setTimeout(() => fin(false), timeoutMs);
    s.on('error', () => fin(false));
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fin(false);
        stage = 1; buf = Buffer.alloc(0);
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([destPort >> 8, destPort & 255])]));
      } else if (stage === 1) {
        if (buf.length < 2) return;
        fin(buf[1] === 0);
      }
    });
  });
}
const TESTBOT = path.resolve(here, '..', '..', 'testbot');
const RUNNER = path.join(TESTBOT, 'src', 'runner.js');
const BOTS_DIR = path.join(store.dir, 'bots');
const UPTO = process.env.CC_UPTO || '34';

// ---- shopping (gear-up) constants (2026-10-08) ----
// required knight gems — canonical purchase names + matchers (>=2% rule, mirrors the dashboard dots)
const SHOP_GEM_REQS = [
  ['Lifesteal Gem (Attack)', /lifesteal gem \(attack\)/i],
  ['Lifesteal Gem (Skill)', /lifesteal gem \(skill\)/i],
  ['Mana Gem (Skill)', /mana gem \(skill\)/i],
];
// a job is "live" (collector occupied, collection paused) while in any of these phases
const SHOP_LIVE = new Set(['sent', 'shopping', 'refining', 'delivering']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readControl = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')); } catch { return null; } };

// tiny digest of the last meaningful log event — powers the per-bot activity badge in the UI
const EVT_BRIEF = (evt, d) => {
  try {
    switch (evt) {
      case 'route': return { to: d.to };
      case 'travel_msg': return { to: d.mapId };
      case 'traveled': return { to: d.now };
      case 'proxy_exit': return { ip: d.ip };
      case 'shop': return { name: d.name };
      case 'buy_potions': return { have: d.have };
      case 'auto_sold': return { n: d.count };
      case 'npc_dialog': return { name: d.name };
      case 'reconnect_attempt_fail': return { attempt: d.attempt };
      case 'queue_wait': return { pos: d.position, wait: d.waiting, eta: d.etaSeconds };
      case 'reconnect_done': case 'death_recovered': return { map: d.map };
      case 'kill': return { mob: d.m };
      case 'farm_status': return { base: d.baseLevel, dead: !!d.dead, auto: d.autoEnabled };
      case 'STEP_START': case 'STEP_DONE': return { step: d.step };
      case 'levelup': return { level: d.level };
      default: return {};
    }
  } catch { return {}; }
};

// local-day key for the kill log (the dashboard machine is the fleet's own clock)
const dayKey = (iso) => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

export class BotManager {
  constructor({ onUpdate = () => {}, onEvent = () => {} } = {}) {
    this.onUpdate = onUpdate;
    this.onEvent = onEvent;
    this.runtime = new Map(); // botId -> { proc, dir, state, status, tail* , pendingStart }
    this.tradeQueue = []; // botIds waiting to be granted a collector
    // PARALLEL collect (2026-10-08): one active donor per collector. Key = collector charName, value = { botId, grantAt }.
    this.activeTrades = new Map();
    // restore persisted queue state — a server restart must not lose waiting turns or double-grant active bots
    try {
      const qs = store.getSettings?.()?.collectQueue;
      if (qs && typeof qs === 'object') {
        this.tradeQueue = (qs.queue ?? []).map((x) => parseInt(x, 10)).filter((id) => { const b = store.findBot(id); return !!b && b.mode !== 'collector'; });
        for (const h of (qs.holds ?? [])) { const b = store.findBot(parseInt(h, 10)); if (b && b.mode !== 'collector') this.rt(b.id).collectHold = true; }
        const acts = Array.isArray(qs.actives) ? qs.actives : (qs.active != null ? [{ botId: qs.active, grantAt: qs.grantAt, collector: null }] : []);
        for (const e of acts) {
          const b = store.findBot(parseInt(e?.botId, 10));
          if (!b || b.mode === 'collector') continue;
          const rt = this.rt(b.id);
          rt.grantAt = e?.grantAt ?? Date.now();
          rt.grantPending = true; // the runner still holds its control.json grant — don't grant this donor again
          let colName = e?.collector ?? null;
          if (!colName) { try { const ctl = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); colName = ctl?.grant?.collector ?? ctl?.grant?.targets?.[0]?.name ?? null; } catch {} }
          this.activeTrades.set(colName ?? ('donor-' + b.id), { botId: b.id, grantAt: rt.grantAt });
        }
      }
    } catch {}
    // SHOPPING (gear-up) queue: jobs { id, botId, botName, collector, status, note, need, at, grantAt }.
    // Assigned to the richest collector at queue time; that collector pauses collection while it has shop work.
    this.shopJobs = [];
    this._shopId = 1;
    try {
      const sq = store.getSettings?.()?.shopQueue;
      if (sq && Array.isArray(sq.jobs)) {
        this.shopJobs = sq.jobs.filter((j) => j && j.botId != null && (j.status === 'queued' || SHOP_LIVE.has(j.status) || j.status === 'failed' || j.status === 'timeout'));
    // failed/timeout rows are the user's actionable "needs attention" list — keep the most recent 20 across restarts
    {
      const bad = this.shopJobs.filter((j) => j.status === 'failed' || j.status === 'timeout');
      if (bad.length > 20) {
        const drop = new Set(bad.slice(0, bad.length - 20));
        this.shopJobs = this.shopJobs.filter((j) => !drop.has(j));
      }
    }
        this._shopId = Math.max(1, parseInt(sq.nextId ?? 1, 10) || 1, ...this.shopJobs.map((j) => (parseInt(j.id, 10) || 0) + 1));
      }
    } catch {}
    // collector's last-seen storage snapshot — persisted so the dashboard can show where items sit even
    // after the collector restarts (donors never open storage; the collector is the only storer)
    this.storeSnap = null; // { at, zeny, slots, items: { itemId: qty } }
    try { const raw = JSON.parse(fs.readFileSync(STORESNAP_FILE, 'utf8')); if (raw && typeof raw === 'object' && raw.items) this.storeSnap = raw; } catch {}
    // per-collector holdings ledger: held = baseline (last storage snapshot) + transfers since that snapshot.
    // Receipts come from the donor runners ('collector_receipt'), so caps never rely on stale storage reads.
    this.colLedger = {}; // collectorBotId -> { baselineAt, baseZeny, baseItems:{}, transfers:[{at,zeny,items:{}}] }
    try { const raw = JSON.parse(fs.readFileSync(COLLEDGER_FILE, 'utf8')); if (raw && typeof raw === 'object') this.colLedger = raw; } catch {}
    this._ledgerSaveAt = 0;
    this._colCreating = false; // auto-create-collector in-flight guard
    this._colTryAt = 0; // throttle between auto-create attempts
    this.fleet = { regular: new Map(), collectorBag: new Map() };
    // persistent kill log — rows: "<day>|<botId>|<monster>" -> count; tails: per-bot "how far its newest
    // JSONL was processed" { file, off, lastTs } so a server restart resumes without re-counting (ts-dedup
    // is the second guard). Cleared only via the dashboard's 🗑 button.
    this.killLog = { v: 1, rows: {}, tails: {} };
    try { const raw = JSON.parse(fs.readFileSync(KILLLOG_FILE, 'utf8')); if (raw && typeof raw === 'object' && raw.rows) this.killLog = raw; } catch {}
    this._killDirty = false;
    // per-bot earnings tracker (2026-10-10): incremental JSONL scan -> per-local-hour estimated zeny
    // (loot drops × NPC sellPrice) + realized zeny steps. Powers the dashboard ≈z/h column + drawer graph.
    this.earnings = new EarningsTracker({ botsDir: BOTS_DIR, dataFile: EARN_FILE });
    setTimeout(() => { this.earnings.sweep().catch(() => {}); }, 6000);
    setInterval(() => { this.earnings.sweep().catch(() => {}); }, 45_000);
    // collector cycle (2026-10-10, user rule): collectors REST OFFLINE — they are brought online
    // (staggered, rotated, NEVER two per channel) only while a collect wave actually needs them, and
    // logged out again once it drains. Sneaky = shortest possible online window, spread channels.
    // settings.collectorCycle = { enabled, graceMin, staggerSec, maxOnline, activeIds } (lazy default).
    this.colCycle = { started: new Map(), idleSince: 0, lastStartAt: 0, rot: 0 };
    try { const cp = store.getSettings()?.collectorCycle; if (Array.isArray(cp?.activeIds)) for (const id of cp.activeIds) { const n = parseInt(id, 10); if (Number.isFinite(n)) this.colCycle.started.set(n, Date.now()); } } catch {}
    setTimeout(() => { try { this.assignCollectorChannels(); } catch {} }, 3500);
    setInterval(() => { try { this.collectorCycleTick(); } catch {} }, 15_000);
    // rehydrate runtime entries for every known bot — without this, a command-center restart leaves the
    // map empty and NOTHING polls status.json / tails logs until the next manual play/stop per bot
    for (const bot of store.data.bots) this.rt(bot.id);
    // restored shop jobs: the knight still holds its control.json grant — don't grant it a collect meanwhile
    for (const j of this.shopJobs) {
      if (SHOP_LIVE.has(j.status)) { const rt = this.runtime.get(j.botId); if (rt) rt.grantPending = true; }
    }
    this._poller = setInterval(() => this.poll(), 2000);
    this.startTorWatchdog();
  }

  // ---- Tor health watchdog (2026-10-09): the recurring fleet-wide jams (all proxies time out while direct
  // internet is fine) cost 30+ min because nothing noticed. Probe both daemons every ~2.5 min; on 3
  // consecutive failed probes restart that daemon (kill its listener pid, respawn with its torrc) — recovery
  // in ~2-4 min; exit IPs for that half re-roll (accepted: a jam means downtime anyway). Rate limit 10 min.
  // Health is exposed in /api/state as `tor` for the dashboard.
  startTorWatchdog() {
    if (this._torWd) return;
    this.torHealth = this.torHealth ?? { daemons: { 1: { ok: null, fails: 0, at: 0, lastRestart: 0 }, 2: { ok: null, fails: 0, at: 0, lastRestart: 0 } } };
    setTimeout(() => this.torProbeAll().catch(() => {}), 20000);
    this._torWd = setInterval(() => this.torProbeAll().catch(() => {}), 150000);
    try { this._torWd.unref?.(); } catch {}
  }
  async torProbeAll() {
    const ports = { 1: 19001, 2: 20002 };
    for (const d of [1, 2]) {
      const ok = await socks5Canary(ports[d]).catch((e) => { console.log(`[tor-watchdog] daemon ${d}: probe threw — ${e?.message || e}`); return false; });
      const h = this.torHealth.daemons[d];
      h.at = Date.now();
      if (ok) {
        if (h.ok !== true) console.log(`[tor-watchdog] daemon ${d}: circuit probe OK`);
        h.ok = true; h.fails = 0;
      } else {
        h.ok = false; h.fails++;
        console.log(`[tor-watchdog] daemon ${d}: circuit probe FAILED (${h.fails} in a row)`);
        if (h.fails >= 3 && Date.now() - (h.lastRestart ?? 0) > 10 * 60 * 1000) {
          h.lastRestart = Date.now();
          console.log(`[tor-watchdog] daemon ${d}: jammed (3 failed probes) — restarting tor`);
          this._restartTorDaemon(d);
        }
      }
    }
  }
  _restartTorDaemon(d) {
    const port = d === 1 ? 19001 : 20002;
    let pid = null;
    try {
      if (process.platform === 'win32') {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 15000, windowsHide: true });
        for (const line of out.split('\n')) {
          if (line.includes(':' + port + ' ') && line.includes('LISTENING')) { const parts = line.trim().split(/\s+/); pid = parseInt(parts[parts.length - 1], 10) || null; break; }
        }
      } else {
        // Debian: find the listener PID of the jammed daemon's first SOCKS port via iproute2
        const out = execSync(`ss -ltnpH 'sport = :${port}'`, { encoding: 'utf8', timeout: 15000 });
        const m = out.match(/pid=(\d+)/);
        if (m) pid = parseInt(m[1], 10) || null;
      }
    } catch {}
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    setTimeout(() => {
      const torrc = path.join(store.dir, d === 1 ? 'tor' : 'tor2', 'torrc');
      try { const p = spawn(TOR_BIN, ['-f', torrc], { detached: true, stdio: 'ignore', windowsHide: true }); p.unref(); console.log(`[tor-watchdog] daemon ${d} respawned (old pid ${pid ?? 'n/a'})`); }
      catch (e) { console.error(`[tor-watchdog] daemon ${d}: respawn failed — ${e?.message || e}`); }
    }, 2500);
  }

  // persist the trade queue so restarts are seamless (runners keep their control.json grants either way)
  _saveQueue() {
    try {
      const s = store.getSettings?.();
      if (!s) return;
      s.collectQueue = { queue: [...this.tradeQueue], active: this.activeView()[0]?.botId ?? null, actives: this.activeView(), holds: this.heldList(), at: Date.now() };
      store.save?.();
    } catch {}
  }

  // persist the shopping queue across restarts (runners keep their control.json grants either way)
  _saveShop() {
    try {
      const s = store.getSettings?.();
      if (!s) return;
      s.shopQueue = { jobs: this.shopJobs.slice(0, 60), nextId: this._shopId, at: Date.now() };
      store.save?.();
    } catch {}
  }

  // near-real-time fleet item totals: farming bots contribute their BAGS only (they never touch storage by
  // policy); the collector contributes bag + its last-seen storage snapshot (persisted, with its timestamp).
  _ledgerTick() {
    const regular = new Map();
    const collectorBag = new Map();
    let snapSrc = null, snapAt = 0, snapBotId = null;
    for (const [botId, rt] of this.runtime) {
      const s = rt.status; if (!s) continue;
      const isCol = store.findBot(botId)?.mode === 'collector';
      const tgt = isCol ? collectorBag : regular;
      for (const it of (s.inventory ?? [])) if (it.itemId != null) tgt.set(it.itemId, (tgt.get(it.itemId) ?? 0) + (it.qty ?? 1));
      // a collector storage snapshot only counts when it carries a read-timestamp (fresh window read)
      if (isCol && Array.isArray(s.storage?.items) && (s.storageAt ?? 0) > snapAt) { snapSrc = s.storage; snapAt = s.storageAt; snapBotId = botId; }
    }
    this.fleet = { regular, collectorBag };
    if (snapSrc && snapAt > (this.storeSnap?.at ?? 0)) {
      const items = {};
      for (const it of snapSrc.items) if (it.itemId != null) items[it.itemId] = (items[it.itemId] ?? 0) + (it.qty ?? 1);
      this.storeSnap = { at: snapAt, botId: snapBotId, zeny: snapSrc.zeny ?? null, slots: snapSrc.slots ?? null, items };
      try { fs.writeFileSync(STORESNAP_FILE, JSON.stringify(this.storeSnap)); } catch {}
      // the snapshot is ground truth for that collector's storage — rebase its holdings ledger on it
      if (snapBotId != null) { try { this.snapshotBaseline(snapBotId, snapAt, snapSrc.zeny ?? 0, items); } catch {} }
    }
  }
  fleetView() {
    // storage snapshots are tied to the collector that read them — a snapshot left behind by a retired
    // collector must never leak into the totals (that's how the old account's items lingered after decom)
    const colBot = store.data.bots.find((b) => b.mode === 'collector' && !b.retired);
    const fresh = !!this.storeSnap && !!colBot && this.storeSnap.botId === colBot.id;
    return {
      updatedAt: Date.now(),
      regular: Object.fromEntries(this.fleet?.regular ?? []),
      collectorBag: Object.fromEntries(this.fleet?.collectorBag ?? []),
      collectorStorage: fresh ? this.storeSnap : null,
      collectorStorageStale: !fresh && !!this.storeSnap,
    };
  }
  // command-center ⟳ — ask the collector to re-open its storage and report a fresh snapshot
  requestStorageRefresh(botId) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    cur.refreshStorage = Date.now();
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify(cur));
    this.onUpdate();
    return { ok: true, requestedAt: cur.refreshStorage };
  }

  // 🔓 force-online — kick the character's previous (stale) session server-side, exactly like the game's
  // character-select "kick" button (POST /characters/:id/kick). Use when a bot is stuck at
  // "already online"; the stale seat frees instantly and the next login/restart succeeds.
  async kickSession(botId) {
    const bot = store.findBot(botId);
    if (!bot) return { ok: false, error: 'bot not found' };
    const c = store.findCharacter(bot.characterId);
    const a = c ? store.findAccount(c.accountId) : null;
    if (!c || !a) return { ok: false, error: 'character/account missing' };
    const dir = this.dirOf(botId);
    // the CC store id is internal — the GAME-side character id lives on the store character record
    // (set for CC-created characters) or in the runner's run-state.json (imported accounts)
    let gameCharId = c.characterId ?? null;
    if (!gameCharId) {
      try { const rs = JSON.parse(fs.readFileSync(path.join(dir, 'run-state.json'), 'utf8')); if (rs?.characterId) gameCharId = rs.characterId; } catch {}
    }
    if (!gameCharId) return { ok: false, error: 'game characterId unknown — start the bot once so it can sync, then kick' };
    let token = null;
    try { token = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).token; } catch {}
    const call = async (tok) => {
      const res = await fetch(`https://www.aetheria-online.in.th/characters/${gameCharId}/kick`, {
        method: 'POST', headers: { Authorization: `Bearer ${tok}` },
      });
      let j = null; try { j = await res.json(); } catch {}
      return { status: res.status, ok: res.ok, err: (j && (j.error ?? j.err)) || null };
    };
    try {
      let r = token ? await call(token) : { status: 401, ok: false, err: 'no session token' };
      if (r.status === 401 && a.userId && a.password) {
        // stale/absent token → fresh login with the stored account, persist it, retry once
        const lr = await fetch('https://www.aetheria-online.in.th/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: a.userId, password: a.password }),
        });
        const lj = await lr.json().catch(() => ({}));
        if (lr.ok && lj.token) {
          token = lj.token;
          try { fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ token, createdAt: new Date().toISOString() })); } catch {}
          r = await call(token);
        } else {
          return { ok: false, status: lr.status, error: (lj && (lj.error ?? lj.err)) || 'login failed' };
        }
      }
      return { ok: r.ok, status: r.status, error: r.err ?? undefined };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // ---- kill log (persistent; wiped only via the dashboard) ----
  _saveKills() {
    try { fs.writeFileSync(KILLLOG_FILE, JSON.stringify(this.killLog)); this._killSavedAt = Date.now(); this._killDirty = false; } catch {}
  }
  killView() { return { rows: this.killLog.rows, at: this._killSavedAt ?? null }; }
  clearKills() {
    this.killLog.rows = {}; // tails stay — they are how we avoid re-counting already-processed files
    this._saveKills();
    return { ok: true, clearedAt: Date.now() };
  }

  // ---- store helpers ----
  ensureBot(characterId) {
    let bot = store.data.bots.find((b) => b.characterId === characterId);
    if (!bot) {
      bot = { id: store.nextId('bot'), characterId, mode: 'leveling', state: 'stopped', createdAt: Date.now(), updatedAt: Date.now() };
      store.data.bots.push(bot);
      store.save();
    }
    // every bot owns a Tor circuit: allocate its SocksPort the moment the bot row exists
    // (register/import from the Accounts tab → sync enrolls bots → ports are configured here)
    try { torEnsurePort(bot.id); } catch {}
    return bot;
  }

  dirOf(botId) { return path.join(BOTS_DIR, String(botId)); }

  // liveness of the pid the runner wrote at boot — authoritative even for processes the CC did not spawn
  // (detached runners survive CC restarts; without this check a new start() would spawn a duplicate)
  _pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } }
  runningPid(botId) {
    try {
      const pid = parseInt(fs.readFileSync(path.join(this.rt(botId).dir, 'runner.pid'), 'utf8'), 10);
      return Number.isFinite(pid) && this._pidAlive(pid) ? pid : null;
    } catch { return null; }
  }
  // hard-verify a bot's process is dead before allowing a respawn (kill handle → SIGKILL by pid → re-check)
  async _ensureDead(botId) {
    const rt = this.runtime.get(botId); if (!rt) return;
    const p = rt.proc;
    if (p && p.exitCode === null && p.signalCode === null) {
      try { p.kill('SIGKILL'); } catch {}
      const t0 = Date.now();
      while (Date.now() - t0 < 6000 && p.exitCode === null && p.signalCode === null) await sleep(200);
    }
    const pid = this.runningPid(botId);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} await sleep(800); }
    rt.proc = null;
    rt.stopping = false;
  }

  rt(botId) {
    if (!this.runtime.has(botId)) {
      const dir = this.dirOf(botId);
      fs.mkdirSync(dir, { recursive: true });
      this.runtime.set(botId, { dir, state: 'stopped', status: null, tailFile: null, tailOffset: 0, tailCarry: '' });
    }
    return this.runtime.get(botId);
  }

  control(botId, cmd, extra = {}) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, cmd, ...extra }));
  }

  // Push runtime config (auto-combat, weave, channel, collect, farm) to a bot via control.json.
  applySettings(botId, cfg) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    const rev = (cur.rev ?? 0) + 1;
    // "keep all cards" toggle: when on, every card item id rides with the whitelist into control.json — the
    // runner's keep machinery then protects/banks/trades cards exactly like whitelist items. keepRaw preserves
    // the user's explicit list so toggling off restores it (the expanded list must never leak back into raw).
    const cards = cfg.cards !== undefined ? !!cfg.cards : !!cur.cards;
    const rawKeep = cfg.keep !== undefined ? cfg.keep : (cur.keepRaw !== undefined ? cur.keepRaw : (cur.keep ?? []));
    const keep = cards ? [...new Set([...rawKeep, ...cardItemIds()])] : rawKeep;
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, ...cfg, cards, keep, keepRaw: rawKeep, cmd: cur.cmd === 'stop' ? 'run' : (cur.cmd ?? 'run'), rev }));
    const bot = store.findBot(botId);
    if (bot) { bot.cfg = { ...(bot.cfg ?? {}), ...cfg }; store.save(); }
    rt.cfg = { ...(rt.cfg ?? {}), ...cfg };
    this.onUpdate();
    return { ok: true, rev };
  }
  grantCollect(botId, grant) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    const rev = (cur.rev ?? 0) + 1;
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, grant, rev, cmd: cur.cmd === 'stop' ? 'run' : (cur.cmd ?? 'run') }));
    rt.grantAt = Date.now();
    this.onUpdate();
    return rev; // shop dispatch tracks this rev: no directives_applied ack in time = deaf runner -> restart it
  }
  clearGrant(botId) {
    const rt = this.rt(botId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    if (!cur.grant) return;
    const { grant, ...rest } = cur;
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...rest, rev: (cur.rev ?? 0) + 1 }));
    this.onUpdate();
  }
  enqueueCollect(botId) {
    const bot = store.findBot(botId);
    if (!bot || bot.mode === 'collector') return { ok: false, error: 'not a collectible bot' };
    if (this.shopJobs.some((j) => j.botId === botId && (j.status === 'queued' || SHOP_LIVE.has(j.status)))) return { ok: false, error: 'bot is queued for gear-up — collect after the shopping turn' };
    const rt = this.rt(botId);
    // offline bots can't collect — each one granted a slot would stall the queue until the 10-min grant timeout
    if (rt.state !== 'running' && rt.state !== 'starting') return { ok: false, error: `bot is ${rt.state} — not queued (online bots only)` };
    rt.collectHold = false; // explicitly queuing releases a skip-hold
    if (!this.tradeQueue.includes(botId) && !this.isActive(botId)) this.tradeQueue.push(botId);
    this._saveQueue();
    this.onUpdate();
    return { ok: true, queue: [...this.tradeQueue], actives: this.activeView() };
  }

  // ✕ — remove a waiting bot from this round; the hold keeps it out of auto-queueing until its want-cycle resets or it is queued again
  dequeueCollect(botId, { hold = true } = {}) {
    if (this.isActive(botId)) return { ok: false, error: 'bot is trading right now — it finishes on its own (auto-skip after 10 min)' };
    const i = this.tradeQueue.indexOf(botId);
    if (i === -1) return { ok: false, error: 'not in the queue' };
    this.tradeQueue.splice(i, 1);
    if (hold) this.rt(botId).collectHold = true;
    this._saveQueue();
    this.onUpdate();
    return { ok: true, queue: [...this.tradeQueue], actives: this.activeView(), held: this.heldList() };
  }

  // ⏹ — empty the waiting queue (the active bot keeps trading); every removed bot is held out of auto-queueing
  clearWaiting() {
    const n = this.tradeQueue.length;
    for (const id of this.tradeQueue) this.rt(id).collectHold = true;
    this.tradeQueue = [];
    this._saveQueue();
    this.onUpdate();
    return { ok: true, removed: n, actives: this.activeView(), held: this.heldList() };
  }

  // ↺ — release held bots (one if id given): they auto-queue again if they still want to hand over
  releaseCollect(id = null) {
    const ids = id != null ? [parseInt(id, 10)] : [...this.runtime.keys()];
    const released = [];
    for (const bId of ids) {
      const rt = this.runtime.get(bId);
      if (!rt || !rt.collectHold) continue;
      rt.collectHold = false;
      released.push(bId);
      const st = rt.status;
      if (st?.wantCollect && !this.isActive(bId) && !this.tradeQueue.includes(bId) && !rt.grantPending) this.tradeQueue.push(bId);
    }
    if (released.length) { this._saveQueue(); this.onUpdate(); }
    return { ok: true, released, queue: [...this.tradeQueue], actives: this.activeView(), held: this.heldList() };
  }

  heldList() { const out = []; for (const [bId, rt] of this.runtime) if (rt.collectHold) out.push(bId); return out; }
  // parallel trades: is this donor busy with any collector? which donors are active right now?
  isActive(botId) { for (const a of this.activeTrades.values()) if (a.botId === botId) return true; return false; }
  activeView() { return [...this.activeTrades.entries()].map(([collector, a]) => ({ collector, botId: a.botId, grantAt: a.grantAt })); }

  // ---- shopping (gear-up) queue (2026-10-08) ----
  // What does this knight still need? null = complete / not a knight / no equipment data yet.
  shopNeedOf(botOrId) {
    const bot = typeof botOrId === 'object' ? botOrId : store.findBot(botOrId);
    if (!bot) return null;
    const st = this.runtime.get(bot.id)?.status;
    const eq = Array.isArray(st?.equipment) ? st.equipment : null;
    if (!eq) return null;
    if (!/knight/i.test(String(st?.classId ?? ''))) return null;
    const pct = (n) => { const m = String(n ?? '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? parseFloat(m[1]) : 0; };
    const gems = eq.filter((e) => /^gem-\d/.test(String(e.slot ?? '')));
    const missing = [];
    for (const [label, re] of SHOP_GEM_REQS) {
      if (!gems.some((g) => { const nm = String(g.name ?? ''); return re.test(nm) && pct(nm) >= 2; })) missing.push(label);
    }
    const main = eq.find((e) => e.slot === 'main-hand') ?? null;
    let weapon = null;
    if (main && /dawnbreaker/i.test(String(main.name ?? ''))) {
      if ((Number(main.refine) || 0) < 7) weapon = { mode: 'refine', current: Number(main.refine) || 0 };
    } else weapon = { mode: 'buy' };
    if (!missing.length && !weapon) return null;
    return { gems: missing, weapon };
  }
  // the collector with the most zeny in its wallet (user rule: jobs queue under the richest one)
  shopRichest() {
    let best = null; let bestZ = -1;
    for (const c of this.collectors()) {
      const bot = this.collectorBotFor(c);
      const z = this.runtime.get(bot?.id)?.status?.zeny ?? 0;
      if (z > bestZ) { bestZ = z; best = c; }
    }
    return best;
  }
  // does this collector have shopping work (waiting or live)? → collection pauses for it
  // (parked jobs with a future retryAt don't count — the collector resumes collecting while they wait)
  shopBusyFor(charName) {
    const now = Date.now();
    return this.shopJobs.some((j) => j.collector === charName && (j.status === 'queued' || SHOP_LIVE.has(j.status)) && !(j.retryAt > now));
  }
  queueShop(ids) {
    const want = [...new Set((ids ?? []).map((x) => parseInt(x, 10)))].filter((x) => Number.isFinite(x));
    const col = this.shopRichest();
    if (!col) return { ok: false, error: 'no collectors in the pool' };
    let queued = 0; let skipped = 0;
    for (const id of want) {
      const bot = store.findBot(id);
      if (!bot || bot.mode === 'collector' || bot.retired) { skipped++; continue; }
      if (this.shopJobs.some((j) => j.botId === id && (j.status === 'queued' || SHOP_LIVE.has(j.status)))) { skipped++; continue; }
      const need = this.shopNeedOf(bot);
      if (!need) { skipped++; continue; } // already complete / not a knight / no equipment data
      const rt = this.runtime.get(id);
      if (!rt || (rt.state !== 'running' && rt.state !== 'starting')) { skipped++; continue; } // offline knights can't receive gear
      const ch = store.findCharacter(bot.characterId);
      const nm = ch?.name ?? bot.name ?? ('#' + id); // trade requests are BY CHARACTER NAME — never the id
      this.shopJobs.push({ id: this._shopId++, botId: id, botName: nm, collector: col.charName, status: 'queued', note: '', need, at: Date.now() });
      this.tradeQueue = this.tradeQueue.filter((x) => x !== id); // shopping wins over a waiting collect turn
      queued++;
    }
    this._saveShop(); this._saveQueue(); this.onUpdate();
    return { ok: true, queued, skipped, collector: col.charName };
  }
  dequeueShop(jobId) {
    const j = this.shopJobs.find((x) => x.id === jobId);
    if (!j) return { ok: false, error: 'job not found' };
    if (SHOP_LIVE.has(j.status)) return { ok: false, error: 'job already started — let it finish' };
    this.shopJobs = this.shopJobs.filter((x) => x.id !== jobId);
    this._saveShop(); this.onUpdate();
    return { ok: true };
  }
  clearShopWaiting() {
    const n = this.shopJobs.filter((j) => j.status === 'queued').length;
    this.shopJobs = this.shopJobs.filter((j) => j.status !== 'queued');
    this._saveShop(); this.onUpdate();
    return { ok: true, removed: n };
  }
  // force-drop a job (stuck/crashed workers): releases the knight, clears the collector's job slot, marks it failed
  dropShop(jobId) {
    const j = this.shopJobs.find((x) => x.id === jobId);
    if (!j) return { ok: false, error: 'job not found' };
    if (SHOP_LIVE.has(j.status)) {
      try { this.clearGrant(j.botId); } catch {}
      const rt = this.runtime.get(j.botId); if (rt) rt.grantPending = false;
      const cbot = this.collectorBotFor(this.collectors().find((c) => c.charName === j.collector));
      if (cbot) { try { this.clearShopCtl(cbot.id); } catch {} }
    }
    this.shopJobs = this.shopJobs.filter((x) => x.id !== jobId);
    this._saveShop(); this.onUpdate();
    return { ok: true };
  }
  // transient shop failures AUTO-RETRY with backoff (user rule 2026-10-09): disconnects / trade timeouts /
  // channel hiccups are usually gone by the next attempt — only after maxAttempts the job stays failed
  // (manual ↻ retry re-arms it with fresh attempts). Parked jobs don't block the collector (shopBusyFor +
  // the dispatch loop both honor retryAt), so it keeps collecting while the job waits out its backoff.
  retryShop(j, reason, { maxAttempts = 3, baseMin = 5 } = {}) {
    j.attempts = (j.attempts ?? 0) + 1;
    const tail = String(reason ?? 'failure').slice(0, 80);
    if (j.attempts < maxAttempts) {
      j.status = 'queued';
      j.retryAt = Date.now() + baseMin * 60000 * j.attempts; // fail #1 → +5 min, fail #2 → +10 min
      j.note = `retry ${j.attempts}/${maxAttempts - 1} in ~${baseMin * j.attempts} min — ${tail}`;
      console.log(`[shop] job ${j.id}: ${j.botName} — auto-retry ${j.attempts}/${maxAttempts - 1} (~${baseMin * j.attempts} min) after: ${tail}`);
      this._saveShop(); this.onUpdate();
      return { retry: true, attempts: j.attempts };
    }
    j.status = 'failed';
    j.note = `failed (${j.attempts} tries) — ${tail}`;
    console.log(`[shop] job ${j.id}: ${j.botName} — failed permanently after ${j.attempts} attempt(s): ${tail}`);
    this._saveShop(); this.onUpdate();
    return { retry: false, attempts: j.attempts };
  }
  // manual ↻ retry: reset a failed/timeout job (or ALL of them when called without an id) and re-queue it
  retryShopJob(jobId, { all = false } = {}) {
    let n = 0;
    for (const j of this.shopJobs) {
      const retryable = j.status === 'failed' || j.status === 'timeout';
      if (all) { if (!retryable) continue; }
      else { if (j.id !== jobId) continue; if (!retryable) return { ok: false, error: 'job is not in a retryable state' }; }
      j.attempts = 0;
      j.status = 'queued';
      j.retryAt = 0;
      j.note = 'manual retry — waiting for the collector';
      n++;
    }
    if (!n) return { ok: false, error: 'no retryable job(s)' };
    this._saveShop(); this.onUpdate();
    console.log(`[shop] ${n} job(s) re-queued for a manual retry`);
    return { ok: true, retried: n };
  }
  // job instructions for the collector's runner (control.json `shop` field; cleared when the job ends)
  setShopCtl(collectorBotId, shop) {
    const rt = this.rt(collectorBotId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, shop, rev: (cur.rev ?? 0) + 1 }));
  }
  clearShopCtl(collectorBotId) {
    const rt = this.rt(collectorBotId);
    let cur = {}; try { cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8')); } catch {}
    if (cur.shop == null) return;
    fs.writeFileSync(path.join(rt.dir, 'control.json'), JSON.stringify({ ...cur, shop: null, rev: (cur.rev ?? 0) + 1 }));
  }
  pollShop() {
    if (!this.shopJobs.length) return;
    let dirty = false;
    // completion / timeout sweep — the knight writes status.shopDone after it finished equipping
    for (const j of this.shopJobs) {
      if (!SHOP_LIVE.has(j.status)) continue;
      const rt = this.runtime.get(j.botId);
      const doneAt = rt?.status?.shopDone?.at ?? 0;
      const stuck = Date.now() - (j.grantAt ?? 0) > 30 * 60 * 1000;
      if ((doneAt && doneAt >= (j.grantAt ?? 0)) || stuck) {
        const failed = rt?.status?.shopDone?.ok === false;
        const outcome = failed ? 'failed' : (stuck && !doneAt ? 'timeout' : 'done');
        try { this.clearGrant(j.botId); } catch {}
        const cbot = this.collectorBotFor(this.collectors().find((c) => c.charName === j.collector));
        if (cbot) { try { this.clearShopCtl(cbot.id); } catch {} }
        if (rt) rt.grantPending = false;
        if (outcome === 'done') {
          // completed jobs leave the page entirely (user request) — the lane only shows work that still needs attention
          this.shopJobs = this.shopJobs.filter((x) => x !== j);
          console.log(`[shop] job ${j.id}: ${j.botName} — done ✓ (removed from the list)`);
        } else {
          // failed / 30-min timeout — auto-retry with backoff before giving up (user rule 2026-10-09)
          const reason = (failed && rt?.status?.shopDone?.error) ? String(rt.status.shopDone.error).slice(0, 90) : (stuck && !doneAt ? 'no completion after 30 min' : outcome);
          this.retryShop(j, reason);
        }
        dirty = true;
      }
    }
    // unresponsive-knight watchdog (2026-10-09): after a dispatch a healthy runner applies the grant's
    // control.json revision within seconds (directives_applied) and starts the visit. A runner whose main
    // loop is parked never acks - the collector then burns 8 trade attempts and defers, forever ("knight
    // unreachable" loop; the knights themselves stood around dying because their loop was deaf). Detect the
    // missing ack and restart the knight (rate-limited; dead knights skipped - their own recovery owns them).
    for (const j of this.shopJobs) {
      if (!SHOP_LIVE.has(j.status)) continue;
      if (!j.needRev || !j.grantAt || Date.now() - j.grantAt < 5 * 60 * 1000) continue;
      const rt = this.runtime.get(j.botId);
      if (!rt || (rt.state !== 'running' && rt.state !== 'starting')) continue;
      const w = rt.status?.world;
      if (!w || (w.ageSec ?? 999) > 150) continue; // no fresh world snapshot (booting / login queue) — skip
      if (w.dead) continue; // dead knights are handled elsewhere — their own recovery owns them
      if ((rt.lastDirectiveRev ?? -1) >= j.needRev) continue; // it applied the grant - not deaf
      if (Date.now() < (rt.shopBounceAt ?? 0)) continue; // rate limit: at most one auto-bounce / 10 min
      rt.shopBounceAt = Date.now() + 10 * 60 * 1000;
      j.note = 'knight unresponsive - restarting it';
      console.log(`[shop] job ${j.id}: ${j.botName} never applied the grant (rev ${j.needRev}) - restarting the knight`);
      this.restartBot(j.botId).catch((e) => console.error(`[shop] job ${j.id}: knight restart failed - ${e?.message || e}`));
      dirty = true;
    }
    // dispatch — one live job per collector; jobs were assigned at queue time.
    // A knight that can't take the job right now (offline / DEAD / mid-collect) must never hold up the lane:
    // its job keeps a 'waiting' note and is re-checked every tick, while the next dispatchable job goes through.
    for (const c of this.collectors()) {
      if (this.shopJobs.some((j) => j.collector === c.charName && SHOP_LIVE.has(j.status))) continue;
      if (!this.collectorLiveFor(c)) continue;
      let j = null;
      for (const cand of this.shopJobs) {
        if (cand.collector !== c.charName || cand.status !== 'queued') continue;
        if (cand.retryAt && cand.retryAt > Date.now()) continue; // parked (waiting for restock / funds)
        const crt = this.runtime.get(cand.botId);
        if (!crt || (crt.state !== 'running' && crt.state !== 'starting')) { if (cand.note !== 'knight offline — waiting') { cand.note = 'knight offline — waiting'; dirty = true; } continue; }
        if (crt.status?.world?.dead) { if (cand.note !== 'knight is dead — waiting for respawn') { cand.note = 'knight is dead — waiting for respawn'; dirty = true; } continue; }
        if (this.isActive(cand.botId)) { if (cand.note !== 'knight is collecting — waiting') { cand.note = 'knight is collecting — waiting'; dirty = true; } continue; }
        j = cand;
        break;
      }
      if (!j) continue;
      const rt = this.runtime.get(j.botId);
      const cbot = this.collectorBotFor(c);
      if (!cbot) continue;
      rt.grantPending = true;
      j.status = 'sent'; j.grantAt = Date.now(); j.note = ''; j.retryAt = null;
      j.needRev = this.grantCollect(j.botId, { shop: { jobId: j.id, need: j.need }, collector: c.charName, channel: c.channel ?? 1, spot: c.spot ?? { x: 880, y: 1520 } });
      this.setShopCtl(cbot.id, { jobId: j.id, nonce: Date.now(), botName: j.botName, need: j.need, at: Date.now() });
      console.log(`[shop] job ${j.id}: ${j.botName} → ${c.charName} (gems: ${j.need.gems.join(', ') || '—'}${j.need.weapon ? ' · weapon ' + j.need.weapon.mode : ''})`);
      dirty = true;
    }
    if (dirty) { this._saveShop(); this.onUpdate(); }
  }
  // runner events (shop_*) update the job's displayed phase + note
  applyShopEvent(botId, evt) {
    const d = evt.data ?? {};
    let job = d.jobId != null ? this.shopJobs.find((j) => j.id === d.jobId) : null;
    if (!job) job = this.shopJobs.find((j) => j.botId === botId && SHOP_LIVE.has(j.status));
    if (!job) job = this.shopJobs.find((j) => SHOP_LIVE.has(j.status) && this.collectorBotFor(this.collectors().find((c) => c.charName === j.collector))?.id === botId);
    if (!job || !SHOP_LIVE.has(job.status)) return;
    // the knight ACKED the grant and started its trip (fast-retry signal: after a defer it is usually
    // already near/at the capital, so re-dispatching quickly converges instead of restarting from scratch)
    if (evt.evt === 'shop_visit_start' && job.botId === botId) job.knightAckAt = Date.now();
    const label = {
      shop_job_start: 'checking the knight / buying',
      shop_gem_buy: d.name ? `bought ${d.name}` : 'gem bought',
      shop_weapon_buy: 'bought a Dawnbreaker',
      shop_ore_buy: d.name ? `bought ${d.name} ×${d.qty ?? '?'}` : 'ores bought',
      shop_ore_withdraw: d.name ? `withdrew ${d.name} ×${d.qty ?? '?'}` : 'ores withdrawn',
      shop_refine_attempt: d.to != null ? `refining → +${d.to}` : 'refining',
      shop_refine_done: d.refine != null ? `refined +${d.refine}` : 'refine done',
      shop_trade_done: 'traded to the knight — equipping',
      shop_equip_done: 'knight equipped ✓',
      shop_job_done: 'done — releasing',
      shop_job_fail: d.reason ? `failed: ${String(d.reason).slice(0, 90)}` : 'failed',
    }[evt.evt];
    if (label) job.note = label;
    // "waiting" cases (empty market / not enough funds / transient hiccups): park the job with an auto-retry —
    // back to 'queued' (parked jobs don't block the collector: it resumes collecting so funds + market refill),
    // the knight is released immediately, dispatch re-picks the job after the retry window.
    if (evt.evt === 'shop_job_defer') {
      try { this.clearGrant(job.botId); } catch {}
      const rt2 = this.runtime.get(job.botId); if (rt2) rt2.grantPending = false;
      const cbot2 = this.collectorBotFor(this.collectors().find((c) => c.charName === job.collector));
      if (cbot2) { try { this.clearShopCtl(cbot2.id); } catch {} }
      job.status = 'queued';
      // knight demonstrably started its trip this cycle (ack >= this grant) → quick re-dispatch (~90s):
      // it is usually near the capital by now, so the next delivery attempt lands fast instead of missing
      // by a margin every 5 minutes (the "kept dying / knight unreachable" ping-pong, 2026-10-09)
      const acked = job.knightAckAt && job.knightAckAt >= (job.grantAt ?? 0);
      job.retryAt = Date.now() + (acked ? 90 * 1000 : 5 * 60 * 1000);
      job.note = `waiting — ${String(d.reason ?? 'retrying').slice(0, 90)}`;
      console.log(`[shop] job ${job.id}: ${job.botName} deferred — ${d.reason ?? ''}${acked ? ' (knight was en route — fast retry)' : ''}`);
      this._saveShop(); this.onUpdate();
      return;
    }
    // collector-side failure: release the knight + the collector's job slot, then AUTO-RETRY with backoff —
    // disconnects / trade timeouts / channel hiccups are transient (user rule 2026-10-09); after the max
    // attempts the job stays failed (manual ↻ retry stays available in the Shopping tab).
    if (evt.evt === 'shop_job_fail') {
      try { this.clearGrant(job.botId); } catch {}
      const rt2 = this.runtime.get(job.botId); if (rt2) rt2.grantPending = false;
      const cbot2 = this.collectorBotFor(this.collectors().find((c) => c.charName === job.collector));
      if (cbot2) { try { this.clearShopCtl(cbot2.id); } catch {} }
      this.retryShop(job, String(d.reason ?? 'collector reported failure'));
      return;
    }
    if (evt.evt === 'shop_job_start') job.status = 'shopping';
    else if (evt.evt === 'shop_refine_attempt' || evt.evt === 'shop_refine_done') job.status = 'refining';
    else if (evt.evt === 'shop_trade_done') job.status = 'delivering';
    this._saveShop();
  }
  shopView() {
    return {
      jobs: this.shopJobs.map((j) => ({ id: j.id, botId: j.botId, botName: j.botName, collector: j.collector, status: j.status, note: j.note ?? '', need: j.need ?? null, at: j.at ?? null, grantAt: j.grantAt ?? null, attempts: j.attempts ?? 0 })),
    };
  }

  // ⇪ Queue ALL — enqueue every bot that has something to hand over (bag or own storage + zeny over reserve).
  // This is the fleet-wide "perform the collection" trigger; parallel grants drain it immediately.
  queueAllEligible() {
    const ids = this.eligibleCollectBots({ minStacks: 1, minZeny: 15000 })
      .filter((id) => !this.shopJobs.some((j) => j.botId === id && (j.status === 'queued' || SHOP_LIVE.has(j.status)))); // gear-up jobs own these knights first
    for (const id of ids) { this.rt(id).collectHold = false; this.tradeQueue.push(id); }
    this._saveQueue();
    this.onUpdate();
    console.log(`[collectors] queue-all: ${ids.length} bot(s) queued for parallel collection`);
    return { ok: true, queued: ids.length, queue: [...this.tradeQueue] };
  }

  // ---- multi-collector pool (2026-10-08) ----
  collectors() { const s = store.getSettings(); return Array.isArray(s.collectors) ? s.collectors : []; }
  collectorBotFor(col) {
    if (!col?.charName) return null;
    const ch = store.data.characters.find((c) => c.name === col.charName);
    return ch ? (store.data.bots.find((b) => b.characterId === ch.id && !b.retired) ?? null) : null;
  }
  // ONE collector is usable ONLY when its runner is alive AND actually in the game: process state alone
  // lied after 2026-10-08 (a user-held seat leaves the runner stuck reconnecting, still "running" → donors
  // were granted futile trips). Status freshness + game map + the runner's own `connected` flag close that.
  collectorLiveFor(col) {
    const bot = this.collectorBotFor(col);
    const rt = bot ? this.runtime.get(bot.id) : null;
    if (!rt || (rt.state !== 'running' && rt.state !== 'starting')) return false;
    const st = rt.status;
    if (!st) return false;
    if (Date.now() - (st.ts ?? 0) > 90000) return false; // heartbeats are ~20s; stale = dead/starting
    if (!st.map) return false;                            // pre-join boot — no game session yet
    if (st.connected === false) return false;             // runner says its socket is down (seat held / probing)
    return true;
  }

  // ---- collector cycle: on-demand collection windows (2026-10-10, user rule) ----
  _colCycleCfg() {
    const s = store.getSettings();
    if (!s.collectorCycle || typeof s.collectorCycle !== 'object') {
      s.collectorCycle = { enabled: true, graceMin: 3, staggerSec: 35, maxOnline: 12, activeIds: [] };
      try { store.save(); } catch {}
    }
    return s.collectorCycle;
  }
  _colCyclePersist() {
    try { this._colCycleCfg().activeIds = [...this.colCycle.started.keys()]; store.save(); } catch {}
  }
  _collectorOnlineState(col) {
    const b = this.collectorBotFor(col);
    const rt = b ? this.runtime.get(b.id) : null;
    return rt && (rt.state === 'running' || rt.state === 'starting' || rt.state === 'queued') ? rt : null;
  }
  // one collector per channel (user rule): next free channel from the 2,5,8,11,… spread sequence
  _freeCollectorChannel(exceptId = null) {
    const used = new Set(this.collectors().filter((c) => exceptId == null || c.id !== exceptId).map((c) => c.channel ?? 1));
    for (let ch = 2; ch < 200; ch += 3) if (!used.has(ch)) return ch;
    for (let ch = 2; ch < 500; ch++) if (!used.has(ch)) return ch;
    return 2;
  }
  // boot migration + repair: whenever two collectors share a channel, re-spread the whole pool
  assignCollectorChannels() {
    const cols = this.collectors();
    if (!cols.length) return { ok: true, changed: 0 };
    if (new Set(cols.map((c) => c.channel ?? 1)).size === cols.length) return { ok: true, changed: 0 };
    let changed = 0;
    let i = 0;
    for (const c of cols) {
      i++;
      const next = i * 3 - 1; // 2,5,8,11,…
      if (c.channel !== next) {
        c.channel = next;
        const bot = this.collectorBotFor(c);
        if (bot) this.applySettings(bot.id, { collect: { enabled: true, channel: next, spot: c.spot ?? { x: 880, y: 1520 } } });
        changed++;
        console.log(`[colcycle] ${c.charName}: channel → ${next} (one collector per channel)`);
      }
    }
    if (changed) { this._syncLegacyCollector(); try { store.save(); } catch {} this.onUpdate(); }
    return { ok: true, changed };
  }
  collectorCycleTick() {
    const cfg = this._colCycleCfg();
    if (cfg.enabled === false) return;
    const now = Date.now();
    const waiting = this.tradeQueue.length;
    const active = this.activeTrades.size;
    const demand = waiting + active;
    if (demand > 0) {
      this.colCycle.idleSince = 0;
      const cols = this.collectors().filter((c) => { const b = this.collectorBotFor(c); return b && !b.retired; });
      if (!cols.length) return;
      const online = cols.filter((c) => this._collectorOnlineState(c));
      const want = Math.max(1, Math.min(Math.max(1, cfg.maxOnline ?? 12), cols.length, Math.ceil(demand / 6)));
      if (online.length >= want) return;
      const staggerMs = Math.max(10, cfg.staggerSec ?? 35) * 1000 * (0.6 + Math.random() * 0.8); // jittered — not a herd
      if (now - (this.colCycle.lastStartAt ?? 0) < staggerMs) return;
      const offline = cols.filter((c) => !this._collectorOnlineState(c));
      if (!offline.length) return;
      this.colCycle.rot = ((this.colCycle.rot ?? 0) + 1) % offline.length; // rotate who comes up first
      const pick = offline[this.colCycle.rot] ?? offline[0];
      // never two collectors on one channel: if a LIVE collector already sits on the pick's channel, wait
      const clash = cols.find((c) => c !== pick && (c.channel ?? 1) === (pick.channel ?? 1) && this.collectorLiveFor(c));
      if (clash) return;
      // ONE-IN-TRANSIT rule (user policy 2026-10-10): every collector logs into the default channel first and
      // then switches to its own — normally seconds, but under server lag they loiter there. Never launch the
      // next one while a cycle-started collector is still off its assigned channel (unknown channel counts as
      // in-transit), so two never share the default channel at the same time.
      for (const id of this.colCycle.started.keys()) {
        const c = cols.find((x) => (this.collectorBotFor(x) || {}).id === id);
        if (!c || !this._collectorOnlineState(c)) continue; // offline/stopped — fine
        const chNow = this.runtime.get(id)?.status?.channel ?? null;
        if (chNow == null || (c.channel ?? 1) !== chNow) return; // still in transit — wait for it to land
      }
      const bot = this.collectorBotFor(pick);
      if (!bot) return;
      this.colCycle.lastStartAt = now;
      this.colCycle.started.set(bot.id, now);
      this._colCyclePersist();
      console.log(`[colcycle] collect wave (${waiting} waiting / ${active} trading) — bringing ${pick.charName} online on ch${pick.channel}`);
      this.start(bot.id, { skipAdopt: true }).catch(() => {});
      return;
    }
    // no demand: wind down the collectors THIS cycle brought online, after the grace period
    if (this.colCycle.started.size) {
      if (!this.colCycle.idleSince) { this.colCycle.idleSince = now; return; }
      if (now - this.colCycle.idleSince < Math.max(1, cfg.graceMin ?? 3) * 60000) return;
      for (const id of [...this.colCycle.started.keys()]) {
        const rt = this.runtime.get(id);
        if (rt && (rt.state === 'running' || rt.state === 'starting' || rt.state === 'queued')) {
          console.log(`[colcycle] wave drained — logging out collector #${id}`);
          this.stop(id);
          break; // sneaky: one logout per tick (~15s apart), not a synchronized mass exit
        }
        if (!rt || rt.state === 'stopped' || rt.state === 'stopping') this.colCycle.started.delete(id);
      }
      this._colCyclePersist();
    }
  }
  // keep settings.collector (legacy single) mirrored to collectors[0] — older UI bits + scripts read it
  _syncLegacyCollector() {
    const s = store.getSettings();
    const c0 = this.collectors()[0];
    s.collector = c0 ? { charName: c0.charName, channel: c0.channel ?? 1, spot: c0.spot ?? { x: 880, y: 1520 } } : null;
  }
  _saveLedger(force = false) {
    if (!force && Date.now() - this._ledgerSaveAt < 2000) return;
    this._ledgerSaveAt = Date.now();
    try { fs.writeFileSync(COLLEDGER_FILE, JSON.stringify(this.colLedger)); } catch {}
  }
  ledgerFor(collectorBotId) {
    let L = this.colLedger[collectorBotId];
    if (!L) { L = this.colLedger[collectorBotId] = { baselineAt: 0, baseZeny: 0, baseItems: {}, transfers: [] }; }
    return L;
  }
  // what a collector holds right now (best knowledge): storage snapshot baseline + confirmed receipts since.
  // ZENY = storage zeny at the last snapshot + the LIVE wallet. Receipts must NOT be re-added for zeny —
  // their money already landed in that wallet, and adding both double-counted every post-snapshot handover
  // (caught 2026-10-08: UI showed 299.7M for a collector actually holding 156.2M). Receipts are kept for
  // ITEMS only (bag stacks not yet absorbed by a storage snapshot). Manual withdrawals simply show up in
  // the wallet — the ledger stays consistent because zeny never flows through the items baseline.
  heldFor(col) {
    const bot = this.collectorBotFor(col);
    if (!bot) return null;
    const L = this.ledgerFor(bot.id);
    const held = { zeny: L.baseZeny ?? 0, items: { ...(L.baseItems ?? {}) }, transfers: L.transfers?.length ?? 0 };
    held.zeny += this.runtime.get(bot.id)?.status?.zeny ?? 0;
    for (const t of (L.transfers ?? [])) {
      for (const [id, q] of Object.entries(t.items ?? {})) held.items[id] = (held.items[id] ?? 0) + q;
    }
    return held;
  }
  // donor runner confirmed a trade round batch with one collector: {collector, zeny, items:[{itemId,qty}]}
  applyReceipt(d) {
    if (!d?.collector) return;
    const col = this.collectors().find((c) => c.charName === d.collector);
    const bot = this.collectorBotFor(col);
    if (!bot) return;
    const items = {};
    for (const it of (Array.isArray(d.items) ? d.items : [])) { const id = parseInt(it.itemId, 10); const q = parseInt(it.qty, 10) || 0; if (Number.isFinite(id) && q > 0) items[id] = (items[id] ?? 0) + q; }
    const zeny = Math.max(0, parseInt(d.zeny, 10) || 0);
    if (!zeny && !Object.keys(items).length) return;
    const L = this.ledgerFor(bot.id);
    L.transfers.push({ at: Date.now(), zeny, items });
    if (L.transfers.length > 800) L.transfers = L.transfers.slice(-800);
    this._saveLedger(true);
  }
  // a fresh storage snapshot for THIS collector absorbs everything up to its read-time into the baseline
  snapshotBaseline(collectorBotId, snapAt, zeny, items) {
    const L = this.ledgerFor(collectorBotId);
    L.baselineAt = snapAt;
    L.baseZeny = zeny ?? 0;
    L.baseItems = { ...(items ?? {}) };
    L.transfers = (L.transfers ?? []).filter((t) => (t.at ?? 0) > snapAt);
    this._saveLedger(true);
  }
  // split one donor's handover across the collector pool: each collector takes up to its remaining capacity,
  // the remainder flows to the next; anything left after the last collector triggers auto-creation.
  buildCollectPlan(donorBotId, { only = null, autoCreate = true } = {}) {
    const st = this.runtime.get(donorBotId)?.status;
    if (!st) return { targets: [], leftover: null, empty: false };
    const bot = store.findBot(donorBotId);
    const keepIds = new Set([...(bot?.cfg?.keep ?? []), ...(bot?.cfg?.cards ? [...cardItemIds()] : [])].map(Number));
    const bag = new Map();
    for (const it of (st.inventory ?? [])) {
      const id = parseInt(it.itemId, 10);
      if (!Number.isFinite(id) || id === 90311) continue; // butterfly wings never travel
      if (keepIds.size && !keepIds.has(id)) continue;
      if (!keepIds.size) continue;
      bag.set(id, (bag.get(id) ?? 0) + (it.qty ?? 1));
    }
    // STORAGE COUNTS TOO (2026-10-09 — enchant-rune gap): storeWhitelist plans bank keep items in the bot's
    // own storage between collects and the runner pulls them back out at trip start — the grant allowances
    // MUST include them, or the pulled items are filtered out of the offers and never leave the bot.
    for (const it of (st.storage?.items ?? [])) {
      const id = parseInt(it.itemId, 10);
      if (!Number.isFinite(id) || id === 90311) continue;
      if (keepIds.size && !keepIds.has(id)) continue;
      if (!keepIds.size) continue;
      bag.set(id, (bag.get(id) ?? 0) + (it.qty ?? 1));
    }
    const zenyKnown = Number.isFinite(st.zeny);
    let zenyLeft = zenyKnown ? Math.max(0, st.zeny - ZENY_RESERVE) : 0;
    // only call a donor EMPTY when we positively know it has nothing: no keep items (bag + storage) and a
    // KNOWN broke wallet — a fresh session with no zeny snapshot yet must not be dropped from the queue.
    const empty = bag.size === 0 && zenyKnown && st.zeny < ZENY_RESERVE + 500;
    const targets = [];
    for (const col of this.collectors()) {
      if (only && !only.has(col.charName)) continue; // parallel grants: only collectors that are free right now
      if (!this.collectorLiveFor(col)) continue; // stopped/missing collectors are skipped (or created when none)
      const held = this.heldFor(col);
      if (!held) continue;
      const cb = this.collectorBotFor(col);
      const remZ = Math.max(0, (col.zenyCap ?? DEF_ZENY_CAP) - held.zeny);
      const acceptZeny = Math.min(remZ, zenyLeft);
      const acceptItems = {};
      for (const [id, qty] of bag) {
        const rem = Math.max(0, (col.itemCapPerItem ?? DEF_ITEM_CAP) - (held.items[id] ?? 0));
        const take = Math.min(rem, qty);
        if (take > 0) acceptItems[id] = take;
      }
      const anyItems = Object.keys(acceptItems).length > 0;
      if (acceptZeny > 0 || anyItems) {
        targets.push({ name: col.charName, channel: col.channel ?? 1, spot: col.spot ?? { x: 880, y: 1520 }, acceptZeny, acceptItems, collectorBotId: cb?.id ?? null });
        zenyLeft -= acceptZeny;
        for (const [id, take] of Object.entries(acceptItems)) { bag.set(+id, bag.get(+id) - take); if (bag.get(+id) <= 0) bag.delete(+id); }
      }
      if (zenyLeft < 500 && !bag.size) break;
    }
    const leftover = (zenyLeft >= 500 || bag.size > 0) ? { zeny: zenyLeft, items: Object.fromEntries(bag) } : null;
    // anything still in the bag or wallet after every collector = capacity exhausted → create a new collector
    // (skipped for the parallel grant path, which distinguishes "busy collectors" from "capacity exhausted")
    if (leftover && autoCreate) this.ensureCollectorCapacity('all collectors full').catch(() => {});
    return { targets, leftover, empty };
  }
  // auto-create a brand-new collector account when the pool is out of capacity: register → character →
  // enroll as mode=collector → park it next to the primaries (its own Tor circuit comes automatically)
  async ensureCollectorCapacity(why = 'full') {
    if (this._colCreating) return { ok: false, busy: true };
    if (Date.now() < this._colTryAt) return { ok: false, throttled: true };
    // ANTI-RUNAWAY (2026-10-09): during Tor jams the whole pool looks dead → every capacity check concluded
    // "no capacity" and ANOTHER collector was created (8 total; 209/210/211 appeared within an hour).
    // Never auto-create while: one was created in the last 30 min, the Tor watchdog sees a jammed daemon,
    // or ≥25% of the running fleet has stale heartbeats (a network-wide event — not a capacity problem).
    if (Date.now() - (this._colCreatedAt ?? store.data?.collectorCreatedAt ?? 0) < 30 * 60 * 1000) {
      console.log(`[collectors] auto-create skipped (${why}) — 30 min cooldown since the last creation`);
      return { ok: false, throttled: true };
    }
    const torBad = this.torHealth && [1, 2].some((d) => this.torHealth.daemons[d]?.ok === false);
    if (torBad) {
      console.log(`[collectors] auto-create skipped (${why}) — Tor unhealthy (capacity checks are unreliable during jams)`);
      return { ok: false, throttled: true };
    }
    {
      let running = 0, stale = 0;
      const now = Date.now();
      for (const [, rt] of this.runtime) {
        if (rt.state !== 'running') continue;
        running++;
        if (now - (rt.status?.ts ?? 0) > 180000) stale++;
      }
      if (running > 5 && stale / running >= 0.25) {
        console.log(`[collectors] auto-create skipped (${why}) — ${stale}/${running} of the fleet stale (network event in progress)`);
        return { ok: false, throttled: true };
      }
    }
    this._colCreating = true;
    this._colTryAt = Date.now() + 90000;
    this._colCreatedAt = Date.now();
    // persist the stamp so a CC restart cannot reset the cooldown window (RoyalDove incident 2026-10-09:
    // the 20:33 restart dropped the in-memory stamp from ZestyIbis' 20:17 creation, and the next
    // healthy capacity check created collector #9 at 20:44)
    try { store.data.collectorCreatedAt = this._colCreatedAt; store.save(); } catch {}
    try {
      console.log(`[collectors] ${why} — auto-creating a new collector account…`);
      const reg = await registerAccount({ userId: accountUsername(), password: strongPassword() });
      const account = { id: store.nextId('account'), userId: reg.userId, password: reg.password, type: 'registered', createdAt: Date.now() };
      store.data.accounts.push(account);
      store.save();
      const { name } = await createCharacterFor(account, { token: reg.token });
      const ch = addCharacter(account, { name, included: true });
      const bot = this.ensureBot(ch.id);
      bot.mode = 'collector';
      bot.updatedAt = Date.now();
      const primary = this.collectors()[0];
      const spot = { x: (primary?.spot?.x ?? 880) + 40 * this.collectors().length, y: primary?.spot?.y ?? 1520 };
      // one collector per channel (user rule 2026-10-10): never copy the primary's channel
      const channel = this._freeCollectorChannel();
      const row = { id: store.nextId('collector'), charName: name, channel, spot, zenyCap: DEF_ZENY_CAP, itemCapPerItem: DEF_ITEM_CAP, createdAt: Date.now(), auto: true };
      this.collectors().push(row);
      this._syncLegacyCollector();
      store.save();
      this.applySettings(bot.id, { collect: { enabled: true, channel, spot } });
      // cycle-tracked (2026-10-10): an auto-created collector exists only for collection capacity — the
      // cycle wind-down must log it out when the wave drains, like any other collector it brought online
      this.colCycle.started.set(bot.id, Date.now());
      this._colCyclePersist();
      await this.start(bot.id);
      console.log(`[collectors] created collector #${row.id} "${name}" (bot ${bot.id}) → walking to ${spot.x},${spot.y} ch${channel}`);
      this.onUpdate();
      return { ok: true, botId: bot.id, charName: name, collectorId: row.id };
    } catch (e) {
      console.log('[collectors] auto-create failed:', String((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      this._colCreating = false;
    }
  }

  // ---- lifecycle ----
  async start(botId, { delayMs = 0, skipAdopt = false, kick = false } = {}) {
    const bot = store.findBot(botId);
    const rt = this.rt(botId);
    // explicit user start/restart of a COLLECTOR = "take the seat back" (2026-10-08 user policy:
    // auto-recovery only ever probes, never kicks — the user plays collector accounts by hand sometimes).
    // Only kick when the seat can't already be ours: skip if the runner is healthy + connected right now.
    if (kick && bot?.mode === 'collector') {
      const st = rt.status;
      const healthy = !!(rt.proc && rt.proc.exitCode === null && st && Date.now() - (st.ts ?? 0) < 90000 && st.map && st.connected !== false);
      if (!healthy) {
        const k = await this.kickSession(botId).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        console.log(`[collectors] explicit start of bot ${botId} — seat kick ${k?.ok ? 'accepted' : `failed (${k?.status ?? k?.error ?? '?'})`}`);
      }
    }
    // intent marker: every start() call means "this bot should be running" — persisted so the orphan
    // sweep can recover handle-less (adopted) runners that die while no process handle is watching
    if (bot && bot.wantRun !== true) { bot.wantRun = true; bot.updatedAt = Date.now(); try { store.save(); } catch {} }
    if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) return; // already up (signal-killed procs keep exitCode null!)
    // a detached runner for this bot may already exist on the machine (survived a CC restart) — but only
    // adopt it when it LOOKS alive: Windows recycles PIDs fast, and a recycled pid made the guard adopt a
    // ghost, skip the respawn, and strand watchdog-exited bots in 'error' (the 3 & 26 incident). Adoption
    // requires a fresh status.json whose pid matches — a dead runner's status goes stale within 90s.
    // Verified-death restarts (exit handler) pass skipAdopt and never trust the old pid file.
    const livePid = skipAdopt ? null : this.runningPid(botId);
    if (livePid) {
      let fresh = false, pidMatch = false;
      try { const st = JSON.parse(fs.readFileSync(path.join(rt.dir, 'status.json'), 'utf8')); fresh = Date.now() - (st.ts ?? 0) < 90000; pidMatch = st.pid === livePid; } catch {}
      if (fresh && pidMatch) {
        if (rt.state !== 'running') { rt.state = 'running'; this.onUpdate(); }
        return;
      }
      console.log(`[start] bot ${botId}: stale pid ${livePid} (pid-reuse suspicion) — spawning fresh instead`);
    }
    if (delayMs > 0) { rt.state = 'queued';
      this.control(botId, 'run'); // clear any stale 'stop' left over from a previous stop-all
      await sleep(delayMs);
      // abort only if we were stopped WHILE queued (fresh stop written during the wait)
      if (readControl(rt.dir)?.cmd === 'stop') { rt.state = 'stopped'; this.onUpdate(); return; }
    }
    if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) return;
    try { torEnsurePort(botId); } catch {} // self-heal: the bot's circuit must exist before it dials out
    const character = store.findCharacter(bot.characterId);
    const account = store.findAccount(character.accountId);
    this.control(botId, 'run');
    rt.state = 'starting';
    rt.lastEvt = null; // fresh spawn → don't show the previous session's activity badge
    rt.exitIp = null; // fresh spawn → will be re-logged by the pre-login proxy probe
    rt.lastExit = null; // fresh spawn → clear the death certificate so status-based promotion works again
    rt.stopping = false;
    rt.startedAt = Date.now();
    // stdio goes straight to a FILE HANDLE and the child is detached: piped stdio dies with the parent
    // and took the whole fleet down when the command center was restarted (2026-10-08). Never again.
    let logFd;
    try {
      logFd = fs.openSync(path.join(rt.dir, 'worker.log'), 'a');
      rt.proc = spawn(process.execPath, [RUNNER, '--upto', UPTO, '--mode', bot.mode ?? 'leveling'], {
        cwd: TESTBOT,
        detached: true,
        env: {
          ...process.env,
          AETHERIA_DATA: rt.dir,
          AETHERIA_USER: account.userId,
          AETHERIA_PASS: account.password,
          AETHERIA_QUIET: '1',
          AETHERIA_MODE: bot.mode ?? 'leveling',
        },
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } catch (e) {
      // a silent throw here used to strand the bot in 'error' with no trace (bot 26 incident)
      try { if (logFd) fs.closeSync(logFd); } catch {}
      console.error(`[start] bot ${botId}: spawn failed — ${e?.message || e}`);
      rt.state = 'error'; rt.proc = null;
      bot.state = 'error'; bot.updatedAt = Date.now();
      try { store.save(); } catch {}
      this.onUpdate();
      if (bot.wantRun) setTimeout(() => { if (bot.wantRun && !rt.stopping && !rt.proc) this.start(botId, { skipAdopt: true }).catch(() => {}); }, 45000);
      return;
    }
    try { fs.closeSync(logFd); } catch {} // the child keeps its own duplicate of the handle
    rt.proc.on('exit', (code) => {
      const uptime = Date.now() - (rt.startedAt ?? 0);
      if (uptime > 10 * 60 * 1000) rt.restarts = 0; // a healthy run resets crash backoff
      rt.lastExit = { code, at: Date.now() };
      if (rt.stopping || code === 0) {
        rt.state = 'stopped';
        rt.stopping = false;
      } else {
        rt.restarts = (rt.restarts ?? 0) + 1;
        if (rt.autoRestart !== false && rt.restarts <= 30) {
          rt.state = 'restarting';
          const delay = Math.min(5 * 60 * 1000, 15000 * rt.restarts);
          // skipAdopt: this exit IS the death certificate — the pid file must not be trusted here
          // guard on the PROCESS, not the state: a leftover fresh status file used to flip 'restarting'
          // back to 'running' before this timer fired, silently cancelling the restart
          setTimeout(() => {
            if (rt.stopping || rt.state === 'stopped' || rt.state === 'paused') return;
            if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) return;
            this.start(botId, { skipAdopt: true }).catch((e) => console.error(`[restart] bot ${botId}: ${e?.message || e}`));
          }, delay);
        } else {
          rt.state = 'error';
        }
      }
      bot.state = rt.state; bot.updatedAt = Date.now(); store.save();
      rt.proc = null; // Windows signal kills keep exitCode null — a dead handle must not look alive to poll()/start()
      this.onUpdate();
    });
    bot.state = 'starting'; bot.updatedAt = Date.now(); store.save();
    this.onUpdate();
  }

  pause(botId) {
    const rt = this.rt(botId);
    if (!rt.proc || rt.proc.exitCode !== null || rt.proc.signalCode !== null) return;
    rt.state = 'pausing';
    this.control(botId, 'pause');
    this.onUpdate();
  }

  resume(botId) { this.control(botId, 'run'); this.start(botId); this.onUpdate(); }

  stop(botId) {
    const rt = this.rt(botId);
    const bot = store.findBot(botId);
    if (bot && bot.wantRun !== false) { bot.wantRun = false; bot.updatedAt = Date.now(); try { store.save(); } catch {} }
    this.control(botId, 'stop'); // also cancels a queued start
    rt.stopping = true;
    rt.state = 'stopping';
    if (!rt.proc || rt.proc.exitCode !== null || rt.proc.signalCode !== null) {
      // no process handle (CC restarted while this runner was already up — adopted bots): the runner exits
      // on its own via control.json. KEEP rt.stopping so poll() cannot flip the state back to 'running'
      // off the runner's last fresh heartbeat before it exits; start() clears it on the next Play.
      // (2026-10-10: collectors stopped from the dashboard showed 'running' forever because poll() saw the
      // dying runner's still-fresh status and re-promoted them.)
      rt.state = 'stopped';
      this.onUpdate();
      return;
    }
    const proc = rt.proc;
    setTimeout(() => { try { if (proc.exitCode === null) proc.kill(); } catch {} }, 25000);
    this.onUpdate();
  }

  async stopAll() {
    for (const bot of store.data.bots) this.stop(bot.id);
  }

  // Reliable single restart for mode changes (UI stop→7s→play races the graceful-exit window and can be
  // silently swallowed). stop → wait for the process to actually exit → drop any stale handle → start.
  async restartBot(botId, { kick = false } = {}) {
    const bot = store.findBot(botId);
    if (!bot) return { ok: false, error: 'bot not found' };
    const rt = this.rt(botId);
    this.stop(botId);
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      if (!rt.proc || rt.proc.exitCode !== null || rt.proc.signalCode !== null || rt.state === 'stopped') break;
      await sleep(700);
    }
    await this._ensureDead(botId); // verified kill — a stale handle must never block or duplicate the respawn
    await this.start(botId, { skipAdopt: true, kick });
    return { ok: true, id: botId };
  }

  // Fleet restart: stop everything, wait for all exits, kill stragglers, drop stale handles, then start with ramp.
  // Use after pushing mode changes (mode is read at spawn) or to reload runner code fleet-wide.
  async restartAll({ rampMs = 3000 } = {}) {
    await this.stopAll();
    const t0 = Date.now();
    const alive = () => [...this.runtime.values()].some((rt) => rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null);
    while (alive() && Date.now() - t0 < 50000) await sleep(800);
    for (const [bid, rt] of this.runtime) {
      void rt;
      await this._ensureDead(bid); // verified kill per bot (handles survive CC restarts now — no blind handoffs)
    }
    await sleep(1500);
    const bots = store.data.bots.slice();
    for (let i = 0; i < bots.length; i++) this.start(bots[i].id, { delayMs: i * rampMs, skipAdopt: true }).catch(() => {});
    return { ok: true, count: bots.length, rampMs };
  }

  // Restart a SUBSET of bots (mode/map changes for selected bots only — avoids a full-fleet bounce).
  async restartMany(botIds, { kick = false } = {}) {
    const ids = [...new Set(botIds.map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x) && !!store.findBot(x)))];
    for (const id of ids) this.stop(id);
    const t0 = Date.now();
    const anyAlive = () => ids.some((id) => { const rt = this.runtime.get(id); return rt && rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null; });
    while (anyAlive() && Date.now() - t0 < 50000) await sleep(800);
    for (const id of ids) {
      await this._ensureDead(id);
    }
    await sleep(1000);
    for (let i = 0; i < ids.length; i++) this.start(ids[i], { delayMs: i * 1500, skipAdopt: true, kick }).catch(() => {});
    return { ok: true, count: ids.length, ids };
  }

  // Boot / power-cycle recovery (Debian): start every bot whose persisted intent is "running"
  // (wantRun === true), skipping retired, paused, and already-up bots. The server-side
  // aetheria-fleetup.timer calls POST /api/bots/start-all right after boot and every 5 min after —
  // a dead runner with live intent self-heals, while anything the user intentionally stopped stays down.
  async startAll({ rampMs = 2500 } = {}) {
    const ids = (store.data.bots ?? [])
      .filter((b) => b && !b.retired && b.wantRun === true && b.state !== 'paused')
      .filter((b) => { const rt = this.runtime.get(b.id); return !(rt && (rt.proc || rt.stopping || rt.state === 'running' || rt.state === 'starting' || rt.state === 'queued' || rt.state === 'restarting' || rt.state === 'paused')); })
      .map((b) => b.id);
    for (let i = 0; i < ids.length; i++) this.start(ids[i], { delayMs: i * rampMs, skipAdopt: true }).catch(() => {});
    return { ok: true, count: ids.length, ids, rampMs };
  }

  // 🔥 EMERGENCY — sever every bot's game connection INSTANTLY (hard kill, no graceful leave) and keep
  // them down (no auto-restart). Bring bots back with the normal Play / start-all buttons afterwards.
  disconnectAll() {
    let killed = 0;
    for (const [id, rt] of this.runtime) {
      rt.stopping = true; // the exit handler must NOT auto-restart from this
      try { this.control(id, 'stop'); } catch {} // cancels queued (delayed) starts; hint for anything mid-loop
      if (rt.proc && rt.proc.exitCode === null && rt.proc.signalCode === null) { try { if (rt.proc.kill()) killed++; } catch {} }
      rt.state = 'stopped';
      rt.grantPending = false;
    }
    for (const bot of store.data.bots) { bot.state = 'stopped'; bot.wantRun = false; bot.updatedAt = Date.now(); }
    try { store.save(); } catch {}
    this.onUpdate();
    return { ok: true, killed, total: store.data.bots.length };
  }

  async startMany(characterIds, { rampMs = 5000, kick = false } = {}) {
    const started = [];
    for (let i = 0; i < characterIds.length; i++) {
      const bot = this.ensureBot(characterIds[i]);
      started.push(bot.id);
      this.start(bot.id, { delayMs: i * rampMs, kick }).catch(() => {});
    }
    return started;
  }

  // ---- polling: status files + JSONL tailing ----
  poll() {
    for (const [botId, rt] of this.runtime) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(rt.dir, 'status.json'), 'utf8'));
        rt.status = s;
        if (s?.exitIp && !rt.exitIp) rt.exitIp = s.exitIp; // fallback: the pre-login probe also lands in status.json
        const fresh = Date.now() - (s.ts ?? 0) < 90000;
        if (fresh) {
          if (rt.state === 'starting' && s.map) rt.state = 'running';
          if (s.state === 'paused' && rt.state !== 'stopping') rt.state = 'paused';
          // no proc handle after a CC restart → trust a FRESH status.json (heartbeats every ~20s). BUT a
          // leftover status from a runner that already exited must never mask the death: rt.lastExit is
          // the death certificate — it also must not cancel a scheduled restart by flipping 'restarting'
          // back to 'running' (the 3 & 26 strand-in-error root cause).
          else if (s.state === 'running' && rt.state !== 'stopping' && rt.state !== 'pausing' && !rt.stopping && !rt.lastExit && (rt.proc ? rt.proc.exitCode === null : true)) rt.state = 'running';
        } else if (rt.proc && rt.proc.exitCode === null && rt.state === 'running') {
          rt.state = 'stalled';
        }
      } catch {}
      this.tailEvents(botId, rt);
      const alive = rt.proc && rt.proc.exitCode === null;
      // stall watchdog: a running bot whose status stopped updating gets recycled (exit → auto-restart)
      if (alive && rt.state === 'running' && rt.status && Date.now() - (rt.status.ts ?? 0) > 300000) {
        if (Date.now() - (rt.lastStallKill ?? 0) > 10 * 60 * 1000) {
          rt.lastStallKill = Date.now();
          console.error(`[watchdog] bot ${botId} stalled (no status for 5min) — recycling`);
          try { rt.proc.kill(); } catch {}
        }
      }
      // a bot stuck in 'starting' for too long also gets recycled
      if (alive && rt.state === 'starting' && Date.now() - (rt.startedAt ?? 0) > 7 * 60 * 1000) {
        if (Date.now() - (rt.lastStallKill ?? 0) > 10 * 60 * 1000) {
          rt.lastStallKill = Date.now();
          console.error(`[watchdog] bot ${botId} stuck starting for 7min — recycling`);
          try { rt.proc.kill(); } catch {}
        }
      }
      // orphan sweep: after a CC restart we adopt runners WITHOUT process handles, so a later crash has no
      // exit event to schedule a restart. Fresh status = alive; stale status + no handle + persisted run
      // intent (wantRun) = the runner died unwatched — kill leftovers (verified) and respawn.
      const wantBot = store.findBot(botId);
      if (!rt.proc && !rt.stopping && wantBot?.wantRun === true && !wantBot.retired && rt.status
        && rt.state !== 'restarting' && rt.state !== 'queued' && rt.state !== 'stopping' && rt.state !== 'paused'
        && Date.now() - (rt.status.ts ?? 0) > 120000 && Date.now() - (rt._orphanAt ?? 0) > 60000) {
        rt._orphanAt = Date.now();
        rt.state = 'restarting';
        console.error(`[watchdog] bot ${botId}: status stale ${Math.round((Date.now() - rt.status.ts) / 1000)}s with no process handle — verified kill + respawn`);
        this._ensureDead(botId).then(() => this.start(botId, { skipAdopt: true })).catch(() => {});
      }
      if (!alive && !rt.stopping && rt.state !== 'stopped' && rt.state !== 'error' && rt.state !== 'queued' && rt.state !== 'restarting') {
        rt.state = rt.lastExit?.code === 0 ? 'stopped' : (rt.lastExit ? 'error' : rt.state);
      }
    }
    try { this._ledgerTick(); } catch {}
    if (this._killDirty && Date.now() - (this._killSavedAt ?? 0) > 30000) this._saveKills();
    this.pollHop();
    this.pollShop();
    this.pollCollect();
    this.onUpdate();
  }

  // ---- collect queue (trade to collector, one bot at a time) ----
  pollCollect() {
    const settings = store.getSettings?.() ?? {};
    const col = settings.collector;
    // ---- auto-collect scheduler (2026-10-10): the SCHEDULE LIVES ON PLANS ----
    // A plan may carry cfg.autoCollect {enabled, everyMin}: every bot riding that plan (bot.plan.name) is
    // queued on that cadence; plans without it never auto-collect. The "main" group stays excluded either
    // way (user rule 2026-10-10). If NO plan enables it, fall back to the legacy global settings.autoCollect
    // so collection can never silently stop (the collector-tab toggle is legacy now).
    if (this.activeTrades.size === 0 && !this.tradeQueue.length) {
      const legacy = settings.autoCollect;
      const planSched = (settings.plans ?? []).filter((pl) => pl?.cfg?.autoCollect?.enabled);
      const sources = planSched.length
        ? planSched.map((pl) => ({ key: 'plan:' + pl.name, everyMin: pl.cfg.autoCollect.everyMin ?? 240, lastAt: pl.collectLastAt ?? 0, match: (id) => (store.findBot(id)?.plan?.name ?? '') === pl.name, touch: (t) => { pl.collectLastAt = t; } }))
        : (legacy?.enabled ? [{ key: 'global', everyMin: legacy.everyMin ?? 360, lastAt: legacy.lastAt ?? 0, match: () => true, touch: (t) => { legacy.lastAt = t; } }] : []);
      const ac = legacy ?? {};
      const skipGroups = new Set((Array.isArray(ac.skipGroups) ? ac.skipGroups : ['main']).map((g) => String(g).toLowerCase()));
      const groupOf = (id) => String(store.findBot(id)?.group ?? '').toLowerCase();
      let saved = false;
      for (const src of sources) {
        const period = Math.max(15, src.everyMin) * 60000;
        if (!src.lastAt) { src.touch(Date.now()); saved = true; continue; } // first sight: anchor the clock only
        if (Date.now() - src.lastAt <= period) continue;
        src.touch(Date.now()); saved = true; // due: fire and re-arm
        const all = this.eligibleCollectBots(ac);
        const ids = all.filter((id) => src.match(id) && !skipGroups.has(groupOf(id)));
        const skippedMain = all.filter((id) => skipGroups.has(groupOf(id))).length;
        if (ids.length) {
          for (const id of ids) { if (!this.tradeQueue.includes(id)) this.tradeQueue.push(id); }
          console.log(`[auto-collect] ${src.key} queued ${ids.length} bot(s): ${ids.join(',')}${skippedMain ? ` (skipped ${skippedMain} main-group)` : ''}`);
          this._saveQueue();
          this.onUpdate?.();
        }
      }
      if (saved) { try { store.save?.(); } catch {} }
    }
    let qDirty = false, hDirty = false;
    for (const [botId, rt] of this.runtime) {
      const bot = store.findBot(botId);
      if (!bot || bot.mode === 'collector') continue;
      const st = rt.status;
      // a held bot (✕ removed) rejoins the pool once its want-cycle resets (wantCollect flips false, e.g. after a bounce)
      if (rt.collectHold && st && st.wantCollect === false) { rt.collectHold = false; hDirty = true; }
      // MANUAL-ONLY COLLECTION (2026-10-08 user policy): bots no longer auto-join the queue when their bag fills.
      // The queue is fed exclusively by explicit actions (Queue buttons / auto-collect scheduler, itself off by default).
    }
    if (qDirty || hDirty) this._saveQueue();
    // completion / timeout sweep — parallel: iterate every active donor
    let anyDone = false;
    for (const [colKey, a] of [...this.activeTrades]) {
      const rt = this.runtime.get(a.botId);
      const doneAt = rt?.status?.collectDone?.at ?? 0;
      const stuck = Date.now() - (a.grantAt ?? 0) > 10 * 60 * 1000;
      if ((doneAt && doneAt >= (a.grantAt ?? 0)) || stuck) {
        try { this.clearGrant(a.botId); } catch {}
        if (rt) rt.grantPending = false;
        this.activeTrades.delete(colKey);
        if (stuck) this.hopActive?.delete(a.botId); // a stuck hop trip must not hold a concurrency slot
        anyDone = true;
        if (stuck && !doneAt) console.log(`[collectors] bot ${a.botId} → ${colKey}: grant timed out (10 min) — slot freed`);
      }
    }
    if (anyDone) this._saveQueue();
    // grants: PARALLEL — one donor per FREE collector per tick. A donor's plan only targets collectors that
    // are live and not already entertaining a donor, so two donors never fight over one collector's window.
    if (this.tradeQueue.length && this.collectors().length && this.collectorLive()) {
      // shopping priority (user rule): a collector with shop work (waiting or live) takes no new collect grants
      const free = this.collectors().filter((c) => this.collectorLiveFor(c) && !this.activeTrades.has(c.charName) && !this.shopBusyFor(c.charName));
      const liveCols = this.collectors().filter((c) => this.collectorLiveFor(c)).length;
      this.hopActive ??= new Map(); // botId → grantAt of live hop trips (cap = live collectors + 2 parked donors)
      for (const [bid, at] of [...this.hopActive]) if (Date.now() - at > 20 * 60 * 1000) { this.hopActive.delete(bid); const rts = this.runtime.get(bid); if (rts) rts.grantPending = false; } // stale trip (runner died mid-hop / finish never arrived): free the flag too
      const hopCap = Math.max(1, liveCols) + 2; // +2 parked donors keep the lanes hot (user rule 2026-10-09)
      let grantedAny = false;
      // HOP PASS (2026-10-09): hop trips don't need a free lane — find them anywhere in the queue and launch
      // them up to the cap (= one live trip per live collector). While they run, they book collectors per hop.
      for (let i = 0; i < this.tradeQueue.length && this.hopActive.size < hopCap; ) {
        const botId = this.tradeQueue[i];
        const rt = this.runtime.get(botId);
        if (!rt || (rt.state !== 'running' && rt.state !== 'starting') || !this.hopEnabledFor(botId) || this.hopActive.has(botId)
          || this.shopJobs.some((j) => j.botId === botId && (j.status === 'queued' || SHOP_LIVE.has(j.status)))) { i++; continue; }
        const probe = this.buildCollectPlan(botId, { autoCreate: false });
        const maybeHidden = !!store.findBot(botId)?.cfg?.storeWhitelist; // own-storage items are invisible until the trip's pull
        if (!probe.targets.length && !maybeHidden) { i++; continue; } // no capacity anywhere for it — let the legacy pass decide
        this.tradeQueue.splice(i, 1);
        rt.grantPending = true;
        this.hopActive.set(botId, Date.now());
        const lounge = this.collectors().find((c) => this.collectorLiveFor(c)) ?? this.collectors()[0];
        this.grantCollect(botId, { collector: lounge.charName, channel: lounge.channel ?? 1, spot: lounge.spot ?? { x: 880, y: 1520 }, hop: true, targets: probe.targets });
        grantedAny = true; // the next item slid into slot i — don't i++
      }
      // LEGACY PASS: head-first, one donor per free collector lane (unchanged semantics; waiting hop bots rotate
      // out of the way instead of blocking the line)
      const hasLegacy = this.tradeQueue.some((id) => !this.hopEnabledFor(id));
      let guard = 0;
      while (this.tradeQueue.length && guard++ < 400) {
        const botId = this.tradeQueue[0];
        const rt = this.runtime.get(botId);
        // offline leftovers leave the line instead of stalling a collector slot for 10 min
        if (!rt || (rt.state !== 'running' && rt.state !== 'starting')) { this.tradeQueue.shift(); continue; }
        // SHOPPING priority (2026-10-08 fix): never grant a collect to a knight that has a queued/live gear-up
        // job — both grants land in the SAME control.json slot, and whichever writes second wins (the other
        // side then waits forever for a trade the loser never knew about — "delivery trade failed" chaos).
        if (this.shopJobs.some((j) => j.botId === botId && (j.status === 'queued' || SHOP_LIVE.has(j.status)))) {
          this.tradeQueue.shift();
          console.log(`[collectors] bot ${botId}: dropped from the collect queue — it has a gear-up job (shopping first)`);
          continue;
        }
        if (this.hopEnabledFor(botId)) { // couldn't start in the hop pass (cap/no capacity) — don't block legacy behind it
          if (hasLegacy && this.tradeQueue.length > 1) { this.tradeQueue.push(this.tradeQueue.shift()); continue; }
          break;
        }
        if (!free.length) break; // legacy grants need a free collector lane
        const plan = this.buildCollectPlan(botId, { only: new Set(free.map((c) => c.charName)), autoCreate: false });
        if (plan.empty) { this.tradeQueue.shift(); console.log(`[collectors] bot ${botId}: nothing to hand over — dropped from the queue`); continue; }
        if (!plan.targets.length) {
          // fits anywhere (busy collectors included)? then it just waits; fits nowhere → the pool is full
          const fitsBusy = this.buildCollectPlan(botId, { autoCreate: false }).targets.length > 0;
          const maybeFits = !fitsBusy && this.collectors().some((c) => this.collectorLiveFor(c) && !this.heldFor(c));
          if (!fitsBusy && !maybeFits && !this._colCreating && Date.now() > 10000 + (rt.planWaitAt ?? 0)) {
            rt.planWaitAt = Date.now();
            console.log(`[collectors] bot ${botId} waits — the whole pool is at capacity`);
            this.ensureCollectorCapacity('no collector capacity').catch(() => {});
          } else if (fitsBusy && this.tradeQueue.length > 1) {
            this.tradeQueue.push(this.tradeQueue.shift()); // rotate — let donors that fit the free subset go first
          }
          break;
        }
        this.tradeQueue.shift();
        rt.grantPending = true;
        const t0 = plan.targets[0];
        this.grantCollect(botId, { collector: t0.name, channel: t0.channel, spot: t0.spot, targets: plan.targets, leftover: plan.leftover ?? null });
        this.activeTrades.set(t0.name, { botId, grantAt: Date.now() });
        free.splice(free.findIndex((c) => c.charName === t0.name), 1); // that collector is busy now
        grantedAny = true;
        if (plan.leftover) console.log(`[collectors] bot ${botId}: leftover after the free-collector plan — ${Object.keys(plan.leftover.items).length} item type(s) + ${plan.leftover.zeny}z ride the next round`);
      }
      if (grantedAny) this._saveQueue();
    }
  }

  collectView() {
    const settings = store.getSettings?.() ?? {};
    const plan = this.capacityPlan();
    const actives = this.activeView();
    const activeByCol = new Map(actives.map((a) => [a.collector, a.botId]));
    const collectors = this.collectors().map((c) => {
      const bot = this.collectorBotFor(c);
      const held = this.heldFor(c);
      const itemTotal = held ? Object.values(held.items).reduce((a, b) => a + b, 0) : 0;
      const topItem = held ? Object.entries(held.items).sort((a, b) => b[1] - a[1])[0] : null;
      const qp = plan.queues[c.charName];
      return {
        ...c,
        botId: bot?.id ?? null,
        live: this.collectorLiveFor(c),
        active: activeByCol.get(c.charName) ?? null,
        queuePreview: qp?.queue ?? [],
        held: held ? { zeny: held.zeny, itemTotal, topItem: topItem ? { itemId: +topItem[0], qty: topItem[1] } : null, transfers: held.transfers } : null,
      };
    });
    return { queue: [...this.tradeQueue], actives, held: this.heldList(), collector: settings.collector ?? null, collectorLive: this.collectorLive(), collectors, capacity: plan, tracked: settings.tracked ?? [], autoCollect: settings.autoCollect ?? null };
  }
  // is ANY collector bot up (running/starting)? — grants are held while none is, so donors never trek out for nothing
  collectorLive() {
    return this.collectors().some((c) => this.collectorLiveFor(c));
  }

  // ---- hop protocol (2026-10-09) --------------------------------------------------------------
  // ONE donor trip to the collectors' lounge, then a just-in-time allocation request per hop. Each
  // collector is booked the moment it is allocated (the CC is single-threaded → booking is atomic), so
  // nothing is held while the donor trades elsewhere; items + zeny split across the pool inside one trip.
  // Files: <bot dir>/hop.json (runner→CC requests) · hopres.json (CC→runner replies, matched by hopId).
  hopEnabledFor(botId) {
    const h = store.getSettings?.()?.collectHop ?? {};
    if (!h.enabled) return false;
    const canary = Array.isArray(h.canary) ? h.canary.map(Number) : [];
    return canary.length === 0 || canary.includes(Number(botId));
  }
  // what could collector `col` take from `leftover` = { zeny, items:{id:qty} }? null when its ledger is unknown
  hopFits(col, leftover) {
    const held = this.heldFor(col);
    if (!held) return null;
    const remZ = Math.max(0, (col.zenyCap ?? DEF_ZENY_CAP) - held.zeny);
    const acceptZeny = Math.min(remZ, Math.max(0, (leftover.zeny ?? 0) - ZENY_RESERVE));
    const acceptItems = {};
    for (const [id, qty] of Object.entries(leftover.items ?? {})) {
      const rem = Math.max(0, (col.itemCapPerItem ?? DEF_ITEM_CAP) - (held.items[id] ?? 0));
      const take = Math.min(rem, qty);
      if (take > 0) acceptItems[id] = take;
    }
    return { acceptZeny, acceptItems, any: acceptZeny > 0 || Object.keys(acceptItems).length > 0 };
  }
  // finish-leftover fit (2026-10-09 fix): `leftover.zeny` reported by a FINISHED hop is already net of the
  // donor's reserve (`hopFits` is for ALLOC requests, which carry the full wallet) — re-subtracting the
  // reserve made every sub-reserve remnant unplaceable → every such finish false-tripped the capacity
  // valve (bot 68's 518z remnant → spurious collector #9 RoyalDove).
  leftoverFits(col, leftover) {
    const held = this.heldFor(col);
    if (!held) return true; // ledger unknown → maybe — never let unknowable state read as capacity exhaustion
    const remZ = Math.max(0, (col.zenyCap ?? DEF_ZENY_CAP) - held.zeny);
    if (remZ > 0 && (leftover.zeny ?? 0) > 0) return true;
    for (const [id, qty] of Object.entries(leftover.items ?? {})) {
      if (qty <= 0) continue;
      if (Math.max(0, (col.itemCapPerItem ?? DEF_ITEM_CAP) - (held.items[id] ?? 0)) > 0) return true;
    }
    return false;
  }
  releaseHopLeases(botId) {
    let hit = false;
    for (const [k, a] of [...this.activeTrades]) if (a.botId === botId && a.hop) { this.activeTrades.delete(k); hit = true; }
    return hit;
  }
  pollHop() {
    for (const [botId, rt] of this.runtime) {
      const p = path.join(rt.dir, 'hop.json');
      let mtime = 0, req = null;
      try { mtime = fs.statSync(p).mtimeMs; if (mtime <= (rt.hopSeen ?? 0)) continue; req = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      rt.hopSeen = mtime;
      if (!req || typeof req !== 'object' || !req.hopId) continue;
      if (Date.now() - (req.at ?? 0) > 180000) continue; // stale replay (e.g. after a CC restart) — the runner gave up on it long ago
      try { this.handleHopRequest(botId, rt, req); }
      catch (e) {
        console.error(`[hop] bot ${botId}: ${e.message}`);
        try { fs.writeFileSync(path.join(rt.dir, 'hopres.json'), JSON.stringify({ hopId: req.hopId, none: 'error' })); } catch {}
      }
    }
  }
  handleHopRequest(botId, rt, req) {
    this.tailEvents(botId, rt); // ordering guard: ingest the donor's latest receipts BEFORE freeing/booking
    this.releaseHopLeases(botId); // a new request supersedes the previous hop — its collector is free again
    const res = { hopId: req.hopId, at: Date.now() };
    if (req.want === 'finish') {
      this.hopActive?.delete(botId);
      // trip is over — the runner no longer holds a grant slot. This clear was MISSING: releaseHopLeases()
      // (called at the top of EVERY request, incl. finish) deletes the collector booking, so the completion
      // sweep — the only other place that clears this flag — never sees hop donors. Result: every bot that
      // ever finished a hop trip stayed grantPending=true forever and queue-all / auto-collect skipped the
      // whole fleet ("queue ALL does nothing" bug, 2026-10-09).
      rt.grantPending = false;
      // bookkeeping (2026-10-09): hop donors never reach the activeTrades completion sweep, so their
      // control.json grant used to stay FOREVER (the "120 stale grants" incident - every bot that ever
      // hopped kept a spent grant). Clear it here, but only when it is still the hop grant: a gear-up
      // shop grant may have landed in the meantime and must never be touched.
      try {
        const cur = JSON.parse(fs.readFileSync(path.join(rt.dir, 'control.json'), 'utf8'));
        if (cur?.grant?.hop === true) this.clearGrant(botId);
      } catch {}
      const leftover = req.leftover ?? { zeny: 0, items: {} };
      const hasLeft = (leftover.zeny ?? 0) >= 500 || Object.keys(leftover.items ?? {}).length > 0;
      if (hasLeft) {
        const liveCols = this.collectors().filter((c) => this.collectorLiveFor(c));
        const anywhere = liveCols.some((c) => this.leftoverFits(c, leftover));
        if (!anywhere && !liveCols.length) {
          console.log(`[collectors] bot ${botId}: hop leftover — no live collectors right now (outage, not capacity) — re-queued, NO creation`);
        } else if (!anywhere) {
          console.log(`[collectors] bot ${botId}: hop leftover — the pool is at capacity, capacity check`);
          this.ensureCollectorCapacity('no collector capacity').catch(() => {});
        }
        if (!this.tradeQueue.includes(botId) && !this.isActive(botId)) {
          // churn fix (2026-10-09): a trip that moved NOTHING (timed out while waiting for a lane) must
          // NOT jump the front - front-jumping zero-progress trips let the same unlucky set cycle forever
          // (25-min timeout -> front -> redispatch) and starve everyone else. Front only for continuation
          // (receipts > 0); back of the line otherwise. Old runners send no `receipts` -> treated as
          // continuation (no behavior change until the runner rollout).
          const progressed = req.receipts === undefined || req.receipts === null ? true : (parseInt(req.receipts, 10) || 0) > 0;
          if (progressed) this.tradeQueue.unshift(botId); else this.tradeQueue.push(botId);
          this._saveQueue();
          console.log(`[collectors] bot ${botId}: hop leftover ${anywhere ? (progressed ? '— re-queued front for a continuation trip' : '— re-queued to the BACK (trip moved nothing)') : '— re-queued (waiting for capacity)'}`);
        }
      }
      res.ok = true;
    } else if (req.want === 'alloc') {
      const exclude = new Set(req.exclude ?? []);
      const leftover = { zeny: req.have?.zeny ?? 0, items: req.have?.items ?? {} };
      let anyCapacity = false, target = null;
      for (const col of this.collectors()) {
        if (!this.collectorLiveFor(col) || exclude.has(col.charName)) continue;
        const fit = this.hopFits(col, leftover);
        if (!fit?.any) continue;
        anyCapacity = true;
        if (this.activeTrades.has(col.charName) || this.shopBusyFor(col.charName)) continue; // busy → try the next collector
        target = { col, fit };
        break;
      }
      if (target) {
        const cb = this.collectorBotFor(target.col);
        this.activeTrades.set(target.col.charName, { botId, grantAt: Date.now(), hop: true, tripId: req.tripId ?? null });
        res.target = { name: target.col.charName, channel: target.col.channel ?? 1, spot: target.col.spot ?? { x: 880, y: 1520 }, collectorBotId: cb?.id ?? null };
        res.acceptZeny = target.fit.acceptZeny;
        res.acceptItems = target.fit.acceptItems;
        this._saveQueue?.();
      } else {
        res.none = anyCapacity ? 'busy' : 'capacity';
      }
    } else res.ok = true;
    fs.writeFileSync(path.join(rt.dir, 'hopres.json'), JSON.stringify(res));
    this.onUpdate?.();
  }

  // CAPACITY PLANNER (2026-10-08): estimate what the fleet still has to hand over (zeny beyond the 50k
  // reserve + whitelist items in bags AND bot storages), what the current pool can hold, how many more
  // collectors would be needed if everything were handed over — and dry-runs the parallel reservation:
  // which waiting donors each collector would take right now (→ the per-collector queue preview in the UI).
  capacityPlan() {
    const collectors = this.collectors();
    const sim = new Map(); // charName -> remaining capacity + reserved queue (the dry-run)
    const colInfo = [];
    for (const c of collectors) {
      const held = this.heldFor(c);
      const r = {
        zeny: Math.max(0, (c.zenyCap ?? DEF_ZENY_CAP) - (held?.zeny ?? 0)),
        items: new Map(Object.entries(held?.items ?? {}).map(([k, v]) => [+k, v])),
        queue: [],
        live: this.collectorLiveFor(c),
      };
      sim.set(c.charName, r);
      colInfo.push({ name: c.charName, zenyRemain: r.zeny, itemCap: c.itemCapPerItem ?? DEF_ITEM_CAP, live: r.live, heldZeny: held?.zeny ?? 0 });
    }
    const donorState = (botId) => {
      const bot = store.findBot(botId);
      const st = this.runtime.get(botId)?.status;
      if (!bot || bot.mode === 'collector' || !st) return null;
      const keep = new Set(bot.cfg?.keep ?? []);
      const bag = new Map();
      for (const it of (st.inventory ?? [])) if (keep.has(it.itemId) && it.itemId !== 90311) bag.set(it.itemId, (bag.get(it.itemId) ?? 0) + (it.qty ?? 1));
      for (const it of (st.storage?.items ?? [])) if (keep.has(it.itemId) && it.itemId !== 90311) bag.set(it.itemId, (bag.get(it.itemId) ?? 0) + (it.qty ?? 1));
      return { zeny: Math.max(0, (st.zeny ?? 0) - ZENY_RESERVE), bag, fresh: Date.now() - (st.ts ?? 0) < 120000 };
    };
    // fleet pending totals
    let totalZeny = 0, totalItems = 0, botsWith = 0, stale = 0;
    const perItem = new Map();
    for (const [botId] of this.runtime) {
      const d = donorState(botId);
      if (!d) continue;
      if (!d.fresh) { stale++; continue; }
      let n = 0;
      for (const q of d.bag.values()) { n += q; }
      if (d.zeny > 0 || n > 0) botsWith++;
      totalZeny += d.zeny; totalItems += n;
      for (const [id, q] of d.bag) perItem.set(id, (perItem.get(id) ?? 0) + q);
    }
    // how many collectors the handover needs (capacity model: zeny cap + per-item cap)
    const zenyNeed = Math.ceil(totalZeny / DEF_ZENY_CAP);
    let itemNeed = 0;
    for (const q of perItem.values()) itemNeed = Math.max(itemNeed, Math.ceil(q / DEF_ITEM_CAP));
    const neededTotal = Math.max(zenyNeed, itemNeed, 0);
    // dry-run reservation for the WAITING queue (parallel preview): assign in FIFO order to whatever fits
    const unassigned = [];
    for (const botId of this.tradeQueue) {
      const d = donorState(botId);
      if (!d) { unassigned.push(botId); continue; }
      let zenyLeft = d.zeny;
      const bag = new Map(d.bag);
      let target = null;
      for (const [name, r] of sim) {
        if (zenyLeft > 0 && r.zeny <= 0) continue;
        let any = zenyLeft > 0;
        if (!any) for (const [id, q] of bag) { if (q > 0 && (DEF_ITEM_CAP - (r.items.get(id) ?? 0)) > 0) { any = true; break; } }
        if (any) { target = [name, r]; break; }
      }
      if (!target) { unassigned.push(botId); continue; }
      const [name, r] = target;
      void name;
      if (zenyLeft > 0) { const take = Math.min(zenyLeft, r.zeny); r.zeny -= take; zenyLeft -= take; }
      for (const [id, q] of bag) {
        const remQ = Math.max(0, DEF_ITEM_CAP - (r.items.get(id) ?? 0));
        const take = Math.min(remQ, q);
        if (take > 0) r.items.set(id, (r.items.get(id) ?? 0) + take);
      }
      r.queue.push(botId);
      void name;
    }
    const queues = {};
    for (const [name, r] of sim) queues[name] = { queue: r.queue, zenyRemain: r.zeny };
    return {
      totals: { zeny: totalZeny, items: totalItems, bots: botsWith, stale },
      collectors: colInfo,
      neededTotal, have: collectors.length,
      additionalNeeded: Math.max(0, neededTotal - collectors.length),
      queues, unassigned: unassigned.length,
    };
  }

  // bots that have whitelist items in the bag or zeny waiting beyond the 50k reserve
  eligibleCollectBots(ac = {}) {
    const out = [];
    for (const [botId, rt] of this.runtime) {
      const bot = store.findBot(botId);
      if (!bot || bot.mode === 'collector') continue;
      if (rt.state !== 'running') continue;
      if (rt.collectHold) continue; // ✕ skip honored by the auto-scheduler too
      const st = rt.status;
      const fresh = st && Date.now() - (st.ts ?? 0) < 120000;
      if (!fresh || !st.selfId) continue;
      if (this.isActive(botId) || this.tradeQueue.includes(botId) || rt.grantPending) continue;
      const keep = new Set(bot.cfg?.keep ?? []);
      // bag + own storage both feed the handover (storeWhitelist plans bank the whitelist in storage)
      const stacks = (st.inventory ?? []).filter((it) => keep.has(it.itemId) && it.itemId !== 90311).reduce((s, it) => s + (it.qty ?? 1), 0)
        + (st.storage?.items ?? []).filter((it) => keep.has(it.itemId) && it.itemId !== 90311).reduce((s, it) => s + (it.qty ?? 1), 0);
      const zeny = st.zeny ?? 0;
      if (stacks >= (ac.minStacks ?? 1) || zeny > 50000 + (ac.minZeny ?? 15000)) out.push(botId);
    }
    return out;
  }

  tailEvents(botId, rt) {
    let files = [];
    try { files = fs.readdirSync(rt.dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort(); } catch { return; }
    const newest = files[files.length - 1];
    if (!newest) return;
    const p = path.join(rt.dir, newest);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { return; }
    if (rt.tailFile !== newest) {
      rt.tailFile = newest; rt.tailCarry = '';
      // resume where this bot's log was left off (persisted kill-log tails) — 0 when the file is new
      const remember = this.killLog.tails?.[botId];
      rt.tailOffset = (remember && remember.file === newest && remember.off > 0 && remember.off <= size) ? remember.off : 0;
      // command-center restarted mid-session: the head of the log (where proxy_exit lives) was already
      // consumed — pread it once per file so the Tor exit IP survives CC restarts
      if (!rt.exitIp) {
        try {
          const head = Buffer.alloc(Math.min(3000, size));
          const fdh = fs.openSync(p, 'r');
          try { fs.readSync(fdh, head, 0, head.length, 0); } finally { fs.closeSync(fdh); }
          const m = head.toString('utf8').match(/"evt":"proxy_exit".*?"ip":"([^"]+)"/);
          if (m) rt.exitIp = m[1];
        } catch {}
      }
    }
    if (size < rt.tailOffset) { rt.tailOffset = 0; rt.tailCarry = ''; }
    if (size === rt.tailOffset) return;
    const len = size - rt.tailOffset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, 'r');
    try { fs.readSync(fd, buf, 0, len, rt.tailOffset); } finally { fs.closeSync(fd); }
    rt.tailOffset = size;
    const text = rt.tailCarry + buf.toString('utf8');
    const lines = text.split('\n');
    rt.tailCarry = lines.pop() ?? '';
    const tl = this.killLog.tails[botId] ?? (this.killLog.tails[botId] = { file: newest, off: 0, last: '' });
    let read = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      read = true;
      try {
        const evt = JSON.parse(line);
        // kill log: count per (local day, bot, monster) — monotonic timestamps fence off re-reads
        if (evt?.t && evt.t > (tl.last || '')) {
          tl.last = evt.t;
          if (evt.evt === 'kill') {
            const key = dayKey(evt.t) + '|' + botId + '|' + (evt.data?.m ?? '?');
            this.killLog.rows[key] = (this.killLog.rows[key] ?? 0) + 1;
          }
        }
        // remember the last meaningful event for the card activity badge (skip heartbeats)
        if (evt && evt.evt && evt.evt !== 'HEARTBEAT') rt.lastEvt = { evt: evt.evt, b: EVT_BRIEF(evt.evt, evt.data ?? {}), at: Date.now() };
        // directive-ack tracking (2026-10-09): the runner logs directives_applied when it APPLIES a control.json
        // revision - a wedged/deaf runner never acks; the shop dispatcher uses this to auto-restart it
        if (evt?.evt === 'directives_applied' && evt.data?.rev != null) rt.lastDirectiveRev = Math.max(rt.lastDirectiveRev ?? -1, evt.data.rev);
        // Tor identity: the runner logs its exit IP before login — surface it on the dashboard card/list
        if (evt?.evt === 'proxy_exit' && evt.data?.ip) rt.exitIp = evt.data.ip;
        // multi-collector ledger: donors report exactly what they handed each collector
        if (evt?.evt === 'collector_receipt') this.applyReceipt(evt.data ?? {});
        // shopping progress (the collector's runner + the knight both emit shop_* events)
        if (evt?.evt && String(evt.evt).startsWith('shop_')) { try { this.applyShopEvent(botId, evt); } catch {} }
        this.onEvent(botId, evt);
      } catch {}
    }
    if (read) { tl.file = newest; tl.off = rt.tailOffset; this._killDirty = true; }
  }

  // ---- views for API/UI ----
  view() {
    return store.data.bots.map((bot) => {
      const rt = this.runtime.get(bot.id);
      const c = store.findCharacter(bot.characterId);
      const a = c ? store.findAccount(c.accountId) : null;
      return {
        id: bot.id,
        characterId: bot.characterId,
        name: c?.name ?? `char#${bot.characterId}`,
        account: a?.userId ?? null,
        mode: bot.mode,
        retired: bot.retired === true,
        group: bot.group ?? null,
        state: this.stateOf(bot.id),
        status: rt?.status ?? null,
        exitIp: rt?.exitIp ?? null,
        lastExit: rt?.lastExit ?? null,
        restarts: rt?.restarts ?? 0,
        activity: rt?.lastEvt ?? null,
        earn: this.earnings.summaryFor(bot.id),
        cfg: bot.cfg ?? null,
        plan: bot.plan ?? null,
      };
    });
  }

  stateOf(botId) {
    const rt = this.runtime.get(botId);
    if (!rt) return store.findBot(botId)?.state ?? 'stopped';
    return rt.state;
  }
}
