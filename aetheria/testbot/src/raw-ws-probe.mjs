// RAW WS PROBE — bypass the SDK: connect straight to the room socket and dump raw frames.
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://www.aetheria-online.in.th';
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');
const sess = JSON.parse(fs.readFileSync(path.join(outDir, 'session.json'), 'utf8'));
const H = { Authorization: `Bearer ${sess.token}`, 'Content-Type': 'application/json' };

const chars = await (await fetch(`${BASE}/characters`, { headers: H })).json();
const cid = chars.characters?.[0]?.characterId;
console.log('characterId:', cid);
const enter = await (await fetch(`${BASE}/world/enter`, { method: 'POST', headers: H, body: JSON.stringify({ characterId: cid }) })).json();
console.log('enter:', JSON.stringify({ ...enter, ticket: '<' + enter.ticket.length + '>' }));
const mmRes = await fetch(enter.endpoint + '/matchmake/joinById/' + enter.roomId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: enter.ticket }) });
const res = await mmRes.json();
console.log('reservation:', JSON.stringify(res));

const host = enter.endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
const url = `${host}/${res.processId}/${res.roomId}?sessionId=${res.sessionId}`;
console.log('ws url:', url);

const ws = new WebSocket(url);
const frames = [];
ws.on('open', () => console.log('WS OPEN'));
ws.on('message', (data, isBinary) => {
  const buf = Buffer.from(data);
  frames.push(buf);
  const hex = buf.subarray(0, 220).toString('hex');
  console.log(`frame #${frames.length} len=${buf.length} binary=${isBinary}\n  hex: ${hex}`);
  fs.writeFileSync(path.join(outDir, `rawframe-${frames.length}.bin`), buf);
  if (frames.length === 1) {
    // try parsing as [0x0a][utf8 string][utf8 string]...
    let off = 1;
    const readStr = () => { const len = buf[off++]; const s = buf.subarray(off, off + len).toString('utf8'); off += len; return s; };
    try {
      console.log('  parse: code=0x' + buf[0].toString(16), 'str1=', JSON.stringify(readStr()), 'str2=', JSON.stringify(readStr()), 'rest bytes=', buf.length - off);
      fs.writeFileSync(path.join(outDir, 'handshake-rest.bin'), buf.subarray(off));
      console.log('  rest hex head:', buf.subarray(off, off + 120).toString('hex'));
    } catch (e) { console.log('  parse error:', e.message); }
    // ACK join like the SDK does
    ws.send(Buffer.from([0x0a]));
    console.log('  sent ACK [0x0a]');
  }
});
ws.on('close', (code, reason) => console.log('WS CLOSE', code, String(reason)));
ws.on('error', (e) => console.log('WS ERROR', e.message));
setTimeout(() => { console.log(`done, ${frames.length} frames`); ws.close(); process.exit(0); }, 15000);
