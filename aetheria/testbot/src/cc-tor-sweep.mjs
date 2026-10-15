// cc-tor-sweep.mjs — verify every bot's Tor circuit gives a DIFFERENT exit IP.
// usage: node src/cc-tor-sweep.mjs [idFrom idTo]   (default: 1..101 + 202 + 203)
import https from 'node:https';
import { SocksProxyAgent } from 'socks-proxy-agent';

const ids = process.argv[2] && process.argv[3]
  ? Array.from({ length: +process.argv[3] - +process.argv[2] + 1 }, (_, i) => +process.argv[2] + i)
  : [...Array.from({ length: 101 }, (_, i) => i + 1), 202, 203];

const probe = (id) => new Promise((resolve) => {
  const port = 19000 + id;
  const agent = new SocksProxyAgent(`socks5h://bot${id}:aeth${id}@127.0.0.1:${port}`);
  const req = https.get('https://api.ipify.org/', { agent, timeout: 45000 }, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve({ id, port, ip: res.statusCode === 200 ? b.trim() : `HTTP ${res.statusCode}` }));
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (e) => resolve({ id, port, ip: 'ERR ' + String(e.message || e).slice(0, 80) }));
});

const results = [];
const QUEUE = [...ids];
const workers = Array.from({ length: 10 }, async () => {
  while (QUEUE.length) {
    const id = QUEUE.shift();
    const r = await probe(id);
    results.push(r);
    console.log(`bot ${String(id).padStart(3)} :${r.port} -> ${r.ip}`);
  }
});
await Promise.all(workers);

const ok = results.filter((r) => /^\d+\.\d+\.\d+\.\d+$/.test(r.ip));
const ipCount = new Map();
for (const r of ok) ipCount.set(r.ip, (ipCount.get(r.ip) ?? 0) + 1);
const dupes = [...ipCount.entries()].filter(([, n]) => n > 1);
console.log(`\n== ${ok.length}/${results.length} circuits up, ${ipCount.size} unique exit IPs, ${dupes.length} collisions`);
if (dupes.length) console.log('collisions:', dupes.map(([ip, n]) => `${ip} x${n}`).join(', '));
const errs = results.filter((r) => !ok.includes(r));
if (errs.length) console.log('failures:', errs.map((r) => `${r.id}(${r.ip})`).join(', '));
