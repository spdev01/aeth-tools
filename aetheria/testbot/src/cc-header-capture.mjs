// cc-header-capture.mjs — capture REAL Chrome request headers for the game (auth POST, matchmake POST,
// WS handshake) via CDP, so the bots can mirror a legitimate browser byte-for-byte.
// usage: node src/cc-header-capture.mjs
import fs from 'node:fs';
import { WebSocket } from 'ws';

const CDP = 'http://127.0.0.1:9333';
const OUT = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-headers-captured2.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// find a page target
let targets = [];
for (let i = 0; i < 30; i++) {
  try { targets = await (await fetch(CDP + '/json/list')).json(); if (targets.length) break; } catch {}
  await sleep(1000);
}
const page = targets.find((t) => t.type === 'page');
if (!page) { console.log('no page target'); process.exit(1); }
console.log('# attached to', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let msgId = 0;
const pending = new Map();
const base = new Map();     // requestId -> {url, method, headers, type}
const extra = new Map();    // requestId -> on-the-wire headers
ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    if (/aetheria-online\.in\.th/.test(r.url)) base.set(m.params.requestId, { url: r.url, method: r.method, headers: { ...r.headers }, type: m.params.type });
  }
  if (m.method === 'Network.requestWillBeSentExtraInfo') {
    const h = m.params.headers;
    if (h) extra.set(m.params.requestId, { ...h });
  }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'https://www.aetheria-online.in.th/play' });
await sleep(6000);

// probe 1: same-origin POST fetch to /auth/login (headers-only; 4xx response is fine)
await send('Runtime.evaluate', {
  expression: `fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'probe_nonexistent', password: 'x' }) }).then(r => r.status).catch(e => String(e))`,
  awaitPromise: true, returnByValue: true,
});
await sleep(2500);

// probe 2: cross-origin POST to a room endpoint (matchmake) — capture preflight + POST headers
await send('Runtime.evaluate', {
  expression: `fetch('https://g28.aetheria-online.in.th/matchmake/joinById/Zx7RX91Vf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: 'probe', batch: true }) }).then(r => r.status).catch(e => String(e))`,
  awaitPromise: true, returnByValue: true,
});
await sleep(2500);

// probe 3: WebSocket handshake — game page CSP may block connects, so use a fresh CSP-free tab
let wsTab = null;
try {
  const t = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  wsTab = t;
} catch (e) { console.log('# ws tab create failed:', String(e)); }
if (wsTab?.webSocketDebuggerUrl) {
  const ws2 = new WebSocket(wsTab.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res) => ws2.once('open', res));
  let id2 = 0;
  ws2.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.method === 'Network.webSocketWillSendHandshakeRequest') {
      const r = m.params.request;
      const key = 'ws-' + (++id2);
      base.set(key, { url: r.url, method: 'GET(WS)', headers: { ...r.headers }, type: 'WebSocket' });
    } else if (m.method === 'Network.webSocketCreated') {
      const key = 'ws-' + (++id2);
      base.set(key, { url: m.params.url, method: 'GET(WS)', headers: {}, type: 'WebSocket' });
    }
  });
  ws2.send(JSON.stringify({ id: 1, method: 'Network.enable', params: {} }));
  await sleep(500);
  ws2.send(JSON.stringify({
    id: 2, method: 'Runtime.evaluate', params: {
      expression: `(function(){ try { const w = new WebSocket('wss://g28.aetheria-online.in.th/1/1?sessionId=probe123'); w.onerror = () => {}; w.onopen = () => w.close(); return 'created'; } catch (e) { return String(e); } })()`,
      returnByValue: true,
    },
  }));
  await sleep(3000);
  ws2.close();
  await fetch(CDP + '/json/close/' + wsTab.id).catch(() => {});
}
await sleep(500);

// merge base + extra (extra = what actually went on the wire; wins on overlaps)
const captured = [];
for (const [id, b] of base) {
  const ex = extra.get(id);
  const merged = { ...(b.headers || {}), ...(ex || {}) };
  captured.push({ url: b.url, method: b.method, type: b.type, headers: merged });
}
fs.writeFileSync(OUT, JSON.stringify(captured, null, 1));
console.log(`# captured ${captured.length} requests -> ${OUT}`);
for (const c of captured) {
  if (!/auth\/(login|config)|matchmake|sessionId=/.test(c.url) && c.type !== 'Document') continue;
  console.log(`===== ${c.method} ${c.url.slice(0, 110)} | ${c.type ?? '?'}`);
  for (const [k, v] of Object.entries(c.headers)) console.log(`  ${k}: ${String(v)}`);
}
ws.close();
process.exit(0);
