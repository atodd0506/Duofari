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
`content-main.js` also stops in frames (`top !== self`) and in non-HTML
documents (SVG, XML).

### 2.1 Detecting the column (`content-geometry.js`)

```
if visualViewport.width < layoutWidth − 1                → 'zoomed' (controller keeps its state)
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
  `nativeScale` and the hardware model. The answer is stored as `device` in
  `storage.local`, and the content scripts use it when `screen` doesn't look
  like a Duo.
- **Unfolded.** `layoutWidth × scale` (951 or 669) is larger than the screen's
  side, so `columnPt` is negative and the reason is `no-column`. Duofari is idle
  on the inner display at full screen, as Safari has no column there.
- **A window, not 84.** Safari's column measured 84 in every web measurement,
  but Duofari always measures. 60–110 pt accepts small variations and rejects
  leftover widths that can't be Safari's column.
- **Pinch zoom.** While the visual viewport is narrower than the layout
  viewport the arithmetic doesn't hold. The controller keeps its previous
  answer until the user zooms back out. The scale at rest still enters the
  formula, so a page that starts zoomed out gets the right `C` in CSS px.
- **Desktop layout** is read from the last viewport meta. No meta means
  desktop. A meta without `width=` means desktop unless it has `initial-scale`.
  `width=device-width` is mobile. A numeric width is desktop only when it is
  wider than the screen's side plus 1. v1 used `scale < 0.95` instead, which
  misfired under Safari's page zoom.
- **Landscape side.** Which side the column is on in landscape is unconfirmed.
  The Auto guess is that Safari keeps its controls beside the outer camera,
  which ends up on the left at angle 90. Because the guess may be wrong, Auto
  extends bands only in landscape and leaves `<img>` and `<video>` alone. A
  wrong guess then has no visible cost: background overflow on the far side
  lands off-screen and the guard holds it still, while widened images would
  have been cropped for nothing. Picking Left or Right in the popup turns
  images back on.
- **Start side.** Pages can only paint toward their end edge (§1). Two cases
  stay off: right-to-left pages with the column on the right (portrait, and
  landscape right), and left-to-right pages with the column on the left. A
  right-to-left page with the column on the left extends leftward through the
  mirrored code path. A unit test covers its geometry, but no fixture does.

`measureColumn` returns a `reason`, which the popup shows:

| Reason | Popup title |
|---|---|
| `column` | "Extended …" or "On, nothing to extend yet" |
| `not-duo` | Not an iPhone Duo |
| `no-column`, `unexpected-width` | Nothing to extend here |
| `desktop-layout` | Desktop layout |
| `start-side` | Controls on the wrong side |
| `reduced-transparency` | Reduce Transparency is on |
| `unstable` (controller, §2.7) | Paused on this page |
| `disabled`, `site-disabled`, `excluded-site` (controller) | Duofari is off / Off for this site / Off for this web app |

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
viewport heights.

**The walk.**

- **Budget.** At most 6,000 visits and 12 ms per run (`SCAN_BUDGET`,
  `SLICE_MS` in `content-main.js`). A scan cut short continues in a later run,
  and the debug badge shows "partial".
- **Window.** Elements that end more than 2 viewport heights above the top of
  the visible area, or start more than 4 viewport heights below it, are
  skipped. A scroll of more than half a viewport since the last scan schedules
  a new one.
- **Never entered:** `script`, `style`, `link`, `meta`, `template`, `noscript`,
  `br`, `wbr`, `head`, `title`, `source`, `track`, `area`, `map`, `option`,
  `optgroup`, `datalist`, `param`, `iframe`, `frame`, `frameset`, `object`,
  `embed`, `input`, `select`, `textarea`, `button`, `dialog`, `svg`, `math`,
  `audio`, `slot`, `canvas`, and Duofari's own nodes (`data-duofari-ui`).
- **Zero-size** elements are skipped, except `display: contents`, which is
  walked through. Open shadow roots are walked, and the controller starts
  observing each one it meets.
- **Edge tests.** For the right edge: *at* means `|right − layoutWidth| ≤ 1.5`;
  *past* means `|right − (layoutWidth + C)| ≤ 1.5`; *near* means within 48 px
  of the edge, used only when breakout is on. A box that overflows the edge by
  any other amount (a carousel track, a broken layout) is pruned with its
  subtree. A box that does not reach the edge is still entered when its
  `scrollWidth` does, which finds `width: 100vw; margin-left: calc(50% - 50vw)`
  breakouts inside a narrower article column.
- **Pruned with their subtree:** `display: none`, `visibility: hidden` or
  `collapse`, `opacity: 0`, `checkVisibility({ contentVisibilityAuto: true })`
  false; `position: fixed` boxes at least 0.9 viewport heights tall (menus,
  modals, dimming layers, which Safari's sampler would cover with an opaque
  fill anyway); and transforms other than a plain translation, or the `scale`
  and `rotate` properties, because their rects disagree with layout.
- **Left as they are, but entered:** boxes that already reach `C` past the edge
  (the site's own `100vw`, or art that grew with an extended parent), elements
  rejected earlier in the same layout at the same size, elements blocked by the
  re-apply limit (§2.7), and elements with running animations
  (`getAnimations()`).

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
`[data-carousel]`) or one with `scroll-snap-type`. Its band background may
extend, but Duofari does not descend into it, so slides never move.

**Scroll containers.** The walk does not descend into an element that actually
scrolls (overflow `auto` or `scroll` with content larger than the box), so
carousels, tab strips and code blocks keep their own layout. The exception is
a page-sized scroller: full width and at least 0.6 viewport heights tall. That
is an app shell scrolling instead of the document. Duofari walks into it and
registers it with the guard so it is held still too (§2.5). Elements on the
spine whose computed overflow is `auto` or `scroll` but which do not scroll
sideways are collected as **touch roots** for the guard, together with `html`
and `body`.

**Clipping ancestors.** Before anything is extended, every ancestor that would
clip it gets the padding recipe, so the clip reaches into the column too.
Ancestors are followed by containing block: an absolutely positioned box
escapes clippers below its containing block, and a fixed box escapes everything
up to a transformed ancestor. `html` never counts. `body` counts only when
`html`'s own overflow is not `visible`, because otherwise `body`'s overflow is
propagated to the viewport. This handles the common `html, body { overflow-x:
hidden }`, where `body` really clips. If a clipper cannot be extended, the
element is not extended either.

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
fixed descendant appears. Whether the lift makes the bar paint under Safari's
column is unverified on a device.

Media are covered in §2.4.

### 2.3 Extending a box without moving its content (`content-bleed.js`)

**Bookkeeping.** Every change is an inline `!important` declaration. Inline
`!important` beats ordinary site CSS and author `!important` utilities, and it
reaches into shadow roots. For each property Duofari saves the page's own
inline value and priority before the first write, and remembers the page's
whole `style` attribute from the first time it touched the element.

- **Exact restore.** Reverting puts each property back, or removes it. Then
  `tidyStyleAttribute` compares declarations: if they match the page's original
  attribute, the original string is written back byte for byte. If the page had
  no `style` attribute and nothing is left, the attribute is removed. The
  attribute is read first, which flushes the engine's lazily serialised inline
  style; removing it while that is pending can leave `style=""` behind.
- **Clone marks.** A changed element carries `data-duofari`, holding the saved
  originals as JSON (`[[property, value, priority], …]`). When the page copies
  an element (a sticky-header clone, a carousel loop slide), the copy carries
  the mark but Duofari has no record of it. The controller finds such copies
  among added nodes and restores them from the JSON.
- **No transitions.** Each apply, verify and revert runs inside
  `withoutTransitions`: `transition: none !important` is set, the work is done,
  the computed style is flushed, and the page's own `transition` is put back.
  Without this, `transition: all` would animate the change, measurements would
  read the starting values, every recipe would fail, and reverts would animate.
- **Detached elements** are reverted when they leave the document, in case the
  page puts them back.

**Recipes.** For an extension of `C` px on the right (the left is the mirror
image):

1. **Border recipe** (default for bands): `margin-right: m − C;
   border-right: (b + C)px solid transparent; background-clip: border-box`.
   The padding box doesn't change, so nothing positioned against it moves.
   `background-origin` is set per background layer. Layers that scale with the
   box (gradients, `cover`, percentage sizes, repeating tiles) take
   `border-box`. A positioned `no-repeat` image (an icon, a centred logo)
   keeps its own origin. It stays exactly where it was, and only the colour
   extends. Scaling layers do rescale: a `cover` background grows by up to
   (382 + 84) / 382 ≈ 1.22 in portrait and recentres.
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
  cover layer is an absolutely positioned child with no text and nothing
  interactive whose left and right edges match the padding box within 1.5 px,
  such as a hero image at `inset: 0` or a dimming overlay. Positioned
  `::before`/`::after` boxes that fill the padding box also count. A border
  extension would leave a seam of bare background beside them.
- The padding recipe is skipped when the element clips and something hidden
  would show. Duofari walks the subtree, up to `HIDDEN_SCAN_LIMIT = 12000`
  nodes; past that it assumes yes. It looks for any visible descendant in the
  strip the column would open up: an off-canvas menu, the rest of a tab strip.
- A cache keyed by tag, class, `display`, `position`, `box-sizing` and the
  parent's `display` tries the last recipe that worked for that signature
  first.

**Verify after each attempt.** Duofari re-measures. Tolerances are
`EPS = 0.75` px for unchanged boxes and `EDGE_EPS = 1.25` px for the extended
edge. It accepts the attempt only if all of these hold:

- the border box now ends exactly `C` further out, its other edge, top and
  height are unchanged;
- the content box is unchanged on both sides;
- the first and last in-flow children have the same left, right and top;
- positioned `::before`/`::after` boxes that aren't cover layers have the same
  computed `left`, `width`, `top` and `height`;
- padding recipe only: absolutely positioned children whose containing block
  is the element are where they were. Duofari collects up to
  `ABS_KEEP_LIMIT = 400` of them, visiting at most `ABS_SCAN_LIMIT = 2000`
  nodes. Cover layers are expected to grow (see below). Any other child that
  moved, such as a hamburger at `right: 16px`, is pinned back with an explicit
  `left`, `right: auto` and `width`, and must end up exactly in place.

If the geometry was off, Duofari retries with width compensation. If the
geometry was fine but a child or pseudo-element moved, compensation can't help,
and it moves on to the next recipe. If nothing passes, everything is reverted,
and the element is remembered as rejected for this layout and size.

**Cover layers in the padding recipe.** A cover `<img>` or `<video>` that is
`object-fit: cover` and has at least `C` of cropped-away art on the column
side gets its `object-position` pinned to its current pixel offset. Its visible
part stays put, and the column shows the art the crop was hiding, pixel for
pixel. Without enough cropped art, a cover layer with `object-fit: fill` is
switched to `cover`, so it is re-cropped rather than stretched. Other cover
layers simply grow with the box.

**Menus that open later.** A positioned child that appears after a band was
extended with the padding recipe is laid out against the grown padding box. A
search panel or menu could land under the column. On every scan, Duofari
finds such newcomers that reach into the column and adds `C` to their `right`.
If that doesn't bring one back (it was positioned by its other edge), the pin
is dropped.

**Re-checking.** On each scan an applied element is still valid only if all of
these hold:

- the site hasn't overwritten Duofari's declarations;
- its edges are where the extension put them (±1.25 px);
- its parent's content box hasn't moved;
- its pins are still attached and intact.

Height changes are accepted for boxes, for example a header that shrinks on
scroll. When the site changes the `class` or `style` of an applied element,
the element is marked dirty. It is reverted and measured again from the site's
own styles, so Duofari never keeps padding, margin or width values frozen from
an older layout.

### 2.4 Media: Reveal, Fill and breakout

Only `<img>` and `<video>` are treated as media. `canvas`, inline SVG, iframes
(players, maps) and `video[controls]` are never touched. The "Lead image and
wide artwork" setting (`media`) controls all of it.

A picture is a candidate only if:

- it is at least 100 px tall and not hidden;
- its `object-fit` is not `contain`, `scale-down` or `none`;
- an `<img>` has loaded (it is scanned again on `load`) and has no `usemap`;
- a `<video>` is background video: no `controls`, muted or autoplaying, looping
  or autoplaying, and not inside a known player (`.html5-video-player`,
  `.video-js`, JW Player, Brightcove, Plyr, MediaElement, Shaka, Vimeo,
  `[data-player]`, `.video-player`).

Pictures with more than 2 absolutely positioned text labels over them, within
two ancestor levels, are skipped. Their pixels must not move under the labels.

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
  reader is looking at, or has scrolled past, ever grows;
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
scroll range (the *allowance*). The guard then does three things:

1. **Touch-action lock.** With "Hold pages steady" (`holdSteady`) on, while not
   zoomed in, and only when the page had no horizontal overflow of its own
   (allowance < 1 px):
   - `touch-action: pan-y pinch-zoom !important` goes on `html`, `body` and
     every touch root from the scan. Touch roots are spine wrappers whose
     computed overflow is `auto` or `scroll` but which don't scroll sideways.
     WebKit resets `touch-action` at those (§1), so `html` alone would not be
     enough.
   - `overscroll-behavior-x: none` goes on `html`.

   Real horizontal scrollers (carousels) are not locked. `touch-action`
   resets at them, so they keep panning. Pinch zoom keeps working.
2. **Snap-back.** A capture-phase `scroll` listener watches the root (window,
   `html` or `body`) and any registered app-shell scroller. The root may rest
   anywhere in `[0, allowance]` (`[−allowance, 0]` for right-to-left pages);
   app shells rest at 0.
   - A drift that arrives while scrolling was idle and no finger is down is a
     programmatic jump (focus, an anchor, find-in-page). It is put back at once.
   - Any other drift waits until there are no touches and no scroll events for
     `SETTLE_MS = 150` ms, or for `scrollend`.
   - The correction is relative: `scrollBy({ left: −dx, top: 0, behavior:
     'instant' })`. It never sets an absolute vertical position, so it can't
     fight a vertical fling with a stale `scrollY`.
3. **Zoom.** When `visualViewport.scale` exceeds the resting scale × 1.02, the
   lock comes off and snap-back pauses, so a zoomed page can be panned freely.
   Both return when the user zooms back out.

While the page is drifted, the controller postpones scans by 200 ms. Rects
would otherwise be measured shifted, and every band would look invalid.

Pages with their own horizontal overflow (a wide table with no scroll wrapper)
get no lock, so that content stays reachable. They get no viewport meta change
either (§2.6). Snap-back only acts beyond their own range.

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
`initial-scale`. It appends whatever is missing of `initial-scale=1` and
`minimum-scale=1`.

- `minimum-scale=1` matters on its own. A user who has zoomed once could
  otherwise be snapped to the new, lower minimum when content grows (SOURCE).
  Zooming out below 1 never showed anything on these pages anyway. Zooming in
  is untouched.
- Duofari never adds `viewport-fit`, `maximum-scale` or `user-scalable`.
- The observer watches the `content` attribute. When a head manager (Next.js,
  React Helmet) rewrites the meta, Duofari re-applies its additions, up to 5
  times per page, then leaves the page alone.
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

### 2.7 Keeping up with the page (`content-main.js`)

| Constant | Value | Use |
|---|---|---|
| `MIN_INTERVAL` | 300 ms | minimum time between runs; requests in between are merged into one trailing run |
| `RESIZE_SETTLE` | 250 ms | quiet time after the last resize before a fresh run |
| `SCAN_BUDGET` | 6000 | visits per run |
| `SLICE_MS` | 12 ms | time per run; the rest continues in a later run |
| `FLIP_LIMIT` / `FLIP_WINDOW` | 4 / 10 s | on/off changes allowed before standing down |

**A run.**

1. Skip while the document is hidden.
2. Measure the column. While pinch-zoomed in, change nothing.
3. While the page is drifted, try again in 200 ms.
4. Decide whether to be active: global switch, site state, column width,
   flip back-off.
5. If the geometry changed (width, side, the images flag or the layout width),
   revert everything and start from the page's own layout.
6. On activation, measure the allowance, probe `100vw` and fix the viewport
   meta, in that order.
7. Drop records of removed elements, then scan.
8. Enable the guard with the touch roots and app shells the scan found, then
   update the debug view.
9. Discard the mutation records caused by Duofari's own writes.

**Triggers.**

- A `MutationObserver` on the document and on each open shadow root. It
  watches `childList` and the `class`, `style`, `src`, `srcset`, `hidden`,
  `open`, `content` and `aria-expanded` attributes.
- `load` and `loadedmetadata` of images and video (capture phase), and the
  window's `load`.
- A `ResizeObserver` on `<body>`.
- `resize`, `orientationchange` and `visualViewport` resize.
- A scroll of more than half a viewport height since the last scan.
- SPA navigation: `popstate`, `hashchange`, and the Navigation API's
  `navigatesuccess`.
- `pageshow` (back/forward cache), `visibilitychange`, `document.fonts.ready`.
- Settings changes.

**Mutation filtering.**

- Added and removed elements count, except Duofari's own nodes.
- Each added subtree is checked for clone marks (§2.3).
- A `class` or `style` change on an applied element marks it dirty.
- A `style` change on any other element is ignored. That covers Duofari's own
  writes and the page's animations.
- Other attribute changes count unless the element is busy. An element that
  changes more than 10 times in a second is ignored for 5 s.
- After every batch, lifts are re-checked (§2.2).

**Fold, unfold and rotation.** On a resize that changes the layout width,
Duofari reverts everything at once. Pinned widths from the old layout would
otherwise flash at the new size. It re-applies 250 ms after the last resize,
once the transient sizes have passed.

**Back-off.**

- **Flips.** More than 4 changes between on and off within 10 s, for example a
  page and Duofari's zoom effects feeding each other, puts the page in
  `unstable`. The popup shows "Paused on this page". The pause is cleared by
  SPA navigation and by a settings change. The content script also clears it on
  a `duofari:rescan` message, but nothing in the extension sends that message
  at present.
- **Style fights.** When a site overwrites Duofari's declarations on an element
  more than 6 times in 10 s, the element is left alone for the rest of the page
  view. This follows Dark Reader's pattern. Layout or class changes that leave
  the declarations intact don't count.
- **Head managers.** Viewport meta rewrites are re-applied at most 5 times.

**Off switch.** A global or per-site disable, a column of 0, or the flip
back-off makes Duofari:

- revert every element;
- remove the guard (touch-action and overscroll values restored, listeners
  removed);
- restore the viewport meta;
- remove the debug view.

### 2.8 Settings and the popup

Settings live in `storage.local`. The code notes that `storage.sync` doesn't
sync in Safari. Content scripts get changes through `storage.onChanged` and
apply them at once. A change to `bands`, `media`, `allImages`, `breakout`,
`landscapeSide`, `desktopPages`, `force`, `forceColumn` or `device` reverts
everything first and starts again from the page's own layout.

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

**Status and site access.** The popup asks the open tab's content script for
its status (`duofari:status`):

- A non-web page shows "Duofari can’t change this kind of page".
- If nothing answers and Safari hides the tab's address, Duofari has no access
  to the site. The popup shows "Duofari can’t see this site yet" with **Allow
  on All Websites**. That calls `permissions.request({ origins: ['*://*/*'] })`
  and, if granted, injects the content scripts into the open tab with
  `scripting.executeScript`, so no reload is needed. The file list comes from
  the manifest.
- If nothing answers but the address is visible, the page was open before
  Duofari was. The popup offers **Apply to This Page**, which injects the
  scripts and falls back to reloading the tab.
- Otherwise it shows what happened, for example "Extended 3 bars and 2 images"
  and "Safari’s controls take 84 points on the right.", or the reason from
  §2.1. Counts use `Intl.PluralRules` and `Intl.ListFormat`, and all strings
  are in `_locales/en/messages.json`.

The popup also asks `background.js` to refresh the device info from the app.

**Diagnostics** (under More) lists the raw inputs: `screen`, `dpr`,
`clientWidth`, `innerWidth`, `innerHeight`, `visualViewport`, `orientation`,
`direction`, `viewportMeta`, `columnPoints`, `columnCss`, `side`,
`vwIncludesColumn`, `ownOverflow`, `touchLock`, `deviceFromApp`, `userAgent`,
`reason` and `counts`. **Copy** puts them on the clipboard, or selects the text
when the clipboard is refused.

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
- The slides inside carousels and sliders, players, `canvas`, inline SVG, form
  controls and dialogs; and tables, inline boxes and interactive elements as
  bands.
- Charts, screenshots and comics, except where Reveal can show cropped-away
  art without rescaling. Full-width pictures with text labels positioned over
  them are skipped in every mode.
- Full-height fixed overlays, elements with non-translation transforms, and
  elements that are animating.
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
  check this on every active case except the scripted ones (`menus`, `clone`,
  `spa`), and `test/run-live.mjs` checks it on live sites.

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
  extends only backgrounds, with no images, in landscape. The user can pick
  the side under "Safari’s controls in landscape".
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

- `npm test` runs the unit tests (`test/unit/geometry.test.mjs`, `node:test`),
  the 23 fixture cases (`test/run-fixtures.mjs`) and the popup states
  (`test/run-popup.mjs`, with a mocked browser API).
- `npm run test:live` runs the same invariants against 16 live sites.
- The fixtures emulate the folded Duo in Playwright/Chromium (`test/lib/duo.mjs`):
  - a 382 × 580 viewport, a 466 × 678 screen and DPR 3;
  - the screen orientation set through CDP and re-applied after screenshots;
  - a shim that pins Chromium's minimum scale the way Safari keeps it.
- They check that no text moves, nothing hidden is revealed, the page doesn't
  stay scrolled sideways and turning Duofari off restores every element. Pixel
  probes check that the column shows art, not page background.
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
