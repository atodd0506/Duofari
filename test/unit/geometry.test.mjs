// Unit tests for the column measurement: given what a page can see (screen,
// layout width, zoom, orientation, viewport meta), does Duofari find Safari's
// side column, and does it stay out of the way everywhere else?
//
//   node --test "test/unit/*.test.mjs"   # or: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

function loadDuofari() {
  const context = vm.createContext({});
  for (const file of ['shared-settings.js', 'content-geometry.js']) {
    vm.runInContext(readFileSync(join(EXT, file), 'utf8'), context, { filename: file });
  }
  return context.Duofari;
}

const D = loadDuofari();
const settings = (patch = {}) => ({ ...D.DEFAULTS, ...patch });

/** The folded iPhone Duo in portrait, Safari's column on the right. */
const folded = (patch = {}) => ({
  screenWidth: 466,
  screenHeight: 678,
  dpr: 3,
  layoutWidth: 382,
  layoutHeight: 580,
  visualWidth: 382,
  scale: 1,
  orientationType: 'portrait-primary',
  orientationAngle: 0,
  landscapeMedia: false,
  rtl: false,
  meta: 'width=device-width, initial-scale=1',
  reducedTransparency: false,
  device: null,
  ...patch,
});

/** Held sideways; Safari lays the page out beside the column along the long side. */
const landscape = (angle, patch = {}) => folded({
  layoutWidth: 594,
  layoutHeight: 382,
  visualWidth: 594,
  orientationType: angle === 90 ? 'landscape-primary' : 'landscape-secondary',
  orientationAngle: angle,
  landscapeMedia: true,
  ...patch,
});

test('finds the 84-point column on the folded outer display', () => {
  const geo = D.measureColumn(settings(), folded());
  assert.equal(geo.reason, 'column');
  assert.equal(geo.width, 84);
  assert.equal(geo.side, 'right');
  assert.equal(geo.right, true);
  assert.equal(geo.left, false);
  assert.equal(geo.media, true);
  assert.equal(geo.duo, true);
});

test('measures the column in CSS pixels when the page starts zoomed out', () => {
  // A page with initial-scale=0.5 is laid out twice as wide.
  const geo = D.measureColumn(settings(), folded({ layoutWidth: 764, visualWidth: 764, scale: 0.5 }));
  assert.equal(geo.reason, 'column');
  assert.equal(geo.width, 168);
});

test('follows Display Zoom, which shrinks the screen in points but keeps its shape', () => {
  const geo = D.measureColumn(settings(), folded({ screenWidth: 414, screenHeight: 602, layoutWidth: 340, visualWidth: 340 }));
  assert.equal(geo.reason, 'column');
  assert.equal(geo.width, 74);
});

test('stands aside on the unfolded inner display, where Safari has no column', () => {
  // The screen still reports the outer display; the page is wider than it.
  const geo = D.measureColumn(settings(), folded({ layoutWidth: 700, visualWidth: 700 }));
  assert.equal(geo.reason, 'no-column');
  assert.equal(geo.width, 0);
});

test('stands aside when the page fills the outer display', () => {
  const geo = D.measureColumn(settings(), folded({ layoutWidth: 466, visualWidth: 466 }));
  assert.equal(geo.reason, 'no-column');
});

test('stands aside when the leftover width is not a column Safari would draw', () => {
  const geo = D.measureColumn(settings(), folded({ layoutWidth: 300, visualWidth: 300 }));
  assert.equal(geo.reason, 'unexpected-width');
  assert.equal(geo.width, 0);
});

test('ignores other iPhones', () => {
  const geo = D.measureColumn(settings(), folded({ screenWidth: 402, screenHeight: 874, layoutWidth: 402, visualWidth: 402 }));
  assert.equal(geo.reason, 'not-duo');
  assert.equal(geo.width, 0);
});

test('ignores iPads, whose proportions are close but whose scale is 2x', () => {
  const geo = D.measureColumn(settings(), folded({ screenWidth: 820, screenHeight: 1180, dpr: 2, layoutWidth: 736, visualWidth: 736 }));
  assert.equal(geo.reason, 'not-duo');
});

test('uses the screen size from the app when Safari hides the real one', () => {
  const hidden = folded({ screenWidth: 390, screenHeight: 844 });
  assert.equal(D.measureColumn(settings(), hidden).reason, 'not-duo');
  const geo = D.measureColumn(settings({ device: { screenWidth: 466, screenHeight: 678, scale: 3 } }),
    { ...hidden, device: { screenWidth: 466, screenHeight: 678, scale: 3 } });
  assert.equal(geo.reason, 'column');
  assert.equal(geo.width, 84);
});

test('force mode simulates the column on any device', () => {
  const env = folded({ screenWidth: 402, screenHeight: 874, layoutWidth: 402, visualWidth: 402 });
  const geo = D.measureColumn(settings({ force: true, forceColumn: 90 }), env);
  assert.equal(geo.reason, 'column');
  assert.equal(geo.width, 90);
  assert.equal(geo.duo, false);
});

test('keeps its previous answer while the user is pinch-zoomed in', () => {
  const geo = D.measureColumn(settings(), folded({ visualWidth: 190, scale: 2 }));
  assert.equal(geo.zoomed, true);
  assert.equal(geo.reason, 'zoomed');
});

test('leaves desktop-layout pages alone unless asked', () => {
  for (const meta of [null, 'width=980', 'width=1024, user-scalable=yes', '']) {
    const env = folded({ meta, layoutWidth: 980, visualWidth: 980, scale: 382 / 980 });
    assert.equal(D.measureColumn(settings(), env).reason, 'desktop-layout', `meta ${JSON.stringify(meta)}`);
  }
  const env = folded({ meta: null, layoutWidth: 980, visualWidth: 980, scale: 382 / 980 });
  const geo = D.measureColumn(settings({ desktopPages: true }), env);
  assert.equal(geo.reason, 'column');
  assert.equal(geo.width, 215.5);
});

test('treats device-width, narrow fixed widths and scale-only metas as mobile layouts', () => {
  for (const meta of ['width=device-width', 'WIDTH = device-width; initial-scale=1', 'initial-scale=1', 'width=375, initial-scale=1']) {
    const env = folded({ meta });
    assert.equal(D.measureColumn(settings(), env).reason, 'column', `meta ${JSON.stringify(meta)}`);
  }
});

test('stays off when Reduce Transparency makes the column opaque', () => {
  assert.equal(D.measureColumn(settings(), folded({ reducedTransparency: true })).reason, 'reduced-transparency');
});

test('landscape with the column on the right extends backgrounds only, unless the side is set', () => {
  const auto = D.measureColumn(settings(), landscape(270));
  assert.equal(auto.reason, 'column');
  assert.equal(auto.landscape, true);
  assert.equal(auto.side, 'right');
  assert.equal(auto.width, 84);
  assert.equal(auto.media, false);
  const chosen = D.measureColumn(settings({ landscapeSide: 'right' }), landscape(270));
  assert.equal(chosen.reason, 'column');
  assert.equal(chosen.media, true);
});

test('landscape with the column on the left can’t be painted under, so it stays off', () => {
  assert.equal(D.measureColumn(settings(), landscape(90)).reason, 'start-side');
  assert.equal(D.measureColumn(settings({ landscapeSide: 'left' }), landscape(270)).reason, 'start-side');
});

test('reads landscape from the media query when the Screen Orientation API is missing', () => {
  const geo = D.measureColumn(settings(), landscape(270, { orientationType: '' }));
  assert.equal(geo.landscape, true);
  assert.equal(geo.reason, 'column');
});

test('right-to-left pages are off in portrait and on with the column on their end side', () => {
  assert.equal(D.measureColumn(settings(), folded({ rtl: true })).reason, 'start-side');
  const geo = D.measureColumn(settings({ landscapeSide: 'left' }), landscape(90, { rtl: true }));
  assert.equal(geo.reason, 'column');
  assert.equal(geo.left, true);
});

test('sameGeometry notices changes that need a fresh layout', () => {
  const a = D.measureColumn(settings(), folded());
  assert.equal(D.sameGeometry(a, D.measureColumn(settings(), folded())), true);
  assert.equal(D.sameGeometry(a, D.measureColumn(settings(), folded({ layoutWidth: 381, visualWidth: 381 }))), false);
  assert.equal(D.sameGeometry(a, D.measureColumn(settings({ landscapeSide: 'right' }), landscape(270))), false);
  assert.equal(D.sameGeometry(a, null), false);
});

test('site switches: built-in exclusions can be overridden, user choices stick', () => {
  const host = D.EXCLUDED_SITES[0];
  let s = settings();
  assert.equal(D.siteState(s, host), 'excluded');
  assert.equal(D.siteState(s, 'example.com'), 'on');
  s = { ...s, ...D.sitePatch(s, host, true) };
  assert.equal(D.siteState(s, host), 'on');
  s = { ...s, ...D.sitePatch(s, host, false) };
  assert.equal(D.siteState(s, host), 'excluded');
  s = { ...s, ...D.sitePatch(s, 'example.com', false) };
  assert.equal(D.siteState(s, 'example.com'), 'off');
  s = { ...s, ...D.sitePatch(s, 'example.com', true) };
  assert.equal(D.siteState(s, 'example.com'), 'on');
  assert.deepEqual([...s.disabledSites], []);
  assert.deepEqual([...s.enabledSites], []);
});
