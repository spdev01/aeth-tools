// Cross-platform "zip a directory's contents into a file" helper.
// Windows -> PowerShell Compress-Archive; Linux/macOS (e.g. GitHub runners) -> zip.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export function makeZip(srcDir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  if (process.platform === 'win32') {
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'pipe' });
  } else {
    execSync(`zip -r -q "${zipPath}" .`, { cwd: srcDir, stdio: 'pipe' });
  }
  return zipPath;
}
