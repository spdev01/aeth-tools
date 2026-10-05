// Assemble the GitHub Pages site (_site/) from built artifacts + site pages.
//   node tools/assemble-site.mjs
//
// Inputs:
//   aetheria/market-tool/dist/         (built by market-tool/build.mjs)
//   aetheria/command-center/release/   (built by command-center/tools/build-release.mjs)
//   aetheria/site/                     (gated pages: index, guides)
//   XPI_DIR env (optional)             (web-ext-artifacts dir with signed .xpi)
//   SITE_VERSION env (optional)        (display only)
//
// Layout (stable URLs for auto-updaters stay un-gated):
//   /index.html /market-watch.html /command-center.html   (password-gated pages)
//   /aetheria-market-plus-chrome.zip  /aetheria-market-plus-bundle.zip
//   /aetheria-market-plus.user.js     /latest-version.txt  /updates.json  (+ xpi)
//   /command-center/aetheria-command-center.zip  /command-center/version.txt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './zipdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');           // repo root (lumivaraonline)
const AETHERIA = path.join(REPO, 'aetheria');
const MARKET = path.join(AETHERIA, 'market-tool');
const CC = path.join(AETHERIA, 'command-center');
const SITE_SRC = path.join(AETHERIA, 'site');
const SITE = path.join(REPO, '_site');

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };

// --- Market+ (root, un-gated — updaters and installers fetch these directly)
const mDist = path.join(MARKET, 'dist');
for (const f of ['aetheria-market-plus-chrome.zip', 'aetheria-market-plus-firefox.zip', 'latest-version.txt', 'updates.json']) {
  const p = path.join(mDist, f);
  if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(SITE, f)); console.log('site:', f); }
}
const us = path.join(mDist, 'userscript', 'aetheria-market-plus.user.js');
if (fs.existsSync(us)) { fs.copyFileSync(us, path.join(SITE, 'aetheria-market-plus.user.js')); console.log('site: aetheria-market-plus.user.js'); }

// --- recommended starter bundle: chrome/ folder + updater + guide (updater expects sibling "chrome")
const bundle = path.join(SITE, '_bundle', 'aetheria-market-plus');
cp(path.join(mDist, 'chrome'), path.join(bundle, 'chrome'));
for (const f of ['UPDATE-CHROME.ps1', 'UPDATE-CHROME.cmd', 'INSTALL-CHROME.txt', 'INSTALL-TH.txt']) {
  const p = path.join(mDist, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(bundle, f));
}
makeZip(bundle, path.join(SITE, 'aetheria-market-plus-bundle.zip'));
fs.rmSync(path.join(SITE, '_bundle'), { recursive: true, force: true });
console.log('site: aetheria-market-plus-bundle.zip');

// --- signed Zen xpi (optional)
const xpiDir = process.env.XPI_DIR ? path.resolve(REPO, process.env.XPI_DIR) : null;
if (xpiDir && fs.existsSync(xpiDir)) {
  for (const f of fs.readdirSync(xpiDir)) {
    if (f.endsWith('.xpi')) { fs.copyFileSync(path.join(xpiDir, f), path.join(SITE, f)); console.log('site:', f); }
  }
}

// --- Command Center (zip + version beacon only — not the uncompressed staging copy)
const ccRelease = path.join(CC, 'release');
if (fs.existsSync(ccRelease)) {
  const outCC = path.join(SITE, 'command-center');
  fs.mkdirSync(outCC, { recursive: true });
  for (const f of ['aetheria-command-center.zip', 'version.txt']) {
    const p = path.join(ccRelease, f);
    if (fs.existsSync(p)) { fs.copyFileSync(p, path.join(outCC, f)); console.log('site: command-center/' + f); }
  }
}

// --- gated pages last (copied over everything; index.html etc.)
if (fs.existsSync(SITE_SRC)) cp(SITE_SRC, SITE);

console.log('\n_site assembled at', SITE);
console.log('version footer:', process.env.SITE_VERSION || '(env SITE_VERSION not set)');
