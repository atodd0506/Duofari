# App Store submission

This guide covers shipping Duofari through the App Store: what to upload, how to number
versions, draft metadata, the privacy label, notes for App Review and screenshots. Replace
everything in angle brackets, such as `<your-repo-url>`, with your own values.

> **Check on a device first.** Duofari has been verified only in Playwright/Chromium emulation
> and against WebKit source and other developers' simulator reports. It has not run on iPhone
> Duo hardware. Before you submit, open `test/device/index.html` (served by
> `node test/serve.mjs`) on an iPhone Duo or in the iPhone Duo Simulator in Xcode 27.1. Check
> four things there: painting under the column, the fixed-bar lift, Safari's opaque fill over
> the column, and touch behaviour. See [README.md](../README.md#testing).

## Contents

- [Before you submit](#before-you-submit)
- [What to upload](#what-to-upload)
- [Versioning](#versioning)
- [Metadata](#metadata)
- [App privacy](#app-privacy)
- [iPhone only, and only useful on iPhone Duo](#iphone-only-and-only-useful-on-iphone-duo)
- [App Review notes](#app-review-notes)
- [Screenshots](#screenshots)
- [Review risks raised during design](#review-risks-raised-during-design)
- [Sources](#sources)

## Before you submit

- [ ] `npm test` passes: unit, fixture, regression and popup tests.
- [ ] You ran the device check on an iPhone Duo or in the iPhone Duo Simulator, folded, in
      portrait.
- [ ] The version in `extension/manifest.json` is the one you want to release.
- [ ] You generated the Xcode project with your team, your bundle ID and a new build number
      (see [Versioning](#versioning)).
- [ ] [PRIVACY.md](../PRIVACY.md) and [SUPPORT.md](../SUPPORT.md) are online at public URLs,
      with `<your-repo-url>` filled in.

## What to upload

### Option A: the Xcode project (recommended)

This ships the full containing app: onboarding, the extension's on/off state, the **Open
Settings** button, and the native handler that tells the extension the real screen size.

1. Generate the project:

   ```sh
   python3 scripts/gen-xcodeproj.py --team <TEAM_ID> --bundle-id <com.yourname.Duofari> --build <N>
   ```

   The extension's bundle ID is the app's plus `.Extension`. The app relies on that suffix to
   find the extension (`ExtensionStatus.extensionIdentifier` in
   `apple/Duofari/ExtensionStatus.swift`), so keep it.
2. Open `apple/Duofari.xcodeproj` in Xcode 27.1 or later. Select the **Duofari** scheme and a
   generic iOS device as the destination, then choose **Product > Archive**.
3. Upload the archive to App Store Connect from the Organizer.
4. In App Store Connect, create the app record for the same bundle ID, fill in the metadata
   below, and select the build.

Facts about the project that affect submission:

- iPhone only (`TARGETED_DEVICE_FAMILY = 1`), deployment target iOS 27.0.
- Category key `public.app-category.utilities`.
- `ITSAppUsesNonExemptEncryption` is `false` in `apple/Duofari/Info.plist`, so App Store
  Connect should not ask the export-compliance question for each build.
- Both targets include a `PrivacyInfo.xcprivacy` (see [App privacy](#app-privacy)).
- Uploads must be built with Xcode 26 and the iOS 26 SDK or later. Apple has posted no iOS 27
  SDK requirement. Building with the iOS 27.1 SDK has one side effect: iPhone Duo screenshots
  become required from April 2027 (see [Screenshots](#screenshots)).

### Option B: the web extension zip

```sh
npm run package
```

This writes `dist/Duofari-<version>.zip` with `manifest.json` at the root of the archive. First
it checks that every file the manifest refers to exists and that every JSON file parses.

App Store Connect also has a Safari web extension packager. It builds the containing app for
you from the extension's files, with no Mac and no Xcode. In October 2026, Apple's documentation
gave this path: create the app record, then go to **Users and Access > Xcode Cloud > Safari Web
Extension Packager > Upload**. You upload "the full contents of your
extension, including the manifest". The result goes to TestFlight or to App Store review.

This option is possible, but you lose part of Duofari:

- **No Duofari app.** Apple generates the containing app, and you can't add Swift code to it.
  Users don't get Duofari's onboarding screen, its on/off status or its **Open Settings**
  button.
- **No native screen-size answer.** `SafariWebExtensionHandler.swift` is not included.
  `background.js` handles the missing answer without errors, but Duofari loses its fallback for
  when Safari hides the real screen size (Safari's Advanced Fingerprinting Protection, which is
  on by default in Private Browsing). In that case the popup may say "Not an iPhone Duo".
- **Not iPhone only.** Apple's documentation says the result runs on iOS, iPadOS and visionOS.
- **Build hours.** Packaging counts against the 25 Xcode Cloud compute hours a month that come
  with the developer program.
- **Reported problems.** Developers on Apple's forums reported a missing upload section, a
  "NetworkError" on zip upload, and "Invalid Pre-Release Train" when they uploaded again
  without a new version. Raise `version` in `extension/manifest.json` for every upload.

## Versioning

| Number | Where it comes from | Used for |
|---|---|---|
| Marketing version (`MARKETING_VERSION`) | `--version`, which defaults to `"version"` in `extension/manifest.json` (now `1.0.0`) | The version on the App Store. `package.mjs` also uses it to name the zip, and the popup's Diagnostics shows it as the first line ("Duofari 1.0.0"). |
| Build number (`CURRENT_PROJECT_VERSION`) | `--build`, default `1` | Must be higher for each upload. The checked-in project uses build 1. |

For a new release:

1. Raise `"version"` in `extension/manifest.json`, for example to `1.0.1`.
2. Regenerate the project with a build number that only goes up. The commit count works:

   ```sh
   python3 scripts/gen-xcodeproj.py --team <TEAM_ID> --bundle-id <com.yourname.Duofari> --build $(git rev-list --count HEAD)
   ```

3. Archive and upload as above.

Leave out `--version`, so the app and the extension carry the same version. If they differ,
the popup's Diagnostics shows the extension's version, not the one on the App Store.

`package.json` has its own `version` field, which no script reads.

The generator writes your team ID and bundle ID into `apple/Duofari.xcodeproj/project.pbxproj`.
To keep them out of the repository, run `python3 scripts/gen-xcodeproj.py` with no flags before
you commit. That restores `com.example.Duofari`, no team and build 1.

## Metadata

The drafts below were checked against App Store Connect's length limits: 30 characters for the
name and the subtitle, 170 for promotional text, 100 for keywords and 4,000 for the description.

### Name

**Duofari** (7 characters). See [Review risks](#review-risks-raised-during-design) for a note on
the name.

### Subtitle

Pick one (30 characters at most):

| Subtitle | Characters |
|---|---|
| `Full-width pages on iPhone Duo` | 30 |
| `For Safari on iPhone Duo` | 24 |

### Promotional text

```text
On the folded iPhone Duo, header bars and lead images continue under Safari’s side controls. Text, links and buttons stay where they were.
```

138 characters. You can change promotional text without a new build. Use it to report
device-test results or fixes.

### Description

The first sentence says who the app is for. The App Store shows only the first lines before
"more", and this is a requirement nobody can enforce at install time (see
[below](#iphone-only-and-only-useful-on-iphone-duo)).

```text
Requires iPhone Duo. Duofari changes web pages only on the folded outer display, where Safari keeps its controls in a column on the right. On other iPhones, and while iPhone Duo is open, it does nothing.

On the folded iPhone Duo, Safari lays every web page out beside that column, so pages stop where the column begins. Apple's own apps on iPhone Duo let header art and backgrounds run under the column while text stays clear of it. Duofari is a Safari extension that does the same for web pages.

What continues under Safari's controls:
- Header bars, hero sections and other full-width backgrounds
- The lead image near the top of a page, and pictures that have cropped-away art to show
- If you turn them on: every full-width image, and photos inside the page margins (text below those photos moves down)

What stays where it was:
- Text, links, buttons and form fields
- Carousels, video players, charts, maps and screenshots
- The page itself: it doesn't slide sideways

In Safari, tap the extensions button and choose Duofari to:
- See what Duofari did on the page, or why it left the page alone
- Turn Duofari off for a site
- Choose what extends
- Choose which side Safari's controls are on in landscape
- Outline everything Duofari changed

Where it works:
- Folded, portrait: yes
- Folded, landscape: backgrounds only, unless you choose the side Safari's controls are on. With the controls on the left, left-to-right pages are left alone
- Open (inner display): Safari has no side column there, so Duofari stays idle
- Right-to-left pages in portrait: left alone, because pages can only extend past the edge where their lines end
- Pages laid out only for desktop screens: skipped, unless you turn them on
- Safari's own pages, Reader and PDFs: not changed

Good to know:
- iPhone Duo is new and so is Duofari. If a site looks wrong, turn Duofari off for that site, and send a report using the Diagnostics section of the Duofari popup in Safari.
- "Hold pages steady" is on by default. It stops pages sliding sideways, but it also turns off double-tap zoom and swiping back from the middle of a page. Turn it off to get those back.
- Duofari needs access to all websites so it can adjust pages as they open.

Privacy: Duofari runs on your iPhone and collects no data. It keeps its settings on your iPhone, including the sites you turn it off for, and sends nothing anywhere.
```

This draft is about 2,400 characters. Before you submit, compare the "Where it works" list with
your device test. Folded landscape is the least certain row: which side Safari's column is on
in landscape has not been confirmed.

### Keywords

```text
foldable,outer display,cover display,full width,edge to edge,header,hero,images,web,extension
```

93 characters. App Store search already covers the words in the name and subtitle, so the
keywords don't repeat them. They also contain no other companies' trademarks.

### Category

- Primary: **Utilities**. This matches `LSApplicationCategoryType`
  (`public.app-category.utilities`) in the project.
- Secondary: optional. Productivity fits if you want one.

### URLs and copyright

- Support URL: the public address of [SUPPORT.md](../SUPPORT.md), for example
  `<your-repo-url>/blob/<branch>/SUPPORT.md`.
- Privacy policy URL: the public address of [PRIVACY.md](../PRIVACY.md).
- Copyright: `<year> <your name>`.
- Sign-in required for review: no. Duofari has no accounts.

### Age rating

Duofari shows no content of its own. It changes the layout of pages the user opens in Safari.

| Questionnaire topic | Answer |
|---|---|
| Violence, sexual content or nudity, profanity, horror or fear themes, mature themes | None |
| Alcohol, tobacco, drugs; medical or treatment information | None |
| Gambling, simulated gambling, contests | None |
| Unrestricted web access | No. The app has no browser and loads no pages. The extension changes styles on pages that Safari has already loaded. |
| User-generated content, messaging or chat, advertising | No |
| Parental controls, age assurance | No |
| Made for Kids | No |

The expected rating is the lowest one, 4+. Apple changes the questionnaire's wording from time
to time. Answer "None" or "No" to anything not listed here, unless the app has changed. The
"Unrestricted web access" answer is a judgement call: Duofari is an extension for a browser,
but it is not a browser itself.

## App privacy

In App Store Connect, under **App Privacy**, choose **Data Not Collected**. Apple's label covers
data that leaves the device. Nothing Duofari handles ever leaves it:

| Claim | Where to check |
|---|---|
| No network requests | `extension/*.js` contains no `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` or `EventSource`. The Swift files in `apple/` contain no `URLSession`. The only `URL` in the app opens the Settings app (`UIApplication.openSettingsURLString`). |
| Settings stay on the device | `shared-settings.js` reads and writes `storage.local` only. Its comment notes that `storage.sync` doesn't sync in Safari anyway. |
| The native message carries only device facts | `background.js` sends `{ type: 'device' }`. `SafariWebExtensionHandler.swift` replies with `screenWidth`, `screenHeight`, `scale`, `nativeScale` and `model`. `background.js` stores the size, scale and model as `device` in `storage.local`, and writes it only when the answer changes. Any other message gets `{ ok: true }`. |
| No tracking, no third-party code | No analytics, advertising or crash-reporting SDKs. `extension/` has no dependencies. The only `devDependency` is Playwright, used by the tests. |
| Privacy manifests agree | `apple/Duofari/PrivacyInfo.xcprivacy` and `apple/Duofari Extension/PrivacyInfo.xcprivacy` declare no tracking, no tracking domains, no collected data types and no required-reason APIs. |

Two things on the device might look like data collection, but neither leaves it:

- The host names of sites the user turns Duofari on or off for (`disabledSites`,
  `enabledSites`).
- The text in the popup's Diagnostics section. The popup builds it when it opens. It reaches
  the clipboard only when the user taps **Copy**.

[PRIVACY.md](../PRIVACY.md) lists every stored key and every permission.

## iPhone only, and only useful on iPhone Duo

- **iPhone only** is enforced. The project sets `TARGETED_DEVICE_FAMILY = 1`.
- **Useful only on iPhone Duo** is not enforced. Nothing in the research behind this project
  names a `UIRequiredDeviceCapabilities` value, or any other key, that limits an app to a
  foldable iPhone or to one where Safari has a side column. The project sets no such key.
  Anyone with an iPhone that runs iOS 27 can install Duofari.
- What each part does on other iPhones:
  - The app recognises iPhone Duo by screen shape and scale (`DeviceInfo.swift`). Elsewhere it
    says: "On this screen Safari has no column, so Duofari stays idle."
  - The extension's popup says "Not an iPhone Duo".
- Say it in the metadata. "Requires iPhone Duo" opens the description. Optionally, the subtitle
  can name iPhone Duo as well.
- In **Pricing and Availability**, look at the availability options for Macs with Apple silicon
  and for Apple Vision Pro. Turn them off. Duofari has nothing to do on either.

## App Review notes

Paste this into **App Review Information > Notes**, and fill in the placeholders:

```text
Duofari is a Safari web extension for iPhone Duo. It changes web pages only on iPhone Duo's folded outer display, where Safari shows its controls in a column on the right. There, it lets header bars, background colours and a page's lead image continue under that column, while text, links and buttons stay where they were.

On other iPhones, and on iPhone Duo's unfolded inner display (where Safari has no side column), Duofari does nothing by design. The app says so on its main screen, and the extension's popup in Safari says "Not an iPhone Duo" or "Nothing to extend here".

To try it on iPhone Duo:
1. Open Duofari and tap Open Settings (or go to Settings > Apps > Safari > Extensions > Duofari).
2. Switch on Allow Extension. Under Permissions, set All Websites to Allow.
3. Fold the phone and open Safari in portrait. Visit <demo-page-url>, or any site with a coloured header bar.
4. The header colour and the top image continue under Safari's side controls. Tap the extensions button in Safari and choose Duofari. The popup reports what it changed, for example "Extended 2 bars and 1 image" and "Safari’s controls take 84 points on the right." If All Websites is not set to Allow, the popup shows "For now Duofari can see only this page" in place of the second line (or says "Duofari can’t see this site yet") and offers Allow on All Websites, which asks Safari for access.
5. Under More, turn on "Show what’s extended" to outline every element Duofari changed. Turn off "On for <site>" to see the page without Duofari. The page changes back at once, without a reload.

Without an iPhone Duo: the attached screen recording shows the same steps in the iPhone Duo Simulator in Xcode 27.1, folded, in portrait.

Permissions: Duofari needs access to all websites so it can adjust pages as they open. It makes no network requests and collects no data. It uses native messaging only to ask the Duofari app for the screen size, scale and model, because Safari's fingerprinting protection can hide the real screen size from web pages.

No account or sign-in is needed.
```

`<demo-page-url>` can be a public copy of one of your own test pages, such as
`test/fixtures/news.html` or `test/fixtures/blog.html` with the `test/fixtures/img/` folder.
Don't send reviewers to someone else's site.

### Testing without an iPhone Duo

App Review may not have an iPhone Duo. Give them a recording from the Simulator:

1. In Xcode 27.1, run the **Duofari** scheme on the iPhone Duo Simulator.
2. In the Simulator's Settings app, turn the extension on as in the notes above.
3. Put the simulated iPhone Duo in its folded pose, in portrait.
4. On the Mac, run `node test/serve.mjs`. In the Simulator's Safari, open
   `http://localhost:8080/fixtures/news.html`. In the Simulator, `localhost` reaches the Mac.
5. Record with `xcrun simctl io booted recordVideo <file>.mov`. Stop the recording with
   Ctrl-C. Show the page with Duofari off (the **On for localhost** switch) and then on.
6. Attach the video under App Review Information, or put a link to it in the notes.

**The `force` setting won't help App Review.** `extension/shared-settings.js` defines
`force: false` and `forceColumn: 84`. With `force` on, `content-geometry.js` acts as if the
device were an iPhone Duo with a column `forceColumn` points wide. The unit tests use it. Nothing
lets a user turn it on: `popup.html` has no control for `force` or `forceColumn`, and neither
does the app. A developer can only set it by writing to the extension's `storage.local`. And even
when it is on, another iPhone has no column to paint into, so the extended parts end up past the
right edge of the screen and nothing looks different. Leave it out of the review notes.

## Screenshots

App Store Connect's screenshot specifications list these sizes for iPhone Duo:

| Display | Portrait | Landscape |
|---|---|---|
| Outer (folded) | 1398 × 2034 px | 2034 × 1398 px |
| Inner (open) | 2007 × 2853 px | 2853 × 2007 px |

Apple says these are required from April 2027 for apps built with the iOS 27.1 SDK or later.
Check in App Store Connect which ones it asks for when you upload.

What to show:

- **Outer display, portrait.** This is where Duofari works. A pair of shots works well: the
  same page with Duofari off and on.
- **Inner display.** Duofari is idle there by design. Show the Duofari app's main screen
  rather than an effect that doesn't happen.
- **Other iPhone sizes.** If App Store Connect also asks for the standard iPhone sizes, a capture
  from another iPhone shows nothing changed. One option is to place a Duo capture, framed and
  captioned, on a canvas of the required size. The screenshot specifications list the current
  sizes.

How to make them:

- Capture from an iPhone Duo or the iPhone Duo Simulator, for example with
  `xcrun simctl io booted screenshot <file>.png`. Then check the pixel size against the table
  above.
- Don't use `docs/images/*.png`. The before/after previews (`appstore-story.png`, `news.png`,
  `blog.png`) were rendered in Chromium with Safari's column drawn onto them afterwards, and
  they are 2200 × 1440 px. `popup.png` is a 764 × 1400 px Chromium capture from the popup tests.
  None of them is a capture of Safari.
- Use your own pages, served with `node test/serve.mjs`: `test/fixtures/news.html` and
  `test/fixtures/blog.html` are generic. Avoid `test/fixtures/appstore-story.html` in store
  screenshots: it imitates an App Store editorial page ("Favorite finds from App Store
  Editors"). Avoid other companies' sites and brands too.
- Turn off **Show what’s extended** for the main shots. One extra shot with it on can explain
  what Duofari changed.

## Review risks raised during design

A design review of this project flagged these risks:

- **"Doesn't work" rejections.** A reviewer on another iPhone sees no change. The answer is
  everything above: "Requires iPhone Duo" opening the description, the review notes, the
  Simulator recording, and the app saying plainly that it is idle on other screens.
- **A thin containing app.** App Review expects an app that contains an extension to offer some
  functionality of its own, such as help screens or settings. Duofari's app explains what the
  extension does, shows whether it is on, and opens its settings.
- **The name.** "Duofari" combines Apple's "Duo" and "Safari", and the review mentioned
  guideline 5.2.5. Have a fallback name ready that contains neither word.

## Sources

- App Store Connect screenshot specifications:
  https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications
- Apple upcoming requirements (Xcode 26 / iOS 26 SDK minimum):
  https://developer.apple.com/news/upcoming-requirements/
- Packaging and distributing Safari Web Extensions with App Store Connect:
  https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect
- How users get and turn on extensions on iPhone:
  https://support.apple.com/guide/iphone/get-extensions-iphab0432bf6/ios
