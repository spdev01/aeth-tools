// Build Aetheria Market+ distribution artifacts.
//   node build.mjs
//
// Version: auto = yy.mm.dd.hhmm at build time (override with MARKETPLUS_VERSION env).
// Hosting URLs: deploy.config.json (see deploy.config.example.json), or derived from
// DEPLOY_BASE env (used by CI), e.g. DEPLOY_BASE=https://user.github.io/repo
//
// Outputs (all under market-tool/):
//   aetheria-market-plus.user.js        (canonical userscript: header + core)
//   dist/userscript/                    dist/chrome/    dist/firefox/
//   dist/UPDATE-CHROME.ps1 + .cmd       (updater for Chrome zip installs)
//   dist/latest-version.txt             (version beacon to host)
//   dist/updates.json                   (Firefox/Zen update manifest, if configured)
//   dist/aetheria-market-plus-*.zip     (for sharing)   dist/INSTALL-*.txt (guides)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion, displayVersion } from '../tools/version.mjs';
import { makeZip } from '../tools/zipdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

// 1) version
const VERSION = process.env.MARKETPLUS_VERSION || computeVersion();
console.log('version:', VERSION, '(' + displayVersion(VERSION) + ')');

// 2) hosting config: DEPLOY_BASE env sets defaults; deploy.config.json overrides
let cfg = {};
const cfgPath = path.join(HERE, 'deploy.config.json');
if (fs.existsSync(cfgPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    console.log('deploy.config.json loaded:', Object.keys(cfg).join(', ') || '(empty)');
  } catch (e) { console.warn('deploy.config.json unreadable (skipped):', String(e.message).split('\n')[0]); }
}
if (process.env.DEPLOY_BASE) {
  const base = String(process.env.DEPLOY_BASE).replace(/\/$/, '');
  cfg = {
    userscriptBase: base,
    chromeZipUrl: base + '/aetheria-market-plus-chrome.zip',
    chromeLatestVersionUrl: base + '/latest-version.txt',
    firefoxUpdatesUrl: base + '/updates.json',
    firefoxXpiUrlTemplate: base + '/aetheria-market-plus-{version}.xpi',
    ...cfg,
  };
  console.log('DEPLOY_BASE:', base);
}

// 3) stamp VERSION into the core used by all shipped copies
const core = fs.readFileSync(path.join(HERE, 'core.js'), 'utf8').replace(/const VERSION = '[^']*'/, `const VERSION = '${VERSION}'`);

// 4) fresh dist
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'userscript'), { recursive: true });

// 5) userscript = header + core (stamped)
let header = fs.readFileSync(path.join(HERE, 'userscript.header.txt'), 'utf8').replace(/@version\s+\S+/, `@version      ${VERSION}`);
if (cfg.userscriptBase) {
  const base = String(cfg.userscriptBase).replace(/\/$/, '');
  header = header.replace('// ==/UserScript==', `// @updateURL    ${base}/aetheria-market-plus.user.js\n// @downloadURL  ${base}/aetheria-market-plus.user.js\n// ==/UserScript==`);
  console.log('userscript auto-update URLs injected:', base);
}
const userscript = header + '\n' + core;
fs.writeFileSync(path.join(DIST, 'userscript', 'aetheria-market-plus.user.js'), userscript);
fs.writeFileSync(path.join(HERE, 'aetheria-market-plus.user.js'), userscript);
console.log('wrote userscript (header + core)');

// 6) extension folders (firefox gets update_url when configured)
for (const browser of ['chrome', 'firefox']) {
  const out = path.join(DIST, browser);
  fs.mkdirSync(out, { recursive: true });
  let manifest = fs.readFileSync(path.join(HERE, 'extension', `manifest.${browser}.json`), 'utf8').replace(/"version"\s*:\s*"[^"]+"/, `"version": "${VERSION}"`);
  if (browser === 'firefox' && cfg.firefoxUpdatesUrl) {
    manifest = manifest.replace(/"id": "([^"]+)",/, (s, id) => `"id": "${id}",\n      "update_url": "${cfg.firefoxUpdatesUrl}",`);
    console.log('firefox update_url injected:', cfg.firefoxUpdatesUrl);
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(out, 'core.js'), core);
  fs.cpSync(path.join(HERE, 'extension', 'icons'), path.join(out, 'icons'), { recursive: true });
  console.log('wrote dist/' + browser + '/');
}

// 7) Chrome one-click updater (for zip/"Load unpacked" users)
const upTpl = path.join(HERE, 'templates', 'update-chrome.ps1');
if (fs.existsSync(upTpl)) {
  let upd = fs.readFileSync(upTpl, 'utf8');
  upd = upd.replace('__ZIP_URL__', cfg.chromeZipUrl || 'TODO-set-chromeZipUrl-in-deploy.config.json');
  upd = upd.replace('__VERSION_URL__', cfg.chromeLatestVersionUrl || 'TODO-set-chromeLatestVersionUrl-in-deploy.config.json');
  upd = upd.replace('__VERSION__', VERSION);
  fs.writeFileSync(path.join(DIST, 'UPDATE-CHROME.ps1'), '\uFEFF' + upd, 'utf8'); // BOM: Thai text in PS 5.1
  fs.copyFileSync(path.join(HERE, 'templates', 'UPDATE-CHROME.cmd'), path.join(DIST, 'UPDATE-CHROME.cmd'));
  console.log('wrote dist/UPDATE-CHROME.ps1 + .cmd' + (cfg.chromeZipUrl ? '' : '  [URLs are TODO — set deploy.config.json or DEPLOY_BASE]'));
}

// 8) version beacon + Firefox updates.json
fs.writeFileSync(path.join(DIST, 'latest-version.txt'), VERSION + '\n');
const updatesFile = path.join(HERE, 'updates.json');
if (fs.existsSync(updatesFile)) {
  fs.copyFileSync(updatesFile, path.join(DIST, 'updates.json'));
  console.log('wrote dist/updates.json (from repo updates.json)');
} else if (cfg.firefoxXpiUrlTemplate) {
  const doc = { addons: { 'market-plus@lumivara.online': { updates: [{ version: VERSION, update_link: cfg.firefoxXpiUrlTemplate.replace('{version}', VERSION) }] } } };
  fs.writeFileSync(path.join(DIST, 'updates.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  console.log('wrote dist/updates.json (starter)');
}

// 9) zips
for (const browser of ['chrome', 'firefox']) {
  try {
    console.log('wrote', makeZip(path.join(DIST, browser), path.join(DIST, `aetheria-market-plus-${browser}.zip`)));
  } catch (e) {
    console.warn('zip step failed — folder output is still usable:', String(e.message).split('\n')[0]);
  }
}

// 10) end-user install guides alongside the artifacts
for (const g of ['INSTALL-TH.txt', 'INSTALL-ZEN.txt', 'INSTALL-CHROME.txt']) {
  const guide = path.join(HERE, g);
  if (fs.existsSync(guide)) { fs.copyFileSync(guide, path.join(DIST, g)); console.log('wrote dist/' + g); }
}

console.log('\nDone. version', VERSION);
