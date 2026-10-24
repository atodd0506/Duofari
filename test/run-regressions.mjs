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
