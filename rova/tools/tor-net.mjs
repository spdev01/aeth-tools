// tor-net.mjs — Tor-only network helper for rova/ tooling. NO direct-connection path exists here:
// every request goes through a SOCKS circuit via command-center/server/rova-http.mjs.
// CLI: node tor-net.mjs <absolute-url> [--port 21000] [--user canary] [--pass canary]
import { torRequest } from '../command-center/server/rova-http.mjs';

export async function torFetchText(url, { port = 21000, user = 'canary', pass = 'canary', method = 'GET', headers = {}, body = null, timeoutMs = 90000, binary = false } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('torFetchText: only http(s) URLs');
  const path = u.pathname + (u.search || '');
  return await torRequest({ port, user, pass, method, path, host: u.hostname, headers, body, timeoutMs, binary });
}

// direct-run CLI
if (process.argv[1] && import.meta.url.startsWith('file:') && process.argv[1].endsWith('tor-net.mjs')) {
  const url = process.argv[2];
  const args = {};
  for (let i = 3; i < process.argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(process.argv[i]);
    if (!m) continue;
    args[m[1]] = m[2] !== undefined ? m[2] : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true);
  }
  if (!url) { console.log('usage: node tor-net.mjs <url> [--port 21000] [--user u] [--pass p]'); process.exit(1); }
  const r = await torFetchText(url, { port: Number(args.port || 21000), user: String(args.user || 'canary'), pass: String(args.pass || 'canary') });
  console.log(`status ${r.status} · bytes ${r.body.length} · via tor ${args.port || 21000}`);
  console.log(r.body.slice(0, 400));
}
