# Testing Duofari

Duofari is tested in two ways:

1. **Automated tests** run the extension's scripts in Node and in headless Chromium through
   Playwright. For the content scripts, the browser is set up to look like Safari on the folded
   iPhone Duo: a 382 × 580 layout viewport, a 466 × 678 screen and a pixel ratio of 3.
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
| `npm test` | `test:unit`, then `test:fixtures`, then `test:regressions`, then `test:popup` | Everything except live sites. The scripts are joined with `&&`, so the run stops at the first failing suite. | Chromium |
| `npm run test:unit` | `node --test "test/unit/*.test.mjs"` | 22 tests: column detection (`content-geometry.js`), the per-site switches (`shared-settings.js`) and the device report in `background.js`. | Node only |
| `npm run test:fixtures` | `node test/run-fixtures.mjs` | 26 cases on the pages in `test/fixtures/`, in the emulated folded Duo. | Chromium |
| `npm run test:regressions` | `node test/run-regressions.mjs` | 48 cases, each a small page built around one defect found in review. | Chromium |
| `npm run test:popup` | `node test/run-popup.mjs` | 15 popup states, with a stand-in for Safari's extension APIs. | Chromium |
| `npm run test:live` | `node test/run-live.mjs` | The same invariants on 16 live websites. Not part of `npm test`. | Chromium, network |

Two related scripts:

- `npm run fixture-images` runs `scripts/build-fixture-images.mjs`. It redraws the JPEGs in
  `test/fixtures/img/`. The output is deterministic. The pictures have colour bands at known
  positions, so a pixel probe can tell which part of a picture shows under the column.
- `npm run package` runs `scripts/package.mjs`. Before it writes the zip, it checks that every
  file `manifest.json` refers to exists and that every JSON file in `extension/` parses.

### Unit tests (`test/unit/`)

There are 22 tests in two files. Both load extension scripts into a `node:vm` context with no
DOM.

`geometry.test.mjs` loads `shared-settings.js` and `content-geometry.js`. Its tests call
`Duofari.measureColumn(settings, env)` with made-up page measurements. There are 20 tests:

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

`background.test.mjs` runs `background.js` against a stand-in for `browser.*`, in which the
app's native-messaging reply is fixed. It sends `duofari:refresh-device` the way the popup does
each time it opens. There are 2 tests:

- **Stored once.** However often the popup opens, the device the app reports is written to
  `storage.local` only once.
- **Rewritten only when it changes.** A device stored by an older version, stamped with a
  `checked` time, is rewritten once without it, and then left alone.

Every open tab starts over from the page's own layout when the stored device changes, which is
why these writes matter.

### Fixture tests (`test/run-fixtures.mjs`)

#### How a case runs

For each case the runner:

1. Opens a new browser context in the case's pose (see
   [the emulation](#how-the-emulation-approximates-safari-testlibduomjs)), loads the fixture
   page from a local server and applies the minimum-scale shim.
2. Marks the elements named in the case's `expect`, `same` and `probe` fields with test
   attributes. Many fixture elements already carry `data-expect` and pixel probes in their HTML.
   It then collects the pixel probes. Any `data-probe-*` attribute other than
   `data-probe-column`, `data-probe-same` and `data-probe-y` stops the run with an error, so a
   misspelt probe can't be skipped without a word.
3. Takes a full-page screenshot, the page's `outerHTML` and a snapshot of where every text run
   and control sits. These are the "before" state. The first snapshot picks the text runs and
   controls; later snapshots measure the same nodes, so content the page adds or removes in
   between can't misalign them.
4. Injects the six content scripts in manifest order, as one script, with the case's settings.
   It then waits 450 ms and two animation frames. This stands in for Safari running them at
   `document_idle`.
5. Runs the checks below, writes a before/after preview, then turns Duofari off through
   `Duofari.controller` and compares the page with the "before" state.

The runner prints `✓` or `✗` for each case, with Duofari's reason and the number of changed
elements. It exits with status 1 if any case failed.

```sh
node test/run-fixtures.mjs                # all 26 cases
node test/run-fixtures.mjs blog news      # cases whose name contains "blog" or "news"
VERBOSE=1 node test/run-fixtures.mjs      # also print each changed element (kind/recipe element)
```

A filter matches parts of names, so `blog` also runs `blog-breakout`, and `landscape` runs all
five landscape cases, the two right-to-left ones included.

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
- **Text never moves.** No text run moves sideways by more than 0.75 px or up or down by more
  than 1 px, and none ends up in the column. Only `blog-breakout` allows vertical moves, because
  a photo that breaks out grows and pushes the text below it down.
- **Nothing hidden is revealed.** No text that was clipped before becomes visible beside the
  layout viewport. Examples are a closed off-canvas drawer, or content waiting to slide in. Text
  counts as hidden when an ancestor clips it (overflow, `clip-path` or paint containment) or has
  `opacity: 0`. `<body>` counts as a clipping box only when the overflow of `<html>` is not
  `visible`; otherwise its overflow applies to the viewport, as in the browser.
- **Controls never move.** Buttons, inputs, selects, text areas and links keep their
  horizontal position (±0.75 px) and their vertical position (±1 px, except in
  `blog-breakout`).
- **Annotated expectations.**
  - `data-expect="bleed"`: the element's edge on the column's side now reaches the column's
    outer edge (±1 px).
  - `data-expect="breakout"`: the element spans the full width plus the column.
  - `data-expect="inset"` or `"none"`: the element stays where it was (±0.75 px).
  - Elements marked `bleed`, `inset` or `none` also keep their top and height (±1 px), except in
    `blog-breakout`.
  - `data-pseudo-check`: the element's `::before` and `::after` boxes did not move.
- **Pixel probes.** These read pixels from full-page screenshots taken before and after Duofari.
  A column probe reads the middle of the column strip, at a height inside the element given by
  `data-probe-y` (a fraction, 0.5 by default). For a column on the left, the runner reads the
  middle of the left strip instead. Colours are compared by the sum of their RGB differences:
  - `data-probe-column="image"`: the strip shows the art. The pixel must lie inside the
    screenshot and must not match (within 20) the page background or the background colour of
    the element or any of its ancestors. A band showing its own colour there is not art.
  - `data-probe-column="page"`: it shows the page background (within 20).
  - `data-probe-column="#rrggbb"`: it shows that colour (within 30).
  - `data-probe-same="x1,x2,…"`: those points inside the page look the same as before (within
    24).
- **Scroll width.** When a non-fixed element was extended, the document is at least as wide as
  the layout viewport plus the column. Otherwise nothing could show there.
- **App shells.** The app shell's scroller did not become sideways-scrollable. This applies to
  `app-shell`.
- **Holding still.** The runner scrolls 60 px toward the page's end side, where the extended
  content is: to `scrollX` 60, or −60 on a right-to-left page. If the document is wider than the
  viewport and the page did not move, the case fails, because the check would test nothing.
  450 ms later the page is back at `scrollX` 0 (±0.5), and `touch-action` on `<html>` contains
  `pan-y`.
- **Clean undo.** After Duofari is turned off, `document.documentElement.outerHTML` is
  byte-for-byte what it was before.

Only the `spa` case skips the text, hidden-text, control and expectation checks and the
byte-for-byte undo check, because its content is replaced while it runs. The `menus` and
`clone` cases run every check, after their own steps listed in the table below.

#### Fixture cases

All cases use the folded portrait pose unless the table says otherwise. "≥ n" is the minimum
number of extended elements.

| Case | Page | Pose / settings | Expected | What it covers |
|---|---|---|---|---|
| `appstore-story` | `appstore-story.html` | | active, ≥ 2 | The App Store story layout. The hero header and its cover-cropped image reach under the column. The column shows more of the picture, not page background. Three points inside the page (x = 60, 200, 300) look the same as before. The caption and close button stay put. |
| `blog` | `blog.html` | | active, ≥ 3 | Sticky green header, the site's own `100vw` band and the footer extend. The lede photo, figure, pull quote, code block and card stay inside the article. The viewport meta starts as `width=device-width` only and must end up with both `initial-scale=1` and `minimum-scale=1`. The harness's minimum-scale shim leaves this meta alone, so Duofari has to make that fix itself. |
| `blog-breakout` | `blog.html` | `breakout: true` | active | The figure photo, which is below the first screen, breaks out to the full width plus the column. The only case that allows vertical moves. |
| `news` | `news.html` | | active, ≥ 6 | A fixed masthead that changes height on scroll, a section nav that scrolls sideways, a lead image in a ratio box, a headline band, a carousel band whose slides do not move, a promo, and a fixed cookie bar. The two-column grid is left alone. |
| `edge-cases` | `edge-cases.html` | | active, ≥ 8 | Numbered layout patterns. Among them: `width: 100%` with `border-box` and a positioned button, `max-width: 100%`, a grid full-bleed row, a band inside a transformed ancestor, a background-image hero, a clipping wrapper around an image (probe: art shows). Left inside the page: a video with controls, an iframe, `background-clip: text`, an `object-fit: contain` image, a `border-image` band, a float. Also an inline-block band, a table, a band the same colour as the page, a band inside an open shadow root, a hidden fixed modal, and a footer in a flex-column body. |
| `compat` | `compat.html` | | active, ≥ 6 | Patterns from real sites. An accordion chevron drawn by `::after` must not move. A row with a background-image chevron and a header with a centred logo background: points on the chevron's tip (x = 361, 362, 363) and on the logo (x = 160, 191, 222) look the same as before. A ratio box with a cover photo and a badge (probe: art). A dimmed hero with a `::before` overlay (probe: `#005200`). A header with `transition: all`. A Bootstrap 4 column, an `aspect-ratio` hero, a Swiper-like carousel whose band extends but whose slides stay (probe: `#222222`), and a table that is left alone. |
| `images` | `images.html` | | active, ≥ 2 | Which images extend by default. The lead photo is widened and trimmed (Fill; probe: art). A second natural-aspect photo stays (probe: page background). A cover-fitted banner continues pixel for pixel (Reveal; probe: art). Stacked slices of one picture, an annotated graphic, an image named as a chart, and a video with controls all stay. |
| `images-all` | `images.html` | `allImages: true` | active | With **Every full-width image** on, the second photo extends too, and the column shows its art. |
| `overflow-root` | `overflow-root.html` | | active, ≥ 2 | `html, body { overflow-x: hidden }`. The body becomes a clipping box and has to reach into the column too. Header probe `#cc0000`, hero probe: art. |
| `overflow-root-parked` | `overflow-root.html?parked` | | active | The same page with a slide parked past the right edge, hidden only by the body's clip. Opening the body would show the slide under the column, so the header and the hero stay where they are (`none`), the column beside them shows the page background, and the slide's text stays hidden. |
| `app-shell` | `app-shell.html` | | active, ≥ 2 | A page that scrolls a `div` (`#app`) instead of the document. The shell reaches into the column but must not become sideways-scrollable. Bar probe `#0f766e`. |
| `menus` | `menus.html` | | active, ≥ 1 | A header with a cover art layer, so Duofari must extend it with the padding recipe; the case fails if it uses another one. The menu and the search panel sit inside the header and open after Duofari has run, laid out against the grown padding box. The runner opens the menu, then the search panel. Every menu link and the search input must end left of the column. It closes them again before the other checks. |
| `clone` | `news.html` | | active | Copies the extended `.masthead` after Duofari has run, like sticky-header scripts do. The copy must not keep `data-duofari` or the `-84px` styles. |
| `spa` | `spa.html` | | active, ≥ 2 | A page that renders its content late and swaps it on `pushState`. The runner navigates to `/b` and back to `/a`, and Duofari must extend the new content. Skips the text, hidden-text, control and expectation checks and the byte-for-byte undo check. |
| `offcanvas` | `offcanvas.html` | | active, ≥ 2 | A closed drawer parked past the right edge inside an `overflow-x: hidden` wrapper must stay hidden, and that wrapper's band is left alone. The fixed header extends. A band in a wrapper that hides only transparent, waiting-to-animate content extends. |
| `landscape-right` | `appstore-story.html` | `landscape-right` (594 × 340, angle 270) | active, ≥ 1 | **Auto** in landscape: the header extends, the image stays (`inset`), and the column shows the header's own grey (probe `#5a5a5f`), not the picture. |
| `landscape-right-pinned` | `appstore-story.html` | `landscape-right`, `landscapeSide: 'right'` | active, ≥ 2 | With the side chosen, images extend too. |
| `landscape-left` | `appstore-story.html` | `landscape-left` (594 × 340, angle 90) | off, `start-side` | A column on the left of a left-to-right page. |
| `rtl` | `rtl.html` | | off, `start-side` | A right-to-left page in portrait. |
| `rtl-landscape-left` | `rtl.html` | `landscape-left` | active, ≥ 2 | The same page with the column on its end side, the left, under **Auto**. The header (probe `#7a1f5c`) and the green feature band reach under the left column. The photo and the cover banner stay where they are, and the column beside them shows the page background. Points on the photo (x = 100, 300, 500) and on the sun in the feature's art (x = 510, 521, 532) look the same as before. The heading, the menu button and the text stay put. |
| `rtl-landscape-left-pinned` | `rtl.html` | `landscape-left`, `landscapeSide: 'left'` | active, ≥ 4 | With **Left** chosen, pictures extend too. The feature band takes the padding recipe, which grows its padding box to the left: its menu button, placed from the left, is pinned back, and its cover art is pinned so the visible part keeps its place. The photo, the feature's art and the banner show their art under the column. Points on the sun in the feature and in the banner (x = 510, 521, 532) look the same as before. |
| `desktop-layout` | `desktop.html` | | off, `desktop-layout` | A page with no viewport meta. |
| `unfolded` | `appstore-story.html` | `unfolded` (951 × 543) | off, `no-column` | The inner display at full screen. |
| `other-iphone` | `appstore-story.html` | `iphone` (402 × 714, screen 402 × 874) | off, `not-duo` | An ordinary iPhone. |
| `disabled` | `appstore-story.html` | `enabled: false` | off, `disabled` | The main switch. |
| `site-off` | `appstore-story.html` | `disabledSites: ['127.0.0.1']` | off, `site-disabled` | The per-site switch. |

### Regression tests (`test/run-regressions.mjs`)

Each of the 48 cases builds a small page around one defect found in review and checks the
behaviour its fix restored. Most cases write their page inline. The runner serves it at
`/<case name>.html` beside the fixtures, so pictures in `img/` load. Two cases (`lifecycle-6`
and `engine-9`) use `blog.html`.

For each case the runner opens a fresh folded tab, loads the page, applies the minimum-scale
shim, waits 300 ms and takes a snapshot. The case then injects Duofari itself and drives the
page. Depending on the defect it adds content, restyles elements, zooms in with
`Emulation.setPageScaleFactor`, switches poses with `orientPage()`, slows the CPU, sends touch
events, or turns Duofari off the way the popup does. Some cases open a second tab. A case fails
if one of its checks fails, if it throws, or if the page logs an error.

```sh
node test/run-regressions.mjs              # all 48 cases
node test/run-regressions.mjs engine-4     # cases whose name contains "engine-4"
```

As with the fixtures, a filter matches parts of names, so `engine-4` also runs `r3-engine-4`.
The name `engine-r2-10` is used once in each group, so filtering on it runs both. The runner
prints `✓` or `✗` with each case's description, and exits with status 1 if any case failed.

The cases are in two groups, run in this order.

**`ENGINE`, 31 cases:** choosing, extending and restoring boxes (`content-bleed.js`,
`content-classify.js`).

- **Fixed and sticky bars.** A lifted fixed header stays extended through later scans
  (`engine-1`), and stays lifted through a restyle that brings no `translate` (`engine-r2-1`).
  A restyled header's own slide transitions still run (`engine-4`).
- **Wrappers that hide sideways overflow.** Opening one reveals no hidden text,
  pseudo-element, shadow-DOM drawer or late content (`engine-2`). One stays open after zooming
  and is opened again after a class change (`engine-3`), or once the drawer that kept it shut
  is gone (`engine-r2-8`). One whose overflow is only margins, its own padding or invisible
  content is opened (`engine-r2-7`). Content that grows past an opened one later is checked
  (`engine-r2-3`). A clipping `<body>` is checked again for added content (`engine-r2-2`). A
  class on it cuts no running transition, and a photo broken out on screen doesn't shrink with
  it (`r3-engine-2`). A band that clips stays extended when it holds a band or the lead image
  (`r3-engine-1`).
- **Positioned children and pseudo-elements.** They stay put deep inside a large wrapper
  (`engine-6`, `engine-r2-9`), and under CSS anchor positioning (`engine-13`). So does
  foreground in a full-size layer: a contained image, a centred logo, a labelled pseudo-element
  (`engine-7`). Toasts added to an extended hero stay centred, also while sliding in, and still
  slide in by `right` or grow by `width` (`engine-10`, `engine-r2-4`, `r3-engine-7`). Extending
  a band's border reads no pseudo-elements of what is inside it (`engine-r2-10`).
- **Pictures and cover layers.** Pictures are measured again when their `src` changes
  (`engine-5`). A broken-out photo stays broken out when it is restyled (`engine-9`). Layers
  built from boxes grow with their hero (`engine-r2-5`), but an icon drawn as a layer's
  background image stays put (`engine-r2-6`). Art drawn by an inner wrapper's pseudo-element
  continues under the column (`r3-engine-4`). Under **Auto** in landscape, no picture in a band
  is rescaled (`r3-engine-extra-1`, the only case in a folded landscape pose; it compares
  screenshots of the page from before and after).
- **Restoring.** A copy of `<body>` put back by the page, as Turbo does, keeps none of
  Duofari's styles or lock (`engine-8`). Turning off restores `var()` shorthands and inline
  transitions exactly and keeps the page's own later writes (`engine-11`, `r3-engine-5`).
  Nothing is written into editable content (`engine-12`).
- **Large pages.** A band after 7,000 elements is reached (`r3-engine-scan`). A large page whose
  positioned `<body>` clips is walked to the end with the CPU slowed four times
  (`r3-engine-3`). Once walked, neither page gets more than one scan in 2 s of idling.

**`LIFECYCLE`, 17 cases:** the controller, the guard and what the popup is told
(`content-main.js`, `content-guard.js`, `content-geometry.js`).

- **Holding the page still.** A page-sized horizontal scroller, and an app shell that holds
  wide content of its own, keep their scroll positions (`lifecycle-1`, `r3-lifecycle-2`). Wide
  content added later can be scrolled to, and the lock returns once it is gone (`lifecycle-4`).
  The lock brings back no pinch-zoom the page turned off, and leaves `touch-action: none` alone
  (`lifecycle-2`). A touch whose target removes itself does not leave the snap-back waiting
  (`lifecycle-7`).
- **The viewport meta.** The fix survives head managers that replace the meta or keep
  rewriting it (`lifecycle-3`). After five repairs within 10 s the meta is left to the page
  until its next route (`r3-lifecycle-7`). Both cases run without the Navigation API, as in
  Safari 18. A page that starts zoomed out keeps its zoom and layout width (`lifecycle-9`).
- **When Duofari runs.** Folding and unfolding twice does not pause it (`lifecycle-5`). A page
  that switches to a desktop viewport whenever something is extended makes it stand down with
  `unstable` (`r3-lifecycle-3`). Turning it off while zoomed in takes effect at once, a page
  that starts zoomed in reports `zoomed`, and zooming in keeps an idle reason such as
  `no-column` or `not-duo` (`lifecycle-8`, `r3-lifecycle-4`). The device report the popup asks
  for each time it opens changes nothing on the page (`lifecycle-6`).
- **Keeping up with changes.** Custom properties written every frame, and a ticking clock,
  inside an opened wrapper bring no stream of scans (`engine-r2-10`). Text that changes twice in
  a row, or is edited in place, is still checked (`r3-lifecycle-1`, `r3-engine-6`).
- **The popup's answer.** An SVG file shown on its own answers `unsupported-document`, from one
  listener even when the scripts are injected twice (`platform-3`).

### Popup tests (`test/run-popup.mjs`)

This runner serves `extension/` and opens `popup.html` in Chromium at 382 × 700 and DPR 2. It
replaces `browser.*` with a stand-in. The stand-in supports `i18n` (reading
`_locales/en/messages.json`), `runtime`, `storage.local`, `tabs`, `permissions` and `scripting`.
It also records what the popup asks for. `permissions.contains()` answers from a set of granted
origins (all websites unless the scenario says otherwise), and `permissions.request()` adds to
it. As in Safari, the temporary access that opening the popup gives a tab is not in that set.

| Scenario | Popup shows |
|---|---|
| `active` | "Extended 3 bars and 1 image", the **On for** switch on. Turning the switch off saves `example.com` in `disabledSites`. |
| `one-of-each` | "Extended 1 bar" (the singular form). |
| `not-duo` | "Not an iPhone Duo". |
| `site-off` | "Off for this site", the switch off. |
| `excluded-site` | "Off for this web app" on `docs.google.com`, with the web-app note. |
| `unsupported` | "Duofari can’t change this kind of page", for a non-http URL. |
| `not-run-yet` | "Duofari hasn’t run on this page yet" with **Apply to This Page**. Tapping it injects the manifest's content scripts, and the status updates. |
| `no-access` | A site set to Deny: no access at all, so Safari hides the address. "Duofari can’t see this site yet" with **Allow on All Websites**. Tapping it requests `*://*/*`, then injects, and the status updates. |
| `this-page-only` | Safari's default, Ask: opening the popup gave the tab temporary access, so Duofari runs, but nothing is granted for good. "Extended 3 bars and 1 image" with "For now Duofari can see only this page. Allow it on all websites so it can extend pages as they open." and **Allow on All Websites**. Tapping it requests `*://*/*`, and the status updates. |
| `site-allowed` | Access granted for `example.com` only. "Extended 3 bars and 1 image" with "Safari’s controls take 84 points on the right." and no button. |
| `start-page` | No address, with access to all websites: Safari's Start Page, or a site set to Deny while all others are allowed. "Duofari can’t see this page" with "This is Safari’s Start Page, or a website set to Deny in Settings › Apps › Safari › Extensions › Duofari." and no button. |
| `svg-file` | The content script answers `unsupported-document` for an SVG file shown on its own. "Duofari can’t change this kind of page", no button. |
| `pdf` | No answer on an address ending in `.pdf`. "Duofari can’t change this kind of page", no button. |
| `pdf-no-suffix` | A PDF at an address without `.pdf`. "Duofari hasn’t run on this page yet" with **Apply to This Page**. Injecting fails there, so after the tap the popup says "Duofari can’t change this kind of page". |
| `dark` | Dark colour scheme. Opens **More** and **Diagnostics**: the text starts with `Duofari <version>` and contains `columnPoints: 84`. Choosing **Left** under **Safari’s controls in landscape** saves `landscapeSide: 'left'` and marks the segment as checked. **Enlarge photos inside page margins** saves `breakout: true`. |

Every scenario also checks:

- The action button is shown only where the table names one, with that label. Where a scenario
  names a detail line, the popup shows exactly that text.
- Where a scenario expects the site switch, it shows, in the expected position, and the web-app
  note shows only for `excluded-site`.
- No `data-i18n` element is left empty.
- The popup asked the background script for device details (`duofari:refresh-device`).
- No script errors were logged.

After a tap on the action button, the button must be gone once the status has updated: nothing
is left to offer. Where the scenario expects it, the popup must have requested `*://*/*` and
injected exactly the manifest's content scripts. No tap may reload the tab.

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
3. Applies the minimum-scale shim. Notes the inline `touch-action` and `overscroll-behavior-x`
   of `<html>` and `<body>`, and the viewport meta's content. Takes a screenshot and a
   snapshot.
4. Injects Duofari. Right after, it saves the inline declarations of every element Duofari
   changed, before the checks below give the page's scripts a reason to write. Whatever changes
   after this is the page's doing. It then takes another snapshot.

It checks, on pages where Duofari is active:

- **Sideways.** No text or control moves sideways, no text moves into the column, and no
  hidden text is revealed. These compare the snapshots from before and after injecting.
- **Holding still.** It scrolls 60 px toward the page's end side (−60 on a right-to-left page).
  450 ms later the page must be no further sideways than its own overflow allows
  (`Duofari.controller.state.allowance`). The folded portrait pose leaves right-to-left pages
  off (`start-side`), so on live sites this check only runs on left-to-right pages.
- **Up and down.** In one `page.evaluate`, it reads the tops of the text runs and controls the
  snapshot tracks, turns Duofari off, and reads them again. No page script can run in between,
  so only Duofari's own moves show, not the page's (rotating promo bars, late ad slots). A move
  of more than 1 px fails. The report gives the top without Duofari first: `top <off> → <on>`.
- **Restore.** After turning off, `Duofari.records` is empty, no element is still marked
  `data-duofari` (open shadow roots included), and the touch settings of `<html>` and `<body>`
  and the viewport meta are back as they were. On each element Duofari had recorded:
  - A declaration Duofari still held is back to the value it replaced. If that saved value is
    `!important` and isn't the page's own, it counts as saved wrongly, and the page's own value
    is expected instead. Duofari's declarations are always `!important`, and a script's hardly
    ever are.
  - A declaration the page changed after the save stays as the page set it.
  - Every other declaration matches the page's original `style` attribute.
  - Once the declarations are the page's own, the `style` attribute matches the original byte
    for byte. This catches a leftover `style=""`.
  - On an element Duofari took on only after the save, only the declarations it holds are
    checked: nothing else tells its changes from the page's there.

  One limit: a declaration the page writes on one of these elements during the injection
  itself can't be told from Duofari's. The check expects it to be gone.

On every page it also checks that no script error was thrown from Duofari's code. The harness
names the injected script `duofari-content.js` with a `//# sourceURL` comment (`SOURCE_URL` in
`test/lib/duo.mjs`), so its frames don't read `<anonymous>`. Only errors whose stack names that
file count; live pages throw plenty of their own.

The output marks each site:

- `✓` passed.
- `✗` failed. The first 12 failures are printed.
- `–` could not be tested (load error or timeout). This doesn't count as a failure.

The number after the counts is the time from injection until settled. It includes the fixed
450 ms wait, so it is not Duofari's own running time.

Live sites change, show consent banners and sometimes block headless browsers, so results vary
from run to run. A page that overflows the viewport by itself is flagged `emulationLimited`, and
its sideways and up-and-down checks are skipped (see below).

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
  `emulateSafariMinimumScale()` appends `minimum-scale=1` to a viewport meta that has both
  `device-width` and `initial-scale` but no `minimum-scale`. A meta without an initial scale is
  left alone: that is the page Duofari has to fix itself (`blog.html` is one), and a shim there
  would hide a missing fix. The shim runs before the "before" snapshot, so it is never counted
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
  (`innerWidth` larger than `clientWidth` before Duofari runs) and skips the sideways and
  up-and-down checks of text and controls for them. The holding-still, restore and error checks
  still run.

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
- **Touch.** The fixture and live guard checks use a programmatic `scrollTo`, and the fixtures
  read the computed `touch-action`. Two regression cases send Chromium touch events: a tap
  (`lifecycle-7`) and a two-finger pinch (`lifecycle-2`). Other regression cases zoom in with
  `Emulation.setPageScaleFactor` instead of a gesture. None of this shows whether Safari
  honours the lock (`pan-y pinch-zoom` on the root), what happens to double-tap zoom and
  swiping back, or how pausing while pinch-zoomed feels.
- **Folding and unfolding.** Every fixture case starts in a fresh context. `lifecycle-5` folds
  and unfolds twice in one tab, and `r3-lifecycle-3` drives the on/off back-off with a page that
  keeps switching its viewport meta. But `orientPage()` changes the size in a single jump, so
  the sequence of resizes during a real fold is not exercised. Handling that sequence is the job
  of `onResize` and `RESIZE_SETTLE` (250 ms) in `content-main.js`.
- **Private Browsing and Reduce Transparency.** These are covered only by unit tests of
  `measureColumn`. `background.test.mjs` tests how `background.js` stores the app's reply, and
  `lifecycle-6` that the same report again changes nothing on the page. The native-messaging
  round trip itself (`background.js` to `SafariWebExtensionHandler.swift`) is not tested. The
  popup test only checks that the popup asks for it.
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

The unit tests and `run-regressions.mjs` write no files.

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

**3. The other side.** This bar is pushed 84 points past the left edge. In portrait that is off
the screen whatever WebKit does, so the section is checked in landscape, in the pose with
Safari's controls on the left (section 5). There the bar's left end would sit under the
controls. WebKit is expected to clamp overflow at the start edge, so no stripes should show
under them. The page should not scroll left in any pose.

The section asks "With the controls on the left: do stripes show under them?" Tap **Yes** or
**No** in that pose. The page answers "Saved for" and the orientation, and the report keeps the
answer with that pose as `stripesUnderLeftControls`.

**4. Sideways scrolling.** After the paint test the page is wider than its viewport. A
`scrollX` readout shows the horizontal scroll position.

- With **Hold pages steady** on, dragging sideways in the middle of the page should not move it.
- With it off, the page should slide back once you let go.
- Also try swiping back from the left edge, and double-tapping text.

**5. Rotate and unfold.** Turn the phone sideways both ways and note which side Safari's controls
are on. In the pose that has them on the left, answer section 3. Then unfold. The report keeps
one entry per pose, keyed by orientation and `clientWidth`, with the section 3 answer given in
that pose. It keeps them only until the page reloads, so visit all poses without reloading.

**Report.** The report is JSON: `poses`, `duofari` (the Duofari line) and `scrollX`. **Copy
report** copies it.

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
6. **The other side.** The page can't be scrolled left. Section 3's question is answered in
   landscape (step 11).
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
   page pans freely in every direction. Zoom back out: the page is held steady again. If a page
   is already zoomed in when Duofari first runs on it, the popup reads "Paused while zoomed in"
   until you zoom back out.
10. **Second pass.** Do the second pass without Duofari described above, then switch **On for**
    *host* back on.

**Other poses:**

11. **Rotate.** Rotate to landscape one way, then the other. For each, record:
    - which side Safari's controls are on, and the `orientation` row (type and angle);
    - `clientWidth` and `columnPoints`;
    - the popup status;
    - with the controls on the left, the answer to section 3: **Yes** or **No**.

    Then set **Safari’s controls in landscape** to **Left** and to **Right** in turn, and record
    what changes.
12. **Unfold.** Unfold to full screen, in portrait and in landscape. Then try Split View if Safari
    offers it. Record the same values, and whether Safari shows any vertical column. Fold again.
13. **Copy the report.** Copy the device report, which now holds every pose you visited and your
    section 3 answer.

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
| Folded, landscape, turned one way | Rotate | Under **Auto**, Duofari guesses the side from `screen.orientation.angle`. At 90° it assumes the left and stays off: "Controls on the wrong side". At any other angle it assumes the right and extends background colours only: no image extends, and no picture inside a band is rescaled or moved. | Which side Safari's controls are really on, or whether there is no column. `orientation`, `clientWidth`, `columnPoints`. With the controls on the left, the device page's section 3 answer. |
| Folded, landscape, turned the other way | Rotate | As above. | As above. |
| Folded, landscape, side chosen | **More > Safari’s controls in landscape**: **Left**, then **Right** | **Right**: images extend too. **Left**: "Controls on the wrong side" on left-to-right pages. | Whether the choice matched reality. |
| Folding and unfolding with a page open | Fold and unfold on `appstore-story.html`, several times in a row | When the width changes, Duofari undoes its changes at once. It re-applies 250 ms after resizing stops. Nothing extended is left over on the inner display. On/off changes are counted per pose: the window's width in points (`visualViewport` width × scale) and the orientation. Folding and unfolding change the pose, so they never pause Duofari. More than 4 on/off changes within 10 seconds in one pose, such as a page that keeps switching its viewport meta, pause it on that page ("Paused on this page") until the page reloads, a setting changes or the page navigates (history, hash change, or a new address from `pushState`). | The popup status after each step, and any flicker. |
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
| Right-to-left page | `/fixtures/rtl.html` | Portrait: idle, "Controls on the wrong side". Landscape with the column on the left (at 90° under **Auto**, or with **Left** chosen): the page's end side, so Duofari extends toward the left. Under **Auto** only the header and the green feature band extend. With **Left** chosen, the photo, the feature's art and the banner extend too. | Whether anything paints under a left column. |
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
| `compat.html` | The accordion chevron, the row's background chevron, the centred logo and the badge on the photo do not move. The carousel slides do not move. |
| `images.html` | The lead photo and the cover banner extend. The other pictures and the video stay. |
| `overflow-root.html` | The red header and the hero reach under the column even though `html` and `body` hide overflow. Open `overflow-root.html?parked` too: a slide parked past the right edge is then hidden only by the body's clip, so nothing extends, and "Second slide text that must stay hidden" never shows under the column. |
| `app-shell.html` | The bar and hero extend. The scrolling `div` can't be dragged sideways. |
| `menus.html` | The blue header reaches under the column, and the **Menu** button stays where it was. Tap **Menu**. The menu opens inside the header and stays left of the column. The page has no button for the search field. To open it, run `document.getElementById('wrap').classList.add('searching')` from Web Inspector, and check that it also stays left of the column. |
| `spa.html` | Route A appears after a short delay, and its bar and hero then extend. To switch routes, run `navigateTo('/b')` and `navigateTo('/a')` from Safari's Web Inspector on the Mac. |
| `offcanvas.html` | The drawer stays hidden: no "Drawer text" or "Sign in" shows under the column. The purple fixed header extends. |
| `rtl.html` | Nothing changes in portrait. In landscape, when Duofari puts the column on the left (at 90° under **Auto**, or with **Left** chosen), the header and the green feature band reach under it, and the heading, the round menu button and the text stay put. With **Left** chosen, the photo, the feature's art and the banner continue under the column too, and the art does not shift. |
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
`test/lib/duo.mjs`, the values in `test/unit/geometry.test.mjs`, and `C` and `VW` at the top of
`test/run-regressions.mjs`, so the automated tests describe the real device.

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
  sets `result.media = false`, so only background colours extend. The scan then also passes
  `pictures: false` to `D.extendBox`, so no picture inside a band is rescaled or moved either.
- **If the guess is right.** Remove `result.media = false`, so **Auto** extends images in
  landscape too. Update the `hintLandscape` string in `_locales/en/messages.json` and
  `popup.html`.
- **If it is reversed.** Swap the angle test.
- **If there is no column.** No code change is needed: `columnPt` comes out near 0, below
  `MIN_COLUMN`, and the reason is `no-column`. **Safari’s controls in landscape** can then be
  removed from the popup.

### 5. Can a page paint under a column on its start side?

- **Check.** Device page section 3, answered **Yes** or **No** in the landscape pose where the
  controls are on the left. The report saves the answer with that pose as
  `stripesUnderLeftControls`. Also open `rtl.html` in portrait, where the column on the right is
  the page's start side.
- **Today.** No. WebKit clamps overflow toward the start edge. `D.measureColumn` returns
  `start-side` when the column is not on the page's end side.
- **If yes.** Relax the `endSide` comparison in `D.measureColumn`. The extension code already
  handles a left column (`sides.left`), which right-to-left pages use in landscape. The fixture
  cases `rtl-landscape-left` and `rtl-landscape-left-pinned` test it.

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
    `lockElement()` in `content-guard.js` locks `<html>`, `<body>` and scrolling wrappers.
    `lockValue()` takes the element's own computed `touch-action` and removes only sideways
    panning (`pan-x`, `pan-left`, `pan-right`). `auto` and `manipulation` become `pan-y
    pinch-zoom`. An element that already allows no sideways panning is left alone, so a
    pinch-zoom the page turned off stays off. It also sets `overscroll-behavior-x: none` on
    `<html>`. Locked elements carry `data-duofari-lock`. The lock costs double-tap zoom and
    swiping back from the middle of a page.
  - `settle()` puts the page back once scrolling has been quiet for `SETTLE_MS` (150 ms). An app
    shell is put back to 0 only while its sideways overflow is at most the column plus 1 px,
    as much as Duofari's extensions can add. Wider overflow is the page's own and stays
    reachable.
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
     reply as `device`, but only when it differs from the stored one. It asks when the
     extension is installed, when Safari starts, and whenever the popup opens.
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
  treated as having no real sideways content: `activate()` resets the allowance to 0, so the
  guard still holds it. After each scan, `updateAllowance()` measures again, and only overflow
  wider than the column plus 1 px counts as the page's own.
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
