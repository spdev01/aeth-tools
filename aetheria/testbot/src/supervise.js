// SUPERVISOR — turn-key keeper for the audit runner.
// Runs runner.js; restarts it automatically if it ever exits non-zero (crash/block).
// Exit 0 (pipeline complete for the given --upto) stops the supervisor cleanly.
// Usage: node src/supervise.js [--upto N] [--char NAME]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const logFile = path.join(root, '..', 'out', 'supervisor.log');
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
  try { console.log(m); } catch {}
};

log(`supervisor start args=[${args.join(' ')}]`);
let restarts = 0;
for (;;) {
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, 'runner.js'), ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, AETHERIA_QUIET: '1' },
    });
    p.on('exit', (c) => resolve(c ?? 0));
  });
  if (code === 0) { log('runner completed cleanly (exit 0) — supervisor exiting'); process.exit(0); }
  restarts++;
  log(`runner exited code=${code} — restart #${restarts} in 30s`);
  await new Promise((r) => setTimeout(r, 30000));
}
