#!/usr/bin/env node
// Runs Duofari against live websites in an emulated folded iPhone Duo and
// checks the invariants that must hold on any page:
//   - no text or control moves sideways;
//   - no hidden text becomes visible beside the viewport;
//   - the page doesn't stay scrolled sideways;
//   - turning Duofari off restores every element it touched.
// Writes before/after previews to test/output/live/.
//
//   node test/run-live.mjs                 # the default site list
//   node test/run-live.mjs https://…       # specific pages

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import { POSES, newDuoContext, injectDuofari, snapshot, duofariState, checkInvariants, settle } from './lib/duo.mjs';
import { capturePair, pageBackground, renderPreview } from './lib/preview.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'output', 'live');

const SITES = [
  'https://en.m.wikipedia.org/wiki/IPhone',
  'https://www.bbc.com/news',
  'https://www.theguardian.com/international',
  'https://www.apple.com/iphone/',
  'https://developer.apple.com/iphone-duo/prepare/',
  'https://github.com/',
  'https://news.ycombinator.com/',
  'https://www.nytimes.com/',
  'https://www.cnn.com/',
  'https://stripe.com/',
  'https://www.theverge.com/',
  'https://9to5mac.com/',
  'https://webkit.org/',
  'https://developer.mozilla.org/en-US/docs/Web/CSS/overflow',
  'https://www.reddit.com/r/apple/',
  'https://www.amazon.com/',
];

const urls = process.argv.slice(2).length ? process.argv.slice(2) : SITES;
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });
const pose = POSES.folded;
const C = pose.column;
const summary = [];

for (const url of urls) {
  const name = new URL(url).hostname.replace(/^www\./, '') + new URL(url).pathname.replace(/\/$/, '').replace(/[^a-z0-9]+/gi, '-');
  const context = await newDuoContext(browser, 'folded', { reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { if (/Duofari|content-(bleed|classify|main|guard|geometry)/.test(e.stack || e.message)) errors.push(e.message); });
  const line = { url, name };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await settle(page, 1500);
    // Emulate Safari's minimum scale (see emulateSafariMinimumScale).
    await page.evaluate(() => {
      const metas = document.querySelectorAll('meta[name="viewport" i]');
      const meta = metas[metas.length - 1];
      if (meta && /device-width/i.test(meta.content) && !/minimum-scale/i.test(meta.content)) meta.content += ', minimum-scale=1';
    });
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    const fill = await pageBackground(page);
    const shotBefore = await page.screenshot();
    const before = await snapshot(page);

    const t0 = Date.now();
    await injectDuofari(page);
    line.ms = Date.now() - t0;
    const after = await snapshot(page);
    const state = await duofariState(page);
    line.reason = state ? state.status.reason : 'not started';
    line.records = state ? state.records : [];
    const failures = state && state.status.active ? checkInvariants(before, after, { C, strictExpect: false }) : [];

    if (state && state.status.active) {
      await page.evaluate(() => window.scrollTo(60, window.scrollY));
      await page.waitForTimeout(450);
      const x = await page.evaluate(() => window.scrollX);
      if (Math.abs(x) > 0.5) failures.push(`page left scrolled sideways (scrollX ${x})`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 200);
      const shotAfter = await capturePair(page, { C, vw, vh: pose.viewport.height });
      await writeFile(join(OUT, `${name}.png`), await renderPreview(browser, {
        before: shotBefore, after: shotAfter, fill, C, vw, vh: pose.viewport.height, title: url,
      }));
      const leftovers = await page.evaluate(() => {
        globalThis.Duofari.controller.state.settings.enabled = false;
        globalThis.Duofari.controller.run();
        return globalThis.Duofari.records.size;
      });
      if (leftovers) failures.push(`${leftovers} elements still modified after turning off`);
    }
    failures.push(...errors.map((e) => `script error: ${e}`));
    line.failures = failures;
  } catch (error) {
    line.failures = [`could not test: ${error.message.split('\n')[0]}`];
    line.skipped = true;
  }
  const counts = {};
  for (const r of line.records || []) counts[r.kind] = (counts[r.kind] || 0) + 1;
  console.log(`${line.skipped ? '–' : line.failures.length ? '✗' : '✓'} ${url} — ${line.reason || ''} ${JSON.stringify(counts)}${line.ms ? ` ${line.ms}ms` : ''}`);
  for (const f of line.failures.slice(0, 12)) console.log(`    ${f}`);
  if (line.failures.length > 12) console.log(`    … ${line.failures.length - 12} more`);
  summary.push(line);
  await context.close();
}

await writeFile(join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
await browser.close();
const failed = summary.filter((s) => !s.skipped && s.failures.length).length;
console.log(failed ? `\n${failed} site(s) failed` : '\nNo invariant failures');
process.exit(failed ? 1 : 0);
