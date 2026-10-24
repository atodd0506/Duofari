# Duofari design

Duofari is a Safari Web Extension for iPhone Duo. On the folded outer display,
Safari keeps its controls in an 84-pt column on the right, and the page stops
at that column. Duofari makes web pages treat the column the way Apple's own
apps do: **header bars, hero art and full-width images extend under the
column, and text and controls stay where they were.**

Apple describes the same split for native apps: "You can also combine both
approaches, letting a background image or header span the full width while
scrollable content stays inset" (HIG, Designing for iPhone Duo). None of
Apple's iPhone Duo design and developer pages (the HIG page, the Prepare page,
Tech Talks 111461 and 111466) mention Safari or web content.

This document describes the v2 engine in `extension/`. The code is the source
of truth. Constants are quoted from it with their values.

> **Status.** Everything here was checked in Playwright/Chromium emulation of
> the folded Duo and against WebKit source and published simulator
> measurements. Nothing has been checked on iPhone Duo hardware. Painting under
> the column, the lift of fixed bars, Safari's opaque fill over the column and
> touch behaviour all need a device or the Xcode 27.1 Simulator.
> `test/device/index.html` is the page for that (see [Testing](#4-testing)).

## 1. Where the column is and what Safari does with it

Research as of 2026-10-23. Every Safari number comes from the Xcode 27.1
Simulator. No hardware measurements had been published on launch day. Labels:

- **VERIFIED**: read in an Apple or WebKit primary source.
- **SUPPORTED**: a third-party measurement or report says so.
- **SOURCE**: read in WebKit's `main` branch during the design reviews. Not
  observed in Safari.
- **UNVERIFIED**: open. Duofari either handles every outcome or stays off.

| Pose | Screen (pt) | Safari layout viewport (CSS px) | Side column | Status |
|---|---|---|---|---|
| Folded, portrait (outer display) | 466 × 678 @3x | 382 × 580 | 84 pt, right edge | SUPPORTED (4 or more sources) |
| Folded, landscape | 678 × 466 | 678 × 340 (fold-ready, no column), or 594 wide if the native 84-pt column applies (Crosley, native probe) | probably 84 pt, left **or** right depending on rotation | UNVERIFIED |
| Unfolded, full screen (inner display) | 951 × 669 / 669 × 951 | full width: 951 × 543 or 951 × 589 in landscape, 669 × 825 in portrait | none | VERIFIED (Apple engineer) and SUPPORTED |
| Unfolded, Split View | native pane about 469 pt wide | not measured | unknown | UNVERIFIED |

The Screen column is each display's logical size. Pages see `screen` as
466 × 678 in every pose (see below).

- **The column is not a safe area.** With `viewport-fit=cover`, fold-ready
  measured `env(safe-area-inset-*)` as 0/0/0/0 on the folded display in
  portrait (SUPPORTED, single source). WebKit computes `env()` as the safe area
  minus the *obscured* insets (VERIFIED, `WKWebViewIOS.mm`). A right inset of 0
  therefore fits Safari reporting the column as an obscured content inset
  (inference). The layout viewport stops at the column either way.
- **Pages can paint under it.** Content that overflows the layout viewport to
  the right is drawn under the column, and Safari's buttons sit over it as
  glass (SUPPORTED: Mike Piontek's simulator screenshots, checked visually).
  The cost is that the page becomes horizontally scrollable by the column
  width (SUPPORTED: Piontek, Widen, OutSpan).
- **Only toward the end edge.** WebKit clamps layout overflow on the
  document's start side (`RenderBox::addLayoutOverflow`, SOURCE). A
  left-to-right page can reach under a column on its right, not one on its
  left. A right-to-left page is the mirror image.
- **Safari tints the column from the page.** It ignores `theme-color` and
  samples fixed or sticky elements at the right edge. An 8-px `position: fixed`
  full-height strip tints the whole column. A 1-px line does not. A fixed top
  bar is cut off at the column (SUPPORTED: Piontek, fold-ready).
- **Safari can paint an opaque fill over the column.** WebKit's edge sampler
  (`LocalFrameView::fixedContainerEdges`) uses `sampleRectMargin = 4`,
  `thinBorderWidth = 10` and length ratios of 0.9 and 1.05. Colours below 0.75
  alpha are blended with the page background (VERIFIED). When a fixed or sticky
  container qualifies, WebKit places one solid-colour view over the full height
  of that inset (VERIFIED, `WKWebView.mm`). That view would hide anything
  painted under it (inference). The review also found a "sidebar" path for
  fixed or sticky boxes at least 90 % as wide as the viewport but shorter than
  90 % of its height, a path for dimming
  layers and `::backdrop`, and that WebKit keeps the last container it found
  while that container stays rendered (SOURCE).
- **A second possible cover.** WebKit commit 318137@main hides page colours
  and content in the *leading* obscured inset while the page is at its scroll
  origin. It is gated on `HorizontalBannerViewOverlaysEnabled`, whose value in
  shipping Safari is unknown (commit VERIFIED, effect UNVERIFIED).
- **Fixed elements are clipped at the column.** WebKit clips the composited
  layer of a `position: fixed` element to the layout viewport, unless the
  layer is transformed (`RenderLayerBacking`, SOURCE). That explains the
  cut-off fixed top bar above. Sticky elements are clipped to the document
  rect instead, which includes the overflow (SOURCE).
- **`screen` reads 466 × 678 in every pose, including unfolded** (SUPPORTED:
  Crosley natively, fold-ready in Safari). Its aspect ratio, about 1.455, is
  unlike any other iPhone's. There is no web API for the column. Apple's
  answer to "can a page detect iPhone Duo" is "No", and Viewport Segments and
  Device Posture are off-by-default feature flags in iOS 27.1 (VERIFIED).
- **Folding fires several resizes.** `resize` fires 2–3 times through
  transient sizes such as 466 × 498 and 382 × 498. The page does not reload,
  and there is no posture event (SUPPORTED, fold-ready).
- **Viewport units.** On the folded display `100vh` and `100lvh` are 598, and
  `100dvh` and `100svh` are 580 (SUPPORTED). Whether `100vw` includes the
  column in Safari is unknown. Firefox for iOS notes that it can in its own
  WKWebView set-up (SUPPORTED). Duofari measures it at runtime (§2.6).
- **Zoom.** WebKit fits a page to its content width when the viewport meta has
  no `initial-scale`. It also lets the minimum scale follow the content width
  down (`ViewportConfiguration`, SOURCE). Content that reaches under the
  column would otherwise let such pages zoom out to 382 / 466 ≈ 0.82.
- **Touch.** WebKit resets the effective `touch-action` to `auto` at any
  element whose computed `overflow-x` or `overflow-y` is `auto` or `scroll`,
  whether or not it scrolls (`StyleAdjuster`, SOURCE). That includes
  `body { overflow-x: hidden }`, whose other axis computes to `auto`.
- **Reduce Transparency.** Apple says a vertical bar "does have a background
  when the reduced transparency accessibility setting is enabled" (VERIFIED,
  Tech Talk 111462, native apps). Whether Safari's column does the same, and
  whether Safari exposes `prefers-reduced-transparency`, is UNVERIFIED.
- **Live Activities** expand the Dynamic Island vertically (VERIFIED). How much
  of Safari's column that covers is UNVERIFIED.
- **Scrolling.** The Safari 27 release notes list "Enabled scroll anchoring"
  and a fix on iOS for `scrollTo` interrupting momentum scrolling (VERIFIED).

## 2. Strategy: keep Safari's layout, widen the backgrounds, hold the page still

Duofari never changes the layout viewport. Media queries, `vw` units and the
page's own layout resolve exactly as before. Duofari picks elements whose
background or pixels belong under the column. It grows only their *painted
box* by the column width `C`, toward the page's end edge, and keeps each
content box where it was. It measures every change and rolls it back if
anything else moved. Then it stops the page from drifting sideways.

The content scripts run at `document_idle`, in the top frame only, in this
order. They share one `globalThis.Duofari` object in the extension's isolated
world:

| File | Job |
|---|---|
| `shared-settings.js` | Defaults, built-in excluded web apps, per-site on/off, storage helpers. The popup loads it too. |
| `content-geometry.js` | Is there a column, how wide is it, which side is it on. |
| `content-bleed.js` | Extends one element, verifies the result, reverts exactly. |
| `content-classify.js` | Walks the page and decides what to extend. |
| `content-guard.js` | Holds the page still horizontally. |
| `content-main.js` | The controller: when to run, viewport meta, observers, answers to the popup. |

Every content script except `shared-settings.js` returns early when
`Duofari.controller` already exists, and `shared-settings.js` only redefines
its constants and helpers, so injecting them a second time (the popup does
this, §2.8) is harmless.
`content-main.js` also stops in frames (`top !== self`). In a non-HTML
document (an SVG or XML file shown on its own) it changes nothing and only
answers the popup's status request, with the reason `unsupported-document`
(§2.8).

### 2.1 Detecting the column (`content-geometry.js`)

```
if visualViewport.width < layoutWidth − 1                → 'zoomed' (the controller decides, §2.7)
short, long = min/max(screen.width, screen.height)
duo   = |long / short − 678/466| < 0.03  and  devicePixelRatio ≥ 2.5
        else the same test on the screen size stored by the app (below)
if !duo and !force                                       → 'not-duo'
landscape   = screen.orientation.type contains 'landscape'
              (fallback: matchMedia('(orientation: landscape)'))
screenAlong = landscape ? long : short
if matchMedia('(prefers-reduced-transparency: reduce)')  → 'reduced-transparency'
if desktop layout and !desktopPages                      → 'desktop-layout'
columnPt = screenAlong − layoutWidth × visualViewport.scale     (forced, not a Duo: forceColumn, default 84)
if columnPt < 60                                          → 'no-column'
if columnPt > 110                                         → 'unexpected-width'
side = portrait ? right
     : landscapeSide setting if 'left' or 'right'
     : Auto → angle 90 ? left : right, and no images (media = false)
if side is not the page's end edge (right for ltr, left for rtl) → 'start-side'
C = columnPt / scale     (CSS px, rounded to 0.01)
```

`layoutWidth` is `documentElement.clientWidth` (`body.clientWidth` in quirks
mode). The constants are `DUO_ASPECT = 678 / 466`, `MIN_COLUMN = 60` and
`MAX_COLUMN = 110` points.

Why it is built this way:

- **Shape, not size.** Display Zoom changes the screen size in points but keeps
  its proportions, so Duofari matches the aspect ratio. The 2.5 scale floor
  rules out iPads (2x), whose proportions come close.
- **Native fallback.** Safari's Advanced Fingerprinting Protection (on by
  default in Private Browsing) reports a generic screen size. `background.js`
  calls `browser.runtime.sendNativeMessage('application.id', { type: 'device' })`
  on install, on startup and whenever the popup opens. `SafariWebExtensionHandler`
  in the extension target answers with `UIScreen.main`'s size, `scale`,
  `nativeScale` and the hardware model. `background.js` stores the
  `screenWidth`, `screenHeight`, `scale` and `model` as `device` in
  `storage.local`. Every open tab starts over from the page's own layout when
  `device` changes, so it writes only when one of them differs from what is
  stored. The content scripts use `device` when `screen` doesn't look like a
  Duo.
- **Unfolded.** `layoutWidth × scale` (951 or 669) is larger than the screen's
  side, so `columnPt` is negative and the reason is `no-column`. Duofari is idle
  on the inner display at full screen, as Safari has no column there.
- **A window, not 84.** Safari's column measured 84 in every web measurement,
  but Duofari always measures. 60–110 pt accepts small variations and rejects
  leftover widths that can't be Safari's column.
- **Pinch zoom.** While the visual viewport is narrower than the layout
  viewport the arithmetic doesn't hold. The controller changes nothing until
  the user zooms back out, unless Duofari is switched off meanwhile (§2.7).
  The scale at rest still enters the formula, so a page that starts zoomed
  out gets the right `C` in CSS px.
- **Desktop layout** is read from the last viewport meta. No meta means
  desktop. A meta without `width=` means desktop unless it has `initial-scale`.
  `width=device-width` is mobile. A numeric width is desktop only when it is
  wider than the screen's side plus 1. v1 used `scale < 0.95` instead, which
  misfired under Safari's page zoom.
- **Landscape side.** Which side the column is on in landscape is unconfirmed.
  The Auto guess is that Safari keeps its controls beside the outer camera,
  which ends up on the left at angle 90. Because the guess may be wrong, Auto
  (`media = false`, which the scan passes on as `pictures: false`) extends
  only background colours and gradients in landscape. No picture is rescaled
  or moved:
  - `<img>` and `<video>` are not extended, and nothing breaks out;
  - with the border recipe, every `url()` background layer keeps its
    `background-origin`, so only the colour around it extends;
  - layers and pseudo-elements that draw a picture (an image, a video, a
    `url()` background) are not cover layers (§2.3), so they keep their
    place: the padding recipe pins such a layer back instead of growing or
    revealing it, and doesn't pass if such a pseudo-element moves;
  - a band or a clipper with its own `url()` background doesn't take the
    padding recipe, so such a clipper isn't opened.

  A wrong guess then has no visible cost: background overflow on the far side
  lands off-screen and the guard holds it still, while widened images would
  have been cropped for nothing. Picking Left or Right in the popup turns
  images back on.
- **Start side.** Pages can only paint toward their end edge (§1). Two cases
  stay off: right-to-left pages with the column on the right (portrait, and
  landscape right), and left-to-right pages with the column on the left. A
  right-to-left page with the column on the left extends leftward through the
  mirrored code path. A unit test covers its geometry, and the
  `rtl-landscape-left` and `rtl-landscape-left-pinned` fixture cases cover
  the extensions.

`measureColumn` returns a `reason`, and the controller adds its own. The popup
shows them:

| Reason | Popup title |
|---|---|
| `column` | "Extended …" or "On, nothing to extend yet" |
| `not-duo` | Not an iPhone Duo |
| `no-column`, `unexpected-width` | Nothing to extend here |
| `desktop-layout` | Desktop layout |
| `start-side` | Controls on the wrong side |
| `reduced-transparency` | Reduce Transparency is on |
| `unstable` (controller, §2.7) | Paused on this page |
| `zoomed` (controller, §2.7) | Paused while zoomed in |
| `disabled`, `site-disabled`, `excluded-site` (controller) | Duofari is off / Off for this site / Off for this web app |
| `starting` (controller, before its first run) | Checking this page… |
| `unsupported-document` (non-HTML documents) | Duofari can’t change this kind of page |

### 2.2 Choosing what extends (`content-classify.js`)

Only an element that reaches the layout viewport's end edge can continue under
the column. The scan therefore walks a **spine**. It starts at `<body>`'s
children and descends only into elements whose box touches the edge (or whose
overflow reaches it). Everything else is pruned after one rect read. The walk
is depth-first in document order, so a parent is already extended, with its
content box unchanged, when its children are measured. A child that fills its
parent's content box still ends at `layoutWidth` and can be extended in turn,
for example a hero `<img>` inside a header.

Constants: `TOL = 1.5` px ("touches the edge"), `NEAR = 48` px, `MIN_MEDIA_HEIGHT
= 100` px, `BREAKOUT_MIN_WIDTH = 0.8`, `OVERLAY_HEIGHT = 0.9`, `LEAD_DEPTH = 1.5`
viewport heights, `FRESH_SHARE = 0.25` of a slice.

**The walk.**

- **Budget and passes.** A pass over the page runs in slices of at most 6,000
  visits and 12 ms each (`SCAN_BUDGET`, `SLICE_MS` in `content-main.js`). A
  pass keeps a stack of frames. Each frame is a container's live list of
  children (an open shadow root's come after them) and a position in it, so
  descending into a container costs nothing until the walk gets there. A
  slice cut short returns a cursor (`stats.cursor`). It holds each
  unfinished pass, with its stack, its state (whether the lead image is
  taken, and which breakouts were reverted) and the touch roots it found so
  far, and the layout key and `<body>`. The controller gives the cursor back
  as `ctx.resume` on every run (§2.7), and its resume timer runs one
  `MIN_INTERVAL` later, so the pass goes on where it stopped. It goes on by
  position and skips elements that are no longer in the document. Children
  the page removed before that position shift the rest, and the pass that
  the removal brings covers them.
- **Two passes at once.** Any other run while a pass is unfinished (a
  mutation, a scroll, a load) starts a new pass from the top at once,
  alongside the old one. In each slice the newer pass walks first, for a
  quarter (`FRESH_SHARE`) of the slice's visits and time. In the slice it
  begins in, that time counts from after its start (`beginPass`). The older
  pass then has the rest of the visits, and at least the other three quarters
  of the slice's time from when it takes over, so a slice can run past
  `SLICE_MS` by about as long as the newer pass's start took. A further
  request replaces an unfinished newer pass. When the older pass ends, the
  newer one carries on alone. If the newer one reaches the end first, the
  older one is dropped. Both share the set of reverted breakouts. The guard
  gets the touch roots of both, and those of an older pass that ended stay
  until the newer one ends. The cursor is used only while the layout key
  (layout width, `C`, side and the images flag) and `<body>` are unchanged.
  Reverting everything (turning off, a geometry change, a relayout) drops
  both passes. The debug badge shows "partial" while a slice was cut short.
- **Start of a pass.** Every pass, a newer one included, starts
  (`beginPass`) by reverting any record on an element that has become
  editable (`isContentEditable`): whatever Duofari writes into editable
  content would be saved with it. `<body>` is never walked itself, but it can
  be a clipper Duofari opened, so its record is then checked like any other
  (§2.3, Re-checking). Both happen once per pass, not once per slice.
- **Window.** Elements that end more than 2 viewport heights above the top of
  the visible area, or start more than 4 viewport heights below it, are
  skipped. A scroll of more than half a viewport since the last scan schedules
  a new one.
- **Never entered:** `script`, `style`, `link`, `meta`, `template`, `noscript`,
  `br`, `wbr`, `head`, `title`, `source`, `track`, `area`, `map`, `option`,
  `optgroup`, `datalist`, `param`, `iframe`, `frame`, `frameset`, `object`,
  `embed`, `input`, `select`, `textarea`, `button`, `dialog`, `svg`, `math`,
  `audio`, `slot`, `canvas`; editable content (`isContentEditable`);
  Duofari's own nodes (`data-duofari-ui`); and children Duofari pinned
  (§2.3).
- **Zero-size** elements are skipped, except `display: contents`, which is
  walked through. Open shadow roots are walked, and the controller starts
  observing each one it meets.
- **Edge tests.** For the right edge: *at* means `|right − layoutWidth| ≤ 1.5`;
  *past* means `|right − (layoutWidth + C)| ≤ 1.5`; *near* means within 48 px
  of the edge, used only when breakout can run (§2.4). A box that overflows
  the edge by any other amount (a carousel track, a broken layout) is pruned
  with its subtree. A box that does not reach the edge is still entered when its
  `scrollWidth` does, which finds `width: 100vw; margin-left: calc(50% - 50vw)`
  breakouts inside a narrower article column.
- **Pruned with their subtree:** `display: none`, `visibility: hidden` or
  `collapse`, `opacity: 0`, `checkVisibility({ contentVisibilityAuto: true })`
  false; `position: fixed` boxes at least 0.9 viewport heights tall (menus,
  modals, dimming layers, which Safari's sampler would cover with an opaque
  fill anyway); and transforms other than a plain translation, or the `scale`
  and `rotate` properties, because their rects disagree with layout.
- **Already extended.** An element with a record is re-checked first (§2.3,
  Re-checking). If it still holds, it is entered (media and breakouts have
  nothing to enter). If not, it is reverted and classified again on the spot.
  A record the page restyled is left as it is, and entered, while the
  element, one of its pins or (in a clipper) anything extended inside it
  runs a CSS transition (§2.3, Re-checking).
- **Left as they are, but entered:** boxes that already reach `C` past the edge
  (the site's own `100vw`, or art that grew with an extended parent), elements
  rejected earlier in the same layout (with the same images flag) at the same
  size, elements blocked by the re-apply limit (§2.7), elements with running
  animations (`getAnimations()`), and anchors for CSS anchor positioning
  (`anchor-name` other than `none`), whose anchored boxes would move with
  them.

**Bands.** A *band* is an element that spans the full width (at or past both
edges) and paints a background worth continuing. Header bars, hero sections,
banners and footers are bands. It must not be a replaced element, a table box,
an inline box (except `inline-block`) or match the interactive selector
(`a[href]`, `button`, `input`, `select`, `textarea`, `label`, `summary`,
`video[controls]`, `[role=button]`, `[role=link]`, `[tabindex]`, `iframe`).
"Worth continuing" means:

- any `background-image` (images and gradients), or
- a background colour with alpha ≥ 0.05 that differs from the colour behind it.
  The colour behind it is the nearest ancestor background with alpha ≥ 0.95,
  else the `html`/`body` background, else white. Colours count as equal when the
  RGB channels differ by 6 or less in total and alpha by 0.05 or less.

A border or `box-shadow` line alone does not count. List separators stay inset,
as they do in Apple's apps. `background-clip: text` and `border-image` rule an
element out. The "Header bars and backgrounds" setting (`bands`) turns bands
off.

**Recipe order for bands** (§2.3 explains the recipes):

- horizontal scroll container, or a carousel: border recipe only, because a
  scroll container's padding box is its scrollport;
- an element that clips: padding first, because its clip has to reach into the
  column for its children to show there; then border;
- anything else: border first, so positioned children, pseudo-elements and
  icons keep their padding box; then padding.

A carousel is an element matching a list of common slider classes (Swiper,
Slick, Splide, Embla, Glide, Flickity, Owl, Keen, Bootstrap and FlexSlider,
`[data-carousel]`), or one that snaps sideways: `scroll-snap-type` on `x`,
`both` or `inline` (`block` under a vertical or sideways writing mode). Its
band background may extend, with the border recipe. The walk never enters a
carousel, on any scan and by any path (`display: contents`, overflow that
reaches the edge, a box that is passed over or already extended), so its
slides are never touched. The first time the walk meets a carousel, it
reverts whatever Duofari extended inside it before it became one, except
boxes pinned by an extended box outside it: Slick, Flickity and Owl wrap the
slides when they load. Each carousel is swept once, until it stops being a
carousel (a slider torn down at a breakpoint is walked again).

**Scroll containers.** The walk does not descend into an element that actually
scrolls (overflow `auto` or `scroll` with content larger than the box), so
carousels, tab strips and code blocks keep their own layout. (A scroller that
isn't a carousel and whose box stops short of the edge is still entered when
its content reaches the edge, see Edge tests.) The exception is a page-sized
scroller: full width and at least 0.6 viewport heights tall. That is an app
shell scrolling instead of the document. Duofari walks into it. If
it scrolls only vertically, Duofari also registers it with the guard so it is
held still too (§2.5). One that scrolls sideways itself, such as a page-sized
kanban board, keeps its own scroll position. A shell that snaps up and down
(`scroll-snap-type: y`) is not a carousel: it is entered, registered and
touch-locked like any other, and its sections extend. Elements on the spine
whose computed overflow is `auto` or `scroll` but which do not scroll
sideways are collected by each pass as **touch roots** for the guard,
together with `html` and `body`.

**Clipping ancestors.** Before anything is extended, every ancestor that would
clip it gets the padding recipe, so the clip reaches into the column too.
Ancestors are followed by containing block: an absolutely positioned box
escapes clippers below its containing block, and a fixed box escapes everything
up to a transformed ancestor. `html` never counts. `body` counts only when
`html`'s own overflow is not `visible`, because otherwise `body`'s overflow is
propagated to the viewport. This handles the common `html, body { overflow-x:
hidden }`, where `body` really clips. A clipper that is an anchor
(`anchor-name`) is never opened.

If a clipper cannot be opened, the element is not extended either. It is not
rejected, though: it is tried again on later scans. What a clipper hides past
the edge (a menu that is open) can go away again, so the failure is
remembered per clipper (`unopened`), keyed to the layout (layout width, `C`,
side and the images flag), the clipper's `clientWidth` (its padding box,
which a band's border recipe leaves alone) and its `scrollWidth`. Retries
cost almost nothing until one of these changes. A clipper that is already a
band extended with the border recipe is reverted and extended again with the
padding recipe; the `unopened` key is checked before that revert. If the
band can't be opened, its own recipe goes back on at once, and a lifted band
keeps its lift either way. When opening the clippers makes the element itself
wider (a backdrop at `inset: 0` that fills one), it already reaches into the
column and is left as it is.

**Inner scrollers.** After an extension, Duofari checks the nearest ancestor
with `overflow-x: auto` or `scroll`. If its horizontal scroll range grew by
more than 1 px, the extension is reverted. Otherwise an app shell or a list
would become scrollable sideways by `C`, which the guard would not see.

**Fixed bands are lifted.** Because WebKit clips a fixed element's layer to the
layout viewport unless it is transformed (§1), a band with `position: fixed`
gets an identity `translate: 0px 0px`. A transform also makes the element the
containing block of its fixed descendants, which would trap a slide-out menu
inside the header. The lift is therefore added only when the band has no
transform and no `position: fixed` descendant. Bands with more than 300
descendants count as having one, since checking them is too costly. Duofari
checks again after every batch of DOM changes and takes the lift off when a
fixed descendant appears.

The lift would also hide a `translate` the page gives the band later and stop
its transition. A restyle of a lifted band therefore takes the lift off when
one of the band's transitions animates `translate` (its own entry or `all`,
with a duration above 0) and the page now actually brings in a translate of
its own. Duofari reads that with the lift off for a moment, inside
`withoutTransitions` with `keepRunning` (§2.3), so the page's running
transitions carry on. The class and style it last checked are remembered, so
the echo of its own writes is skipped. The band is measured again on the next
scan and is lifted again only if it has no translate of its own. Whether the
lift makes the bar paint under Safari's column is unverified on a device.

Media are covered in §2.4.

### 2.3 Extending a box without moving its content (`content-bleed.js`)

Constants: `EPS = 0.75` px, `EDGE_EPS = 1.25` px, `HIDDEN_SCAN_LIMIT = 12000`
nodes, `ABS_SCAN_LIMIT = 12000` nodes, `ABS_KEEP_LIMIT = 400` positioned
boxes, `LATE_SCAN_LIMIT = 2000` nodes, `LATE_QUEUE_LIMIT = 20` elements per
box, `LATE_LOOK_LIMIT = 200` elements, `NEAR_PSEUDO_LIMIT = 8` children (and
8 grandchildren).

**Bookkeeping.** Every change is an inline `!important` declaration. Inline
`!important` beats ordinary site CSS and author `!important` utilities, and it
reaches into shadow roots. For each property Duofari saves the page's own
inline value and priority before the first write. It also remembers the
page's whole `style` attribute as it was before any part of Duofari first
touched the element, the guard's lock (§2.5) and the transition switch below
included.

- **What was written.** `setStyles` keeps the value the browser reads back
  for each declaration, not the string it passed (`0px 0px` reads back as
  `0px`), so the check for the page overwriting a declaration compares like
  with like. It writes nothing when one of the properties is a longhand of an
  inline shorthand that uses `var()`: such a longhand reads as `''` and
  couldn't be put back on its own. The unchanged geometry then fails
  verification, and the element is left alone.
- **Exact restore.** Reverting puts each property back, or removes it. A
  property the page has set itself since keeps the page's value. A property
  still holds Duofari's value when it reads the same with `!important`, or
  without it when the value is a single non-zero `px` length (`ours()`).
  Such a value is an echo of the computed style, not one of the page's own.
  Scroll locks write these, for example Bootstrap's modal scroll-bar helper
  on `<body>`'s `padding-right` and a `.sticky-top`'s `margin-right`. An echo
  doesn't invalidate the record, and reverting puts the page's original
  back. A zero, a keyword or any other value is the page's own and is kept.
  Then `tidyStyleAttribute` compares declarations: if they match the page's
  original attribute, the original string is written back byte for byte. If
  the page had no `style` attribute and nothing is left, the attribute is
  removed. The attribute is read first, which flushes the engine's lazily
  serialised inline style; removing it while that is pending can leave
  `style=""` behind.
- **Bootstrap's copies.** Bootstrap's modal scroll lock also saves the
  inline value it finds (Duofari's, while the box is extended) in a
  `data-bs-<property>` attribute, and writes it back when the modal closes.
  Every revert points such a copy that holds Duofari's applied value at the
  page's original value, or removes it when there was none. When Duofari
  extends the element again while the lock still holds (`<body>`'s inline
  `overflow` is `hidden`) and the copy is still as Duofari left it, the copy
  is pointed at the new value. The modal then writes back Duofari's value,
  an echo, if the box is extended when it closes, and the page's own value
  otherwise.
- **Clone marks.** A changed element carries `data-duofari`, holding the saved
  originals as JSON (`[[property, value, priority], …]`). When the page copies
  an element (a sticky-header clone, a carousel loop slide), the copy carries
  the mark but Duofari has no record of it. The controller finds such copies
  among added nodes and restores them from the JSON. Elements the guard locks
  carry `data-duofari-lock` the same way (§2.5). Copies are cleaned even
  while Duofari is off, since a page can put back a snapshot it took while
  Duofari was on (Turbo, PJAX).
- **No transitions.** Each apply, verify and revert runs inside
  `withoutTransitions`. It saves the inline `transition` shorthand and its
  five longhands, sets `transition: none !important`, does the work, flushes
  the computed style, and puts the page's own values back: the shorthand if
  it read as non-empty (a `var()` shorthand, whose longhands read as `''`),
  the longhands otherwise. An element whose `var()` shorthand has a longhand
  set over it can't be put back exactly, so it is left out and keeps its
  transitions. Without this, `transition: all` would animate the change,
  measurements would read the starting values, every recipe would fail, and
  reverts would animate. The `keepRunning` mode sets `transition-duration: 0s`
  and `transition-delay: 0s` instead. That starts nothing new either, but it
  leaves the page's running transitions alone, which `transition: none` would
  cancel. Latecomer pins and the lift check use it.
- **Detached elements** are reverted at the next run after they leave the
  document, in case the page puts them back.

**Recipes.** For an extension of `C` px on the right (the left is the mirror
image):

1. **Border recipe** (default for bands): `margin-right: m − C;
   border-right: (b + C)px solid transparent; background-clip: border-box`.
   The padding box doesn't change, so nothing positioned against it moves.
   `background-origin` is set per background layer. Layers that scale with the
   box (gradients, `cover`, percentage sizes, repeating tiles) take
   `border-box`. A positioned `no-repeat` image (an icon, a centred logo)
   keeps its own origin, and so does every `url()` layer under Auto
   landscape (§2.1). Such an image stays exactly where it was, and only the
   colour extends. Scaling layers do rescale: a `cover` background grows by
   up to (382 + 84) / 382 ≈ 1.22 in portrait and recentres.
2. **Padding recipe**: `margin-right: m − C; padding-right: p + C`. This grows
   the padding box and with it the clip box, so it is the one used for
   clippers, for bands that clip, and for bands with *cover layers*. A
   centred no-repeat background moves by `C / 2` under this recipe, which
   is one reason the border recipe comes first for bands.
3. **Width compensation**, tried with either recipe when the geometry came out
   wrong. The element has an explicit width, a border-box `max-width`, a flex
   basis or an aspect ratio. Duofari pins `box-sizing: border-box; width: w + C;
   max-width: none; min-width: 0`, plus `flex-basis` in a flex parent with a
   non-auto basis. With an `aspect-ratio` it also pins `height` and sets
   `aspect-ratio: auto`.

**Recipe choice.**

- When the element has cover layers, only the padding recipe is tried. A
  border extension would leave a seam of bare background beside them. A
  cover layer fills the padding box and may grow with it:
  - an absolutely positioned child whose left and right edges match the
    padding box within 1.5 px, and which is either an `<img>` or `<video>`
    with `object-fit: cover` or `fill` that isn't interactive (a
    `video[controls]` never is a cover layer), or a box of background art
    with no text and nothing interactive (a tint, slides, a parallax
    backdrop). In such a box every background layer, its own and its
    descendants', must scale with the box, and every picture inside must be a
    cover-fitted `<img>` or `<video>` that fills the layer edge to edge. A
    `canvas` or `svg` rules it out;
  - a positioned `::before`/`::after` with empty content (`""`) whose
    backgrounds scale with the box, at `left` 0 and as wide as the padding
    box (within 1.5 px). The element's own two count, and so do those of its
    first `NEAR_PSEUDO_LIMIT` direct children that aren't containing blocks
    themselves, and of the first `NEAR_PSEUDO_LIMIT` such children of those
    (`.hero .wrap::before`, inside a container too). The pseudo-elements of
    the other boxes in between are read only when the padding recipe is
    tried, and don't decide the recipe.

  A layer or pseudo-element that draws a positioned `no-repeat` image (an
  icon, a badge, a play button drawn as a background) is not a cover layer.
  It has to keep its place, and nothing forces the padding recipe for it, so
  a band that doesn't clip keeps the border recipe, which leaves that image
  where it was. Under Auto landscape nothing that draws a picture is a cover
  layer (§2.1).
- The padding recipe is skipped when the element clips and something hidden
  would show. Duofari walks the subtree, entering open shadow roots, up to
  `HIDDEN_SCAN_LIMIT` nodes; past that it assumes yes. It looks for any
  visible box in the strip the column would open up: an off-canvas menu, the
  rest of a tab strip. Boxes Duofari extended itself are left out, and so is
  the inside of a descendant that clips within the viewport. A scroll-width
  gate covers what the walk can't see. The clipper's content reach is read
  from its `scrollWidth`, less its own end padding. If that goes more than
  1 px past what all the boxes found account for, the rest is text, a
  pseudo-element or closed shadow content, and Duofari assumes yes too. When
  there is such overflow, each box accounts for it up to its margin edge, and
  an invisible one (not `visibility: visible`) for its own content as well.
- The padding recipe is also skipped when the walk for positioned children
  (below) stopped at a limit, and under Auto landscape for a band or clipper
  with its own `url()` background, which a grown padding box would rescale.
- A cache keyed by tag, class, `display`, `position`, `box-sizing` and the
  parent's `display` tries the last recipe that worked for that signature
  first, with or without width compensation as it worked then.

**Verify after each attempt.** Duofari re-measures. Tolerances are `EPS` for
unchanged boxes and `EDGE_EPS` for the extended edge. It accepts the attempt
only if all of these hold:

- the border box now ends exactly `C` further out, its other edge, top and
  height are unchanged;
- the content box is unchanged on both sides;
- the first and last in-flow children have the same left, right and top;
- positioned `::before`/`::after` boxes that aren't cover layers have the same
  computed `left`, `width`, `top` and `height`. With the border recipe these
  are the element's own two. With the padding recipe they also include those
  of every box in between that isn't a containing block itself, since their
  positioned pseudo-elements have the element as containing block too;
- padding recipe only: absolutely positioned children whose containing block
  is the element are where they were. Duofari collects up to
  `ABS_KEEP_LIMIT` of them, visiting at most `ABS_SCAN_LIMIT` nodes, and
  doesn't enter nested containing blocks. If the walk stops at either limit,
  the padding recipe isn't used at all. Cover layers are expected to grow
  (see below). Any other child that moved, such as a hamburger at
  `right: 16px`, is pinned back (`pinBack`). One that only shifted (same
  width, height and top) is moved back by its margins, `margin-left − dx` and
  `margin-right + dx`. Its insets and width stay the page's, so a drawer
  sliding in by `right` or a panel that grows still animates. If that doesn't
  put it exactly in place, or the box was resized, it is pinned with an
  explicit `left`, `right: auto` and `width` instead. Either way it must end
  up exactly in place.

If the geometry was off, Duofari retries with width compensation. If the
geometry was fine but a child or pseudo-element moved, compensation can't help,
and it moves on to the next recipe. If nothing passes, everything is reverted,
and the element is remembered as rejected for this layout and size.

**Cover layers in the padding recipe.** A cover `<img>` or `<video>` that is
`object-fit: cover` and has at least `C − 0.5` px of cropped-away art on the
column side, measured before the box grows, gets its `object-position` pinned
to its current pixel offset. Its visible part stays put, and the column shows
the art the crop was hiding, pixel for pixel. Without enough cropped art, a
cover layer with `object-fit: fill` is
switched to `cover`, so it is re-cropped rather than stretched. Other cover
layers simply grow with the box. A `<video>` with controls is never a cover
layer: it is pinned back like other positioned foreground, and its
`object-position` and `object-fit` are never set.

**Menus that open later.** A positioned child that appears after a box was
extended with the padding recipe is laid out against the grown padding box. A
search panel, a toast or a menu could land under the column. Whenever such a
record is re-checked, `repinLatecomers` looks for the box's positioned
children that aren't cover layers or pinned already:

- The controller queues elements the page adds inside any padding-recipe box
  (`noteAdded`), and the targets of attribute changes on elements Duofari
  hasn't changed (`noteChanged`: `class`, `style`, `src`, `srcset`,
  `hidden`, `open` and `aria-expanded`, §2.7), for every such box around
  them. Each box keeps the latest `LATE_QUEUE_LIMIT`.
- `repinLatecomers` looks at those first, newest first, visiting at most
  `LATE_LOOK_LIMIT` elements. It starts at each one, or at the outermost
  containing block between it and the box (a toast stack a toast went into).
- On a full look, which a pass on its own makes, it then walks the box from
  its start, at most `LATE_SCAN_LIMIT` nodes.
- A pass begun alongside an unfinished one (§2.2) does only the queued look
  on the boxes it passes, and on `<body>` at its start. It owes those boxes
  the full look until it is the only pass. If a box then fails that look,
  it is reverted with what it holds, and a new pass begins from the top.

When one of the children found is new, or reaches into the column, Duofari
takes the extension off for a moment and measures where the page's own box
puts each of them, `left` and width included.

- If the box clips and one of them, under the page's own box, would sit in
  the strip and show (a drawer added later that the page's clip hides), the
  record fails and the box is measured again.
- Otherwise each child that moved is pinned back with `pinBack`, as above.
  This runs with `keepRunning`, so a toast's entrance transition keeps going
  and the box is compared at the same point of it.
- A child that can't be placed is unpinned and tried again on a later scan.

**Re-checking.** On each pass an applied element is still valid only if all of
these hold:

- the site hasn't overwritten Duofari's declarations;
- an `<img>` or `<video>` still has the intrinsic size it was measured with
  (a lazy loader's real image, the next slide), and so do its pins;
- its edges are where the extension put them (±1.25 px);
- its parent's content box hasn't moved;
- its pins are still attached and intact;
- for a clipper Duofari opened: its content reaches no more than 1 px further
  on the column side than when it was opened, and nothing added inside it
  since shows in the strip it opened. The controller passes added elements
  and text, and text edited in place, to `noteAdded` (§2.7). It queues them
  for the nearest opened clipper's strip check, and, separately, queues
  elements for the latecomer look of every padding-recipe box around them
  (above). No positioned child that appeared later would show in that strip
  either.

Height changes are accepted for boxes, for example a header that shrinks on
scroll. When the site changes the `class` or `style` of an applied element,
or of a child it pinned, the element is marked dirty. It is reverted and
measured again from the site's own styles, so Duofari never keeps padding,
margin or width values frozen from an older layout. If the element or one of
its pins is running a CSS transition, that waits until the transition ends:
reverting with transitions off would cut it short. For a box that clips, the
same goes for anything extended inside it, which is reverted with it.
Restyles of `<body>` itself don't mark it dirty, because it changes class all
the time and reverting it reverts everything inside. Its record is checked at
the start of each pass instead (§2.2). A class change that alters `<body>`'s
own padding or margin on the column side is therefore not seen while
`<body>` stays extended.

Reverting a clipper reverts everything extended inside it, so that the
clipper is extended first again. Breakouts reverted with an invalid record
(their own, or inside a clipper) are put back in the same pass, or in the
pass running alongside it (§2.4).

### 2.4 Media: Reveal, Fill and breakout

Only `<img>` and `<video>` are treated as media. `canvas`, inline SVG, iframes
(players, maps) and `video[controls]` are never extended, rescaled or
re-fitted, and never count as cover layers. When one is positioned inside a
box that takes the padding recipe, it is only pinned back where it was
(§2.3). The "Lead image and wide artwork" setting (`media`) controls all of
it, and under Auto landscape none of it runs (§2.1).

A picture is a candidate only if:

- it is at least 100 px tall and not hidden;
- its `object-fit` is not `contain`, `scale-down` or `none`;
- an `<img>` has loaded (it is scanned again on `load`) and has no `usemap`;
- a `<video>` is background video: no `controls`, muted or autoplaying, looping
  or autoplaying, and not inside a known player (`.html5-video-player`,
  `.video-js`, JW Player, Brightcove, Plyr, MediaElement, Shaka, Vimeo,
  `[data-player]`, `.video-player`).

Full-width pictures with more than 2 absolutely positioned text labels over
them, within two ancestor levels, are skipped. Their pixels must not move under the labels.

**Full-width pictures** keep their height in both modes, so the page never
shifts:

- **Reveal.** The picture is `object-fit: cover` and already crops away at
  least `C − 0.5` px on the column side. Duofari widens the box by `C` and pins
  `object-position` to the current pixel offset. Nothing is rescaled: the
  column shows the art the crop was hiding. Any full-width picture that
  qualifies is revealed.
- **Fill.** Duofari widens the box by `C`, keeps the height, and sets
  `object-fit: cover` (from `fill` or `cover`). The picture is scaled by
  `(W + C) / W`, which is 466 / 382 ≈ 1.22 in portrait. A centred picture is
  trimmed about 9 % at the top and at the bottom. Fill applies to the **lead
  image** only. That
  is the first full-width picture that starts within 1.5 viewport heights of
  the top of the document. Fill applies to every other full-width picture only
  with "Every full-width image" (`allImages`). Pictures that look like graphics
  are never filled. These are pictures inside chart, diagram, infographic or
  ai2html containers; pictures whose alt text, title, label, file name or class
  mentions a screenshot, diagram, chart, graph, map, numbered figure, table,
  code, slide, comic or panel; SVGs; and PNG or GIF files shown narrower than
  1.6 : 1.
  Pictures stacked edge to edge with another full-width picture (comic strips,
  sliced infographics) are not filled either.

Both modes set `width`, `height`, `max-width: none`, `min-width: 0`,
`max-height: none`, `flex-shrink: 0`, `aspect-ratio: auto` and the negative
margin. The result is verified like a band's border box.

**Breakout** ("Enlarge photos inside page margins", `breakout`, off by
default) lets a photo inset by page margins grow to the full screen width:
from 0 to `layoutWidth + C`, 466 CSS px in portrait. It keeps its aspect
ratio, so it gets taller and the text below it moves down. That changes the
layout, so it is opt-in and tightly limited. The photo must be:

- an `<img>` whose top is below the visible part of the page. Nothing the
  reader is looking at, or has scrolled past, ever grows. The one exception
  is a photo reverted from a breakout earlier in the same pass, or in the
  pass running alongside it (its record, or a clipper around it, was no
  longer valid): it is put back before the reader sees it shrink;
- at least 0.8 of the layout width, with both edges within 48 px of the
  viewport edges;
- without rounded corners over 2 px, not inside an interactive element other
  than a link, not a likely graphic, not PNG or GIF;
- at least `layoutWidth + C` pixels wide in its source, so it isn't upscaled;
- inside a full-width ancestor, with only plain boxes in between. Plain means
  no background, shadow, radius, side border, clip, transform or filter, fixed
  or sticky position, multi-child flex or grid, table or list item.

The parent must grow by the same height, or contain the taller photo, or the
breakout is reverted. v1 compensated height changes with `scrollBy`. v2 does
not, because breakout never touches anything at or above the viewport. When a
breakout above the viewport is reverted (on rotation, or when Duofari is
turned off), the page height changes above the reader. Duofari leaves that to
Safari's scroll anchoring, which the Safari 27 release notes say is enabled.

### 2.5 Holding the page still (`content-guard.js`)

Extended content makes the document `C` px wider than the layout viewport.
Before changing anything, the controller measures the page's own horizontal
scroll range (the *allowance*), and it measures again after every scan
(§2.6). The guard then does three things:

1. **Touch-action lock.** With "Hold pages steady" (`holdSteady`) on, while not
   zoomed in, and only while the page has no horizontal overflow of its own
   (allowance < 1 px):
   - `html`, `body` and every touch root from the scan get the page's own
     computed `touch-action` minus sideways panning (`pan-x`, `pan-left`,
     `pan-right`), as an `!important` inline value. `auto` and
     `manipulation` become `pan-y pinch-zoom`, and `pan-x pan-y` becomes
     `pan-y`, so a pinch-zoom the page turned off stays off. An element whose
     `touch-action` already allows no sideways panning (`none`, `pan-y` and
     so on) is left alone. Touch roots are spine wrappers whose computed
     overflow is `auto` or `scroll` but which don't scroll sideways. WebKit
     resets `touch-action` at those (§1), so `html` alone would not be
     enough.
   - Registered app shells (§2.2) are locked the same way while their
     sideways overflow is at most the column width plus 1 px (`C + 1`). That
     is Duofari's own widening, or a little of the page's added since, which
     stays out of reach as small late overflow does on the root (§2.6). Once a
     shell's overflow is wider, it is unlocked and its whole range stays
     reachable (see Snap-back).
   - `overscroll-behavior-x: none` goes on `html` when it is locked.
   - Each locked element carries `data-duofari-lock` with the page's own
     inline values as JSON, so copies the page makes of it are cleaned like
     clone marks (§2.3). Elements that are no longer touch roots or held app
     shells, or have left the document, are unlocked.

   Real horizontal scrollers (carousels) are not locked. `touch-action`
   resets at them, so they keep panning. Pinch zoom keeps working unless the
   page itself turned it off.
2. **Snap-back.** A capture-phase `scroll` listener watches the root (window,
   `html` or `body`) and any registered app-shell scroller. The root may rest
   anywhere in `[0, allowance]` (`[−allowance, 0]` for right-to-left pages).
   App shells rest at 0 while their sideways overflow is at most the column
   width plus 1 px (`column`, which the controller passes to `enable()`),
   since Duofari's extensions widen a shell by `C` at most. Wider overflow is
   content the page added since (a wide table on a later route), so the
   shell's whole range stays reachable.
   - A drift that arrives while scrolling was idle and no finger is down is a
     programmatic jump (focus, an anchor, find-in-page). It is put back at once.
   - Any other drift waits until there are no touches and no scroll events for
     `SETTLE_MS = 150` ms, or for `scrollend`.
   - Touches are counted from capture-phase `touchstart`, `touchend` and
     `touchcancel` on the window. On `touchstart` the guard also listens once
     on the touch's own target, so a target the page removes mid-touch (a
     recycled feed row) still brings the count back to 0.
   - The correction is relative: `scrollBy({ left: −dx, top: 0, behavior:
     'instant' })`. It never sets an absolute vertical position, so it can't
     fight a vertical fling with a stale `scrollY`.
3. **Zoom.** When `visualViewport.scale` exceeds the resting scale × 1.02, the
   lock comes off and snap-back pauses, so a zoomed page can be panned freely.
   Both return when the user zooms back out.

While the page is drifted, the controller postpones the scan: it asks for
another run 200 ms on, which `schedule()` keeps at least `MIN_INTERVAL` after
the last (§2.7). Rects would otherwise be measured shifted, and every band
would look invalid.

Pages with their own horizontal overflow (a wide table with no scroll wrapper)
get no lock, so that content stays reachable. They get no viewport meta change
either (§2.6). Snap-back only acts beyond their own range. This also holds
when the overflow appears after activation (§2.6).

**Trade-off.** The lock turns off double-tap zoom and swiping back from the
middle of a page, and the popup's hint for "Hold pages steady" says so. Two
design reviews read WebKit's source on this. Both found that the lock can
block a back-swipe that starts mid-page and that a swipe from the screen edge
is not affected. Both also read WebKit as leaving double-tap zoom working
(`touchActionAllowsDoubleTapToZoom`), while a third review expected the lock
to turn it off. So the evidence on double-tap zoom is mixed. All of this needs
checking on a device. With the setting off, pages can slide sideways during a
swipe and slide back once scrolling settles. Wrappers off the spine, and
iframes, are not locked. A swipe that starts on one of them falls back to
snap-back.

### 2.6 Viewport meta and `100vw` (`content-main.js`)

**Viewport meta.** WebKit would zoom a page without an initial scale out to
fit the wider content, and lets the minimum scale follow the content width
down (§1). On activation Duofari edits the **last** viewport meta in tree
order, which is the one WebKit applies. It does so only when the page's own
content fits (allowance < 1) and the meta mentions `width=device-width` or
`initial-scale`. It appends `initial-scale=1` if that is missing, and a
`minimum-scale` if the meta has none or a lower one (Wikipedia declares
0.25); the later value wins. The minimum is the page's own `initial-scale`
when that is below 1, and 1 otherwise: a minimum above the initial scale
would zoom the page in and lay it out narrower. A declared minimum below it
would let the reader zoom out over what Duofari added beside the page, and
fixed bars (a donation banner inset from both edges) would stretch along.

- `minimum-scale=1` matters on its own. A user who has zoomed once could
  otherwise be snapped to the new, lower minimum when content grows (SOURCE).
  Zooming out below 1 never showed anything on these pages anyway. Zooming in
  is untouched.
- Duofari never adds `viewport-fit`, `maximum-scale` or `user-scalable`.
- The observer watches the `content` attribute of `<meta>` elements and the
  children of `<head>`. When a head manager rewrites the meta (unhead) or
  replaces it with a fresh one (Next.js, React Helmet and Turbo swap out the
  edited tag on navigation), Duofari puts the original content back on the
  meta it edited, if that is still in the document and still holds Duofari's
  version, and fixes the current last one. It does this at
  most `META_LIMIT = 5` times in any `META_WINDOW = 10` s; beyond that it
  leaves the meta to the page. SPA navigation resets the count (§2.7). A
  meta that appears while Duofari is active is fixed too.
- On deactivation the original `content` is restored, but only if the meta
  still holds Duofari's version.
- Pages without a viewport meta count as desktop layouts and are skipped by
  default (§2.1).

**`100vw` probe.** On activation Duofari measures a hidden `width: 100vw`
element against `documentElement.clientWidth`. Some WKWebView set-ups include
the column in `vw`. When Safari does, and the page's own overflow is no more
than that excess plus 1 px, the "overflow" is just a `width: 100vw` section, and
the allowance is set to 0. The result appears in Diagnostics as
`vwIncludesColumn`.

**Allowance after activation.** The page's own content can make it wider
after activation (a wide table on a client-rendered route, lazy content) and
narrower again. After every scan the controller measures the document's
horizontal overflow again. Duofari's extensions widen it by `C` at most, so
overflow beyond `C + 1` px is the page's own. The allowance then becomes that
overflow, the viewport meta is restored and the touch lock comes off, so the
content stays reachable. When the overflow goes away, the allowance falls
back to the value measured at activation, and the meta is fixed again if the
page fitted then. Diagnostics shows the current allowance as `ownOverflow`.

### 2.7 Keeping up with the page (`content-main.js`)

| Constant | Value | Use |
|---|---|---|
| `MIN_INTERVAL` | 300 ms | minimum time between runs; requests in between are merged into one trailing run. Also the wait before the next slice of a pass cut short |
| `RESIZE_SETTLE` | 250 ms | quiet time after the last resize before a fresh run |
| `SCAN_BUDGET` | 6000 | visits per slice, shared by the passes under way (§2.2) |
| `SLICE_MS` | 12 ms | time per slice; the rest of the pass continues in a later run |
| `FLIP_LIMIT` / `FLIP_WINDOW` | 4 / 10 s | on/off changes allowed within one pose before standing down |
| `POSE_FREE` | `not-duo`, `reduced-transparency` | reasons an idle page keeps while zoomed in after a fold or rotation |
| `META_LIMIT` / `META_WINDOW` | 5 / 10 s | viewport meta repairs allowed before leaving the meta to the page |
| `TEXT_QUIET` | 5 s | text-only changes, anywhere on the page, bring a scan at most this often |

**A run.**

1. Skip while the document is hidden.
2. Measure the column, and work out the pose: the window width in points
   (`visualViewport.width × scale`, rounded) and the orientation type. A new
   pose clears the flip count and `unstable` (see Back-off). A new pose while
   zoomed in also drops an idle page's earlier unzoomed reason, unless it is
   one that holds in every pose (`POSE_FREE`).
3. Work out whether Duofari is switched off here: the global switch
   (`disabled`), the site state (`site-disabled`, `excluded-site`) or the
   flip back-off (`unstable`).
4. While pinch-zoomed in, change nothing, except that an active page is
   deactivated if it was switched off meanwhile. An inactive page reports the
   off reason if there is one, otherwise its earlier unzoomed reason
   (`not-duo`, `no-column`, `desktop-layout`, `start-side` and so on). It
   reports `zoomed` when there is no earlier answer (none yet, or one dropped
   in step 2), or that answer was `column`. A fold or rotation while zoomed
   in therefore shows `zoomed` until the user zooms out, except on a page
   that isn't on a Duo or has Reduce Transparency on.
5. While the page is drifted, ask for another run 200 ms on (`schedule(200)`,
   so in practice `MIN_INTERVAL` after this run began).
6. Decide whether to be active: not switched off, and a column width above 0.
   A change between on and off counts as a flip.
7. If the geometry changed (width, side, the images flag or the layout width),
   revert everything, drop any unfinished pass and start from the page's own
   layout.
8. On activation, measure the allowance, probe `100vw` and fix the viewport
   meta, in that order.
9. Drop records of removed elements, then scan. The pass's own timer goes on
   with an unfinished pass. Any other run starts a new pass, alongside the
   unfinished one if there is one (§2.2).
10. Measure the allowance again (§2.6).
11. Enable the guard with the touch roots and app shells the scan found and
    the column width, then update the debug view.
12. Discard the mutation records caused by Duofari's own writes.

**Scheduling.** Triggers ask for a run through `schedule()`, which keeps runs
`MIN_INTERVAL` apart, and each such run starts a new pass from the top.
Settings changes and the end of a resize run at once. A pass cut short (§2.2)
is continued by its own timer `MIN_INTERVAL` later. That timer stands down
when another run is already on its way, since that run goes on with the
unfinished pass too. Once the passes complete, nothing is rescheduled, except
while a record waits for a transition to end (§2.3): then a run is asked for
60 ms on, which `schedule()` still keeps `MIN_INTERVAL` after the last run.

**Triggers.**

- A `MutationObserver` on the document and on each open shadow root. It
  watches `childList`, `characterData` and the `class`, `style`, `src`,
  `srcset`, `hidden`, `open`, `content` and `aria-expanded` attributes, with
  their old values.
- `load` and `loadedmetadata` of images and video (capture phase), and the
  window's `load`.
- A `ResizeObserver` on `<body>`.
- `resize`, `orientationchange` and `visualViewport` resize.
- A scroll of more than half a viewport height since the last scan.
- SPA navigation: `popstate`, `hashchange`, the Navigation API's
  `navigatesuccess`, and a new address that the observer notices with a batch
  of DOM changes. The last covers `pushState` and `replaceState` routes
  without the Navigation API, which Safari 18 lacks. Each clears the flip
  count, `unstable` and the meta repair count, and asks for a run.
- `pageshow` (back/forward cache), `visibilitychange`, `document.fonts.ready`.
- Settings changes.

**Mutation filtering.**

- Copies carrying `data-duofari` or `data-duofari-lock` among added elements
  are cleaned first, even while Duofari is off (§2.3). With the global switch
  off, nothing else is done.
- Added and removed elements count, except Duofari's own nodes.
- While Duofari is active, added elements and text, and text edited in place
  (`characterData`, as React updates it), go to `noteAdded` (§2.3). It queues
  elements for the latecomer look of each padding-recipe box around them,
  and any node for the nearest opened clipper's strip check.
- Text-only changes count only when an opened clipper queued them, and then
  bring a scan at most once per `TEXT_QUIET` across the whole page, not per
  element (a live list updates many cells, each on its own). A change within
  that time sets one shared trailing timer instead. It brings a scan
  `TEXT_QUIET` after the last text scan and counts as one itself, so no change
  goes unchecked, and a clock or a live list costs about one scan per 5 s.
  Text in a batch that already brings a scan isn't counted. Text changes
  outside opened clippers don't count.
- A `class` or `style` change on an applied element, or on a child it pinned,
  marks the element dirty (§2.3). A `style` change that only touches the
  guard's lock (written while zooming, outside a run) or custom properties
  (`--*`, which scroll effects write every frame) is ignored.
- While Duofari is active, attribute changes other than `content` on
  elements Duofari hasn't changed are queued with `noteChanged` for the
  padding-recipe boxes around them (§2.3), `style` changes included. An
  element whose inline style changes more than 10 times in a second is left
  out of that queue for 5 s (`styleRates`, counted apart from the rule
  below), so animations written every frame don't push everything else out
  of it.
- A `style` change on any other element brings no scan by itself. That covers
  Duofari's own writes and the page's animations.
- A `content` change never brings a scan by itself. On a `<meta>` it
  re-checks the viewport meta (§2.6), and so does any change to `<head>`'s
  children.
- Other attribute changes count. On elements Duofari hasn't changed they are
  ignored while the element is busy: one that changes more than 10 times in
  a second is ignored for 5 s.
- After every batch, lifts are re-checked (§2.2).

**Fold, unfold and rotation.** On a resize that changes the layout width,
Duofari reverts everything at once and drops any unfinished pass. Pinned
widths from the old layout would otherwise flash at the new size. It
re-applies 250 ms after the last resize, once the transient sizes have
passed.

**Back-off.**

- **Flips.** More than 4 changes between on and off within 10 s in one pose,
  for example a page and Duofari's zoom effects feeding each other, puts the
  page in `unstable`. The popup shows "Paused on this page". Folding,
  unfolding and rotating are the user's doing, so a new pose starts the count
  again. Viewport meta edits, the zoom-out loop and pinch zoom leave the
  window width in points unchanged, so such a loop still stands down. The
  pause is also cleared by SPA navigation and by a settings change. The
  content script also clears it on a `duofari:rescan` message, but nothing in
  the extension sends that message at present.
- **Style fights.** When a site overwrites Duofari's declarations on an element
  more than 6 times in 10 s, the element is left alone for the rest of the page
  view. This follows Dark Reader's pattern. Layout or class changes that leave
  the declarations intact don't count.
- **Head managers.** Viewport meta rewrites are repaired at most 5 times in
  any 10 s, and the count starts again on SPA navigation (§2.6).

**Off switch.** A global or per-site disable, a column of 0, or the flip
back-off makes Duofari:

- revert every element;
- remove the guard (touch-action and overscroll values restored, listeners
  removed);
- restore the viewport meta;
- remove the debug view.

A disable or the back-off does this even while the page is pinch-zoomed in.

### 2.8 Settings and the popup

Settings live in `storage.local`. The code notes that `storage.sync` doesn't
sync in Safari. Content scripts get changes through `storage.onChanged` and
apply them at once. A change to `bands`, `media`, `allImages`, `breakout`,
`landscapeSide`, `desktopPages`, `force`, `forceColumn` or `device` that
actually changes the value reverts everything first and starts again from the
page's own layout. A `device` change whose `screenWidth`, `screenHeight`,
`scale` and `model` match the stored ones is dropped, so it reverts nothing
and doesn't clear the flip count; a change left with nothing in it is ignored.
Every change that remains clears the flip count and `unstable`, and Duofari
runs at once.

| Setting | Popup label | Default |
|---|---|---|
| `enabled` | Duofari on all websites (under More) | on |
| `disabledSites`, `enabledSites` | On for *site* | on, except built-in exclusions |
| `bands` | Header bars and backgrounds | on |
| `media` | Lead image and wide artwork | on |
| `allImages` | Every full-width image | off |
| `breakout` | Enlarge photos inside page margins | off |
| `landscapeSide` | Safari’s controls in landscape: Auto / Left / Right (under More) | Auto |
| `holdSteady` | Hold pages steady (under More) | on |
| `desktopPages` | Also adjust desktop-layout pages (under More) | off |
| `debug` | Show what’s extended (under More) | off |
| `force`, `forceColumn` | none; for testing on other devices | off, 84 |
| `device` | none; written by `background.js` | none |

"Every full-width image" and "Enlarge photos inside page margins" are disabled
in the popup while "Lead image and wide artwork" is off.

**Built-in exclusions.** Web apps that draw their own full-screen interface
are off by default, and the user can turn each one on. The list is in
`shared-settings.js`:

- Google Docs, Sheets, Slides, Drive, Gmail, Calendar, Maps, Earth and Meet;
- Outlook and Teams;
- Figma, Canva, Excalidraw, diagrams.net and Photopea;
- iCloud, Apple Music and Apple TV;
- vscode.dev, github.dev, CodePen, CodeSandbox and StackBlitz;
- WhatsApp Web, Slack, Discord and Notion.

**Status and site access.** With no tab open the popup shows "No page open".
An address that isn't `http` or `https` shows "Duofari can’t change this kind
of page". Otherwise the popup asks the open
tab's content script for its status (`duofari:status`) and, at the same
time, asks `permissions.contains` whether Duofari may run on the site for
good: the site's `scheme://host/*`, or `*://*/*` when Safari hides the
address. Opening the popup also gives the tab temporary access (`activeTab`).
Safari then shows the address and runs the content scripts, but only until
the tab moves to another site, and `permissions.contains` leaves that grant
out. The popup shows the first of these that applies:

- **Nothing answers, no access.** "Duofari can’t see this site yet" with
  **Allow on All Websites**. That calls
  `permissions.request({ origins: ['*://*/*'] })` and, if granted, injects
  the content scripts into the open tab with `scripting.executeScript`, so no
  reload is needed. The file list comes from the manifest.
- **Nothing answers, access, hidden address.** "Duofari can’t see this page":
  Safari's Start Page or an empty tab, or a website set to Deny in Settings ›
  Apps › Safari › Extensions › Duofari while all others are allowed. There is
  no button, since allowing would change nothing.
- **Nothing answers, and the path ends in `.pdf`.** "Duofari can’t change this
  kind of page".
- **Nothing answers otherwise.** The page was open before Duofari was. The
  popup shows "Duofari hasn’t run on this page yet" and offers **Apply to
  This Page**, which injects the scripts. If that fails (a PDF at an address
  without `.pdf`, Reader), it shows "Duofari can’t change this kind of page"
  instead of reloading, which would only lose the reader's place.
- **A non-HTML document answers** with the reason `unsupported-document`:
  "Duofari can’t change this kind of page", with no button.
- **The content script answers.** The popup shows what happened, for example
  "Extended 3 bars and 2 images" and "Safari’s controls take 84 points on the
  right.", or the reason from §2.1. When Duofari runs only on the temporary
  access, the detail line says "For now Duofari can see only this page. Allow
  it on all websites so it can extend pages as they open." and **Allow on All
  Websites** is shown alongside.

Counts use `Intl.PluralRules` and `Intl.ListFormat`, and all strings are in
`_locales/en/messages.json`.

The popup also asks `background.js` to refresh the device info from the app.
`background.js` writes it only when it has changed (§2.1).

**Diagnostics** (under More) lists the raw inputs: `screen`, `dpr`,
`clientWidth`, `innerWidth`, `innerHeight`, `visualViewport`, `orientation`,
`direction`, `viewportMeta`, `columnPoints`, `columnCss`, `side`,
`vwIncludesColumn`, `ownOverflow`, `touchLock`, `deviceFromApp`, `userAgent`,
`reason` and `counts`. When nothing answers, it lists only the address (`url`,
or `(hidden)`). **Copy** puts them on the clipboard, or selects the text when
the clipboard is refused.

**Debug view** ("Show what’s extended") draws a hatched strip where the column
is and a badge, for example "Duofari · 84px right · 3 bars · 2 images ·
locked". Extended elements get a dashed pink outline, and pinned children a
blue one. It lives in a shadow root marked `data-duofari-ui`, which the scan
and the observer ignore.

**The containing app** (`apple/Duofari`) explains where Duofari works and how
to turn it on. It reads the extension's state with
`SFSafariExtensionManager.stateOfExtension(withIdentifier:)`. "Open Settings"
calls `SFSafariSettings.openExtensionsSettings(forIdentifiers:)` and falls back
to the Settings app. It recognises the Duo with the same shape-and-scale test as
the content script, restricted to the phone idiom.

### 2.9 What Duofari deliberately leaves alone

- The column on the page's start side (§2.1), the inner display at full screen,
  and inner Split View, which hasn't been measured.
- Desktop-layout pages, unless "Also adjust desktop-layout pages" is on.
- The built-in excluded web apps, unless turned on per site.
- Frames. Only the top document runs, and iframes can't reach the column.
- The slides inside carousels and sliders (§2.2), players, `canvas`, inline
  SVG, form controls and dialogs; and tables, inline boxes and interactive
  elements as bands.
- Charts, screenshots and comics, except where Reveal can show cropped-away
  art without rescaling. Full-width pictures with text labels positioned over
  them are skipped in every mode.
- Full-height fixed overlays, elements with non-translation transforms,
  elements that are animating, and anchors for CSS anchor positioning.
- Editable content (`contenteditable`), where Duofari's inline styles would
  be saved with the text.
- Closed shadow roots, which can't be reached.
- A mirrored or blurred continuation like Apple's `backgroundExtensionEffect`.
  v1's Mirror mode used `-webkit-box-reflect`. It had no blur, showed
  backwards text at a hard seam, and in WebKit made the image a layer that
  paints over overlapping content. v2 dropped it.
- Predicting Safari's opaque fill. Duofari does not port `fixedContainerEdges`.
  If a page's fixed or sticky element triggers the fill, the column shows one
  colour over whatever Duofari extended.
- A tint-only fallback, such as fold-ready's 8-px fixed strip.
- Text. No rule ever moves text or controls into the column. The fixture tests
  check this on every active case except `spa`, and `test/run-live.mjs`
  checks it on live sites.

## 3. Known limitations

- **No hardware testing.** Everything was verified in Chromium emulation and
  against WebKit source and simulator reports, not on iPhone Duo. Painting
  under the column, the fixed-bar lift, Safari's opaque fill over the column
  (`fixedContainerEdges`) and touch behaviour need a device or the Xcode 27.1
  Simulator. Use `test/device/index.html`.
- **End edge only.** Pages can only paint toward their end edge (right in
  left-to-right pages). Right-to-left pages in portrait, and the column on the
  left in landscape for left-to-right pages, are left alone.
- **Landscape side unconfirmed.** Which side the column is on in landscape is
  unconfirmed, and so is whether there is a column at all. "Auto" therefore
  extends only background colours and gradients in landscape: no image is
  extended, rescaled or moved (§2.1). The user can pick the side under
  "Safari’s controls in landscape".
- **Inner display.** Safari has no column on the unfolded inner display at
  full screen, so Duofari is idle there.
- **Hold pages steady.** The touch-action lock turns off double-tap zoom and
  swiping back from mid-page. It can be turned off; pages then snap back after
  scrolling. The design reviews disagree on double-tap zoom, so both effects
  need checking on a device (§2.5).
- **Reduce Transparency** is detected with
  `matchMedia('(prefers-reduced-transparency: reduce)')` as future-proofing. If
  it matches, Duofari stays off. Whether Safari exposes this media feature is
  unverified.
- **Desktop-layout pages** (no `device-width` viewport) are skipped unless
  enabled.
- **Large pages** are walked in slices of 6,000 visits or 12 ms, 300 ms apart
  (§2.2), so on a very large page some bands extend a moment later than
  others. On a page that keeps changing, each new pass takes a quarter of
  every slice, so the pass already under way reaches deep content about a
  third later.
- **Changing text.** Text-only changes inside an opened wrapper bring a scan
  at most once every 5 s (`TEXT_QUIET`), counted across the whole page. Text
  that starts to reach into the column within 5 s of another text change can
  show there until that scan.
- **Late menus and toasts.** In a box extended with the padding recipe,
  Duofari looks for positioned boxes that appear later among the last 20
  elements the page added or changed in the box, and in the first 2,000
  nodes from its start (§2.3). One that both miss (deep in a large box,
  behind more than 20 newer changes) keeps the place the grown box gives it,
  up to `C` px off, until the page changes it again.
- **Scroll locks.** Bootstrap's `data-bs-*` copies of inline values are kept
  in step (§2.3). A lock that keeps its copy elsewhere (Bootstrap 4 uses
  jQuery data), or that rounds the value it echoes, can leave Duofari's
  padding on the page once Duofari lets go of the box, for example when a
  modal closes after Duofari was turned off.
- **Safari's own covers.** Safari's opaque fill, the
  `HorizontalBannerViewOverlaysEnabled` behaviour, Live Activities and the
  column's own contents may hide part or all of what is extended. None of this
  can be detected from the page.
- **Right-to-left system languages.** In portrait Duofari assumes the column is
  on the right. Apple's sources disagree on whether the bar moves in
  right-to-left languages.

## 4. Testing

See [docs/TESTING.md](TESTING.md) for how to run each suite and what it checks.
In short:

- `npm test` runs, in this order:
  - the 22 unit tests (`test/unit/geometry.test.mjs` and
    `test/unit/background.test.mjs`, `node:test`);
  - the 26 fixture cases (`test/run-fixtures.mjs`);
  - the 71 regression cases (`test/run-regressions.mjs`): 49 for the engine
    and 22 for the controller, guard and popup-facing behaviour. Each builds a
    small page around one defect found in review and checks the behaviour its
    fix restored;
  - the 15 popup states (`test/run-popup.mjs`, with a mocked browser API).
- `npm run test:live` runs the same invariants against 16 live sites. It
  reads vertical moves on both sides of turning Duofari off, in one step
  where no page script can run, and checks that turning off gives back every
  declaration Duofari changed, the touch settings of `html` and `body`, and
  the viewport meta. An echo of a non-zero `px` value Duofari wrote, without
  `!important`, counts as Duofari's and must come back to the saved
  original (§2.3).
- The fixture and live runners wait for Duofari's scan to finish before they
  check anything (`untilScanned` in `test/lib/duo.mjs`): until the
  controller's `cursor`, `timer` and `resumeTimer` are clear, for at most
  5 s.
- The fixtures emulate the folded Duo in Playwright/Chromium (`test/lib/duo.mjs`):
  - a 382 × 580 viewport, a 466 × 678 screen and DPR 3;
  - the screen orientation set through CDP and re-applied after screenshots;
  - a shim that adds `minimum-scale=1` to a `device-width` viewport meta that
    has an `initial-scale` and no `minimum-scale`, so Chromium keeps its
    minimum scale the way Safari does.
- They check that no text or control moves, nothing hidden is revealed, the
  expected elements extend or stay put, the page doesn't stay scrolled
  sideways and turning Duofari off restores the DOM byte for byte. Of these,
  only the sideways-scroll check runs on the `spa` case, whose page changes
  as it navigates. Pixel probes check what the column shows (art, a band's
  colour or the page background) and that chosen pixels inside the page
  don't change.
- Chromium cannot show WebKit's compositing, the start-side clamp, Safari's
  fill, the touch-action reset or Safari's zoom rules. `node test/serve.mjs`
  serves `test/device/index.html` and the fixtures on the LAN for a check on a
  device or in the Simulator.

## 5. Packaging

- **`extension/`** is the single source of the web extension. It uses
  Manifest V3 and plain JavaScript with no bundler.
  - Permissions: `storage`, `nativeMessaging`, `scripting` and `activeTab`.
  - Host permissions: `*://*/*`.
  - Content scripts: on `http` and `https` pages at `document_idle`, with
    `all_frames: false`.
  - A background script (`background.js`), and Safari 18.0 as the minimum.
- **`npm run package`** (`node scripts/package.mjs`) writes
  `dist/Duofari-<version>.zip`, with the version from `manifest.json`.
  - It first checks that every file the manifest refers to exists and that
    every JSON file parses.
  - It skips dotfiles, `.DS_Store` and `Thumbs.db`.
  - The archive is reproducible: files are sorted and timestamps are fixed.
  - It writes the ZIP itself, with its own CRC-32, so any Node.js 22 runs it.
  - It is meant for App Store Connect's Safari web extension upload or for
    loading in Safari's developer settings.
- **`npm run xcodeproj`** (`python3 scripts/gen-xcodeproj.py`) generates
  `apple/Duofari.xcodeproj`. The project is an iPhone app that embeds a Safari
  web extension target, structured like Apple's WWDC26 sample.
  - The extension target references the files in `../extension` directly, so
    an Xcode build and the zip carry identical code. Top-level files are added
    one by one; `images` and `_locales` are added as folder references.
  - Swift files, asset catalogs, privacy manifests and string catalogs come
    from `apple/Duofari` and `apple/Duofari Extension`.
  - Flags:
    - `--bundle-id` (default `com.example.Duofari`). The extension gets
      `.Extension` appended, which the app relies on to find it.
    - `--team`, for automatic signing.
    - `--version` (default: the `manifest.json` version).
    - `--build` (default 1). The checked-in project uses build 1. Pass a higher
      number for each upload, for example `--build $(git rev-list --count HEAD)`.
  - Deployment target iOS 27.0, iPhone only (`TARGETED_DEVICE_FAMILY = 1`),
    Swift 5.
  - Object identifiers derive from stable names, so regenerating an unchanged
    tree produces an identical file. Run it again after adding or removing
    files in `extension/` or `apple/`.
- **`npm run icons`** renders `scripts/icon.svg` and `scripts/toolbar-icon.svg`
  into the PNGs the extension and the app need.
- **`npm run fixture-images`** draws the JPEG photos the fixtures use.

## Sources

Apple:

- Forum thread 847864 (Safari disables the vertical bar at regular width):
  https://developer.apple.com/forums/thread/847864
- Forum thread 847644 (no web detection; Viewport Segments and Device Posture
  flags): https://developer.apple.com/forums/thread/847644
- iPhone Duo Prepare page: https://developer.apple.com/iphone-duo/prepare/
- HIG, Designing for iPhone Duo:
  https://developer.apple.com/tutorials/data/design/human-interface-guidelines/designing-for-iphone-duo.json
- Tech Talks 111461 and 111466:
  https://developer.apple.com/videos/play/tech-talks/111461/ and
  https://developer.apple.com/videos/play/tech-talks/111466/
- Tech Talk 111462 (vertical bar with Reduce Transparency), transcript
- Safari 27 release notes (scroll anchoring, `scrollTo` during momentum)

WebKit (`main`):

- `LocalFrameView.cpp` (`fixedContainerEdges`)
- `WKWebView.mm` (fixed colour extension views)
- `WKWebViewIOS.mm` (`env()` insets)
- `ViewportConfiguration.cpp`
- Commit 318137@main: https://commits.webkit.org/318137@main
- Read during the design reviews: `RenderLayerBacking.cpp`, `RenderBox.cpp`,
  `StyleAdjuster.cpp`

Third-party measurements and prior art:

- fold-ready: https://raw.githubusercontent.com/tyoukyou23/fold-ready/main/src/devices.ts
- render-harness: https://github.com/Ahmed-Badr00/render-harness/pull/2
- Mike Piontek: https://mikepiontek.com/journal/iphone-duo-safari.html
- Blake Crosley: https://blakecrosley.com/blog/xcode-27-1-beta-iphone-duo-simulator
- Firefox for iOS: https://github.com/mozilla-mobile/firefox-ios/pull/36231
- Widen: https://github.com/pedantique/widen-site
- OutSpan: https://www.outspan.app/
