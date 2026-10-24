// Duofari's controller: decides when to run, keeps up with the page, and
// answers the popup.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});
  if (D.controller) return;
  if (globalThis.top !== globalThis.self) return;
  if (!(document.documentElement instanceof HTMLElement)) {
    // An SVG or XML file shown on its own: nothing to change, but the popup
    // should say so rather than offer to apply Duofari.
    if (!D.documentListener && D.api && D.api.runtime && D.api.runtime.onMessage) {
      D.documentListener = true;
      D.api.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message && message.type === 'duofari:status') sendResponse({ hostname: location.hostname, active: false, reason: 'unsupported-document' });
      });
    }
    return;
  }

  const MIN_INTERVAL = 300;
  const RESIZE_SETTLE = 250;
  const SCAN_BUDGET = 6000;
  const SLICE_MS = 12;          // keep each scan short; the rest continues in the next one
  const FLIP_LIMIT = 4;         // on/off changes within FLIP_WINDOW before Duofari stands down
  const FLIP_WINDOW = 10000;
  const META_LIMIT = 5;         // viewport meta repairs within META_WINDOW before leaving it to the page
  const META_WINDOW = 10000;
  const TEXT_QUIET = 5000;      // text changing in one element brings a scan at most this often

  const state = {
    settings: { ...D.DEFAULTS },
    geometry: null,
    pose: '',
    active: false,
    reason: 'starting',
    ownAllowance: 0,
    allowance: 0,
    vwIncludesColumn: false,
    vwExcess: 0,
    meta: null,
    metaRewrites: [],
    href: location.href,
    debug: null,
    timer: 0,
    textTimer: 0,
    lastRun: 0,
    lastScrollY: 0,
    stats: null,
    cursor: null,
    resumeTimer: 0,
    resuming: false,
    flips: [],
    unstable: false,
    observedRoots: new WeakSet(),
    mutationRates: new WeakMap(),
    textScans: new WeakMap(),
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
    state.timer = 0;
    run();
  }

  function run() {
    state.timer = 0;
    state.lastRun = performance.now();
    if (document.hidden) return;
    const s = state.settings;
    const geo = D.measureColumn(s);
    // Folding, unfolding and rotating are the user's doing, not the page
    // being unstable: only on/off changes within one pose count. The window's
    // width in points stays put whatever the page does to its viewport meta,
    // and while zooming.
    const vv = globalThis.visualViewport;
    const pose = `${Math.round(vv ? vv.width * vv.scale : geo.layoutWidth)}|${screen.orientation ? screen.orientation.type : globalThis.orientation}`;
    if (pose !== state.pose) {
      state.pose = pose;
      state.flips = [];
      state.unstable = false;
    }
    const site = D.siteState(s, location.hostname);
    const off = !s.enabled ? 'disabled' : site === 'off' ? 'site-disabled' : site === 'excluded' ? 'excluded-site'
      : state.unstable ? 'unstable' : '';
    if (geo.zoomed) {
      // Keep things as they are until the user zooms back out, unless
      // Duofari was switched off meanwhile. Not a Duo, unfolded and the
      // like still hold while zoomed in.
      if (off && state.active) deactivate();
      const unzoomed = state.geometry && state.geometry.reason !== 'column' ? state.geometry.reason : '';
      if (!state.active) state.reason = off || unzoomed || 'zoomed';
      return;
    }
    if (state.active && D.guard.drifted()) {
      // Rects would be measured while the page is shifted sideways; wait for
      // the guard to put it back.
      schedule(200);
      return;
    }

    let want = !off && geo.width > 0;
    state.reason = off || geo.reason;

    if (want !== state.active && noteFlip()) {
      want = false;
      state.reason = 'unstable';
    }
    if (!want) {
      if (state.active) deactivate();
      state.geometry = geo;
      return;
    }
    if (state.active && !D.sameGeometry(state.geometry, geo)) {
      // Rotation, fold or a settings change: start from the page's own layout.
      resetChanges();
      state.active = false;
    }
    if (!state.active) activate();
    state.geometry = geo;

    D.pruneDetached();
    const touchRoots = new Set();
    const scrollers = new Set();
    const ctx = {
      layoutWidth: geo.layoutWidth,
      viewportHeight: globalThis.innerHeight,
      C: geo.width,
      left: geo.left,
      right: geo.right,
      media: geo.media,
      settings: s,
      budget: SCAN_BUDGET,
      deadline: performance.now() + SLICE_MS,
      touchRoots,
      scrollers,
      observeRoot,
    };
    // A pass cut short goes on where it stopped; anything else that asks for
    // a scan meanwhile starts a fresh pass from the top.
    ctx.resume = state.resuming ? state.cursor : null;
    const stats = D.scan(ctx);
    state.stats = stats;
    state.lastScrollY = globalThis.scrollY;
    state.cursor = stats.cursor;
    clearTimeout(state.resumeTimer);
    if (stats.cursor) {
      state.resumeTimer = setTimeout(() => {
        if (state.timer) return; // a fresh pass is on its way
        state.resuming = true;
        run();
        state.resuming = false;
      }, MIN_INTERVAL);
    }
    // Elements waiting for a transition to end.
    if (stats.waiting) schedule(60);
    updateAllowance(geo.width);

    D.guard.enable({
      baseScale: geo.scale,
      allowance: state.allowance,
      column: geo.width,
      lock: s.holdSteady,
      roots: [...touchRoots],
      scrollers: [...scrollers],
    });
    if (s.debug) drawDebug(geo, stats);
    else removeDebug();
    observer.takeRecords(); // our own writes
  }

  function activate() {
    // Measure the page's own horizontal overflow before changing anything.
    state.ownAllowance = D.guard.measureAllowance();
    state.vwIncludesColumn = probeViewportUnits();
    if (state.vwIncludesColumn && state.ownAllowance <= state.vwExcess + 1) state.ownAllowance = 0;
    state.allowance = state.ownAllowance;
    fixViewportMeta();
    state.active = true;
  }

  /**
   * The page's own content can make it wider after activation (a wide table
   * on a client-rendered route, lazy content) and narrower again. Duofari's
   * extensions widen it by at most C, so overflow beyond that is the page's:
   * it stays reachable, with no touch lock or meta pin in the meantime.
   */
  function updateAllowance(C) {
    const overflow = D.guard.measureAllowance();
    const allowance = overflow > C + 1 ? overflow : state.ownAllowance;
    if (allowance === state.allowance) return;
    state.allowance = allowance;
    if (allowance >= 1) restoreViewportMeta();
    else fixViewportMeta();
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
  }

  /** Counts on/off changes; true (stand down) if they come too fast. */
  function noteFlip() {
    const now = performance.now();
    state.flips = state.flips.filter((t) => now - t < FLIP_WINDOW);
    state.flips.push(now);
    if (state.flips.length > FLIP_LIMIT) {
      state.unstable = true;
      return true;
    }
    return false;
  }

  /**
   * Whether `100vw` already reaches under the column in this browser (it does
   * in some WKWebView set-ups). If so, a page whose own overflow is exactly the
   * column width just has a `width: 100vw` section, not real sideways content.
   */
  function probeViewportUnits() {
    const probe = document.createElement('div');
    probe.setAttribute('data-duofari-ui', 'probe');
    probe.style.cssText = 'position:absolute!important;visibility:hidden!important;width:100vw!important;height:0!important;top:0!important;left:0!important';
    document.documentElement.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    state.vwExcess = Math.max(0, width - document.documentElement.clientWidth);
    return width > document.documentElement.clientWidth + 1;
  }

  // ---------------------------------------------------------------------------
  // Viewport meta. WebKit fits a page without an initial scale to its content
  // width, and lets the minimum zoom follow the content width down, so content
  // reaching under the column would zoom the page out to 382/466. Pin both to
  // 1 (the minimum to the page's own initial scale if that is lower) — only on
  // pages whose own content fits, where zooming out further never showed
  // anything anyway. Zooming in is untouched.

  function lastViewportMeta() {
    const metas = document.querySelectorAll('meta[name="viewport" i]');
    return metas[metas.length - 1] || null;
  }

  function fixViewportMeta() {
    if (state.allowance >= 1) return;
    const meta = lastViewportMeta();
    if (!meta) return;
    const content = meta.getAttribute('content') || '';
    if (!/width\s*=\s*device-width|initial-scale/i.test(content)) return;
    const additions = [];
    if (!/initial-scale/i.test(content)) additions.push('initial-scale=1');
    // A minimum above the page's initial scale would zoom it in and lay it out narrower.
    const initial = parseFloat((/initial-scale\s*=\s*([\d.]+)/i.exec(content) || [])[1]);
    if (!/minimum-scale/i.test(content)) additions.push(`minimum-scale=${initial > 0 && initial < 1 ? initial : 1}`);
    if (!additions.length) return;
    const next = `${content.trim().replace(/[\s,;]+$/, '')}, ${additions.join(', ')}`;
    if (!state.meta || state.meta.el !== meta) state.meta = { el: meta, content, ours: next };
    state.meta.ours = next;
    meta.setAttribute('content', next);
  }

  /**
   * Puts our additions back if a head manager rewrote the meta (unhead) or
   * replaced it with a fresh one (Next.js, Helmet and Turbo compare tags, so
   * they swap out the one we edited on every navigation).
   */
  function checkViewportMeta() {
    if (!state.active) return;
    if (state.meta) {
      const meta = lastViewportMeta();
      if (meta === state.meta.el && meta.getAttribute('content') === state.meta.ours) return;
      const now = performance.now();
      state.metaRewrites = state.metaRewrites.filter((t) => now - t < META_WINDOW);
      if (state.metaRewrites.length >= META_LIMIT) return; // the page insists; leave it for now
      state.metaRewrites.push(now);
      restoreViewportMeta();
    }
    fixViewportMeta();
  }

  function restoreViewportMeta() {
    if (!state.meta) return;
    const { el, content, ours } = state.meta;
    if (el.isConnected && el.getAttribute('content') === ours) el.setAttribute('content', content);
    state.meta = null;
  }

  // ---------------------------------------------------------------------------
  // Debug view: hatches the column and outlines what was extended.

  function drawDebug(geo, stats) {
    if (!state.debug) {
      const host = document.createElement('div');
      host.setAttribute('data-duofari-ui', 'debug');
      host.setAttribute('aria-hidden', 'true');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        .col{position:fixed;top:0;bottom:0;width:var(--c);pointer-events:none;z-index:2147483646;
          background:repeating-linear-gradient(45deg,rgba(255,45,146,.35) 0 6px,transparent 6px 12px)}
        .badge{position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;
          font:600 11px/1.3 -apple-system,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.72);
          padding:4px 8px;border-radius:10px}
      </style><div class="col"></div><div class="badge"></div>`;
      document.documentElement.appendChild(host);
      const style = document.createElement('style');
      style.setAttribute('data-duofari-ui', 'debug-style');
      style.textContent = '[data-duofari-debug]{outline:2px dashed #ff2d92!important;outline-offset:-2px!important}' +
        '[data-duofari-debug=pin]{outline-color:#0a84ff!important}';
      document.documentElement.appendChild(style);
      state.debug = { host, shadow, style, outlined: new Set() };
    }
    const { shadow } = state.debug;
    shadow.host.style.setProperty('--c', `${geo.width}px`);
    const col = shadow.querySelector('.col');
    col.style.left = geo.right ? `${geo.layoutWidth}px` : `${-geo.width}px`;
    const counts = countKinds();
    shadow.querySelector('.badge').textContent =
      `Duofari · ${geo.width}px ${geo.right ? 'right' : 'left'} · ${counts.band} bars · ${counts.media + counts.breakout} images` +
      `${D.guard.locked ? ' · locked' : ''}${stats && stats.truncated ? ' · partial' : ''}`;
    const now = new Set(D.records.keys());
    for (const el of state.debug.outlined) if (!now.has(el)) el.removeAttribute('data-duofari-debug');
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

  const OBSERVE = {
    childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['class', 'style', 'src', 'srcset', 'hidden', 'open', 'content', 'aria-expanded'],
  };

  /** Ignores elements that change many times a second (animations, tickers). */
  function tooBusy(target) {
    const now = performance.now();
    let r = state.mutationRates.get(target);
    if (!r || now - r.since > 1000) {
      if (r && r.mutedUntil > now) return true;
      r = { since: now, count: 0, mutedUntil: 0 };
      state.mutationRates.set(target, r);
    }
    if (++r.count > 10) {
      r.mutedUntil = now + 5000;
      return true;
    }
    return r.mutedUntil > now;
  }

  const observer = new MutationObserver((mutations) => {
    // Copies are cleaned up even while Duofari is off: the page may put back
    // a snapshot it took while Duofari was on (Turbo, PJAX).
    for (const m of mutations) {
      for (const n of m.addedNodes) if (n.nodeType === 1 && !n.hasAttribute('data-duofari-ui')) cleanClones(n);
    }
    if (!state.settings.enabled) return;
    // Safari 18 has no Navigation API: a single-page app's pushState shows
    // only as a new address.
    if (location.href !== state.href) onNavigate();
    let relevant = false;
    let head = false;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        // Text edited in place (as React updates it) inside an opened clipper.
        const n = m.target;
        if (state.active && n.nodeType === 3 && D.noteAdded(n) && !textRecently(n.parentNode)) relevant = true;
        continue;
      }
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.hasAttribute('data-duofari-ui')) continue;
          if (n.nodeType === 1) relevant = true;
          // Content added inside a clipper Duofari opened up (text too). Text
          // that keeps changing in one place (a clock, a live score) is left
          // for a later scan instead of bringing one each time.
          if (state.active && (n.nodeType === 1 || n.nodeType === 3) && D.noteAdded(n) && (n.nodeType === 1 || !textRecently(m.target))) {
            relevant = true;
          }
        }
        if (!relevant) for (const n of m.removedNodes) if (n.nodeType === 1 && !n.hasAttribute('data-duofari-ui')) relevant = true;
        if (m.target === document.head) head = true;
        continue;
      }
      const t = m.target;
      if (!(t instanceof Element) || t.hasAttribute('data-duofari-ui')) continue;
      if (m.attributeName === 'content') {
        if (t.localName === 'meta') checkViewportMeta();
        continue;
      }
      if (D.records.has(t)) {
        // The site restyled something we extended: re-measure it from the
        // site's own styles instead of keeping stale numbers. The guard's
        // touch-action lock, written while zooming, and custom properties
        // aren't a restyle.
        if (m.attributeName === 'style' && !D.guard.restyled(t, m.oldValue)) continue;
        if (m.attributeName === 'class' || m.attributeName === 'style') D.markDirty(t);
        relevant = true;
      } else if (m.attributeName !== 'style' && !tooBusy(t)) {
        relevant = true;
      }
    }
    // A head manager may have swapped in a fresh viewport meta.
    if (head) checkViewportMeta();
    if (state.active) D.checkLifts();
    if (relevant) schedule();
  });

  /**
   * True if text in `parent` already brought a scan within TEXT_QUIET. The
   * change is still checked: by the next scan, TEXT_QUIET from now at the latest.
   */
  function textRecently(parent) {
    const now = performance.now();
    const last = state.textScans.get(parent);
    if (last !== undefined && now - last < TEXT_QUIET) {
      if (!state.textTimer) state.textTimer = setTimeout(() => { state.textTimer = 0; schedule(); }, TEXT_QUIET);
      return true;
    }
    state.textScans.set(parent, now);
    return false;
  }

  /** Elements the page copied from ones we'd changed (sticky-header clones, loop slides, snapshots). */
  function cleanClones(node) {
    if (!node.querySelectorAll) return;
    for (const el of [node, ...node.querySelectorAll(`[${D.MARK}],[${D.LOCK}]`)]) {
      if (el.hasAttribute(D.MARK)) D.cleanClone(el);
      if (el.hasAttribute(D.LOCK)) D.guard.cleanClone(el);
    }
  }

  function observeRoot(root) {
    if (state.observedRoots.has(root)) return;
    state.observedRoots.add(root);
    observer.observe(root, OBSERVE);
  }

  let resizeTimer = 0;
  function onResize() {
    // Folding and unfolding pass through several intermediate sizes. Undo
    // widths pinned for the old layout at once, then re-apply when it settles.
    if (state.active && state.geometry && Math.abs(document.documentElement.clientWidth - state.geometry.layoutWidth) > 0.5) {
      resetChanges();
      observer.takeRecords();
    }
    clearTimeout(resizeTimer);
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

  function onNavigate() {
    // A new page in a single-page app: give it a fresh chance.
    state.href = location.href;
    state.unstable = false;
    state.flips = [];
    state.metaRewrites = [];
    schedule();
  }

  function diagnostics() {
    const vv = globalThis.visualViewport;
    const geo = state.geometry;
    return {
      screen: `${screen.width}×${screen.height}`,
      dpr: globalThis.devicePixelRatio,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: globalThis.innerWidth,
      innerHeight: globalThis.innerHeight,
      visualViewport: vv ? `${Math.round(vv.width * 100) / 100} @ ${Math.round(vv.scale * 1000) / 1000}, offset ${Math.round(vv.offsetLeft)}` : 'n/a',
      orientation: screen.orientation ? `${screen.orientation.type} ${screen.orientation.angle}°` : `${globalThis.orientation}`,
      direction: getComputedStyle(document.documentElement).direction,
      viewportMeta: (lastViewportMeta() || {}).content || '(none)',
      columnPoints: geo ? geo.columnPt : 0,
      columnCss: geo ? geo.width : 0,
      side: geo ? geo.side : null,
      vwIncludesColumn: state.vwIncludesColumn,
      ownOverflow: state.allowance,
      touchLock: D.guard.locked,
      deviceFromApp: state.settings.device || null,
      userAgent: navigator.userAgent,
    };
  }

  function status() {
    const geo = state.geometry;
    return {
      hostname: location.hostname,
      active: state.active,
      reason: state.reason,
      column: geo ? geo.width : 0,
      side: geo && geo.width ? geo.side : null,
      landscape: !!(geo && geo.landscape),
      counts: countKinds(),
      truncated: !!(state.stats && state.stats.truncated),
      diagnostics: diagnostics(),
    };
  }

  function onMessage(message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('duofari:')) return;
    if (message.type === 'duofari:rescan' && document.readyState !== 'loading') {
      state.unstable = false;
      state.flips = [];
      runNow();
    }
    sendResponse(status());
  }

  /** What the app's device report says, without the time stamp older versions added. */
  const deviceKey = (d) => (d ? [d.screenWidth, d.screenHeight, d.scale, d.model].join('|') : '');

  async function start() {
    state.settings = await D.loadSettings();
    D.onSettingsChanged((patch) => {
      // The popup asks the app for the device each time it opens; the same
      // answer again changes nothing.
      if ('device' in patch && deviceKey(patch.device) === deviceKey(state.settings.device)) delete patch.device;
      if (!Object.keys(patch).length) return;
      const relayout = ['bands', 'media', 'allImages', 'breakout', 'landscapeSide', 'desktopPages', 'force', 'forceColumn', 'device']
        .some((k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(state.settings[k]));
      Object.assign(state.settings, patch);
      state.unstable = false;
      state.flips = [];
      if (relayout && state.active) resetChanges();
      runNow();
    });
    observer.observe(document.documentElement, OBSERVE);
    if (globalThis.ResizeObserver && document.body) {
      new ResizeObserver(() => schedule()).observe(document.body);
    }
    globalThis.addEventListener('resize', onResize, { passive: true });
    globalThis.addEventListener('orientationchange', onResize, { passive: true });
    if (globalThis.visualViewport) globalThis.visualViewport.addEventListener('resize', onResize, { passive: true });
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    globalThis.addEventListener('load', () => schedule(), { once: true });
    globalThis.addEventListener('popstate', onNavigate);
    globalThis.addEventListener('hashchange', onNavigate);
    globalThis.addEventListener('pageshow', () => schedule());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
    document.addEventListener('load', onLoad, true);
    document.addEventListener('loadedmetadata', onLoad, true);
    if (globalThis.navigation && globalThis.navigation.addEventListener) {
      globalThis.navigation.addEventListener('navigatesuccess', onNavigate);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => schedule());
    runNow();
  }

  D.controller = {
    state,
    run: runNow,
    deactivate,
    status: () => Promise.resolve(status()),
  };

  // Answer the popup even while the page is still loading.
  if (D.api && D.api.runtime && D.api.runtime.onMessage) D.api.runtime.onMessage.addListener(onMessage);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
