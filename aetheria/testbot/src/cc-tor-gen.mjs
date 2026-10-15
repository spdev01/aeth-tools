// cc-tor-gen.mjs — generate the per-bot Tor config (one SocksPort per bot id 1..203, isolated circuits).
// usage: node src/cc-tor-gen.mjs
import fs from 'node:fs';
import path from 'node:path';

const DATA = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/tor';
fs.mkdirSync(path.join(DATA, 'data'), { recursive: true });

// torrc = static settings; per-bot SocksPorts live in bot-ports.extra (%include) so the command center can
// append a port for a newly created account and live-reload (SIGNAL RELOAD) without dropping other bots.
const extraPath = path.join(DATA, 'bot-ports.extra');
const lines = [
  '# per-bot isolated SOCKS listeners live in bot-ports.extra (included below)',
  `DataDirectory ${path.join(DATA, 'data').replace(/\\/g, '/')}`,
  `Log notice file ${path.join(DATA, 'notice.log').replace(/\\/g, '/')}`,
  'ClientOnly 1',
  'AvoidDiskWrites 1',
  'MaxCircuitDirtiness 86400',
  'NewCircuitPeriod 3600',
  'SocksTimeout 60',
  'ControlPort 9051',
  'CookieAuthentication 0',
  `%include ${extraPath.replace(/\\/g, '/')}`,
  '',
];
const extras = ['# bot id N -> SocksPort 19000+N (username bot<N>)'];
for (let id = 1; id <= 203; id++) extras.push(`SocksPort ${19000 + id} IsolateSOCKSAuth`);
extras.push('');

const rc = path.join(DATA, 'torrc');
fs.writeFileSync(rc, lines.join('\n'));
fs.writeFileSync(extraPath, extras.join('\n'));
console.log('wrote', rc, '+ bot-ports.extra with', 203, 'socks ports (19001..19203)');
