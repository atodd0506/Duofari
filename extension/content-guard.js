// Holds the page still horizontally.
//
// Content that reaches under Safari's column makes the document wider than
// the layout viewport, which would let the page slide sideways. Duofari:
//   1. restricts panning to the vertical axis while the page is at its normal
//      zoom (`touch-action: pan-y pinch-zoom`, less whatever the page itself
//      turned off) — on <html>, <body> and every wrapper on the way that
//      WebKit would otherwise reset to `auto` (any element whose computed
//      overflow is auto or scroll). Real horizontal scrollers (carousels)
//      keep their own panning. Optional: it also turns off double-tap zoom
//      and swiping back from the middle of the page;
//   2. puts the page (or an app shell that scrolls instead of it) back if it
//      ends up scrolled sideways anyway — focus, find-in-page, anchors, or a
//      swipe when (1) is off — once scrolling has settled, with a relative
//      scrollBy so it never fights an ongoing vertical fling;
//   3. gives up both while the user is pinch-zoomed in, so a zoomed page can
//      be panned freely.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});
  if (D.controller) return; // already running in this page

  const SETTLE_MS = 150;
  // Marks a locked element with the page's own values, as `data-duofari` does
  // for extended ones, so copies the page makes of it can be cleaned up.
  const LOCK = 'data-duofari-lock';
  D.LOCK = LOCK;
  const LOCK_PROPS = ['touch-action', 'overscroll-behavior-x'];

  const state = {
    on: false,
    lock: true,
    baseScale: 1,
    allowance: 0,          // horizontal scroll the page had before Duofari (px)
    column: 0,             // the most Duofari's extensions can widen an app shell by (px)
    locked: new Map(),     // element -> saved inline touch-action / overscroll values
    roots: new Set(),      // elements that should carry the touch-action lock
    scrollers: new Set(),  // app shells that scroll instead of the document
    touches: 0,
    lastScroll: 0,
    timer: 0,
  };

  const scratch = [document.createElement('div'), document.createElement('div')];

  function zoomed() {
    const vv = globalThis.visualViewport;
    return !!vv && vv.scale > state.baseScale * 1.02;
  }

  const rtl = () => getComputedStyle(document.documentElement).direction === 'rtl';

  // ---------------------------------------------------------------------------
  // touch-action lock

  /**
   * The page's own touch-action without sideways panning, so a pinch-zoom
   * (or anything else) the page turned off stays off. Null when the page
   * already allows no sideways panning there.
   */
  function lockValue(el) {
    const own = getComputedStyle(el).touchAction;
    if (!own || own === 'auto' || own === 'manipulation') return 'pan-y pinch-zoom';
    const tokens = own.split(/\s+/);
    const kept = tokens.filter((token) => !/^pan-(x|left|right)$/.test(token));
    if (kept.length === tokens.length) return null;
    return kept.join(' ') || 'none';
  }

  function lockElement(el) {
    if (state.locked.has(el)) return;
    // A copy of a locked element (a page snapshot put back) would otherwise
    // have our lock saved as its own value.
    if (el.hasAttribute(LOCK)) cleanLock(el);
    const lock = lockValue(el);
    if (!lock) return;
    const style = el.style;
    const values = LOCK_PROPS.map((prop) => [style.getPropertyValue(prop), style.getPropertyPriority(prop)]);
    state.locked.set(el, { attr: D.originalStyle ? D.originalStyle(el) : el.getAttribute('style'), values });
    style.setProperty('touch-action', lock, 'important');
    if (el === document.documentElement) style.setProperty('overscroll-behavior-x', 'none', 'important');
    el.setAttribute(LOCK, JSON.stringify(values));
  }

  function unlockElement(el) {
    const saved = state.locked.get(el);
    if (!saved) return;
    state.locked.delete(el);
    restoreLocked(el, saved.values);
    if (D.records && D.records.has(el)) return; // its style attribute is Duofari's to tidy
    D.tidyStyleAttribute(el, saved.attr);
  }

  function restoreLocked(el, values) {
    LOCK_PROPS.forEach((prop, i) => {
      const [value, priority] = values[i] || [];
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    });
    el.removeAttribute(LOCK);
  }

  /** Puts the page's own values back on a copy of a locked element. */
  function cleanLock(el) {
    let values;
    try {
      values = JSON.parse(el.getAttribute(LOCK) || '[]');
    } catch {
      values = [];
    }
    restoreLocked(el, Array.isArray(values) ? values : []);
    D.tidyStyleAttribute(el, null);
  }

  function updateLock() {
    const want = state.on && state.lock && !zoomed() && state.allowance < 1;
    for (const el of [...state.locked.keys()]) {
      if (!want || !state.roots.has(el) || !el.isConnected) unlockElement(el);
    }
    if (want) for (const el of state.roots) if (el.isConnected) lockElement(el);
  }

  // ---------------------------------------------------------------------------
  // Snap-back

  /** The horizontal position the page itself allows, given its own overflow. */
  function clampX(x, allowance) {
    const min = rtl() ? -allowance : 0;
    const max = rtl() ? 0 : allowance;
    return Math.min(max, Math.max(min, x));
  }

  /**
   * An app shell's own sideways range. Duofari widens it by the column at
   * most, so wider overflow is content the page added since it was
   * registered (a wide table on a later route) and stays reachable.
   */
  function shellAllowance(el) {
    const overflow = el.scrollWidth - el.clientWidth;
    return overflow > state.column + 1 ? overflow : 0;
  }

  function settle() {
    state.timer = 0;
    if (!state.on || zoomed()) return;
    if (state.touches > 0 || performance.now() - state.lastScroll < SETTLE_MS) {
      state.timer = setTimeout(settle, SETTLE_MS);
      return;
    }
    const dx = globalThis.scrollX - clampX(globalThis.scrollX, state.allowance);
    if (Math.abs(dx) >= 0.5) scrollByInstant(globalThis, -dx);
    for (const el of state.scrollers) {
      if (!el.isConnected) { state.scrollers.delete(el); continue; }
      const ex = el.scrollLeft - clampX(el.scrollLeft, shellAllowance(el));
      if (Math.abs(ex) >= 0.5) scrollByInstant(el, -ex);
    }
  }

  function scrollByInstant(target, dx) {
    try {
      target.scrollBy({ left: dx, top: 0, behavior: 'instant' });
    } catch {
      target.scrollBy(dx, 0);
    }
  }

  function onScroll(event) {
    if (!state.on) return;
    const t = event.target;
    const isRoot = t === document || t === document.documentElement || t === document.body;
    if (!isRoot && !state.scrollers.has(t)) return;
    const now = performance.now();
    const idle = now - state.lastScroll > SETTLE_MS;
    state.lastScroll = now;
    const drifted = isRoot
      ? Math.abs(globalThis.scrollX - clampX(globalThis.scrollX, state.allowance)) >= 0.5
      : Math.abs(t.scrollLeft - clampX(t.scrollLeft, shellAllowance(t))) >= 0.5;
    if (!drifted) return;
    if (idle && state.touches === 0) {
      // A programmatic jump (focus, anchor, find): put it back right away.
      state.lastScroll = 0;
      settle();
    } else if (!state.timer) {
      state.timer = setTimeout(settle, SETTLE_MS);
    }
  }

  function onScrollEnd() {
    if (!state.on) return;
    state.lastScroll = 0;
    if (state.touches === 0) settle();
  }

  function onTouch(event) {
    state.touches = event.touches ? event.touches.length : 0;
    if (event.type !== 'touchstart') return;
    // A target the page removes mid-touch (a recycled feed row) still gets
    // its touchend, but outside the document, where the window never hears it.
    const target = event.composedPath()[0] || event.target;
    for (const type of ['touchend', 'touchcancel']) target.addEventListener(type, onTouch, { once: true, passive: true });
  }

  function onViewport() {
    if (!state.on) return;
    updateLock();
    if (!zoomed() && !state.timer) state.timer = setTimeout(settle, SETTLE_MS);
  }

  D.guard = {
    /** The page's own horizontal scroll range. Call before Duofari changes anything. */
    measureAllowance() {
      const el = document.scrollingElement || document.documentElement;
      return Math.max(0, el.scrollWidth - el.clientWidth);
    },

    /** True while the page is scrolled away from where it should rest. */
    drifted() {
      return state.on && !zoomed() && Math.abs(globalThis.scrollX - clampX(globalThis.scrollX, state.allowance)) >= 0.5;
    },

    enable({ baseScale = 1, allowance = 0, column = 0, lock = true, roots = [], scrollers = [] } = {}) {
      state.baseScale = baseScale;
      state.allowance = allowance;
      state.column = column;
      state.lock = lock;
      state.roots = new Set(roots);
      for (const el of scrollers) state.scrollers.add(el);
      if (!state.on) {
        state.on = true;
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        document.addEventListener('scrollend', onScrollEnd, { capture: true, passive: true });
        for (const type of ['touchstart', 'touchend', 'touchcancel']) {
          globalThis.addEventListener(type, onTouch, { capture: true, passive: true });
        }
        if (globalThis.visualViewport) globalThis.visualViewport.addEventListener('resize', onViewport);
      }
      updateLock();
      settle();
    },

    disable() {
      state.on = false;
      clearTimeout(state.timer);
      state.timer = 0;
      document.removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('scrollend', onScrollEnd, { capture: true });
      for (const type of ['touchstart', 'touchend', 'touchcancel']) {
        globalThis.removeEventListener(type, onTouch, { capture: true });
      }
      if (globalThis.visualViewport) globalThis.visualViewport.removeEventListener('resize', onViewport);
      updateLock();
      state.scrollers.clear();
      state.roots.clear();
    },

    /** A copy of a locked element, made by the page: strip our lock from it. */
    cleanClone(el) {
      if (state.locked.has(el)) return false;
      cleanLock(el);
      return true;
    },

    /**
     * Whether a style attribute that was `oldValue` sets anything different
     * now, apart from the lock (which is written while zooming, outside a
     * run) and custom properties (scroll effects write those every frame).
     */
    restyled(el, oldValue) {
      const [before, now] = scratch;
      before.setAttribute('style', oldValue || '');
      now.setAttribute('style', el.getAttribute('style') || '');
      for (const { style } of scratch) {
        for (const prop of [...style]) if (LOCK_PROPS.includes(prop) || prop.startsWith('--')) style.removeProperty(prop);
      }
      return before.style.cssText !== now.style.cssText;
    },

    get active() { return state.on; },
    get locked() { return state.locked.size > 0; },
    get zoomed() { return zoomed(); },
  };
})();
