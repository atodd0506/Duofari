// Finds what should extend into Safari's column and extends it.
//
// Only an element that reaches the edge of the layout viewport can continue
// under the column, so the scan walks a "spine": it starts at <body> and
// descends only into elements whose box (or overflow) touches the column's
// edge, or comes close to it for photos inset by page margins. Everything
// else is pruned after one rect read. Elements are processed top-down, so a
// parent is already extended (with its content box unchanged) when its
// children are measured.
//
// What extends (Apple's rule: background art extends, foreground stays put):
//   bands  – full-width boxes with their own background (header bars, hero
//            sections, banners, footers): the background continues, the
//            content doesn't move;
//   media  – the lead image, and cover-fitted pictures that have cropped-away
//            art to show; other full-width images only if the user asks;
//   breakout (opt-in) – photos inset by page margins grow to the full width.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});
  if (D.controller) return; // already running in this page

  const TOL = 1.5;            // px: "touches the edge"
  const NEAR = 48;            // px: page margins an inset photo may break out of
  const MIN_MEDIA_HEIGHT = 100;
  const BREAKOUT_MIN_WIDTH = 0.8;
  const OVERLAY_HEIGHT = 0.9;
  const LEAD_DEPTH = 1.5;     // viewport heights from the top where the lead image may start
  const FRESH_SHARE = 0.25;   // of a slice, for a pass begun while another is unfinished

  const SKIP = new Set([
    'script', 'style', 'link', 'meta', 'template', 'noscript', 'br', 'wbr', 'head', 'title', 'source', 'track',
    'area', 'map', 'option', 'optgroup', 'datalist', 'param', 'iframe', 'frame', 'frameset', 'object', 'embed',
    'input', 'select', 'textarea', 'button', 'dialog', 'svg', 'math', 'audio', 'slot', 'canvas',
  ]);
  const MEDIA = new Set(['img', 'video']);
  const REPLACED = new Set(['img', 'video', 'canvas', 'picture', 'audio', 'meter', 'progress']);
  const CAROUSELS = '.swiper,.swiper-container,.swiper-wrapper,.slick-list,.slick-track,.splide__track,.embla,.embla__viewport,' +
    '.glide__track,.flickity-viewport,.owl-stage-outer,.keen-slider,.carousel-inner,.flex-viewport,[data-carousel]';
  const PLAYERS = '.html5-video-player,.video-js,.vjs-tech,[class*="jw-"],.jwplayer,.bc-player,.plyr,[class*="mejs__"],' +
    '.shaka-video-container,.vimeo-player,[data-player],.video-player';
  const GRAPHICS = '.g-artboard,[class*="ai2html"],[class*="infographic"],[class*="chart"],[class*="diagram"]';
  const GRAPHIC_WORDS = /screen\s?shot|diagram|chart|graph|infographic|\bmap\b|figure\s?\d|\btable\b|\bcode\b|\bslide\b|comic|\bpanel\b/i;

  /** Elements we've tried and couldn't extend cleanly, keyed to the layout they failed in. */
  const rejected = new WeakMap();
  /** Clippers we couldn't open, keyed to the layout and how far their content reaches. */
  const unopened = new WeakMap();
  /** Elements whose extension the page keeps undoing; left alone for this page view. */
  const blocked = new WeakSet();
  D.blocked = blocked;

  // ---------------------------------------------------------------------------
  // Colours and backgrounds

  function parseColor(value) {
    const m = /rgba?\(([^)]+)\)/.exec(value || '');
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }

  const visibleColor = (c) => !!c && c.a >= 0.05;

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
   * Whether an element paints a background worth continuing: an image or
   * gradient, or a colour different from what's behind it. (A border line
   * alone isn't: list separators stay inset, as in Apple's apps.)
   */
  function hasBackground(el, cs, cache) {
    if (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text') return false;
    if (cs.borderImageSource && cs.borderImageSource !== 'none') return false;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const color = parseColor(cs.backgroundColor);
    return visibleColor(color) && !sameColor(color, backdropColor(el, cache));
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

  const isScroller = (el, cs) => scrollsX(el, cs) || scrollsY(el, cs);

  /** WebKit resets touch-action at any element whose computed overflow is auto or scroll. */
  const resetsTouchAction = (cs) => /auto|scroll/.test(cs.overflowX) || /auto|scroll/.test(cs.overflowY);

  function hidden(cs) {
    return cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity) === 0;
  }

  /** Transforms other than a plain translation make rects disagree with layout. */
  function oddTransform(cs) {
    const t = cs.transform;
    if (t && t !== 'none' && !/^matrix\(1, 0, 0, 1, /.test(t)) return true;
    return (cs.scale && cs.scale !== 'none') || (cs.rotate && cs.rotate !== 'none');
  }

  function animating(el) {
    if (!el.getAnimations) return false;
    try {
      return el.getAnimations().some((a) => a.playState === 'running');
    } catch {
      return false;
    }
  }

  /** Running CSS transitions on `el` (unlike animations, they end). */
  function transitioning(el) {
    if (!el.getAnimations || typeof CSSTransition === 'undefined') return false;
    try {
      return el.getAnimations().some((a) => a instanceof CSSTransition && a.playState === 'running');
    } catch {
      return false;
    }
  }

  /** An anchor for CSS anchor positioning: boxes placed against its border box would move with it. */
  const anchors = (cs) => !!cs.anchorName && cs.anchorName !== 'none';

  /** "Plain" ancestors an inset photo may break out of: no box of their own. */
  function plainBetween(el, stopAt, cache) {
    let node = D.parentOf(el);
    while (node && node !== stopAt) {
      const cs = getComputedStyle(node);
      if (hasBackground(node, cs, cache)) return false;
      if (cs.boxShadow !== 'none' || parseFloat(cs.borderTopLeftRadius) > 2 || parseFloat(cs.borderTopRightRadius) > 2) return false;
      if (parseFloat(cs.borderLeftWidth) || parseFloat(cs.borderRightWidth)) return false;
      if (D.clips(node, cs) || D.containsFixed(cs) || cs.position === 'fixed' || cs.position === 'sticky') return false;
      if (/^(flex|inline-flex|grid|inline-grid)$/.test(cs.display) && node.children.length > 1) return false;
      if (/^(table|table-cell|table-row|list-item)$/.test(cs.display)) return false;
      node = D.parentOf(node);
    }
    return true;
  }

  function sourceOf(el) {
    return String(el.currentSrc || el.src || el.poster || '');
  }

  /** Charts, screenshots, comics and other pictures whose edges carry information. */
  function likelyGraphic(el, rect) {
    if (el.closest(GRAPHICS)) return true;
    const src = sourceOf(el).split(/[?#]/)[0];
    const words = [el.alt, el.title, el.getAttribute('aria-label'), src.startsWith('data:') ? '' : src.split('/').pop(),
      typeof el.className === 'string' ? el.className : ''].join(' ');
    if (GRAPHIC_WORDS.test(words)) return true;
    if (/^data:image\/svg|\.svg$/i.test(src)) return true;
    // Lossless formats on something taller than a banner are usually graphics.
    return /\.(png|gif)$/i.test(src) && rect.width / rect.height < 1.6;
  }

  /** Labels positioned over a picture (annotated graphics): its pixels must not move under them. */
  function annotated(el, rect) {
    let host = D.parentOf(el);
    for (let i = 0; i < 2 && host; i++, host = D.parentOf(host)) {
      let labels = 0;
      const nodes = host.querySelectorAll('*');
      if (nodes.length > 400) return false;
      for (const node of nodes) {
        if (node === el || node.contains(el) || !(node.textContent || '').trim()) continue;
        if (getComputedStyle(node).position !== 'absolute') continue;
        const r = node.getBoundingClientRect();
        if (r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) labels++;
        if (labels > 2) return true;
      }
    }
    return false;
  }

  /** Full-width pictures stacked edge to edge (comic strips, long infographics in slices). */
  function stacked(el, rect, vw) {
    let node = el;
    for (let i = 0; i < 3; i++) {
      const parent = D.parentOf(node);
      if (!parent || parent.children.length !== 1) break;
      node = parent;
    }
    for (const sib of [node.previousElementSibling, node.nextElementSibling]) {
      if (!sib) continue;
      const img = sib.matches('img,video') ? sib : sib.querySelector('img,video');
      if (!img) continue;
      const r = img.getBoundingClientRect();
      if (Math.abs(r.left) > TOL || Math.abs(r.right - vw) > TOL) continue;
      if (Math.abs(r.bottom - rect.top) < 3 || Math.abs(rect.bottom - r.top) < 3) return true;
    }
    return false;
  }

  function nearestScroller(el) {
    for (let node = D.parentOf(el); node && node !== document.body && node !== document.documentElement; node = D.parentOf(node)) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowX)) return node;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // The scan

  /**
   * One slice of a pass over the page. A pass cut short by the budget or the
   * deadline returns `stats.cursor`; given back as `ctx.resume`, the next
   * slice goes on from there, so a large page is walked to the end. With
   * `ctx.again` (the page changed meanwhile) a new pass starts from the top
   * at once, alongside the unfinished one. It walks first, for FRESH_SHARE
   * of each slice once it has begun, and the older pass then has the rest
   * of a slice, however long that took. So <body> and the top of the page
   * are looked at again straight away, and the older pass still ends however
   * often the page changes. Once it has, the newer one goes on alone; if the
   * newer one gets to the end first, the older one has nothing left to do.
   * Until then the newer one looks for latecomers only among what the page
   * changed (see holds).
   * @param {object} ctx  { layoutWidth, viewportHeight, C, left, right, media, settings, budget, deadline,
   *                        touchRoots:Set, scrollers:Set, observeRoot(root), resume, again }
   */
  D.scan = function scan(ctx) {
    const stats = { visited: 0, applied: 0, reverted: 0, truncated: false, waiting: false, cursor: null };
    const body = document.body;
    if (!body) return stats;
    const vw = ctx.layoutWidth;
    const C = ctx.C;
    const sides = { left: !!ctx.left, right: !!ctx.right };
    const s = ctx.settings;
    const winTop = -2 * ctx.viewportHeight;
    const winBottom = 4 * ctx.viewportHeight;
    const near = s.breakout && s.media && ctx.media ? NEAR : TOL;
    const colorCache = new Map();
    const layoutKey = `${vw}|${C}|${sides.left}|${sides.right}|${!!ctx.media}`;
    const resume = ctx.resume && ctx.resume.layoutKey === layoutKey && ctx.resume.body === body ? ctx.resume : null;
    const scrollY = globalThis.scrollY;
    const slice = ctx.deadline ? ctx.deadline - performance.now() : 0;

    // kept: the touch roots of a pass that ended before the newer one had been everywhere.
    let pass = resume ? resume.pass : null;
    let fresh = resume ? resume.fresh : null;
    let kept = resume ? resume.kept : null;
    if (!pass) pass = beginPass(body, stats, ctx, null);
    else if (ctx.again) fresh = beginPass(body, stats, ctx, pass);
    let walk = fresh || pass;
    let budget = fresh ? ctx.budget * FRESH_SHARE : ctx.budget;
    let deadline = fresh && ctx.deadline ? performance.now() + slice * FRESH_SHARE : ctx.deadline;

    for (;;) {
      if (finished(walk.stack)) {
        if (!fresh) {
          kept = null;
          break;
        }
        // Either the older pass is done, and the newer one goes on alone, or
        // the newer one has walked the whole page, and the older one has
        // nothing left to do. A box it then has to measure again is reverted,
        // and the page walked again from the top.
        kept = walk === fresh ? null : pass.roots;
        pass = walk = fresh;
        fresh = null;
        if (lookLate(pass, vw, stats)) fresh = beginPass(body, stats, ctx, pass);
        continue;
      }
      if (stats.visited >= budget || (deadline && performance.now() > deadline)) {
        if (walk === fresh) {
          // The older pass's share, however long the newer one's took.
          walk = pass;
          budget = ctx.budget;
          deadline = ctx.deadline && Math.max(ctx.deadline, performance.now() + slice * (1 - FRESH_SHARE));
          continue;
        }
        stats.truncated = true;
        stats.cursor = { layoutKey, body, pass, fresh, kept };
        break;
      }
      const { stack, state } = walk;
      const el = next(stack);
      const tag = el.localName;
      // A resumed pass may be going through a part of the page removed since.
      if (SKIP.has(tag) || !el.isConnected || el.hasAttribute('data-duofari-ui') || el.isContentEditable) continue;
      stats.visited++;

      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        const cs = getComputedStyle(el);
        if (cs.display === 'contents' && !leaveCarousel(el, cs)) pushChildren(stack, el, ctx);
        continue;
      }
      if (r.bottom < winTop || r.top > winBottom) continue;

      let rec = D.records.get(el);
      if (rec && rec.kind === 'pin') continue;
      if (rec) {
        const leaf = rec.kind === 'media' || rec.kind === 'breakout';
        if (mustWait(rec)) {
          stats.waiting = true;
          if (!leaf) descend(walk, el, getComputedStyle(el), r, ctx, vw);
          continue;
        }
        if (holds(rec, vw, walk)) {
          if (rec.kind === 'media' && r.top + scrollY < LEAD_DEPTH * ctx.viewportHeight) state.leadTaken = true;
          if (!leaf) descend(walk, el, getComputedStyle(el), r, ctx, vw);
          continue;
        }
        invalidate(rec, state, stats);
        rec = null;
      }

      const rect = el.getBoundingClientRect();
      const touch = edgeState(rect, vw, C, sides, near);
      if (!touch.relevant) {
        if (touch.overflowReaches(el) && !leaveCarousel(el, getComputedStyle(el))) pushChildren(stack, el, ctx);
        continue;
      }

      const cs = getComputedStyle(el);
      if (cs.display === 'none' || hidden(cs)) continue;
      if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true })) continue;

      // Full-screen fixed overlays (menus, modals, dimming layers). Safari
      // paints an opaque fill over the column for these anyway.
      if (cs.position === 'fixed' && rect.height >= OVERLAY_HEIGHT * ctx.viewportHeight) continue;
      if (oddTransform(cs)) continue;

      if (touch.bleeds) {
        // Already reaches into the column (the site's own 100vw, or artwork
        // that grew with an extended parent). Nothing to do but look inside.
        descend(walk, el, cs, rect, ctx, vw);
        continue;
      }

      const key = `${layoutKey}|${rect.width}|${rect.height}`;
      if (blocked.has(el) || rejected.get(el) === key || animating(el) || anchors(cs)) {
        if (!MEDIA.has(tag)) descend(walk, el, cs, rect, ctx, vw);
        continue;
      }

      if (MEDIA.has(tag)) {
        if (s.media && ctx.media) {
          const outcome = classifyMedia(el, cs, rect, touch, ctx, sides, C, colorCache, stats, state, scrollY);
          if (outcome === 'rejected') rejected.set(el, key);
        }
        continue;
      }

      if (touch.full && s.bands && !REPLACED.has(tag) && !/^table/.test(cs.display) && !el.matches(D.INTERACTIVE) &&
          !(cs.display.startsWith('inline') && cs.display !== 'inline-block') && hasBackground(el, cs, colorCache)) {
        // A scroll container's padding box is its scrollport, and a clipping
        // box's clip has to reach into the column for its children to show
        // there. Everything else keeps its padding box: positioned children,
        // pseudo-elements and icons stay exactly where they were.
        const recipes = scrollsX(el, cs) || isCarousel(el, cs) ? ['border'] : D.clips(el, cs) ? ['padding', 'border'] : ['border', 'padding'];
        const extend = () => D.extendBox(el, 'band', sides, C, { recipes, layoutWidth: vw, pictures: ctx.media });
        const done = applyGuarded(el, stats, sides, C, vw, extend, ctx.media);
        if (done) {
          if (cs.position === 'fixed') liftFixed(el, cs);
        } else if (done === null) {
          rejected.set(el, key);
        }
      }

      descend(walk, el, cs, rect, ctx, vw);
    }

    if (ctx.touchRoots) {
      ctx.touchRoots.add(document.documentElement).add(body);
      for (const roots of [kept, pass.roots, fresh && fresh.roots]) if (roots) for (const el of roots) ctx.touchRoots.add(el);
    }
    return stats;
  };

  /**
   * Starts a pass from the top, which finds its own touch roots, with what a
   * pass does once before it walks <body>'s children. `older`: the
   * unfinished pass it is begun alongside, if any. brokenOut: photos
   * reverted from a breakout earlier in either.
   */
  function beginPass(body, stats, ctx, older) {
    const brokenOut = older ? older.state.brokenOut : new Set();
    const walk = { stack: [], state: { leadTaken: false, brokenOut }, roots: new Set(), owed: older ? new Set() : null };
    // Whatever Duofari writes into editable content would be saved with it.
    for (const [el, rec] of D.records) if (!rec.owner && el.isContentEditable) D.revert(el);

    // <body> is never walked itself, but it can be a clipper Duofari opened.
    const bodyRec = D.records.get(body);
    if (bodyRec && mustWait(bodyRec)) {
      stats.waiting = true;
    } else if (bodyRec && !holds(bodyRec, ctx.layoutWidth, walk)) {
      invalidate(bodyRec, walk.state, stats);
    }
    pushChildren(walk.stack, body, ctx);
    return walk;
  }

  /**
   * Whether an extended box still holds, with the positioned boxes that
   * appeared in it since pinned. Looking for those everywhere in it reads
   * the style of everything inside, so a pass begun while another is
   * unfinished, which may be every scan, looks only at what the page added
   * or restyled there since, and puts the rest off (in `owed`) until it is
   * on its own.
   */
  function holds(rec, vw, walk) {
    if (!D.stillValid(rec)) return false;
    if (walk.owed) walk.owed.add(rec);
    return D.repinLatecomers(rec, vw, { everywhere: !walk.owed });
  }

  /**
   * The looks for latecomers a pass put off, once it is on its own. True if
   * a box had to be reverted to be measured again, with what is inside it.
   */
  function lookLate(walk, vw, stats) {
    let reverted = false;
    for (const rec of walk.owed || []) {
      if (D.records.get(rec.el) !== rec || D.repinLatecomers(rec, vw)) continue;
      invalidate(rec, walk.state, stats);
      reverted = true;
    }
    walk.owed = null;
    return reverted;
  }

  /**
   * Carousels and sliders, whose slides are never touched: a slider's
   * class, or snapping sideways. (Snapping up and down is a page of
   * sections, often an app shell.)
   */
  function isCarousel(el, cs) {
    if (el.matches(CAROUSELS)) return true;
    const axis = (cs.scrollSnapType || 'none').split(' ')[0];
    const across = /^(vertical|sideways)/.test(cs.writingMode) ? 'block' : 'inline';
    return axis === 'x' || axis === 'both' || axis === across;
  }

  /**
   * Whether the walk stays out of an element because it is a carousel. A
   * slide extended before a slider library set one up (Slick, Flickity and
   * Owl wrap the slides when they load) is put back.
   */
  function leaveCarousel(el, cs) {
    if (!isCarousel(el, cs)) return false;
    for (const [inner, rec] of D.records) if (!rec.owner && inner !== el && D.contains(el, inner)) D.revert(inner);
    return true;
  }

  /** Visits an element's children, unless it is a carousel or a small scroll container (a tab strip). */
  function descend(walk, el, cs, rect, ctx, vw) {
    if (leaveCarousel(el, cs)) return;
    if (isScroller(el, cs)) {
      const pageSized = Math.abs(rect.left) <= TOL && rect.right >= vw - TOL && rect.height >= 0.6 * ctx.viewportHeight;
      if (!pageSized) return;
      // An app shell that scrolls instead of the document: hold it still too.
      if (ctx.scrollers && !scrollsX(el, cs)) ctx.scrollers.add(el);
    }
    if (resetsTouchAction(cs) && !scrollsX(el, cs)) walk.roots.add(el);
    pushChildren(walk.stack, el, ctx);
  }

  /**
   * Puts an element's children, and then an open shadow root's, on a pass's
   * stack. A frame goes through the live list of children, so a container
   * with thousands of them costs nothing more until the walk gets there.
   */
  function pushChildren(stack, el, ctx) {
    if (el.shadowRoot) {
      if (ctx.observeRoot) ctx.observeRoot(el.shadowRoot);
      stack.push({ kids: el.shadowRoot.children, i: 0 });
    }
    stack.push({ kids: el.children, i: 0 });
  }

  /** Whether a pass has nothing left to visit, dropping the frames it is done with. */
  function finished(stack) {
    for (let top = stack[stack.length - 1]; top && top.i >= top.kids.length; top = stack[stack.length - 1]) stack.pop();
    return !stack.length;
  }

  /** The next element of a pass that isn't finished. */
  function next(stack) {
    const top = stack[stack.length - 1];
    return top.kids[top.i++];
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
    const full = (atLeft || (sides.left && pastLeft)) && (atRight || (sides.right && pastRight));
    // A box narrower than the viewport can still hold a full-bleed child
    // (`width: 100vw; margin-left: calc(50% - 50vw)` in an article column).
    const overflowReaches = (el) => {
      if (overflowing || !el.firstElementChild) return false;
      if (sides.right) return rect.left + el.clientLeft + el.scrollWidth >= vw - TOL;
      return rect.right - el.clientLeft - el.scrollWidth <= TOL;
    };
    return { relevant, bleeds, full, nearRight, nearLeft, overflowReaches };
  }

  /**
   * Runs an extension and undoes it if it gave an enclosing scroll container
   * (an app shell, a list) horizontal overflow it didn't have. Returns null
   * if it failed, and false if a clipper around the element couldn't be
   * opened (that is retried, see ensureClippers). Clippers are opened with
   * the extension's `pictures` (see extendBox).
   */
  function applyGuarded(el, stats, sides, C, vw, apply, pictures = true) {
    const width = el.getBoundingClientRect().width;
    if (!ensureClippers(el, sides, C, stats, vw, pictures)) return false;
    // A layer filling a clipper just opened (a backdrop at inset: 0) grew
    // with it, and reaches into the column already.
    if (Math.abs(el.getBoundingClientRect().width - width) > TOL) return false;
    const scroller = nearestScroller(el);
    const before = scroller ? scroller.scrollWidth - scroller.clientWidth : 0;
    const done = apply();
    if (!done) return null;
    if (scroller && scroller.scrollWidth - scroller.clientWidth > before + 1) {
      D.revert(el);
      return null;
    }
    stats.applied++;
    return done;
  }

  /**
   * WebKit clips a fixed box's composited layer to the layout viewport unless
   * the box is transformed. An identity translate lifts that clip so the
   * extension actually paints under the column. It would also make the box
   * the containing block of fixed descendants (slide-out menus), so it's
   * only added when there are none (and dropped if one appears).
   */
  function liftFixed(el, cs) {
    if ((cs.transform && cs.transform !== 'none') || (cs.translate && cs.translate !== 'none')) return;
    if (D.hasFixedDescendant(el)) return;
    const rec = D.records.get(el);
    if (rec) D.lift(rec);
  }

  function classifyMedia(el, cs, rect, touch, ctx, sides, C, colorCache, stats, state, scrollY) {
    const vw = ctx.layoutWidth;
    const s = ctx.settings;
    if (hidden(cs) || rect.height < MIN_MEDIA_HEIGHT) return null;
    if (/contain|scale-down|none/.test(cs.objectFit)) return null;
    if (el.localName === 'img' && (!el.complete || !el.naturalWidth)) return null; // re-scanned on load
    if (el.localName === 'img' && el.useMap) return null;
    if (el.localName === 'video') {
      // Only background video: muted, looping or autoplaying, with no
      // controls and not inside a player that draws its own.
      if (el.controls || !(el.muted || el.autoplay) || !(el.loop || el.autoplay) || el.closest(PLAYERS)) return null;
    }

    const docTop = rect.top + scrollY;
    if (touch.full) {
      const isLead = !state.leadTaken && docTop < LEAD_DEPTH * ctx.viewportHeight;
      if (docTop < LEAD_DEPTH * ctx.viewportHeight) state.leadTaken = true;
      if (annotated(el, rect)) return null;
      // A cover-fitted picture with art cropped away beside it continues
      // pixel for pixel. Anything else has to be scaled up and trimmed,
      // which suits the lead image but not content further down.
      const slack = D.coverSlack(el);
      const reveal = !!slack && (!sides.right || slack.right >= C - 0.5) && (!sides.left || slack.left >= C - 0.5);
      if (!reveal) {
        if (!(isLead || s.allImages)) return null;
        if (likelyGraphic(el, rect) || stacked(el, rect, vw)) return null;
      }
      const done = applyGuarded(el, stats, sides, C, vw, () => D.extendMedia(el, sides, C, { mode: reveal ? 'reveal' : 'fill' }));
      return done === null ? 'rejected' : done;
    }

    if (!s.breakout || el.localName !== 'img') return null;
    // Breakout changes the layout, so only photos that are still entirely
    // below the visible part of the page grow; nothing the reader is looking
    // at moves. A photo reverted from a breakout earlier in this pass (the
    // page restyled it) is the exception: it is put back before the reader
    // sees it shrink.
    if (rect.top < ctx.viewportHeight && !state.brokenOut.has(el)) return null;
    if (rect.width < BREAKOUT_MIN_WIDTH * vw) return null;
    if (!(sides.right ? touch.nearRight : true) || !(sides.left ? touch.nearLeft : true)) return null;
    if (rect.left > NEAR || rect.right < vw - NEAR) return null;
    if (parseFloat(cs.borderTopLeftRadius) > 2 || parseFloat(cs.borderTopRightRadius) > 2) return null;
    if (el.closest(D.INTERACTIVE.replace('a[href],', ''))) return null;
    if (likelyGraphic(el, rect) || /\.(png|gif)(?:$|[?#])/i.test(sourceOf(el))) return null;
    if (el.naturalWidth && el.naturalWidth < vw + C) return null; // would be upscaled past its resolution
    const anchor = fullWidthAncestor(el, vw);
    if (!anchor || !plainBetween(el, anchor, colorCache)) return null;
    const grew = applyGuarded(el, stats, sides, C, vw, () => (D.breakOut(el, sides, C, vw) === null ? null : 'grow'));
    return grew === null ? 'rejected' : grew;
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
  function ensureClippers(el, sides, C, stats, vw, pictures) {
    for (const clipper of D.clippingAncestors(el)) {
      const rec = D.records.get(clipper);
      if (rec && rec.recipe === 'padding' && sameSides(rec.sides, sides)) continue;
      if (anchors(getComputedStyle(clipper))) return false;
      // What it hides past the edge (a menu that is open) can go away again,
      // so a failure only holds while its content reaches as far. (A band's
      // border extension leaves its padding box as it was.)
      const key = `${vw}|${C}|${sides.left}|${sides.right}|${pictures}|${clipper.clientWidth}|${clipper.scrollWidth}`;
      if (unopened.get(clipper) === key) return false;
      if (rec) D.revert(clipper);
      const done = D.extendBox(clipper, rec ? rec.kind : 'clipper', sides, C, { recipes: ['padding'], layoutWidth: vw, pictures });
      if (!done) unopened.set(clipper, key);
      if (rec && rec.kind === 'band') {
        // A band keeps the border it had if it can't be opened, and its lift either way.
        if (!done) D.extendBox(clipper, 'band', sides, C, { recipes: [rec.recipe], layoutWidth: vw, pictures });
        if (rec.lifted && D.records.has(clipper)) liftFixed(clipper, getComputedStyle(clipper));
      }
      if (!done) return false;
      stats.applied++;
    }
    return true;
  }

  function sameSides(a, b) {
    return !!a && a.left === b.left && a.right === b.right;
  }

  /**
   * Whether a record the page restyled has started a transition: reverting
   * now (with transitions off) would cut it short, so it waits until it
   * ends. That goes for the boxes it pinned and, in a clipper, for anything
   * extended inside it, which is reverted with it.
   */
  function mustWait(rec) {
    if (!rec.dirty) return false;
    const els = [rec.el, ...rec.pins.map((p) => p.el)];
    if (rec.clips) for (const el of D.records.keys()) if (el !== rec.el && rec.el.contains(el)) els.push(el);
    return els.some(transitioning);
  }

  /**
   * Reverts a record the page has invalidated. Breakouts reverted with it
   * (its own, or those inside a clipper) are put back in this pass.
   */
  function invalidate(rec, state, stats) {
    noteReapply(rec);
    for (const [el, r] of D.records) {
      if (r.kind === 'breakout' && (el === rec.el || (rec.clips && rec.el.contains(el)))) state.brokenOut.add(el);
    }
    D.revert(rec.el);
    stats.reverted++;
  }

  function noteReapply(rec) {
    if (D.stylesIntact(rec)) return; // the layout or the site's classes changed; that's not a fight
    const now = Date.now();
    const history = (D.reapplyHistory = D.reapplyHistory || new WeakMap());
    const times = (history.get(rec.el) || []).filter((t) => now - t < 10000);
    times.push(now);
    history.set(rec.el, times);
    if (times.length > 6) blocked.add(rec.el);
  }
})();
