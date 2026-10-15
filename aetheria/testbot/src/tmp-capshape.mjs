// tmp-capshape.mjs — raw human_check payload shapes for the new image-match captcha vs the old name type.
import fs from 'node:fs';
const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
for (const id of [101, 102, 103, 106, 107]) {
  const dir = `${BOTS}/${id}`;
  const files = fs.readdirSync(dir).filter((f) => /^run-.*\.jsonl$/.test(f)).sort();
  const seenShapes = new Set();
  for (const f of files) {
    const lines = fs.readFileSync(`${dir}/${f}`, 'utf8').split(/\r?\n/);
    for (const l of lines) {
      if (!l.includes('message:human_check')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const d = o.data ?? {};
      const keys = Object.keys(d).sort().join(',');
      const sig = keys + '|' + (Array.isArray(d.items) ? 'items:' + d.items.length : 'no-items') + '|' + (String(d.prompt ?? '').includes('เหมือนกับรูปในกรอบ') ? 'MATCH-TYPE' : 'NAME-TYPE');
      if (!seenShapes.has(sig)) {
        seenShapes.add(sig);
        console.log(`bot ${id} @ ${o.t} :: ${JSON.stringify(d).slice(0, 500)}`);
      }
    }
  }
}
