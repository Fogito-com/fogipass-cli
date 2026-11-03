import { execFileSync } from 'node:child_process';

export function npm(args, options = {}) {
  if (!process.env.npm_execpath) throw new Error('Run this check through npm run.');
  return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, ...options,
  });
}
