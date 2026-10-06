// Raw Aetheria client — ws + msgpack, no SDK. Protocol (all verified live):
//  - REST: /auth/guest | /characters | /world/enter (Bearer token)
//  - POST /matchmake/joinById/<roomId> {ticket} -> flat reservation {name,sessionId,roomId,processId}
//  - ws url: wss://<endpoint-host>/<processId>/<roomId>?sessionId=<sessionId>
//  - frames: 0x0a join(2 strings + reflection) [ack 0x0a], 0x0b error, 0x0c leave,
//            0x0d msgpack(type)+msgpack(data), 0x0e full state, 0x0f patch
//  - send: [0x0d][msgpack(type)][msgpack(data)]
import WebSocket from 'ws';
import { encode, decodeMulti } from '@msgpack/msgpack';

export const BASE_DEFAULT = 'https://www.aetheria-online.in.th';

export class AetheriaClient {
  constructor(opts = {}) {
    this.base = opts.base || BASE_DEFAULT;
    this.token = opts.token;
    this.ws = null;
    this.handlers = { message: [], state: [], join: [], close: [], error: [] };
    this.joinInfo = null;
    this.reflection = null;
    this.enter = null;
    this.reservation = null;
    this.msgs = new Map(); // last message per type (await-style flows: channels, trade, storage, invite)
    this.lastError = null;
  }
  on(evt, fn) {
    (this.handlers[evt] ||= []).push(fn);
    return () => { const a = this.handlers[evt]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  }
  emit(evt, ...args) { for (const fn of [...(this.handlers[evt] || [])]) fn(...args); }

  // ---------- REST ----------
  async api(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(this.base + pathname, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: json ? null : text };
  }
  async listCharacters() { return (await this.api('/characters')).json; }
  async createCharacter(name) { return (await this.api('/characters', { method: 'POST', body: { name } })).json; }
  async worldEnter(characterId) { return (await this.api('/world/enter', { method: 'POST', body: { characterId } })).json; }

  async getReservation(characterId) {
    const enter = await this.worldEnter(characterId);
    if (!enter || !enter.roomId) throw new Error('world/enter failed: ' + JSON.stringify(enter));
    const mmRes = await fetch(enter.endpoint + '/matchmake/joinById/' + enter.roomId, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: enter.ticket }),
    });
    const reservation = await mmRes.json();
    if (!reservation || !reservation.sessionId) throw new Error('matchmake failed: ' + JSON.stringify(reservation));
    const host = enter.endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    return { enter, reservation, wsUrl: `${host}/${reservation.processId}/${reservation.roomId}?sessionId=${reservation.sessionId}` };
  }

  // ---------- Connect ----------
  async connect(characterId) {
    const { enter, reservation, wsUrl } = await this.getReservation(characterId);
    this.enter = enter; this.reservation = reservation; this.wsUrl = wsUrl;
    this.mapId = enter.mapId;
    await this.connectSocket(wsUrl);
    await this.waitJoin();
    return this;
  }

  // Rejoin a room directly (used after 'travel' messages: {roomId, ticket, endpoint})
  async rejoinRoom(travel) {
    const { roomId, ticket, mapId, endpoint: newEndpoint } = travel;
    if (!roomId || !ticket) throw new Error('travel msg missing roomId/ticket: ' + JSON.stringify(travel));
    // 1) consented leave of current room (exactly like the game client)
    try { this.ws && this.ws.send(Buffer.from([0x0c])); } catch {}
    await new Promise((r) => setTimeout(r, 900));
    try { this.ws && this.ws.removeAllListeners(); this.ws && this.ws.close(); } catch {}
    // 2) matchmake the new room
    const endpoint = newEndpoint || this.enter.endpoint;
    const mmRes = await fetch(endpoint + '/matchmake/joinById/' + roomId, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, batch: true }),
    });
    const reservation = await mmRes.json();
    if (!reservation || !reservation.sessionId) throw new Error('rejoin matchmake failed: ' + JSON.stringify(reservation));
    this.reservation = reservation;
    if (mapId) this.mapId = mapId;
    this.enter.endpoint = endpoint;
    const host = endpoint.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    this.wsUrl = `${host}/${reservation.processId}/${reservation.roomId}?sessionId=${reservation.sessionId}`;
    await this.connectSocket(this.wsUrl);
    const joined = await this.waitJoin();
    if (!joined) throw new Error('rejoin connect did not join: ' + this.wsUrl);
    this.arrived();
    return this;
  }

  async connectSocket(wsUrl) {
    this.hasJoined = false;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      ws.once('open', resolve); ws.once('error', reject);
    });
    ws.on('message', (data) => this._onFrame(Buffer.from(data)));
    ws.on('close', (code, reason) => this.emit('close', code, String(reason)));
    ws.on('error', (e) => this.emit('error', { kind: 'ws', err: String(e && e.message || e) }));
  }

  waitJoin(timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (this.hasJoined) return resolve(true);
      const t = setTimeout(() => { off(); resolve(false); }, timeoutMs);
      const off = this.on('join', () => { clearTimeout(t); off(); resolve(true); });
    });
  }

  _onFrame(buf) {
    try { this._onFrameInner(buf); }
    catch (e) { this.emit('error', { kind: 'frame', err: String((e && e.stack) || e), head: buf.subarray(0, 24).toString('hex') }); }
  }

  _onFrameInner(buf) {
    const code = buf[0];
    if (code === 0x0a) {
      let off = 1;
      const readStr = () => { const len = buf[off++]; const s = buf.subarray(off, off + len).toString('utf8'); off += len; return s; };
      try {
        this.joinInfo = { reconnectionToken: readStr(), serializerId: readStr() };
        this.reflection = buf.subarray(off);
        try { this.ws.send(Buffer.from([0x0a])); } catch {}
        this.hasJoined = true;
        this.emit('join', this.joinInfo);
      } catch (e) { this.emit('error', { kind: 'joinparse', err: String(e) }); }
    } else if (code === 0x0b) {
      this.lastError = buf.toString('hex');
      this.emit('error', { kind: 'server_error', raw: this.lastError });
    } else if (code === 0x0c) {
      this.emit('close', 0, 'server-sent leave');
    } else if (code === 0x0d) {
      try {
        const parts = [...decodeMulti(buf.subarray(1))];
        const mtype = String(parts[0]);
        this.msgs.set(mtype, { data: parts.length > 1 ? parts[1] : undefined, at: Date.now() });
        if (this.msgs.size > 120) this.msgs.delete(this.msgs.keys().next().value);
        this.emit('message', parts[0], parts.length > 1 ? parts[1] : undefined);
      } catch (e) {
        this.emit('error', { kind: 'msgpack', head: buf.subarray(0, 40).toString('hex'), err: String(e) });
      }
    } else {
      this.emit('state', '0x' + code.toString(16), buf);
    }
  }

  send(type, data) {
    const t = encode(type);
    const out = data === undefined
      ? new Uint8Array(1 + t.length)
      : new Uint8Array(1 + t.length + encode(data).length);
    out[0] = 0x0d;
    out.set(t, 1);
    if (data !== undefined) out.set(encode(data), 1 + t.length);
    try { this.ws.send(Buffer.from(out)); }
    catch (e) { this.emit('error', { kind: 'send', type, err: String((e && e.message) || e) }); }
  }

  close() { try { this.ws && this.ws.close(); } catch {} }

  // Send leave-room frame (0x0c) then wait — frees our seat so the next joinById succeeds immediately.
  async leaveGraceful(ms = 700) {
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(Buffer.from([0x0c])); } catch {}
    await new Promise((r) => setTimeout(r, ms));
  }

  // ---------- Verified command helpers ----------
  moveTo(tileX, tileY) { const x = (tileX + 0.5) * 32, y = (tileY + 0.5) * 32; this.lastMove = { x, y, t: Date.now() }; this.send('move_to', { x, y }); }
  moveToPx(x, y) { this.lastMove = { x, y, t: Date.now() }; this.send('move_to', { x, y }); }
  arrived() { this.send('arrived'); }
  move(dx, dy) { this.send('move', { dx, dy }); }
  npcTalk(npcKey) { this.send('npc_talk', { npcKey }); }
  npcOption(index) { this.send('npc_option', { index }); }
  npcClose() { this.send('npc_close', {}); }
  invSort() { this.send('inv_sort', {}); }
  statUp(stat, n = 1) { this.send('stat_up', { stat, n }); }
  skillUp(skillId) { this.send('skill_up', { skillId }); }
  autoEnabled(enabled) { this.send('auto_set', { enabled }); }
  autoConfig(config) { this.send('auto_set', { config }); }
  cast(skillId, targetId) { this.send('cast', { skillId, targetId }); }
  invUse(slot) { this.send('inv_use', { slot }); }
  petSet(petId) { this.send('pet_set', { petId }); }
  warp(mapId) { this.send('npc_warp', { mapId }); }
  shopSell(slot, qty) { this.send('shop_sell', { slot, qty }); }
  shopSellMany(lines) { this.send('shop_sell_many', { lines }); }
  storagePut(slot, qty) { this.send('storage_put', { slot, qty }); }
  storageTake(slot, qty) { this.send('storage_take', { slot, qty }); }
  storageSort() { this.send('storage_sort', {}); }
  storageZeny(action, amount) { this.send('storage_zeny', { action, amount }); }
  channelSwitch(channel) { this.send('channel_switch', { channel }); }
  channelList() { this.send('channel_list'); }
  trade(payload) { this.send('trade', payload); }
  tradeRequest(name) { this.send('trade', { action: 'request', name }); }
  tradeOffer(items, zeny) { this.send('trade', { action: 'offer', items, zeny }); }
  tradeLock() { this.send('trade', { action: 'lock' }); }
  tradeConfirm() { this.send('trade', { action: 'confirm' }); }
  tradeCancel() { this.send('trade', { action: 'cancel' }); }
}
