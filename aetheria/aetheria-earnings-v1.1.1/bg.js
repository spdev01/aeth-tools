// Aetheria Earnings Overlay — background service worker.
// The ONLY place that talks to the local Command Center. Idle by default: it does nothing until the
// content script asks for data, and MV3 evicts it after ~30s of inactivity (near-zero idle memory).
'use strict';

const CC = 'http://127.0.0.1:4310';

async function getJSON(path, ms = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(CC + path, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function bots() {
  const s = await getJSON('/api/state');
  const list = (s.bots || [])
    .filter((b) => b.mode !== 'collector' && !b.retired)
    .map((b) => ({
      id: b.id,
      name: b.name || 'bot ' + b.id,
      state: b.state,
      mode: b.mode,
      rate3: (b.earn && b.earn.rate3) || 0,
    }));
  list.sort((a, b) => ((b.state === 'running') - (a.state === 'running')) || (b.rate3 - a.rate3));
  return list;
}

chrome.runtime.onMessage.addListener((m, sender, send) => {
  (async () => {
    try {
      if (m && m.type === 'bots') {
        send({ ok: true, data: await bots() });
      } else if (m && m.type === 'earn') {
        const id = Math.max(1, Math.floor(Number(m.botId) || 0));
        const h = Math.min(72, Math.max(6, Math.floor(Number(m.hours) || 12)));
        send({ ok: true, data: await getJSON(`/api/bots/${id}/earnings?hours=${h}`) });
      } else {
        send({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      send({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // keep the message channel open for the async send
});

// toolbar icon click → toggle the panel in the active tab
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle' }, () => void chrome.runtime.lastError);
  }
});
