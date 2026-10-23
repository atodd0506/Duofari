// Finds what should extend into Safari's column and extends it.
//
// Only an element that reaches the edge of the layout viewport can continue
// under the column, so the scan walks a "spine": it starts at <body> and
// descends only into elements whose box touches the column's edge (or comes
// close to it, for images inset by page margins). Everything else is pruned
// without a second look. Elements are processed top-down, so a parent is
// already extended (with its content box unchanged) when its children are
// measured.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});

  const TOL = 1.5;            // px: "touches the edge"
  const NEAR = 48;            // px: page margins an inset image may break out of
  const MIN_MEDIA_HEIGHT = 100;
  const BREAKOUT_MIN_WIDTH = 0.8;
  const OVERLAY_HEIGHT = 0.9;

  const SKIP = new Set([
    'script', 'style', 'link', 'meta', 'template', 'noscript', 'br', 'wbr', 'head', 'title', 'source', 'track',
    'area', 'map', 'option', 'optgroup', 'datalist', 'param', 'iframe', 'frame', 'frameset', 'object', 'embed',
    'input', 'select', 'textarea', 'button', 'dialog', 'svg', 'math', 'audio', 'slot',
  ]);
  const MEDIA = new Set(['img', 'video']);
  const REPLACED = new Set(['img', 'video', 'canvas', 'picture', 'audio', 'meter', 'progress']);
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[contenteditable=""],[contenteditable=true]';

  /** Elements we've tried and couldn't extend cleanly, keyed to the layout they failed in. */
  const rejected = new WeakMap();
  /** Elements whose extension the page keeps undoing; left alone for this page view. */
  const blocked = new WeakSet();
  D.blocked = blocked;

  // ---------------------------------------------------------------------------
  // Colours

  function parseColor(value) {
    const m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  function visibleColor(c) {
    return !!c && c.a >= 0.05;
  }

  function sameColor(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) <= 6 && Math.abs(a.a - b.a) <= 0.05;
  }

  /** The colour showing behind `el`: the nearest ancestor background, or the canvas. */
  function backdropColor(el, cache) {
    let node = D.parentOf(el);
    const trail = [];
    let found = null;
    while (node) {
      if (cache.has(node)) { found = cache.get(node); break; }
      trail.push(node);
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (visibleColor(c) && c.a >= 0.95) { found = c; break; }
      node = D.parentOf(node);
    }
    if (!found) found = canvasColor();
    for (const n of trail) cache.set(n, found);
    return found;
  }

  function canvasColor() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (visibleColor(c)) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  /**
   * How an element's background reads:
   *   'backdrop' – an image or gradient that fills the box (extend by resizing),
   *   'color'    – a solid colour different from what's behind it,
   *   'icon'     – a small positioned image on a coloured box (extend the colour only),
   *   null       – nothing worth extending.
   */
  function backgroundKind(el, cs, cache) {
    if (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text') return null;
    if (cs.borderImageSource && cs.borderImageSource !== 'none') return null;
    const color = parseColor(cs.backgroundColor);
    const colorDiffers = visibleColor(color) && !sameColor(color, backdropColor(el, cache));
    const image = cs.backgroundImage;
    if (image && image !== 'none') {
      const gradientOnly = !/url\(/.test(image);
      const sizes = (cs.backgroundSize || 'auto').split(',').map((s) => s.trim());
      const repeats = (cs.backgroundRepeat || 'repeat').split(',').map((s) => s.trim());
      const fills = gradientOnly || sizes.some((s) => /cover|100%/.test(s)) || repeats.some((r) => !/no-repeat/.test(r));
      if (fills) return 'backdrop';
      return colorDiffers ? 'icon' : null;
    }
    return colorDiffers ? 'color' : null;
  }

  // ---------------------------------------------------------------------------
  // Classification helpers

  // `overflow-x: hidden` alone computes overflow-y to auto, so the computed
  // value doesn't say whether anything scrolls. Check for actual overflow.
  function scrollsX(el, cs) {
    return /auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
  }

  function scrollsY(el, cs) {
    return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
  }

  function isScroller(el, cs) {
    return scrollsX(el, cs) || scrollsY(el, cs);
  }

  function hidden(cs) {
    return cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity) === 0;
  }

  /** "Plain" ancestors an inset image may break out of: no box of their own. */
  function plainBetween(el, stopAt, cache) {
    let node = D.parentOf(el);
    while (node && node !== stopAt) {
      const cs = getComputedStyle(node);
      if (backgroundKind(node, cs, cache)) return false;
      if (cs.boxShadow !== 'none' || parseFloat(cs.borderTopLeftRadius) > 2 || parseFloat(cs.borderTopRightRadius) > 2) return false;
      if (parseFloat(cs.borderLeftWidth) || parseFloat(cs.borderRightWidth)) return false;
      if (D.clips(node, cs) || D.containsFixed(cs) || cs.position === 'fixed' || cs.position === 'sticky') return false;
      if (/^(flex|inline-flex|grid|inline-grid)$/.test(cs.display) && node.children.length > 1) return false;
      if (/^(table|table-cell|table-row|li|list-item)$/.test(cs.display)) return false;
      node = D.parentOf(node);
    }
    return true;
  }

  function mediaElement(el) {
    if (!MEDIA.has(el.localName)) return false;
    if (el.localName === 'video' && el.controls) return false;
    return true;
  }

  function childElements(el) {
    const kids = [...el.children];
    if (el.shadowRoot) kids.push(...el.shadowRoot.children);
    return kids;
  }

  // ---------------------------------------------------------------------------
  // The scan

  /**
   * @param {object} ctx  { layoutWidth, viewportHeight, C, left, right, settings, budget }
   * @returns {{visited:number, applied:number, reverted:number, truncated:boolean, growAbove:number}}
   */
  D.scan = function scan(ctx) {
    const stats = { visited: 0, applied: 0, reverted: 0, truncated: false, growAbove: 0 };
    const body = document.body;
    if (!body) return stats;
    const vw = ctx.layoutWidth;
    const C = ctx.C;
    const sides = { left: !!ctx.left, right: !!ctx.right };
    const s = ctx.settings;
    const winTop = -2 * ctx.viewportHeight;
    const winBottom = 4 * ctx.viewportHeight;
    const near = s.breakout && s.media ? NEAR : TOL;
    const colorCache = new Map();
    const layoutKey = `${vw}|${C}|${sides.left}|${sides.right}`;

    // Depth-first, in document order. Each entry is an element whose parent
    // has already been processed.
    const stack = childElements(body).reverse();

    while (stack.length) {
      if (stats.visited >= ctx.budget) { stats.truncated = true; break; }
      const el = stack.pop();
      const tag = el.localName;
      if (SKIP.has(tag) || el.hasAttribute('data-duofari-ui')) continue;
      stats.visited++;

      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        const cs = getComputedStyle(el);
        if (cs.display === 'contents') pushChildren(stack, el);
        continue;
      }
      if (r.bottom < winTop || r.top > winBottom) continue;

      let rec = D.records.get(el);
      if (rec && rec.kind === 'pin') continue;
      if (rec && rec.kind !== 'clipper') {
        if (D.stillValid(rec)) {
          if (rec.kind !== 'media' && rec.kind !== 'breakout') pushChildren(stack, el);
          continue;
        }
        noteReapply(rec);
        D.revert(el);
        stats.reverted++;
        rec = null;
      }

      // Re-measure only if we just reverted something.
      const rect = rec ? r : el.getBoundingClientRect();
      const touch = edgeState(rect, vw, C, sides, near);
      if (!touch.relevant) {
        if (rec && rec.kind === 'clipper') { D.revert(el); stats.reverted++; }
        continue;
      }

      const cs = getComputedStyle(el);
      if (cs.display === 'none' || hidden(cs)) continue;

      // Full-screen fixed overlays (menus, modals, dimming layers). Safari
      // paints an opaque fill over the column for these anyway.
      if (cs.position === 'fixed' && rect.height >= OVERLAY_HEIGHT * ctx.viewportHeight) continue;

      if (touch.bleeds) {
        // Already reaches into the column (the site's own 100vw, or artwork
        // that grew with an extended parent). Nothing to do but look inside.
        pushChildren(stack, el);
        continue;
      }

      if (blocked.has(el) || rejected.get(el) === `${layoutKey}|${rect.width}|${rect.height}`) {
        if (!mediaElement(el)) pushChildren(stack, el);
        continue;
      }

      const full = touch.full;
      let outcome = null;

      if (mediaElement(el)) {
        if (s.media) outcome = classifyMedia(el, cs, rect, full, touch, ctx, sides, C, colorCache, stats);
        if (outcome === 'rejected') rejected.set(el, `${layoutKey}|${rect.width}|${rect.height}`);
        continue;
      }

      if (full && s.bands && !rec && !REPLACED.has(tag)) {
        const kind = cs.display.startsWith('inline') && cs.display !== 'inline-block' ? null : backgroundKind(el, cs, colorCache);
        if (kind && !/^table/.test(cs.display) && !el.matches(INTERACTIVE)) {
          if (ensureClippers(el, sides, C, stats, vw)) {
            // A scroll container's padding box is its scrollport: growing it
            // would scroll content under the column. Extend its border instead.
            const recipes = kind === 'icon' || scrollsX(el, cs) ? ['border'] : ['padding', 'border'];
            const done = D.extendBox(el, 'band', sides, C, { recipes, backdrop: kind === 'backdrop', layoutWidth: vw });
            if (done) stats.applied++;
            else rejected.set(el, `${layoutKey}|${rect.width}|${rect.height}`);
          }
        }
      }

      // Small scroll containers (carousels, tab strips) keep their contents
      // to themselves; page-sized ones (app shells) are walked like <body>.
      if (isScroller(el, cs) && !(full && rect.height >= 0.6 * ctx.viewportHeight)) continue;
      pushChildren(stack, el);
    }

    return stats;
  };

  function pushChildren(stack, el) {
    const kids = childElements(el);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }

  function edgeState(rect, vw, C, sides, near) {
    const atRight = Math.abs(rect.right - vw) <= TOL;
    const atLeft = Math.abs(rect.left) <= TOL;
    const pastRight = Math.abs(rect.right - (vw + C)) <= TOL;
    const pastLeft = Math.abs(rect.left + C) <= TOL;
    const nearRight = rect.right >= vw - near && rect.right <= vw + TOL;
    const nearLeft = rect.left <= near && rect.left >= -TOL;
    const overflowing = (rect.right > vw + TOL && !pastRight) || (rect.left < -TOL && !pastLeft);
    const relevant = !overflowing && ((sides.right && (atRight || pastRight || nearRight)) || (sides.left && (atLeft || pastLeft || nearLeft)));
    const bleeds = (sides.right ? pastRight : true) && (sides.left ? pastLeft : true) && (pastRight || pastLeft);
    const full = atLeft && atRight;
    return { relevant, bleeds, full, nearRight, nearLeft };
  }

  function classifyMedia(el, cs, rect, full, touch, ctx, sides, C, colorCache, stats) {
    const vw = ctx.layoutWidth;
    if (hidden(cs) || rect.height < MIN_MEDIA_HEIGHT) return null;
    if (/contain|scale-down|none/.test(cs.objectFit)) return null;
    if (el.localName === 'img' && !el.complete) return null; // re-scanned on load
    const s = ctx.settings;
    if (full) {
      if (!ensureClippers(el, sides, C, stats, vw)) return 'rejected';
      const done = D.extendMedia(el, sides, C, { style: s.imageStyle });
      if (done) {
        stats.applied++;
        if (done === 'mirror') ctx.needsSpacer = true;
        return done;
      }
      return 'rejected';
    }
    if (!s.breakout) return null;
    if (rect.width < BREAKOUT_MIN_WIDTH * ctx.layoutWidth) return null;
    if (!(sides.right ? touch.nearRight : true) || !(sides.left ? touch.nearLeft : true)) return null;
    if (rect.left > NEAR || rect.right < ctx.layoutWidth - NEAR) return null;
    if (parseFloat(cs.borderTopLeftRadius) > 2 || parseFloat(cs.borderTopRightRadius) > 2) return null;
    if (el.closest(INTERACTIVE.replace('a[href],', ''))) return null;
    // Break out only through plain wrappers up to a full-width ancestor.
    const anchor = fullWidthAncestor(el, ctx.layoutWidth);
    if (!anchor || !plainBetween(el, anchor, colorCache)) return null;
    if (!ensureClippers(el, sides, C, stats, vw)) return 'rejected';
    const grew = D.breakOut(el, sides, C, ctx.layoutWidth);
    if (grew === null) return 'rejected';
    stats.applied++;
    if (rect.top < 0) stats.growAbove += grew;
    return 'grow';
  }

  function fullWidthAncestor(el, vw) {
    let node = D.parentOf(el);
    while (node && node !== document.documentElement) {
      const r = node.getBoundingClientRect();
      if (Math.abs(r.left) <= TOL && r.right >= vw - TOL) return node;
      node = D.parentOf(node);
    }
    return null;
  }

  /**
   * Makes sure every ancestor that would clip `el` reaches into the column
   * too, by extending its padding box. Returns false if one can't be.
   */
  function ensureClippers(el, sides, C, stats, vw) {
    for (const clipper of D.clippingAncestors(el)) {
      const rec = D.records.get(clipper);
      if (rec && rec.recipe === 'padding' && sameSides(rec.sides, sides)) continue;
      if (rec) D.revert(clipper);
      const done = D.extendBox(clipper, rec ? rec.kind : 'clipper', sides, C, { recipes: ['padding'], layoutWidth: vw });
      if (!done) return false;
      stats.applied++;
    }
    return true;
  }

  function sameSides(a, b) {
    return !!a && a.left === b.left && a.right === b.right;
  }

  function noteReapply(rec) {
    if (D.stylesIntact(rec)) return; // the layout changed; that's not a fight
    const now = Date.now();
    const history = (D.reapplyHistory = D.reapplyHistory || new WeakMap());
    const times = (history.get(rec.el) || []).filter((t) => now - t < 10000);
    times.push(now);
    history.set(rec.el, times);
    if (times.length > 6) blocked.add(rec.el);
  }
})();
