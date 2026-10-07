// cc-buffsprobe.mjs — (1) list ALL fields of our player in decoded room state (looking for buffs/effects),
// (2) print keys of the owner 'character' push from the web capture (looking for buff state).
import fs from 'node:fs';
import { decodeMulti } from '@msgpack/msgpack';
import { Reflection } from '@colyseus/schema';

// ---------- Part 1: room-state player fields ----------
try {
  const lines = fs.readFileSync('out/frames-bot47.jsonl', 'utf8').split('\n').filter(Boolean);
  let decoder = null, state = null, mySid = null;
  for (const line of lines) {
    const { b } = JSON.parse(line);
    const buf = Buffer.from(b, 'base64');
    const code = buf[0];
    if (code === 0x0a) {
      let off = 1;
      const l1 = buf[off++]; off += l1;
      const l2 = buf[off++]; off += l2;
      let rb = buf.subarray(off);
      if (rb.length > 3) { const m = rb[0]; if (m === 0xcc) rb = rb.subarray(2); else if (m === 0xcd) rb = rb.subarray(3); else if (m === 0xce) rb = rb.subarray(5); }
      decoder = Reflection.decode(rb);
      state = decoder.state;
    } else if ((code === 0x0e || code === 0x0f) && decoder) {
      try {
        decoder.decode(buf.subarray(1));
        if (!mySid && state.players) {
          for (const [sid, p] of state.players) if (p.name === 'RapidDove64') mySid = sid;
          if (!mySid && state.players.size === 1) mySid = [...state.players.keys()][0];
        }
      } catch {}
    }
  }
  if (mySid && state?.players?.get(mySid)) {
    const p = state.players.get(mySid);
    console.log('PLAYER KEYS:', Object.keys(p).join(','));
    const interesting = {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v == null) continue;
      if (Array.isArray(v) || (v && typeof v === 'object')) interesting[k] = JSON.stringify(v).slice(0, 200);
      else interesting[k] = v;
    }
    console.log('PLAYER VALUES:', JSON.stringify(interesting, null, 1).slice(0, 2200));
  } else console.log('no player found');
} catch (e) { console.log('part1 err', String(e && e.message || e)); }

// ---------- Part 2: owner character push keys ----------
try {
  const lines = fs.readFileSync('E:/GitHub/lumivaraonline/aetheria/command-center/data/cc-epic-frames.jsonl', 'utf8').split('\n').filter(Boolean);
  let last = null;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(o)) continue;
    for (const batch of o) {
      if (batch?.kind !== 'frames') continue;
      for (const f of batch.items ?? []) {
        if (f.dir !== 'in') continue;
        const buf = Buffer.from(f.b, 'base64');
        if (buf[0] !== 0x0d) continue;
        try {
          const parts = [...decodeMulti(buf.subarray(1))];
          if (String(parts[0]) === 'character' && parts[1]?.name === 'EpicWillow') last = { at: f.at, d: parts[1] };
        } catch {}
      }
    }
  }
  if (last) {
    console.log('\nCHAR-PUSH KEYS:', Object.keys(last.d).join(','));
    const out = {};
    for (const k of Object.keys(last.d)) {
      const v = last.d[k];
      if (v == null) continue;
      out[k] = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 160) : v;
    }
    console.log('CHAR-PUSH VALUES:', JSON.stringify(out, null, 1).slice(0, 2000));
  } else console.log('\nno character push found');
} catch (e) { console.log('part2 err', String(e && e.message || e)); }
