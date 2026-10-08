import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Minimal .env loader (never overrides already-set variables). Searches upward from cwd. */
export function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        if (line.trim().startsWith('#')) continue;
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const v = m[2].replace(/^"(.*)"$/, '$1');
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
      return;
    }
    const up = path.dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}
