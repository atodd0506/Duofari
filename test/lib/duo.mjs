// Emulates Safari on a folded iPhone Duo in headless Chromium and runs
// Duofari's content scripts against a page.
//
// What the emulation reproduces (from simulator measurements):
//   - the layout viewport Safari gives a page beside its side column
//     (382 × 580 portrait, 594 × 340 landscape);
//   - window.screen reporting 466 × 678 in every pose;
//   - DPR 3, touch, mobile viewport handling.
// Safari's column itself lives outside the web content, so it is drawn onto
// the screenshots afterwards (see preview.mjs).

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const POSES = {
  // Folded, portrait: Safari's controls take an 84 pt column on the right.
  folded: { viewport: { width: 382, height: 580 }, screen: { width: 466, height: 678 }, column: 84, orientation: { type: 'portraitPrimary', angle: 0 } },
  // Folded, landscape, turned clockwise: the column is (probably) on the right.
  'landscape-right': { viewport: { width: 594, height: 340 }, screen: { width: 466, height: 678 }, column: 84, orientation: { type: 'landscapeSecondary', angle: 270 } },
  // Folded, landscape, turned counterclockwise: the column is (probably) on the left.
  'landscape-left': { viewport: { width: 594, height: 340 }, screen: { width: 466, height: 678 }, column: 84, orientation: { type: 'landscapePrimary', angle: 90 } },
  // Unfolded: Safari uses the full width of the inner display.
  unfolded: { viewport: { width: 951, height: 543 }, screen: { width: 466, height: 678 }, column: 0, orientation: { type: 'landscapePrimary', angle: 90 } },
  // An ordinary iPhone: no column at all.
  iphone: { viewport: { width: 402, height: 714 }, screen: { width: 402, height: 874 }, column: 0, orientation: { type: 'portraitPrimary', angle: 0 } },
};

export const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';

const SCRIPTS = [
  'shared-settings.js',
  'content-geometry.js',
  'content-bleed.js',
  'content-classify.js',
  'content-guard.js',
  'content-main.js',
];

let scriptSource = null;
export async function extensionSource() {
  if (!scriptSource) {
    const manifest = JSON.parse(await readFile(join(ROOT, 'extension', 'manifest.json'), 'utf8'));
    const files = manifest.content_scripts[0].js;
    if (JSON.stringify(files) !== JSON.stringify(SCRIPTS)) {
      throw new Error(`manifest content scripts changed: ${files.join(', ')}`);
    }
    const parts = await Promise.all(files.map((f) => readFile(join(ROOT, 'extension', f), 'utf8')));
    scriptSource = parts.map((src, i) => `// ${files[i]}\n${src}`).join('\n;\n');
  }
  return scriptSource;
}

/** Applies a pose's screen orientation (Chromium derives it from the screen size otherwise). */
export async function orientPage(page, poseName = 'folded') {
  const pose = POSES[poseName];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: pose.viewport.width, height: pose.viewport.height, deviceScaleFactor: 3, mobile: true,
    screenWidth: pose.screen.width, screenHeight: pose.screen.height, screenOrientation: pose.orientation,
  });
  return cdp;
}

export async function newDuoContext(browser, poseName = 'folded', extra = {}) {
  const pose = POSES[poseName];
  return browser.newContext({
    viewport: pose.viewport,
    screen: pose.screen,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: SAFARI_UA,
    // Content scripts aren't subject to the page's CSP; the injected test
    // script is, so let it through.
    bypassCSP: true,
    ...extra,
  });
}

/** Runs Duofari in the page (as Safari would at document_idle) and waits for it to settle. */
export async function injectDuofari(page, settings = {}) {
  const source = await extensionSource();
  await page.evaluate((s) => { globalThis.__duofariTestSettings = s; }, settings);
  const tag = await page.addScriptTag({ content: source });
  await tag.evaluate((el) => el.remove());
  await settle(page);
}

/**
 * Chromium lets a page with horizontal overflow zoom out to fit it, and then
 * stretches the layout viewport (and every fixed element) to the overflow
 * width. Safari on iPhone keeps the minimum scale at 1 for pages with
 * width=device-width and an initial scale (WebKit ViewportConfiguration), so
 * fixed elements stay beside the column. Pin Chromium to the same minimum.
 */
export async function emulateSafariMinimumScale(page) {
  await page.evaluate(() => {
    const metas = document.querySelectorAll('meta[name="viewport" i]');
    const meta = metas[metas.length - 1];
    if (!meta) return;
    const content = meta.getAttribute('content') || '';
    if (/device-width/i.test(content) && !/minimum-scale/i.test(content)) {
      meta.setAttribute('content', `${content}, minimum-scale=1`);
    }
  });
}

export async function settle(page, ms = 450) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Records where every text run, form control and annotated element sits.
 * Text positions are compared horizontally only: an image that grows can push
 * text down, but nothing may move sideways or into the column.
 */
export async function snapshot(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out = { text: [], controls: [], expect: [], columnText: [], vw, innerWidth };
    // Text that actually shows in the strip beside the layout viewport: not
    // cut off by any clipping ancestor's padding box.
    const clipsAt = (el) => {
      const cs = getComputedStyle(el);
      if (el === document.documentElement || el === document.body) return null;
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none' && !/paint|strict|content/.test(cs.contain)) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left + parseFloat(cs.borderLeftWidth), right: r.right - parseFloat(cs.borderRightWidth) };
    };
    const visibleInColumn = (rect, el) => {
      let left = rect.left, right = rect.right;
      for (let a = el; a; a = a.parentElement || (a.getRootNode && a.getRootNode().host)) {
        if (parseFloat(getComputedStyle(a).opacity) === 0) return false;
        const box = clipsAt(a);
        if (box) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (right <= left) return false;
      }
      return (right > vw + 0.5 && left < vw + 200) || (left < -0.5 && right > -200);
    };

    // The first snapshot picks the nodes; later ones measure the same nodes,
    // so content the page adds or removes in between can't misalign them.
    let nodes = globalThis.__duofariSnapNodes;
    if (!nodes) {
      nodes = { text: [], controls: [] };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && nodes.text.length < 4000; node = walker.nextNode()) {
        if (!node.textContent.trim()) continue;
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,template,[data-duofari-ui]')) continue;
        nodes.text.push(node);
      }
      nodes.controls = [...document.querySelectorAll('button,input,select,textarea,a[href]')];
      globalThis.__duofariSnapNodes = nodes;
    }

    const range = document.createRange();
    nodes.text.forEach((node, id) => {
      if (!node.isConnected) return;
      const parent = node.parentElement;
      const cs = getComputedStyle(parent);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) return;
      if (rects.some((r) => (r.right > vw + 0.5 || r.left < -0.5) && visibleInColumn(r, parent))) {
        out.columnText.push(node.textContent.trim().slice(0, 40));
      }
      out.text.push({
        id,
        text: node.textContent.trim().slice(0, 40),
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
        top: Math.min(...rects.map((r) => r.top)),
      });
    });
    nodes.controls.forEach((el, id) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      out.controls.push({ id, tag: el.localName, label: (el.textContent || el.value || '').trim().slice(0, 30), left: r.left, right: r.right });
    });

    const all = [...document.querySelectorAll('[data-expect]')];
    // Also look inside open shadow roots.
    for (const host of document.querySelectorAll('*')) {
      if (host.shadowRoot) all.push(...host.shadowRoot.querySelectorAll('[data-expect]'));
    }
    for (const el of all) {
      const r = el.getBoundingClientRect();
      const pseudo = el.hasAttribute('data-pseudo-check')
        ? ['::before', '::after'].map((p) => { const cs = getComputedStyle(el, p); return `${cs.left}|${cs.right}|${cs.width}`; }).join(' ')
        : null;
      out.expect.push({
        pseudo,
        expect: el.dataset.expect,
        name: `${el.localName}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`,
        left: r.left, right: r.right, top: r.top, width: r.width, height: r.height,
      });
    }
    return out;
  });
}

export async function duofariState(page) {
  return page.evaluate(async () => {
    const D = globalThis.Duofari;
    if (!D || !D.controller) return null;
    const status = await D.controller.status();
    const root = document.scrollingElement || document.documentElement;
    return {
      status,
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      touchAction: getComputedStyle(document.documentElement).touchAction,
      viewport: (document.querySelector('meta[name=viewport]') || {}).content || null,
      marks: (() => {
        let n = document.querySelectorAll('[data-duofari]').length;
        for (const host of document.querySelectorAll('*')) if (host.shadowRoot) n += host.shadowRoot.querySelectorAll('[data-duofari]').length;
        return n;
      })(),
      records: [...D.records.values()].map((r) => ({
        kind: r.kind, recipe: r.recipe, fixed: getComputedStyle(r.el).position === 'fixed',
        el: `${r.el.localName}${r.el.className && typeof r.el.className === 'string' ? '.' + r.el.className.trim().split(/\s+/).join('.') : ''}`,
      })),
    };
  });
}

/**
 * Compares two snapshots and returns a list of human-readable failures.
 * @param {object} opts { C, left, right, bleedExpected }
 */
export function checkInvariants(before, after, { C, left = false, right = true, strictExpect = true } = {}) {
  const failures = [];
  const vw = after.vw;
  const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;

  // 1. No text moves sideways, and none ends up in the column.
  const beforeText = new Map(before.text.map((t) => [t.id, t]));
  for (const t of after.text) {
    const b = beforeText.get(t.id);
    if (b && (!near(b.left, t.left, 0.75) || !near(b.right, t.right, 0.75))) {
      failures.push(`text moved sideways: "${t.text}" ${b.left.toFixed(1)}–${b.right.toFixed(1)} → ${t.left.toFixed(1)}–${t.right.toFixed(1)}`);
    }
    const wasOut = b && (b.right > vw + 0.5 || b.left < -0.5);
    if (!wasOut && (t.right > vw + 0.5 || t.left < -0.5)) {
      failures.push(`text in the column: "${t.text}" ${t.left.toFixed(1)}–${t.right.toFixed(1)} (viewport ${vw})`);
    }
  }

  // 1b. No text that was hidden (clipped) becomes visible beside the viewport.
  for (const t of after.columnText) {
    if (!before.columnText.includes(t)) failures.push(`hidden text revealed in the column: "${t}"`);
  }

  // 2. No control moves sideways.
  const afterControls = new Map(after.controls.map((c) => [c.id, c]));
  before.controls.forEach((c) => {
    const a = afterControls.get(c.id);
    if (a && (!near(a.left, c.left, 0.75) || !near(a.right, c.right, 0.75))) {
      failures.push(`control moved: <${c.tag}> "${c.label}" ${c.left.toFixed(1)}–${c.right.toFixed(1)} → ${a.left.toFixed(1)}–${a.right.toFixed(1)}`);
    }
  });

  // 3. Annotated expectations.
  if (strictExpect) {
    before.expect.forEach((b, i) => {
      const a = after.expect[i];
      if (!a) return;
      const targetRight = vw + (right ? C : 0);
      const targetLeft = left ? -C : 0;
      switch (b.expect) {
        case 'bleed':
          if ((right && !near(a.right, targetRight)) || (left && !near(a.left, targetLeft))) {
            failures.push(`expected ${b.name} to extend into the column: ${a.left.toFixed(1)}–${a.right.toFixed(1)}, wanted ${targetLeft}–${targetRight}`);
          }
          break;
        case 'breakout':
          if (!near(a.left, targetLeft) || !near(a.right, targetRight)) {
            failures.push(`expected ${b.name} to break out to ${targetLeft}–${targetRight}: got ${a.left.toFixed(1)}–${a.right.toFixed(1)}`);
          }
          break;
        case 'inset':
        case 'none':
          if (!near(a.left, b.left, 0.75) || !near(a.right, b.right, 0.75)) {
            failures.push(`expected ${b.name} to stay put: ${b.left.toFixed(1)}–${b.right.toFixed(1)} → ${a.left.toFixed(1)}–${a.right.toFixed(1)}`);
          }
          break;
        default:
          break; // lenient expectations ("bleed-or-inset" etc.) are informational
      }
      if (b.pseudo !== null && b.pseudo !== a.pseudo) {
        failures.push(`pseudo-element of ${b.name} moved: ${b.pseudo} → ${a.pseudo}`);
      }
    });
  }
  return failures;
}

/**
 * Pixel probes declared on fixture elements, in document coordinates:
 *   data-probe-column="image|page|#rrggbb"  the middle of the column strip at
 *                                          the element's height (data-probe-y,
 *                                          a fraction, default 0.5)
 *   data-probe-same="x1,x2"                these points inside the page look
 *                                          the same before and after
 */
export async function probePoints(page, C) {
  return page.evaluate((C) => {
    const vw = document.documentElement.clientWidth;
    const points = [];
    for (const el of document.querySelectorAll('[data-probe-column],[data-probe-same]')) {
      const r = el.getBoundingClientRect();
      const fy = parseFloat(el.getAttribute('data-probe-y') || '0.5');
      const y = Math.round(r.top + scrollY + r.height * fy);
      const name = `${el.localName}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}${el.id ? '#' + el.id : ''}`;
      if (el.hasAttribute('data-probe-column')) points.push({ name, kind: 'column', want: el.getAttribute('data-probe-column'), x: Math.round(vw + C / 2), y });
      if (el.hasAttribute('data-probe-same')) {
        for (const x of el.getAttribute('data-probe-same').split(',')) points.push({ name, kind: 'same', x: Math.round(parseFloat(x)), y });
      }
    }
    return points;
  }, C);
}

/** Reads pixels (CSS-pixel coordinates) out of a PNG using a scratch page. */
export async function readPixels(browser, png, points) {
  const page = await browser.newPage();
  const out = await page.evaluate(async ({ b64, points }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return points.map((p) => {
      if (p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) return null;
      const d = g.getImageData(p.x, p.y, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }, { b64: png.toString('base64'), points });
  await page.close();
  return out;
}

export function hexColor(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

export function cssColor(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css || '');
  return m ? m[1].split(/[\s,]+/).slice(0, 3).map(Number) : [255, 255, 255];
}

export const colorDistance = (a, b) => (a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : Infinity);
