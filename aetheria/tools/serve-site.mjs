// Local preview server for the assembled site (test the gated pages before pushing).
//   node tools/serve-site.mjs            -> serves _site on http://127.0.0.1:4398
//   PORT=1234 node tools/serve-site.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const SITE = process.env.SITE_DIR ? path.resolve(REPO, process.env.SITE_DIR) : path.join(REPO, '_site');
const PORT = parseInt(process.env.PORT || '4398', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.xpi': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const full = path.join(SITE, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(SITE)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`site: http://127.0.0.1:${PORT}  (${SITE})`));
