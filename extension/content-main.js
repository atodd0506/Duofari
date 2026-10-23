// Duofari's controller: decides when to run, keeps up with the page, and
// answers the popup.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});
  if (D.controller) return;
  if (globalThis.top !== globalThis.self) return;
  if (!(document.documentElement instanceof HTMLElement)) return; // SVG, XML

  const MIN_INTERVAL = 300;
  const RESIZE_SETTLE = 250;
  const SCAN_BUDGET = 6000;

  const state = {
    settings: { ...D.DEFAULTS },
    geometry: null,
    active: false,
    reason: 'starting',
    allowance: 0,
    meta: null,
    spacer: null,
    debug: null,
    timer: 0,
    lastRun: 0,
    lastScrollY: 0,
    stats: null,
  };

  // ---------------------------------------------------------------------------
  // Scheduling

  function schedule(delay = 0) {
    if (state.timer) return;
    const wait = Math.max(delay, MIN_INTERVAL - (performance.now() - state.lastRun));
    state.timer = setTimeout(run, Math.max(0, wait));
  }

  function runNow() {
    clearTimeout(state.timer);
    run();
  }

  function run() {
    state.timer = 0;
    state.lastRun = performance.now();
    if (document.hidden) return;
    const s = state.settings;
    const geo = D.measureColumn(s);
    if (geo.zoomed) return; // keep things as they are until the user zooms back out

    const siteOff = D.siteDisabled(s, location.hostname);
    const want = s.enabled && !siteOff && geo.width > 0;
    state.reason = !s.enabled ? 'disabled' : siteOff ? 'site-disabled' : geo.reason;

    if (!want) {
      if (state.active) deactivate();
      state.geometry = geo;
      return;
    }
    if (state.active && !D.sameGeometry(state.geometry, geo)) {
      // Rotation, fold or a settings change: start from the page's own layout.
      resetChanges();
      state.allowance = D.guard.measureAllowance();
    }
    if (!state.active) {
      state.allowance = D.guard.measureAllowance();
      state.active = true;
    }
    state.geometry = geo;

    const ctx = {
      layoutWidth: geo.layoutWidth,
      viewportHeight: globalThis.innerHeight,
      C: geo.width,
      left: geo.left,
      right: geo.right,
      settings: s,
      budget: SCAN_BUDGET,
      needsSpacer: false,
    };
    const stats = D.scan(ctx);
    state.stats = stats;
    state.lastScrollY = globalThis.scrollY;

    if (D.records.size) fixViewportMeta();
    setSpacer(ctx.needsSpacer || hasMirror() ? geo : null);
    if (stats.growAbove) globalThis.scrollBy(0, stats.growAbove);
    D.guard.enable({ baseScale: geo.scale, allowance: state.allowance });
    if (s.debug) drawDebug(geo, stats);
    else removeDebug();
    observer.takeRecords(); // our own writes
  }

  function deactivate() {
    resetChanges();
    D.guard.disable();
    restoreViewportMeta();
    removeDebug();
    state.active = false;
    state.stats = null;
    observer.takeRecords();
  }

  function resetChanges() {
    D.revertAll();
    setSpacer(null);
  }

  function hasMirror() {
    for (const rec of D.records.values()) if (rec.recipe === 'mirror') return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Viewport meta: WebKit fits a page without an initial-scale to its content
  // width, so content reaching under the column would zoom the page out.

  function fixViewportMeta() {
    if (state.meta) return;
    const metas = document.querySelectorAll('meta[name="viewport" i]');
    const meta = metas[metas.length - 1];
    if (!meta) return;
    const content = meta.getAttribute('content') || '';
    if (/initial-scale/i.test(content) || !/width\s*=\s*device-width/i.test(content)) return;
    state.meta = { el: meta, content };
    meta.setAttribute('content', `${content.trim().replace(/[\s,;]+$/, '')}, initial-scale=1`);
  }

  function restoreViewportMeta() {
    if (!state.meta) return;
    if (state.meta.el.isConnected) state.meta.el.setAttribute('content', state.meta.content);
    state.meta = null;
  }

  // ---------------------------------------------------------------------------
  // Spacer: mirrored media paint as ink overflow, which doesn't widen the
  // document. A 1 px invisible box makes the scrollable area cover the column
  // so WebKit has tiles to paint the reflection into.

  function setSpacer(geo) {
    if (!geo || !geo.right) {
      if (state.spacer) state.spacer.remove();
      state.spacer = null;
      return;
    }
    if (!state.spacer) {
      state.spacer = document.createElement('div');
      state.spacer.setAttribute('data-duofari-ui', 'spacer');
      state.spacer.setAttribute('aria-hidden', 'true');
    }
    state.spacer.style.cssText = `position:absolute!important;top:0!important;width:1px!important;height:1px!important;` +
      `left:${geo.layoutWidth + geo.width - 1}px!important;visibility:hidden!important;pointer-events:none!important;` +
      `margin:0!important;padding:0!important;border:0!important`;
    if (!state.spacer.isConnected) document.documentElement.appendChild(state.spacer);
  }

  // ---------------------------------------------------------------------------
  // Debug view: hatches the column and outlines what was extended.

  function drawDebug(geo, stats) {
    if (!state.debug) {
      const host = document.createElement('div');
      host.setAttribute('data-duofari-ui', 'debug');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        .col{position:fixed;top:0;bottom:0;width:var(--c);pointer-events:none;z-index:2147483646;
          background:repeating-linear-gradient(45deg,rgba(255,45,146,.35) 0 6px,transparent 6px 12px)}
        .badge{position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;
          font:600 11px/1.3 -apple-system,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.72);
          padding:4px 8px;border-radius:10px}
      </style><div class="col r"></div><div class="col l"></div><div class="badge"></div>`;
      document.documentElement.appendChild(host);
      state.debug = { host, shadow, outlined: new Set(), style: null };
      const style = document.createElement('style');
      style.setAttribute('data-duofari-ui', 'debug-style');
      style.textContent = '[data-duofari-debug]{outline:2px dashed #ff2d92!important;outline-offset:-2px!important}' +
        '[data-duofari-debug=pin]{outline-color:#0a84ff!important}';
      document.documentElement.appendChild(style);
      state.debug.style = style;
    }
    const { shadow } = state.debug;
    shadow.host.style.setProperty('--c', `${geo.width}px`);
    const right = shadow.querySelector('.col.r');
    const left = shadow.querySelector('.col.l');
    right.style.display = geo.right ? 'block' : 'none';
    right.style.left = `${geo.layoutWidth}px`;
    left.style.display = geo.left ? 'block' : 'none';
    left.style.left = `${-geo.width}px`;
    const counts = countKinds();
    shadow.querySelector('.badge').textContent =
      `Duofari · ${geo.width}px ${geo.left && geo.right ? 'both sides' : geo.right ? 'right' : 'left'} · ` +
      `${counts.band} bars · ${counts.media + counts.breakout} images${stats && stats.truncated ? ' · partial' : ''}`;
    const now = new Set(D.records.keys());
    for (const el of state.debug.outlined) {
      if (!now.has(el)) el.removeAttribute('data-duofari-debug');
    }
    for (const [el, rec] of D.records) el.setAttribute('data-duofari-debug', rec.kind);
    state.debug.outlined = now;
  }

  function removeDebug() {
    if (!state.debug) return;
    for (const el of state.debug.outlined) el.removeAttribute('data-duofari-debug');
    state.debug.host.remove();
    state.debug.style.remove();
    state.debug = null;
  }

  function countKinds() {
    const counts = { band: 0, media: 0, breakout: 0, clipper: 0, pin: 0 };
    for (const rec of D.records.values()) counts[rec.kind] = (counts[rec.kind] || 0) + 1;
    return counts;
  }

  // ---------------------------------------------------------------------------
  // Keeping up with the page

  const observer = new MutationObserver((mutations) => {
    if (!state.settings.enabled) return;
    for (const m of mutations) {
      if (m.type === 'childList') {
        if (relevantNodes(m.addedNodes) || relevantNodes(m.removedNodes)) return schedule();
      } else if (m.attributeName === 'style') {
        // Only our own elements care about inline style changes; anything
        // else would make every JS animation trigger a scan.
        if (D.records.has(m.target)) return schedule();
      } else if (!(m.target instanceof Element && m.target.hasAttribute('data-duofari-ui'))) {
        return schedule();
      }
    }
  });

  function relevantNodes(nodes) {
    for (const n of nodes) {
      if (n.nodeType === 1 && !n.hasAttribute('data-duofari-ui')) return true;
    }
    return false;
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    // Folding and unfolding pass through several intermediate sizes.
    resizeTimer = setTimeout(runNow, RESIZE_SETTLE);
  }

  function onScroll() {
    if (!state.active) return;
    if (Math.abs(globalThis.scrollY - state.lastScrollY) > globalThis.innerHeight / 2) schedule(150);
  }

  function onLoad(event) {
    const t = event.target;
    if (t && (t.localName === 'img' || t.localName === 'video')) schedule();
  }

  function onMessage(message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('duofari:')) return;
    if (message.type === 'duofari:status') {
      const geo = state.geometry;
      sendResponse({
        hostname: location.hostname,
        active: state.active,
        reason: state.reason,
        column: geo ? geo.width : 0,
        left: !!(geo && geo.left),
        right: !!(geo && geo.right),
        counts: countKinds(),
        truncated: !!(state.stats && state.stats.truncated),
      });
    }
  }

  async function start() {
    state.settings = await D.loadSettings();
    D.onSettingsChanged((patch) => {
      const relayout = ['bands', 'media', 'breakout', 'imageStyle', 'landscapeSide', 'desktopPages', 'force', 'forceColumn']
        .some((k) => k in patch && patch[k] !== state.settings[k]);
      Object.assign(state.settings, patch);
      if (relayout && state.active) resetChanges();
      runNow();
    });
    if (D.api && D.api.runtime && D.api.runtime.onMessage) D.api.runtime.onMessage.addListener(onMessage);

    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'src', 'srcset', 'hidden', 'open'],
    });
    if (globalThis.ResizeObserver && document.body) {
      new ResizeObserver(() => schedule()).observe(document.body);
    }
    globalThis.addEventListener('resize', onResize, { passive: true });
    globalThis.addEventListener('orientationchange', onResize, { passive: true });
    if (globalThis.visualViewport) globalThis.visualViewport.addEventListener('resize', onResize, { passive: true });
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    globalThis.addEventListener('load', () => schedule(), { once: true });
    globalThis.addEventListener('popstate', () => schedule());
    globalThis.addEventListener('hashchange', () => schedule());
    globalThis.addEventListener('pageshow', () => schedule());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    document.addEventListener('load', onLoad, true);
    document.addEventListener('loadedmetadata', onLoad, true);
    if (globalThis.navigation && globalThis.navigation.addEventListener) {
      globalThis.navigation.addEventListener('navigatesuccess', () => schedule());
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => schedule());
    runNow();
  }

  D.controller = {
    state,
    run: runNow,
    deactivate,
    status: () => new Promise((resolve) => onMessage({ type: 'duofari:status' }, null, resolve)),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
