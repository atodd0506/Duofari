# Duofari privacy policy

Effective 2026-10-24. This policy covers Duofari 1.0.0: the Duofari app for iPhone and the Duofari
Safari extension that comes with it.

## Summary

- Duofari collects no data. There are no accounts, analytics, ads, trackers or third-party
  code.
- Duofari makes no network requests. Neither the extension nor the app has code that sends
  anything over the network.
- Duofari keeps its settings on your iPhone, in the extension's local storage.
- To do its job, Duofari reads the layout of the web pages you open and changes their styles.
  This happens in Safari, on your iPhone. Duofari does not keep or send what it reads.

## What the extension reads on web pages

The extension runs on `http` and `https` pages, in the top frame only. Content inside frames is
not touched. On each page it reads:

- The layout: element sizes and positions, computed styles, and whether an element contains
  text. It does this to find header bars, backgrounds and images that reach the right edge.
- For images: the alt text, title, `aria-label`, file name and class names. These tell photos
  apart from charts, maps and screenshots, which Duofari leaves alone.
- The screen and viewport: screen size, pixel ratio, layout and visual viewport size, zoom,
  orientation, the page's text direction, its viewport meta tag, and whether
  `prefers-reduced-transparency` matches. From these Duofari works out whether Safari's side
  column is showing, and how wide it is.
- The page's host name, such as `www.example.com`, to apply your per-site setting.

All of this stays in memory, in that page, while the page is open. None of it is sent anywhere.
The only part that can be written to storage is a site's host name, and only when you use the
popup's **On for** switch (see [What Duofari stores](#what-duofari-stores)).

Duofari does not read form fields, passwords, cookies or your browsing history.

## What Duofari changes on pages, and what pages can see

- **Inline styles.** Duofari adds inline styles, marked `!important`, to the elements it
  extends. It saves the original values in a `data-duofari` attribute on each changed element,
  so it can undo the change exactly.
- **Page guard.** It sets `touch-action` on `html`, `body` and some wrappers, and
  `overscroll-behavior-x` on `html`. This is the "Hold pages steady" setting. Whether that
  setting is on or off, Duofari scrolls the page back if it slides sideways further than it
  could without Duofari.
- **Viewport meta.** On some pages it adds `initial-scale=1` and `minimum-scale=1` to the page's
  viewport meta tag.
- **Helper elements.** It briefly adds an invisible measuring element marked
  `data-duofari-ui` and removes it straight away. When **Show what’s extended** is on, it also
  adds an overlay and `data-duofari-debug` attributes.

A page's own scripts can see these changes, so a website could tell that Duofari is running.
Duofari gives the page nothing beyond these changes. Turning Duofari off for a site removes them
from the open page.

## What Duofari stores

Settings live in the extension's `storage.local` area in Safari, on your iPhone. Duofari does not
use `storage.sync` and does not copy them anywhere else.

| Key | What it holds |
|---|---|
| `enabled`, `bands`, `media`, `allImages`, `breakout`, `landscapeSide`, `desktopPages`, `holdSteady`, `debug` | The switches in the popup: on/off values, and Auto, Left or Right for landscape |
| `disabledSites` | Host names of sites you turned Duofari off for |
| `enabledSites` | Host names of built-in excluded web apps (such as Google Docs or Figma) that you turned Duofari on for |
| `force`, `forceColumn` | A testing switch (off) and a column width (84). Nothing in the popup or the app changes them. |
| `device` | Your iPhone's screen width and height in points, its scale, its model identifier, and when Duofari last checked them (see the next section) |

A site's host name is stored only when you use the **On for** switch in the popup. When you set a
site back to its default, its name is removed from the list.

## Native messaging with the Duofari app

Safari can hide the real screen size from web pages, for example through Advanced
Fingerprinting Protection in Private Browsing. Duofari needs the screen size to recognise iPhone
Duo, so the extension asks the Duofari app instead:

- **When.** `background.js` sends `{ type: 'device' }` to the app's extension handler when
  the extension is installed, when Safari starts, and whenever you open the Duofari popup.
- **The reply.** `SafariWebExtensionHandler.swift` answers with the main screen's width and
  height in points, its `scale` and `nativeScale`, and the hardware model identifier. Any other
  message gets `{ ok: true }`.
- **What is kept.** `background.js` stores the width, height, scale, model and the time of the
  check as `device`. It does not keep `nativeScale`.
- **What it's used for.** The screen size and scale are used to recognise iPhone Duo. The model
  identifier is only shown in the popup's Diagnostics.
- **Logging.** The handler writes each message and its reply to the iPhone's system log at debug
  level. That log stays on the device.

Nothing in this exchange leaves your iPhone.

## The Duofari app

The app:

- shows what Duofari does and how to turn it on;
- asks Safari whether the extension is on (`SFSafariExtensionManager`);
- opens Duofari's page in Safari's extension settings (`SFSafariSettings`), or the Settings app;
- reads the screen's size, scale and device type, to tell you when the screen isn't an iPhone
  Duo outer display.

The app stores nothing and makes no network requests.

## Permissions and why Duofari needs them

| Permission | Why |
|---|---|
| Access to all websites (`host_permissions: *://*/*`, content scripts on `http://*/*` and `https://*/*`) | To adjust each page as it opens. Duofari can't know in advance which sites have header bars or images to extend. Safari asks you to grant this, and you can change it at any time in **Settings > Apps > Safari > Extensions > Duofari**. |
| `storage` | To keep your settings (see above). |
| `nativeMessaging` | To ask the Duofari app for the real screen size (see above). |
| `scripting` | To run Duofari on a tab that was already open. The popup's **Allow on All Websites** and **Apply to This Page** buttons use it, so you don't have to reload. |
| `activeTab` | To let the popup work with the tab you're looking at when you open it: ask it for its status, and run Duofari on it. |

If Duofari has no access to the current site, the popup can ask Safari for access to all
websites (`permissions.request`). Safari shows its own prompt, and you decide.

The popup reads the current tab's address to check that it is a web page. It asks the page for
Duofari's status, and if you tap **Apply to This Page** and Duofari can't run, it reloads the
tab.

## Diagnostics and bug reports

The popup's **Diagnostics** section (under **More**) shows technical details for bug reports.
The popup builds this text only while it is open. The text goes to the clipboard only when you
tap **Copy**, and from there it goes only where you paste it.

It contains:

- the Duofari version;
- screen size, pixel ratio, viewport sizes, zoom, orientation and text direction;
- the page's viewport meta tag, the measured column, the side, and the page's own sideways
  overflow;
- whether the touch lock is on, and the counts of what Duofari extended;
- the device information from the app, including the model identifier;
- Safari's user agent string.

When Duofari hasn't run on a page, it contains the page's address instead. Read the text before
you share it, and remove anything you don't want to share. Issues in a public GitHub
repository are public.

## What Duofari never does

- Send data anywhere. The extension's code contains no `fetch`, `XMLHttpRequest`,
  `sendBeacon`, `WebSocket` or `EventSource`, and the app's code contains no `URLSession`.
- Track you, show ads, or include analytics or other third-party SDKs.
- Read form fields, passwords, cookies or browsing history.
- Sell or share data. It has none to sell or share.

## Privacy manifests and the App Store label

The app and the extension each include a `PrivacyInfo.xcprivacy` file. Both declare no tracking,
no tracking domains, no collected data types and no required-reason APIs. On the App Store,
Duofari's privacy label is "Data Not Collected".

## Data Apple handles

Apple runs the App Store and iOS, and it handles some data under its own privacy policy, not
this one. One example: if you share analytics with app developers in iOS's privacy settings,
Apple may pass crash reports for the Duofari app to its developer. Duofari adds nothing to them.

## Removing Duofari and its data

- Switch off **Duofari on all websites** in the popup, or a site's **On for** switch. Duofari
  then undoes its changes on open pages.
- To turn the extension off in Safari, switch off **Allow Extension** in **Settings > Apps >
  Safari > Extensions > Duofari**.
- To delete Duofari, delete the Duofari app. That removes the extension from Safari.

## Children

Duofari collects no data from anyone, children included.

## Changes to this policy

Changes to this policy are made in this file. You can see every past version in the
repository's history. The effective date at the top changes with each update.

## Contact

Questions about privacy: open an issue at `<your-repo-url>/issues`.
