// Dev sink: POST /save?name=x -> write capture; GET /file?path=rel -> serve file from aetheria dir
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'e:/GitHub/lumivaraonline/aetheria';
const OUT = path.join(BASE, 'out-grep');
const PORT = 4399;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u0 = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === 'GET' && u0.pathname === '/raw') {
    const rel = (u0.searchParams.get('path') || '').replace(/\.\./g, '');
    const file = path.join(BASE, rel);
    try {
      const data = fs.readFileSync(file); // binary-safe
      const ct = file.endsWith('.zip') ? 'application/zip' : file.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length });
      res.end(data);
      console.log(`[sink] served raw ${file} (${data.length} bytes)`);
    } catch (e) {
      res.writeHead(404); res.end('not found: ' + String(e));
    }
    return;
  }
  if (req.method === 'GET' && u0.pathname === '/file') {
    const rel = (u0.searchParams.get('path') || '').replace(/\.\./g, '');
    const file = path.join(BASE, rel);
    try {
      const data = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(data);
      console.log(`[sink] served ${file} (${data.length} bytes)`);
    } catch (e) {
      res.writeHead(404); res.end('not found: ' + String(e));
    }
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const name = (u.searchParams.get('name') || 'capture').replace(/[^a-z0-9._-]/gi, '_');
    const file = path.join(OUT, name.endsWith('.json') ? name : `${name}.json`);
    fs.writeFileSync(file, body);
    console.log(`[sink] ${new Date().toISOString()} wrote ${body.length} bytes -> ${file}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, bytes: body.length, file }));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`[sink] listening on http://127.0.0.1:${PORT}`));
