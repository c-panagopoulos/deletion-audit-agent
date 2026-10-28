// Loads KEY=VALUE pairs from the repo-root .env into process.env (without overriding real env vars).
// Secrets are read from the environment only; .env is git-ignored and never committed.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';

export function loadEnv(file = path.join(REPO_ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
