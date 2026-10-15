// tmp-bundle-diff.mjs — OLD vs NEW game client bundle anti-bot forensics (safe to delete)
import fs from 'fs';
const oldF = 'E:/GitHub/lumivaraonline/aetheria/index-main.js';
const newF = process.env.TEMP + '\\aetheria-bundle.js';
const A = fs.existsSync(oldF) ? fs.readFileSync(oldF, 'utf8') : '';
const B = fs.readFileSync(newF, 'utf8');
console.log(`old bundle: ${A.length} chars (${fs.existsSync(oldF) ? '' : 'MISSING'}) | new bundle: ${B.length} chars`);

const pats = [
  'human_check', 'fingerprint', 'webdriver', 'headless', 'puppeteer', 'devtools',
  'captcha', 'vpn', 'tor', 'proxy', 'datacenter', 'suspicious', 'suspect', 'abnormal',
  'hardwareConcurrency', 'deviceMemory', 'plugins', 'mimeTypes', 'getContext', 'webgl',
  'toDataURL', 'userAgentData', 'performance.memory', 'languages', 'timezone',
  'client_info', 'clientInfo', 'environment', 'report(', 'violation', 'tamper',
];
console.log('\n=== pattern counts (old -> new) ===');
for (const p of pats) {
  const a = A ? A.split(p).length - 1 : -1;
  const b = B.split(p).length - 1;
  if (a !== b || b > 0) console.log(`  "${p}": ${a === -1 ? 'no-old' : a} -> ${b}${a !== b && a !== -1 ? '   <<< CHANGED' : ''}`);
}

const names = (src, re) => [...new Set([...src.matchAll(re)].map((m) => m[2] || m[3] || m[4]).filter(Boolean))];
const sendRe = /\.send\((`([^`]+)`|'([^']+)'|"([^"]+)")/g;
const msgRe = /\.onMessage\((`([^`]+)`|'([^']+)'|"([^"]+)")/g;
const so = A ? names(A, sendRe) : [];
const sn = names(B, sendRe);
console.log('\n=== room.send types ===');
console.log('[new]:', sn.join(', '));
if (A) { console.log('[old]:', so.join(', ')); console.log('ADDED sends:', sn.filter((x) => !so.includes(x)).join(', ') || '(none)'); console.log('REMOVED sends:', so.filter((x) => !sn.includes(x)).join(', ') || '(none)'); }
const mo = A ? names(A, msgRe) : [];
const mn = names(B, msgRe);
if (A) { console.log('\nADDED onMessage:', mn.filter((x) => !mo.includes(x)).join(', ') || '(none)'); console.log('REMOVED onMessage:', mo.filter((x) => !mn.includes(x)).join(', ') || '(none)'); }

console.log('\n=== x-* header strings (new) ===');
console.log([...new Set([...B.matchAll(/['"](x-[a-z0-9-]+)['"]/gi)].map((m) => m[1]))].join(', ') || '(none)');

console.log('\n=== setInterval send/ping candidates (new) ===');
for (const m of B.matchAll(/setInterval\((.{0,100})/g)) {
  if (/send|ping|ack|heartbeat|beat/i.test(m[1])) console.log('  ', m[1].replace(/\s+/g, ' ').slice(0, 110));
}

console.log('\n=== key contexts (new) ===');
for (const key of ['matchmake/joinById', '/world/enter', '`arrived`']) {
  const i = B.indexOf(key);
  if (i >= 0) console.log(`\n--- ${key} @${i} ---\n`, B.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, ' '));
}
