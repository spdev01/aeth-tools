// page-hook.src.js — MAIN-world tap for the Aetheria game socket.
// BUILD:  cd aetheria/ext-test && npx esbuild page-hook.src.js --bundle --minify --format=iife --target=chrome110 --outfile=../extension/page-hook.js
//
// Passive ONLY: observes the WebSocket frames and REST calls the game already makes. It never sends,
// never mutates, never touches game state. Every decode is wrapped; any failure just skips a frame.
// Verified wire facts (from testbot/src/client.js, all confirmed live):
//   0x0a join | 0x0b error | 0x0c leave | 0x0d msgpack(type)+msgpack(data) | 0x0e/0x0f schema state+patch
//   item_gain {name,qty} = loot into bag | exp_gain {monster,...} = kill | character {zeny,...} = stat push
// Identity comes from REST taps the client itself performs: GET /characters (names) + POST /world/enter
// (characterId in body) + POST /matchmake/joinById (sessionId in response).
import { decodeMulti } from '@msgpack/msgpack';

(() => {
  'use strict';
  if (window.__axHook) return;
  window.__axHook = '1.0.0';

  // bounded debug ring — handy for support; not used by the UI
  const EV = [];
  window.__axEvents = EV;
  const emit = (o) => {
    o.src = 'ax-hook';
    try {
      EV.push(o);
      if (EV.length > 250) EV.splice(0, EV.length - 250);
    } catch {}
    try {
      window.postMessage(o, '*');
    } catch {}
  };

  const GAME = /aetheria-online\.in\.th/i;

  // Did we get injected into an ALREADY-LOADED page? (Firefox/Chrome inject content scripts into open
  // tabs when an add-on loads/reloads — the game socket + login REST calls already happened, so nothing
  // will ever be tapped. Flag it so the UI can tell the user to reload the page once.)
  const late = (() => {
    try { return document.readyState !== 'loading' && performance.now() > 1500; } catch { return false; }
  })();

  // ---------- capture control (the content script toggles this via postMessage) ----------
  // Paused = no decode at all: frames still reach the game untouched, we just skip our copy.
  // probe = a (re)loaded content script asks this instance to re-emit its state — after an add-on
  // reload THIS older instance stays alive and still holds the identity + the tapped socket.
  let paused = false;
  let lastIdentPayload = null;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.src !== 'ax-ctl') return;
    if (typeof d.paused === 'boolean') paused = d.paused;
    if (d.probe === true) {
      emit({ ev: 'ready', v: '1.0.0', late, probe: true });
      if (lastIdentPayload) emit({ ev: 'ident', ...lastIdentPayload });
    }
  });

  // ---------- frame decode ----------
  let charKeysSent = false;
  const decodeFrame = (buf) => {
    if (paused) return;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!u8.length) return;
    const code = u8[0];
    if (code === 0x0d) {
      const parts = [...decodeMulti(u8.subarray(1))];
      const type = String(parts[0]);
      const data = parts.length > 1 ? parts[1] : undefined;
      if (type === 'item_gain' && data && data.name) {
        emit({ ev: 'drop', name: String(data.name), qty: Math.max(1, Math.floor(Number(data.qty) || 1)) });
      } else if (type === 'exp_gain') {
        emit({ ev: 'kill', m: data && data.monster ? String(data.monster) : null });
      } else if (type === 'character' && data) {
        if (!charKeysSent) {
          charKeysSent = true;
          try {
            emit({ ev: 'charFields', keys: Object.keys(data).slice(0, 50) });
          } catch {}
        }
        emit({
          ev: 'char',
          zeny: Number.isFinite(data.zeny) ? data.zeny : null,
          base: data.baseLevel ?? null,
          job: data.jobLevel ?? null,
        });
      }
    } else if (code === 0x0a) {
      emit({ ev: 'join' });
    } else if (code === 0x0c) {
      emit({ ev: 'left' });
    }
  };

  const onMessage = (ev) => {
    if (paused) return;
    try {
      const d = ev.data;
      if (d instanceof ArrayBuffer || d instanceof Uint8Array) decodeFrame(d);
      else if (typeof Blob !== 'undefined' && d instanceof Blob) d.arrayBuffer().then(decodeFrame, () => {});
    } catch {}
  };

  // ---------- websocket tap (wrapper keeps every static/prototype the game may rely on) ----------
  const OWS = window.WebSocket;
  if (OWS) {
    const tap = (ws) => {
      try {
        if (GAME.test(String(ws.url || ''))) ws.addEventListener('message', onMessage);
      } catch {}
    };
    function AetheriaWS(url, protocols) {
      const ws = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
      tap(ws);
      return ws;
    }
    AetheriaWS.prototype = OWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) AetheriaWS[k] = OWS[k];
    try {
      Object.defineProperty(window, 'WebSocket', { value: AetheriaWS, configurable: true, writable: true });
    } catch {}
  }

  // ---------- REST taps (character identity, passive) ----------
  const seen = { characters: null, charId: null, sessionId: null };
  let lastIdent = null;
  let lastIdentName = null;
  const maybeIdent = () => {
    if (seen.charId == null) return;
    const list = Array.isArray(seen.characters) ? seen.characters : [];
    const c = list.find((x) => x && (x.characterId === seen.charId || x.id === seen.charId));
    const name = c ? c.name : null;
    if (String(seen.charId) === lastIdent && name == null) return; // nothing new
    if (String(seen.charId) === lastIdent && name === lastIdentName) return;
    lastIdent = String(seen.charId);
    lastIdentName = name;
    lastIdentPayload = { characterId: seen.charId, name, sessionId: seen.sessionId };
    emit({ ev: 'ident', ...lastIdentPayload });
  };

  const onRest = (url, { reqBody, respText, respJson } = {}) => {
    try {
      if (!GAME.test(url)) return;
      emit({ ev: 'rest', path: String(url).replace(/^https?:\/\/[^/]+/, '').slice(0, 80), body: typeof reqBody === 'string' ? reqBody.slice(0, 60) : null });
      if (/\/world\/enter/.test(url) && typeof reqBody === 'string') {
        const b = JSON.parse(reqBody);
        if (b && b.characterId != null) {
          seen.charId = b.characterId;
          maybeIdent();
        }
      } else if (/\/characters(\?|$)/.test(url)) {
        const j = respJson !== undefined ? respJson : respText ? JSON.parse(respText) : null;
        if (j) {
          seen.characters = j;
          maybeIdent();
        }
      } else if (/\/matchmake\/joinById/.test(url)) {
        const j = respJson !== undefined ? respJson : respText ? JSON.parse(respText) : null;
        if (j && j.sessionId) {
          seen.sessionId = j.sessionId;
          maybeIdent();
        }
      }
    } catch {}
  };

  try {
    const of = window.fetch;
    if (of) {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const p = of.apply(this, arguments);
        try {
          if (GAME.test(url)) {
            const reqBody = init && typeof init.body === 'string' ? init.body : undefined;
            p.then(
              (r) =>
                r
                  .clone()
                  .json()
                  .then((j) => onRest(url, { reqBody, respJson: j }), () => onRest(url, { reqBody })),
              () => onRest(url, { reqBody }),
            );
          }
        } catch {}
        return p;
      };
    }
  } catch {}

  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const oOpen = XHR.prototype.open;
      const oSend = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try {
          this.__axUrl = String(url);
        } catch {}
        return oOpen.apply(this, arguments);
      };
      XHR.prototype.send = function (body) {
        try {
          const url = this.__axUrl || '';
          if (GAME.test(url)) {
            const reqBody = typeof body === 'string' ? body : undefined;
            this.addEventListener('load', () => {
              try {
                onRest(url, { reqBody, respText: this.responseText });
              } catch {}
            });
          }
        } catch {}
        return oSend.apply(this, arguments);
      };
    }
  } catch {}

  emit({ ev: 'ready', v: '1.0.0', late });
})();
