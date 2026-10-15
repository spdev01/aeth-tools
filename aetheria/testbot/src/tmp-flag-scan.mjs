// tmp-flag-scan.mjs — scan ALL bots' captcha ledgers for PENDING JAIL FLAGS.
// Mechanism (confirmed 2026-10-14): an unanswered (expired) captcha becomes a flag that is
// executed at the account's NEXT login. Flag = captcha id with 'seen' but no 'answer' for that id
// (and the prompt is older than the 5-min answer window).
import fs from 'node:fs';
import path from 'node:path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const NOW = Date.now();
const rows = [];
for (const id of fs.readdirSync(BOTS)) {
  const d = path.join(BOTS, id);
  let st;
  try { st = fs.statSync(d); } catch { continue; }
  if (!st.isDirectory()) continue;
  const cap = path.join(d, 'captcha.jsonl');
  if (!fs.existsSync(cap)) continue;
  const seen = new Map(); // cid -> {at, raw}
  let answers = 0, dismissals = 0;
  const flagged = [];
  let lastEvt = null;
  for (const line of fs.readFileSync(cap, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    lastEvt = j.t;
    if (j.evt === 'seen') {
      if (j.id) seen.set(String(j.id), { at: j.t, items: Array.isArray(j.items) ? j.items.length : null, prompt: j.prompt ?? null });
    } else if (j.evt === 'answer') {
      answers++;
      if (j.id) seen.delete(String(j.id));
    } else if (j.evt === 'dismiss') {
      dismissals++;
    }
  }
  // leftover ids = never answered. Treat older-than-10min as expired/flagged; newer = live window.
  for (const [cid, info] of seen) {
    const ageMin = (NOW - Date.parse(info.at)) / 60000;
    flagged.push({ cid, at: info.at, ageMin: Math.round(ageMin), items: info.items, expired: ageMin > 10 });
  }
  // runner code age: newest run file's first timestamp
  let codeAt = null;
  try {
    const rf = fs.readdirSync(d).filter((f) => f.startsWith('run-')).sort().pop();
    if (rf) {
      const first = fs.readFileSync(path.join(d, rf), 'utf8').split('\n', 1)[0];
      try { codeAt = JSON.parse(first).t; } catch {}
    }
  } catch {}
  rows.push({ id: +id, answers, dismissals, flagged, codeAt, lastEvt });
}
rows.sort((a, b) => a.id - b.id);
console.log('=== accounts with PENDING (unanswered) captcha ids ===');
let flaggedCount = 0;
for (const r of rows) {
  const fl = r.flagged.filter((f) => f.expired);
  if (!fl.length) continue;
  flaggedCount++;
  console.log(`bot ${r.id}: ${fl.length} expired-unanswered  |> ` + fl.map((f) => `${f.cid} seen@${f.at.slice(11, 19)} (${f.ageMin}min, items=${f.items})`).join('  |  '));
}
console.log(`\ntotal flagged accounts: ${flaggedCount} / ${rows.length} scanned`);
console.log('\n=== all scanned (id, answers, pending, runnerCodeSince) ===');
for (const r of rows) {
  const pend = r.flagged.length;
  console.log(`${String(r.id).padStart(3)}  ans=${String(r.answers).padStart(3)}  pend=${String(pend).padStart(2)}  codeSince=${r.codeAt ? r.codeAt.slice(5, 16) : '?'}`);
}
