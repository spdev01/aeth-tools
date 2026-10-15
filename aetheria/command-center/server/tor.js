// tor.js — command-center side of the per-bot Tor pool: allocate a bot's SocksPort the moment its bot row is
// created (register/import/sync/start), then live-reload tor via the control port (SIGNAL RELOAD) so the new
// listener appears WITHOUT dropping circuits other bots are riding.
// Port scheme: bot id N -> SocksPort 19000+N, username bot<N> (isolated circuit). Lines are appended to
// data/tor/bot-ports.extra, which data/tor/torrc pulls in via %include.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { store } from './store.js';

const TOR_DIR = path.join(store.dir, 'tor');
const TOR2_DIR = path.join(store.dir, 'tor2');
const EXTRA = path.join(TOR_DIR, 'bot-ports.extra');
const EXTRA2 = path.join(TOR2_DIR, 'bot-ports.extra');
const TORRC = path.join(TOR_DIR, 'torrc');
const TORRC2 = path.join(TOR2_DIR, 'torrc');
const CONTROL_PORT = 9051;
const CONTROL_PORT2 = 9052;

// two-daemon split (2026-10-09): even bot ids ride daemon 2 (SocksPort 20000+id / control 9052), odd ids
// daemon 1 (19000+id / 9051). Halves the per-daemon circuit-build stampede on mass reconnects — the
// recurring fleet-wide Tor jams. During transition daemon 1 still listens on ALL 19000+id ports.
export const daemonFor = (botId) => (Number(botId) % 2 === 0 ? 2 : 1);
export const portFor = (botId) => (Number(botId) % 2 === 0 ? 20000 : 19000) + Number(botId);
export const proxyFor = (botId) => `socks5h://bot${botId}:aeth${botId}@127.0.0.1:${portFor(botId)}`;
export const torDir = TOR_DIR;
const extraFor = (botId) => (Number(botId) % 2 === 0 ? EXTRA2 : EXTRA);
const controlFor = (botId) => (Number(botId) % 2 === 0 ? CONTROL_PORT2 : CONTROL_PORT);

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
    reload(daemonFor(botId));
    return { ok: true, port, added: true };
  }
  return { ok: true, port, added: false };
}

// SIGNAL RELOAD over the control protocol — adds new SocksPort listeners without touching live circuits.
// Fire-and-forget: failure (tor not running) is fine — the port line is already saved for next start.
export function reload(which = 1) {
  return new Promise((resolve) => {
    let sent = false, buf = '';
    const s = net.connect(which === 2 ? CONTROL_PORT2 : CONTROL_PORT, '127.0.0.1');
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

export function info() {
  const ports = listPorts();
  return { torrc: TORRC, torrc2: TORRC2, extra: EXTRA, extra2: EXTRA2, controlPort: CONTROL_PORT, controlPort2: CONTROL_PORT2, ports: ports.length, maxPort: ports.length ? Math.max(...ports) : 0 };
}
