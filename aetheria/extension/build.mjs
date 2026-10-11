// Build Chrome/Edge + Firefox/Zen distribution packages for the Aetheria Earnings Overlay.
//   cd aetheria/extension
//   node build.mjs
//
// Outputs (all under extension/dist/):
//   dist/chrome/   + dist/aetheria-earnings-chrome-v<ver>.zip    ← Edge/Chrome "Load unpacked"
//   dist/firefox/  + dist/aetheria-earnings-firefox-v<ver>.zip   ← Zen/Firefox temporary add-on / web-ext sign
//   dist/INSTALL-*.txt                                           ← guides to send alongside the zips
//
// Both packages ship the same source files; only the manifest differs:
//   chrome  ← manifest.json         (MV3 service worker)
//   firefox ← manifest.firefox.json (event page background + gecko settings — Firefox has no MV3 service workers)
// Version is stamped from the root manifest.json so the two can never drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from '../tools/zipdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const FILES = ['bg.js', 'content.js', 'page-hook.js', 'session.js'];
const PACKAGES = [
  { browser: 'chrome', manifest: 'manifest.json', guide: 'INSTALL-CHROME.txt' },
  { browser: 'firefox', manifest: 'manifest.firefox.json', guide: 'INSTALL-FIREFOX.txt' },
];

const rootManifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
const version = rootManifest.version;
if (!version) throw new Error('manifest.json has no version');

fs.mkdirSync(DIST, { recursive: true });
for (const { browser, manifest, guide } of PACKAGES) {
  const out = path.join(DIST, browser);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const m = JSON.parse(fs.readFileSync(path.join(HERE, manifest), 'utf8'));
  m.version = version; // stamp — single source of truth
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  for (const f of FILES) fs.copyFileSync(path.join(HERE, f), path.join(out, f));
  fs.cpSync(path.join(HERE, 'icons'), path.join(out, 'icons'), { recursive: true });
  if (fs.existsSync(path.join(HERE, guide))) fs.copyFileSync(path.join(HERE, guide), path.join(out, guide)); // guide rides inside too

  const zip = makeZip(out, path.join(DIST, `aetheria-earnings-${browser}-v${version}.zip`));
  console.log(`wrote dist/${browser}/ + ${path.basename(zip)}`);
}

// guides also at dist/ root, right next to the zips
for (const { guide } of PACKAGES) {
  const p = path.join(HERE, guide);
  if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(DIST, guide)); console.log('wrote dist/' + guide); }
}

console.log(`\nDone — v${version}`);
console.log(`  send to friends: aetheria-earnings-chrome-v${version}.zip + aetheria-earnings-firefox-v${version}.zip (guides included inside)`);
console.log('  dev load (Zen):        about:debugging#/runtime/this-firefox → Load Temporary Add-on… → dist/firefox/manifest.json');
console.log('  dev load (Edge/Chrome): edge://extensions → Load unpacked → dist/chrome/');
