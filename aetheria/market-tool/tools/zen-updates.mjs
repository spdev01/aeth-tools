// Maintain updates.json for the self-distributed Firefox/Zen extension.
//   node tools/zen-updates.mjs --url-template "https://host/path/aetheria-market-plus-{version}.xpi" [--out dist/updates.json]
// Or set "firefoxXpiUrlTemplate" in deploy.config.json and just run: node tools/zen-updates.mjs
// After signing a new xpi (web-ext sign), run this to add its entry; host updates.json
// at the URL set as gecko.update_url in the built manifest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const core = fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8');
const VERSION = (core.match(/const VERSION = '([0-9.]+)'/) || [])[1];
if (!VERSION) throw new Error('VERSION not found in core.js');

const args = process.argv.slice(2);
const getArg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

let template = getArg('--url-template');
if (!template) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy.config.json'), 'utf8').replace(/^\uFEFF/, ''));
    template = cfg.firefoxXpiUrlTemplate;
  } catch (e) { /* no config */ }
}
if (!template) {
  console.error('Missing URL template. Use: node tools/zen-updates.mjs --url-template "https://host/path/aetheria-market-plus-{version}.xpi"');
  process.exit(1);
}

const link = String(template).replace('{version}', VERSION);
const out = getArg('--out') || path.join(ROOT, 'updates.json');

let doc = { addons: { 'market-plus@lumivara.online': { updates: [] } } };
if (fs.existsSync(out)) {
  try { doc = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { console.warn('existing updates.json unreadable - starting fresh'); }
}
const addon = doc.addons['market-plus@lumivara.online'] || (doc.addons['market-plus@lumivara.online'] = { updates: [] });
addon.updates = (addon.updates || []).filter((u) => u.version !== VERSION);
addon.updates.push({ version: VERSION, update_link: link });
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
console.log('updates.json updated:', out);
console.log(`  ${VERSION} -> ${link}`);
console.log('Now host this file and make sure the built manifest contains gecko.update_url pointing to it.');
