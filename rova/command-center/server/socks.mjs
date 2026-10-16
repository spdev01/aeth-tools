// socks.mjs — minimal dependency-free SOCKS5 client (user/pass auth, RFC 1928 + RFC 1929) and helpers.
// Every ROVA outbound byte goes through one of these sockets (per-bot Tor circuit). There is deliberately
// NO direct-connection fallback anywhere in this tree.
import net from 'node:net';
import tls from 'node:tls';

// Opens a SOCKS5 connection to destHost:destPort and resolves with the ready socket.
// destHost is a DOMAIN NAME and is passed to the proxy as a domain (socks5h) — DNS resolves inside Tor.
export function socks5Connect({ port, host = '127.0.0.1', user, pass, destHost, destPort, timeoutMs = 55000 }) {
  return new Promise((resolve, reject) => {
    let stage = 0, buf = Buffer.alloc(0), settled = false, timer;
    const sock = net.connect({ host, port });
    const fail = (e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { sock.destroy(); } catch {}
      reject(new Error(String((e && e.message) || e)));
    };
    const succeed = (leftover) => {
      if (settled) return; settled = true; clearTimeout(timer);
      sock.removeAllListeners('data'); sock.removeAllListeners('close'); sock.removeAllListeners('error');
      if (leftover && leftover.length) sock.unshift(leftover);
      resolve(sock);
    };
    timer = setTimeout(() => fail('socks: timeout (circuit build)'), timeoutMs);
    sock.on('error', (e) => fail(e));
    sock.on('close', () => fail('socks: closed before ready'));
    sock.on('connect', () => sock.write(Buffer.from([5, 2, 0, 2]))); // offer no-auth + user/pass
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        const method = buf[1]; buf = Buffer.alloc(0);
        if (method === 255) return fail('socks: no acceptable auth method');
        if (method === 2) {
          if (!user) return fail('socks: proxy demands auth but no credentials were given');
          const u = Buffer.from(String(user)), p = Buffer.from(String(pass || ''));
          sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 1;
        } else if (method === 0) {
          sendConnect(); stage = 2;
        } else return fail('socks: unexpected method ' + method);
      } else if (stage === 1) {
        if (buf.length < 2) return;
        if (buf[1] !== 0) return fail('socks: auth rejected');
        buf = Buffer.alloc(0);
        sendConnect(); stage = 2;
      } else if (stage === 2) {
        if (buf.length < 5) return; // ver, rep, rsv, atyp, ...
        const rep = buf[1];
        const atyp = buf[3];
        const need = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 7 + buf[4] : 0;
        if (!need || buf.length < need) return;
        if (rep !== 0) return fail('socks: connect rejected (rep=' + rep + ')');
        succeed(buf.subarray(need));
      }
    });
    function sendConnect() {
      const h = Buffer.from(destHost);
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([destPort >> 8, destPort & 255])]));
    }
  });
}

// Plain HTTP GET through a SOCKS5 proxy (kept as generic as the proxy is).
export async function socksHttpGet({ port, user, pass, host, path: httpPath = '/', headers = {}, timeoutMs = 50000 }) {
  const sock = await socks5Connect({ port, user, pass, destHost: host, destPort: 80, timeoutMs });
  return await new Promise((resolve, reject) => {
    let raw = Buffer.alloc(0);
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('http: timeout')); }, timeoutMs);
    sock.on('data', (d) => { raw = Buffer.concat([raw, d]); });
    sock.on('close', () => { done(); });
    sock.on('end', () => { done(); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    let finished = false;
    function done() {
      if (finished) return; finished = true; clearTimeout(timer);
      const txt = raw.toString('utf8');
      const i = txt.indexOf('\r\n\r\n');
      const head = i >= 0 ? txt.slice(0, i) : txt;
      const body = i >= 0 ? txt.slice(i + 4) : '';
      const status = (head.split('\r\n')[0].match(/ (\d{3}) /) || [])[1];
      resolve({ status: Number(status || 0), body });
    }
    const hdrs = { Host: host, 'User-Agent': 'rova-command-center/tor-probe', Connection: 'close', ...headers };
    const req = 'GET ' + httpPath + ' HTTP/1.1\r\n' + Object.entries(hdrs).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n';
    sock.write(req);
  });
}

// HTTPS GET through a SOCKS5 proxy: bytes ride the circuit up to the proxy, then TLS to the origin.
// (check.torproject.org redirects HTTP→HTTPS, so the plain helper never sees its API answer.)
export async function socksHttpsGet({ port, user, pass, host, path: httpPath = '/', headers = {}, timeoutMs = 50000 }) {
  const raw = await socks5Connect({ port, user, pass, destHost: host, destPort: 443, timeoutMs });
  const sock = tls.connect({ socket: raw, servername: host });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('tls handshake timeout')), 30000);
    sock.once('secureConnect', () => { clearTimeout(t); resolve(); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  return await new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} reject(new Error('https: timeout')); }, timeoutMs);
    let finished = false;
    const done = (body, status) => { if (finished) return; finished = true; clearTimeout(timer); try { sock.destroy(); } catch {} resolve({ status, body }); };
    sock.on('data', (d) => { data += d.toString('utf8'); });
    sock.on('close', () => { split(); });
    sock.on('end', () => { split(); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    function split() {
      const i = data.indexOf('\r\n\r\n');
      const head = i >= 0 ? data.slice(0, i) : data;
      const body = i >= 0 ? data.slice(i + 4) : '';
      const status = Number((head.split('\r\n')[0].match(/ (\d{3}) /) || [])[1] || 0);
      done(body, status);
    }
    const hdrs = { Host: host, 'User-Agent': 'rova-command-center/tor-probe', 'Accept': 'application/json', Connection: 'close', ...headers };
    sock.write('GET ' + httpPath + ' HTTP/1.1\r\n' + Object.entries(hdrs).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
  });
}

// Health canary: raw SOCKS5 CONNECT through a SocksPort — success proves the daemon can build circuits
// right now. Never touches game traffic; completes in ms–seconds. (Mirrors the aetheria CC watchdog.)
// NOTE: this tor build asks for user/pass on every port including the house ports, so the canary
// always authenticates (any credentials are accepted; they only affect IsolateSOCKSAuth buckets).
export async function torCanary(port, { user = 'canary', pass = 'canary', timeoutMs = 25000 } = {}) {
  try {
    const s = await socks5Connect({ port, user, pass, destHost: 'api.ipify.org', destPort: 80, timeoutMs });
    try { s.destroy(); } catch {}
    return true;
  } catch { return false; }
}

// Full end-to-end probe on a bot circuit: exit IP + IsTor verdict via check.torproject.org (HTTPS through
// the circuit). Falls back to plain-HTTP ipify (IP only) if the checker is unreachable.
export async function torExitProbe({ port, user, pass, timeoutMs = 55000 }) {
  try {
    const r = await socksHttpsGet({ port, user, pass, host: 'check.torproject.org', path: '/api/ip', timeoutMs });
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      return { ok: true, ip: j.IP || null, isTor: j.IsTor === true, via: 'check.torproject.org' };
    }
  } catch { /* fall through */ }
  const r2 = await socksHttpGet({ port, user, pass, host: 'api.ipify.org', path: '/', timeoutMs }).catch(() => null);
  if (r2 && r2.status === 200 && r2.body.trim()) return { ok: true, ip: r2.body.trim(), isTor: null, via: 'api.ipify.org' };
  throw new Error('tor exit probe failed (no route through circuit)');
}
