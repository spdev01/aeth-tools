// tmp-jail107-audit.mjs — full forensic: (a) 107 jail timeline, (b) seen-vs-answered accounting for 101-107.
import fs from 'node:fs';
import path from 'node:path';

const BOTS = 'E:/GitHub/lumivaraonline/aetheria/command-center/data/bots';
const ids = [101, 102, 103, 104, 105, 106, 107];
const line = (s) => console.log(s);

// ---------- A) seen vs answered accounting ----------
line('================ A) CAPTCHA ACCOUNTING ================');
for (const id of ids) {
  const dir = path.join(BOTS, String(id));
  let stats = null;
  try { stats = JSON.parse(fs.readFileSync(path.join(dir, 'captcha-stats.json'), 'utf8')); } catch {}
  let evts = [];
  try {
    evts = fs.readFileSync(path.join(dir, 'captcha.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  const seen = evts.filter((e) => e.evt === 'seen');
  const seenReal = seen.filter((e) => e.id);
  const seenNull = seen.length - seenReal.length;
  const answers = evts.filter((e) => e.evt === 'answer');
  const retries = evts.filter((e) => e.evt === 'retry_received');
  const outcomes = evts.filter((e) => e.evt === 'outcome');
  const skips = evts.filter((e) => ['answer_skip', 'no_match', 'give_up', 'answer_fail'].includes(e.evt));
  // unanswered real captchas: seen id with no answer for that id
  const answeredIds = new Set(answers.map((a) => a.id));
  const unanswered = seenReal.filter((s) => !answeredIds.has(s.id));
  line(`bot ${id}: stats{prompts=${stats?.prompts},answered=${stats?.answered},wrong=${stats?.wrong},success=${stats?.success},lastResult=${stats?.lastResult}} jsonl{seen=${seen.length} real=${seenReal.length} dismissals=${seenNull} answered=${answers.length} retries=${retries.length} outcomes=${outcomes.length} skips=${skips.length} unanswered=${unanswered.length}}`);
  for (const u of unanswered.slice(-6)) line(`    UNANSWERED id=${u.id} at=${u.t} triesLeft=${u.triesLeft} prompt=${JSON.stringify(u.prompt ?? '').slice(0, 40)}`);
  for (const s of skips.slice(-6)) line(`    SKIP ${s.evt} reason=${s.reason ?? s.why ?? ''} at=${s.t}`);
  // wrong answers detail
  for (const r of retries.slice(-4)) line(`    RETRY at=${r.t} id=${r.id} wrongPick=${r.wrongPick} triesLeft=${r.triesLeft}`);
}

// ---------- B) 107 jail timeline ----------
line('');
line('================ B) BOT 107 JAIL TIMELINE ================');
const dir107 = path.join(BOTS, '107');
const runs = fs.readdirSync(dir107).filter((f) => /^run-.*\.jsonl$/.test(f)).map((f) => ({ f, m: fs.statSync(path.join(dir107, f)).mtimeMs })).sort((a, b) => a.m - b.m);
line(`run files: ${runs.map((r) => r.f).join(', ')}`);
// concat all runs' events, find jail moment & captcha context
const all = [];
for (const r of runs) {
  const evts = fs.readFileSync(path.join(dir107, r.f), 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const e of evts) all.push(e);
}
all.sort((a, b) => String(a.t).localeCompare(String(b.t)));
const jailIdx = all.map((e, i) => ({ e, i })).filter((x) => /jail|message:alert/.test(x.e.evt));
for (const { e, i } of jailIdx.slice(0, 3)) {
  line(`--- jail/alert event at ${e.t} : ${e.evt} :: ${JSON.stringify(e.data).slice(0, 160)}`);
  const ctx = all.slice(Math.max(0, i - 40), i + 6).filter((x) => x.evt !== 'HEARTBEAT');
  for (const c of ctx) line(`    ${String(c.t).slice(11, 19)} ${c.evt} ${JSON.stringify(c.data ?? {}).slice(0, 130)}`);
  line('    ─────');
}
// last login/session starts to know what happened after
const tail = all.slice(-25).filter((x) => x.evt !== 'HEARTBEAT');
line('--- last 25 non-heartbeat events overall ---');
for (const c of tail) line(`    ${String(c.t).slice(11, 19)} ${c.evt} ${JSON.stringify(c.data ?? {}).slice(0, 120)}`);
