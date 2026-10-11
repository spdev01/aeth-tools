// make-icons.mjs — generates the extension icons (PNG, no dependencies — zlib + hand-rolled chunks).
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const OUT = 'E:/GitHub/lumivaraonline/aetheria/extension/icons';
fs.mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const png = (w, h, rgba) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

const make = (S) => {
  const px = Buffer.alloc(S * S * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const o = (y * S + x) * 4;
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = a;
  };
  // dark rounded-ish background
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const edge = Math.min(x, y, S - 1 - x, S - 1 - y);
      set(x, y, 13, 16, 22, edge === 0 ? 80 : 255);
    }
  }
  // bars
  const m = Math.max(2, Math.round(S * 0.22));
  const base = S - m;
  const bw = Math.max(2, Math.round(S * 0.2));
  const gap = Math.max(1, Math.round(S * 0.12));
  const x1 = Math.round(S / 2 - bw - gap / 2);
  const x2 = x1 + bw + gap;
  const h1 = Math.round((S - 2 * m) * 0.55);
  const h2 = Math.round((S - 2 * m) * 0.85);
  for (let y = base - h1; y < base; y++) for (let x = x1; x < x1 + bw; x++) set(x, y, 63, 174, 111);
  for (let y = base - h2; y < base; y++) for (let x = x2; x < x2 + bw; x++) set(x, y, 76, 139, 245);
  // baseline
  for (let x = m - 2; x <= S - m + 1; x++) {
    set(x, base, 150, 170, 200);
    set(x, base + 1, 150, 170, 200);
  }
  const buf = png(S, S, px);
  fs.writeFileSync(path.join(OUT, `icon${S}.png`), buf);
  return buf.length;
};

for (const S of [16, 32, 48, 128]) console.log(`icon${S}.png`, make(S), 'bytes');
