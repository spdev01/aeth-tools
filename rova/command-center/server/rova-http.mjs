// rova-http.mjs — JSON HTTP(S) through a per-bot Tor circuit (no direct-connection path).
// Minimal HTTP/1.1 over TLS-over-SOCKS: one connection per request, Connection: close, identity encoding.
import crypto from 'node:crypto';
import tls from 'node:tls';
import { socks5Connect } from './socks.mjs';

export const ROVA_HOST = process.env.ROVA_HOST || 'rovaonline.net';

// Client-style device id: 18 random bytes → base64url without padding (matches the client's dv scheme).
export function genDevice() {
  return crypto.randomBytes(18).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function dechunk(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString('latin1').trim(), 16);
    if (!Number.isFinite(size) || size < 0) break;
    const start = nl + 2;
    parts.push(buf.subarray(start, start + size));
    i = start + size + 2;
    if (size === 0) break;
  }
  return Buffer.concat(parts);
}

// One-shot JSON request through the circuit. Returns { status, headers, body, json }.
// binary:true returns body as a latin1 string that is byte-preserving for Buffer.from(body,'latin1').
export async function torRequest({
  port, user, pass, method = 'GET', path = '/', host = ROVA_HOST,
  headers = {}, body = null, timeoutMs = 45000, binary = false,
}) {
  const raw = await socks5Connect({ port, user, pass, destHost: host, destPort: 443, timeoutMs: Math.min(timeoutMs, 60000) });
  const sock = tls.connect({ socket: raw, servername: host });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tls handshake timeout')), 30000);
    sock.once('secureConnect', () => { clearTimeout(t); resolve(); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  const bodyText = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const hdrs = {
    Host: host,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 safari/537.36',
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
    Connection: 'close',
    ...(bodyText != null ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(bodyText)) } : {}),
    ...headers,
  };
  const reqLine = `${method} ${path} HTTP/1.1\r\n` + Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';
  return await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return; finished = true;
      try { sock.destroy(); } catch {}
      reject(new Error(`http timeout (${method} ${path})`));
    }, timeoutMs);
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); });
    sock.on('end', done);
    sock.on('close', done);
    sock.on('error', (e) => { if (!finished) { finished = true; clearTimeout(timer); reject(e); } });
    function done() {
      if (finished) return; finished = true; clearTimeout(timer);
      const ii = buf.indexOf('\r\n\r\n');
      if (ii < 0) return reject(new Error(`bad http response (${method} ${path})`));
      const head = buf.subarray(0, ii).toString('latin1');
      const lines = head.split('\r\n');
      const status = Number((lines[0].match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0);
      const H = {};
      for (const ln of lines.slice(1)) { const j = ln.indexOf(':'); if (j > 0) H[ln.slice(0, j).trim().toLowerCase()] = ln.slice(j + 1).trim(); }
      let rb = buf.subarray(ii + 4);
      if (String(H['transfer-encoding'] || '').includes('chunked')) rb = dechunk(rb);
      else if (H['content-length'] != null) rb = rb.subarray(0, Number(H['content-length']));
      const text = binary ? rb.toString('latin1') : rb.toString('utf8');
      let json = null;
      if (!binary) { try { json = JSON.parse(text); } catch {} }
      resolve({ status, headers: H, body: text, json });
    }
    sock.write(reqLine + (bodyText == null ? '' : bodyText));
  });
}

// Thin API wrappers (Bearer where needed). All ride the circuit given by {port,user,pass}.
const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
export const rovaApi = {
  meta: (c) => torRequest({ ...c, path: '/api/meta' }),
  guest: (c, { device, locale = 'en', invite = '', cbt = '' }) =>
    torRequest({ ...c, method: 'POST', path: '/api/auth/guest', body: { device, locale, invite, cbt } }),
  me: (c, token) => torRequest({ ...c, path: '/api/auth/me', headers: bearer(token) }),
  characters: (c, token) => torRequest({ ...c, path: '/api/characters', headers: bearer(token) }),
  createCharacter: (c, token, name = '') =>
    torRequest({ ...c, method: 'POST', path: '/api/characters', headers: bearer(token), body: name ? { name } : {} }),
  checkName: (c, token, name) =>
    torRequest({ ...c, path: `/api/names/check?name=${encodeURIComponent(name)}`, headers: bearer(token) }),
  endpoints: (c) => torRequest({ ...c, path: '/endpoints.json' }),
};
