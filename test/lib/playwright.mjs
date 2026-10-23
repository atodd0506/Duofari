// Locates Playwright: a local dependency first, then well-known global installs.
// Lets the tests and scripts run both in a checked-out repo (`npm install`) and
// in environments that ship Playwright globally.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright() {
  const candidates = [];
  try {
    candidates.push(createRequire(import.meta.url).resolve('playwright'));
  } catch {}
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(join(globalRoot, 'playwright', 'index.js'));
  } catch {}
  candidates.push('/opt/node-tools/node_modules/playwright/index.js');
  for (const file of candidates) {
    if (file && existsSync(file)) {
      const mod = await import(pathToFileURL(file).href);
      return mod.default ?? mod;
    }
  }
  throw new Error('Playwright not found. Run `npm install` in the repository root.');
}
