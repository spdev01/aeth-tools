// audit-tor-only.mjs — enforce the Tor-only invariant over the rova/ tree.
// Fails (exit 1) if any target-facing direct-connection primitive is found:
//   fetch( / WebSocket( without a SOCKS agent / net|tls.connect to a non-loopback destination /
//   http(s).get|request / axios / got / node-fetch.
// Allowed without question: loopback (127.0.0.1 / localhost), the CC's own UI (public/), tor's own
// control/data, and anything that explicitly routes through rova-http.mjs / tor-net.mjs / socks.mjs.
// usage: node rova/tools/audit-tor-only.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  path.join(here, '..', 'command-center'),
  path.join(here),
  path.join(here, '..', '..', 'rova-wiki'), // sibling tool project (fetch/build/serve live here)
];
const SKIP_DIRS = new Set(['node_modules', 'data', 'recon', '.git', 'public']);
const SKIP_FILES = new Set(['audit-tor-only.mjs']);

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
    if (SKIP_FILES.has(e.name)) continue;
    if (/\.(mjs|js|cjs)$/.test(e.name)) files.push(path.join(dir, e.name));
  }
}
for (const r of ROOTS) if (fs.existsSync(r)) walk(r);

const findings = [];
const near = (t, i, span = 260) => t.slice(Math.max(0, i - span), i + span);
const loopback = (s) => /(127\.0\.0\.1|localhost|\[::1\]|BASE\b|location\.host)/.test(s);
// static-analysis tools grep bundle TEXT for these literals — those are not connections
const analyzingText = (s) => /indexOf|matchAll|\.match\(|includes\(/.test(s);

for (const f of files) {
  const rel = path.relative(path.join(here, '..'), f);
  const t = fs.readFileSync(f, 'utf8');
  const report = (i, msg) => findings.push(`${rel}:${t.slice(0, i).split('\n').length}  ${msg}`);

  for (const m of t.matchAll(/fetch\s*\(/g)) {
    const w = near(t, m.index, 200);
    if (loopback(w)) continue; // local CC API / UI same-origin
    if (analyzingText(w)) continue; // scanning text, not connecting
    report(m.index, `fetch() with non-loopback context → must use rova-http.mjs (torRequest)`);
  }
  for (const m of t.matchAll(/new WebSocket\s*\(/g)) {
    const w = near(t, m.index, 300);
    if (/\bagent\b/.test(w)) continue; // socks-proxy-agent (shorthand or property)
    if (/location\.host/.test(w)) continue; // same-origin UI socket
    if (analyzingText(w)) continue; // scanning text, not connecting
    report(m.index, `WebSocket() without a SOCKS agent → must go through SocksProxyAgent`);
  }
  for (const m of t.matchAll(/(?:net|tls)\.connect\s*\(/g)) {
    const w = near(t, m.index, 260);
    if (loopback(w) || /socket:/.test(w)) continue; // loopback (tor control) or over an existing socket
    report(m.index, `net/tls.connect() to a non-loopback destination`);
  }
  for (const m of t.matchAll(/(?:https?\.(?:get|request))|axios|(?:^|[^a-z])got\(|node-fetch/g)) {
    report(m.index, `generic HTTP client (http(s).get/request, axios, got, node-fetch) — banned`);
  }
}

for (const line of findings) console.log('FAIL ' + line);
console.log(`\nscanned ${files.length} files · ${findings.length} finding(s)`);
if (findings.length) { console.log('AUDIT FAIL — target-facing connections must ride Tor (rova-http.mjs / tor-net.mjs / socks.mjs).'); process.exit(1); }
console.log('AUDIT PASS — all outbound code is loopback, Tor-routed, or same-origin UI.');
