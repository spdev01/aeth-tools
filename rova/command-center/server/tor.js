// tor.js — ROVA command center side of the per-bot Tor pool.
// Allocates a bot's SocksPort the moment its bot row is created, live-reloads tor via the control port
// (SIGNAL RELOAD) so new listeners appear WITHOUT dropping circuits other bots are riding, and can
// start/restart the two daemons. See tor-const.mjs for the port scheme.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { store } from './store.js';
import { D1_BASE, D2_BASE, CONTROL1, CONTROL2, TOR_BIN, daemonFor, portFor, housePortFor } from './tor-const.mjs';

const TOR_DIR = path.join(store.dir, 'tor');
const TOR2_DIR = path.join(store.dir, 'tor2');
const EXTRA = path.join(TOR_DIR, 'bot-ports.extra');
const EXTRA2 = path.join(TOR2_DIR, 'bot-ports.extra');
const TORRC = path.join(TOR_DIR, 'torrc');
const TORRC2 = path.join(TOR2_DIR, 'torrc');

const extraFor = (botId) => (daemonFor(botId) === 2 ? EXTRA2 : EXTRA);
const controlFor = (botId) => (daemonFor(botId) === 2 ? CONTROL2 : CONTROL1);
const fwd = (p) => p.replace(/\\/g, '/');

export function ensureTorrc() {
  fs.mkdirSync(TOR_DIR, { recursive: true });
  fs.mkdirSync(TOR2_DIR, { recursive: true });
  const writeIfMissing = (file, body) => { if (!fs.existsSync(file)) fs.writeFileSync(file, body); };
  writeIfMissing(TORRC, torrcTemplate(TOR_DIR, CONTROL1, D1_BASE));
  writeIfMissing(TORRC2, torrcTemplate(TOR2_DIR, CONTROL2, D2_BASE));
  for (const f of [EXTRA, EXTRA2]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, '# auto-managed: one SocksPort per bot (SIGNAL RELOAD applies new lines live)\n');
  }
}

function torrcTemplate(dir, controlPort, basePort) {
  return [
    '# ROVA command center tor daemon — per-bot isolated SOCKS listeners live in bot-ports.extra',
    `DataDirectory ${fwd(path.join(dir, 'data'))}`,
    `Log notice file ${fwd(path.join(dir, 'notice.log'))}`,
    'ClientOnly 1',
    'AvoidDiskWrites 1',
    'MaxCircuitDirtiness 86400',
    'NewCircuitPeriod 3600',
    'SocksTimeout 60',
    'MaxClientCircuitsPending 160',
    `ControlPort ${controlPort}`,
    'CookieAuthentication 0',
    `SocksPort ${basePort}` + '            # house circuit (health canaries, tools)',
    `%include ${fwd(path.join(dir, 'bot-ports.extra'))}`,
    '',
  ].join('\n');
}

export function hasPort(botId) {
  try {
    const txt = fs.readFileSync(extraFor(botId), 'utf8');
    return new RegExp(`^SocksPort\\s+${portFor(botId)}\\b`, 'm').test(txt);
  } catch { return false; }
}

export function listPorts() {
  const read = (f) => { try { return [...fs.readFileSync(f, 'utf8').matchAll(/^SocksPort\s+(\d+)/gm)].map((m) => +m[1]); } catch { return []; } };
  return [...read(EXTRA), ...read(EXTRA2)];
}

// append the port line (idempotent) and ask tor to re-read its config
export function ensurePort(botId) {
  const port = portFor(botId);
  if (!Number.isFinite(botId) || botId < 1) return { ok: false, port, added: false };
  const file = extraFor(botId);
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  if (!new RegExp(`^SocksPort\\s+${port}\\b`, 'm').test(txt)) {
    fs.writeFileSync(file, (txt && !txt.endsWith('\n') ? txt + '\n' : txt) + `SocksPort ${port} IsolateSOCKSAuth\n`);
    reload(daemonFor(botId)).catch(() => {});
    return { ok: true, port, added: true };
  }
  return { ok: true, port, added: false };
}

// SIGNAL RELOAD over the control protocol — adds new SocksPort listeners without touching live circuits.
// Fire-and-forget: failure (tor not running) is fine — the port line is saved for the next start.
export function reload(which = 1) {
  return new Promise((resolve) => {
    let sent = false, buf = '';
    const s = net.connect(which === 2 ? CONTROL2 : CONTROL1, '127.0.0.1');
    const done = (ok, why) => { try { s.destroy(); } catch {} resolve({ ok, why }); };
    s.setTimeout(5000, () => done(false, 'timeout'));
    s.on('error', (e) => done(false, String(e.message || e)));
    s.on('connect', () => s.write('AUTHENTICATE\r\n'));
    s.on('data', (d) => {
      buf += d.toString();
      if (!sent) {
        if (/250/.test(buf)) { sent = true; buf = ''; s.write('SIGNAL RELOAD\r\n'); }
        else if (/^5\d\d/m.test(buf)) return done(false, 'auth rejected');
      } else if (/250/.test(buf)) return done(true, 'reloaded');
      else if (/^5\d\d/m.test(buf)) return done(false, 'reload rejected');
    });
  });
}

// ---- daemon lifecycle ------------------------------------------------------------------------------
export function isListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1500);
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.on('timeout', () => done(false));
  });
}

export async function waitPort(port, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await isListening(port)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// Start one daemon (detached). Returns { ok, msg, port } — does NOT wait unless wait=true.
export async function startDaemon(d, { wait = true } = {}) {
  ensureTorrc();
  const torrc = d === 2 ? TORRC2 : TORRC;
  const port = housePortFor(d);
  if (await isListening(port)) return { ok: true, msg: 'already listening', port };
  let logFd1 = null, logFd2 = null;
  try {
    logFd1 = fs.openSync(path.join(d === 2 ? TOR2_DIR : TOR_DIR, 'stdout.log'), 'a');
    logFd2 = fs.openSync(path.join(d === 2 ? TOR2_DIR : TOR_DIR, 'stderr.log'), 'a');
    const p = spawn(TOR_BIN, ['-f', torrc], { detached: true, stdio: ['ignore', logFd1, logFd2], windowsHide: true });
    p.unref();
  } catch (e) {
    return { ok: false, msg: 'spawn failed: ' + (e && e.message), port };
  } finally {
    try { if (logFd1) fs.closeSync(logFd1); } catch {}
    try { if (logFd2) fs.closeSync(logFd2); } catch {}
  }
  if (!wait) return { ok: true, msg: 'spawned', port };
  const up = await waitPort(port, 90000);
  return { ok: up, msg: up ? 'listening' : 'did not open ' + port + ' within 90s', port };
}

export async function startAllDaemons() {
  const a = await startDaemon(1);
  const b = await startDaemon(2);
  return { d1: a, d2: b };
}

// Restart a jammed daemon: kill whoever listens on its house port, respawn with its torrc.
export async function restartDaemon(d) {
  const port = housePortFor(d);
  let pid = null;
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 15000, windowsHide: true });
      for (const line of out.split('\n')) {
        if (line.includes(':' + port + ' ') && line.includes('LISTENING')) { const parts = line.trim().split(/\s+/); pid = parseInt(parts[parts.length - 1], 10) || null; break; }
      }
    } else {
      const out = execSync(`ss -ltnpH 'sport = :${port}'`, { encoding: 'utf8', timeout: 15000 });
      const m = out.match(/pid=(\d+)/); if (m) pid = parseInt(m[1], 10) || null;
    }
  } catch {}
  if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await new Promise((r) => setTimeout(r, 2500));
  return await startDaemon(d);
}

export async function daemonStatus() {
  return {
    1: { port: housePortFor(1), control: CONTROL1, listening: await isListening(housePortFor(1)) },
    2: { port: housePortFor(2), control: CONTROL2, listening: await isListening(housePortFor(2)) },
  };
}

export function info() {
  const ports = listPorts();
  return {
    torrc: TORRC, torrc2: TORRC2, extra: EXTRA, extra2: EXTRA2,
    controlPort: CONTROL1, controlPort2: CONTROL2,
    basePort: D1_BASE, basePort2: D2_BASE,
    bin: TOR_BIN,
    ports: ports.length, maxPort: ports.length ? Math.max(...ports) : 0,
  };
}
