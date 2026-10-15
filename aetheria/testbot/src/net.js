// net.js — every outbound byte a bot sends: per-bot Tor SOCKS circuit + browser-identical identity.
// Header profile captured live 2026-10-08 from real Chrome v154 traffic on the game itself (CDP):
//  - fetch POST (www, same-origin): origin(+POST), referer /play, sec-fetch-mode cors, site same-origin, priority u=1,i
//  - fetch POST (g28 matchmake, cross-origin): sec-fetch-site same-site, origin www, referer www root
//  - ws handshake (Chrome): Origin, UA, Accept-Language, Accept-Encoding, Cache-Control no-cache, Pragma no-cache,
//    Sec-WebSocket-Version 13, permessage-deflate; HTTP/2 used for all REST (:authority pseudo-headers observed).
//
// Proxy mapping: bot data dir name = bot id → SocksPort 19000+id (bots 1..203), username bot<id> isolates its
// circuit (torrc: SocksPort <p> IsolateSOCKSAuth). Env overrides: AETHERIA_SOCKS=<port|socks5h url>, AETHERIA_NOPROXY=1.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { SocksProxyAgent } from 'socks-proxy-agent';

// ---------------- identity ----------------
const OUT = process.env.AETHERIA_DATA ? path.resolve(process.env.AETHERIA_DATA) : null;
const BOT_ID = OUT ? parseInt(path.basename(OUT), 10) : NaN;
const PROXY_MAX_BOT = 1000; // was 203: auto-created collectors (204/206/207...) silently ran DIRECT — no Tor, no exit IP (found 2026-10-09; their torrc ports existed all along)

function proxyUrl() {
  if (process.env.AETHERIA_NOPROXY === '1') return null;
  const env = process.env.AETHERIA_SOCKS || null;
  if (env) {
    if (/^\d+$/.test(env)) { const port = +env; return `socks5h://bot${Number.isFinite(BOT_ID) ? BOT_ID : port}:aeth${Number.isFinite(BOT_ID) ? BOT_ID : port}@127.0.0.1:${port}`; }
    return env;
  }
  if (Number.isFinite(BOT_ID) && BOT_ID >= 1 && BOT_ID <= PROXY_MAX_BOT) {
    // two-daemon split (2026-10-09): even ids → tor daemon 2 (ports 20000+id), odd ids → daemon 1 (19000+id).
    // Halves the per-daemon circuit-build stampede under mass reconnects + gives failover capacity.
    const base = BOT_ID % 2 === 0 ? 20000 : 19000;
    const port = base + BOT_ID;
    return `socks5h://bot${BOT_ID}:aeth${BOT_ID}@127.0.0.1:${port}`;
  }
  return null;
}

export const PROXY = proxyUrl();
export const hasProxy = !!PROXY;
export const proxyLabel = hasProxy ? PROXY.replace(/:\/\/[^@]*@/, '://***@') : 'direct';
let agent = null; // lazy — only created when something actually goes out
// CRITICAL: the SOCKS timeout bounds the handshake. Without it a stalled Tor circuit left `agent.connect()`
// pending FOREVER — the awaited promise never settled and the bot parked mid-reconnect (the 2026-10-08
// wedge epidemic, 26 bots). Raised 20s → 55s (2026-10-09): during circuit-build contention a build often
// needs 30-50s; abandoning at 20s left the build running AND queued another one — the fleet-wide jam
// feedback loop. torrc allows SocksTimeout 60 — stay just below it.
const getAgent = () => (agent ||= new SocksProxyAgent(PROXY, { keepAlive: true, timeout: 55000 }));

// ---------------- browser identity (captured from real Chrome 154) ----------------
export const WWW = 'https://www.aetheria-online.in.th';
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const CH_UA = '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"';
const ACCEPT_LANG = 'en-US,en;q=0.9';
// Chrome sends "gzip, deflate, br, zstd"; Node 20 cannot inflate zstd, so we omit it (minor tell, accepted)
const ACCEPT_ENC = 'gzip, deflate, br';

export async function gfetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = 60000 } = {}) {
  const u = new URL(url);
  const hdrs = { ...headers };
  let payload = body;
  if (payload != null && typeof payload !== 'string' && !Buffer.isBuffer(payload)) payload = JSON.stringify(payload);
  if (payload != null) hdrs['content-length'] = String(Buffer.byteLength(payload));
  if (u.protocol === 'https:') {
    try { return await h2Request(u, method, hdrs, payload, timeoutMs); }
    catch (e) {
      if (/no h2 alpn/.test(String(e && e.message))) throw e; // server said h1 — rare; caller fallback below
      return await h1Request(u, method, hdrs, payload, timeoutMs);
    }
  }
  return await h1Request(u, method, hdrs, payload, timeoutMs);
}

// ---------------- HTTP/2 (same wire protocol real Chrome uses) ----------------
const h2sessions = new Map(); // host -> http2 session

async function openH2Socket(hostname, port) {
  const fakeReq = new EventEmitter();
  fakeReq.destroy = () => {};
  fakeReq.on('proxy', () => {});
  const tcp = await getAgent().connect(fakeReq, { host: hostname, port, secureEndpoint: false });
  const tlsSock = tls.connect({ socket: tcp, servername: hostname, ALPNProtocols: ['h2'] });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('h2 tls timeout')), 25000);
    tlsSock.once('secureConnect', () => { clearTimeout(to); res(); });
    tlsSock.once('error', (e) => { clearTimeout(to); rej(e); });
  });
  if (tlsSock.alpnProtocol !== 'h2') { try { tlsSock.destroy(); } catch {} throw new Error('no h2 alpn: ' + tlsSock.alpnProtocol); }
  return tlsSock;
}

async function h2Request(u, method, headers, body, timeoutMs) {
  const key = u.host;
  let session = h2sessions.get(key);
  if (session && (session.closed || session.destroyed)) session = null;
  if (!session) {
    const sock = await openH2Socket(u.hostname, Number(u.port) || 443);
    session = http2.connect(`${u.protocol}//${u.host}`, { createConnection: () => sock });
    session.on('error', () => {});
    session.on('goaway', () => session.close());
    session.on('close', () => { if (h2sessions.get(key) === session) h2sessions.delete(key); });
    h2sessions.set(key, session);
  }
  let status = 0, rheaders = {};
  const chunks = [];
  const req = session.request({ ':method': method, ':path': u.pathname + u.search, ...headers });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => { try { req.close(http2.constants.NGHTTP2_CANCEL); } catch {} reject(new Error('h2 request timeout')); }, timeoutMs);
    req.on('response', (h) => { status = Number(h[':status']); rheaders = h; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { clearTimeout(to); resolve(); });
    req.on('error', (e) => { clearTimeout(to); reject(e); });
    req.end(body || undefined);
  });
  return makeRes(status, rheaders, Buffer.concat(chunks));
}

// ---------------- HTTP/1.1 fallback (same headers, pooled socks agent) ----------------
function h1Request(u, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method,
      headers, ...(hasProxy ? { agent: getAgent() } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(makeRes(res.statusCode, res.headers, Buffer.concat(chunks))));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('h1 timeout')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

// ---------------- response shaping (fetch-lite) ----------------
function decodeBody(headers, buf) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (!enc || enc === 'identity') return buf;
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    return buf;
  } catch { return buf; }
}
function makeRes(status, headers, buf) {
  let cached = null;
  const text = () => (cached ??= decodeBody(headers, buf).toString('utf8'));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => text(),
    json: async () => { const t = text(); return t ? JSON.parse(t) : null; },
  };
}

// ---------------- high-level game call (exact Chrome fetch shape) ----------------
export async function apiFetch(pathOrUrl, { method = 'GET', body = null, token = null, referer = null, timeoutMs = 30000, extraHeaders = {} } = {}) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : WWW + pathOrUrl;
  const u = new URL(url);
  const isWww = u.hostname === 'www.aetheria-online.in.th';
  const headers = {
    'accept': '*/*',
    'accept-encoding': ACCEPT_ENC,
    'accept-language': ACCEPT_LANG,
    'sec-ch-ua': CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': isWww ? 'same-origin' : 'same-site',
    'priority': 'u=1, i',
    'user-agent': UA,
    'referer': referer || (isWww ? WWW + '/play' : WWW + '/'),
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const serialized = body != null && typeof body !== 'string' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
  if (serialized != null) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['origin'] = WWW; // fetch: Origin on all non-GET, even same-origin
  Object.assign(headers, extraHeaders);
  return gfetch(url, { method, headers, body: serialized, timeoutMs });
}

// ---------------- WebSocket options (exact Chrome handshake) ----------------
export function wsOptions() {
  return {
    ...(hasProxy ? { agent: getAgent() } : {}),
    headers: {
      'Origin': WWW,
      'User-Agent': UA,
      'Accept-Language': ACCEPT_LANG,
      'Accept-Encoding': ACCEPT_ENC,
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'sec-ch-ua': CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
    perMessageDeflate: true, // Chrome always offers permessage-deflate
    handshakeTimeout: 30000,
  };
}

// ---------------- exit-IP probe (ops/verification) ----------------
export async function probeExitIp(timeoutMs = 30000) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await gfetch('https://api.ipify.org/', { timeoutMs });
      const ip = (await r.text()).trim();
      if (r.ok && ip) return ip;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}
