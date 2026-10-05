// Shared build versioning for all tools (Market+ and Command Center).
//
// Format: yy.mm.dd.hhmm   (leading zeros stripped per component)
//   e.g. 25.10.5.1430  ->  2025-10-05 14:30
//
// Why this shape: Chrome extension manifests allow up to 4 dot-separated
// integers (each <= 65535, no leading-zero components), and Firefox compares
// versions component-by-component numerically. yy-first keeps chronological
// ordering correct forever; a single "ddmmyyhhmm" number is invalid in Chrome.
//
// CLI:  node tools/version.mjs            -> 25.10.5.1430
//       node tools/version.mjs --display  -> 05/10/25 14:30
// Env:  VERSION=... to force a specific value.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function computeVersion(d = new Date()) {
  const yy = String(d.getFullYear()).slice(-2);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hhmm = d.getHours() * 100 + d.getMinutes();
  return `${yy}.${mm}.${dd}.${hhmm}`;
}

export function displayVersion(v) {
  const [yy, mm, dd, hhmm] = String(v).split('.');
  const h = Math.floor(Number(hhmm) / 100);
  const m = Number(hhmm) % 100;
  return `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${yy} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const v = process.env.VERSION || computeVersion();
  console.log(process.argv.includes('--display') ? displayVersion(v) : v);
}
