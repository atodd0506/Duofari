#!/usr/bin/env node
// Regression cases for defects found in review. Each case builds a
// small page around one defect, runs Duofari on it in an emulated folded
// iPhone Duo, and checks the behaviour the fix restored. Every case failed
// before its fix.
//
//   node test/run-regressions.mjs            # all cases
//   node test/run-regressions.mjs engine-4   # only cases whose name matches

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import { serve } from './lib/server.mjs';
import {
  newDuoContext, orientPage, injectDuofari, emulateSafariMinimumScale, settle, snapshot, checkInvariants,
} from './lib/duo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const C = 84;
const VW = 382;
const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;

const page = (style, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body { margin: 0; font: 16px/1.5 system-ui, sans-serif; } p { margin: 0 0 12px; padding: 0 16px; } ${style}</style>
</head><body>${body}</body></html>`;

const paragraphs = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i}</p>`).join('');

/** A wrapper that hides sideways overflow, holding a header bar and a hero. */
const WRAPPER = page(`
  .site { overflow-x: hidden; }
  header { background: #036; color: #fff; padding: 16px; }
  .hero { background: linear-gradient(#a00, #600); color: #fff; height: 200px; padding: 16px; box-sizing: border-box; }`,
`<div class="site" id="site"><header id="hdr">My Blog</header><section class="hero" id="hero">Hero</section>
  <article id="art">${paragraphs(40)}</article></div>`);

/** Turns Duofari off the way the popup does. */
const turnOff = (p) => p.evaluate(() => {
  globalThis.Duofari.controller.state.settings.enabled = false;
  globalThis.Duofari.controller.run();
});

// Controller, guard and popup-facing behaviour (content-main.js, content-guard.js, content-geometry.js).
const LIFECYCLE = [
  {
    name: 'lifecycle-1',
    what: 'a page-sized horizontal scroller (a kanban board) keeps its own scroll position',
    html: page(`
      header { background: #036; color: #fff; padding: 16px; }
      .board { display: flex; gap: 8px; height: 420px; overflow-x: auto; }
      .board > div { flex: 0 0 260px; margin: 8px 0; background: #ddd; }`,
    `<header>Board</header><div class="board" id="board"><div>To do</div><div>Doing</div><div>Review</div><div>Done</div></div>${paragraphs(20)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      await p.evaluate(() => { document.getElementById('board').scrollLeft = 300; });
      await settle(p, 600);
      const x = await p.evaluate(() => document.getElementById('board').scrollLeft);
      if (!near(x, 300)) failures.push(`board scrolled to 300 was put back to ${x}`);
    },
  },

  {
    name: 'lifecycle-2',
    what: 'the touch lock doesn’t bring back a pinch-zoom the page turned off, and leaves touch-action: none alone',
    html: page(`
      html { touch-action: pan-x pan-y; }
      header { background: #036; color: #fff; padding: 16px; }`,
    `<header>App</header>${paragraphs(80)}`),
    async run({ p, cdp, failures, open }) {
      await injectDuofari(p);
      const own = await p.evaluate(() => getComputedStyle(document.documentElement).touchAction);
      if (own !== 'pan-y') failures.push(`html touch-action ${own}, expected pan-y`);
      // A two-finger pinch, which the page itself doesn't allow.
      const fingers = (d) => [{ x: 190 - d, y: 300, id: 1 }, { x: 190 + d, y: 300, id: 2 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(30) });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(30 + i * 10) });
        await p.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(p, 500);
      const scale = await p.evaluate(() => visualViewport.scale);
      if (scale > 1.01) failures.push(`a pinch zoomed the page to ${scale.toFixed(2)}`);

      const second = await open();
      await second.p.addStyleTag({ content: 'html, body { touch-action: none; }' });
      await injectDuofari(second.p);
      const none = await second.p.evaluate(() => [document.documentElement, document.body].map((el) => getComputedStyle(el).touchAction).join(', '));
      if (none !== 'none, none') failures.push(`touch-action: none on html and body became ${none}`);
    },
  },

  {
    name: 'lifecycle-3',
    what: 'the viewport meta fix survives head managers that replace the meta or keep rewriting it',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Site</header>${paragraphs(20)}`)
      .replace('width=device-width, initial-scale=1', 'width=device-width'),
    async run({ p, failures }) {
      // As in Safari 18, which has no Navigation API.
      await p.evaluate(() => Object.defineProperty(globalThis, 'navigation', { value: undefined, configurable: true }));
      await injectDuofari(p);
      const meta = () => p.evaluate(() => [...document.querySelectorAll('meta[name=viewport]')].pop().content);
      // Next.js, Helmet, Turbo: the tag we edited no longer equals the one the
      // next route wants, so it is swapped for a fresh one.
      await p.evaluate(() => {
        document.querySelector('meta[name=viewport]').remove();
        document.head.append(Object.assign(document.createElement('meta'), { name: 'viewport', content: 'width=device-width' }));
        history.pushState({}, '', '/next');
      });
      await settle(p, 400);
      const replaced = await meta();
      if (!/minimum-scale=1/.test(replaced)) failures.push(`a replaced meta was left as "${replaced}"`);
      // unhead: the tag is rewritten in place on every client navigation.
      for (let i = 1; i <= 7; i++) {
        await p.evaluate((i) => {
          document.querySelector('meta[name=viewport]').setAttribute('content', 'width=device-width');
          history.pushState({}, '', `/page-${i}`);
        }, i);
        await settle(p, 300);
        const now = await meta();
        if (!/minimum-scale=1/.test(now)) {
          failures.push(`after in-place rewrite ${i} the meta is "${now}"`);
          break;
        }
      }
    },
  },

  {
    name: 'lifecycle-4',
    what: 'wide content added after Duofari started can be scrolled to, and the lock returns once it is gone',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Stats</header><div id="later"></div>${paragraphs(60)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      // A client-rendered route brings a wide table with no scroll wrapper.
      await p.evaluate(() => {
        document.getElementById('later').innerHTML = `<table style="width: 900px"><tr>${'<td>A value</td>'.repeat(9)}</tr></table>`;
      });
      await settle(p, 600);
      await p.evaluate(() => scrollTo(300, scrollY));
      await settle(p, 600);
      const read = () => p.evaluate(() => ({ x: scrollX, touch: getComputedStyle(document.documentElement).touchAction }));
      const wide = await read();
      if (!near(wide.x, 300) || wide.touch !== 'auto') failures.push(`with a wide table: scrolled to 300, now at ${wide.x}; touch-action ${wide.touch}`);
      await p.evaluate(() => { document.getElementById('later').textContent = ''; });
      await settle(p, 800);
      const gone = await read();
      if (Math.abs(gone.x) > 0.5 || !/pan-y/.test(gone.touch)) failures.push(`with the table gone: scrollX ${gone.x}, touch-action ${gone.touch}`);
    },
  },

  {
    name: 'lifecycle-5',
    what: 'folding and unfolding a few times in a row does not pause Duofari',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Site</header>${paragraphs(20)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      for (const pose of ['unfolded', 'folded', 'unfolded', 'folded']) {
        await orientPage(p, pose);
        await settle(p, 1000);
      }
      const s = await p.evaluate(() => globalThis.Duofari.controller.status());
      if (!s.active) failures.push(`after two fold cycles: active ${s.active}, reason ${s.reason}`);
    },
  },

  {
    name: 'lifecycle-6',
    what: 'the device report the popup asks for on every open changes nothing on the page',
    fixture: 'blog.html',
    async run({ p, failures }) {
      // storage.local as Safari keeps it, with the device stored at startup
      // (stamped with the time, as older versions did).
      await p.evaluate(() => {
        const device = { screenWidth: 466, screenHeight: 678, scale: 3, model: 'iPhone19,1' };
        const store = { breakout: true, device: { ...device, checked: 1 } };
        const listeners = [];
        globalThis.browser = {
          storage: {
            local: {
              get: async (defaults) => ({ ...defaults, ...structuredClone(store) }),
              set: async (patch) => {
                const changes = {};
                for (const [key, value] of Object.entries(patch)) {
                  changes[key] = { oldValue: store[key], newValue: value };
                  store[key] = value;
                }
                for (const fn of listeners) fn(changes, 'local');
              },
            },
            onChanged: { addListener: (fn) => listeners.push(fn) },
          },
          runtime: { onMessage: { addListener() {} } },
        };
        globalThis.reportDevice = () => globalThis.browser.storage.local.set({ device: { ...device, checked: Date.now() } });
      });
      await injectDuofari(p);
      // The reader has scrolled past a photo that was broken out of the margins.
      await p.evaluate(() => scrollTo(0, scrollY + document.getElementById('figure-img').getBoundingClientRect().bottom + 20));
      await settle(p, 500);
      const read = () => p.evaluate(() => ({
        height: document.getElementById('figure-img').getBoundingClientRect().height,
        redone: [...globalThis.Duofari.records.values()].filter((r) => !r.seenByTest).length,
      }));
      await p.evaluate(() => globalThis.Duofari.records.forEach((r) => { r.seenByTest = true; }));
      const before = await read();
      await p.evaluate(() => globalThis.reportDevice());
      await settle(p, 600);
      const after = await read();
      if (!near(after.height, before.height) || after.redone) {
        failures.push(`the same device report again: photo ${before.height.toFixed(1)} → ${after.height.toFixed(1)} px tall, ${after.redone} element(s) extended afresh`);
      }
    },
  },

  {
    name: 'lifecycle-7',
    what: 'a touch whose target removes itself does not leave snap-back waiting for the finger',
    html: page(`
      header { background: #036; color: #fff; padding: 16px; }
      #row { margin: 20px; padding: 20px; background: #ccf; }`,
    `<header>Feed</header><div id="row">A row the feed recycles</div>${paragraphs(80)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const at = await p.evaluate(() => {
        const row = document.getElementById('row');
        row.addEventListener('touchstart', () => row.remove());
        const r = row.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await p.touchscreen.tap(at.x, at.y);
      await settle(p, 300);
      // Focus or find-in-page then shifts the page sideways.
      await p.evaluate(() => scrollTo(60, 0));
      await settle(p, 800);
      const x = await p.evaluate(() => scrollX);
      if (Math.abs(x) > 0.5) failures.push(`page left scrolled sideways (scrollX ${x})`);
    },
  },

  {
    name: 'lifecycle-8',
    what: 'turning Duofari off while zoomed in takes effect at once, and a page that starts zoomed in says so',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Site</header>${paragraphs(20)}`),
    async run({ p, cdp, failures, open }) {
      await injectDuofari(p);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      await settle(p, 500);
      await turnOff(p);
      const s = await p.evaluate(async () => ({ ...(await globalThis.Duofari.controller.status()), marks: document.querySelectorAll('[data-duofari]').length }));
      if (s.active || s.reason !== 'disabled' || s.marks) failures.push(`turned off while zoomed in: active ${s.active}, reason ${s.reason}, ${s.marks} marked element(s)`);

      const second = await open();
      await second.cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      await settle(second.p, 300);
      await injectDuofari(second.p);
      const reason = await second.p.evaluate(async () => (await globalThis.Duofari.controller.status()).reason);
      if (reason !== 'zoomed') failures.push(`a page zoomed in from the start reports "${reason}"`);
    },
  },

  {
    name: 'lifecycle-9',
    what: 'a page that starts zoomed out keeps its zoom and layout width',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Site</header>${paragraphs(20)}`)
      .replace('initial-scale=1', 'initial-scale=0.8'),
    async run({ p, failures }) {
      // The harness pins minimum-scale=1, as Safari effectively does for pages
      // at an initial scale of 1; this one starts at 0.8, so give it its own meta back.
      await p.evaluate(() => document.querySelector('meta[name=viewport]').setAttribute('content', 'width=device-width, initial-scale=0.8'));
      await settle(p, 300);
      const read = () => p.evaluate(() => ({ width: document.documentElement.clientWidth, scale: visualViewport.scale }));
      const plain = await read();
      await injectDuofari(p);
      const now = await read();
      if (!near(now.width, plain.width) || Math.abs(now.scale - plain.scale) > 0.01) {
        failures.push(`laid out ${plain.width} px wide at ${plain.scale.toFixed(2)}, now ${now.width} px at ${now.scale.toFixed(2)}`);
      }
    },
  },

  {
    name: 'engine-r2-10',
    what: 'custom properties written every frame, and a ticking clock, inside an opened wrapper bring no stream of scans',
    html: page(`
      .site { overflow-x: hidden; }
      header { background: #036; color: #fff; padding: 16px; }`,
    `<div class="site" id="site"><header>My Blog <span id="clock">0</span></header><article>${paragraphs(400)}</article></div>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const s = await p.evaluate(async () => {
        const D = globalThis.Duofari;
        const scan = D.scan;
        let scans = 0;
        D.scan = (ctx) => { scans++; return scan(ctx); };
        const counted = async (ms, step) => {
          scans = 0;
          const t0 = performance.now();
          while (performance.now() - t0 < ms) await step();
          await new Promise((r) => setTimeout(r, 400));
          return scans;
        };
        const site = document.getElementById('site');
        const clock = document.getElementById('clock');
        // A scroll-linked effect, then a clock updating four times a second.
        const vars = await counted(1500, () => new Promise((r) => requestAnimationFrame(() => { site.style.setProperty('--progress', String(Math.random())); r(); })));
        let tick = 0;
        const ticks = await counted(3000, () => new Promise((r) => setTimeout(() => { clock.textContent = String(++tick); r(); }, 250)));
        return { vars, ticks, padding: getComputedStyle(site).paddingRight };
      });
      if (s.vars > 1) failures.push(`custom-property writes on the wrapper brought ${s.vars} scans in 1.5 s`);
      if (s.ticks > 2) failures.push(`a clock ticking in the wrapper brought ${s.ticks} scans in 3 s`);
      if (s.padding !== `${C}px`) failures.push(`wrapper no longer opened (padding-right ${s.padding})`);
    },
  },

  {
    name: 'platform-3',
    what: 'an SVG file shown on its own tells the popup that Duofari can’t change it',
    html: page('', ''),
    async run({ p, failures }) {
      const url = p.url().replace(/[^/]*$/, 'logo.svg');
      await p.route(url, (route) => route.fulfill({ contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#036"/></svg>' }));
      await p.goto(url);
      await p.evaluate(() => {
        globalThis.listeners = [];
        globalThis.browser = { runtime: { onMessage: { addListener: (fn) => globalThis.listeners.push(fn) } } };
      });
      // Injected by Safari, then again by the popup's Apply.
      const { extensionSource } = await import('./lib/duo.mjs');
      const source = await extensionSource();
      await p.evaluate(source);
      await p.evaluate(source);
      const s = await p.evaluate(() => new Promise((resolve) => {
        for (const fn of globalThis.listeners) fn({ type: 'duofari:status' }, {}, (reply) => resolve({ reply, listeners: globalThis.listeners.length }));
        setTimeout(() => resolve({ reply: null, listeners: globalThis.listeners.length }), 300);
      }));
      if (!s.reply || s.reply.reason !== 'unsupported-document' || s.listeners !== 1) {
        failures.push(`status ${JSON.stringify(s.reply)} from ${s.listeners} listener(s)`);
      }
    },
  },

  {
    name: 'r3-lifecycle-1',
    what: 'text that changes twice in a row inside an opened wrapper is still checked',
    html: page(`
      .site { overflow-x: hidden; }
      header { background: #036; color: #fff; padding: 16px; }
      #status { white-space: nowrap; padding: 0 16px; }`,
    `<div class="site" id="site"><header>My Blog</header><div id="status">Ready</div>${paragraphs(40)}</div>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const clipRight = () => p.evaluate(() => document.getElementById('site').getBoundingClientRect().right);
      if (!near(await clipRight(), VW + C)) failures.push('wrapper not opened to begin with');
      const status = (text) => p.evaluate((text) => { document.getElementById('status').textContent = text; }, text);
      await status('Loading');
      await settle(p, 500);
      // Too soon after the first change for a scan of its own.
      await status('Saved to https://example.com/a/very/long/path/that/does/not/wrap/at/all/and/keeps/going');
      await settle(p, 5600);
      const right = await clipRight();
      if (right > VW + 0.5) failures.push(`the long status shows under the column 5.6 s later (wrapper clips at ${right})`);
    },
  },

  {
    name: 'r3-lifecycle-2',
    what: 'an app shell held still can be scrolled once the page puts wide content of its own in it',
    html: page(`
      html, body { height: 100%; overflow: hidden; }
      #app { height: 100%; overflow-y: auto; }
      header { background: #036; color: #fff; padding: 16px; }`,
    `<div id="app"><header>Shell</header><div id="route"></div>${paragraphs(80)}</div>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      // A client-rendered route brings a wide table, with no scroll wrapper of its own.
      await p.evaluate(() => {
        document.getElementById('route').innerHTML = `<table style="width: 900px"><tr>${'<td>A value</td>'.repeat(9)}</tr></table>`;
      });
      await settle(p, 600);
      await p.evaluate(() => { document.getElementById('app').scrollLeft = 300; });
      await settle(p, 600);
      const x = await p.evaluate(() => document.getElementById('app').scrollLeft);
      if (!near(x, 300)) failures.push(`shell scrolled to 300 was put back to ${x}`);
    },
  },

  {
    name: 'r3-lifecycle-3',
    what: 'a page that switches to a desktop viewport whenever something is extended makes Duofari stand down',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Site</header>${paragraphs(20)}
      <script>
        const meta = document.querySelector('meta[name=viewport]');
        globalThis.toggles = 0;
        setInterval(() => {
          const widened = !!document.querySelector('[data-duofari]');
          if (widened === /width=600/.test(meta.content)) return;
          meta.content = widened ? 'width=600, initial-scale=0.6367' : 'width=device-width, initial-scale=1';
          globalThis.toggles++;
        }, 300);
      </script>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      await settle(p, 6000);
      const s = await p.evaluate(async () => ({ ...(await globalThis.Duofari.controller.status()), toggles: globalThis.toggles }));
      await settle(p, 2000);
      const more = (await p.evaluate(() => globalThis.toggles)) - s.toggles;
      if (s.reason !== 'unstable' || more) failures.push(`after 6 s: active ${s.active}, reason ${s.reason}; the page switched its meta ${more} more time(s) in the next 2 s`);
    },
  },

  {
    name: 'r3-lifecycle-4',
    what: 'zooming in keeps the reason Duofari is idle (unfolded, not an iPhone Duo)',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Site</header>${paragraphs(20)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const reason = () => p.evaluate(async () => {
        globalThis.Duofari.controller.run();
        return (await globalThis.Duofari.controller.status()).reason;
      });
      for (const [pose, expected] of [['unfolded', 'no-column'], ['iphone', 'not-duo']]) {
        const cdp = await orientPage(p, pose);
        await settle(p, 600);
        const plain = await reason();
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
        await settle(p, 500);
        const zoomed = await reason();
        if (plain !== expected || zoomed !== expected) failures.push(`${pose}: reason ${plain}, and ${zoomed} once zoomed in`);
        await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
        await settle(p, 300);
      }
    },
  },

  {
    name: 'r3-lifecycle-7',
    what: 'without the Navigation API, a page rewriting the viewport meta is left to it after five repairs, until its next route',
    html: page('header { background: #036; color: #fff; padding: 16px; }', `<header>Site</header>${paragraphs(20)}`)
      .replace('width=device-width, initial-scale=1', 'width=device-width'),
    async run({ p, failures }) {
      await p.evaluate(() => Object.defineProperty(globalThis, 'navigation', { value: undefined, configurable: true }));
      await injectDuofari(p);
      const meta = () => p.evaluate(() => [...document.querySelectorAll('meta[name=viewport]')].pop().content);
      const rewrite = (path) => p.evaluate((path) => {
        document.querySelector('meta[name=viewport]').setAttribute('content', 'width=device-width');
        if (path) history.pushState({}, '', path);
      }, path);
      for (let i = 0; i < 6; i++) {
        await rewrite(null);
        await settle(p, 200);
      }
      const insisted = await meta();
      if (insisted !== 'width=device-width') failures.push(`a sixth rewrite within 10 s was repaired too ("${insisted}")`);
      // A client-side route (history.pushState) starts afresh.
      await rewrite('/next');
      await settle(p, 300);
      const routed = await meta();
      if (!/minimum-scale=1/.test(routed)) failures.push(`on the next route the meta is "${routed}"`);
    },
  },

  {
    name: 'r3-engine-6',
    what: 'text edited in place inside an opened wrapper (as React updates it) is checked',
    html: page(`
      .wrap { overflow-x: hidden; }
      .wrap header { background: #036; color: #fff; padding: 16px; }`,
    `<div class="wrap" id="text"><header>Text</header><p id="link">Short</p></div>${paragraphs(10)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const clipRight = () => p.evaluate(() => document.getElementById('text').getBoundingClientRect().right);
      if (!near(await clipRight(), VW + C)) failures.push('wrapper not opened to begin with');
      await p.evaluate(() => { document.getElementById('link').firstChild.data = 'https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all'; });
      await settle(p, 800);
      const right = await clipRight();
      if (right > VW + 0.5) failures.push(`text that got longer shows under the column (wrapper clips at ${right})`);
    },
  },
];

// The engine: choosing, extending and restoring boxes (content-bleed.js, content-classify.js).
const ENGINE = [
  {
    name: 'engine-1',
    what: 'a lifted fixed header stays extended through later scans',
    html: page(`
      .bar { position: fixed; top: 0; left: 0; width: 100%; height: 56px; box-sizing: border-box; padding: 16px; background: #036; color: #fff; z-index: 5; }
      main { padding-top: 72px; }`,
    `<header class="bar" id="hdr">Site</header><main id="main">${paragraphs(80)}</main>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const read = () => p.evaluate(() => {
        const D = globalThis.Duofari;
        const el = document.getElementById('hdr');
        const rec = D.records.get(el);
        return { right: el.getBoundingClientRect().right, lifted: !!(rec && rec.lifted), intact: !!rec && D.stylesIntact(rec), blocked: D.blocked.has(el) };
      });
      const first = await read();
      if (!first.lifted || !first.intact) failures.push(`after extending: lifted ${first.lifted}, own styles intact ${first.intact}`);
      // Ordinary DOM insertions (ads, lazy content) each bring a scan.
      for (let i = 0; i < 8; i++) {
        await p.evaluate((i) => {
          const el = document.createElement('p');
          el.textContent = `Late paragraph ${i}`;
          document.getElementById('main').appendChild(el);
        }, i);
        await settle(p, 350);
      }
      const last = await read();
      if (!near(last.right, VW + C) || last.blocked) failures.push(`after 8 scans: right edge ${last.right}, blocked ${last.blocked}`);
    },
  },

  {
    name: 'engine-2',
    what: 'opening a clipper reveals no hidden text, pseudo-element, shadow content or late content',
    html: page(`
      .ticker { overflow: hidden; white-space: nowrap; background: #c00; color: #fff; padding: 8px 16px; }
      .wrap { overflow-x: hidden; }
      .wrap header { background: #036; color: #fff; padding: 16px; }
      .badge::after { content: 'NEW ARRIVALS'; position: absolute; left: 100%; white-space: nowrap; }
      .badge { position: relative; }`,
    `<div class="ticker">BREAKING: Parliament votes on budget tonight as protests continue outside the building</div>
      <div class="wrap" id="text"><header>Text</header><p>Download https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all/abcdefghijkl now.</p></div>
      <div class="wrap" id="pseudo"><header class="badge" id="badge">Pseudo</header></div>
      <div class="wrap" id="shadow"><header>Shadow</header><site-drawer></site-drawer></div>
      <div class="wrap" id="late"><header>Late</header><div id="late-main">${paragraphs(3)}</div></div>
      <div class="wrap" id="drawer" style="position: relative"><header>Drawer</header>${paragraphs(3)}</div>
      <script>customElements.define('site-drawer', class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML =
          '<style>:host { display: block; position: relative; height: 0 } nav { position: absolute; top: -40px; left: 100%; width: 200px; background: #fff; }</style><nav><a href="/account">My account</a></nav>'; }
      });</script>`),
    async run({ p, failures, before }) {
      await injectDuofari(p);
      const after = await snapshot(p);
      failures.push(...checkInvariants(before, after, { C }).filter((f) => /hidden text revealed/.test(f)));
      // Each wrapper hides content that starts at the layout viewport's edge,
      // so its clip (it has no border) must still end there.
      const clipRight = (id) => p.evaluate((id) => document.getElementById(id).getBoundingClientRect().right, id);
      for (const [id, what] of [['pseudo', '::after past the edge'], ['shadow', 'shadow-DOM drawer']]) {
        const right = await clipRight(id);
        if (right > VW + 0.5) failures.push(`${what} shows under the column (wrapper clips at ${right})`);
      }
      // Added after the wrappers were opened up: a tag strip, and an
      // off-canvas drawer parked past the edge of a positioned wrapper.
      await p.evaluate(() => {
        document.getElementById('late-main').insertAdjacentHTML('afterbegin',
          '<div style="display:flex;gap:8px;white-space:nowrap;padding:0 16px"><a href="#">Politics</a><a href="#">World</a>' +
          '<a href="#">Business</a><a href="#">Technology</a><a href="#">Science</a><a href="#">Health</a><a href="#">Sport</a></div>');
        document.getElementById('drawer').insertAdjacentHTML('beforeend',
          '<div><nav style="position:absolute;top:0;left:100%;width:200px;background:#fff"><a href="/account">My account</a></nav></div>');
      });
      await settle(p, 800);
      for (const [id, what] of [['late', 'late tag strip'], ['drawer', 'drawer added later']]) {
        const right = await clipRight(id);
        if (right > VW + 0.5) failures.push(`${what} shows under the column (wrapper clips at ${right})`);
      }
    },
  },

  {
    name: 'engine-3',
    what: 'a wrapper stays open after pinch-zooming, and is opened again after a class change',
    html: WRAPPER,
    async run({ p, cdp, failures }) {
      await injectDuofari(p);
      const read = () => p.evaluate(() => {
        const D = globalThis.Duofari;
        const site = document.getElementById('site');
        const rec = D.records.get(site);
        return { recipe: rec ? rec.recipe : null, site: site.getBoundingClientRect().right, hdr: document.getElementById('hdr').getBoundingClientRect().right };
      });
      const check = (label, s) => {
        if (s.recipe !== 'padding' || !near(s.site, VW + C) || !near(s.hdr, VW + C)) {
          failures.push(`${label}: wrapper ${s.recipe ? `extended (${s.recipe})` : 'not extended'}, clipping at ${s.site}; header ends at ${s.hdr}`);
        }
      };
      check('before', await read());
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      await settle(p, 600);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await settle(p, 800);
      await p.evaluate(() => document.getElementById('art').append(Object.assign(document.createElement('p'), { textContent: 'More' })));
      await settle(p, 800);
      check('after zooming in and out', await read());
      await p.evaluate(() => document.getElementById('site').classList.add('nav-open'));
      await settle(p, 800);
      check('after a class change on the wrapper', await read());
    },
  },

  {
    name: 'engine-4',
    what: "a restyled header's own transitions run instead of snapping",
    html: page(`
      .bar { position: sticky; top: 0; height: 56px; box-sizing: border-box; padding: 16px; background: #036; color: #fff; z-index: 5;
        transition: transform .6s linear; }
      .bar.unpinned { transform: translateY(-100%); }
      .fixed { position: fixed; top: 0; left: 0; right: 0; height: 56px; padding: 16px; box-sizing: border-box; background: #4a2c82; color: #fff;
        z-index: 6; transition: translate .6s linear; }
      .fixed.hide { translate: 0 -100%; }`,
    `<header class="bar" id="sticky">Sticky</header><header class="fixed" id="fixed">Fixed</header><main>${paragraphs(60)}</main>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      await settle(p, 400);
      // Where each header is 200 ms into its 600 ms slide (a third of the way, -19 px).
      const midway = (id, cls) => p.evaluate(async ({ id, cls }) => {
        const el = document.getElementById(id);
        const top0 = el.getBoundingClientRect().top;
        el.classList.add(cls);
        const t0 = performance.now();
        while (performance.now() - t0 < 200) await new Promise((r) => requestAnimationFrame(r));
        return el.getBoundingClientRect().top - top0;
      }, { id, cls });
      for (const [id, cls] of [['sticky', 'unpinned'], ['fixed', 'hide']]) {
        const dy = await midway(id, cls);
        if (!(dy < -3 && dy > -50)) failures.push(`#${id}: moved ${dy.toFixed(1)} px after 200 ms of a 600 ms slide (expected about -19)`);
      }
      await settle(p, 1000);
      const right = await p.evaluate(() => document.getElementById('sticky').getBoundingClientRect().right);
      if (!near(right, VW + C)) failures.push(`#sticky not extended again once its transition ended (right edge ${right})`);
    },
  },

  {
    name: 'engine-5',
    what: 'pictures are measured again when their src changes',
    html: page(`
      img.lead { display: block; width: 100%; height: auto; }
      .slide img { display: block; width: 100%; height: 240px; object-fit: cover; }`,
    `<img class="lead" id="lead" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-src="img/photo.jpg">
      <p id="after">First paragraph of the article.</p>${paragraphs(4)}
      <div class="slide"><img id="slide" alt="" src="img/banner.jpg"></div>${paragraphs(20)}`),
    async run({ p, failures }) {
      await p.evaluate(() => document.getElementById('slide').decode());
      await injectDuofari(p);
      const pinned = await p.evaluate(() => getComputedStyle(document.getElementById('slide')).objectPosition);
      await p.evaluate(async () => {
        const lead = document.getElementById('lead');
        lead.src = lead.dataset.src;
        await lead.decode();
        const slide = document.getElementById('slide');
        slide.src = 'img/square.jpg';
        await slide.decode();
      });
      await settle(p, 1200);
      const s = await p.evaluate((vw) => {
        const lead = document.getElementById('lead');
        return { own: (vw * lead.naturalHeight) / lead.naturalWidth, after: document.getElementById('after').getBoundingClientRect().top,
          slide: getComputedStyle(document.getElementById('slide')).objectPosition };
      }, VW);
      // The paragraph has no top margin, so it starts where the image ends.
      if (!near(s.after, s.own)) failures.push(`lead image kept the placeholder's height: text starts at ${s.after.toFixed(1)}, not ${s.own.toFixed(1)}`);
      if (s.slide === pinned) failures.push(`next slide kept the old slide's object-position ${pinned}`);
    },
  },

  {
    name: 'engine-6',
    what: 'positioned boxes deep in a large wrapper, and pseudo-elements of static children, stay put',
    html: page(`
      .hero { position: relative; height: 200px; background: #333; color: #fff; }
      .hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .hero h2 { margin: 0; padding: 16px; }
      .hero h2::after { content: 'NEW'; position: absolute; right: 16px; top: 16px; background: #fc0; color: #000; }
      .site { position: relative; overflow-x: hidden; padding-bottom: 60px; }
      .site header { background: #036; color: #fff; padding: 16px; }
      .top { position: absolute; right: 16px; bottom: 16px; background: #eee; padding: 4px 8px; }`,
    `<section class="hero"><img src="img/hero.jpg" alt=""><h2 data-expect="none" data-pseudo-check>Story</h2></section>
      <div class="site"><header>My Blog</header><article id="art"></article><a class="top" href="#top">Top ↑</a></div>
      <script>const art = document.getElementById('art');
        for (let i = 0; i < 2100; i++) art.insertAdjacentHTML('beforeend', '<p>Para <b>' + i + '</b></p>');</script>`),
    async run({ p, failures, before }) {
      await injectDuofari(p);
      const after = await snapshot(p);
      failures.push(...checkInvariants(before, after, { C }).filter((f) => /control moved|pseudo-element/.test(f)));
      const header = await p.evaluate(() => document.querySelector('.site header').getBoundingClientRect().right);
      if (!near(header, VW + C)) failures.push(`header inside the wrapper not extended (right edge ${header})`);
    },
  },

  {
    name: 'engine-7',
    what: 'foreground in a full-size layer (contained image, centred logo, labelled pseudo) stays put',
    html: page(`
      .product { position: relative; height: 260px; background: #f2f2f2; }
      .product img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
      .brand { position: relative; height: 200px; background: #123; }
      .brand .bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .brand .logo { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      .brand .logo svg { width: 80px; height: 80px; }
      .video { position: relative; height: 200px; background: #000; }
      .video::after { content: '\\25B6  Watch'; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; }`,
    `<section class="product"><img id="product" src="img/square.jpg" alt="Product"></section>${paragraphs(1)}
      <section class="brand" id="brand"><img class="bg" src="img/hero.jpg" alt=""><div class="logo"><svg id="logo" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#fc0"/></svg></div></section>${paragraphs(1)}
      <section class="video" id="video"></section>${paragraphs(10)}`),
    async run({ p, failures }) {
      const measure = () => p.evaluate(async () => {
        await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
        const box = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return `${r.left.toFixed(1)}–${r.right.toFixed(1)}`; };
        return { product: box('product'), logo: box('logo'), label: getComputedStyle(document.getElementById('video'), '::after').width,
          brand: document.getElementById('brand').getBoundingClientRect().right };
      });
      const plain = await measure();
      await injectDuofari(p);
      const now = await measure();
      if (now.product !== plain.product) failures.push(`contained product image moved: ${plain.product} → ${now.product}`);
      if (now.logo !== plain.logo) failures.push(`centred logo moved: ${plain.logo} → ${now.logo}`);
      if (now.label !== plain.label) failures.push(`'Watch' label layer resized: ${plain.label} → ${now.label}`);
      if (!near(now.brand, VW + C)) failures.push(`hero with a cover image not extended (right edge ${now.brand})`);
    },
  },

  {
    name: 'engine-8',
    what: "a page snapshot put back keeps none of Duofari's lock or styles",
    html: WRAPPER,
    async run({ p, cdp, failures, open }) {
      await injectDuofari(p);
      // Turbo-style restoration: cache a clone of <body>, show another page, put the clone back.
      await p.evaluate(() => {
        globalThis.snap = document.body.cloneNode(true);
        const other = document.createElement('body');
        other.innerHTML = '<p>Another page</p>';
        document.body.replaceWith(other);
      });
      await settle(p, 500);
      await p.evaluate(() => document.body.replaceWith(globalThis.snap));
      await settle(p, 700);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      await settle(p, 600);
      const zoomed = await p.evaluate(() => getComputedStyle(document.body).touchAction);
      if (/pan-y/.test(zoomed)) failures.push(`restored <body> still locked while zoomed in (touch-action ${zoomed})`);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
      await settle(p, 400);
      await turnOff(p);
      const off = await p.evaluate(() => document.body.getAttribute('style'));
      if (off) failures.push(`restored <body> keeps style="${off}" after turning Duofari off`);

      // A snapshot taken while on, put back after the user turned Duofari off.
      const second = await open();
      await injectDuofari(second.p);
      await second.p.evaluate(() => { globalThis.snap = document.body.cloneNode(true); });
      await turnOff(second.p);
      await second.p.evaluate(() => document.body.replaceWith(globalThis.snap));
      await settle(second.p, 500);
      const s = await second.p.evaluate(() => ({
        marks: document.querySelectorAll('[data-duofari],[data-duofari-lock]').length,
        width: document.documentElement.scrollWidth,
      }));
      if (s.marks || s.width > VW) failures.push(`with Duofari off: ${s.marks} marked elements, document ${s.width} px wide`);
    },
  },

  {
    name: 'engine-9',
    what: 'a photo broken out of the margins stays broken out when restyled on screen',
    fixture: 'blog.html',
    async run({ p, failures }) {
      await injectDuofari(p, { breakout: true });
      const read = () => p.evaluate(() => {
        const img = document.getElementById('figure-img');
        const r = img.getBoundingClientRect();
        return { left: r.left, right: r.right, height: r.height, next: img.nextElementSibling.getBoundingClientRect().top };
      });
      await p.evaluate(() => scrollTo(0, scrollY + document.getElementById('figure-img').getBoundingClientRect().top - 100));
      await settle(p, 600);
      const seen = await read();
      if (!near(seen.left, 0) || !near(seen.right, VW + C)) failures.push(`photo not broken out (${seen.left}–${seen.right})`);
      // A scroll-reveal library marks it as it comes into view.
      await p.evaluate(() => document.getElementById('figure-img').classList.add('aos-animate'));
      await settle(p, 800);
      const now = await read();
      if (!near(now.height, seen.height) || !near(now.next, seen.next)) {
        failures.push(`photo on screen changed from ${seen.height.toFixed(1)} to ${now.height.toFixed(1)} px tall; caption moved ${(now.next - seen.next).toFixed(1)} px`);
      }
    },
  },

  {
    name: 'engine-10',
    what: 'a centred toast added later to an extended hero stays centred',
    html: page(`
      .hero { position: relative; height: 260px; background: #333; color: #fff; }
      .hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .hero h1 { position: relative; margin: 0; padding: 16px; }
      .toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); background: #fff; color: #000; padding: 6px 12px; white-space: nowrap; }`,
    `<section class="hero" id="hero"><img src="img/banner.jpg" alt=""><h1>Title</h1></section>${paragraphs(20)}`),
    async run({ p, failures }) {
      const toast = () => p.evaluate(async () => {
        const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: 'Copied to clipboard' });
        document.getElementById('hero').appendChild(t);
        await new Promise((r) => setTimeout(r, 800));
        const r = t.getBoundingClientRect();
        t.remove();
        return `${r.left.toFixed(1)}–${r.right.toFixed(1)}`;
      });
      const plain = await toast();
      await injectDuofari(p);
      const hero = await p.evaluate(() => document.getElementById('hero').getBoundingClientRect().right);
      if (!near(hero, VW + C)) failures.push(`hero not extended (right edge ${hero})`);
      const now = await toast();
      if (now !== plain) failures.push(`toast moved off centre: ${plain} → ${now}`);
    },
  },

  {
    name: 'engine-11',
    what: "turning off restores var() shorthands exactly and keeps the page's own later writes",
    html: page(`
      body { --gutter: 16px; }
      .wrap { padding: 0 16px; }
      .bar { width: 100%; box-sizing: border-box; background: #4a2c82; color: #fff; padding: 16px; }`,
    `<div class="wrap"><p>Intro</p><div id="band" style="margin: 0 calc(var(--gutter) * -1); background: #036; color: #fff; padding: 16px">Full-bleed band</div></div>
      <header class="bar" id="bar">Bar</header>${paragraphs(20)}`),
    async run({ p, failures }) {
      const read = () => p.evaluate(() => {
        const band = document.getElementById('band');
        return { attr: band.getAttribute('style'), right: band.getBoundingClientRect().right, width: document.getElementById('bar').style.width };
      });
      const plain = await read();
      await injectDuofari(p);
      // A sticky-header script pins the bar's width itself.
      await p.evaluate(() => { document.getElementById('bar').style.width = '382px'; });
      await settle(p, 700);
      await turnOff(p);
      const off = await read();
      if (off.attr !== plain.attr || !near(off.right, plain.right)) failures.push(`band not restored: style="${off.attr}", right edge ${off.right}`);
      if (off.width !== '382px') failures.push(`the page's own width on the bar was lost (now "${off.width}")`);
    },
  },

  {
    name: 'engine-12',
    what: 'nothing is written into editable content',
    html: page(`
      .callout { background: #fde; padding: 16px; }
      .band { background: #036; color: #fff; padding: 16px; }`,
    `<div id="editor" contenteditable="true"><p>Write here</p><div class="callout">A coloured callout block</div>
        <img src="img/photo.jpg" style="width:100%;display:block" alt=""><p>More</p></div>
      <article id="article"><div class="band">A band the page makes editable later</div>${paragraphs(10)}</article>`),
    async run({ p, failures }) {
      await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
      await injectDuofari(p);
      const dirty = (id) => p.evaluate((id) => /data-duofari|!important/.test(document.getElementById(id).innerHTML), id);
      if (await dirty('editor')) failures.push('editor content carries Duofari styles');
      await p.evaluate(() => {
        const a = document.getElementById('article');
        a.contentEditable = 'true';
        a.append(Object.assign(document.createElement('p'), { textContent: 'Typed' }));
      });
      await settle(p, 800);
      if (await dirty('article')) failures.push('content made editable later still carries Duofari styles');
    },
  },

  {
    name: 'engine-13',
    what: 'a menu anchored to a header with CSS anchor positioning stays put',
    html: page(`
      header { anchor-name: --bar; background: #036; color: #fff; padding: 16px; height: 24px; }
      .menu { position: absolute; position-anchor: --bar; top: anchor(bottom); right: anchor(right); background: #fff; border: 1px solid #ccc; padding: 8px; margin: 0; }`,
    `<header>Site</header><ul class="menu" id="menu"><li><a href="#">Account</a></li></ul>${paragraphs(10)}`),
    async run({ p, failures, before }) {
      await injectDuofari(p);
      failures.push(...checkInvariants(before, await snapshot(p), { C }));
    },
  },

  {
    name: 'engine-r2-1',
    what: 'a lifted fixed header stays lifted through a restyle that brings no translate',
    html: page(`
      .bar { position: fixed; left: 0; right: 0; height: 48px; box-sizing: border-box; padding: 12px 16px; background: #036; color: #fff; z-index: 5; }
      #plain { top: 0; }
      #eased { top: 56px; transition: all .3s; }
      .bar.scrolled { background: #024; }
      main { padding-top: 120px; }`,
    `<header class="bar" id="plain">No transition</header><header class="bar" id="eased">Eased</header><main>${paragraphs(60)}</main>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      for (const id of ['plain', 'eased']) {
        // Checked every frame for half a second after a scroll-driven class change.
        const gaps = await p.evaluate(async (id) => {
          const el = document.getElementById(id);
          const lifted = () => { const rec = globalThis.Duofari.records.get(el); return !!(rec && rec.lifted); };
          if (!lifted()) return -1;
          el.classList.add('scrolled');
          let n = 0;
          const t0 = performance.now();
          while (performance.now() - t0 < 500) {
            await new Promise((r) => requestAnimationFrame(r));
            if (!lifted()) n++;
          }
          return n;
        }, id);
        if (gaps) failures.push(`#${id}: ${gaps < 0 ? 'not lifted to begin with' : `unlifted for ${gaps} frames after a colour change`}`);
      }
    },
  },

  {
    name: 'engine-r2-2',
    what: 'a <body> that clips is checked again for content added later, and keeps no removed nodes',
    html: page(`
      html, body { overflow-x: hidden; }
      header { background: #036; color: #fff; padding: 16px; }
      .strip { white-space: nowrap; padding: 0 16px; }`,
    `<header>Site</header><main id="main">${paragraphs(20)}</main>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const read = () => p.evaluate(() => {
        const rec = globalThis.Duofari.records.get(document.body);
        return { opened: !!rec, queued: rec && rec.added ? rec.added.size : 0, right: document.body.getBoundingClientRect().right };
      });
      if (!(await read()).opened) failures.push('<body> not opened to begin with');
      // Short-lived nodes (placeholders, measuring probes) added straight into <body>.
      await p.evaluate(async () => {
        for (let i = 0; i < 30; i++) {
          const d = Object.assign(document.createElement('div'), { textContent: 'x' });
          document.body.append(d);
          await new Promise((r) => setTimeout(r, 0));
          d.remove();
        }
      });
      await settle(p, 800);
      const kept = await read();
      if (kept.queued) failures.push(`<body> still holds ${kept.queued} added nodes after a scan`);
      await p.evaluate(() => document.getElementById('main').insertAdjacentHTML('beforebegin',
        '<div class="strip">Tags: Politics · Economy · Health · Sport · Culture · Science · Travel · Weather</div>'));
      await settle(p, 800);
      const { right } = await read();
      if (right > VW + 0.5) failures.push(`tag strip added to <body> shows under the column (<body> clips at ${right})`);
    },
  },

  {
    name: 'engine-r2-3',
    what: 'content that grows past an opened wrapper later is checked (drawer in a new wrapper, nowrap class, longer text)',
    html: page(`
      .wrap { overflow-x: hidden; }
      .wrap header { background: #036; color: #fff; padding: 16px; }
      .nav { position: relative; background: #eee; padding: 8px 16px; }
      .drawer { position: absolute; top: 0; left: 100%; width: 260px; background: #fff; padding: 8px; }
      .one-line { white-space: nowrap; }`,
    `<div class="wrap" id="drawer"><header>Drawer</header><div class="nav" id="nav">Menu</div></div>
      <div class="wrap" id="nowrap"><header>Tags</header><p id="tags">Politics Economy Health Sport Culture Science Travel Weather</p></div>
      <div class="wrap" id="text"><header>Text</header><p id="link">Short</p></div>${paragraphs(10)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const clipRight = (id) => p.evaluate((id) => document.getElementById(id).getBoundingClientRect().right, id);
      for (const id of ['drawer', 'nowrap', 'text']) if (!near(await clipRight(id), VW + C)) failures.push(`#${id} not opened to begin with`);
      await p.evaluate(() => {
        // A menu component mounting a wrapper that holds its drawer, a class
        // that stops the tags wrapping, and a text update (as React makes it).
        document.getElementById('nav').insertAdjacentHTML('beforeend',
          '<div class="menu-root"><aside class="drawer"><a href="#">Home</a> <a href="#">News</a></aside></div>');
        document.getElementById('tags').classList.add('one-line');
        document.getElementById('link').firstChild.data = 'https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all';
      });
      await settle(p, 800);
      for (const [id, what] of [['drawer', 'drawer in an added wrapper'], ['nowrap', 'tags that stopped wrapping'], ['text', 'text that got longer']]) {
        const right = await clipRight(id);
        if (right > VW + 0.5) failures.push(`${what} shows under the column (wrapper clips at ${right})`);
      }
    },
  },

  {
    name: 'engine-r2-4',
    what: 'a toast that slides in with a transition is pinned centred',
    html: page(`
      .hero { position: relative; height: 260px; background: #333; color: #fff; }
      .hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .hero h1 { position: relative; margin: 0; padding: 16px; }
      .toast { position: absolute; left: 50%; bottom: 16px; transform: translate(-50%, 24px); opacity: 0; transition: transform .6s, opacity .6s;
        background: #fff; color: #000; padding: 6px 12px; white-space: nowrap; }
      .toast.show { transform: translate(-50%, 0); opacity: 1; }`,
    `<section class="hero" id="hero"><img src="img/banner.jpg" alt=""><h1>Title</h1></section>${paragraphs(20)}`),
    async run({ p, failures }) {
      const toast = () => p.evaluate(async () => {
        const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: 'Copied to clipboard' });
        document.getElementById('hero').appendChild(t);
        t.getBoundingClientRect();
        t.classList.add('show');
        await new Promise((r) => setTimeout(r, 1500));
        const r = t.getBoundingClientRect();
        t.remove();
        return `${r.left.toFixed(1)}–${r.right.toFixed(1)}`;
      });
      const plain = await toast();
      await injectDuofari(p);
      const now = await toast();
      if (now !== plain) failures.push(`toast moved off centre: ${plain} → ${now}`);
    },
  },

  {
    name: 'engine-r2-5',
    what: 'background layers built from boxes (slides, a parallax backdrop) grow with their hero',
    html: page(`
      .hero { position: relative; height: 220px; background: #222; color: #fff; }
      .slides, .parallax { position: absolute; inset: 0; }
      .parallax { overflow: hidden; }
      .slide, .backdrop { position: absolute; inset: 0; background: url(img/hero.jpg) center / cover; }
      .shade { position: absolute; inset: 0; background: linear-gradient(transparent, #0008); }
      .hero h1 { position: relative; margin: 0; padding: 16px; }`,
    `<section class="hero"><div class="slides" id="slides"><div class="slide"></div><div class="slide" style="opacity: 0"></div></div>
        <div class="shade"></div><h1>Slideshow</h1></section>
      <section class="hero"><div class="parallax" id="parallax"><div class="backdrop" id="backdrop"></div></div><h1>Parallax</h1></section>${paragraphs(10)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      for (const id of ['slides', 'parallax', 'backdrop']) {
        const right = await p.evaluate((id) => document.getElementById(id).getBoundingClientRect().right, id);
        if (!near(right, VW + C)) failures.push(`#${id} ends at ${right}, not at the column's edge (${VW + C})`);
      }
    },
  },

  {
    name: 'engine-r2-6',
    what: "an icon drawn as a full-size layer's background image stays put",
    html: page(`
      .video { position: relative; height: 200px; background: #000; }
      .play { position: absolute; inset: 0; background: url(img/square.jpg) center / 64px no-repeat; }
      .promo { position: relative; height: 200px; background: #123; }
      .promo::after { content: ''; position: absolute; inset: 0; background: url(img/square.jpg) 50% 50% / 80px no-repeat; }`,
    `<section class="video" id="video"><div class="play" id="play"></div></section>${paragraphs(1)}
      <section class="promo" id="promo"></section>${paragraphs(10)}`),
    async run({ p, failures }) {
      const measure = () => p.evaluate(() => {
        // A centred background sits in the middle of the box it is positioned in.
        const play = document.getElementById('play');
        const cs = getComputedStyle(play);
        const r = play.getBoundingClientRect();
        const bl = parseFloat(cs.borderLeftWidth), br = parseFloat(cs.borderRightWidth);
        const [a, b] = cs.backgroundOrigin === 'border-box' ? [r.left, r.right] : [r.left + bl, r.right - br];
        return { icon: ((a + b) / 2).toFixed(1), layer: getComputedStyle(document.getElementById('promo'), '::after').width,
          bands: ['video', 'promo'].map((id) => document.getElementById(id).getBoundingClientRect().right) };
      });
      const plain = await measure();
      await injectDuofari(p);
      const now = await measure();
      if (now.icon !== plain.icon) failures.push(`play icon moved: centre ${plain.icon} → ${now.icon}`);
      if (now.layer !== plain.layer) failures.push(`::after icon layer resized: ${plain.layer} → ${now.layer}`);
      if (!now.bands.every((right) => near(right, VW + C))) failures.push(`bands not extended (right edges ${now.bands.join(', ')})`);
    },
  },

  {
    name: 'engine-r2-7',
    what: 'a wrapper whose overflow is only margins, its own padding or invisible content is opened',
    html: page(`
      .site { overflow-x: hidden; }
      .site header { background: #036; color: #fff; padding: 16px; }
      .btn { display: inline-block; width: 100%; margin-right: 8px; box-sizing: border-box; }
      #padded { padding: 0 12px; }
      #padded header { margin: 0 -12px; }
      .wide { width: 100%; padding: 0 4px; }
      .marquee { visibility: hidden; white-space: nowrap; }`,
    `<div class="site" id="margin"><header>Margin</header><span class="btn">Button</span></div>
      <div class="site" id="padded"><header>Padded</header><div class="wide">A few px into the padding</div></div>
      <div class="site" id="hidden"><header>Hidden</header><div class="marquee">Breaking news that is very long and never wraps at all here</div></div>
      <div class="site" id="shadow"><header>Shadow</header><x-drawer></x-drawer><p>Text</p></div>${paragraphs(10)}
      <script>customElements.define('x-drawer', class extends HTMLElement {
        constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML =
          '<style>:host { display: block; position: relative } nav { position: absolute; top: 0; left: 100%; width: 260px; visibility: hidden }</style><nav>Drawer menu links</nav>'; }
      });</script>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      for (const id of ['margin', 'padded', 'hidden', 'shadow']) {
        const right = await p.evaluate((id) => document.querySelector(`#${id} header`).getBoundingClientRect().right, id);
        if (!near(right, VW + C)) failures.push(`#${id}: header inside the wrapper not extended (right edge ${right})`);
      }
    },
  },

  {
    name: 'engine-r2-8',
    what: 'a wrapper is opened again once the drawer that kept it shut is gone',
    html: page(`
      .site { overflow-x: hidden; }
      .site header { background: #036; color: #fff; padding: 16px; }
      .nav { position: relative; background: #eee; padding: 8px 16px; }
      .drawer { position: absolute; top: 0; left: 100%; width: 260px; background: #fff; padding: 8px; }`,
    `<div class="site" id="site"><header id="hdr">Site</header><div class="nav" id="nav">Menu</div><main id="main">${paragraphs(20)}</main></div>`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const right = () => p.evaluate(() => document.getElementById('hdr').getBoundingClientRect().right);
      if (!near(await right(), VW + C)) failures.push('header not extended to begin with');
      await p.evaluate(() => document.getElementById('nav').insertAdjacentHTML('beforeend', '<aside class="drawer" id="drawer"><a href="#">Home</a></aside>'));
      await settle(p, 800);
      if (!near(await right(), VW)) failures.push('wrapper not shut while the drawer is open');
      await p.evaluate(() => document.getElementById('drawer').remove());
      await settle(p, 800);
      const now = await right();
      if (!near(now, VW + C)) failures.push(`header not extended again after the drawer closed (right edge ${now})`);
    },
  },

  {
    name: 'engine-r2-9',
    what: 'a positioned pseudo-element past the first thousand nodes of a wrapper stays put',
    html: page(`
      .site { position: relative; overflow-x: hidden; }
      .site header { background: #036; color: #fff; padding: 16px; }
      .note::after { content: 'NEW'; position: absolute; right: 16px; background: #fc0; }`,
    `<div class="site"><header>My Blog</header><article id="art"></article><p class="note" id="note">Note</p></div>
      <script>const art = document.getElementById('art');
        for (let i = 0; i < 800; i++) art.insertAdjacentHTML('beforeend', '<p>Para <b>' + i + '</b></p>');</script>`),
    async run({ p, failures }) {
      const left = () => p.evaluate(() => getComputedStyle(document.getElementById('note'), '::after').left);
      const plain = await left();
      await injectDuofari(p);
      const now = await left();
      if (now !== plain) failures.push(`::after of a static paragraph moved: left ${plain} → ${now}`);
    },
  },

  {
    name: 'engine-r2-10',
    what: "extending a band's border reads no pseudo-elements of what is inside it",
    html: page(`
      header { position: sticky; top: 0; background: #036; color: #fff; padding: 12px 16px; z-index: 9; }
      .mega { visibility: hidden; height: 0; overflow: hidden; }`,
    `<header id="hdr"><b>Site</b><nav class="mega"><ul>${Array.from({ length: 300 }, (_, i) => `<li><a href="#">Item ${i}</a></li>`).join('')}</ul></nav></header>
      ${paragraphs(20)}`),
    async run({ p, failures }) {
      // Pseudo-element styles cost several times more to read than boxes.
      await p.evaluate(() => {
        const own = globalThis.getComputedStyle;
        globalThis.pseudoReads = 0;
        globalThis.getComputedStyle = function (el, pseudo) {
          if (pseudo) globalThis.pseudoReads++;
          return own.call(this, el, pseudo);
        };
      });
      await injectDuofari(p);
      const s = await p.evaluate(() => ({ reads: globalThis.pseudoReads, right: document.getElementById('hdr').getBoundingClientRect().right }));
      if (!near(s.right, VW + C)) failures.push(`header not extended (right edge ${s.right})`);
      if (s.reads > 10) failures.push(`${s.reads} pseudo-element styles read to extend it`);
    },
  },

  {
    name: 'r3-engine-1',
    what: 'a band that clips what hangs past its edge stays extended when it holds a band or the lead image',
    html: page(`
      .hero { position: relative; overflow: hidden; background: #123; color: #fff; padding-bottom: 16px; }
      .hero h1 { margin: 0; padding: 16px; }
      .blob { position: absolute; right: -70px; top: 20px; width: 160px; height: 160px; border-radius: 50%; background: #f80; }
      .strip { background: #fc0; color: #000; padding: 6px 16px; }
      .lead { display: block; width: 100%; height: 200px; object-fit: cover; }
      .bar { position: fixed; bottom: 0; left: 0; right: 0; overflow: hidden; background: #036; color: #fff; z-index: 5; }
      .bar div { background: #024; padding: 8px 16px; white-space: nowrap; }`,
    `<section class="hero" id="strip"><span class="blob"></span><div class="strip">Free shipping on all orders</div><h1>Spring sale</h1></section>
      <section class="hero" id="lead"><span class="blob"></span><h1>Feature</h1><img class="lead" alt="" src="img/banner.jpg"></section>
      <nav class="bar" id="bar"><div>World Politics Business Technology Science Health Sport Culture Travel</div></nav>${paragraphs(30)}`),
    async run({ p, failures }) {
      await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
      await injectDuofari(p);
      // Each insertion brings another scan.
      for (let i = 0; i < 3; i++) {
        await p.evaluate(() => document.body.append(document.createElement('span')));
        await settle(p, 400);
      }
      const s = await p.evaluate(() => {
        const D = globalThis.Duofari;
        const rec = D.records.get(document.getElementById('bar'));
        return { right: ['strip', 'lead', 'bar'].map((id) => document.getElementById(id).getBoundingClientRect().right), lifted: !!(rec && rec.lifted) };
      });
      s.right.forEach((right, i) => {
        if (!near(right, VW + C)) failures.push(`#${['strip', 'lead', 'bar'][i]} not extended after a few scans (right edge ${right})`);
      });
      if (!s.lifted) failures.push('fixed #bar not lifted');
    },
  },

  {
    name: 'r3-engine-2',
    what: 'a class on a <body> that clips cuts no running transition, and no photo broken out on screen shrinks with <body>',
    html: page(`
      html, body { overflow-x: hidden; }
      .bar { position: sticky; top: 0; z-index: 5; background: rgb(0, 0, 255); color: #fff; padding: 12px 16px; transition: background-color .6s linear; }
      body.scrolled .bar { background: rgb(255, 0, 0); }
      article { padding: 0 16px; }
      article p { padding: 0; }
      figure { margin: 16px 0; }
      figure img { display: block; width: 100%; height: auto; }`,
    `<header class="bar" id="bar">Site</header>
      <article>${paragraphs(30)}<figure><img id="photo" alt="" src="img/photo.jpg"></figure><p id="next">After the photo.</p>${paragraphs(30)}</article>`),
    async run({ p, failures }) {
      await p.evaluate(() => document.getElementById('photo').decode());
      await injectDuofari(p, { breakout: true });
      await p.evaluate(() => document.getElementById('photo').scrollIntoView({ block: 'center' }));
      await settle(p, 600);
      const read = () => p.evaluate(() => {
        const r = document.getElementById('photo').getBoundingClientRect();
        return { width: r.width, height: r.height, next: document.getElementById('next').getBoundingClientRect().top };
      });
      const seen = await read();
      if (!near(seen.width, VW + C)) failures.push(`photo not broken out (${seen.width} px wide)`);
      // A scroll handler marks the page as scrolled; the bar takes 0.6 s to turn red.
      const mid = await p.evaluate(async () => {
        document.body.classList.add('scrolled');
        await new Promise((r) => setTimeout(r, 350));
        return getComputedStyle(document.getElementById('bar')).backgroundColor;
      });
      const [r, , b] = mid.match(/\d+/g).map(Number);
      if (r > 240 || b < 15) failures.push(`the bar's colour change was cut short: ${mid} 350 ms into 600`);
      await settle(p, 800);
      const now = await read();
      if (!near(now.height, seen.height) || !near(now.next, seen.next)) {
        failures.push(`photo on screen changed from ${seen.height.toFixed(1)} to ${now.height.toFixed(1)} px tall; the text below moved ${(now.next - seen.next).toFixed(1)} px`);
      }
      // A modal library writes <body>'s padding itself, so <body> is reverted
      // and opened again, and the photo with it.
      await p.evaluate(() => { document.body.style.paddingRight = '0px'; });
      await settle(p, 800);
      const later = await read();
      if (!near(later.height, seen.height) || !near(later.next, seen.next)) {
        failures.push(`once <body> was reverted the photo changed from ${seen.height.toFixed(1)} to ${later.height.toFixed(1)} px tall`);
      }
    },
  },

  {
    name: 'r3-engine-3',
    what: 'a large page whose positioned <body> clips is walked to the end on a slow phone, then left alone',
    html: page(`
      html, body { overflow-x: hidden; }
      body { position: relative; }
      header { background: #036; color: #fff; padding: 12px 16px; }
      .hero { background: linear-gradient(#a00, #600); height: 200px; }
      .card { padding: 8px 16px; border-bottom: 1px solid #ddd; }`,
    `<header>Site</header><section class="hero" id="hero"></section>
      <main>${Array.from({ length: 1500 }, (_, i) => `<div class="card"><h3>Item ${i}</h3><p>Lorem <b>ipsum</b> dolor.</p></div>`).join('')}</main>`),
    async run({ p, cdp, failures }) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await injectDuofari(p);
      await settle(p, 3000);
      const s = await p.evaluate(async () => {
        const D = globalThis.Duofari;
        const scan = D.scan;
        let scans = 0;
        D.scan = (ctx) => { scans++; return scan(ctx); };
        await new Promise((r) => setTimeout(r, 2000));
        D.scan = scan;
        return { right: document.getElementById('hero').getBoundingClientRect().right, scans };
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      if (!near(s.right, VW + C)) failures.push(`hero below the header not extended (right edge ${s.right})`);
      if (s.scans > 1) failures.push(`${s.scans} scans in 2 s of an idle page`);
    },
  },

  {
    name: 'r3-engine-4',
    what: "art drawn by a pseudo-element of a hero's inner wrapper continues under the column",
    html: page(`
      .hero { position: relative; height: 240px; background: #222; color: #fff; }
      .hero .wrap::before { content: ''; position: absolute; inset: 0; background: url(img/hero.jpg) center / cover; }
      .hero h1 { position: relative; margin: 0; padding: 16px; }`,
    `<section class="hero" id="hero"><div class="wrap" id="wrap"><h1>Title</h1></div></section>${paragraphs(20)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      const s = await p.evaluate(() => ({
        hero: document.getElementById('hero').getBoundingClientRect().right,
        art: getComputedStyle(document.getElementById('wrap'), '::before').width,
      }));
      if (!near(s.hero, VW + C)) failures.push(`hero not extended (right edge ${s.hero})`);
      if (s.art !== `${VW + C}px`) failures.push(`the art is ${s.art} wide, leaving the bare background beside it under the column`);
    },
  },

  {
    name: 'r3-engine-5',
    what: 'inline transitions (a var() shorthand, a lone duration) are put back exactly when turned off',
    html: page(`
      :root { --t: background-color .3s; }
      .fixed { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: #036; color: #fff; z-index: 3; }
      .fixed.on { background: #600; }
      main { padding-top: 48px; }
      .band { background: #036; color: #fff; padding: 12px 16px; }`,
    `<header class="fixed" id="lifted" style="transition: var(--t), translate .3s">Fixed</header>
      <main><div class="band" id="band" style="transition-duration: .3s">Band</div>${paragraphs(40)}</main>`),
    async run({ p, failures }) {
      const read = () => p.evaluate(() => ['lifted', 'band'].map((id) => document.getElementById(id).getAttribute('style')));
      const plain = await read();
      await injectDuofari(p);
      // A restyle of the lifted header: Duofari looks for a translate it brings.
      await p.evaluate(() => document.getElementById('lifted').classList.add('on'));
      await settle(p, 800);
      await turnOff(p);
      const off = await read();
      off.forEach((attr, i) => { if (attr !== plain[i]) failures.push(`style="${plain[i]}" became "${attr}"`); });
    },
  },

  {
    name: 'r3-engine-7',
    what: 'a toast pinned in an extended hero still slides in by `right`, or grows by `width`',
    html: page(`
      .hero { position: relative; height: 260px; background: #333; color: #fff; }
      .hero img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .hero h1 { position: relative; margin: 0; padding: 16px; }
      .toast { position: absolute; bottom: 16px; box-sizing: border-box; padding: 6px 12px; background: #fff; color: #000; white-space: nowrap; overflow: hidden; }
      .slide { right: -260px; width: 220px; transition: right 2s linear; }
      .slide.show { right: 16px; }
      .grow { right: 16px; width: 0; transition: width 2s linear; }
      .grow.show { width: 200px; }`,
    `<section class="hero" id="hero"><img src="img/banner.jpg" alt=""><h1>Title</h1></section>${paragraphs(20)}`),
    async run({ p, failures }) {
      // Where the toast's left edge is halfway through its entrance, which
      // starts after Duofari has seen it added.
      const toast = (kind) => p.evaluate(async (kind) => {
        const t = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: 'Copied to clipboard' });
        document.getElementById('hero').appendChild(t);
        await new Promise((r) => setTimeout(r, 500));
        t.classList.add('show');
        await new Promise((r) => setTimeout(r, 1000));
        const left = t.getBoundingClientRect().left;
        t.remove();
        return left;
      }, kind);
      const plain = { slide: await toast('slide'), grow: await toast('grow') };
      await injectDuofari(p);
      for (const kind of ['slide', 'grow']) {
        const now = await toast(kind);
        if (Math.abs(now - plain[kind]) > 25) failures.push(`.${kind} toast halfway in at ${now.toFixed(1)}, not ${plain[kind].toFixed(1)}`);
      }
    },
  },

  {
    name: 'r3-engine-extra-1',
    what: 'under Auto landscape no picture in a band is rescaled (an image layer, its own background, pseudo-element art)',
    html: page(`
      section { position: relative; height: 100px; background: #123; color: #fff; }
      section h2 { position: relative; margin: 0; padding: 8px 16px; font-size: 16px; }
      .layer img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .own { background: #123 url(img/photo.jpg) center / cover no-repeat; }
      .pseudo::before { content: ''; position: absolute; inset: 0; background: url(img/photo.jpg) center / cover; }`,
    `<section class="layer" id="layer"><img alt="" src="img/photo.jpg"><h2>Image layer</h2></section>
      <section class="own" id="own"><h2>Own background</h2></section>
      <section class="pseudo" id="pseudo"><h2>Pseudo-element art</h2></section>${paragraphs(20)}`),
    async run({ p, cdp, failures }) {
      const { POSES, readPixels, colorDistance } = await import('./lib/duo.mjs');
      const pose = POSES['landscape-right'];
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: pose.viewport.width, height: pose.viewport.height, deviceScaleFactor: 3, mobile: true,
        screenWidth: pose.screen.width, screenHeight: pose.screen.height, screenOrientation: pose.orientation,
      });
      await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
      await settle(p, 400);
      const ids = ['layer', 'own', 'pseudo'];
      // Probes across the art of each band, in device pixels (the screen is 3x).
      const points = ids.flatMap((id, i) => [60, 200, 340, 480, 560].map((x) => ({ id, x: x * 3, y: (i * 100 + 70) * 3 })));
      // A CDP screenshot leaves the emulated orientation alone.
      const shoot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 594, height: 300, scale: 1 } })).data, 'base64');
      const browser = p.context().browser();
      const plain = await readPixels(browser, await shoot(), points);
      await injectDuofari(p);
      const s = await p.evaluate((ids) => ({ reason: globalThis.Duofari.controller.state.reason, right: ids.map((id) => document.getElementById(id).getBoundingClientRect().right) }), ids);
      if (s.reason !== 'column') failures.push(`not active in landscape (${s.reason})`);
      s.right.forEach((right, i) => { if (!near(right, 594 + C)) failures.push(`#${ids[i]}'s colour not extended (right edge ${right})`); });
      const now = await readPixels(browser, await shoot(), points);
      const moved = new Set(points.filter((pt, i) => colorDistance(plain[i], now[i]) > 24).map((pt) => pt.id));
      for (const id of moved) failures.push(`#${id}'s picture changed inside the page`);
    },
  },

  {
    name: 'r3-engine-scan',
    what: 'a band after thousands of elements is reached, and a large page is left alone once walked',
    html: page(`
      header, .band { background: #036; color: #fff; padding: 16px; }
      .r { height: 4px; overflow: hidden; font-size: 2px; }`,
    `<header>Top</header>${Array.from({ length: 7000 }, (_, i) => `<div class="r">Row ${i}</div>`).join('')}
      <section class="band" id="deep">Deep band</section>${paragraphs(30)}`),
    async run({ p, failures }) {
      await injectDuofari(p);
      await p.evaluate(() => document.getElementById('deep').scrollIntoView());
      await settle(p, 2500);
      const s = await p.evaluate(async () => {
        const D = globalThis.Duofari;
        const scan = D.scan;
        let scans = 0;
        D.scan = (ctx) => { scans++; return scan(ctx); };
        await new Promise((r) => setTimeout(r, 2000));
        D.scan = scan;
        return { right: document.getElementById('deep').getBoundingClientRect().right, scans };
      });
      if (!near(s.right, VW + C)) failures.push(`band after 7000 rows not extended (right edge ${s.right})`);
      if (s.scans > 1) failures.push(`${s.scans} scans in 2 s of an idle page`);
    },
  },
];

const CASES = [...ENGINE, ...LIFECYCLE];

const filter = process.argv.slice(2);
const { chromium } = await loadPlaywright();
const server = await serve(join(HERE, 'fixtures'));
const browser = await chromium.launch();
let failed = 0;

for (const c of CASES) {
  if (filter.length && !filter.some((f) => c.name.includes(f))) continue;
  const contexts = [];
  const errors = [];
  /** A fresh folded-Duo tab on the case's page, with Duofari not yet running. */
  const open = async () => {
    const context = await newDuoContext(browser, 'folded');
    contexts.push(context);
    const p = await context.newPage();
    const cdp = await orientPage(p, 'folded');
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const url = `${server.origin}/${c.fixture || `${c.name}.html`}`;
    if (!c.fixture) await p.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: c.html }));
    await p.goto(url, { waitUntil: 'load' });
    await emulateSafariMinimumScale(p);
    await settle(p, 300);
    return { p, cdp };
  };
  const failures = [];
  try {
    const { p, cdp } = await open();
    const before = await snapshot(p);
    await c.run({ p, cdp, before, failures, open });
  } catch (e) {
    failures.push(`threw: ${e.message.split('\n')[0]}`);
  }
  failures.push(...errors.map((e) => `page error: ${e}`));
  console.log(`${failures.length ? '✗' : '✓'} ${c.name} — ${c.what}`);
  for (const f of failures) console.log(`    ${f}`);
  failed += failures.length ? 1 : 0;
  for (const context of contexts) await context.close();
}

await browser.close();
await server.close();
console.log(failed ? `\n${failed} case(s) failed` : '\nAll cases passed');
process.exit(failed ? 1 : 0);
