// Holds the page still horizontally.
//
// Content that reaches under Safari's column makes the document wider than
// the layout viewport, which would let the page slide sideways. Duofari:
//   1. restricts panning to the vertical axis while the page is at its normal
//      zoom (`touch-action: pan-y pinch-zoom`) — on <html>, <body> and every
//      wrapper on the way that WebKit would otherwise reset to `auto` (any
//      element whose computed overflow is auto or scroll). Real horizontal
//      scrollers (carousels) keep their own panning. Optional: it also turns
//      off double-tap zoom and swiping back from the middle of the page;
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

  const state = {
    on: false,
    lock: true,
    baseScale: 1,
    allowance: 0,          // horizontal scroll the page had before Duofari (px)
    locked: new Map(),     // element -> saved inline touch-action / overscroll values
    roots: new Set(),      // elements that should carry the touch-action lock
    scrollers: new Set(),  // app shells that scroll instead of the document
    touches: 0,
    lastScroll: 0,
    timer: 0,
  };

  function zoomed() {
    const vv = globalThis.visualViewport;
    return !!vv && vv.scale > state.baseScale * 1.02;
  }

  const rtl = () => getComputedStyle(document.documentElement).direction === 'rtl';

  // ---------------------------------------------------------------------------
  // touch-action lock

  function lockElement(el) {
    if (state.locked.has(el)) return;
    const style = el.style;
    state.locked.set(el, {
      attr: D.originalStyle ? D.originalStyle(el) : el.getAttribute('style'),
      touch: [style.getPropertyValue('touch-action'), style.getPropertyPriority('touch-action')],
      over: [style.getPropertyValue('overscroll-behavior-x'), style.getPropertyPriority('overscroll-behavior-x')],
    });
    style.setProperty('touch-action', 'pan-y pinch-zoom', 'important');
    if (el === document.documentElement) style.setProperty('overscroll-behavior-x', 'none', 'important');
  }

  function unlockElement(el) {
    const saved = state.locked.get(el);
    if (!saved) return;
    state.locked.delete(el);
    for (const [prop, [value, priority]] of [['touch-action', saved.touch], ['overscroll-behavior-x', saved.over]]) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    if (D.records && D.records.has(el)) return; // its style attribute is Duofari's to tidy
    D.tidyStyleAttribute(el, saved.attr);
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
      const ex = el.scrollLeft - clampX(el.scrollLeft, 0);
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
      : Math.abs(t.scrollLeft - clampX(t.scrollLeft, 0)) >= 0.5;
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

    enable({ baseScale = 1, allowance = 0, lock = true, roots = [], scrollers = [] } = {}) {
      state.baseScale = baseScale;
      state.allowance = allowance;
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

    get active() { return state.on; },
    get locked() { return state.locked.size > 0; },
    get zoomed() { return zoomed(); },
  };
})();
