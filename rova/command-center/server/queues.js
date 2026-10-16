// queues.js — collect queue, shopping (gear-up) queue, collector pool, whitelist union, fleet totals, plans.
// Mirrors the aetheria CC's shapes (aetheria/server: queue logic + fleetView) so the dashboards stay twins.
// Game actions are NOT wired yet — these are the state machines + endpoints the runner/client will drive.
import { store } from './store.js';

const S = () => store.getSettings();

// ---------- collect queue (one-at-a-time trips to the collector) ----------
export const collectQueue = {
  view() {
    const cq = S().collectQueue;
    return { queue: cq.queue ?? [], actives: cq.actives ?? [], holds: cq.holds ?? [], auto: S().autoCollect };
  },
  queueAll(ids) {
    const cq = S().collectQueue;
    let added = 0;
    for (const id of ids) {
      const b = store.findBot(id);
      if (!b || b.mode === 'collector') continue;
      if (cq.queue.includes(id) || cq.actives.some((a) => a.botId === id)) continue;
      cq.queue.push(id);
      added++;
    }
    cq.at = Date.now();
    store.save();
    return { ok: true, added, queued: cq.queue.length };
  },
  dequeue(ids) {
    const cq = S().collectQueue;
    const before = cq.queue.length;
    cq.queue = cq.queue.filter((x) => !ids.includes(x));
    cq.holds = (cq.holds ?? []).filter((x) => !ids.includes(x));
    store.save();
    return { ok: true, removed: before - cq.queue.length };
  },
  clearWaiting() {
    const cq = S().collectQueue;
    cq.queue = [];
    cq.holds = [];
    store.save();
    return { ok: true };
  },
  release(ids) {
    const cq = S().collectQueue;
    const before = cq.actives.length;
    cq.actives = (!ids || !ids.length) ? [] : cq.actives.filter((a) => !ids.includes(a.botId));
    store.save();
    return { ok: true, released: before - cq.actives.length };
  },
  hold(ids, on) {
    const cq = S().collectQueue;
    cq.holds = (cq.holds ?? []).filter((x) => !ids.includes(x));
    if (on) for (const id of ids) cq.holds.push(id);
    store.save();
    return { ok: true };
  },
  // manual grant for now: pick the first waiting bot + the first collector. The runner will call this
  // automatically once the client + collection flow exist (same endpoint).
  grantNext() {
    const cq = S().collectQueue;
    if (!cq.queue.length) return { ok: false, error: 'queue empty' };
    const col = store.data.bots.find((b) => b.mode === 'collector' && !b.retired);
    if (!col) return { ok: false, error: 'no collector bot — create one in the Collector tab' };
    const id = cq.queue.shift();
    const actives = cq.actives.filter((a) => a.botId !== id);
    actives.push({ botId: id, collector: col.name, collectorId: col.id, at: Date.now() });
    cq.actives = actives;
    cq.at = Date.now();
    store.save();
    return { ok: true, granted: id, collector: col.name };
  },
  setAuto(cfg) {
    Object.assign(S().autoCollect, cfg);
    store.save();
    return { ok: true, auto: S().autoCollect };
  },
};

// ---------- collector pool (bots with mode:'collector' + their caps) ----------
export function collectorsView() {
  const cols = store.data.bots.filter((b) => b.mode === 'collector' && !b.retired);
  const saved = S().collectors ?? [];
  return cols.map((b) => {
    const caps = saved.find((c) => c.botId === b.id) ?? {};
    return { botId: b.id, name: b.name, zenyCap: caps.zenyCap ?? 0, itemCapPerItem: caps.itemCapPerItem ?? 0, createdAt: caps.createdAt ?? b.createdAt };
  });
}
export function setCollectorCaps(botId, { zenyCap, itemCapPerItem }) {
  const b = store.findBot(botId);
  if (!b || b.mode !== 'collector') return { ok: false, error: 'not a collector' };
  const s = S();
  let c = s.collectors.find((x) => x.botId === botId);
  if (!c) { c = { botId, createdAt: Date.now() }; s.collectors.push(c); }
  if (zenyCap != null) c.zenyCap = Math.max(0, parseInt(zenyCap, 10) || 0);
  if (itemCapPerItem != null) c.itemCapPerItem = Math.max(0, parseInt(itemCapPerItem, 10) || 0);
  store.save();
  return { ok: true, collector: c };
}

// ---------- shopping (gear-up) queue ----------
export const shopQueue = {
  view() { return { jobs: S().shopQueue ?? [] }; },
  queue(ids, note = '') {
    const s = S();
    let added = 0;
    for (const id of ids) {
      const b = store.findBot(id);
      if (!b || b.mode === 'collector') continue;
      if (s.shopQueue.some((j) => j.botId === id && j.status === 'queued')) continue;
      s.shopQueue.push({ id: Date.now() + added, botId: id, name: b.name, status: 'queued', note, at: Date.now() });
      added++;
    }
    store.save();
    return { ok: true, added };
  },
  dequeue(ids) { const s = S(); const before = s.shopQueue.length; s.shopQueue = s.shopQueue.filter((j) => !ids.includes(j.botId)); store.save(); return { ok: true, removed: before - s.shopQueue.length }; },
  clear() { const s = S(); s.shopQueue = []; store.save(); return { ok: true }; },
};

// ---------- fleet totals + whitelist union (item & money breakdown) ----------
export function fleetView() {
  const bots = store.data.bots;
  let zeny = 0;
  const items = new Map(); // name -> qty
  const perBot = [];
  for (const b of bots) {
    const st = b.status ?? {};
    const z = Number(st.zeny) || 0;
    zeny += z;
    let stacks = 0;
    for (const it of (st.inventory ?? [])) {
      const name = it.name ?? ('#' + it.itemId);
      items.set(name, (items.get(name) ?? 0) + (it.qty ?? 1));
      stacks++;
    }
    perBot.push({ botId: b.id, name: b.name, mode: b.mode, zeny: z, stacks, bag: st.bag ?? null });
  }
  const union = new Map();
  for (const b of bots) for (const k of (b.cfg?.keepList ?? [])) union.set(k, (union.get(k) ?? 0) + 1);
  return {
    updatedAt: Date.now(),
    zeny, perBot,
    items: [...items.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 200),
    whitelist: [...union.entries()].map(([name, botsWith]) => ({ name, bots: botsWith })),
  };
}

// ---------- config plans (save once, apply to ticked bots) ----------
export const plans = {
  list() { return S().plans ?? []; },
  save(name, cfg) {
    const s = S();
    name = String(name || '').trim().slice(0, 40);
    if (!name) return { ok: false, error: 'plan needs a name' };
    const existing = s.plans.find((p) => p.name === name);
    if (existing) { existing.cfg = cfg; existing.updatedAt = Date.now(); }
    else s.plans.push({ name, cfg, updatedAt: Date.now() });
    store.save();
    return { ok: true, plans: s.plans };
  },
  apply(name, ids) {
    const s = S();
    const plan = s.plans.find((p) => p.name === name);
    if (!plan) return { ok: false, error: 'plan not found' };
    let applied = 0;
    for (const id of ids) {
      const b = store.findBot(id);
      if (!b) continue;
      b.cfg = { ...(b.cfg ?? {}), ...plan.cfg };
      if (plan.cfg?.mode) b.mode = plan.cfg.mode;
      if (plan.cfg?.group != null) b.group = plan.cfg.group || null;
      b.updatedAt = Date.now();
      applied++;
    }
    store.save();
    return { ok: true, applied };
  },
  remove(name) { const s = S(); s.plans = s.plans.filter((p) => p.name !== name); store.save(); return { ok: true, plans: s.plans }; },
};
