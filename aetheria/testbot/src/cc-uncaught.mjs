import fs from 'node:fs';
const p = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots/' + (process.argv[2] || '58');
const files = fs.readdirSync(p).filter((x) => x.startsWith('run-')).sort();
for (const f of files.reverse()) {
  const lines = fs.readFileSync(p + '/' + f, 'utf8').trim().split('\n');
  const un = lines.filter((l) => l.includes('UNCAUGHT')).pop();
  if (un) { console.log('# ' + f); console.log(JSON.parse(un).data); process.exit(0); }
}
console.log('no UNCAUGHT anywhere');
