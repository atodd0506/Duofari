# Duofari design

Duofari is a Safari Web Extension for iPhone Duo. It makes web pages behave like
Apple's own apps on the Duo: **header bars, hero art and full-width images extend
under Safari's side column, and text and controls stay clear of it.** The model is
the App Store's "Great Apps on iPhone Duo" story.

## 1. Where the column is and what Safari does with it

Research as of 2026-10-23, from simulator measurements, WebKit source and Apple
forum answers (sources are in the README):

| Pose | Screen (pt) | Safari layout viewport | Side column |
|---|---|---|---|
| Folded, portrait (outer display) | 466 × 678 | 382 × 580 | 84 pt, right edge |
| Folded, landscape | 678 × 466 | ~594 wide | 84 pt, left **or** right depending on rotation (unconfirmed) |
| Unfolded, full screen (inner display) | 951 × 669 / 669 × 951 | full width | none: Safari disables the vertical bar at regular width |
| Unfolded, Split View | ~469 pt pane | unmeasured | probably on the pane's outer edge |

- Safari treats the column as an **obscured content inset**, not a safe area.
  `env(safe-area-inset-right)` is 0, `viewport-fit=cover` changes nothing, and
  the layout viewport stops at the column.
- The web view itself extends under the column. Content that overflows the
  layout viewport *is* painted there, and Safari's controls turn to glass over
  it (see Mike Piontek's screenshots). The cost is that the page becomes
  horizontally scrollable by the column width.
- Safari tints the column with a colour sampled from the page. A `fixed`/`sticky`
  box that covers the right-edge midpoint and spans ≥ 90 % of the viewport
  height makes Safari paint an opaque fill *over* the column.
  (`LocalFrameView::fixedContainerEdges`.)
- `screen.width × screen.height` is 466 × 678 in every pose, including unfolded.
  No other iPhone has this screen size. There is no web API for the column.
- WebKit fits a page to its content width when the viewport meta has no
  `initial-scale` (`ViewportConfiguration::initialScaleFromSize`). Without care,
  widening the content would zoom such pages out.

## 2. Strategy: keep Safari's layout, widen the backgrounds, hold the page still

Duofari never changes the layout viewport and never moves text. It selects
elements whose **background or pixels** belong under the column and enlarges
only their *painted box* by exactly the column width, keeping each one's content
box where it was. Then it stops the page from drifting sideways.

### 2.1 Detecting the column (`geometry.js`)

```
isDuoScreen = {min, max}(screen.width, screen.height) == {466, 678}  (±1)
layoutW     = documentElement.clientWidth   (body.clientWidth in quirks mode)
scale       = visualViewport.scale          (only while not pinch-zoomed)
screenW     = portrait ? min(screen) : max(screen)
columnPt    = screenW − layoutW × scale
column(css) = columnPt / scale     if 40 ≤ columnPt ≤ 140, else 0
side        = portrait → right;  landscape → both (see below)
```

- Unfolded: `layoutW × scale` (951 or 669) exceeds `screenW`, so the column is 0
  and Duofari stays off.
- **Landscape, side unknown:** Duofari bleeds both edges. Bleed on the side
  without a column lands off-screen. Off-screen bleed on the left is negative
  overflow, which can't be scrolled to; on the right it adds overflow that the
  drift guard holds still. The user can pin a side in settings.
- "Desktop" pages (layout wider than the screen, `scale < 0.95`) are skipped by
  default, as Widen and OutSpan do. A setting can include them.
- Recomputed on `resize`, `visualViewport` resize (ignoring pinch-zoom),
  `orientationchange`, and fold/unfold. Fold and unfold fire several resizes
  through intermediate sizes, so recomputation is debounced.
- `force` setting: treat any device as a Duo with a given column, for testing.

### 2.2 Choosing what bleeds (`classify.js`)

An element can only bleed into the right column if it touches the right edge of
the layout viewport. So Duofari walks a **right-edge spine**: from `<body>` it
descends only into elements whose border box reaches the right edge
(`right ≥ layoutW − 1.5`) and prunes everything else. Left bleed uses the mirror
test. The walk also prunes:

- elements that render nothing (`display: none`, `display: contents` is walked
  through, zero size, `visibility: hidden`);
- subtrees entirely outside a window of 2 viewport heights above to 4 below the
  current scroll position (far content is classified when it scrolls near);
- `<svg>` internals, form controls, `<iframe>`, `<object>`, `<embed>`.

It also descends into **open shadow roots**.

The walk visits at most 6,000 elements per scan.

Each visited element is classified:

| Class | Rule | Treatment |
|---|---|---|
| **band** | Spans the full width (`left ≤ 1.5`, `right ≥ layoutW − 1.5`) and paints a background that differs from what is behind it: a colour with alpha ≥ 0.05 that differs from the page background, any `background-image`, or a `border-top`/`border-bottom`/`box-shadow` line. | Extend its box (§2.3). |
| **media** | `img`, `video` without `controls`, `canvas`, or `picture > img`, spanning the full width, at least 120 px tall, and not `object-fit: contain`/`scale-down`. | Widen with fill or mirror (§2.4). |
| **inset media** (optional, default on) | `img`/`picture`/`video` that is not full width but is ≥ 85 % of a full-width, plain container. Plain means no background, border, shadow, radius, transform or clipping between them, and the element has no inline siblings. Its container is ≥ 80 % of the layout width. | Break out to the full screen width (§2.4). |
| **clipper** | Not a band or media, but it clips (`overflow ≠ visible`, `contain: paint`, `clip-path`, `mask`) and has a band/media descendant. | Extend its box with padding so descendants can paint beyond it. |
| **plain** | Anything else on the spine (wrappers). | Nothing. The walk continues into it. |

Never treated (subtree skipped): `html`, `body`, elements with
`background-clip: text`, `border-image`, `position: fixed` boxes covering ≥ 90 %
of the viewport height (Safari would paint an opaque fill over the column),
and anything already wider than the viewport by a non-column amount
(carousels, broken layouts).

### 2.3 Extending a box without moving its content (`bleed.js`)

Every change is an inline `!important` declaration. Inline styles reach into
shadow roots and beat ordinary site CSS. The original inline value and
priority are saved so each change can be reverted exactly. For a right bleed of
`C` px, recipes are tried in order:

1. **Padding recipe** (best fidelity): `margin-right: m − C; padding-right: p + C`.
   On an auto-width block, flex item or abspos box with `left`/`right` set, the
   content box is unchanged and the border, padding and clip boxes grow by `C`.
   The background repaints at the new size, top/bottom borders run through, and
   descendants may paint into the new area.
2. **Border recipe**: `margin-right: m − C; border-right: C solid transparent;
   background-clip: border-box; background-origin: border-box`. The padding box,
   and with it the containing block of absolutely positioned children, is
   untouched.
3. **Width compensation**: if the content box moved, the element has an
   explicit width and/or `box-sizing: border-box`. Retry recipe 1 or 2 with
   `width: w + C; max-width: none` (and `min-width` as needed).

**Verify after each attempt.** Re-measure and accept only if all hold:
- the border box now ends at `layoutW + C` (±1);
- the content box is unchanged (±0.5 px) and the height is unchanged;
- every absolutely positioned descendant (first 400) has the same rect.

If no recipe passes, everything is reverted and the element is marked rejected
for this layout.

Candidates are processed **top-down in document order**. Parents settle before
children are measured, and a child of an extended band naturally reaches
`layoutW` in its parent's unchanged content box, so it can be extended in turn
(for example a hero `<img>` inside a header). **Clippers** use only recipe 1,
because they must widen their clip box, and they are applied lazily when a
descendant needs them.

Left bleed is the mirror image (`margin-left`/`padding-left`/`border-left`).

### 2.4 Media

- **Fill (default):** `width: w + C; height: h; max-width: none;
  object-fit: cover` plus the margin shift. The page's height never changes, and
  the image is cropped ≈ 9 % top and bottom. The site's `object-position` is
  respected.
- **Grow:** keep the aspect ratio, so the height grows. This is used for
  break-out (inset) images, which are content photos where cropping 25 % would
  hurt. If the element is above the viewport, the height change is compensated
  with `scrollBy`, because Safari has no scroll anchoring.
- **Mirror (setting):** the image keeps its size. `-webkit-box-reflect:
  right|left 0` paints a mirrored copy into the column, like Apple's
  `backgroundExtensionEffect`. A 1 px invisible spacer makes sure the document's
  scrollable area covers the column, so the root tiles exist there.
- Interactive media are not touched: `video[controls]`, `<iframe>` players and
  maps all keep their controls out of the column.

### 2.5 Holding the page still (`guard.js`)

Bleed makes the document `C` px wider than the layout viewport. Duofari takes
three measures:

1. `touch-action: pan-y pinch-zoom` on `<html>` while not zoomed in. The root
   can't be panned sideways, but nested scrollers (carousels) keep working,
   because effective touch-action resets at scroll containers. Pinch zoom still
   works. Once the user zooms in (`visualViewport.scale` > base × 1.02), the
   restriction is lifted so the zoomed page can be panned.
2. A capture-phase `scroll` listener. If the root scroller (window, or `<body>`
   when it is the scroller) moves horizontally while not zoomed, it is put back
   at the rest position. During an active touch this waits for `touchend`, so
   it doesn't fight momentum. This only happens when the page had no horizontal
   overflow of its own before Duofari.
3. `overscroll-behavior-x: none` on `<html>`.

**Viewport meta:** if the page's viewport meta has `width=device-width` and no
`initial-scale`, Duofari appends `initial-scale=1`. Otherwise WebKit's
fit-to-content rule would zoom the page out by 382/466. Duofari never adds
`viewport-fit`, `maximum-scale` or `user-scalable`.

### 2.6 Keeping up with the page (`main.js`)

- **Scans are incremental.** Applied elements are re-verified (still full width
  in their own content box? still the same class?) and reverted if not. New
  spine elements are classified. A scan with nothing to change costs one
  layout plus rect reads.
- **Triggers.** Scans are throttled to at most one every 300 ms, with a trailing
  run. They are triggered by:
  - `MutationObserver` (childList; `class`/`style`/`src`/`srcset`/`hidden`/`open`
    attributes), with records caused by Duofari's own writes discarded;
  - `load` events of media (capture);
  - a `ResizeObserver` on extended elements, with an expected-size guard;
  - `document.fonts.ready`;
  - scroll, throttled, for the scan window;
  - SPA URL changes;
  - settings changes.
- **Back-off.** If a site keeps undoing Duofari's styles on an element, the
  element is reverted. This is triggered by more than 6 re-applies in 10 s,
  after Dark Reader's pattern.
- **Off switch.** On global disable, a per-site disable, or a column of 0,
  Duofari reverts every change and the spacer. It removes the guard and
  restores the viewport meta.

### 2.7 Settings (popup)

Settings are stored in `storage.local`:
- Enabled (global).
- Disabled sites (per hostname).
- Extend header bars and backgrounds.
- Extend images.
- Break images out of page margins.
- Image style: Fill / Mirror.
- Side in landscape: Auto (both) / Left / Right.
- Include desktop-layout pages.
- Debug outline: shows the detected column and marks extended elements.

The popup also shows live status for the current tab: column detected, width
and side, and the number of extended elements. It gets this through
`tabs.sendMessage` to the content script.

## 3. Packaging

- `extension/` holds the Manifest V3 web extension. It has content scripts in
  plain ES2020 (no bundler) sharing one `Duofari` namespace in the isolated
  world, a popup, `storage`, and no background script. It runs on all
  http/https pages at `document_idle`. It is top frame only, because iframes
  can't reach the column.
- `apple/` holds the Xcode project: an iOS app with a Safari Web Extension
  target, structured like Apple's WWDC26 sample. It can be generated two ways:
  - `apple/project.yml`, through XcodeGen;
  - `xcrun safari-web-extension-packager`, through `scripts/package-xcode.sh`.
- `scripts/zip-for-app-store-connect.sh` builds the zip for App Store Connect's
  web packager (no Mac needed).

## 4. Testing

The tests run the content scripts in headless Chromium through Playwright:
- They emulate the Duo outer display: viewport 382 × 580, `screen` 466 × 678,
  DPR 3, mobile, touch.
- A full-page screenshot captures the overflow under the column. A simulated
  Safari column is composited on top to preview the result.

The suite has three parts:
- **Fixtures:** App Store story, blog, news, docs, landing page, sticky and
  fixed headers, clipping wrappers, `box-sizing` and explicit-width cases,
  absolutely positioned header buttons, SPA insertion, RTL, carousels, cards,
  shadow DOM, and video with controls.
- **Invariants checked on every fixture and on live sites:**
  - No text node or form control moves horizontally and none enters the column.
  - Expected elements bleed by exactly `C`.
  - The guard snaps programmatic horizontal scroll back.
  - Nothing happens on a non-Duo screen, unfolded, or with desktop layouts.
  - Disabling reverts the DOM to byte-identical inline styles.
- **Live sites** (when network allows), checked against the same invariants.
