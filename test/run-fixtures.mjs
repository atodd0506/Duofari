#!/usr/bin/env node
// Runs Duofari against the fixture pages in an emulated folded iPhone Duo and
// checks that it extends what it should, never moves text, controls or
// pseudo-elements, shows art (not a background) where it claims to, holds
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
  { name: 'blog-breakout', file: 'blog.html', active: true, settings: { breakout: true }, allowVertical: true,
    expect: { '#figure-img': 'breakout' } },
  { name: 'news', file: 'news.html', active: true, min: 6 },
  { name: 'edge-cases', file: 'edge-cases.html', active: true, min: 8 },
  { name: 'compat', file: 'compat.html', active: true, min: 6 },
  { name: 'images', file: 'images.html', active: true, min: 2 },
  { name: 'images-all', file: 'images.html', active: true, settings: { allImages: true },
    expect: { '#second': 'bleed' }, probe: { '#second': 'image' } },
  { name: 'overflow-root', file: 'overflow-root.html', active: true, min: 2 },
  { name: 'overflow-root-parked', file: 'overflow-root.html?parked', active: true,
    expect: { header: 'none', 'img.hero': 'none' }, probe: { header: 'page', 'img.hero': 'page' } },
  { name: 'app-shell', file: 'app-shell.html', active: true, min: 2, appShell: '#app' },
  { name: 'menus', file: 'menus.html', active: true, min: 1, steps: 'menus' },
  { name: 'clone', file: 'news.html', active: true, steps: 'clone' },
  { name: 'spa', file: 'spa.html', active: true, min: 2, spa: true },
  { name: 'offcanvas', file: 'offcanvas.html', active: true, min: 2 },
  // Auto landscape extends backgrounds only: the column shows the header's colour.
  { name: 'landscape-right', file: 'appstore-story.html', pose: 'landscape-right', active: true, min: 1,
    expect: { 'header.hero img': 'inset' }, probe: { 'header.hero img': '#5a5a5f' } },
  { name: 'landscape-right-pinned', file: 'appstore-story.html', pose: 'landscape-right', active: true, min: 2,
    settings: { landscapeSide: 'right' } },
  { name: 'landscape-left', file: 'appstore-story.html', pose: 'landscape-left', active: false, reason: 'start-side' },
  { name: 'rtl', file: 'rtl.html', active: false, reason: 'start-side' },
  // A right-to-left page with the column on its end side, the left. The
  // feature's padding box grows leftwards, so its button is pinned back; its
  // art and the revealed banner keep their place (the sun at 521).
  { name: 'rtl-landscape-left', file: 'rtl.html', pose: 'landscape-left', active: true, min: 2,
    expect: { header: 'bleed', 'img.hero': 'none', '.feature': 'bleed', 'img.banner': 'none' },
    probe: { header: '#7a1f5c', 'img.hero': 'page', 'img.banner': 'page' },
    same: { 'img.hero': '100,300,500', '.feature': '510,521,532' } },
  { name: 'rtl-landscape-left-pinned', file: 'rtl.html', pose: 'landscape-left', active: true, min: 4, settings: { landscapeSide: 'left' },
    expect: { header: 'bleed', 'img.hero': 'bleed', '.feature': 'bleed', '.feature .art': 'bleed', 'img.banner': 'bleed' },
    probe: { header: '#7a1f5c', 'img.hero': 'image', '.feature': 'image', 'img.banner': 'image' },
    same: { '.feature': '510,521,532', 'img.banner': '510,521,532' } },
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
  // A full-page shot starts at the document's left edge, which in a
  // right-to-left page is as far left of the viewport as the page overflows.
  const shotOrigin = () => page.evaluate(() => (getComputedStyle(document.documentElement).direction === 'rtl'
    ? document.scrollingElement.scrollWidth - document.documentElement.clientWidth : 0));
  const originBefore = await shotOrigin();
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

    // Scripted interactions after Duofari has settled. Each is undone again,
    // so the page can still be compared with how it started.
    if (c.steps === 'menus') {
      // Only a header extended with the padding recipe lays out menus that
      // open later under the column; with any other recipe this tests nothing.
      if (!state.records.some((r) => r.el === 'header' && r.recipe === 'padding')) failures.push('header not extended with the padding recipe');
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
      // Closed again, the menus keep Duofari's pins until it's turned off.
      await page.evaluate(() => document.getElementById('wrap').removeAttribute('class'));
      await settle(page, 450);
    }
    if (c.steps === 'clone') {
      const cloned = await page.evaluate(async () => {
        const src = document.querySelector('.masthead');
        const copy = src.cloneNode(true);
        copy.id = 'clone';
        copy.classList.add('clone');
        document.body.appendChild(copy);
        await new Promise((r) => setTimeout(r, 50));
        const result = { marked: copy.hasAttribute('data-duofari'), style: copy.getAttribute('style') };
        copy.remove();
        return result;
      });
      if (cloned.marked || (cloned.style && /-84px/.test(cloned.style))) failures.push(`clone kept Duofari's styles: ${cloned.style}`);
      await settle(page, 450);
    }

    if (!c.spa) {
      const after = await snapshot(page);
      failures.push(...checkInvariants(before, after, { C, left, right, vertical: !c.allowVertical }));
    }
    if (state.records.some((r) => !r.fixed) && state.scrollWidth < vw + C - 1) {
      failures.push(`document isn't wide enough to reach the column: scrollWidth ${state.scrollWidth}`);
    }
    if (c.appShell) {
      const sideways = await page.evaluate((sel) => { const el = document.querySelector(sel); return el.scrollWidth - el.clientWidth; }, c.appShell);
      if (sideways > 1) failures.push(`app shell became sideways-scrollable by ${sideways}px`);
    }

    // Pixel probes: what actually shows in the column, and nothing inside the page moves.
    if (points.length) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 200);
      const originAfter = await shotOrigin();
      const fullAfter = await shoot({ fullPage: true, scale: 'css' });
      // Column probes are placed on the right; mirror them for a column on the left.
      const at = (origin) => points.map((p) => ({ ...p, x: origin + (p.kind === 'column' && left ? Math.round(-C / 2) : p.x) }));
      const beforePx = await readPixels(browser, fullBefore, at(originBefore));
      const afterPx = await readPixels(browser, fullAfter, at(originAfter));
      const pageColor = cssColor(fill);
      points.forEach((p, i) => {
        const got = afterPx[i];
        if (p.kind === 'same') {
          if (colorDistance(beforePx[i], got) > 24) failures.push(`${p.name}: pixel at x=${p.x} changed ${beforePx[i]} → ${got}`);
        } else if (p.want === 'image') {
          // Art, not the page or an enclosing band showing its own background.
          const flat = [pageColor, ...p.backgrounds.map(cssColor)].find((color) => colorDistance(got, color) < 20);
          if (!got || flat) failures.push(`${p.name}: column shows ${got ? `a background (${got})` : 'nothing'}, not the art`);
        } else if (p.want === 'page') {
          if (colorDistance(got, pageColor) > 20) failures.push(`${p.name}: column should show page background, got ${got}`);
        } else if (colorDistance(got, hexColor(p.want)) > 30) {
          failures.push(`${p.name}: column pixel ${got}, wanted ${p.want}`);
        }
      });
      // Putting a landscape orientation back after the shot fires a resize,
      // and the run Duofari makes 250 ms later re-measures every box. Let it
      // pass first: during the guard check it could undo a drift by itself.
      await settle(page, 450);
    }

    // The guard puts a sideways-scrolled page back. Scroll toward the end
    // side, where the extended content is: a right-to-left page scrolls to
    // negative x, and a scroll the other way would stop at 0 and test nothing.
    const end = await page.evaluate(() => (getComputedStyle(document.documentElement).direction === 'rtl' ? -60 : 60));
    const scrolled = await page.evaluate((dx) => { window.scrollTo(dx, window.scrollY); return window.scrollX; }, end);
    if (state.scrollWidth > vw + 1 && Math.abs(scrolled) < 1) failures.push(`page didn't scroll sideways to test the guard (scrollWidth ${state.scrollWidth})`);
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
