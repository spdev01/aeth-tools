// tmp-extract-cap.mjs — pull the base64 captcha images out of the run logs for inspection.
import fs from 'node:fs';
const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const OUT = 'E:/GitHub/lumivaraonline/aetheria/testbot/out/caps';
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const id of [102, 103, 107]) {
  const dir = `${BOTS}/${id}`;
  for (const f of fs.readdirSync(dir).filter((x) => /^run-.*\.jsonl$/.test(x))) {
    for (const l of fs.readFileSync(`${dir}/${f}`, 'utf8').split(/\r?\n/)) {
      if (!l.includes('"image":"data:image/webp')) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      const b64 = String(o.data?.image ?? '').replace(/^data:image\/webp;base64,/, '');
      if (!b64) continue;
      const buf = Buffer.from(b64, 'base64');
      const name = `bot${id}-${String(o.t).replace(/[:.]/g, '-')}.webp`;
      fs.writeFileSync(`${OUT}/${name}`, buf);
      console.log(`${name}  bytes=${buf.length}  id=${o.data?.id}  prompt=${JSON.stringify(o.data?.prompt).slice(0, 60)}`);
      n++;
    }
  }
}
console.log('total extracted:', n);
