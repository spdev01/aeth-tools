// scan testbot/out for any stored account credentials
import fs from 'node:fs';
const dir = 'e:/GitHub/lumivaraonline/aetheria/testbot/out';
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const raw = fs.readFileSync(`${dir}/${f}`, 'utf8');
    const j = JSON.parse(raw);
    const flat = JSON.stringify(j);
    if (/g_[a-z0-9]{8}/i.test(flat) || /userId|password/i.test(flat)) {
      console.log('FILE:', f);
      console.log('  ', flat.slice(0, 500));
    }
  } catch {}
}
console.log('--- done ---');
