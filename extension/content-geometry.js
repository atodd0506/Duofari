// Works out whether Safari is showing its side column next to this page, how
// wide it is in CSS pixels, and which edge it is on.
//
// Safari treats the column as an obscured inset, not a safe area, so there is
// no CSS or DOM API for it. What we can rely on:
//   - iPhone Duo reports a 466 × 678 pt screen in every pose (even unfolded),
//     and no other iPhone has that screen size.
//   - Safari lays the page out in whatever width is left beside the column, so
//     screen width − layout width × zoom scale = column width in points.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});

  const DUO_SHORT = 466;
  const DUO_LONG = 678;
  const MIN_COLUMN = 40;
  const MAX_COLUMN = 140;

  function defaultEnv() {
    const doc = document;
    const root = doc.compatMode === 'BackCompat' && doc.body ? doc.body : doc.documentElement;
    const vv = globalThis.visualViewport;
    return {
      screenWidth: screen.width,
      screenHeight: screen.height,
      layoutWidth: root.clientWidth,
      layoutHeight: root.clientHeight,
      visualWidth: vv ? vv.width : root.clientWidth,
      scale: vv ? vv.scale : 1,
      landscape: globalThis.matchMedia ? matchMedia('(orientation: landscape)').matches : root.clientWidth > root.clientHeight,
      orientationAngle: screen.orientation ? screen.orientation.angle : (typeof globalThis.orientation === 'number' ? globalThis.orientation : 0),
      userAgent: navigator.userAgent,
    };
  }

  /**
   * @returns {{width:number, left:boolean, right:boolean, reason:string,
   *            layoutWidth:number, scale:number, landscape:boolean, zoomed:boolean, duo:boolean}}
   *   width is the column width in CSS px (0 when there is no column).
   */
  D.measureColumn = function measureColumn(settings, env = defaultEnv()) {
    const result = {
      width: 0, left: false, right: false, reason: '',
      layoutWidth: env.layoutWidth, scale: env.scale, landscape: env.landscape,
      zoomed: false, duo: false,
    };

    // While the user is pinch-zoomed in, the visual viewport is narrower than
    // the layout viewport and the arithmetic below no longer holds. The caller
    // keeps its previous answer.
    if (env.visualWidth < env.layoutWidth - 1) {
      result.zoomed = true;
      result.reason = 'zoomed';
      return result;
    }

    const short = Math.min(env.screenWidth, env.screenHeight);
    const long = Math.max(env.screenWidth, env.screenHeight);
    result.duo = Math.abs(short - DUO_SHORT) <= 1 && Math.abs(long - DUO_LONG) <= 1;
    if (!result.duo && !settings.force) {
      result.reason = 'not-duo';
      return result;
    }

    const scale = env.scale > 0 ? env.scale : 1;
    if (scale < 0.95 && !settings.desktopPages) {
      // The page is laid out wider than the screen and scaled down to fit.
      result.reason = 'desktop-layout';
      return result;
    }

    let columnPt;
    if (result.duo) {
      const screenAlong = env.landscape ? long : short;
      columnPt = screenAlong - env.layoutWidth * scale;
    } else {
      columnPt = Number(settings.forceColumn) || 84;
    }

    if (!(columnPt >= MIN_COLUMN && columnPt <= MAX_COLUMN)) {
      // Unfolded: Safari uses the full width of the inner display.
      result.reason = columnPt < MIN_COLUMN ? 'no-column' : 'unexpected-width';
      return result;
    }

    result.width = Math.round((columnPt / scale) * 100) / 100;
    if (!env.landscape) {
      result.right = true;
    } else if (settings.landscapeSide === 'left') {
      result.left = true;
    } else if (settings.landscapeSide === 'right') {
      result.right = true;
    } else {
      // Which edge Safari uses in landscape depends on the rotation and isn't
      // confirmed. Bleed on both: the side without a column lands off-screen.
      result.left = true;
      result.right = true;
    }
    result.reason = 'column';
    return result;
  };

  D.sameGeometry = function sameGeometry(a, b) {
    return !!a && !!b && a.width === b.width && a.left === b.left && a.right === b.right &&
      Math.abs(a.layoutWidth - b.layoutWidth) < 0.5;
  };
})();
