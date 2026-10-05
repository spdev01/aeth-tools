// Generate extension icons (pure-node PNG writer — no deps)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'extension', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= size || y >= size) return; const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  const rect = (x0, y0, x1, y1, r, g, b) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, r, g, b); };
  rect(0, 0, size - 1, size - 1, 0x12, 0x18, 0x26);          // dark bg
  const bd = Math.max(1, Math.round(size * 0.055));          // gold border
  rect(0, 0, size - 1, bd - 1, 0xc9, 0xa4, 0x5c); rect(0, size - bd, size - 1, size - 1, 0xc9, 0xa4, 0x5c);
  rect(0, 0, bd - 1, size - 1, 0xc9, 0xa4, 0x5c); rect(size - bd, 0, size - 1, size - 1, 0xc9, 0xa4, 0x5c);
  const th = Math.max(2, Math.round(size * 0.16));           // gold plus
  const arm = Math.round(size * 0.62);
  const a0 = Math.round((size - arm) / 2), a1 = Math.round((size + arm) / 2) - 1;
  const m0 = Math.round((size - th) / 2), m1 = Math.round((size + th) / 2) - 1;
  rect(a0, m0, a1, m1, 0xff, 0xd1, 0x66);
  rect(m0, a0, m1, a1, 0xff, 0xd1, 0x66);
  return png(size, size, px);
}
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(OUT, `icon${s}.png`), draw(s));
  console.log('wrote', path.join(OUT, `icon${s}.png`));
}
