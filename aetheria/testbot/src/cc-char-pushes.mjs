// Print every 'character' + 'inventory' + 'item_used' push in the window, with the important fields
import fs from 'node:fs';
import { decodeMulti } from '@msgpack/msgpack';
const FILE = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-epic-frames.jsonl';
const since = Date.now() - 30 * 60 * 1000;
const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.kind !== 'frames') continue;
  for (const f of o.items ?? []) {
    if (f.at < since) continue;
    const buf = Buffer.from(f.b, 'base64');
    if (buf[0] !== 0x0d) continue;
    try {
      const p = [...decodeMulti(buf.subarray(1))];
      const type = String(p[0]);
      const ts = new Date(f.at).toISOString().slice(11, 23);
      if (f.dir !== 'in') continue;
      if (type === 'character') {
        const d = p[1];
        console.log(ts, 'CHAR', d.className, 'lv' + d.baseLevel, '| statPts', d.statusPoints, '| STR', d.stats?.STR, 'AGI', d.stats?.AGI, '| auto', JSON.stringify({ enabled: d.auto?.enabled, hpItems: d.auto?.config?.hpItems, skills: d.auto?.config?.skills }));
      } else if (type === 'inventory') {
        const d = p[1];
        console.log(ts, 'INV', 'weight', d.weight + '/' + d.weightLimit, 'items:', (d.items ?? []).map((i) => (i.name ?? i.itemId) + 'x' + (i.qty ?? 1)).slice(0, 8).join(', '));
      } else if (type === 'item_used') {
        console.log(ts, 'ITEM_USED', JSON.stringify(p[1]));
      }
    } catch {}
  }
}
