// Build the Aetheria Command Center release package (zip + updater + version beacon).
//   node tools/build-release.mjs
//
// Version: auto = yy.mm.dd.hhmm (override with CC_VERSION env).
// Updater URLs: CC_ZIP_URL / CC_VERSION_URL env (set by CI from the Pages base):
//   e.g. CC_ZIP_URL=https://user.github.io/repo/command-center/aetheria-command-center.zip
//
// Outputs (aetheria/command-center/release/):
//   aetheria-command-center/aetheria-command-center.zip   (app + UPDATE-CC.cmd/.ps1 + guide)
//   aetheria-command-center/version.txt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion, displayVersion } from '../../tools/version.mjs';
import { makeZip } from '../../tools/zipdir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');              // aetheria/command-center
const RELEASE = path.join(ROOT, 'release');
const STAGE = path.join(RELEASE, 'aetheria-command-center');

const VERSION = process.env.CC_VERSION || computeVersion();
console.log('version:', VERSION, '(' + displayVersion(VERSION) + ')');

const ZIP_URL = process.env.CC_ZIP_URL || 'TODO-set-CC_ZIP_URL';
const VERSION_URL = process.env.CC_VERSION_URL || 'TODO-set-CC_VERSION_URL';

// fresh stage
fs.rmSync(RELEASE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// app files (exclude node_modules / data / release)
const appFiles = ['server', 'public'];
const appTopFiles = ['package.json', 'package-lock.json', 'cc.mjs', 'cccheck.mjs', 'ccmon.mjs', 'smoke.mjs', 'test-guest.mjs', 'test-register.mjs'];
for (const d of appFiles) fs.cpSync(path.join(ROOT, d), path.join(STAGE, d), { recursive: true });
for (const f of appTopFiles) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(STAGE, f));
}

// stamp version into the packaged package.json
const pkgPath = path.join(STAGE, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = VERSION;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

// updater scripts + Thai guide
for (const f of ['UPDATE-CC.ps1', 'UPDATE-CC.cmd', 'INSTALL-CC.txt']) {
  const p = path.join(ROOT, 'templates', f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(STAGE, f));
  else if (f === 'INSTALL-CC.txt') {
    const g = path.join(ROOT, f);
    if (fs.existsSync(g)) fs.copyFileSync(g, path.join(STAGE, f));
  }
}
let upd = fs.readFileSync(path.join(ROOT, 'templates', 'UPDATE-CC.ps1'), 'utf8');
upd = upd.replace('__ZIP_URL__', ZIP_URL).replace('__VERSION_URL__', VERSION_URL).replace('__VERSION__', VERSION);
fs.writeFileSync(path.join(STAGE, 'UPDATE-CC.ps1'), '\uFEFF' + upd, 'utf8'); // BOM for Thai in PS 5.1

// version beacon + zip
fs.writeFileSync(path.join(RELEASE, 'version.txt'), VERSION + '\n');
const zip = makeZip(STAGE, path.join(RELEASE, 'aetheria-command-center.zip'));

console.log('wrote', zip);
console.log('wrote', path.join(RELEASE, 'version.txt'));
console.log('\nDone. version', VERSION);
