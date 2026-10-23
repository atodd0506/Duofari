#!/usr/bin/env node
// Runs Duofari against the fixture pages in an emulated folded iPhone Duo and
// checks that it extends what it should, never moves text, controls or
// pseudo-elements, shows art (not page background) where it claims to, holds
// the page still, stays off where it should, and reverts cleanly.
//
//   node test/run-fixtures.mjs            # all cases, previews in test/output/
//   node test/run-fixtures.mjs blog news  # only cases whose name matches

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import { serve } from './lib/server.mjs';
import {
  POSES, newDuoContext, orientPage, injectDuofari, snapshot, duofariState, checkInvariants, settle,
  emulateSafariMinimumScale, probePoints, readPixels, hexColor, cssColor, colorDistance,
} from './lib/duo.mjs';
import { capturePair, pageBackground, renderPreview } from './lib/preview.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'output');

const CASES = [
  { name: 'appstore-story', file: 'appstore-story.html', active: true, min: 2,
    expect: { 'header.hero img': 'bleed' }, same: { 'header.hero img': '60,200,300' } },
  { name: 'blog', file: 'blog.html', active: true, min: 3, meta: /initial-scale=1.*minimum-scale=1|minimum-scale=1.*initial-scale=1/ },
  { name: 'blog-breakout', file: 'blog.html', active: true, settings: { breakout: true },
    expect: { '#figure-img': 'breakout' } },
  { name: 'news', file: 'news.html', active: true, min: 6 },
  { name: 'edge-cases', file: 'edge-cases.html', active: true, min: 8 },
  { name: 'compat', file: 'compat.html', active: true, min: 6 },
  { name: 'images', file: 'images.html', active: true, min: 2 },
  { name: 'images-all', file: 'images.html', active: true, settings: { allImages: true },
    expect: { '#second': 'bleed' }, probe: { '#second': 'image' } },
  { name: 'overflow-root', file: 'overflow-root.html', active: true, min: 2 },
  { name: 'app-shell', file: 'app-shell.html', active: true, min: 2, appShell: '#app' },
  { name: 'menus', file: 'menus.html', active: true, min: 1, steps: 'menus' },
  { name: 'clone', file: 'news.html', active: true, steps: 'clone' },
  { name: 'spa', file: 'spa.html', active: true, min: 2, spa: true },
  { name: 'offcanvas', file: 'offcanvas.html', active: true, min: 2 },
  { name: 'landscape-right', file: 'appstore-story.html', pose: 'landscape-right', active: true, min: 1,
    expect: { 'header.hero img': 'inset' } },
  { name: 'landscape-right-pinned', file: 'appstore-story.html', pose: 'landscape-right', active: true, min: 2,
    settings: { landscapeSide: 'right' } },
  { name: 'landscape-left', file: 'appstore-story.html', pose: 'landscape-left', active: false, reason: 'start-side' },
  { name: 'rtl', file: 'rtl.html', active: false, reason: 'start-side' },
  { name: 'desktop-layout', file: 'desktop.html', active: false, reason: 'desktop-layout' },
  { name: 'unfolded', file: 'appstore-story.html', pose: 'unfolded', active: false, reason: 'no-column' },
  { name: 'other-iphone', file: 'appstore-story.html', pose: 'iphone', active: false, reason: 'not-duo' },
  { name: 'disabled', file: 'appstore-story.html', active: false, reason: 'disabled', settings: { enabled: false } },
  { name: 'site-off', file: 'appstore-story.html', active: false, reason: 'site-disabled', settings: { disabledSites: ['127.0.0.1'] } },
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
  const poseName = c.pose || 'folded';
  const pose = POSES[poseName];
  const context = await newDuoContext(browser, poseName);
  const page = await context.newPage();
  await orientPage(page, poseName);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[Duofari]')) errors.push(m.text()); });

  await page.goto(`${server.origin}/${c.file}`, { waitUntil: 'load' });
  await emulateSafariMinimumScale(page);
  await page.evaluate(({ expect, same, probe }) => {
    for (const [sel, value] of Object.entries(expect || {})) for (const el of document.querySelectorAll(sel)) el.setAttribute('data-expect', value);
    for (const [sel, value] of Object.entries(same || {})) for (const el of document.querySelectorAll(sel)) el.setAttribute('data-probe-same', value);
    for (const [sel, value] of Object.entries(probe || {})) for (const el of document.querySelectorAll(sel)) el.setAttribute('data-probe-column', value);
  }, { expect: c.expect, same: c.same, probe: c.probe });
  await settle(page, 300);
  const C = pose.column;
  const vh = pose.viewport.height;
  const points = await probePoints(page, C);
  // Playwright's screenshots reset the device emulation (and with it the
  // screen orientation), so every capture goes through this.
  const shoot = async (opts) => { const png = await page.screenshot(opts); await orientPage(page, poseName); return png; };
  const fullBefore = await shoot({ fullPage: true, scale: 'css' });
  await settle(page, 200);
  // Everything compared later is measured in the same emulation state.
  const domBefore = await page.evaluate(() => document.documentElement.outerHTML);
  const before = await snapshot(page);
  const vw = before.vw;
  const fill = await pageBackground(page);
  const shotBefore = await shoot({});

  await injectDuofari(page, c.settings || {});
  if (c.spa) {
    await page.evaluate(() => window.navigateTo('/b'));
    await settle(page, 500);
    await page.evaluate(() => window.navigateTo('/a'));
    await settle(page, 600);
  }
  const state = await duofariState(page);
  const failures = [];
  const right = !state || state.status.side !== 'left';
  const left = !!state && state.status.side === 'left';

  if (!state) failures.push('Duofari did not start');
  else if (state.status.active !== c.active) failures.push(`expected active=${c.active}, got ${state.status.active} (${state.status.reason})`);
  if (state && c.reason && state.status.reason !== c.reason) failures.push(`expected reason ${c.reason}, got ${state.status.reason}`);

  if (c.active && state) {
    if (Math.abs(state.status.column - C) > 0.5) failures.push(`column ${state.status.column}, expected ${C}`);
    const extended = state.records.filter((r) => r.kind !== 'pin' && r.kind !== 'clipper').length;
    if (c.min && extended < c.min) failures.push(`only ${extended} elements extended, expected ≥ ${c.min}`);
    if (c.meta && !c.meta.test(state.viewport || '')) failures.push(`viewport meta not fixed: ${state.viewport}`);
    if (state.marks !== state.records.length) failures.push(`${state.marks} marked elements but ${state.records.length} records`);

    // Scripted interactions after Duofari has settled.
    if (c.steps === 'menus') {
      await page.click('.menu-button');
      await settle(page, 450);
      const menu = await page.evaluate(() => [...document.querySelectorAll('.menu a, .search input')]
        .filter((el) => el.getBoundingClientRect().width).map((el) => el.getBoundingClientRect().right));
      if (!menu.length) failures.push('menu did not open');
      for (const r of menu) if (r > vw + 0.5) failures.push(`menu item reaches into the column (right edge ${r.toFixed(1)})`);
      await page.evaluate(() => document.getElementById('wrap').classList.add('searching'));
      await settle(page, 450);
      const search = await page.evaluate(() => document.querySelector('.search input').getBoundingClientRect().right);
      if (search > vw + 0.5) failures.push(`search field reaches into the column (right edge ${search.toFixed(1)})`);
    }
    if (c.steps === 'clone') {
      const cloned = await page.evaluate(async () => {
        const src = document.querySelector('.masthead');
        const copy = src.cloneNode(true);
        copy.id = 'clone';
        copy.classList.add('clone');
        document.body.appendChild(copy);
        await new Promise((r) => setTimeout(r, 50));
        return { marked: copy.hasAttribute('data-duofari'), style: copy.getAttribute('style') };
      });
      if (cloned.marked || (cloned.style && /-84px/.test(cloned.style))) failures.push(`clone kept Duofari's styles: ${cloned.style}`);
    }

    if (!c.spa && !c.steps) {
      const after = await snapshot(page);
      failures.push(...checkInvariants(before, after, { C, left, right }));
    }
    if (state.status.side === 'right' && state.records.some((r) => !r.fixed) && state.scrollWidth < vw + C - 1) {
      failures.push(`document isn't wide enough to reach the column: scrollWidth ${state.scrollWidth}`);
    }
    if (c.appShell) {
      const sideways = await page.evaluate((sel) => { const el = document.querySelector(sel); return el.scrollWidth - el.clientWidth; }, c.appShell);
      if (sideways > 1) failures.push(`app shell became sideways-scrollable by ${sideways}px`);
    }

    // Pixel probes: what actually shows in the column, and nothing inside the page moves.
    if (points.length && right) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 200);
      const fullAfter = await shoot({ fullPage: true, scale: 'css' });
      const beforePx = await readPixels(browser, fullBefore, points);
      const afterPx = await readPixels(browser, fullAfter, points);
      const pageColor = cssColor(fill);
      points.forEach((p, i) => {
        const got = afterPx[i];
        if (p.kind === 'same') {
          if (colorDistance(beforePx[i], got) > 24) failures.push(`${p.name}: pixel at x=${p.x} changed ${beforePx[i]} → ${got}`);
        } else if (p.want === 'image') {
          if (colorDistance(got, pageColor) < 20) failures.push(`${p.name}: column shows page background, not the art`);
        } else if (p.want === 'page') {
          if (colorDistance(got, pageColor) > 20) failures.push(`${p.name}: column should show page background, got ${got}`);
        } else if (colorDistance(got, hexColor(p.want)) > 30) {
          failures.push(`${p.name}: column pixel ${got}, wanted ${p.want}`);
        }
      });
    }

    // The guard puts a sideways-scrolled page back.
    await page.evaluate(() => window.scrollTo(60, window.scrollY));
    await page.waitForTimeout(450);
    const x = await page.evaluate(() => window.scrollX);
    if (Math.abs(x) > 0.5) failures.push(`page left scrolled sideways (scrollX ${x})`);
    if (!/pan-y/.test(state.touchAction)) failures.push(`touch-action not restricted (${state.touchAction})`);

    if (right) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 150);
      const shotAfter = await capturePair(page, { C, vw, vh });
      await orientPage(page, poseName);
      await writeFile(join(OUT, `${c.name}.png`), await renderPreview(browser, { before: shotBefore, after: shotAfter, fill, C, vw, vh, title: c.name }));
    }

    // Turning Duofari off restores the page exactly.
    await page.evaluate(() => {
      globalThis.Duofari.controller.state.settings.enabled = false;
      globalThis.Duofari.controller.run();
    });
    const domAfter = await page.evaluate(() => document.documentElement.outerHTML);
    if (!c.spa && !c.steps && domAfter !== domBefore) {
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
