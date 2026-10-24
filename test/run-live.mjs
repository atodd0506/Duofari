#!/usr/bin/env node
// Runs Duofari against live websites in an emulated folded iPhone Duo and
// checks the invariants that must hold on any page:
//   - no text or control moves, sideways or up and down (live pages move
//     content up and down by themselves, so only a move that is gone again
//     once Duofari is off counts);
//   - no hidden text becomes visible beside the viewport;
//   - the page doesn't stay scrolled sideways;
//   - turning Duofari off restores every element it touched, the touch
//     settings of html and body, and the viewport meta;
//   - no error is thrown from Duofari's code.
// Writes before/after previews to test/output/live/.
//
//   node test/run-live.mjs                 # the default site list
//   node test/run-live.mjs https://…       # specific pages

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import {
  POSES, SOURCE_URL, newDuoContext, orientPage, injectDuofari, snapshot, duofariState, checkInvariants, verticalDrift, settle,
  emulateSafariMinimumScale,
} from './lib/duo.mjs';
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
  await orientPage(page, 'folded');
  const errors = [];
  // Only errors thrown in Duofari's own code: live pages throw plenty of their own.
  page.on('pageerror', (e) => { if ((e.stack || '').includes(SOURCE_URL)) errors.push(e.message); });
  const line = { url, name };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await settle(page, 1500);
    await emulateSafariMinimumScale(page);
    // What turning Duofari off has to give back besides the elements it
    // records: the touch settings of html and body, and the viewport meta.
    await page.evaluate(() => {
      const touch = (el) => ['touch-action', 'overscroll-behavior-x'].map((p) => `${el.style.getPropertyValue(p)} ${el.style.getPropertyPriority(p)}`).join('; ');
      const metas = document.querySelectorAll('meta[name="viewport" i]');
      const meta = metas[metas.length - 1];
      globalThis.__duofariBefore = { touch, html: touch(document.documentElement), body: touch(document.body), meta: meta ? meta.getAttribute('content') : null };
    });
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    const fill = await pageBackground(page);
    const shotBefore = await page.screenshot();
    await orientPage(page, 'folded');
    // Rotating promo bars and late ad slots move content up and down by
    // themselves: what moves while Duofari isn't running isn't its doing.
    let before = await snapshot(page);
    const drifting = new Set();
    for (let i = 0; i < 2; i++) {
      await page.waitForTimeout(300);
      const next = await snapshot(page);
      for (const key of verticalDrift(before, next)) drifting.add(key);
      before = next;
    }
    const at = await page.evaluate(() => [window.scrollX, window.scrollY]);

    const t0 = Date.now();
    await injectDuofari(page);
    line.ms = Date.now() - t0;
    const after = await snapshot(page);
    const state = await duofariState(page);
    line.reason = state ? state.status.reason : 'not started';
    line.records = state ? state.records : [];
    // Pages that overflow the viewport by themselves make Chromium widen its
    // layout viewport (and every fixed element) to fit, which Safari doesn't
    // do at minimum scale 1; geometry comparisons there aren't meaningful.
    line.emulationLimited = before.innerWidth > before.vw + 0.5;
    const failures = [];

    if (state && state.status.active) {
      // Toward the end side, where the extended content is: a right-to-left
      // page scrolls to negative x, and +60 would stop at 0 and test nothing.
      await page.evaluate(() => window.scrollTo(getComputedStyle(document.documentElement).direction === 'rtl' ? -60 : 60, window.scrollY));
      await page.waitForTimeout(450);
      const x = await page.evaluate(() => window.scrollX);
      const own = await page.evaluate(() => globalThis.Duofari.controller.state.allowance);
      if (Math.abs(x) > own + 0.5) failures.push(`page left scrolled sideways (scrollX ${x}, own overflow ${own})`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await settle(page, 200);
      const shotAfter = await capturePair(page, { C, vw, vh: pose.viewport.height });
      await orientPage(page, 'folded');
      await writeFile(join(OUT, `${name}.png`), await renderPreview(browser, {
        before: shotBefore, after: shotAfter, fill, C, vw, vh: pose.viewport.height, title: url,
      }));
      // Turning Duofari off puts back every declaration it changed, as the
      // page had it, and the meta and touch settings it started with.
      // (Records are dropped whether or not the styles came back, so their
      // count alone proves nothing.)
      failures.push(...await page.evaluate(() => {
        const D = globalThis.Duofari;
        const before = globalThis.__duofariBefore;
        const decls = (style) => Object.fromEntries([...style].map((p) => [p, `${style.getPropertyValue(p)}${style.getPropertyPriority(p) ? ' !important' : ''}`]));
        const differ = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]);
        const put = (to, prop, value) => { if (value) to[prop] = value; else delete to[prop]; };
        const scratch = document.createElement('div');
        // What each element has to be left with: the page's declarations as
        // they are now (a scroll handler may have set some since Duofari
        // started), with each one Duofari holds back to the value it
        // replaced. Duofari's own are always !important and a script's
        // hardly ever, so one that still is and isn't in the page's style
        // attribute goes back to the page's.
        const touched = [...D.records.values()].map((rec) => {
          scratch.setAttribute('style', rec.styleAttr || '');
          const original = decls(scratch.style);
          const want = decls(rec.el.style);
          for (const [prop, value] of Object.entries(want)) {
            const saved = rec.applied.has(prop) && value === `${rec.applied.get(prop)} !important` && rec.saved.get(prop);
            const back = saved ? saved.value && `${saved.value}${saved.priority ? ' !important' : ''}` : value;
            put(want, prop, back && back.endsWith(' !important') && back !== original[prop] ? original[prop] : back);
          }
          return { el: rec.el, want, original, attr: rec.styleAttr };
        });
        D.controller.state.settings.enabled = false;
        D.controller.run();
        const out = [];
        const label = (el) => `${el.localName}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
        if (D.records.size) out.push(`${D.records.size} elements still recorded after turning off`);
        for (const { el, want, original, attr } of touched) {
          const now = decls(el.style);
          const wrong = differ(now, want);
          if (wrong.length) {
            out.push(`${label(el)} not restored: ${wrong.map((p) => `${p} ${JSON.stringify(now[p] || '')}, wanted ${JSON.stringify(want[p] || '')}`).join('; ')}`);
          } else if (!differ(now, original).length && el.getAttribute('style') !== attr) {
            // Back to the page's own declarations, so back to its attribute too.
            out.push(`${label(el)} style attribute not put back: ${JSON.stringify(el.getAttribute('style'))}, was ${JSON.stringify(attr)}`);
          }
        }
        let marks = document.querySelectorAll('[data-duofari]').length;
        for (const host of document.querySelectorAll('*')) if (host.shadowRoot) marks += host.shadowRoot.querySelectorAll('[data-duofari]').length;
        if (marks) out.push(`${marks} elements still marked data-duofari`);
        for (const [key, el] of [['html', document.documentElement], ['body', document.body]]) {
          if (before.touch(el) !== before[key]) out.push(`${key} touch settings not restored: "${before.touch(el)}", was "${before[key]}"`);
        }
        const metas = document.querySelectorAll('meta[name="viewport" i]');
        const meta = metas[metas.length - 1];
        if ((meta ? meta.getAttribute('content') : null) !== before.meta) out.push(`viewport meta not restored: ${meta && meta.getAttribute('content')}, was ${before.meta}`);
        return out;
      }));

      // A move up or down was Duofari's only if it's gone again now.
      await page.evaluate(([x, y]) => window.scrollTo(x, y), at);
      await settle(page);
      for (const key of verticalDrift(before, await snapshot(page))) drifting.add(key);
      if (!line.emulationLimited) failures.unshift(...checkInvariants(before, after, { C, strictExpect: false, drifting }));
    }
    failures.push(...errors.map((e) => `script error: ${e}`));
    line.failures = failures;
  } catch (error) {
    line.failures = [`could not test: ${error.message.split('\n')[0]}`];
    line.skipped = true;
  }
  const counts = {};
  for (const r of line.records || []) counts[r.kind] = (counts[r.kind] || 0) + 1;
  console.log(`${line.skipped ? '–' : line.failures.length ? '✗' : '✓'} ${url} — ${line.reason || ''} ${JSON.stringify(counts)}${line.ms ? ` ${line.ms}ms` : ''}${line.emulationLimited ? ' (page overflows by itself: geometry checks skipped)' : ''}`);
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
