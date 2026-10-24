# Duofari support

Duofari is a Safari extension for iPhone Duo. On the folded outer display, Safari keeps its
controls in a column on the right, and web pages stop where that column begins. Duofari lets
header bars, backgrounds and lead images continue under the column. Text, links and buttons stay
where they were.

- [Turn Duofari on](#turn-duofari-on)
- [Where Duofari works](#where-duofari-works)
- [What the popup is telling you](#what-the-popup-is-telling-you)
- [Common questions](#common-questions)
- [Send a report](#send-a-report)
- [Contact](#contact)

> **Not yet checked on iPhone Duo hardware.** Duofari has been tested in an emulation of the
> folded iPhone Duo, not on the device itself. Some things can only be confirmed on a real
> device: what Safari actually draws under its column, how fixed header bars look there, and
> how touch behaves. If something looks wrong, a report helps a lot (see
> [Send a report](#send-a-report)).

## Turn Duofari on

1. Open the Duofari app and tap **Open Settings**, or go to **Settings > Apps > Safari >
   Extensions > Duofari** yourself.
2. Switch on **Allow Extension**. Do the same for each Safari profile you use, and for
   **Private Browsing** if you want Duofari there too.
3. Under **Permissions**, set **All Websites** to **Allow**.
4. Reload any tabs that were already open.

To open Duofari's popup, tap the extensions button in Safari and choose **Duofari**. It shows
what Duofari did on the current page and holds all its settings.

## Where Duofari works

| Situation | What Duofari does |
|---|---|
| iPhone Duo folded, portrait | Works. |
| iPhone Duo folded, landscape | Extends backgrounds only, no images, unless you choose the side of Safari's controls. With the controls on the left, left-to-right pages are left alone (see [Landscape](#landscape)). |
| iPhone Duo open (inner display) | Nothing. Safari has no side column there. |
| Other iPhones | Nothing. |
| Right-to-left pages in portrait | Left alone. |
| Pages laid out for desktop screens | Skipped unless you turn on **Also adjust desktop-layout pages**. |
| Some web apps, such as Google Docs, Figma, Slack and Notion | Off by default. You can turn Duofari on for each one. |
| Safari's own pages, Reader, PDFs | Not changed. |
| Embedded content (frames) | Not changed. |

## What the popup is telling you

The status is at the top of the popup. When Duofari is working, it says what it did, for
example "Extended 3 bars and 2 images" and "Safari’s controls take 84 points on the right." When
Duofari is not working, the popup says why:

| The popup says | What it means | What you can do |
|---|---|---|
| Checking this page… | Duofari is still starting on this page. | Wait a moment, then open the popup again. |
| On, nothing to extend yet | Duofari is on, but nothing on this page reaches the right edge with a background or picture that can continue. | Nothing. Many pages have nothing to extend. In landscape with **Auto**, images are never extended. |
| Not an iPhone Duo | The screen doesn't look like iPhone Duo's. | On another iPhone, this is expected. On iPhone Duo, see [Private Browsing](#private-browsing-and-profiles). |
| Nothing to extend here: "Safari is using the full width of the screen." | iPhone Duo is open. Safari has no side column on the inner display. | Fold iPhone Duo. Duofari applies again on the outer display. |
| Nothing to extend here: "Safari’s side column isn’t showing next to this page." | The space beside the page is wider than 110 points, which can't be Safari's column. | If you see this while folded, [send a report](#send-a-report). |
| Desktop layout | The page is laid out for a wider screen, so Safari shows it zoomed out. | Turn on **Also adjust desktop-layout pages** under **More**. |
| Controls on the wrong side | Safari's controls are on the side where the page's lines begin. Pages can only extend past the edge where their lines end. This happens with right-to-left pages in portrait, and with left-to-right pages in landscape when the controls are on the left. | Nothing for that page. In landscape, if Safari's controls are really on the right, set **Safari’s controls in landscape** to **Right** under **More**. |
| Reduce Transparency is on | Duofari stands down when Reduce Transparency is on, because Safari's column may become opaque and hide anything under it. Whether Safari tells pages about this setting has not been confirmed. | To use Duofari, turn off **Reduce Transparency** in **Settings > Accessibility > Display & Text Size**. |
| Paused on this page | The page kept changing size while Duofari worked: more than 4 on/off changes in 10 seconds. Duofari stepped back. | Reload the page. Changing any setting in the popup also makes Duofari try again. If it keeps pausing, [send a report](#send-a-report). |
| Duofari is off | The main switch is off. | Turn on **Duofari on all websites** under **More**. |
| Off for this site | You turned Duofari off for this site. | Turn on the **On for** switch near the top of the popup. |
| Off for this web app | The site is on Duofari's list of web apps that draw their own full-screen interface. | To try Duofari there, turn on the **On for** switch. |
| Not active | A state the popup has no message for. | [Send a report](#send-a-report). |

While you're pinch-zoomed in, Duofari leaves the page as it is and the popup keeps showing the
status from before you zoomed. The popup has a "Paused while zoomed in" message, but this
version never shows it.

The popup can also say:

| The popup says | What it means | What you can do |
|---|---|---|
| No page open | No page is open in the current tab. | Open a web page. |
| Duofari can’t change this kind of page | Safari's own pages, Reader and PDFs can't be changed. | Nothing. Duofari works on websites. |
| Duofari can’t see this site yet | Duofari doesn't have access to this site. | Tap **Allow on All Websites**, then accept Safari's prompt. You can also allow it in **Settings > Apps > Safari > Extensions > Duofari**, under **Permissions**. |
| Duofari hasn’t run on this page yet | The page was open before Duofari was turned on, or it's still loading. | Tap **Apply to This Page**. If Duofari can't run on the page as it is, it reloads the page. |

## Common questions

### A site looks wrong

1. Open the popup and turn off the **On for** switch, which shows the site's name. Duofari
   undoes its changes on the page at once, without a reload, and remembers this for the site.
   The switch applies to that exact name: `www.example.com` and `example.com` count as two sites.
2. To see what Duofari changed, turn on **Show what’s extended** under **More**:
   - A hatched strip marks Safari's column.
   - Pink dashed outlines mark what Duofari extended. Blue outlines mark elements it held in
     place.
   - A badge such as "Duofari · 84px right · 3 bars · 2 images · locked" sums it up.
3. If you turned on **Every full-width image** or **Enlarge photos inside page margins**, try
   the page without them. They change more than the default settings do.
4. [Send a report](#send-a-report), so the site can be fixed for everyone.

### Photos got bigger and the text below them moved down

**Enlarge photos inside page margins** is on. It is the only setting that changes a page's
layout: photos grow to the full width before you scroll to them, and text below them moves
down. Turn it off under **Extend under the controls**.

### Pictures look trimmed at the top and bottom

**Every full-width image** is on. To widen each picture without changing its height, it trims a
little from the top and bottom. Turn it off if you'd rather see whole pictures.

The lead image near the top of a page is widened the same way unless it has cropped-away art to
show. To keep it whole too, turn off **Lead image and wide artwork**.

### The page slides sideways

Extending a header under Safari's column makes the page wider than the screen, so it could be
dragged sideways. **Hold pages steady** (under **More**, on by default) stops that:

- While it's on, you can only scroll the page itself up and down. Carousels and other parts of
  the page that scroll sideways keep working.
- While it's off, a page can be pushed sideways, but it slides back once scrolling stops.
- If a page could already scroll sideways before Duofari, Duofari leaves that alone. It only
  stops the page from going further than it could before.
- While you're pinch-zoomed in, Duofari stops holding the page, so you can move around the
  zoomed page freely.

If a page slides sideways and stays there while **Hold pages steady** is on,
[send a report](#send-a-report).

### Double-tap zoom or swiping back doesn't work

**Hold pages steady** turns off double-tap zoom, and swiping back from the middle of a page.
Pinch-to-zoom still works. To get both back, turn off **Hold pages steady** under **More**.
Pages may then slide sideways a little when you swipe, and slide back after you scroll.

### Landscape

Nobody has confirmed yet which side Safari's column is on when the folded iPhone Duo is turned
sideways. The **Safari’s controls in landscape** setting under **More** has three choices:

- **Auto** (default) guesses the side from how the phone is turned. Because the guess may be
  wrong, it extends backgrounds only, not images. When it guesses the left side, it leaves
  left-to-right pages alone (see the last point).
- **Left** or **Right** tells Duofari which side the column is on, and images extend too. The
  choice applies to both ways of turning the phone.
- Pages can only extend under controls on the side where their lines end. That's the right
  side for most languages. With the column on the left, the popup says "Controls on the wrong
  side".

### iPhone Duo is open

When iPhone Duo is open and Safari fills the inner display, Safari has no side column, so
Duofari does nothing. The popup says "Nothing to extend here". When you fold the phone, Duofari
measures the column again and applies itself to the page. Split View on the inner display
hasn't been tested yet.

### Private Browsing and profiles

- Duofari has to be allowed separately for each Safari profile and for Private Browsing. See
  [Turn Duofari on](#turn-duofari-on).
- Safari's Advanced Fingerprinting Protection, which is on by default in Private Browsing, can
  hide the real screen size from web pages. Duofari asks the Duofari app for it instead, and
  does so again each time you open the popup.
- If the popup says "Not an iPhone Duo" in Private Browsing:
  1. Close the popup and open it again.
  2. Reload the page.
  3. If it still says so, look at `deviceFromApp` in **Diagnostics**. If it says `null`, the
     app's answer didn't arrive. [Send a report](#send-a-report).

### Safari's column shows a solid colour instead of the picture

Safari sometimes paints its column with one solid colour. WebKit's source shows it doing this
when the page has a fixed or sticky bar along most of its right edge (90% or more). Duofari can't change this. Anything
under the column is hidden, but text and controls are unaffected. Live Activities in the column
may cover part of what's underneath too. None of this has been checked on a real device yet.
Screenshots of what you see are welcome.

### Text or buttons end up under Safari's controls

Duofari never moves text, links or buttons into the column. To check whether the page does this
by itself, turn off the **On for** switch. If the text moves out of the column once Duofari is
off, [send a report](#send-a-report).

### Duofari doesn't change anything after I turned it on

- Reload the page. Pages opened before you turned Duofari on aren't changed until you reload
  them or tap **Apply to This Page** in the popup.
- Check that **All Websites** is set to **Allow** for Duofari in Safari's extension settings.
- Read the popup's status line and look it up [above](#what-the-popup-is-telling-you).

### Do my settings sync to my other devices?

No. Duofari keeps its settings on each device. See [PRIVACY.md](PRIVACY.md).

### How do I turn Duofari off or remove it?

- To turn it off everywhere, switch off **Duofari on all websites** under **More**. Open pages
  go back to how they were, without a reload.
- To turn the extension off in Safari, switch off **Allow Extension** in **Settings > Apps >
  Safari > Extensions > Duofari**, then reload open pages.
- To remove it, delete the Duofari app.

## Send a report

1. Open the page where the problem happens, and open the Duofari popup.
2. Open **More**, then **Diagnostics**, and tap **Copy**. The button changes to "Copied". If
   copying isn't allowed, the text is selected instead, and you can copy it by hand.
3. Open a new issue at `<your-repo-url>/issues` and paste the text.
4. Add:
   - the page's address, if you're happy to share it;
   - whether iPhone Duo was folded or open, and in portrait or landscape;
   - what you expected and what you saw;
   - a screenshot, ideally one with **Show what’s extended** on and one with it off.

What **Diagnostics** contains:

- the Duofari version;
- screen size, pixel ratio, viewport sizes, zoom, orientation and text direction;
- the page's viewport meta tag, the measured column width and side, and the page's own sideways
  overflow;
- whether the page is held steady, and how many bars and images were extended;
- the screen information from the Duofari app, including the iPhone's model identifier;
- Safari's user agent string;
- if Duofari hasn't run on the page, the page's address.

Issues are public. Read the text before you post it, and remove anything you'd rather not share.
Duofari never sends any of this by itself. See [PRIVACY.md](PRIVACY.md).

### For testers

To check Duofari on an iPhone Duo or in the iPhone Duo Simulator in Xcode 27.1:

1. On a computer with the repository, run `node test/serve.mjs`.
2. In Safari on the phone, open the `/device/` address it prints. The phone has to be on the
   same Wi-Fi network. In the Simulator, `localhost` works too.
3. The page checks what Safari draws under the column, fixed bars, the other side, sideways
   scrolling, rotating and unfolding.
4. **Copy report** copies the results for an issue.

## Contact

Bug reports, questions and feature requests: `<your-repo-url>/issues`.
