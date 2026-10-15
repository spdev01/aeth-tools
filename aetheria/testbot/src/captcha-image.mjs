// captcha-image.mjs — solver for the image-match captcha ("กดรูปด้านล่างที่เหมือนกับรูปในกรอบ").
// Decodes the webp, finds the yellow reference frame, then searches the lower region
// for the tile that best matches (ZNCC multi-scale template match). Returns click coords.
import sharp from 'sharp';

/** Grayscale float copy of a raw RGB(A) buffer. */
function toGray(data, W, H, C) {
  const g = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += C) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return g;
}

/** Find the yellow rounded frame; returns {x0,y0,x1,y1} or null. */
function findYellowFrame(data, W, H, C) {
  const m = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += C) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    if (r > 170 && g > 120 && b < 160 && r - b > 55 && g - b > 25) m[i] = 1;
  }
  // largest connected component (iterative flood fill, 8-neigh)
  const seen = new Uint8Array(W * H);
  let best = null, bestN = 0;
  const stack = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!m[i] || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    while (sp) {
      const q = stack[--sp]; n++;
      const x = q % W, y = (q / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx;
        if (m[k] && !seen[k]) { seen[k] = 1; stack[sp++] = k; }
      }
    }
    if (n > bestN) { bestN = n; best = { x0, y0, x1, y1, n }; }
  }
  return best;
}

/** ZNCC of patch (pg) at every position in region; coarse step then refine. Returns top hits. */
function znccSearch(pg, pw, ph, sg, W, H, region, step) {
  const pn = pw * ph;
  let pm = 0; for (let i = 0; i < pn; i++) pm += pg[i]; pm /= pn;
  let pv = 0; const pd = new Float32Array(pn);
  for (let i = 0; i < pn; i++) { pd[i] = pg[i] - pm; pv += pd[i] * pd[i]; }
  const pstd = Math.sqrt(pv) + 1e-6;
  const hits = [];
  for (let y = region.y0; y <= region.y1 - ph; y += step) {
    for (let x = region.x0; x <= region.x1 - pw; x += step) {
      let sm = 0;
      for (let yy = 0; yy < ph; yy++) { const o = (y + yy) * W + x; for (let xx = 0; xx < pw; xx++) sm += sg[o + xx]; }
      sm /= pn;
      let num = 0, sv = 0;
      for (let yy = 0; yy < ph; yy++) {
        const o = (y + yy) * W + x, po = yy * pw;
        for (let xx = 0; xx < pw; xx++) {
          const d = sg[o + xx] - sm;
          num += pd[po + xx] * d; sv += d * d;
        }
      }
      const score = num / (pstd * (Math.sqrt(sv) + 1e-6));
      hits.push({ x, y, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

/** Main: returns {ok, x, y, score, margin, frame, cand, W, H, dbg} in image pixel space. */
export async function solveImageCaptcha(imgBuf, declaredW, declaredH) {
  const { data, info } = await sharp(imgBuf).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels;
  const gray = toGray(data, W, H, C);
  const frame = findYellowFrame(data, W, H, C);
  if (!frame) return { ok: false, reason: 'no_frame', W, H };
  // reference patch = central chunk of the frame interior (60%)
  const fw = frame.x1 - frame.x0 + 1, fh = frame.y1 - frame.y0 + 1;
  const ix0 = frame.x0 + Math.round(fw * 0.25), iy0 = frame.y0 + Math.round(fh * 0.25);
  const iw = Math.max(8, Math.round(fw * 0.5)), ih = Math.max(8, Math.round(fh * 0.5));
  const pg = new Float32Array(iw * ih);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) pg[y * iw + x] = gray[(iy0 + y) * W + (ix0 + x)];
  // search whole image except the frame area (expand ref box a bit)
  const region = { x0: 4, x1: W - 4, y0: Math.max(4, frame.y1 + 12), y1: H - 4 };
  if (region.y1 - region.y0 < ih + 8) return { ok: false, reason: 'region_too_small', W, H, frame };
  let best = null;
  for (const s of [0.6, 0.75, 0.9, 1.0, 1.15, 1.35, 1.6]) {
    const sw = Math.max(8, Math.round(iw * s)), sh = Math.max(8, Math.round(ih * s));
    if (sw >= region.x1 - region.x0 || sh >= region.y1 - region.y0) continue;
    const sp = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sp[y * sw + x] = pg[Math.min(ih - 1, (y / s) | 0) * iw + Math.min(iw - 1, (x / s) | 0)];
    const hits = znccSearch(sp, sw, sh, gray, W, H, region, 3);
    const h = hits[0];
    if (!h) continue;
    if (!best || h.score > best.score) best = { ...h, s, sw, sh };
  }
  if (!best) return { ok: false, reason: 'no_hit', W, H, frame };
  // refine around best at step 1
  const r2 = {
    x0: Math.max(region.x0, best.x - 4), x1: Math.min(region.x1, best.x + best.sw + 4),
    y0: Math.max(region.y0, best.y - 4), y1: Math.min(region.y1, best.y + best.sh + 4),
  };
  const sp2 = new Float32Array(best.sw * best.sh);
  for (let y = 0; y < best.sh; y++) for (let x = 0; x < best.sw; x++) sp2[y * best.sw + x] = pg[Math.min(ih - 1, (y / best.s) | 0) * iw + Math.min(iw - 1, (x / best.s) | 0)];
  const fine = znccSearch(sp2, best.sw, best.sh, gray, W, H, r2, 1)[0] || best;
  // margin vs best hit outside a widened neighborhood + up to 3 alternate spots (retry ladder)
  let second = -2;
  const alts = [];
  {
    const guard = Math.round(Math.max(best.sw, best.sh) * 1.2);
    const hits2 = znccSearch(sp2, best.sw, best.sh, gray, W, H, region, 6);
    for (const h of hits2) {
      if (Math.abs(h.x - fine.x) <= guard && Math.abs(h.y - fine.y) <= guard) continue;
      if (second < -1) second = h.score;
      if (alts.length < 3) alts.push({
        x: Math.round((((h.x + best.sw / 2) / W) * (declaredW || W))),
        y: Math.round((((h.y + best.sh / 2) / H) * (declaredH || H))),
        score: +h.score.toFixed(4),
      });
    }
  }
  const cx = fine.x + Math.round(best.sw / 2), cy = fine.y + Math.round(best.sh / 2);
  // map to declared coordinate space
  const dx = Math.round((cx / W) * (declaredW || W)), dy = Math.round((cy / H) * (declaredH || H));
  return {
    ok: true, x: dx, y: dy, cx, cy, score: +fine.score.toFixed(4), margin: +(fine.score - second).toFixed(4), alts,
    frame, cand: { x: fine.x, y: fine.y, w: best.sw, h: best.sh, scale: best.s }, W, H,
  };
}
