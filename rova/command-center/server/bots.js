// bots.js — ROVA bot manager: one worker process per bot, driven by control.json (run/pause/stop),
// status.json polled for the UI, newest run-*.jsonl tailed into the live event stream.
// Tor rule: a bot cannot start unless its daemon's house port is listening; the worker itself also
// refuses to operate without a proven circuit. No code path here can produce a direct connection.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from './store.js';
import { ensurePort, daemonStatus, restartDaemon } from './tor.js';
import { daemonFor, housePortFor } from './tor-const.mjs';
import { isListening } from './tor.js';
import { torCanary } from './socks.mjs';
import { characterName } from './namegen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'worker.mjs');
const BOTS_DIR = path.join(store.dir, 'bots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// tiny digest of the last meaningful event — powers the per-bot activity badge
const EVT_BRIEF = (evt, d) => {
  try {
    switch (evt) {
      case 'boot': return { mode: d.mode };
      case 'proxy_exit': return { ip: d.ip, isTor: d.isTor };
      case 'tor_probe_fail': return { attempt: d.attempt };
      case 'ready': return { ok: true };
      case 'control': return { cmd: d.cmd };
      case 'error': return { fatal: (d.fatal || '').slice(0, 80) };
      case 'stopped': return {};
      default: return {};
    }
  } catch { return {}; }
};

export class BotManager {
  constructor({ onUpdate = () => {}, onEvent = () => {} } = {}) {
    this.onUpdate = onUpdate;
    this.onEvent = onEvent;
    this.runtime = new Map(); // botId -> { dir, proc, state, status, tail: {file, off}, restarts, lastExit, stopping, startedAt, lastEvt }
    this.torHealth = { daemons: { 1: { ok: null, fails: 0, at: 0, lastRestart: 0 }, 2: { ok: null, fails: 0, at: 0, lastRestart: 0 } } };
    for (const bot of store.data.bots) this.rt(bot.id);
    this._poller = setInterval(() => this.poll(), 2000);
    try { this._poller.unref?.(); } catch {}
    this.startTorWatchdog();
  }

  rt(botId) {
    let r = this.runtime.get(botId);
    if (!r) {
      const dir = path.join(BOTS_DIR, String(botId));
      r = { dir, proc: null, state: 'stopped', status: null, tail: { file: null, off: 0 }, restarts: 0, lastExit: null, stopping: false, startedAt: 0, lastEvt: null };
      this.runtime.set(botId, r);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
    return r;
  }

  control(botId, cmd) {
    const r = this.rt(botId);
    const cur = readJson(path.join(r.dir, 'control.json')) || {};
    fs.writeFileSync(path.join(r.dir, 'control.json'), JSON.stringify({ cmd, at: Date.now(), prev: cur.cmd }, null, 1));
  }

  runningPid(botId) {
    const r = this.rt(botId);
    const st = readJson(path.join(r.dir, 'status.json'));
    if (!st || !st.pid) return null;
    const fresh = Date.now() - (st.ts ?? 0) < 90_000;
    if (!fresh) return null;
    try { process.kill(st.pid, 0); return st.pid; } catch { return null; }
  }

  create({ count = 1, mode = 'smoke', names = null } = {}) {
    const made = [];
    for (let i = 0; i < count; i++) {
      const id = store.nextId('bot');
      const bot = {
        id,
        name: (names && names[i]) || characterName(),
        mode,
        accountId: null, characterId: null, // game account/character wiring comes with the leveling plan
        createdAt: Date.now(),
        wantRun: false,
      };
      store.data.bots.push(bot);
      this.rt(id);
      try { ensurePort(id); } catch {} // allocate the bot's Tor circuit now, so config exists before first start
      made.push(bot);
    }
    store.save();
    this.onUpdate();
    return made;
  }

  async start(botId, { delayMs = 0, skipAdopt = false } = {}) {
    const bot = store.findBot(botId);
    if (!bot) return { ok: false, error: 'bot not found' };
    // ---- Tor gate: no daemon, no bot. ----
    const d = daemonFor(botId);
    if (!(await isListening(housePortFor(d)))) {
      return { ok: false, error: `Tor daemon ${d} is not listening on ${housePortFor(d)} — start Tor first (dashboard "เริ่ม Tor" or: node cc.mjs tor-start)` };
    }
    const r = this.rt(botId);
    if (bot.wantRun !== true) { bot.wantRun = true; bot.updatedAt = Date.now(); store.save(); }
    if (r.proc && r.proc.exitCode === null && r.proc.signalCode === null) return { ok: true, already: true };

    const livePid = skipAdopt ? null : this.runningPid(botId);
    if (livePid) {
      // a detached worker for this bot survived a CC restart — adopt it
      r.stopping = false;
      if (r.state !== 'running') { r.state = 'running'; this.onUpdate(); }
      return { ok: true, adopted: true, pid: livePid };
    }

    if (delayMs > 0) {
      r.state = 'queued';
      this.control(botId, 'run');
      await sleep(delayMs);
      if (readJson(path.join(r.dir, 'control.json'))?.cmd === 'stop') { r.state = 'stopped'; this.onUpdate(); return { ok: true, aborted: true }; }
    }
    if (r.proc && r.proc.exitCode === null && r.proc.signalCode === null) return { ok: true, already: true };

    try { ensurePort(botId); } catch {}
    this.control(botId, 'run');
    r.state = 'starting';
    r.stopping = false;
    r.startedAt = Date.now();
    r.lastEvt = null;
    let logFd = null;
    try {
      logFd = fs.openSync(path.join(r.dir, 'worker.log'), 'a');
      r.proc = spawn(process.execPath, [WORKER], {
        cwd: here,
        detached: true,
        env: { ...process.env, ROVA_DATA: r.dir, ROVA_MODE: bot.mode || 'smoke' },
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
    } catch (e) {
      try { if (logFd) fs.closeSync(logFd); } catch {}
      console.error(`[start] bot ${botId}: spawn failed — ${e?.message || e}`);
      r.state = 'error'; r.proc = null;
      bot.updatedAt = Date.now(); store.save();
      this.onUpdate();
      return { ok: false, error: 'spawn failed: ' + (e?.message || e) };
    }
    try { fs.closeSync(logFd); } catch {}
    r.proc.unref?.();
    r.proc.on('exit', (code) => {
      const uptime = Date.now() - (r.startedAt ?? 0);
      if (uptime > 10 * 60 * 1000) r.restarts = 0;
      r.lastExit = { code, at: Date.now() };
      if (r.stopping || code === 0) { r.state = 'stopped'; r.stopping = false; }
      else {
        r.restarts = (r.restarts ?? 0) + 1;
        if (r.restarts <= 30) {
          r.state = 'restarting';
          const delay = Math.min(5 * 60 * 1000, 15000 * r.restarts);
          setTimeout(() => {
            if (r.stopping || r.state === 'stopped') return;
            if (r.proc && r.proc.exitCode === null && r.proc.signalCode === null) return;
            this.start(botId, { skipAdopt: true }).catch(() => {});
          }, delay);
        } else r.state = 'error';
      }
      r.proc = null;
      this.onUpdate();
    });
    bot.updatedAt = Date.now(); store.save();
    this.onUpdate();
    return { ok: true, starting: true };
  }

  pause(botId) {
    const r = this.rt(botId);
    // an adopted worker (CC restarted while it ran) has no process handle here — control.json still drives it
    const alive = (r.proc && r.proc.exitCode === null && r.proc.signalCode === null) || !!this.runningPid(botId);
    if (!alive) return { ok: false, error: 'not running' };
    r.state = 'pausing';
    this.control(botId, 'pause');
    this.onUpdate();
    return { ok: true };
  }

  async resume(botId) {
    this.control(botId, 'run');
    return await this.start(botId);
  }

  stop(botId) {
    const bot = store.findBot(botId);
    if (bot && bot.wantRun !== false) { bot.wantRun = false; bot.updatedAt = Date.now(); try { store.save(); } catch {} }
    const r = this.rt(botId);
    r.stopping = true;
    this.control(botId, 'stop');
    if (!r.proc || r.proc.exitCode !== null || r.proc.signalCode !== null) r.state = 'stopped';
    else r.state = 'stopping';
    this.onUpdate();
    return { ok: true };
  }

  async stopAll() {
    for (const bot of store.data.bots) { try { this.stop(bot.id); } catch {} }
    return { ok: true, count: store.data.bots.length };
  }

  async startAll({ rampMs = 3000, only = null } = {}) {
    const started = [], failed = [];
    const ids = (only || store.data.bots.map((b) => b.id));
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      this.start(id, { delayMs: i * rampMs }).then((r) => { if (!r.ok) failed.push({ id, error: r.error }); }).catch(() => {});
      started.push(id);
    }
    return { ok: true, started, failed };
  }

  remove(botId) {
    this.stop(botId);
    store.data.bots = store.data.bots.filter((b) => b.id !== botId);
    store.save();
    return { ok: true };
  }

  // ---- polling: status.json + newest run log ----------------------------------------
  poll() {
    let changed = false;
    for (const bot of store.data.bots) {
      const r = this.rt(bot.id);
      const st = readJson(path.join(r.dir, 'status.json'));
      if (st && (st.ts ?? 0) > (r.status?.ts ?? 0)) {
        r.status = st;
        bot.status = st;
        // adopt worker-driven states when there is no process handle (CC restarted while it ran)
        if (!r.proc && !r.stopping) {
          const s = st.state;
          const mapped = s === 'stopped' ? 'stopped' : s === 'paused' ? 'paused' : (s === 'error' ? 'error' : 'running');
          if (r.state !== mapped) { r.state = mapped; changed = true; }
        } else if (r.proc && ['ready', 'tor-probing', 'tor-fail', 'paused'].includes(st.state)) {
          const mapped = st.state === 'paused' ? 'paused' : (st.state === 'tor-fail' ? 'tor-fail' : 'running');
          if (r.state !== mapped && !['starting', 'pausing', 'queued'].includes(r.state)) { r.state = mapped; changed = true; }
          else if (r.state === 'starting' && st.state !== 'starting') { r.state = mapped; changed = true; }
        }
        changed = true;
      }
      // tail the newest run-*.jsonl
      try {
        const files = fs.readdirSync(r.dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
        const newest = files.length ? files[files.length - 1] : null;
        if (newest) {
          if (r.tail.file !== newest) { r.tail = { file: newest, off: 0 }; }
          const full = path.join(r.dir, newest);
          const size = fs.statSync(full).size;
          if (size > r.tail.off) {
            const fd = fs.openSync(full, 'r');
            const buf = Buffer.alloc(size - r.tail.off);
            fs.readSync(fd, buf, 0, buf.length, r.tail.off);
            fs.closeSync(fd);
            const text = buf.toString('utf8');
            const lastNl = text.lastIndexOf('\n');
            if (lastNl >= 0) {
              r.tail.off += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
              for (const line of text.slice(0, lastNl).split('\n')) {
                if (!line.trim()) continue;
                try {
                  const evt = JSON.parse(line);
                  r.lastEvt = { evt: evt.evt, ...EVT_BRIEF(evt.evt, evt.data || {}) };
                  this.onEvent({ botId: bot.id, evt });
                } catch {}
              }
            }
          }
        }
      } catch {}
    }
    if (changed) this.onUpdate();
  }

  // ---- Tor watchdog: probe both daemons, restart a jammed one (3 fails, rate-limit 10 min) ----
  startTorWatchdog() {
    if (this._torWd) return;
    setTimeout(() => this.torProbeAll().catch(() => {}), 20000);
    this._torWd = setInterval(() => this.torProbeAll().catch(() => {}), 150000);
    try { this._torWd.unref?.(); } catch {}
  }

  async torProbeAll() {
    for (const d of [1, 2]) {
      const ok = await torCanary(housePortFor(d)).catch(() => false);
      const h = this.torHealth.daemons[d];
      h.at = Date.now();
      if (ok) { if (h.ok !== true) console.log(`[tor-watchdog] daemon ${d}: circuit probe OK`); h.ok = true; h.fails = 0; }
      else {
        h.ok = false; h.fails++;
        console.log(`[tor-watchdog] daemon ${d}: circuit probe FAILED (${h.fails} in a row)`);
        if (h.fails >= 3 && Date.now() - (h.lastRestart ?? 0) > 10 * 60 * 1000) {
          h.lastRestart = Date.now();
          console.log(`[tor-watchdog] daemon ${d}: jammed — restarting tor`);
          restartDaemon(d).catch((e) => console.error(`[tor-watchdog] daemon ${d}: restart failed — ${e?.message || e}`));
        }
      }
    }
    this.onUpdate();
  }

  async torStatus() {
    return { health: this.torHealth, daemons: await daemonStatus() };
  }

  runtimeView(botId) {
    const r = this.rt(botId);
    return { state: r.state, restarts: r.restarts ?? 0, lastExit: r.lastExit, wantRun: !!store.findBot(botId)?.wantRun, lastEvt: r.lastEvt };
  }

  recentEvents(botId, limit = 200) {
    const r = this.rt(botId);
    try {
      const files = fs.readdirSync(r.dir).filter((f) => f.startsWith('run-') && f.endsWith('.jsonl')).sort();
      if (!files.length) return [];
      const lines = fs.readFileSync(path.join(r.dir, files[files.length - 1]), 'utf8').trim().split('\n');
      return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}
