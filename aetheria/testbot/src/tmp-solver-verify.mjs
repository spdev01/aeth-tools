// tmp-solver-verify.mjs — side-by-side ref (frame) vs chosen candidate, upscaled, for visual proof.
import fs from 'node:fs';
import sharp from 'sharp';
import { solveImageCaptcha } from './captcha-image.mjs';

const dir = 'E:/GitHub/lumivaraonline/aetheria/testbot/out/caps';
const picks = [
  'bot107-2026-10-13T21-50-48-210Z.webp',
  'bot102-2026-10-13T18-49-58-074Z.webp',
  'bot103-2026-10-14T00-50-57-706Z.webp',
];
for (const f of picks) {
  const buf = fs.readFileSync(`${dir}/${f}`);
  const res = await solveImageCaptcha(buf, 480, 330);
  if (!res.ok) { console.log(f, 'FAIL', JSON.stringify(res)); continue; }
  const meta = await sharp(buf).metadata();
  const pad = 8;
  const refX = Math.max(0, res.frame.x0 - pad), refY = Math.max(0, res.frame.y0 - pad);
  const refW = Math.min(meta.width - refX, res.frame.x1 - res.frame.x0 + 1 + pad * 2);
  const refH = Math.min(meta.height - refY, res.frame.y1 - res.frame.y0 + 1 + pad * 2);
  const candX = Math.max(0, res.cand.x - pad), candY = Math.max(0, res.cand.y - pad);
  const candW = Math.min(meta.width - candX, res.cand.w + pad * 2);
  const candH = Math.min(meta.height - candY, res.cand.h + pad * 2);
  const H = 200;
  const a = await sharp(buf).extract({ left: refX, top: refY, width: refW, height: refH }).resize({ height: H, kernel: 'nearest' }).png().toBuffer();
  const b = await sharp(buf).extract({ left: candX, top: candY, width: candW, height: candH }).resize({ height: H, kernel: 'nearest' }).png().toBuffer();
  const aw = (await sharp(a).metadata()).width, bw = (await sharp(b).metadata()).width;
  await sharp({ create: { width: aw + bw + 6, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: a, left: 0, top: 0 }, { input: b, left: aw + 6, top: 0 }])
    .png().toFile(`${dir}/annotated/verify-${f.split('-')[0]}.png`);
  console.log(f.split('-')[0], `score=${res.score} margin=${res.margin} candScale=${res.cand.scale} -> verify-${f.split('-')[0]}.png`);
}
