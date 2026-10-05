// Build Aetheria Market+ distribution artifacts.
//   node build.mjs
//
// Reads optional deploy.config.json (see deploy.config.example.json) for hosting URLs:
//   userscriptBase          -> @updateURL/@downloadURL in the userscript (auto-update)
//   firefoxUpdatesUrl       -> gecko.update_url in the Firefox/Zen manifest (auto-update)
//   chromeZipUrl            -> baked into UPDATE-CHROME.ps1 (one-click updater for zip installs)
//   chromeLatestVersionUrl  -> version beacon URL used by the updater
//   firefoxXpiUrlTemplate   -> used by tools/zen-updates.mjs (updates.json)
//
// Outputs (all under market-tool/):
//   aetheria-market-plus.user.js        (canonical userscript: header + core)
//   dist/userscript/                    dist/chrome/    dist/firefox/
//   dist/UPDATE-CHROME.ps1 + .cmd       (updater for Chrome zip installs)
//   dist/latest-version.txt             (version beacon to host)
//   dist/updates.json                   (if updates.json exists in repo root / template configured)
//   dist/aetheria-market-plus-*.zip     (for sharing)   dist/INSTALL-*.txt (guides)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

// 1) version from single source of truth (core.js)
const core = fs.readFileSync(path.join(HERE, 'core.js'), 'utf8');
const m = core.match(/const VERSION = '([0-9.]+)'/);
if (!m) throw new Error('VERSION not found in core.js');
const VERSION = m[1];
console.log('version:', VERSION);

// 2) optional deploy config (BOM-tolerant)
let cfg = {};
const cfgPath = path.join(HERE, 'deploy.config.json');
if (fs.existsSync(cfgPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    console.log('deploy.config.json loaded:', Object.keys(cfg).join(', ') || '(empty)');
  } catch (e) { console.warn('deploy.config.json unreadable (skipped):', String(e.message).split('\n')[0]); }
}

// 3) fresh dist
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'userscript'), { recursive: true });

// 4) userscript = header + core (stamped version, optional auto-update URLs)
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

// 5) extension folders (firefox gets update_url when configured)
for (const browser of ['chrome', 'firefox']) {
  const out = path.join(DIST, browser);
  fs.mkdirSync(out, { recursive: true });
  let manifest = fs.readFileSync(path.join(HERE, 'extension', `manifest.${browser}.json`), 'utf8').replace(/"version"\s*:\s*"[^"]+"/, `"version": "${VERSION}"`);
  if (browser === 'firefox' && cfg.firefoxUpdatesUrl) {
    manifest = manifest.replace(/"id": "([^"]+)",/, (s, id) => `"id": "${id}",\n      "update_url": "${cfg.firefoxUpdatesUrl}",`);
    console.log('firefox update_url injected:', cfg.firefoxUpdatesUrl);
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), manifest);
  fs.copyFileSync(path.join(HERE, 'core.js'), path.join(out, 'core.js'));
  fs.cpSync(path.join(HERE, 'extension', 'icons'), path.join(out, 'icons'), { recursive: true });
  console.log('wrote dist/' + browser + '/');
}

// 6) Chrome one-click updater (for zip/"Load unpacked" users)
const upTpl = path.join(HERE, 'templates', 'update-chrome.ps1');
if (fs.existsSync(upTpl)) {
  let upd = fs.readFileSync(upTpl, 'utf8');
  upd = upd.replace('__ZIP_URL__', cfg.chromeZipUrl || 'TODO-set-chromeZipUrl-in-deploy.config.json');
  upd = upd.replace('__VERSION_URL__', cfg.chromeLatestVersionUrl || 'TODO-set-chromeLatestVersionUrl-in-deploy.config.json');
  upd = upd.replace('__VERSION__', VERSION);
  fs.writeFileSync(path.join(DIST, 'UPDATE-CHROME.ps1'), '\uFEFF' + upd, 'utf8'); // BOM: Thai text in PS 5.1
  fs.copyFileSync(path.join(HERE, 'templates', 'UPDATE-CHROME.cmd'), path.join(DIST, 'UPDATE-CHROME.cmd'));
  console.log('wrote dist/UPDATE-CHROME.ps1 + .cmd' + (cfg.chromeZipUrl ? '' : '  [URLs are TODO — set deploy.config.json before distributing]'));
}

// 7) version beacon + Firefox updates.json
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

// 8) zips (Windows: PowerShell Compress-Archive)
for (const browser of ['chrome', 'firefox']) {
  const zip = path.join(DIST, `aetheria-market-plus-${browser}.zip`);
  try {
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${path.join(DIST, browser)}\\*' -DestinationPath '${zip}' -Force"`, { stdio: 'pipe' });
    console.log('wrote', zip);
  } catch (e) {
    console.warn('zip step failed (missing zip tooling?) — folder output is still usable:', String(e.message).split('\n')[0]);
  }
}

// 9) end-user install guides alongside the artifacts
for (const g of ['INSTALL-TH.txt', 'INSTALL-ZEN.txt', 'INSTALL-CHROME.txt']) {
  const guide = path.join(HERE, g);
  if (fs.existsSync(guide)) { fs.copyFileSync(guide, path.join(DIST, g)); console.log('wrote dist/' + g); }
}

console.log('\nDone. Upload dist/ contents to your host (see README → Auto-update).');
