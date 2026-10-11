// ext-test/run.mjs — loads the earnings extension into a real Edge browser, logs in as a real account
// (Sooood / bot 205), and monitors the in-game panel. Prints JSONL to stdout + ext-test.log.jsonl.
// Usage: node run.mjs --min=60 [--smoke] [--restore]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..', 'extension');
const PROFILE = path.join(__dirname, 'edge-profile');
const SHOTS = path.join(__dirname, 'shots');
const LOGF = path.join(__dirname, 'ext-test.log.jsonl');
const API = 'http://127.0.0.1:4310';
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const MINUTES = Number(arg('min', 60));
const SMOKE = argv.includes('--smoke');
const RESTORE = argv.includes('--restore'); // restart bot 205 when done

fs.mkdirSync(SHOTS, { recursive: true });
const log = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  fs.appendFileSync(LOGF, line + '\n');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- credentials straight from the CC store (read locally, never printed, never on the command line) ----
const store = JSON.parse(fs.readFileSync('E:/GitHub/lumivaraonline/aetheria/command-center/data/store.json', 'utf8'));
const bot = store.bots.find((b) => b.id === 205);
if (!bot) throw new Error('bot 205 not found in store');
const chr = store.characters.find((c) => c.id === bot.characterId);
const acct = chr && store.accounts.find((a) => a.id === chr.accountId);
if (!chr || !acct) throw new Error('character/account chain broken for bot 205');
log({ ev: 'start', minutes: MINUTES, smoke: SMOKE, restore: RESTORE, char: chr.name });

log({ ev: 'cc_meta', ok: await fetch(`${API}/api/meta`).then((r) => r.ok).catch(() => false) });

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--enable-precise-memory-info',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});
try {
  const sw = await context.waitForEvent('serviceworker', { timeout: 25000 });
  log({ ev: 'extension_loaded', id: new URL(sw.url()).host });
} catch {
  log({ ev: 'extension_load_TIMEOUT' });
}

const page = context.pages()[0] || (await context.newPage());
page.on('pageerror', (e) => log({ ev: 'pageerror', msg: String(e).slice(0, 400) }));
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('[ax]')) log({ ev: 'axlog', msg: t.slice(0, 300) });
});

// follow the game if it moves to a new tab/page
let tracked = page;
context.on('page', (p) => {
  log({ ev: 'newpage', url: p.url() });
  if (/aetheria-online/.test(p.url())) tracked = p;
  p.on('pageerror', (e) => log({ ev: 'pageerror', msg: String(e).slice(0, 400) }));
});

const shot = async (name) => {
  try {
    await tracked.screenshot({ path: path.join(SHOTS, name + '.png') });
    log({ ev: 'shot', name });
  } catch (e) {
    log({ ev: 'shot_fail', name, err: String(e).slice(0, 200) });
  }
};
const heap = () => tracked.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)).catch(() => null);

const panelState = () =>
  tracked.evaluate(() => {
    const h = document.getElementById('ax-earn-host');
    if (!h || !h.shadowRoot) return null;
    const sr = h.shadowRoot;
    const panel = sr.querySelector('.panel');
    const pill = sr.querySelector('.pill');
    return {
      styled: !!(panel && getComputedStyle(panel).backgroundColor !== 'rgba(0, 0, 0, 0)'),
      visible: panel ? !panel.hidden : false,
      pill: pill ? !pill.hidden : false,
      k3: sr.getElementById('k3') ? sr.getElementById('k3').textContent : null,
      k24: sr.getElementById('k24') ? sr.getElementById('k24').textContent : null,
      upd: sr.getElementById('upd') ? sr.getElementById('upd').textContent : null,
      sel: sr.getElementById('botsel') ? sr.getElementById('botsel').value : null,
      bars: sr.querySelectorAll('.chart rect').length,
    };
  }).catch(() => null);

try {
  // ----- login -----
  await page.goto('https://www.aetheria-online.in.th/play', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  log({ ev: 'heap_login', mb: await heap() });
  const inputs = page.locator('input');
  const nInputs = await inputs.count();
  if (SMOKE)
    log({
      ev: 'dump_inputs',
      n: nInputs,
      btns: await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.textContent.trim()).slice(0, 15)),
    });
  if (nInputs >= 2) {
    await inputs.nth(0).fill(acct.userId);
    await inputs.nth(1).fill(acct.password);
    await page
      .getByRole('button', { name: /เข้าเกม/ })
      .first()
      .click()
      .catch(async () => {
        await page.locator('button[type=submit]').first().click();
      });
    log({ ev: 'login_submitted' });
    await sleep(4500);
  } else {
    log({ ev: 'no_login_form', note: 'profile may already be signed in' });
  }
  await shot('debug-1-after-login');
  if (SMOKE) log({ ev: 'dump_after_login', body: (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 900) });

  // ----- character select (best-effort; the page may go straight in) -----
  try {
    const card = page.getByText(chr.name, { exact: true }).first();
    if (await card.isVisible({ timeout: 8000 })) {
      await card.click();
      log({ ev: 'char_clicked' });
      await sleep(900);
      const goBtn = page.getByRole('button', { name: /เข้าเกม|เริ่ม|เล่น|start|enter/i }).first();
      if (await goBtn.isVisible({ timeout: 3000 })) {
        await goBtn.click();
        log({ ev: 'char_enter_clicked' });
      }
      await sleep(2500);
    } else {
      log({ ev: 'char_card_not_found' });
    }
  } catch (e) {
    log({ ev: 'char_select_err', err: String(e).slice(0, 200) });
  }
  await shot('debug-2-in-game');

  // ----- wait for the game canvas (the server may hold us in a login queue for a while) -----
  // poll against `tracked` each round so a tab/page switch mid-queue is still caught
  let canvasSeen = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await tracked.locator('canvas').count()) > 0) {
        canvasSeen = true;
        break;
      }
    } catch {}
    await sleep(5000);
  }
  log({ ev: canvasSeen ? 'canvas_visible' : 'canvas_TIMEOUT' });
  await sleep(8000);
  log({ ev: 'heap_ingame', mb: await heap() });
  await shot('debug-2b-ingame');
  if (SMOKE) log({ ev: 'dump_ingame', body: (await tracked.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 600) });

  // ----- extension panel check -----
  for (let i = 0; i < 20; i++) {
    const p = await panelState();
    if (p && p.bars > 0) break;
    await sleep(1500);
  }
  log({ ev: 'panel', state: await panelState() });
  await shot('debug-3-panel');

  // pick the demo bot (Deed, id 213) so the numbers visibly move during the run
  const picked = await tracked.evaluate((id) => {
    const h = document.getElementById('ax-earn-host');
    if (!h || !h.shadowRoot) return false;
    const sel = h.shadowRoot.getElementById('botsel');
    if (!sel) return false;
    if (![...sel.options].some((o) => o.value === String(id))) return false;
    sel.value = String(id);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, 213);
  log({ ev: 'demo_bot_selected', ok: picked });
  await sleep(3500);
  log({ ev: 'panel_after_pick', state: await panelState() });
  await shot('debug-4-demo-bot');

  // ----- monitor loop -----
  const T0 = Date.now();
  let ticks = 0;
  let okTicks = 0;
  let shotAt = Date.now();
  while (Date.now() - T0 < MINUTES * 60000) {
    await sleep(60000);
    if (tracked.isClosed()) {
      log({ ev: 'page_closed', min: Math.round((Date.now() - T0) / 60000) });
      break;
    }
    ticks++;
    const st = await panelState();
    if (st && st.bars > 0) okTicks++;
    const memo = await heap();
    let swMB = null;
    for (const w of context.serviceWorkers()) {
      try {
        swMB = await w.evaluate(() => (typeof performance !== 'undefined' && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
      } catch {}
    }
    log({ ev: 'tick', min: Math.round((Date.now() - T0) / 60000), pageMB: memo, swMB, k3: st && st.k3, upd: st && st.upd, bars: st && st.bars, sel: st && st.sel });
    if ([2, 15, 30, 45, 55].includes(ticks)) {
      // wake the service worker with a forced refresh, then measure its heap while it is alive
      await tracked.evaluate(() => {
        const h = document.getElementById('ax-earn-host');
        if (h && h.shadowRoot) h.shadowRoot.querySelector('[data-act="ref"]').click();
      });
      await sleep(2500);
      let swHeap = null;
      let swCount = 0;
      for (const w of context.serviceWorkers()) {
        swCount++;
        try {
          swHeap = await w.evaluate(() => (typeof performance !== 'undefined' && performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
        } catch {}
      }
      log({ ev: 'sw_probe', tick: ticks, count: swCount, swMB: swHeap });
    }
    if (ticks === 30 && MINUTES > 35) {
      // A/B: collapse the panel for a minute to attribute its heap cost
      await tracked.evaluate(() => {
        const h = document.getElementById('ax-earn-host');
        if (h && h.shadowRoot) h.shadowRoot.querySelector('[data-act="min"]').click();
      });
      await sleep(5000);
      const c1 = await heap();
      await sleep(55000);
      const c2 = await heap();
      log({ ev: 'memory_collapsed', mb: [c1, c2] });
      await tracked.evaluate(() => {
        const h = document.getElementById('ax-earn-host');
        if (h && h.shadowRoot) h.shadowRoot.querySelector('.pill').click();
      });
      await sleep(5000);
      log({ ev: 'memory_reexpanded', mb: await heap() });
    }
    if (Date.now() - shotAt > 5 * 60000) {
      shotAt = Date.now();
      await shot(`tick-${ticks}`);
    }
  }
  await shot('final');
  log({ ev: 'done', ticks, okTicks, finalHeapMB: await heap() });
} catch (e) {
  log({ ev: 'fatal', err: String(e).slice(0, 500) });
  await shot('fatal');
} finally {
  if (RESTORE) {
    try {
      const r = await fetch(`${API}/api/bots/start-many`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [205], rampMs: 0 }),
      });
      log({ ev: 'restore_205', status: r.status });
    } catch (e) {
      log({ ev: 'restore_205_fail', err: String(e).slice(0, 200) });
    }
  }
  await context.close().catch(() => {});
  log({ ev: 'exit' });
}
