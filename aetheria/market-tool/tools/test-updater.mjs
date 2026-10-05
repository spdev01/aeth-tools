// Test harness for the Chrome updater script (simulates an end-user machine).
//   node tools/test-updater.mjs prep   -> create out-grep/upd-test with an OLD extension copy + substituted updater
//   node tools/test-updater.mjs check  -> verify the updater actually replaced the files
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const T = path.join(ROOT, 'out-grep', 'upd-test');
const SINK = 'http://127.0.0.1:4399';

const cmd = process.argv[2];
if (cmd === 'prep') {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(T, { recursive: true });
  // copy current dist/chrome as the "installed old version"
  fs.cpSync(path.join(ROOT, 'dist', 'chrome'), path.join(T, 'chrome'), { recursive: true });
  const mf = path.join(T, 'chrome', 'manifest.json');
  const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
  man.version = '0.2.0'; // pretend the user has an older build
  fs.writeFileSync(mf, JSON.stringify(man, null, 2));
  // substituted updater pointing at the local sink
  let upd = fs.readFileSync(path.join(ROOT, 'templates', 'update-chrome.ps1'), 'utf8');
  upd = upd.replace('__ZIP_URL__', `${SINK}/raw?path=market-tool/dist/aetheria-market-plus-chrome.zip`);
  upd = upd.replace('__VERSION_URL__', `${SINK}/raw?path=market-tool/dist/latest-version.txt`);
  upd = upd.replace('__VERSION__', '0.2.1');
  fs.writeFileSync(path.join(T, 'UPDATE-CHROME.ps1'), '\uFEFF' + upd, 'utf8');
  fs.copyFileSync(path.join(ROOT, 'templates', 'UPDATE-CHROME.cmd'), path.join(T, 'UPDATE-CHROME.cmd'));
  console.log('ready:', T);
  console.log('now run: powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(T, 'UPDATE-CHROME.ps1') + '"');
} else if (cmd === 'check') {
  const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  const local = JSON.parse(fs.readFileSync(path.join(T, 'chrome', 'manifest.json'), 'utf8')).version;
  const coreSame = sha1(path.join(T, 'chrome', 'core.js')) === sha1(path.join(ROOT, 'dist', 'chrome', 'core.js'));
  const distVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'chrome', 'manifest.json'), 'utf8')).version;
  console.log(JSON.stringify({ local, distVer, coreSame, updated: local === distVer && coreSame }, null, 1));
} else {
  console.log('usage: node tools/test-updater.mjs prep|check');
}
