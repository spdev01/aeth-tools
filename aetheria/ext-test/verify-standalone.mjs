// verify-standalone.mjs — end-to-end check of the extension's STANDALONE session mode (guest player flow).
// Fresh Edge profile → guest login → enter game → verify:
//   real hook events -> session accounting -> panel render -> pause/clear -> storage persistence.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..', 'extension');
const PROFILE = path.join(__dirname, 'edge-profile-standalone');
const SHOTS = path.join(__dirname, 'shots-standalone');
const LOGF = path.join(__dirname, 'standalone-verify.jsonl');
fs.mkdirSync(SHOTS, { recursive: true });
const log = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  fs.appendFileSync(LOGF, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-precise-memory-info', '--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());
page.on('pageerror', (e) => log({ ev: 'pageerror', msg: String(e).slice(0, 300) }));
const shot = async (n) => {
  try {
    await page.screenshot({ path: path.join(SHOTS, n + '.png') });
    log({ ev: 'shot', n });
  } catch {}
};

// talk to the isolated-world session engine through the postMessage bridge
const sc = (m, ...args) =>
  page.evaluate(
    ({ m, args }) =>
      new Promise((res) => {
        const id = 'r' + Math.random().toString(36).slice(2);
        const h = (e) => {
          if (e.data && e.data.src === 'ax-a' && e.data.id === id) {
            window.removeEventListener('message', h);
            res(e.data);
          }
        };
        window.addEventListener('message', h);
        window.postMessage({ src: 'ax-q', id, m, args }, '*');
        setTimeout(() => res({ ok: false, error: 'timeout' }), 4000);
      }),
    { m, args },
  );
const inject = (events) => page.evaluate((evs) => { for (const e of evs) window.postMessage({ src: 'ax-hook', ...e }, '*'); }, events);

const panelState = () =>
  page.evaluate(() => {
    const h = document.getElementById('ax-earn-host');
    if (!h || !h.shadowRoot) return null;
    const sr = h.shadowRoot;
    const vis = (el) => !!el && !el.hidden;
    return {
      sel: sr.getElementById('botsel') ? sr.getElementById('botsel').value : null,
      k3: sr.getElementById('k3') ? sr.getElementById('k3').textContent : null,
      upd: sr.getElementById('upd') ? sr.getElementById('upd').textContent : null,
      bars: sr.querySelectorAll('.chart rect').length,
      ctlVisible: vis(sr.getElementById('sctls')),
      pauseGlyph: sr.getElementById('btnPause') ? sr.getElementById('btnPause').textContent : null,
    };
  });

try {
  // ---------- guest login ----------
  await page.goto('https://www.aetheria-online.in.th/play', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  let t = await page.evaluate(() => document.body.innerText);
  if (t.includes('Guest')) {
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Guest')); if (b) b.click(); });
    log({ ev: 'guest_clicked' });
    await sleep(6000);
    t = await page.evaluate(() => document.body.innerText);
  }
  if (t.includes('สร้างตัวละคร')) {
    const name = 'AxStand' + String(Date.now() % 100000);
    await page.evaluate((n) => {
      const inp = [...document.querySelectorAll('input')].find((i) => i.offsetParent && i.placeholder && i.placeholder.includes('ชื่อตัวละคร'));
      if (!inp) return;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(inp, n);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, name);
    await sleep(600);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'สร้างตัวละคร'); if (b && !b.disabled) b.click(); });
    log({ ev: 'char_created', name });
    await sleep(5000);
  }
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('เข้าเกมด้วย')); if (b) b.click(); });
  log({ ev: 'enter_clicked' });
  await shot('1-after-enter');

  // ---------- queue wait ----------
  let inGame = false;
  for (let i = 0; i < 120; i++) {
    await sleep(8000);
    const st = await page.evaluate(() => {
      const m = document.body.innerText.match(/ลำดับที่\s*([\d,]+)/);
      return { pos: m ? m[1] : null, canvas: !!document.querySelector('canvas') };
    });
    if (i % 5 === 0) log({ ev: 'queue', i, ...st });
    if (st.canvas) { inGame = true; break; }
  }
  log({ ev: 'step', name: 'in_game', inGame });
  if (!inGame) throw new Error('never entered the game (queue timeout)');
  await sleep(8000);
  const tGame = Date.now();
  await shot('2-ingame');

  // real hook events captured with NO synthetic help (fresh profile, shipping manifest):
  const hookEvents = await page.evaluate(() => (window.__axEvents || []).slice(0, 12));
  log({ ev: 'step', name: 'hook_events', count: hookEvents.length, sample: hookEvents.slice(0, 6) });
  const idn0 = await sc('identity');
  log({ ev: 'step', name: 'identity', ...(idn0.data || idn0) });

  // ---------- panel: switch source to "this session" ----------
  const before = await panelState();
  await page.evaluate(() => {
    const h = document.getElementById('ax-earn-host');
    const sel = h && h.shadowRoot && h.shadowRoot.getElementById('botsel');
    if (sel) { sel.value = 'session'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await sleep(2500);
  const after = await panelState();
  log({ ev: 'step', name: 'session_selected', before, after });
  await shot('3-session');

  // ---------- accounting: synthetic drops/kills through the same channel the hook uses ----------
  await inject([
    { ev: 'drop', name: 'Mirage Sand', qty: 5 },
    { ev: 'drop', name: 'Royal Stinger', qty: 4 },
    { ev: 'drop', name: 'Red Potion', qty: 2 },
    { ev: 'drop', name: 'Poring Card', qty: 1 },
    { ev: 'kill' },
    { ev: 'kill' },
    { ev: 'kill' },
  ]);
  await sleep(20000); // allow the wiki-data price fetch + render
  const d1 = await sc('getDetail', 6);
  const cur1 = d1.data && d1.data.cur;
  log({ ev: 'step', name: 'accounting', cur: cur1, expect: { v: 38709, q: 12, k: 3, c: 1 } });
  await shot('4-accounted');

  // ---------- zeny (past the 90s login-replay guard) ----------
  const wait = 95000 - (Date.now() - tGame);
  if (wait > 0) await sleep(wait);
  const idn1 = await sc('identity');
  const base = (idn1.data && idn1.data.zeny) || 0;
  await inject([{ ev: 'char', zeny: base + 12345 }]);
  await sleep(4000);
  const d2 = await sc('getDetail', 6);
  log({ ev: 'step', name: 'zeny_earned', base, cur: d2.data && d2.data.cur });

  // ---------- pause / resume ----------
  await sc('setPaused', true);
  await sleep(1500);
  await inject([{ ev: 'drop', name: 'Mirage Sand', qty: 7 }, { ev: 'kill' }]);
  await sleep(3000);
  const dP = await sc('getDetail', 6);
  log({ ev: 'step', name: 'paused_block', cur: dP.data && dP.data.cur });
  await sc('setPaused', false);
  await sleep(1000);
  await inject([{ ev: 'drop', name: 'Mirage Sand', qty: 7 }]);
  await sleep(3000);
  const dR = await sc('getDetail', 6);
  log({ ev: 'step', name: 'resumed_counts', cur: dR.data && dR.data.cur });

  // ---------- storage persistence (before clear) ----------
  await sleep(20000); // let the coalesced flush write
  let sw = context.serviceWorkers()[0] || null;
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 80000 }).catch(() => null);
  let storage1 = null;
  if (sw) {
    storage1 = await sw.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.keys(all).map((k) => k + ':' + JSON.stringify(all[k]).length);
    }).catch((e) => String(e));
  }
  log({ ev: 'step', name: 'storage_before_clear', keys: storage1 });

  // ---------- clear ----------
  await sc('clear');
  await sleep(3000);
  const dC = await sc('getDetail', 6);
  const hours = (dC.data && dC.data.hours) || [];
  const cur = (dC.data && dC.data.cur) || { v: 0, e: 0, k: 0, q: 0 };
  const total = hours.reduce((a, x) => a + x.v + x.e + x.k + x.q, 0) + cur.v + cur.e + cur.k + cur.q;
  log({ ev: 'step', name: 'cleared', total, cur });
  const afterClear = await panelState();
  log({ ev: 'step', name: 'panel_after_clear', afterClear });
  await shot('5-cleared');
  await shot('6-final');
  log({ ev: 'done' });
} catch (e) {
  log({ ev: 'fatal', err: String(e).slice(0, 400) });
  await shot('fatal');
} finally {
  await context.close().catch(() => {});
  log({ ev: 'exit' });
}
