// tmp-freshbundle.mjs — fetch the LIVE game bundle, find the image-match captcha renderer + dimensions of saved puzzles.
import fs from 'node:fs';

const OUT = process.env.TEMP + '/aetheria-bundle3.js';
if (!fs.existsSync(OUT)) {
  const page = await (await fetch('https://www.aetheria-online.in.th/play')).text();
  const srcs = [...page.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
  console.log('script srcs in page:', srcs.join(', ').slice(0, 300));
  let bundleText = null, used = null;
  for (const s of srcs) {
    const url = s.startsWith('http') ? s : 'https://www.aetheria-online.in.th' + (s.startsWith('/') ? s : '/' + s);
    try {
      const t = await (await fetch(url)).text();
      if (t.length > 500000 && /human_check/.test(t)) { bundleText = t; used = url; break; }
    } catch (e) { console.log('fetch fail', url, String(e.message).slice(0, 80)); }
  }
  if (!bundleText) { console.log('BUNDLE NOT FOUND'); process.exit(1); }
  fs.writeFileSync(OUT, bundleText);
  console.log('bundle:', used, bundleText.length, 'chars');
}
const b = fs.readFileSync(OUT, 'utf8');

// find the new image-match captcha UI
for (const p of ['เหมือนกับรูปในกรอบ', 'human-check-img', 'humanCheck.image', '.image&&J.answerHumanCheck', 'answerHumanCheck']) {
  const idx = [];
  let i = b.indexOf(p);
  while (i >= 0 && idx.length < 3) { idx.push(i); i = b.indexOf(p, i + 1); }
  console.log(`===== ${p} (${idx.length} shown) =====`);
  for (const j of idx) {
    console.log(b.slice(Math.max(0, j - 800), j + 500).replace(/\n/g, ' ').slice(0, 1300));
    console.log('-----');
  }
}

// dimensions of the saved puzzles (VP8 lossy + VP8L parsing)
console.log('===== puzzle dims =====');
for (const f of fs.readdirSync('E:/GitHub/lumivaraonline/aetheria/testbot/out/caps')) {
  const buf = fs.readFileSync('E:/GitHub/lumivaraonline/aetheria/testbot/out/caps/' + f);
  let w = null, h = null;
  const vi = buf.indexOf(Buffer.from('VP8 '));
  const li = buf.indexOf(Buffer.from('VP8L'));
  if (li >= 0) { const bits = buf.readUInt32LE(li + 5); w = (bits & 0x3fff) + 1; h = ((bits >> 14) & 0x3fff) + 1; }
  else if (vi >= 0) { w = buf.readUInt16LE(vi + 10 + 0) & 0x3fff; h = buf.readUInt16LE(vi + 12) & 0x3fff; }
  console.log(`${f}  ${w}x${h}`);
  if (f.includes('bot102')) break; // one sample is enough for dims
}
