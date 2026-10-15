// tmp-solver-test.mjs — run the image captcha solver on saved puzzles + write annotated PNGs.
import fs from 'node:fs';
import sharp from 'sharp';
import { solveImageCaptcha } from './captcha-image.mjs';

const dir = 'E:/GitHub/lumivaraonline/aetheria/testbot/out/caps';
const picks = [
  'bot107-2026-10-13T21-50-48-210Z.webp',
  'bot102-2026-10-13T18-49-58-074Z.webp',
  'bot103-2026-10-14T00-50-57-706Z.webp',
];
fs.mkdirSync(dir + '/annotated', { recursive: true });

for (const f of picks) {
  const buf = fs.readFileSync(`${dir}/${f}`);
  const t0 = Date.now();
  const res = await solveImageCaptcha(buf, 480, 330);
  console.log(f, JSON.stringify(res), `${Date.now() - t0}ms`);
  if (!res.ok) continue;
  // annotate
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const p = (y * W + x) * C;
    data[p] = r; data[p + 1] = g; data[p + 2] = b;
  };
  const rect = (x0, y0, x1, y1, r, g, b, th = 2) => {
    for (let x = x0; x <= x1; x++) for (let t = 0; t < th; t++) { put(x, y0 + t, r, g, b); put(x, y1 - t, r, g, b); }
    for (let y = y0; y <= y1; y++) for (let t = 0; t < th; t++) { put(x0 + t, y, r, g, b); put(x1 - t, y, r, g, b); }
  };
  rect(res.frame.x0, res.frame.y0, res.frame.x1, res.frame.y1, 0, 255, 255);        // cyan = detected frame
  rect(res.cand.x, res.cand.y, res.cand.x + res.cand.w, res.cand.y + res.cand.h, 255, 0, 255); // magenta = chosen tile
  for (let d = -8; d <= 8; d++) { put(res.cx + d, res.cy, 255, 255, 0); put(res.cx, res.cy + d, 255, 255, 0); } // yellow crosshair = click point
  await sharp(data, { raw: { width: W, height: H, channels: C } }).png().toFile(`${dir}/annotated/${f}.png`);
}
console.log('annotated ->', dir + '/annotated');
