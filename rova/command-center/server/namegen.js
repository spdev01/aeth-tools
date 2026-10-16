// Giphy-style name generator (same lineage as the aetheria CC): Adjective + Noun (+ optional 2 digits).
// Character names: 3–16 chars, ^[A-Za-z0-9_]+$ — the ROVA names/check API is server-validated, so callers
// should retry on conflicts. Account usernames: lower-case a-z/0-9/_ only.
const ADJ = ['Swift', 'Jolly', 'Cosmic', 'Brave', 'Silent', 'Lucky', 'Amber', 'Frost', 'Sunny', 'Mellow', 'Nimble', 'Royal', 'Happy', 'Bold', 'Gentle', 'Wild', 'Bright', 'Calm', 'Epic', 'Merry', 'Proud', 'Quiet', 'Rapid', 'Shiny', 'Wise', 'Zesty', 'Kind', 'Noble', 'Sleek', 'Vivid'];
const NOUN = ['Falcon', 'Willow', 'Otter', 'Fox', 'Raven', 'Panda', 'Comet', 'Maple', 'Lynx', 'Heron', 'Bison', 'Cedar', 'Finch', 'Koala', 'Moth', 'Newt', 'Puma', 'Quail', 'Robin', 'Swan', 'Tiger', 'Viper', 'Wren', 'Yak', 'Badger', 'Crane', 'Dove', 'Gull', 'Hawk', 'Ibis'];

export function characterName({ withDigitsChance = 0.3 } = {}) {
  const adj = ADJ[Math.floor(Math.random() * ADJ.length)];
  const noun = NOUN[Math.floor(Math.random() * NOUN.length)];
  let name = adj + noun;
  if (Math.random() < withDigitsChance) name += String(Math.floor(Math.random() * 90) + 10);
  name = name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  if (name.length < 3) name = 'Bot' + String(Math.floor(Math.random() * 9000) + 1000);
  return name;
}

export function previewNames(n = 5) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(characterName());
  return out;
}

export function accountUsername() {
  const adj = ADJ[Math.floor(Math.random() * ADJ.length)];
  const noun = NOUN[Math.floor(Math.random() * NOUN.length)];
  let n = (adj + noun).toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (Math.random() < 0.5) n += String(Math.floor(Math.random() * 90) + 10);
  while (n.length < 6) n += String(Math.floor(Math.random() * 10));
  return n.slice(0, 16);
}

export function strongPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
