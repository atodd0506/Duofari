// Holds the page still horizontally.
//
// Content that reaches under Safari's column makes the document wider than
// the layout viewport, which would let the page slide sideways. Duofari:
//   1. restricts panning of the root to the vertical axis while the page is
//      at its normal zoom (`touch-action: pan-y pinch-zoom`); nested scrollers
//      such as carousels keep their own horizontal panning;
//   2. puts the page back if it ends up scrolled sideways anyway (focus,
//      find-in-page, anchors), waiting for scrolling to settle so it never
//      fights a fling;
//   3. gives up both while the user is pinch-zoomed in, so a zoomed page can
//      be panned freely.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});

  const SETTLE_MS = 140;

  const state = {
    on: false,
    baseScale: 1,
    allowance: 0,       // horizontal scroll the page had before Duofari (px)
    touchAction: false,
    touches: 0,
    lastScroll: 0,
    timer: 0,
    saved: null,
  };

  function root() {
    return document.scrollingElement || document.documentElement;
  }

  function zoomed() {
    const vv = globalThis.visualViewport;
    return !!vv && vv.scale > state.baseScale * 1.02;
  }

  function setTouchAction(on) {
    const html = document.documentElement;
    if (on === state.touchAction) return;
    if (on) {
      state.saved = {
        touchAction: [html.style.getPropertyValue('touch-action'), html.style.getPropertyPriority('touch-action')],
        overscroll: [html.style.getPropertyValue('overscroll-behavior-x'), html.style.getPropertyPriority('overscroll-behavior-x')],
        attr: html.getAttribute('style'),
      };
      html.style.setProperty('touch-action', 'pan-y pinch-zoom', 'important');
      html.style.setProperty('overscroll-behavior-x', 'none', 'important');
    } else if (state.saved) {
      for (const [prop, [value, priority]] of [['touch-action', state.saved.touchAction], ['overscroll-behavior-x', state.saved.overscroll]]) {
        if (value) html.style.setProperty(prop, value, priority);
        else html.style.removeProperty(prop);
      }
      D.tidyStyleAttribute(html, state.saved.attr);
      state.saved = null;
    }
    state.touchAction = on;
  }

  /** Scroll positions the page itself allows, in scrollX terms (RTL scrolls negative). */
  function clampX(x) {
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    const min = rtl ? -state.allowance : 0;
    const max = rtl ? 0 : state.allowance;
    return Math.min(max, Math.max(min, x));
  }

  function settle() {
    state.timer = 0;
    if (!state.on || zoomed()) return;
    if (state.touches > 0 || performance.now() - state.lastScroll < SETTLE_MS) {
      state.timer = setTimeout(settle, SETTLE_MS);
      return;
    }
    const x = globalThis.scrollX;
    const target = clampX(x);
    if (Math.abs(x - target) < 0.5) return;
    // Jump, even on pages that ask for smooth scrolling.
    const el = root();
    const attr = el.getAttribute('style');
    const behavior = el.style.getPropertyValue('scroll-behavior');
    const priority = el.style.getPropertyPriority('scroll-behavior');
    el.style.setProperty('scroll-behavior', 'auto', 'important');
    try {
      globalThis.scrollTo({ left: target, top: globalThis.scrollY, behavior: 'instant' });
    } catch {
      globalThis.scrollTo(target, globalThis.scrollY);
    }
    if (behavior) el.style.setProperty('scroll-behavior', behavior, priority);
    else el.style.removeProperty('scroll-behavior');
    D.tidyStyleAttribute(el, attr);
  }

  function onScroll(event) {
    if (!state.on) return;
    const t = event.target;
    if (t !== document && t !== document.documentElement && t !== document.body) return;
    const now = performance.now();
    const idle = now - state.lastScroll > SETTLE_MS;
    state.lastScroll = now;
    if (Math.abs(globalThis.scrollX - clampX(globalThis.scrollX)) < 0.5) return;
    if (idle && state.touches === 0) {
      // A programmatic jump (focus, anchor, find): put it back right away.
      state.lastScroll = 0;
      settle();
    } else if (!state.timer) {
      state.timer = setTimeout(settle, SETTLE_MS);
    }
  }

  function onTouch(event) {
    state.touches = event.touches ? event.touches.length : 0;
  }

  function onViewport() {
    if (!state.on) return;
    const z = zoomed();
    setTouchAction(!z && state.allowance < 1);
    if (!z && !state.timer) state.timer = setTimeout(settle, SETTLE_MS);
  }

  D.guard = {
    /** Call before Duofari changes anything, to learn the page's own horizontal scroll range. */
    measureAllowance() {
      const el = root();
      return Math.max(0, el.scrollWidth - el.clientWidth);
    },

    enable({ baseScale = 1, allowance = 0 } = {}) {
      state.baseScale = baseScale;
      state.allowance = allowance;
      if (!state.on) {
        state.on = true;
        document.addEventListener('scroll', onScroll, { capture: true, passive: true });
        for (const type of ['touchstart', 'touchend', 'touchcancel']) {
          globalThis.addEventListener(type, onTouch, { capture: true, passive: true });
        }
        if (globalThis.visualViewport) globalThis.visualViewport.addEventListener('resize', onViewport);
      }
      onViewport();
      settle();
    },

    disable() {
      if (!state.on) return;
      state.on = false;
      clearTimeout(state.timer);
      state.timer = 0;
      document.removeEventListener('scroll', onScroll, { capture: true });
      for (const type of ['touchstart', 'touchend', 'touchcancel']) {
        globalThis.removeEventListener(type, onTouch, { capture: true });
      }
      if (globalThis.visualViewport) globalThis.visualViewport.removeEventListener('resize', onViewport);
      setTouchAction(false);
    },

    get active() { return state.on; },
    get zoomed() { return zoomed(); },
  };
})();
