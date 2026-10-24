# Testing Duofari

Duofari is tested in two ways:

1. **Automated tests** run the extension's content scripts in headless Chromium through
   Playwright. The browser is set up to look like Safari on the folded iPhone Duo: a 382 × 580
   layout viewport, a 466 × 678 screen and a pixel ratio of 3.
2. **Manual tests** run the real extension in Safari, in the Xcode 27.1 iPhone Duo Simulator or
   on an iPhone Duo.

> **Status.** So far Duofari has been checked only in Chromium emulation, against WebKit
> source, and against other developers' Simulator measurements. Nobody has run it on iPhone Duo
> hardware yet. The automated tests cannot show what Safari really paints under its column, how
> fixed bars are composited, when Safari covers the column with a solid colour, or how touch
> behaves. Those need a device or the Simulator. Section 3 lists the open questions and what
> each answer would change in the code.

Contents:

- [1. Automated tests](#1-automated-tests)
- [2. Manual testing in the Simulator and on iPhone Duo](#2-manual-testing-in-the-simulator-and-on-iphone-duo)
- [3. Open questions only hardware can answer](#3-open-questions-only-hardware-can-answer)

## 1. Automated tests

### Setup

You need Node.js 22 or later. Playwright 1.63 is a dev dependency.

```sh
npm install
npx playwright install chromium
npm test
```

`test/lib/playwright.mjs` looks for Playwright in the repository's `node_modules` first, then in
the global npm folder (`npm root -g`). So the tests also run where Playwright is installed
globally.

### What each npm script runs

| Script | Command | What it checks | Needs |
|---|---|---|---|
| `npm test` | `test:unit`, then `test:fixtures`, then `test:popup` | Everything except live sites. The scripts are joined with `&&`, so the run stops at the first failing suite. | Chromium |
| `npm run test:unit` | `node --test "test/unit/*.test.mjs"` | Column detection (`content-geometry.js`) and the per-site switches (`shared-settings.js`). | Node only |
| `npm run test:fixtures` | `node test/run-fixtures.mjs` | 23 cases on the pages in `test/fixtures/`, in the emulated folded Duo. | Chromium |
| `npm run test:popup` | `node test/run-popup.mjs` | 9 popup states, with a stand-in for Safari's extension APIs. | Chromium |
| `npm run test:live` | `node test/run-live.mjs` | The same invariants on 16 live websites. Not part of `npm test`. | Chromium, network |

Two related scripts:

- `npm run fixture-images` runs `scripts/build-fixture-images.mjs`. It redraws the JPEGs in
  `test/fixtures/img/`. The output is deterministic. The pictures have colour bands at known
  positions, so a pixel probe can tell which part of a picture shows under the column.
- `npm run package` runs `scripts/package.mjs`. Before it writes the zip, it checks that every
  file `manifest.json` refers to exists and that every JSON file in `extension/` parses.

### Unit tests (`test/unit/geometry.test.mjs`)

The unit tests load `shared-settings.js` and `content-geometry.js` into a `node:vm` context with
no DOM. They call `Duofari.measureColumn(settings, env)` with made-up page measurements. There
are 20 tests:

- **The folded Duo.** Finds the 84-pt column on the right. Measures it in CSS pixels when the
  page starts zoomed out: with `initial-scale` 0.5 the column is 168 CSS px.
- **Display Zoom.** Follows it: the test models a 414 × 602 screen with a 340-px layout and
  expects a 74-pt column. These numbers are an assumption, not a measurement.
- **Where it stays idle.** The unfolded inner display. A page that fills the outer display. A
  leftover width that is not a plausible column (`unexpected-width`). Other iPhones. iPads,
  which have a similar shape but a scale of 2.
- **Private Browsing.** When Safari reports a generic screen, Duofari uses the screen size from
  the containing app (`settings.device`).
- **Settings and states.** `force` mode simulates the column on any device. While the user is
  pinch-zoomed in, Duofari keeps its previous answer (`zoomed`). Desktop-layout pages are
  skipped unless `desktopPages` is on. With it on, the column becomes 215.5 CSS px on a
  980-px page. `device-width`, narrow fixed widths and scale-only metas count as mobile
  layouts. Reduce Transparency turns Duofari off.
- **Landscape.** At angle 270 under **Auto**, the column is on the right and only backgrounds
  extend (`media: false`). Choosing **Right** extends images too. At angle 90, or with **Left**
  chosen, the column is on the start side and Duofari stays off. Landscape is read from
  `(orientation: landscape)` when the Screen Orientation API is missing.
- **Right-to-left pages.** They are off in portrait. In landscape they are on when the column is
  on their end side (the left).
- **Helpers.** `sameGeometry` notices changes that need a fresh layout. `siteState` and
  `sitePatch` handle the built-in web-app exclusions and the user's per-site choices.

### Fixture tests (`test/run-fixtures.mjs`)

#### How a case runs

For each case the runner:

1. Opens a new browser context in the case's pose (see
   [the emulation](#how-the-emulation-approximates-safari-testlibduomjs)), loads the fixture
   page from a local server and applies the minimum-scale shim.
2. Marks the elements named in the case's `expect`, `same` and `probe` fields with test
   attributes. Many fixture elements already carry `data-expect` in their HTML.
3. Takes a full-page screenshot, the page's `outerHTML` and a snapshot of where every text run
   and control sits. These are the "before" state.
4. Injects the six content scripts in manifest order, as one script, with the case's settings.
   It then waits 450 ms and two animation frames. This stands in for Safari running them at
   `document_idle`.
5. Runs the checks below, writes a before/after preview, then turns Duofari off through
   `Duofari.controller` and compares the page with the "before" state.

The runner prints `✓` or `✗` for each case, with Duofari's reason and the number of changed
elements. It exits with status 1 if any case failed.

```sh
node test/run-fixtures.mjs                # all 23 cases
node test/run-fixtures.mjs blog news      # cases whose name contains "blog" or "news"
VERBOSE=1 node test/run-fixtures.mjs      # also print each changed element (kind/recipe element)
```

A filter matches parts of names, so `blog` also runs `blog-breakout`, and `landscape` runs all
three landscape cases.

#### What is checked

For every case:

- Duofari started, and it is active or inactive as expected, with the expected reason
  (`start-side`, `desktop-layout`, `no-column`, `not-duo`, `disabled` or `site-disabled`).
- An inactive case changed nothing.
- The page logged no errors and no `[Duofari]` warnings.

For active cases:

- **Column.** The measured column is 84 px (±0.5). At least `min` elements were extended.
  Pinned children and clippers are not counted.
- **Bookkeeping.** The number of elements carrying `data-duofari` equals the number of records,
  open shadow roots included.
- **Text never moves.** No text run moves sideways by more than 0.75 px, and none ends up
  in the column. Vertical positions are not compared, because an image that grows pushes text
  down. Only the opt-in breakout makes an image grow.
- **Nothing hidden is revealed.** No text that was clipped before becomes visible beside the
  layout viewport. Examples are a closed off-canvas drawer, or content waiting to slide in.
- **Controls never move.** Buttons, inputs, selects, text areas and links keep their
  horizontal position (±0.75 px).
- **Annotated expectations.**
  - `data-expect="bleed"`: the element's edge now reaches the column's outer edge (±1 px).
  - `data-expect="breakout"`: the element spans from 0 to the column's outer edge.
  - `data-expect="inset"` or `"none"`: the element stays where it was.
  - `data-pseudo-check`: the element's `::before` and `::after` boxes did not move.
- **Pixel probes.** These read pixels from full-page screenshots taken before and after Duofari.
  Column probes compare the "after" pixel with the page's background colour:
  - `data-probe-column="image"`: the middle of the column strip shows the art, not the page
    background.
  - `data-probe-column="page"`: it shows the page background.
  - `data-probe-column="#rrggbb"`: it shows that colour.
  - `data-probe-same="x1,x2,…"`: those points inside the page look the same as before.
- **Scroll width.** When the column is on the right and a non-fixed element was extended, the
  document is at least as wide as the layout viewport plus the column. Otherwise nothing could
  show there.
- **App shells.** The app shell's scroller did not become sideways-scrollable. This applies to
  `app-shell`.
- **Holding still.** After `scrollTo(60, y)`, the page is back at `scrollX` 0 within 450 ms, and
  `touch-action` on `<html>` contains `pan-y`.
- **Clean undo.** After Duofari is turned off, `document.documentElement.outerHTML` is
  byte-for-byte what it was before.

The `menus`, `clone` and `spa` cases skip the text, control and expectation checks and the
byte-for-byte undo check. They run their own checks instead, listed in the table below.

#### Fixture cases

All cases use the folded portrait pose unless the table says otherwise. "≥ n" is the minimum
number of extended elements.

| Case | Page | Pose / settings | Expected | What it covers |
|---|---|---|---|---|
| `appstore-story` | `appstore-story.html` | | active, ≥ 2 | The App Store story layout. The hero header and its cover-cropped image reach under the column. The column shows more of the picture, not page background. Three points inside the page (x = 60, 200, 300) look the same as before. The caption and close button stay put. |
| `blog` | `blog.html` | | active, ≥ 3 | Sticky green header, the site's own `100vw` band and the footer extend. The lede photo, figure, pull quote, code block and card stay inside the article. The viewport meta starts as `width=device-width` only and must end up with both `initial-scale=1` and `minimum-scale=1`. |
| `blog-breakout` | `blog.html` | `breakout: true` | active | The figure photo, which is below the first screen, breaks out to the full width plus the column. |
| `news` | `news.html` | | active, ≥ 6 | A fixed masthead that changes height on scroll, a section nav that scrolls sideways, a lead image in a ratio box, a headline band, a carousel band whose slides do not move, a promo, and a fixed cookie bar. The two-column grid is left alone. |
| `edge-cases` | `edge-cases.html` | | active, ≥ 8 | Numbered layout patterns. Among them: `width: 100%` with `border-box` and a positioned button, `max-width: 100%`, a grid full-bleed row, a band inside a transformed ancestor, a background-image hero, a clipping wrapper around an image (probe: art shows). Left inside the page: a video with controls, an iframe, `background-clip: text`, an `object-fit: contain` image, a `border-image` band, a float. Also an inline-block band, a table, a band the same colour as the page, a band inside an open shadow root, a hidden fixed modal, and a footer in a flex-column body. |
| `compat` | `compat.html` | | active, ≥ 6 | Patterns from real sites. An accordion chevron drawn by `::after` must not move. A row with a background-image chevron. A header with a centred logo. A ratio box with a cover photo and a badge (probe: art). A dimmed hero with a `::before` overlay (probe: `#005200`). A header with `transition: all`. A Bootstrap 4 column, an `aspect-ratio` hero, a Swiper-like carousel whose band extends but whose slides stay (probe: `#222222`), and a table that is left alone. |
| `images` | `images.html` | | active, ≥ 2 | Which images extend by default. The lead photo is widened and trimmed (Fill; probe: art). A second natural-aspect photo stays (probe: page background). A cover-fitted banner continues pixel for pixel (Reveal; probe: art). Stacked slices of one picture, an annotated graphic, an image named as a chart, and a video with controls all stay. |
| `images-all` | `images.html` | `allImages: true` | active | With **Every full-width image** on, the second photo extends too, and the column shows its art. |
| `overflow-root` | `overflow-root.html` | | active, ≥ 2 | `html, body { overflow-x: hidden }`. The body becomes a clipping box and has to reach into the column too. Header probe `#cc0000`, hero probe: art. |
| `app-shell` | `app-shell.html` | | active, ≥ 2 | A page that scrolls a `div` (`#app`) instead of the document. The shell reaches into the column but must not become sideways-scrollable. Bar probe `#0f766e`. |
| `menus` | `menus.html` | | active, ≥ 1 | Opens the menu and the search field after Duofari has run. Every menu link and the search input must end left of the column. |
| `clone` | `news.html` | | active | Copies the extended `.masthead` after Duofari has run, like sticky-header scripts do. The copy must not keep `data-duofari` or the `-84px` styles. |
| `spa` | `spa.html` | | active, ≥ 2 | A page that renders its content late and swaps it on `pushState`. The runner navigates to `/b` and back to `/a`, and Duofari must extend the new content. |
| `offcanvas` | `offcanvas.html` | | active, ≥ 2 | A closed drawer parked past the right edge inside an `overflow-x: hidden` wrapper must stay hidden, and that wrapper's band is left alone. The fixed header extends. A band in a wrapper that hides only transparent, waiting-to-animate content extends. |
| `landscape-right` | `appstore-story.html` | `landscape-right` (594 × 340, angle 270) | active, ≥ 1 | **Auto** in landscape: the header extends, the image stays (`inset`). |
| `landscape-right-pinned` | `appstore-story.html` | `landscape-right`, `landscapeSide: 'right'` | active, ≥ 2 | With the side chosen, images extend too. |
| `landscape-left` | `appstore-story.html` | `landscape-left` (594 × 340, angle 90) | off, `start-side` | A column on the left of a left-to-right page. |
| `rtl` | `rtl.html` | | off, `start-side` | A right-to-left page in portrait. |
| `desktop-layout` | `desktop.html` | | off, `desktop-layout` | A page with no viewport meta. |
| `unfolded` | `appstore-story.html` | `unfolded` (951 × 543) | off, `no-column` | The inner display at full screen. |
| `other-iphone` | `appstore-story.html` | `iphone` (402 × 714, screen 402 × 874) | off, `not-duo` | An ordinary iPhone. |
| `disabled` | `appstore-story.html` | `enabled: false` | off, `disabled` | The main switch. |
| `site-off` | `appstore-story.html` | `disabledSites: ['127.0.0.1']` | off, `site-disabled` | The per-site switch. |

### Popup tests (`test/run-popup.mjs`)

This runner serves `extension/` and opens `popup.html` in Chromium at 382 × 700 and DPR 2. It
replaces `browser.*` with a stand-in. The stand-in supports `i18n` (reading
`_locales/en/messages.json`), `runtime`, `storage.local`, `tabs`, `permissions` and `scripting`.
It also records what the popup asks for.

| Scenario | Popup shows |
|---|---|
| `active` | "Extended 3 bars and 1 image", the **On for** switch on. Turning the switch off saves `example.com` in `disabledSites`. |
| `one-of-each` | "Extended 1 bar" (singular forms). |
| `not-duo` | "Not an iPhone Duo". |
| `site-off` | "Off for this site", the switch off. |
| `excluded-site` | "Off for this web app" on `docs.google.com`, with the web-app note. |
| `unsupported` | "Duofari can’t change this kind of page", for a non-http URL. |
| `not-run-yet` | "Duofari hasn’t run on this page yet" with **Apply to This Page**. Tapping it injects the manifest's content scripts, and the status updates. |
| `no-access` | "Duofari can’t see this site yet" with **Allow on All Websites**. Tapping it requests `*://*/*`, then injects, and the status updates. |
| `dark` | Dark colour scheme. Opens **More** and **Diagnostics**: the text starts with `Duofari <version>` and contains `columnPoints: 84`. Choosing **Left** under **Safari’s controls in landscape** saves `landscapeSide: 'left'` and marks the segment as checked. **Enlarge photos inside page margins** saves `breakout: true`. |

Every scenario also checks:

- No `data-i18n` element is left empty.
- The popup asked the background script for device details (`duofari:refresh-device`).
- No script errors were logged.

The popup is rendered by Chromium here, not by Safari. Dynamic Type and Safari's popup sheet
are checked by hand (see the [matrix](#device-and-pose-matrix)).

### Live-site tests (`test/run-live.mjs`)

```sh
npm run test:live                              # the 16 built-in sites
node test/run-live.mjs https://example.org/    # specific pages
```

The built-in list is in `SITES` at the top of `test/run-live.mjs`. For each site the runner:

1. Opens a folded-portrait context with reduced motion.
2. Waits for `domcontentloaded` (30 s timeout), then up to 15 s for `load`, then 1.5 s more.
3. Applies the minimum-scale shim, takes a snapshot, injects Duofari and takes another snapshot.

It checks:

- No text or control moves sideways, no text moves into the column, and no hidden text is
  revealed.
- After `scrollTo(60, y)`, the page is no further sideways than its own overflow allows.
- After Duofari is turned off, no element is still modified (`Duofari.records` is empty). This is
  weaker than the byte-for-byte check the fixtures use.
- No script errors whose stack names a Duofari file.

The output marks each site:

- `✓` passed.
- `✗` failed. The first 12 failures are printed.
- `–` could not be tested (load error or timeout). This doesn't count as a failure.

The number after the counts is the time from injection until settled. It includes the fixed
450 ms wait, so it is not Duofari's own running time.

Live sites change, show consent banners and sometimes block headless browsers, so results vary
from run to run. A page that overflows the viewport by itself is flagged `emulationLimited`, and
its geometry checks are skipped (see below).

### How the emulation approximates Safari (`test/lib/duo.mjs`)

#### Poses

The Duo numbers come from other developers' Simulator measurements. The two landscape poses assume
a column whose existence and side are still unconfirmed.

| Pose | Viewport | `screen` | Column | `screen.orientation` |
|---|---|---|---|---|
| `folded` | 382 × 580 | 466 × 678 | 84, right | `portraitPrimary`, 0° |
| `landscape-right` | 594 × 340 | 466 × 678 | 84, probably right | `landscapeSecondary`, 270° |
| `landscape-left` | 594 × 340 | 466 × 678 | 84, probably left | `landscapePrimary`, 90° |
| `unfolded` | 951 × 543 | 466 × 678 | none | `landscapePrimary`, 90° |
| `iphone` | 402 × 714 | 402 × 874 | none | `portraitPrimary`, 0° |

Every context uses:

- `deviceScaleFactor: 3`, `isMobile`, `hasTouch`, and a Safari user-agent string. Duofari doesn't
  use the user agent for detection; it only appears in diagnostics.
- `screen` reports 466 × 678 in every Duo pose, including unfolded, as reported from the
  Simulator. Only the `iphone` pose uses a different screen.

The content scripts are joined in manifest order and added to the page as one `<script>`.
`extensionSource()` throws if the manifest's content-script list changes, so the harness can't
silently test a different set of files. There is no `browser.storage` in the page, so settings
come from `globalThis.__duofariTestSettings`. `loadSettings()` in `shared-settings.js` falls
back to that.

#### Chromium/WebKit differences the harness works around

- **Minimum scale.** Chromium lets a page with horizontal overflow zoom out to fit it, and then
  stretches the layout viewport and every fixed element to the overflow width. Safari keeps the
  minimum scale at 1 for `width=device-width` pages with an initial scale (WebKit's
  `ViewportConfiguration`), so fixed elements stay beside the column. To match that,
  `emulateSafariMinimumScale()` appends `minimum-scale=1` to a `device-width` viewport meta that
  has no `minimum-scale`. This runs before the "before" snapshot, so the shim is never counted
  as a change Duofari made.
- **Screen orientation.** Without help, Chromium derives the orientation from the screen size,
  and 466 × 678 always reads as portrait. `orientPage()` sets the pose's orientation with
  CDP's `Emulation.setDeviceMetricsOverride`. Playwright's screenshots reset that emulation,
  so the runners call `orientPage()` again after every screenshot. Otherwise the landscape
  cases would turn portrait halfway through.
- **Content Security Policy.** In Safari, content scripts are not subject to the page's CSP. The
  injected test script is, so contexts are created with `bypassCSP: true`.
- **Screenshots beyond the viewport.** Chromium captures the strip under the column by briefly
  resizing the view, which fires `resize`. `capturePair()` in `test/lib/preview.mjs` holds
  `resize` events back during the capture, so pages that lay themselves out in script don't
  reflow for the screenshot.
- **Fixed elements.** The minimum-scale shim keeps Chromium from widening fixed elements to the
  overflow width. Chromium has no equivalent of WebKit's clip on a fixed layer, so the fixtures
  cannot tell whether the identity `translate` that Duofari adds to fixed bars (`D.lift`) is
  needed or enough. They only check that it moves nothing.
- **Pages with their own overflow.** A live page that is already wider than its viewport makes
  Chromium widen the layout viewport, which Safari doesn't do at minimum scale 1. Geometry
  comparisons there mean nothing. `run-live.mjs` flags these pages `emulationLimited`
  (`innerWidth` larger than `clientWidth` before Duofari runs) and skips the text and control
  checks for them. The sideways-scroll and undo checks still run.

#### What the emulation cannot show

- **Safari's column.** Chromium has a 382-px viewport and nothing beside it. The previews draw a
  column on top afterwards. `test/lib/preview.mjs` models it on Mike Piontek's Xcode 27.1
  Simulator screenshots. The previews, including those in `docs/images/` (`appstore-story.png`,
  `news.png`, `blog.png`), are not device captures.
- **WebKit painting and compositing.** These are not emulated:
  - whether content past the layout viewport is painted under the obscured inset;
  - how fixed layers are clipped;
  - Safari's column tint and its solid fill over the column (`LocalFrameView::fixedContainerEdges`);
  - the glass effect.
- **Touch.** No touch gestures are simulated. The guard check uses a programmatic `scrollTo`
  and reads the computed `touch-action`. It cannot show whether Safari honours `touch-action:
  pan-y pinch-zoom` on the root, what happens to double-tap zoom and swiping back, or how
  pausing while pinch-zoomed feels.
- **Folding and unfolding.** Every case starts in a fresh context, so the sequence of resizes
  during a fold is not exercised. That covers `onResize` and `RESIZE_SETTLE` (250 ms) in
  `content-main.js`, and the on/off back-off.
- **Private Browsing and Reduce Transparency.** These are covered only by unit tests of
  `measureColumn`. The native-messaging round trip (`background.js` to
  `SafariWebExtensionHandler.swift`) is not tested at all. The popup test only checks that the
  popup asks for it.
- **Isolated worlds.** In Safari the content scripts run in an isolated world. In the harness
  they share the page's globals.

### Output files

`test/output/` is ignored by git. Runs overwrite files with the same name but do not delete old
ones. Clear the folder to remove previews of cases that no longer exist.

| Path | Written by | Contents |
|---|---|---|
| `test/output/<case>.png` | `run-fixtures.mjs` | Before/after preview: Safari on the folded Duo (left) and with Duofari (right). Only for active cases with the column on the right. |
| `test/output/<case>.dom-before.html`, `<case>.dom-after.html` | `run-fixtures.mjs` | Written only when the page differs after Duofari is turned off. Diff them to find what was not restored. |
| `test/output/report.json` | `run-fixtures.mjs` | One entry per case: `name`, `failures`, and `records`. Each record has `kind` (`band`, `media`, `breakout`, `pin` or `clipper`), `recipe` (`border`, `padding`, `fill`, `reveal`, `grow`, or empty for pins), `fixed` and `el`. |
| `test/output/popup/<scenario>.png`, `<scenario>-after.png` | `run-popup.mjs` | The popup in each state. The `-after` file is taken after tapping the action button. |
| `test/output/live/<site>.png` | `run-live.mjs` | Before/after previews for sites where Duofari was active. |
| `test/output/live/report.json` | `run-live.mjs` | One entry per site: `url`, `name`, `ms`, `reason`, `records`, `emulationLimited`, `failures`, and `skipped` when it could not be tested. |

## 2. Manual testing in the Simulator and on iPhone Duo

### Setup

1. **Build and install.** Follow "Build and run" in the [README](../README.md):
   1. Generate the project with `scripts/gen-xcodeproj.py`. A device needs `--team`.
   2. Open `apple/Duofari.xcodeproj`.
   3. Run the **Duofari** scheme on the iPhone Duo Simulator (Xcode 27.1) or on an iPhone Duo.
2. **Turn the extension on.** Open the Duofari app and tap **Open Settings**, or go to
   **Settings > Apps > Safari > Extensions > Duofari**:
   1. Switch on **Allow Extension**. Also switch it on for **Private Browsing** if you will
      test that.
   2. Under **Permissions**, set **All Websites** to **Allow**.
   3. Back in the app, check that the status row reads "Duofari is on in Safari".
3. **Start the test server.** On the Mac, run `node test/serve.mjs`. You can pass a port; the
   default is 8080. It needs only Node, not Playwright. It serves `test/` and prints addresses
   such as `http://192.168.1.20:8080/device/`.
   - **Simulator:** `http://localhost:8080/device/` works.
   - **Device:** the iPhone must be on the same Wi-Fi network as the Mac. macOS may ask whether
     `node` can accept incoming connections.
   - **Fixtures:** the fixture pages are at `/fixtures/<name>.html`, for example
     `/fixtures/appstore-story.html`.
4. **Use default settings.** Leave Duofari's settings at their defaults, and write down any you
   change. In the popup, **Show what’s extended** under **More** helps throughout:
   - It hatches the column in pink and outlines each extended element. Pinned elements are
     outlined in blue.
   - A badge at the bottom left reads like "Duofari · 84px right · 3 bars · 1 images · locked".
     "locked" means the touch-action lock is on. "partial" means the scan ran out of time and
     will continue.

In the Simulator:

- Hold Option and drag to pinch.
- Double-click to double-tap.
- Touch is simulated with the pointer, so confirm the touch checks on hardware when you can.

Pages served from a LAN address over plain HTTP are not a secure context. On those pages,
`navigator.clipboard` is unavailable, and **Copy report** on the device page says "Select the
text below and copy it". Select the JSON under **Report** and copy it by hand. On `localhost` in
the Simulator, the button works. The popup's **Copy** button runs on an extension page and is
not affected.

### The device check page (`test/device/index.html`)

The page is meant to be opened folded, in portrait. It has a purple gradient header (a band
Duofari should extend), a ruler, and these sections.

**What the page sees.** This is a live table. It updates on `resize`, on `visualViewport`
resize, and when Duofari marks elements. Rows:

| Row | Expected when folded, in portrait |
|---|---|
| `screen` | 466 × 678 |
| `devicePixelRatio` | 3 |
| `aspect` | 1.4549 |
| `clientWidth` | 382 |
| `columnPoints` | 84. Computed like Duofari does: the screen side along the page, minus `clientWidth` × zoom scale. |
| `clientHeight`, `innerWidth`, `innerHeight` | Record them. |
| `visualViewport` | Size, scale and offset. Record it. |
| `orientation` | `portrait-primary 0°` |
| `vw100` | The width of a `100vw` box. Is it 382 or 466? |
| `safeArea` | `env(safe-area-inset-*)` for top, right, bottom and left. The page does not set `viewport-fit=cover`. |
| `reducedTransparency` | Whether `(prefers-reduced-transparency: reduce)` matches. |
| `scrollWidth` | Record it. |
| `userAgent` | Record it. |

**Duofari on this page.** This line reads one of two things:

- "Active: N elements changed; the header reaches X px past the layout edge." It is green when
  X is within 1.5 of `columnPoints`, otherwise red.
- "Not active on this page (no elements changed)…" in red.

**1. Painting under the column.**

1. Tap **Run paint test**. It gives a striped bar a transparent right border as wide as the
   measured column, with the background painted under it. This is the border recipe, done by the
   page itself. The button then reads "Painting 84 px under the column".
2. The stripes should reach the right edge of the screen, under Safari's controls, with no gap.
   The ruler below helps judge where the stripes end.
3. Scroll down and back, and check again.

If the stripes stop at the controls, WebKit clips at the layout viewport and Duofari can't
extend anything.

**2. Fixed bars.** The paint test also shows a striped bar fixed to the bottom of the screen. It
carries `translate: 0px 0px`, the same "lift" Duofari gives fixed bars. It should reach under the
controls and stay put while you scroll.

**3. The other side.** This bar is pushed 84 points past the left edge. Its left end should be
cut off at the screen edge, and the page should not scroll left.

**4. Sideways scrolling.** After the paint test the page is wider than its viewport. A
`scrollX` readout shows the horizontal scroll position.

- With **Hold pages steady** on, dragging sideways in the middle of the page should not move it.
- With it off, the page should slide back once you let go.
- Also try swiping back from the left edge, and double-tapping text.

**5. Rotate and unfold.** Turn the phone sideways both ways, note which side Safari's controls are
on, then unfold. The report keeps one entry per pose, keyed by orientation and `clientWidth`. It
keeps them only until the page reloads, so visit all poses without reloading.

**Report.** The report is JSON: `poses`, the Duofari line, and `scrollX`. **Copy report** copies
it.

**A long read.** Paragraphs to scroll through. They must always end left of the controls.

With Duofari on, the striped bar in section 1 is itself a full-width band, so Duofari may extend
it before you tap **Run paint test**. For a reading of WebKit alone, do a second pass:

1. In the popup, switch off **On for** *host*.
2. Reload the page and run the paint test again.

In this pass nothing holds the page still, so expect it to scroll sideways.

### Checklist

Work through this list in the Simulator first, then on hardware. For each step, note pass or
fail, with a screenshot when something looks wrong.

**Folded, portrait, on the device page:**

1. **What the page sees.** Compare the table with the expected values above. Write down every
   value that differs.
2. **Duofari on this page.** The line is green. The purple header continues under Safari's
   controls, and the heading text does not.
3. **Popup status.** Open the popup. The status reads "Extended …" and "Safari’s controls take
   84 points on the right." Open **More > Diagnostics** and tap **Copy**.
4. **Outlines.** Turn on **Show what’s extended**. The outlines match what you see, and no text
   sits in the hatched column.
5. **Paint test.** Run section 1, then section 2. Note whether the stripes and the fixed bar
   reach under the column, at the top of the page and after scrolling.
6. **The other side.** Run section 3. The left end of the bar is cut off, and the page can't be
   scrolled left.
7. **Hold pages steady on.** Run section 4. Drag sideways in the middle of the page: `scrollX`
   stays 0. Then try:
   - vertical scrolling and flicks;
   - pinch zoom;
   - swiping back from the left screen edge;
   - double-tapping text. Double-tap zoom is expected not to work.
8. **Hold pages steady off.** Turn off **Hold pages steady** and repeat. Diagnostics shows
   `touchLock: false`. The page slides under your finger and returns to `scrollX` 0 once
   scrolling settles. Double-tap zoom works. Turn the setting back on.
9. **Pinch zoom.** Pinch to zoom in. Duofari keeps its changes while zoomed. Only the
   touch-action lock and the snap-back pause, so the popup still reads "Extended …". The zoomed
   page pans freely in every direction. Zoom back out: the page is held steady again.
10. **Second pass.** Do the second pass without Duofari described above, then switch **On for**
    *host* back on.

**Other poses:**

11. **Rotate.** Rotate to landscape one way, then the other. For each, record:
    - which side Safari's controls are on, and the `orientation` row (type and angle);
    - `clientWidth` and `columnPoints`;
    - the popup status.

    Then set **Safari’s controls in landscape** to **Left** and to **Right** in turn, and record
    what changes.
12. **Unfold.** Unfold to full screen, in portrait and in landscape. Then try Split View if Safari
    offers it. Record the same values, and whether Safari shows any vertical column. Fold again.
13. **Copy the report.** Copy the device report, which now holds every pose you visited.

**Beyond the device page:**

14. **Fixture pages.** Open each one (next section) and compare with "What to look for".
15. **Real sites.** Open the real sites listed below.
16. **The matrix.** Repeat the key steps (1–5, and 14 for `appstore-story.html` and
    `news.html`) under each condition in the matrix.

### Device and pose matrix

The "Expected" column says what the code is built to do. None of it has been seen on hardware
yet.

| Condition | How to set it up | Expected | Also record |
|---|---|---|---|
| Folded, portrait | Default | Active. The popup reads "Extended …" and "Safari’s controls take 84 points on the right." | Every value in "What the page sees". |
| Folded, landscape, turned one way | Rotate | Under **Auto**, Duofari guesses the side from `screen.orientation.angle`. At 90° it assumes the left and stays off: "Controls on the wrong side". At any other angle it assumes the right and extends backgrounds only, no images. | Which side Safari's controls are really on, or whether there is no column. `orientation`, `clientWidth`, `columnPoints`. |
| Folded, landscape, turned the other way | Rotate | As above. | As above. |
| Folded, landscape, side chosen | **More > Safari’s controls in landscape**: **Left**, then **Right** | **Right**: images extend too. **Left**: "Controls on the wrong side" on left-to-right pages. | Whether the choice matched reality. |
| Folding and unfolding with a page open | Fold and unfold on `appstore-story.html` | When the width changes, Duofari undoes its changes at once. It re-applies 250 ms after resizing stops. Nothing extended is left over on the inner display. More than 4 on/off changes within 10 seconds pause Duofari on that page ("Paused on this page") until the page reloads, a setting changes or the page navigates (history or hash change). | The popup status after each step, and any flicker. |
| Unfolded, full screen | Unfold, portrait and landscape | Idle. If `screen` still reads 466 × 678, the popup says "Nothing to extend here". | `screen`, `clientWidth`, and whether any vertical column appears. |
| Unfolded, Split View | Safari as the left app and as the right app, each divider position, both orientations | Idle. Duofari can only measure against `screen`, which is the outer display. A pane would be mistaken for a column if its width is 568–618 pt in landscape or 356–406 pt in portrait, because the difference from 678 or 466 then lands in the 60–110 pt range. | Whether Safari shows a vertical bar in the pane, and on which edge. `clientWidth`, `columnPoints`, the popup status. |
| Other iPhones | Any other iPhone Simulator or device | Idle. The popup says "Not an iPhone Duo". The app shows its note that Safari has no column on this screen. | The popup status. |
| Private Browsing | Allow the extension in Private Browsing, open a private tab | Active. If Safari reports a generic screen size there, Duofari uses the size the app reported. | Diagnostics `screen` and `deviceFromApp`. Device page `screen`. |
| Reduce Transparency | **Settings > Accessibility > Display & Text Size > Reduce Transparency** | If the media query matches: idle, "Reduce Transparency is on". | Whether Safari's column turns opaque. Device page `reducedTransparency`. |
| Display Zoom | **Settings > Display & Brightness > Display Zoom**, if iPhone Duo offers it | Active, with the column measured from the zoomed screen size. | `screen`, `aspect`, `columnPoints`, and the points shown in the popup. |
| Safari tab layout | Safari's **Tabs** setting: **Bottom** and **Top** | Active in both. | `clientWidth`, `innerHeight`, `columnPoints` for each. |
| Safari page zoom | Zoom pages, for example to 85 % and 125 % | Active. The column is measured in CSS px as points divided by the zoom scale. | Diagnostics `visualViewport`, `columnPoints` and `columnCss`. |
| Dynamic Type, popup | **Settings > Accessibility > Display & Text Size > Larger Text**, up to the largest size | The popup's text scales: it uses `font: -apple-system-body`. No label is clipped, every switch can be reached, and Diagnostics stays readable. | Screenshots of the popup. |
| Dark mode | **Settings > Display & Brightness**, Appearance: **Dark** | The popup and the device page use their dark colours. Bars on dark websites still extend. | Screenshots of the popup and of a dark page. |
| Right-to-left page | `/fixtures/rtl.html` | Portrait: idle, "Controls on the wrong side". Landscape with the controls on the left (or **Left** chosen): the page's end side, so Duofari extends toward the left. Under **Auto** it extends backgrounds only. | Whether anything paints under a left column. |
| Desktop-layout page | `/fixtures/desktop.html` | Idle, "Desktop layout". With **Also adjust desktop-layout pages** on, it extends, with a column about 215 CSS px wide on this 980-px page. | What Safari does with the scaled page. |

### Fixture pages on the device

These are the same pages the automated tests use. On the device there is no minimum-scale shim
and no harness. The `data-expect` attributes do nothing; they only tell you what to look for.
Turn on **Show what’s extended** to see what Duofari changed.

| Page | What to look for |
|---|---|
| `appstore-story.html` | The hero picture continues under the column and shows more of its art there. The caption and the close button do not move. |
| `blog.html` | The sticky green header and the dark footer reach under the column. The lede photo stays inside the margins. With **Enlarge photos inside page margins** on, photos that start below the first screen (the figure) grow before you reach them, and text below them moves down. The lede photo still stays. The page's own `100vw` band: does it reach under the column before Duofari runs? (See open question 10.) |
| `news.html` | The fixed red masthead and the fixed cookie bar reach under the column while you scroll. The masthead shrinks after you scroll 40 px and should stay extended. The carousel slides still swipe. Check whether Safari tints the column or fills it with a solid colour (open question 3). |
| `edge-cases.html` | The video with controls and the iframe stay inside the page. The band in the shadow root (16) extends. |
| `compat.html` | The accordion chevron and the badge on the photo do not move. The carousel slides do not move. |
| `images.html` | The lead photo and the cover banner extend. The other pictures and the video stay. |
| `overflow-root.html` | The red header and the hero reach under the column even though `html` and `body` hide overflow. |
| `app-shell.html` | The bar and hero extend. The scrolling `div` can't be dragged sideways. |
| `menus.html` | Tap **Menu**. The menu stays left of the column. The page has no button for the search field. To open it, run `document.getElementById('wrap').classList.add('searching')` from Web Inspector, and check that it also stays left of the column. |
| `spa.html` | Route A appears after a short delay, and its bar and hero then extend. To switch routes, run `navigateTo('/b')` and `navigateTo('/a')` from Safari's Web Inspector on the Mac. |
| `offcanvas.html` | The drawer stays hidden: no "Drawer text" or "Sign in" shows under the column. The purple fixed header extends. |
| `rtl.html` | Nothing changes in portrait. |
| `desktop.html` | Nothing changes by default. |

### Real sites

Start with the 16 sites `test/run-live.mjs` uses, since emulated previews exist for them in
`test/output/live/` after a live run:

- https://en.m.wikipedia.org/wiki/IPhone
- https://www.bbc.com/news
- https://www.theguardian.com/international
- https://www.apple.com/iphone/
- https://developer.apple.com/iphone-duo/prepare/
- https://github.com/
- https://news.ycombinator.com/
- https://www.nytimes.com/
- https://www.cnn.com/
- https://stripe.com/
- https://www.theverge.com/
- https://9to5mac.com/
- https://webkit.org/
- https://developer.mozilla.org/en-US/docs/Web/CSS/overflow
- https://www.reddit.com/r/apple/
- https://www.amazon.com/

Also open one site from the built-in web-app list (`EXCLUDED_SITES` in
`extension/shared-settings.js`), such as `docs.google.com`. The popup should say "Off for this
web app", and switching **On for** *host* on should work.

On each site:

- Scroll the whole page. Open the site menu and search.
- Watch for text under the column, things that move sideways, or a page that slides sideways.
- Check for gaps between a bar and the column, and for a column that turns a solid colour.
- Compare with the emulated preview from `test/output/live/` if you have one.

### What to record and how to file results

For every finding, record:

```text
Where:      iPhone Duo hardware / Xcode 27.1 Simulator
iOS:        (Settings > General > About)
Safari:     tab layout Bottom or Top; Private Browsing yes/no
Duofari:    first line of popup Diagnostics, e.g. "Duofari 1.0.0"
Pose:       folded portrait / folded landscape (controls on left or right) / unfolded / Split View
Settings:   any popup setting changed from its default
Page:       URL
Expected:   what this document or the page says should happen
Saw:        what happened
Attached:   popup Diagnostics, device page report, screenshots or a screen recording
```

Attach these:

- **Popup diagnostics.** Open the popup on the affected page, then **More > Diagnostics** and
  **Copy**. If copying fails, the text is selected so you can copy it by hand. The text includes:
  - the version and the `reason` and `counts`;
  - `screen`, `dpr`, `clientWidth`, `innerWidth`, `innerHeight`, `visualViewport` and
    `orientation`;
  - `direction` and `viewportMeta`;
  - `columnPoints`, `columnCss` and `side`;
  - `vwIncludesColumn`, `ownOverflow` and `touchLock`;
  - `deviceFromApp` and `userAgent`.
- **Device page report.** Use **Copy report** on `/device/` after visiting every pose, or select
  and copy the JSON on a LAN address.
- **Screenshots** with **Show what’s extended** on and off. Use a screen recording for touch
  and scrolling problems.

File results as an issue in this repository, one issue per problem, with the template above
filled in. See [SUPPORT.md](../SUPPORT.md). Answers to the open questions in section 3 are the
most useful results. Name the question number in the title.

## 3. Open questions only hardware can answer

Each question lists how to check it, what the code assumes today, and what each answer would
change. When hardware numbers differ from the emulation, also update `POSES` in
`test/lib/duo.mjs` and the values in `test/unit/geometry.test.mjs`, so the automated tests
describe the real device.

### 1. Does Safari paint page content under the column?

- **Check.** Device page section 1, with Duofari on and with it off. Also look at the hero on
  `appstore-story.html`.
- **Today.** The code assumes yes. Mike Piontek's Simulator screenshots show content painted
  under the column.
- **If no.** Duofari cannot do anything visible in that pose. It should stand down there and say
  why. That decision belongs in `D.measureColumn` (`content-geometry.js`), where it sets
  `reason = 'column'`. The recipes in `D.extendBox` (`content-bleed.js`) would have nothing to
  show.
- **Also check.** Look at the very top of the page, before any scrolling. WebKit change
  318137@main hides page colours and content in the leading obscured inset at the scroll
  origin. It sits behind a preference whose value in shipping Safari is unknown. Record whether
  the hero shows under the column at scroll position 0, or only after scrolling.

### 2. Do fixed bars need the identity `translate`, and is it enough?

- **Check.**
  - Device page section 2. That bar always carries the translate.
  - The fixed masthead on `news.html`.
  - To test a bar without the lift, open Web Inspector, remove `translate` from the masthead's
    inline style, and scroll.
- **Today.** `liftFixed()` in `content-classify.js` calls `D.lift()` in `content-bleed.js`. That
  adds `translate: 0px 0px`, because WebKit clips a fixed box's layer to the layout viewport
  unless the box is transformed. The lift is skipped, and removed by `D.checkLifts()`, when the
  bar contains a fixed descendant, because the translate would become that descendant's
  containing block.
- **If bars paint without the lift.** Remove `liftFixed`, `D.lift`, `D.unlift` and
  `D.checkLifts`.
- **If they don't paint even with it.** Stop extending fixed bands. Skip `position: fixed` in
  `D.scan` where it calls `D.extendBox` for bands.

### 3. When does Safari cover the column with a solid colour?

- **Check.**
  - `news.html` (fixed masthead and cookie bar) and `blog.html` (sticky header).
  - A real site with a full-height fixed menu or modal open.
  - Note when the column turns a solid colour instead of showing the page through glass.
- **Today.** WebKit's `LocalFrameView::fixedContainerEdges` samples fixed and sticky boxes on
  the right edge. One that spans about 90 % or more of that edge makes Safari paint a single
  solid view over the column, which would hide extended art. `D.scan` skips fixed boxes at
  least `OVERLAY_HEIGHT` (0.9) of the viewport height tall (`content-classify.js`). It extends
  shorter fixed bars.
- **If Duofari's own extended bars trigger the fill.** Lower `OVERLAY_HEIGHT`, or stop extending
  fixed bands as in question 2.
- **If the fill appears only for full-height boxes.** Keep the current rule.

### 4. Is there a column in folded landscape, and on which side?

- **Check.** Device page section 5. Rotate both ways and record the side, `orientation` type
  and angle, `clientWidth` and `columnPoints`.
- **Today.** The evidence is mixed. One Simulator measurement found a 678-px-wide page, which
  means no column. Other reports, and Apple's guidance for native apps, describe a column that
  moves to the left in one rotation. The emulation assumes a 594-px page. Under **Auto**, the
  landscape branch of `D.measureColumn` guesses `left` at angle 90 and `right` otherwise. It
  sets `result.media = false`, so only backgrounds extend.
- **If the guess is right.** Remove `result.media = false`, so **Auto** extends images in
  landscape too. Update the `hintLandscape` string in `_locales/en/messages.json` and
  `popup.html`.
- **If it is reversed.** Swap the angle test.
- **If there is no column.** No code change is needed: `columnPt` comes out near 0, below
  `MIN_COLUMN`, and the reason is `no-column`. **Safari’s controls in landscape** can then be
  removed from the popup.

### 5. Can a page paint under a column on its start side?

- **Check.** Device page section 3, and `rtl.html` in portrait. Then try a left-to-right page in
  the landscape pose where the controls are on the left, with **Left** chosen.
- **Today.** No. WebKit clamps overflow toward the start edge. `D.measureColumn` returns
  `start-side` when the column is not on the page's end side.
- **If yes.** Relax the `endSide` comparison in `D.measureColumn`. The extension code already
  handles a left column (`sides.left`), which right-to-left pages use in landscape.

### 6. Does `screen` read 466 × 678 in every pose, and is the column 84 pt?

- **Check.** The `screen`, `aspect`, `devicePixelRatio` and `columnPoints` rows in each pose,
  including unfolded and with Display Zoom.
- **Today.**
  - `looksLikeDuo()` in `content-geometry.js` accepts a screen whose long-to-short ratio is
    within 0.03 of `DUO_ASPECT` (678/466) at a pixel ratio of 2.5 or more.
  - The column must measure between `MIN_COLUMN` (60) and `MAX_COLUMN` (110) points.
  - The app's `DeviceInfo.matchesDuo` in `apple/Duofari/DeviceInfo.swift` uses the same ratio
    and tolerance.
- **If unfolded `screen` reports the inner display (669 × 951).** Its ratio is about 1.42,
  outside the tolerance. The popup would then say "Not an iPhone Duo" instead of "Nothing to
  extend here". Duofari stays idle either way. Only the wording is affected.
- **If Display Zoom changes the shape, or puts the column outside 60–110 pt.** Adjust the
  tolerance in `looksLikeDuo()`, or `MIN_COLUMN` and `MAX_COLUMN`.

### 7. Does the touch-action lock behave as intended?

- **Check.** Checklist steps 7 to 9, on hardware.
- **Today.**
  - With **Hold pages steady** on (`holdSteady: true` by default in `shared-settings.js`),
    `lockElement()` in `content-guard.js` sets `touch-action: pan-y pinch-zoom` on `<html>`,
    `<body>` and scrolling wrappers. It also sets `overscroll-behavior-x: none` on `<html>`.
    This costs double-tap zoom and swiping back from the middle of a page.
  - `settle()` puts the page back once scrolling has been quiet for `SETTLE_MS` (150 ms).
  - Both stop while the page is zoomed in more than 2 % past its base scale.
- **If Safari ignores `touch-action` on the root.** The lock costs double-tap zoom for nothing.
  Make `holdSteady` default to `false`, or remove the lock.
- **If the snap-back fights flicks or feels late.** Tune `SETTLE_MS`.
- **If edge back-swipe or pinch zoom breaks.** That is a bug in the lock. Report it with a screen
  recording.

### 8. Does Reduce Transparency reach the page?

- **Check.** The matrix row: whether the column turns opaque, and the `reducedTransparency` row
  on the device page.
- **Today.** `D.measureColumn` stands down (`reduced-transparency`) when
  `matchMedia('(prefers-reduced-transparency: reduce)')` matches. This is future-proofing:
  whether Safari exposes the setting is unverified.
- **If the column turns opaque and the query matches.** Nothing to change.
- **If the column turns opaque but the query never matches.** Duofari keeps extending under an
  opaque column. A manual setting would be needed, because the page has no other signal.
- **If the column stays transparent.** Remove the check, so users with Reduce Transparency get
  the effect.

### 9. Does Private Browsing hide the screen size, and does the app fallback work?

- **Check.** A private tab: device page `screen`, popup Diagnostics `screen` and
  `deviceFromApp`, and the popup status.
- **Today.**
  1. `background.js` asks the app with `sendNativeMessage(…, { type: 'device' })` and stores the
     reply as `device`. It asks when the extension is installed, when Safari starts, and
     whenever the popup opens.
  2. `SafariWebExtensionHandler.swift` answers with `UIScreen.main`'s size and scale.
  3. `D.measureColumn` uses that reply when `screen` does not look like a Duo.
- **If `screen` is real in private tabs.** The fallback is unused but harmless.
- **If `deviceFromApp` is `null`.** Native messaging failed. Check the extension handler's log in
  Console.app, with debug messages shown (it logs "Duofari received a native message" at debug
  level), and report it.

### 10. Does `100vw` include the column?

- **Check.** The device page's `vw100` row, Diagnostics `vwIncludesColumn`, and the `100vw` band
  on `blog.html`.
- **Today.** `probeViewportUnits()` in `content-main.js` measures a `100vw` box. If the box is
  wider than the layout viewport, a page whose own overflow is no more than that excess is
  treated as having no real sideways content: `activate()` resets the allowance to 0, so the guard still
  holds it.
- **If `vw100` is 466.** Sites with `width: 100vw` sections already reach under the column on
  their own. That branch is then important; report pages where it misjudges.
- **If it is 382.** Nothing to change.

### 11. Does Safari show a column in Split View?

- **Check.** The Split View row in the matrix.
- **Today.** There is no support. `D.measureColumn` measures against `screen`, which is the outer
  display. It cannot see a column inside a pane.
- **If Safari shows a vertical bar in a pane.** Supporting it needs a different signal than
  `screen`.
- **If a pane width falls in the ranges in the matrix and Duofari switches on.** Add a guard in
  `D.measureColumn`.
