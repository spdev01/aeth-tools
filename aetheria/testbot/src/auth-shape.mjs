// How does login/upgrade/guest auth work in the game client?
import fs from 'node:fs';
const c = fs.readFileSync('e:/GitHub/lumivaraonline/aetheria/index-main.js', 'utf8');
const show = (label, m, back = 250, len = 700) => {
  const i = c.indexOf(m);
  console.log(`\n=== ${label} @ ${i} ===`);
  if (i >= 0) console.log(c.substring(Math.max(0, i - back), Math.max(0, i - back) + len).replace(/\s+/g, ' '));
};
show('auth/login call', 'auth/login');
show('auth/guest call', 'auth/guest');
show('auth/upgrade call', 'auth/upgrade');
show('localStorage guest key', 'localStorage');
// find storage keys containing auth/token
const keys = [...new Set([...c.matchAll(/`([a-z_\-.]*(?:token|auth|guest|session)[a-z_\-.]*)`/gi)].map((m) => m[1]))];
console.log('\nstorage-ish keys:', keys.slice(0, 20).join(', '));
