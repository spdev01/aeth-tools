// serve.mjs — tiny static server for the ROVA wiki tool (localhost only).
// Usage: node tools/serve.mjs [--port 4321]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', 'public');

const argv = process.argv.slice(2);
const portArg = argv.includes('--port') ? argv[argv.indexOf('--port') + 1] : null;
const PORT = Number(portArg || process.env.ROVA_WIKI_SERVE_PORT || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    // never allow escaping the public root
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + p);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        // no-store for data so rebuilds show up immediately (heuristic caching bit us before)
        'Cache-Control': ext === '.json' ? 'no-store, must-revalidate' : 'no-cache',
      };
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('500 ' + String(e.message));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ROVA wiki tool: http://127.0.0.1:${PORT}/`);
  console.log(`serving ${root}`);
});
