// Works out whether Safari is showing its side column next to this page, how
// wide it is in CSS pixels, and which edge it is on.
//
// Safari treats the column as an obscured inset, not a safe area, so there is
// no CSS or DOM API for it. What we can rely on:
//   - iPhone Duo reports its outer display (466 × 678 pt at 3x) as the screen
//     in every pose, even unfolded. Its aspect ratio (≈1.455) is unlike any
//     other iPhone's, which also survives Display Zoom.
//   - Safari lays the page out in whatever width is left beside the column, so
//     screen width − layout width × zoom scale = column width in points.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});

  const DUO_ASPECT = 678 / 466;
  const MIN_COLUMN = 60;
  const MAX_COLUMN = 110;

  function viewportMeta() {
    const metas = document.querySelectorAll('meta[name="viewport" i]');
    return metas.length ? metas[metas.length - 1].getAttribute('content') || '' : null;
  }

  /** A page laid out for a desktop-width viewport rather than the device width. */
  function desktopLayout(meta, screenAlong) {
    if (meta === null) return true;
    const m = /(?:^|[\s,;])width\s*=\s*([^,;\s]+)/i.exec(meta);
    if (!m) return !/initial-scale/i.test(meta);
    if (/device-width/i.test(m[1])) return false;
    const width = parseFloat(m[1]);
    return Number.isFinite(width) && width > screenAlong + 1;
  }

  D.readEnv = function readEnv(settings) {
    const doc = document;
    const root = doc.compatMode === 'BackCompat' && doc.body ? doc.body : doc.documentElement;
    const vv = globalThis.visualViewport;
    const mq = (q) => (globalThis.matchMedia ? matchMedia(q).matches : false);
    return {
      screenWidth: screen.width,
      screenHeight: screen.height,
      dpr: globalThis.devicePixelRatio || 1,
      layoutWidth: root.clientWidth,
      layoutHeight: root.clientHeight,
      visualWidth: vv ? vv.width : root.clientWidth,
      scale: vv ? vv.scale : 1,
      orientationType: screen.orientation ? screen.orientation.type : '',
      orientationAngle: screen.orientation ? screen.orientation.angle : (typeof globalThis.orientation === 'number' ? globalThis.orientation : 0),
      landscapeMedia: mq('(orientation: landscape)'),
      rtl: getComputedStyle(doc.documentElement).direction === 'rtl',
      meta: viewportMeta(),
      reducedTransparency: mq('(prefers-reduced-transparency: reduce)'),
      device: settings && settings.device,
    };
  };

  function looksLikeDuo(short, long, dpr) {
    return short > 0 && Math.abs(long / short - DUO_ASPECT) < 0.03 && dpr >= 2.5;
  }

  /**
   * @returns {{width:number, left:boolean, right:boolean, side:string|null, reason:string,
   *            layoutWidth:number, scale:number, landscape:boolean, zoomed:boolean, duo:boolean, media:boolean}}
   *   width is the column width in CSS px (0 when Duofari shouldn't act).
   */
  D.measureColumn = function measureColumn(settings, env = D.readEnv(settings)) {
    const result = {
      width: 0, left: false, right: false, side: null, reason: '',
      layoutWidth: env.layoutWidth, scale: env.scale, landscape: false,
      zoomed: false, duo: false, media: true, columnPt: 0,
    };

    // While the user is pinch-zoomed in, the visual viewport is narrower than
    // the layout viewport and the arithmetic below no longer holds. The caller
    // keeps its previous answer.
    if (env.visualWidth < env.layoutWidth - 1) {
      result.zoomed = true;
      result.reason = 'zoomed';
      return result;
    }

    let short = Math.min(env.screenWidth, env.screenHeight);
    let long = Math.max(env.screenWidth, env.screenHeight);
    result.duo = looksLikeDuo(short, long, env.dpr);
    if (!result.duo && env.device && looksLikeDuo(
      Math.min(env.device.screenWidth, env.device.screenHeight),
      Math.max(env.device.screenWidth, env.device.screenHeight), env.device.scale || env.dpr)) {
      // Safari's fingerprinting protection (Private Browsing) reports a
      // generic screen size; the containing app told us the real one.
      short = Math.min(env.device.screenWidth, env.device.screenHeight);
      long = Math.max(env.device.screenWidth, env.device.screenHeight);
      result.duo = true;
    }
    if (!result.duo && !settings.force) {
      result.reason = 'not-duo';
      return result;
    }

    result.landscape = env.orientationType ? /landscape/.test(env.orientationType) : env.landscapeMedia;
    const screenAlong = result.landscape ? long : short;

    if (env.reducedTransparency) {
      // Safari's column turns opaque, so nothing under it would show.
      result.reason = 'reduced-transparency';
      return result;
    }
    if (!settings.desktopPages && desktopLayout(env.meta, screenAlong)) {
      result.reason = 'desktop-layout';
      return result;
    }

    const scale = env.scale > 0 ? env.scale : 1;
    const columnPt = result.duo ? screenAlong - env.layoutWidth * scale : Number(settings.forceColumn) || 84;
    result.columnPt = Math.round(columnPt * 100) / 100;
    if (!(columnPt >= MIN_COLUMN && columnPt <= MAX_COLUMN)) {
      // Unfolded: Safari uses the full width of the inner display.
      result.reason = columnPt < MIN_COLUMN ? 'no-column' : 'unexpected-width';
      return result;
    }

    let side = 'right';
    if (result.landscape) {
      if (settings.landscapeSide === 'left' || settings.landscapeSide === 'right') {
        side = settings.landscapeSide;
      } else {
        // Safari keeps its controls beside the outer camera, which ends up on
        // the left after turning the phone counterclockwise (angle 90).
        // Unconfirmed on hardware, so in this mode only background colours
        // extend: a wrong guess then costs nothing visible.
        side = Math.round(env.orientationAngle) % 360 === 90 ? 'left' : 'right';
        result.media = false;
      }
    }
    result.side = side;

    // WebKit can only paint content that overflows toward the document's end
    // edge (right in left-to-right pages); overflow toward the start edge is
    // clamped away.
    const endSide = env.rtl ? 'left' : 'right';
    if (side !== endSide) {
      result.reason = 'start-side';
      return result;
    }

    result.width = Math.round((columnPt / scale) * 100) / 100;
    result.left = side === 'left';
    result.right = side === 'right';
    result.reason = 'column';
    return result;
  };

  D.sameGeometry = function sameGeometry(a, b) {
    return !!a && !!b && a.width === b.width && a.left === b.left && a.right === b.right &&
      a.media === b.media && Math.abs(a.layoutWidth - b.layoutWidth) < 0.5;
  };
})();
