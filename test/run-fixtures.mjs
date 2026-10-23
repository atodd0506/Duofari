#!/usr/bin/env node
// Runs Duofari against the fixture pages in an emulated folded iPhone Duo and
// checks that it extends what it should, never moves text or controls, holds
// the page still, stays off where it should, and reverts cleanly.
//
//   node test/run-fixtures.mjs            # all checks, previews in test/output/
//   node test/run-fixtures.mjs blog news  # only fixtures whose name matches

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import { serve } from './lib/server.mjs';
import { POSES, newDuoContext, injectDuofari, snapshot, duofariState, checkInvariants, settle, emulateSafariMinimumScale } from './lib/duo.mjs';
import { capturePair, pageBackground, renderPreview } from './lib/preview.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'output');

const CASES = [
  { name: 'appstore-story', file: 'appstore-story.html', expectActive: true, minExtended: 2 },
  { name: 'blog', file: 'blog.html', expectActive: true, minExtended: 4, expectMeta: /initial-scale=1/ },
  { name: 'news', file: 'news.html', expectActive: true, minExtended: 4 },
  { name: 'edge-cases', file: 'edge-cases.html', expectActive: true, minExtended: 6 },
  { name: 'rtl', file: 'rtl.html', expectActive: true, minExtended: 2, rtl: true },
  { name: 'spa', file: 'spa.html', expectActive: true, minExtended: 1, spa: true },
  { name: 'offcanvas', file: 'offcanvas.html', expectActive: true, minExtended: 2 },
  { name: 'appstore-mirror', file: 'appstore-story.html', expectActive: true, settings: { imageStyle: 'mirror' }, strictExpect: false },
  { name: 'appstore-landscape', file: 'appstore-story.html', pose: 'folded-landscape', expectActive: true, left: true, right: true, minExtended: 2 },
  { name: 'desktop-layout', file: 'desktop.html', expectActive: false, reason: 'desktop-layout' },
  { name: 'unfolded', file: 'appstore-story.html', pose: 'unfolded', expectActive: false, reason: 'no-column' },
  { name: 'other-iphone', file: 'appstore-story.html', pose: 'iphone', expectActive: false, reason: 'not-duo' },
  { name: 'disabled', file: 'appstore-story.html', expectActive: false, reason: 'disabled', settings: { enabled: false } },
];

const filter = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const server = await serve(join(HERE, 'fixtures'));
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

let failed = 0;
const report = [];

for (const c of CASES) {
  if (filter.length && !filter.some((f) => c.name.includes(f))) continue;
  const pose = POSES[c.pose || 'folded'];
  const left = !!c.left;
  const right = c.right !== undefined ? c.right : !c.left;
  const context = await newDuoContext(browser, c.pose || 'folded');
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[Duofari]')) errors.push(m.text()); });

  await page.goto(`${server.origin}/${c.file}`, { waitUntil: 'load' });
  await emulateSafariMinimumScale(page);
  await settle(page, 300);
  const domBefore = await page.evaluate(() => document.documentElement.outerHTML);
  const before = await snapshot(page);
  const vw = before.vw;
  const vh = pose.viewport.height;
  const fill = await pageBackground(page);
  const shotBefore = await page.screenshot();

  await injectDuofari(page, c.settings || {});
  if (c.spa) {
    await page.evaluate(() => window.navigateTo('/b'));
    await settle(page, 500);
    await page.evaluate(() => window.navigateTo('/a'));
    await settle(page, 500);
  }
  const state = await duofariState(page);
  const failures = [];
  const C = pose.column;

  if (!state) failures.push('Duofari did not start');
  else if (state.status.active !== c.expectActive) {
    failures.push(`expected active=${c.expectActive}, got ${state.status.active} (${state.status.reason})`);
  }
  if (state && c.reason && state.status.reason !== c.reason) failures.push(`expected reason ${c.reason}, got ${state.status.reason}`);

  if (c.expectActive && state) {
    if (Math.abs(state.status.column - C) > 0.5) failures.push(`column ${state.status.column}, expected ${C}`);
    if (state.status.left !== left || state.status.right !== right) failures.push(`sides left=${state.status.left} right=${state.status.right}`);
    const extended = state.records.filter((r) => r.kind !== 'pin' && r.kind !== 'clipper').length;
    if (c.minExtended && extended < c.minExtended) failures.push(`only ${extended} elements extended, expected ≥ ${c.minExtended}`);
    if (c.expectMeta && !c.expectMeta.test(state.viewport || '')) failures.push(`viewport meta not fixed: ${state.viewport}`);
    if (!c.spa) {
      const after = await snapshot(page);
      failures.push(...checkInvariants(before, after, { C, left, right, strictExpect: c.strictExpect !== false }));
    }
    // (RTL documents can't scroll past their right edge, so they never get wider.)
    // (Fixed elements don't add to the scrollable area, so a page whose only
    // extension is a fixed header doesn't get wider either.)
    if (!c.rtl && state.status.right && state.records.some((r) => r.recipe !== 'mirror' && !r.fixed) && state.scrollWidth < vw + C - 1) {
      failures.push(`document isn't wide enough to reach the column: scrollWidth ${state.scrollWidth}`);
    }

    // The guard puts a sideways-scrolled page back.
    await page.evaluate(() => window.scrollTo(60, window.scrollY));
    await page.waitForTimeout(450);
    const x = await page.evaluate(() => window.scrollX);
    if (Math.abs(x) > 0.5) failures.push(`page left scrolled sideways (scrollX ${x})`);
    if (!/pan-y/.test(state.touchAction)) failures.push(`touch-action not restricted (${state.touchAction})`);

    // Preview images.
    if (right) {
      const shotAfter = await capturePair(page, { C, vw, vh });
      const png = await renderPreview(browser, { before: shotBefore, after: shotAfter, fill, C, vw, vh, title: c.name });
      await writeFile(join(OUT, `${c.name}.png`), png);
    }

    // Turning Duofari off restores the page exactly.
    await page.evaluate(() => {
      globalThis.Duofari.controller.state.settings.enabled = false;
      globalThis.Duofari.controller.run();
    });
    const domAfter = await page.evaluate(() => document.documentElement.outerHTML);
    if (!c.spa && domAfter !== domBefore) {
      failures.push('DOM differs after turning Duofari off');
      await writeFile(join(OUT, `${c.name}.dom-before.html`), domBefore);
      await writeFile(join(OUT, `${c.name}.dom-after.html`), domAfter);
    }
  } else if (state && state.records.length) {
    failures.push(`changed ${state.records.length} elements while inactive`);
  }

  failures.push(...errors.map((e) => `page error: ${e}`));
  report.push({ name: c.name, failures, records: state ? state.records : [] });
  console.log(`${failures.length ? '✗' : '✓'} ${c.name}${state ? ` — ${state.status.reason}, ${state.records.length} changes` : ''}`);
  for (const f of failures) console.log(`    ${f}`);
  if (process.env.VERBOSE && state) for (const r of state.records) console.log(`      ${r.kind}/${r.recipe} ${r.el}`);
  failed += failures.length ? 1 : 0;
  await context.close();
}

await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
await browser.close();
await server.close();
console.log(failed ? `\n${failed} case(s) failed` : '\nAll cases passed');
process.exit(failed ? 1 : 0);
