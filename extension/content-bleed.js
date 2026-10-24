// Extends an element's painted box into Safari's column without moving its
// content, verifying every change and rolling back anything that misbehaves.
//
// All changes are inline `!important` declarations. They reach into shadow
// roots and beat ordinary site CSS, and each original value is saved so a
// change can be reverted exactly. Changed elements carry a `data-duofari`
// attribute holding those originals, so copies the page makes of them
// (sticky-header clones, carousel loop slides) can be cleaned up too.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});
  if (D.controller) return; // already running in this page

  const EPS = 0.75;          // px tolerance when comparing layout boxes
  const EDGE_EPS = 1.25;     // px tolerance when checking an extended edge
  const HIDDEN_SCAN_LIMIT = 12000;
  const ABS_SCAN_LIMIT = HIDDEN_SCAN_LIMIT; // past these the padding recipe isn't used
  const ABS_KEEP_LIMIT = 400;
  const LATE_SCAN_LIMIT = 2000;             // per scan, for positioned boxes that appear later
  const NEAR_PSEUDO_LIMIT = 8;              // children whose pseudo-elements are read up front
  const MARK = 'data-duofari';
  D.MARK = MARK;

  /** @type {Map<Element, object>} every element Duofari has modified */
  const records = new Map();
  D.records = records;

  /** Recipes that worked for elements with the same styling, tried first next time. */
  const recipeCache = new Map();

  // ---------------------------------------------------------------------------
  // Inline style bookkeeping

  /** Style attributes as they were before withoutTransitions() touched them. */
  const entryAttrs = new Map();
  /** The page's own style attribute, from the first time any part of Duofari touched an element. */
  const originals = new WeakMap();

  D.originalStyle = function originalStyle(el) {
    if (!originals.has(el)) originals.set(el, entryAttrs.has(el) ? entryAttrs.get(el) : el.getAttribute('style'));
    return originals.get(el);
  };

  function record(el, kind) {
    let rec = records.get(el);
    if (!rec) {
      rec = {
        el, kind, recipe: '', saved: new Map(), applied: new Map(),
        styleAttr: D.originalStyle(el),
        pins: [], owner: null, expect: null,
        sides: null, C: 0, dirty: false,
        source: sourceKey(el),
      };
      records.set(el, rec);
    }
    return rec;
  }

  function setStyles(rec, props) {
    const style = rec.el.style;
    // A longhand of an inline shorthand that uses var() reads as '' and
    // couldn't be put back on its own, so such elements are left alone (the
    // unchanged geometry fails verification).
    const inline = [...style];
    if (Object.keys(props).some((p) => !rec.saved.has(p) && !style.getPropertyValue(p) && inline.includes(p))) return;
    for (const [prop, value] of Object.entries(props)) {
      if (!rec.saved.has(prop)) {
        rec.saved.set(prop, { value: style.getPropertyValue(prop), priority: style.getPropertyPriority(prop) });
      }
      style.setProperty(prop, value, 'important');
      // Keep the browser's own serialisation ('0px 0px' reads back as
      // '0px'), so stylesIntact compares like with like.
      rec.applied.set(prop, style.getPropertyValue(prop));
    }
    rec.el.setAttribute(MARK, JSON.stringify([...rec.saved].map(([p, o]) => [p, o.value, o.priority])));
  }

  function restoreStyles(rec) {
    const style = rec.el.style;
    for (const [prop, orig] of rec.saved) {
      // The page has set this property itself since: its value wins.
      if (!ours(style, prop, rec.applied.get(prop))) continue;
      if (orig.value) style.setProperty(prop, orig.value, orig.priority);
      else style.removeProperty(prop);
    }
    rec.saved.clear();
    rec.applied.clear();
    rec.el.removeAttribute(MARK);
    D.tidyStyleAttribute(rec.el, rec.styleAttr);
  }

  const scratch = document.createElement('div');

  /**
   * Puts the style attribute back byte for byte when its declarations match
   * the page's original, and removes it if the page had none. (Reading the
   * attribute first flushes the engine's lazily serialised inline style;
   * removing it while that is pending can leave `style=""` behind.)
   */
  D.tidyStyleAttribute = function tidyStyleAttribute(el, original) {
    const current = el.getAttribute('style');
    if (original === null) {
      if (current !== null && el.style.length === 0) el.removeAttribute('style');
      return;
    }
    if (current === original) return;
    scratch.setAttribute('style', original);
    if (scratch.style.cssText === el.style.cssText) el.setAttribute('style', original);
  };

  /** Reverts an element (and the children it pinned) to the page's own styles. */
  function revert(el) {
    const rec = records.get(el);
    if (!rec) return;
    // Whatever was extended inside a clipper is clipped at the page's edge
    // again once the clipper is reverted. Revert it too, so extending it
    // again extends the clipper first.
    if (rec.clips) {
      for (const [inner, r] of records) if (inner !== el && !r.owner && contains(el, inner)) revert(inner);
    }
    withoutTransitions([el], () => {
      for (const pin of rec.pins) revert(pin.el);
      rec.pins = [];
      restoreStyles(rec);
      el.getBoundingClientRect(); // settle the reverted style before transitions return
    });
    records.delete(el);
  }
  D.revert = revert;

  D.revertAll = function revertAll() {
    for (const el of [...records.keys()]) if (records.has(el)) revert(el);
  };

  /** Drops records of elements the page has removed (restoring them in case they come back). */
  D.pruneDetached = function pruneDetached() {
    for (const el of [...records.keys()]) {
      const rec = records.get(el);
      if (rec && !rec.owner && !el.isConnected) revert(el);
    }
  };

  /** An element carrying Duofari's mark that Duofari doesn't know: a copy made by the page. */
  D.cleanClone = function cleanClone(el) {
    if (records.has(el)) return false;
    let saved;
    try {
      saved = JSON.parse(el.getAttribute(MARK) || '[]');
    } catch {
      saved = [];
    }
    for (const [prop, value, priority] of saved) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
    el.removeAttribute(MARK);
    D.tidyStyleAttribute(el, null);
    return true;
  };

  /** True when the site has since overwritten one of our declarations. */
  D.stylesIntact = function stylesIntact(rec) {
    const style = rec.el.style;
    for (const [prop, value] of rec.applied) if (!ours(style, prop, value)) return false;
    return true;
  };

  /** Whether `prop` still holds the value Duofari applied. */
  function ours(style, prop, value) {
    return style.getPropertyPriority(prop) === 'important' && normalise(style.getPropertyValue(prop)) === normalise(value);
  }

  function normalise(value) {
    return String(value).replace(/\s+/g, ' ').trim();
  }

  const TRANSITION = ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior'];

  /**
   * Runs `fn` with CSS transitions switched off on `els`. Transitions would
   * animate our changes (and make the boxes we measure report their start
   * values), and also animate reverts. Once the new style has been computed,
   * restoring the transition property starts nothing. `keepRunning` zeroes
   * the durations instead, which starts nothing new either but leaves the
   * page's running transitions alone (`transition: none` cancels them).
   */
  function withoutTransitions(els, fn, { keepRunning = false } = {}) {
    const off = keepRunning ? { 'transition-duration': '0s', 'transition-delay': '0s' } : { transition: 'none' };
    const saved = [];
    for (const el of els) {
      if (!el || !el.style || entryAttrs.has(el)) continue;
      const style = el.style;
      // The longhands of an inline var() shorthand read as '', so it is put
      // back as the shorthand. One a longhand was set over can't be put back
      // at all: that element keeps its transitions.
      const shorthand = [style.getPropertyValue('transition'), style.getPropertyPriority('transition')];
      if (!shorthand[0] && [...style].some((p) => TRANSITION.includes(p) && !style.getPropertyValue(p))) continue;
      const longhands = TRANSITION.map((p) => [p, style.getPropertyValue(p), style.getPropertyPriority(p)]);
      saved.push([el, shorthand, longhands, el.getAttribute('style')]);
      entryAttrs.set(el, el.getAttribute('style'));
      for (const [p, value] of Object.entries(off)) style.setProperty(p, value, 'important');
    }
    try {
      return fn();
    } finally {
      for (const [el, shorthand, longhands, attr] of saved) {
        entryAttrs.delete(el);
        getComputedStyle(el).transitionProperty; // flush the style with transitions off
        if (shorthand[0]) {
          el.style.setProperty('transition', shorthand[0], shorthand[1]);
        } else {
          for (const [p, value, priority] of longhands) {
            if (value) el.style.setProperty(p, value, priority);
            else el.style.removeProperty(p);
          }
        }
        // Touching `transition` re-serialises the style attribute, so tidy it
        // last: back to the page's own attribute if nothing of ours is left.
        const rec = records.get(el);
        if (!rec) D.tidyStyleAttribute(el, attr);
        else if (!rec.applied.size) D.tidyStyleAttribute(el, rec.styleAttr);
      }
    }
  }
  D.withoutTransitions = withoutTransitions;

  // ---------------------------------------------------------------------------
  // Geometry helpers

  const px = (value) => parseFloat(value) || 0;
  const close = (a, b, eps = EPS) => Math.abs(a - b) <= eps;
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const round = (n) => Math.round(n * 100) / 100;

  function boxes(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth);
    const pl = px(cs.paddingLeft), pr = px(cs.paddingRight);
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      padLeft: r.left + bl, padRight: r.right - br,
      contentLeft: r.left + bl + pl, contentRight: r.right - br - pr, cs,
    };
  }
  D.boxes = boxes;

  /** Whether `cs` makes its element the containing block of absolutely positioned descendants. */
  function containsAbsolute(cs) {
    return cs.position !== 'static' || containsFixed(cs);
  }

  /** Whether `cs` makes its element the containing block of fixed descendants. */
  function containsFixed(cs) {
    return (cs.transform && cs.transform !== 'none') ||
      (cs.translate && cs.translate !== 'none') || (cs.scale && cs.scale !== 'none') || (cs.rotate && cs.rotate !== 'none') ||
      (cs.perspective && cs.perspective !== 'none') ||
      (cs.filter && cs.filter !== 'none') ||
      (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== 'none') ||
      /paint|layout|strict|content/.test(cs.contain || '') ||
      /transform|perspective|filter/.test(cs.willChange || '') ||
      cs.containerType === 'size' || cs.containerType === 'inline-size';
  }
  D.containsFixed = containsFixed;

  /** Whether an element clips its descendants' painting. */
  function clips(el, cs) {
    if (el === document.documentElement) return false;
    if (el === document.body) {
      // body's overflow is propagated to the viewport unless html's isn't visible.
      const root = getComputedStyle(document.documentElement);
      if (root.overflowX === 'visible' && root.overflowY === 'visible') return false;
    }
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible' ||
      /paint|strict|content/.test(cs.contain || '') ||
      (cs.contentVisibility && cs.contentVisibility !== 'visible') ||
      (cs.clipPath && cs.clipPath !== 'none') ||
      (cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none');
  }
  D.clips = clips;

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  }
  D.parentOf = parentOf;

  /** Node.contains, across shadow roots. */
  function contains(ancestor, node) {
    for (let n = parentOf(node); n; n = parentOf(n)) if (n === ancestor) return true;
    return false;
  }

  /**
   * Ancestors that clip `el`, nearest first, following containing blocks:
   * an absolutely positioned box escapes clipping by ancestors below its
   * containing block, and a fixed box escapes everything up to a
   * transformed ancestor.
   */
  D.clippingAncestors = function clippingAncestors(el) {
    const out = [];
    let position = getComputedStyle(el).position;
    let node = parentOf(el);
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const isCB = position === 'fixed' ? containsFixed(cs) : position === 'absolute' ? containsAbsolute(cs) : true;
      if (isCB) {
        if (clips(node, cs)) out.push(node);
        position = cs.position;
      }
      node = parentOf(node);
    }
    return out;
  };

  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,video[controls],[role=button],[role=link],[tabindex],iframe';
  D.INTERACTIVE = INTERACTIVE;

  /** True if `el` has no visible text and nothing interactive: pure artwork. */
  function isArt(el) {
    if (el.matches(INTERACTIVE)) return false;
    if (/^(img|video|picture|canvas|svg)$/i.test(el.localName)) return true;
    if ((el.textContent || '').trim()) return false;
    return !el.querySelector(INTERACTIVE);
  }
  D.isArt = isArt;

  /** Whether `node` paints at all: not hidden, and no ancestor up to `root` fully transparent. */
  function shows(node, root) {
    const own = getComputedStyle(node);
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
    for (let n = node; n && n !== root; n = parentOf(n)) {
      if (parseFloat(getComputedStyle(n).opacity) === 0) return false;
    }
    return true;
  }

  /** Where an element's content (its scrollable overflow) ends on the column side. */
  function contentReach(el, r, sides) {
    const start = r.left + el.clientLeft;
    return sides.right ? start + el.scrollWidth : start + el.clientWidth - el.scrollWidth;
  }

  const inStrip = (left, right, sides, C, vw) =>
    (sides.right && right > vw + 0.5 && left < vw + C) || (sides.left && left < -0.5 && right > -C);

  /**
   * Whether a clipping element currently hides content in the strip the
   * column would open up. Content Duofari extended itself doesn't count.
   */
  function hidesOverflow(el, sides, C, vw) {
    // The walk sees element boxes only. Overflow that none of them accounts
    // for is text, a pseudo-element or closed shadow content: assume it
    // shows. Scrollable overflow includes the clipper's own end padding.
    const box = el.getBoundingClientRect();
    const end = px(getComputedStyle(el)[sides.right ? 'paddingRight' : 'paddingLeft']);
    const reach = contentReach(el, box, sides) + (sides.right ? -end : end);
    const further = (a, b) => (sides.right ? Math.max(a, b) : Math.min(a, b));
    let explained = box.left + el.clientLeft + (sides.right ? el.clientWidth : 0);
    const overflows = sides.right ? reach > explained + 1 : reach < explained - 1;
    const stack = [];
    const enter = (node) => {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      if (node.shadowRoot) for (let i = node.shadowRoot.children.length - 1; i >= 0; i--) stack.push(node.shadowRoot.children[i]);
    };
    enter(el);
    let seen = 0;
    while (stack.length) {
      if (++seen > HIDDEN_SCAN_LIMIT) return true; // too big to be sure: assume it does
      const node = stack.pop();
      const r = node.getBoundingClientRect();
      const sized = r.width > 0 && r.height > 0;
      let ncs = null;
      if (sized && overflows) {
        // A box accounts for overflow up to its margin edge (inline-level
        // boxes' margins count), and an invisible one for its own content
        // too (a hidden marquee's text).
        ncs = getComputedStyle(node);
        explained = further(explained, sides.right ? r.right + Math.max(0, px(ncs.marginRight)) : r.left - Math.max(0, px(ncs.marginLeft)));
        if (ncs.visibility !== 'visible') explained = further(explained, contentReach(node, r, sides));
      }
      if (records.has(node) || node.hasAttribute('data-duofari-ui')) continue;
      if (sized) {
        if (inStrip(r.left, r.right, sides, C, vw) && shows(node, el)) return true;
        // A descendant that clips within the viewport keeps its own overflow hidden.
        if (r.left >= -0.5 && r.right <= vw + 0.5 && clips(node, ncs || getComputedStyle(node))) continue;
      }
      enter(node);
    }
    return sides.right ? reach > explained + 1 : reach < explained - 1;
  }

  /**
   * Whether a node added inside a clipper that Duofari opened up (an element
   * or a text run) paints in the strip the column opened. hidesOverflow only
   * saw what was there when the clipper was extended.
   */
  function showsInStrip(node, rec) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !node.isConnected) return false;
    const vw = rec.sides.right ? rec.expect.right - rec.C : rec.expect.right; // the clipper reaches the edge
    let left = Infinity, right = -Infinity;
    if (node.nodeType === 1) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      left = r.left;
      right = r.right;
      if (!clips(el, getComputedStyle(el))) {
        const reach = contentReach(el, r, rec.sides);
        left = Math.min(left, reach);
        right = Math.max(right, reach);
      }
    } else {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (!(r.width > 0 && r.height > 0)) continue;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
      }
    }
    if (!inStrip(left, right, rec.sides, rec.C, vw)) return false;
    // A clipping box in between that ends at the viewport keeps it hidden.
    for (let a = node.nodeType === 1 ? parentOf(el) : el; a && a !== rec.el; a = parentOf(a)) {
      const r = a.getBoundingClientRect();
      if (r.left >= -0.5 && r.right <= vw + 0.5 && clips(a, getComputedStyle(a))) return false;
    }
    return shows(el, rec.el);
  }

  /**
   * Absolutely positioned boxes whose containing block is `el`, and (with
   * `pseudos`) the static boxes in between, whose positioned ::before/::after
   * have `el` as their containing block too. Their position depends on el's
   * padding box, which the padding recipe enlarges. "Cover" layers fill that
   * padding box (a hero image at inset: 0, a dimming overlay) and are meant
   * to grow with it. `truncated` means the walk stopped before seeing them all.
   * Without `pictures` (Auto landscape) no layer drawing a picture counts as cover.
   */
  function absoluteChildren(el, cs, before, { limit = ABS_SCAN_LIMIT, pseudos = false, pictures = true } = {}) {
    const out = { kids: [], statics: [], truncated: false };
    if (!containsAbsolute(cs)) return out;
    const fixedToo = containsFixed(cs);
    const stack = [...el.children].reverse();
    if (el.shadowRoot) stack.push(...el.shadowRoot.children);
    let seen = 0;
    while (stack.length) {
      if (seen >= limit || out.kids.length >= ABS_KEEP_LIMIT) {
        out.truncated = true;
        break;
      }
      const node = stack.pop();
      seen++;
      const ncs = getComputedStyle(node);
      if (ncs.display === 'none') continue;
      const positioned = ncs.position === 'absolute' || (fixedToo && ncs.position === 'fixed');
      if (positioned) {
        const rect = node.getBoundingClientRect();
        const fills = close(rect.left, before.padLeft, 1.5) && close(rect.right, before.padRight, 1.5);
        const cover = fills && growsWithBox(node, rect, pictures);
        out.kids.push({
          el: node, rect, cover, place: placement(node, rect, ncs),
          // How much of a cover-fitted picture is cropped away, measured before
          // the box grows, so it can be revealed rather than rescaled.
          slack: cover && /^(img|video)$/.test(node.localName) ? D.coverSlack(node) : null,
        });
      }
      // Descendants of a nested containing block are positioned against it.
      if (positioned || containsAbsolute(ncs)) continue;
      if (pseudos) out.statics.push(node);
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return out;
  }

  /**
   * Whether a layer that fills the padding box may grow with it: a picture
   * fitted with object-fit cover or fill (re-cropped, not stretched), or a
   * textless box of background art (a tint, slides, a parallax backdrop)
   * whose pictures are cover-fitted and fill it. A layer with foreground in
   * it (a centred logo, a contained product shot, a play icon drawn as a
   * background image) keeps its place, and so, without `pictures`, does
   * anything that draws a picture.
   */
  function growsWithBox(node, rect, pictures) {
    if (/^(img|video)$/.test(node.localName)) return pictures && /^(cover|fill)$/.test(getComputedStyle(node).objectFit);
    if (/^(canvas|svg)$/.test(node.localName) || !isArt(node) || !scalesWithBox(getComputedStyle(node), pictures)) return false;
    for (const inner of node.querySelectorAll('*')) {
      const ics = getComputedStyle(inner);
      if (!scalesWithBox(ics, pictures)) return false;
      if (!/^(img|video|canvas|svg)$/.test(inner.localName)) continue;
      if (!pictures || !/^(img|video)$/.test(inner.localName) || ics.objectFit !== 'cover') return false;
      const r = inner.getBoundingClientRect();
      if (!close(r.left, rect.left, 1.5) || !close(r.right, rect.right, 1.5)) return false;
    }
    return true;
  }

  /** Where an absolutely positioned box sits, for pinning it back there. */
  function placement(node, rect, ncs) {
    // offsetWidth is rounded, which can wrap a label; the rect is exact
    // unless the box is scaled.
    const width = close(rect.width, node.offsetWidth, 1) ? rect.width : node.offsetWidth;
    return { offsetLeft: node.offsetLeft, width, marginLeft: px(ncs.marginLeft) };
  }

  /** Pins a positioned box by its left edge and width. `shift`: how far its padding box's left edge moved. */
  function pinPlace(place, shift) {
    return {
      left: `${round(place.offsetLeft - place.marginLeft + shift)}px`,
      right: 'auto',
      width: `${round(place.width)}px`,
      'box-sizing': 'border-box',
    };
  }

  /**
   * Puts a positioned box that the grown padding box moved back where the
   * page's own box has it (`own`). One that only shifted (a corner toast, a
   * badge at left: 50%) is moved back by its margins, which leaves its insets
   * and width to the page: a drawer sliding in by `right`, or a panel
   * growing, still animates. Anything else is pinned by its left edge and
   * width. True if it is back in place.
   */
  function pinBack(pin, own, place, shift) {
    const now = pin.el.getBoundingClientRect();
    if (close(now.width, own.width) && close(now.height, own.height) && close(now.top, own.top)) {
      const dx = now.left - own.left;
      const cs = getComputedStyle(pin.el);
      setStyles(pin, { 'margin-left': `${round(px(cs.marginLeft) - dx)}px`, 'margin-right': `${round(px(cs.marginRight) + dx)}px` });
      if (sameRect(own, pin.el.getBoundingClientRect())) return true;
      restoreStyles(pin);
    }
    setStyles(pin, pinPlace(place, shift));
    return sameRect(own, pin.el.getBoundingClientRect());
  }

  /** Positioned ::before/::after boxes, read from their computed insets. */
  function pseudoBoxes(el, before, pictures) {
    const out = [];
    for (const which of ['::before', '::after']) {
      const cs = getComputedStyle(el, which);
      if (!cs || cs.content === 'none' || cs.content === 'normal' || cs.display === 'none') continue;
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      const box = { el, which, left: cs.left, right: cs.right, width: cs.width, top: cs.top, height: cs.height };
      const padWidth = before.padRight - before.padLeft;
      // Only an empty one (a tint, a background image) grows with the box;
      // one with text or an icon (a play label, a badge) keeps its place.
      box.cover = cs.content === '""' && scalesWithBox(cs, pictures) && close(px(cs.left), 0, 1.5) && close(px(cs.width), padWidth, 1.5);
      out.push(box);
    }
    return out;
  }

  function pseudosStayed(pseudos) {
    for (const p of pseudos) {
      if (p.cover) continue;
      const cs = getComputedStyle(p.el, p.which);
      if (cs.left !== p.left || cs.width !== p.width || cs.top !== p.top || cs.height !== p.height) return false;
    }
    return true;
  }

  /** The first and last in-flow children: a cheap sample of the content's layout. */
  function contentSample(el) {
    const kids = [...el.children].filter((k) => {
      const p = getComputedStyle(k).position;
      return p !== 'absolute' && p !== 'fixed';
    });
    const pick = [kids[0], kids[kids.length - 1]].filter(Boolean);
    return pick.map((k) => ({ el: k, rect: k.getBoundingClientRect() }));
  }

  function sampleStayed(sample) {
    return sample.every((s) => {
      const r = s.el.getBoundingClientRect();
      return close(r.left, s.rect.left) && close(r.right, s.rect.right) && close(r.top, s.rect.top);
    });
  }

  function sameRect(a, b) {
    return close(a.left, b.left) && close(a.top, b.top) && close(a.width, b.width) && close(a.height, b.height);
  }

  // ---------------------------------------------------------------------------
  // Backgrounds

  /** Splits a comma-separated CSS list at top level (not inside parentheses). */
  function splitList(value) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(value.slice(start).trim());
    return out;
  }

  /**
   * Per background layer, whether it scales with the box (gradients, cover,
   * percentages, tiles), unlike a positioned no-repeat image (an icon, a
   * centred logo), which stays its size and moves when the box grows.
   * Without `pictures` (Auto landscape, which extends colours only) no image
   * scales.
   */
  function layersScale(cs, pictures = true) {
    const sizes = splitList(cs.backgroundSize || 'auto');
    const repeats = splitList(cs.backgroundRepeat || 'repeat');
    return splitList(cs.backgroundImage || 'none').map((image, i) => !/url\(/.test(image) ||
      (pictures && (/cover|%/.test(sizes[i % sizes.length]) || !/no-repeat/.test(repeats[i % repeats.length]))));
  }

  function scalesWithBox(cs, pictures) {
    return layersScale(cs, pictures).every(Boolean);
  }

  /**
   * background-origin per layer for an extended box: layers that scale with
   * the box take the whole border box; a positioned no-repeat image keeps
   * the padding box, so it stays exactly where it was and only the colour
   * extends.
   */
  function backgroundOrigins(cs, pictures) {
    const origins = splitList(cs.backgroundOrigin || 'padding-box');
    return layersScale(cs, pictures).map((scales, i) => (scales ? 'border-box' : origins[i % origins.length])).join(', ');
  }
  D.splitList = splitList;

  // ---------------------------------------------------------------------------
  // Recipes

  function sideProps(cs, sides, C, recipe) {
    const props = {};
    for (const side of ['left', 'right']) {
      if (!sides[side]) continue;
      const margin = px(cs[`margin${cap(side)}`]);
      props[`margin-${side}`] = `${round(margin - C)}px`;
      if (recipe === 'padding') {
        props[`padding-${side}`] = `${round(px(cs[`padding${cap(side)}`]) + C)}px`;
      } else {
        props[`border-${side}-width`] = `${round(px(cs[`border${cap(side)}Width`]) + C)}px`;
        props[`border-${side}-style`] = 'solid';
        props[`border-${side}-color`] = 'transparent';
      }
    }
    return props;
  }

  function compensation(el, before, sides, C) {
    // The element has an explicit width, a border-box max-width, a flex basis
    // or an aspect ratio: pin its border-box size to the extended width.
    const n = (sides.left ? 1 : 0) + (sides.right ? 1 : 0);
    const props = {
      'box-sizing': 'border-box',
      width: `${round(before.width + n * C)}px`,
      'max-width': 'none',
      'min-width': '0px',
    };
    const parent = parentOf(el);
    if (parent && /flex/.test(getComputedStyle(parent).display) && before.cs.flexBasis !== 'auto') {
      props['flex-basis'] = props.width;
    }
    if (before.cs.aspectRatio && before.cs.aspectRatio !== 'auto') {
      props.height = `${round(before.height)}px`;
      props['aspect-ratio'] = 'auto';
    }
    return props;
  }

  function extendedAsExpected(before, after, sides, C) {
    const rightOk = sides.right ? close(after.right, before.right + C, EDGE_EPS) : close(after.right, before.right);
    const leftOk = sides.left ? close(after.left, before.left - C, EDGE_EPS) : close(after.left, before.left);
    return rightOk && leftOk && close(after.top, before.top) && close(after.height, before.height);
  }

  function contentUnchanged(before, after) {
    return close(after.contentLeft, before.contentLeft) && close(after.contentRight, before.contentRight);
  }

  /**
   * Pins absolutely positioned children that moved because their containing
   * block's padding box grew. Cover layers grow with the box (a replaced one
   * switches to object-fit: cover so it isn't stretched); everything else is
   * put back exactly where the site had it.
   */
  function pinMoved(owner, absKids, sides) {
    for (const kid of absKids) {
      if (!kid.el.isConnected || !kid.cover || !/^(img|video)$/.test(kid.el.localName)) continue;
      const C = owner.C;
      const slack = kid.slack;
      const enough = slack && (!sides.right || slack.right >= C - 0.5) && (!sides.left || slack.left >= C - 0.5);
      if (!enough && getComputedStyle(kid.el).objectFit !== 'fill') continue;
      const rec = record(kid.el, 'pin');
      rec.owner = owner;
      owner.pins.push(rec);
      // Enough cropped-away art: pin its position so the visible part stays
      // put and the column shows what the crop hid. Otherwise re-crop it to
      // the wider box rather than stretching it.
      setStyles(rec, enough ? { 'object-position': `${round(slack.offX + (sides.left ? C : 0))}px ${slack.y}` } : { 'object-fit': 'cover' });
    }
    const moved = absKids.filter((k) => !k.cover && k.el.isConnected && !sameRect(k.rect, k.el.getBoundingClientRect()));
    for (const kid of moved) {
      const rec = record(kid.el, 'pin');
      rec.owner = owner;
      owner.pins.push(rec);
      pinBack(rec, kid.rect, kid.place, sides.left ? owner.C : 0);
    }
    return moved.every((k) => sameRect(k.rect, k.el.getBoundingClientRect()));
  }

  function signature(el, cs) {
    const parent = parentOf(el);
    return [el.localName, typeof el.className === 'string' ? el.className : '', cs.display, cs.position, cs.boxSizing,
      parent ? getComputedStyle(parent).display : ''].join('|');
  }

  /**
   * Extends a box-like element (a band or a clipping wrapper).
   *   'border'  – a transparent border on the column side, with the background
   *               painted under it. The padding box doesn't change, so nothing
   *               positioned against it moves. The default for bands.
   *   'padding' – grows the padding box. Needed when the element clips (its
   *               clip has to reach into the column) or holds cover layers
   *               that should grow with it.
   * Either may need width compensation. Every attempt is verified and rolled
   * back if anything but the painted box changed. Without `pictures` (Auto
   * landscape) only colours and gradients extend: no picture in or behind
   * the box is rescaled or moved.
   * @returns {string|null} the recipe that worked, or null (element reverted)
   */
  D.extendBox = function extendBox(el, kind, sides, C, { recipes = ['border', 'padding'], layoutWidth, pictures = true } = {}) {
    const before = boxes(el);
    const abs = absoluteChildren(el, before.cs, before, { pseudos: true, pictures });
    const absKids = abs.kids;
    const own = pseudoBoxes(el, before, pictures);
    // Pseudo-elements cost several times more to read than boxes, and those
    // inside only move with the padding box: read them for that recipe. Its
    // first children's are read now, as that is where a tint or art drawn by
    // one (`.hero .wrap::before`) sits.
    const kids = abs.statics.filter((node) => parentOf(node) === el).slice(0, NEAR_PSEUDO_LIMIT);
    const near = kids.flatMap((node) => pseudoBoxes(node, before, pictures));
    let inner = null;
    const sample = contentSample(el);
    const vw = layoutWidth !== undefined ? layoutWidth : before.right;
    // Cover layers only grow with the padding box. Extending just the border
    // would leave a seam of the bare background beside them.
    const hasCover = absKids.some((k) => k.cover) || own.some((p) => p.cover) || near.some((p) => p.cover);
    let order = hasCover ? recipes.filter((r) => r === 'padding') : recipes.slice();
    // A grown padding box would rescale the box's own background picture.
    if (!pictures && /url\(/.test(before.cs.backgroundImage)) order = order.filter((r) => r !== 'padding');
    const sig = signature(el, before.cs);
    const cached = recipeCache.get(sig);
    if (cached && order.includes(cached.recipe)) {
      order = [cached.recipe, ...order.filter((r) => r !== cached.recipe)];
    }
    // Growing a clipping box's padding box widens its clip, which would show
    // whatever it was hiding past the edge (off-canvas menus, the rest of a
    // tab strip) under the column.
    const revealsHidden = order.includes('padding') && clips(el, before.cs) && hidesOverflow(el, sides, C, vw);

    for (const recipe of order) {
      // Positioned boxes the walk didn't reach could move into the column.
      if (recipe === 'padding' && (revealsHidden || abs.truncated)) continue;
      if (recipe === 'padding' && !inner) inner = abs.statics.filter((node) => !kids.includes(node)).flatMap((node) => pseudoBoxes(node, before, pictures));
      const pseudos = recipe === 'padding' ? [...own, ...near, ...inner] : own;
      const tries = cached && cached.recipe === recipe ? [cached.compensate, !cached.compensate] : [false, true];
      for (const compensate of tries) {
        const result = withoutTransitions([el], () => {
          const rec = record(el, kind);
          rec.C = C;
          const props = sideProps(before.cs, sides, C, recipe);
          if (recipe === 'border') {
            props['background-clip'] = 'border-box';
            props['background-origin'] = backgroundOrigins(before.cs, pictures);
          }
          if (compensate) Object.assign(props, compensation(el, before, sides, C));
          setStyles(rec, props);
          const after = boxes(el);
          const geometryOk = extendedAsExpected(before, after, sides, C) && contentUnchanged(before, after);
          let ok = geometryOk && sampleStayed(sample) && pseudosStayed(pseudos);
          if (ok && recipe === 'padding' && absKids.length) ok = pinMoved(rec, absKids, sides);
          if (ok) {
            rec.recipe = recipe;
            rec.kind = kind;
            rec.sides = { ...sides };
            rec.expect = expectation(el, after);
            rec.clips = recipe === 'padding' && clips(el, before.cs); // its clip now reaches into the column
            // How far its content reaches now, so content that grows past it later is checked.
            if (rec.clips) rec.reach = contentReach(el, el.getBoundingClientRect(), sides);
            rec.seen = new WeakSet(absKids.map((k) => k.el)); // positioned boxes that aren't latecomers
            rec.pictures = pictures;
            return 'ok';
          }
          return geometryOk ? 'stop' : 'retry';
        });
        if (result === 'ok') {
          recipeCache.set(sig, { recipe, compensate });
          return recipe;
        }
        revert(el);
        // Width compensation only helps when the geometry was off; a moved
        // pseudo-element or positioned child won't be fixed by it.
        if (result === 'stop') break;
      }
    }
    return null;
  };

  /** Intrinsic size of an image or video, or null if unknown. */
  function naturalSize(el) {
    const w = el.naturalWidth || el.videoWidth || 0;
    const h = el.naturalHeight || el.videoHeight || 0;
    return w && h ? { w, h } : null;
  }

  /**
   * The intrinsic size a picture had when Duofari measured it. Pinned
   * heights and offsets are worked out from it, so a new `src` (a lazy
   * loader's real image, the next slide) has to be measured again.
   */
  function sourceKey(el) {
    const nat = /^(img|video)$/.test(el.localName) && naturalSize(el);
    return nat ? `${nat.w}x${nat.h}` : '';
  }

  /** Resolves one axis of a computed object-position ("50%", "12px") to px. */
  function positionOffset(value, free) {
    if (/%$/.test(value)) return (free * parseFloat(value)) / 100;
    return parseFloat(value) || 0;
  }

  /**
   * How many pixels of a cover-fitted picture are cropped away beside its box,
   * on each side. A picture that is cropped by at least the column width can
   * continue under the column pixel for pixel, with nothing rescaled.
   */
  D.coverSlack = function coverSlack(el, before = boxes(el)) {
    if (before.cs.objectFit !== 'cover') return null;
    // SVGs without an intrinsic size report a default natural size that
    // doesn't match how they're fitted.
    if (/^data:image\/svg|\.svg(?:$|[?#])/i.test(String(el.currentSrc || el.src || ''))) return null;
    const nat = naturalSize(el);
    if (!nat) return null;
    const W = before.contentRight - before.contentLeft;
    const H = before.height - px(before.cs.borderTopWidth) - px(before.cs.borderBottomWidth) -
      px(before.cs.paddingTop) - px(before.cs.paddingBottom);
    if (W <= 0 || H <= 0) return null;
    const s = Math.max(W / nat.w, H / nat.h);
    const rw = nat.w * s;
    const [xs, ys] = (before.cs.objectPosition || '50% 50%').split(/\s+/);
    const offX = positionOffset(xs, W - rw);
    return { left: -offX, right: rw + offX - W, offX, y: ys || '50%' };
  };

  /**
   * Widens a full-width picture into the column, keeping its height.
   *   'reveal' – a cover-fitted picture with enough cropped-away width: pin its
   *              position so the visible part doesn't move and the column
   *              shows the pixels the crop was hiding.
   *   'fill'   – any other picture: widen and re-crop with object-fit: cover
   *              (scales it by (W + C) / W and trims the top and bottom).
   */
  D.extendMedia = function extendMedia(el, sides, C, { mode = 'fill' } = {}) {
    const before = boxes(el);
    const n = (sides.left ? 1 : 0) + (sides.right ? 1 : 0);
    let position = null;
    if (mode === 'reveal') {
      const slack = D.coverSlack(el, before);
      if (!slack || (sides.right && slack.right < C - 0.5) || (sides.left && slack.left < C - 0.5)) return null;
      position = `${round(slack.offX + (sides.left ? C : 0))}px ${slack.y}`;
    }
    const ok = withoutTransitions([el], () => {
      const rec = record(el, 'media');
      const props = {
        'box-sizing': 'border-box',
        width: `${round(before.width + n * C)}px`,
        height: `${round(before.height)}px`,
        'max-width': 'none',
        'min-width': '0px',
        'max-height': 'none',
        'flex-shrink': '0',
        'aspect-ratio': 'auto',
      };
      if (sides.right) props['margin-right'] = `${round(px(before.cs.marginRight) - C)}px`;
      if (sides.left) props['margin-left'] = `${round(px(before.cs.marginLeft) - C)}px`;
      if (position) props['object-position'] = position;
      else if (before.cs.objectFit === 'fill' || before.cs.objectFit === 'cover') props['object-fit'] = 'cover';
      setStyles(rec, props);
      const after = boxes(el);
      if (!extendedAsExpected(before, after, sides, C)) return false;
      rec.recipe = position ? 'reveal' : 'fill';
      rec.sides = { ...sides };
      rec.C = C;
      rec.expect = expectation(el, after);
      return true;
    });
    if (!ok) {
      revert(el);
      return null;
    }
    return position ? 'reveal' : 'fill';
  };

  /**
   * Breaks an image inset by page margins out to the full screen width,
   * keeping its aspect ratio. Returns the height change, or null if it
   * couldn't be done cleanly.
   */
  D.breakOut = function breakOut(el, sides, C, layoutWidth) {
    const before = boxes(el);
    const parent = parentOf(el);
    const parentBefore = parent ? parent.getBoundingClientRect() : null;
    const targetLeft = sides.left ? -C : 0;
    const targetRight = layoutWidth + (sides.right ? C : 0);
    const width = targetRight - targetLeft;
    const height = before.height * (width / before.width);
    const grew = withoutTransitions([el], () => {
      const rec = record(el, 'breakout');
      const props = {
        'box-sizing': 'border-box',
        width: `${round(width)}px`,
        height: `${round(height)}px`,
        'max-width': 'none',
        'min-width': '0px',
        'max-height': 'none',
        'flex-shrink': '0',
        'aspect-ratio': 'auto',
        'margin-left': `${round(px(before.cs.marginLeft) - (before.left - targetLeft))}px`,
        'margin-right': `${round(px(before.cs.marginRight) - (targetRight - before.right))}px`,
      };
      if (before.cs.objectFit === 'fill' || before.cs.objectFit === 'cover') props['object-fit'] = 'cover';
      setStyles(rec, props);
      const after = boxes(el);
      const delta = after.height - before.height;
      let ok = close(after.left, targetLeft, EDGE_EPS) && close(after.right, targetRight, EDGE_EPS) &&
        close(after.top, before.top) && close(after.height, height, EDGE_EPS);
      if (ok && parent && parentBefore) {
        // The parent must make room for the taller image, or it would overlap
        // whatever follows it.
        const parentAfter = parent.getBoundingClientRect();
        ok = close(parentAfter.height - parentBefore.height, delta, EDGE_EPS) || parentAfter.bottom >= after.bottom - EPS;
      }
      if (!ok) return null;
      rec.recipe = 'grow';
      rec.sides = { ...sides };
      rec.C = C;
      rec.expect = expectation(el, after);
      return delta;
    });
    if (grew === null) revert(el);
    return grew;
  };

  function expectation(el, b) {
    const parent = parentOf(el);
    const pb = parent ? boxes(parent) : null;
    return {
      left: b.left, right: b.right, width: b.width, height: b.height,
      parentContentLeft: pb ? pb.contentLeft : 0, parentContentRight: pb ? pb.contentRight : 0,
    };
  }

  /**
   * Re-checks an applied element: its edges still sit where the extension
   * put them, its parent's content box hasn't moved, its pictures are the
   * ones it was measured with, and nothing added to or grown in a clipper
   * since shows in the strip it opened. Height changes are fine for boxes
   * (headers that shrink on scroll); media heights are ours.
   */
  D.stillValid = function stillValid(rec) {
    const el = rec.el;
    if (rec.dirty || !el.isConnected || !D.stylesIntact(rec) || sourceKey(el) !== rec.source) return false;
    const b = el.getBoundingClientRect();
    if (!close(b.right, rec.expect.right, EDGE_EPS) || !close(b.left, rec.expect.left, EDGE_EPS)) return false;
    const parent = parentOf(el);
    if (parent) {
      const pb = boxes(parent);
      if (!close(pb.contentLeft, rec.expect.parentContentLeft, EDGE_EPS) ||
          !close(pb.contentRight, rec.expect.parentContentRight, EDGE_EPS)) {
        // An extended parent's content box is unchanged by design, so any
        // difference means the page's layout moved underneath us.
        return false;
      }
    }
    for (const pin of rec.pins) {
      if (!pin.el.isConnected || !D.stylesIntact(pin) || sourceKey(pin.el) !== pin.source) return false;
    }
    if (rec.clips) {
      // Content that has grown past it since (a menu added inside a wrapper,
      // text that stopped wrapping or got longer) may be what the clip hid.
      const reach = contentReach(el, b, rec.sides);
      if (rec.sides.right ? reach > rec.reach + 1 : reach < rec.reach - 1) return false;
    }
    if (rec.added) {
      const added = rec.added;
      rec.added = null;
      for (const node of added) if (showsInStrip(node, rec)) return false;
    }
    return true;
  };

  /**
   * Queues a node added inside a clipper that Duofari opened with the
   * padding recipe, for stillValid to check. True if it was queued.
   */
  D.noteAdded = function noteAdded(node) {
    if (!records.size) return false;
    for (let a = parentOf(node); a; a = parentOf(a)) {
      const rec = records.get(a);
      if (rec && rec.clips) {
        (rec.added = rec.added || new Set()).add(node);
        return true;
      }
    }
    return false;
  };

  /** Runs `fn` with an extension taken off for a moment, to measure the page's own layout. */
  function withoutExtension(rec, fn) {
    const style = rec.el.style;
    return withoutTransitions([rec.el], () => {
      for (const [prop, orig] of rec.saved) {
        if (orig.value) style.setProperty(prop, orig.value, orig.priority);
        else style.removeProperty(prop);
      }
      try {
        return fn();
      } finally {
        for (const [prop, value] of rec.applied) style.setProperty(prop, value, 'important');
      }
    });
  }

  /**
   * Positioned children that appeared after a box was extended with the
   * padding recipe (a menu, a toast or a search panel opened later) are laid
   * out against the grown padding box. When there are new ones, or one now
   * reaches into the column, pin each that moved back where the page's own
   * box puts it, as pinMoved does. Returns false if the box has to be
   * measured again instead.
   */
  D.repinLatecomers = function repinLatecomers(rec, vw) {
    if (rec.recipe !== 'padding' || !rec.el.isConnected) return true;
    const cs = getComputedStyle(rec.el);
    if (!containsAbsolute(cs)) return true;
    const pinned = new Set(rec.pins.map((p) => p.el));
    const kids = absoluteChildren(rec.el, cs, boxes(rec.el), { limit: LATE_SCAN_LIMIT, pictures: rec.pictures }).kids.filter((k) =>
      !k.cover && !pinned.has(k.el) && !records.has(k.el) && k.rect.width > 0 && k.rect.height > 0);
    if (!kids.some((k) => !rec.seen.has(k.el) || inStrip(k.rect.left, k.rect.right, rec.sides, rec.C, vw))) return true;
    const where = withoutExtension(rec, () => kids.map((k) => {
      const rect = k.el.getBoundingClientRect();
      return { rect, place: placement(k.el, rect, getComputedStyle(k.el)) };
    }));
    // One the page's own clip would hide (a drawer added later) would show
    // under the column.
    const revealed = (w, i) => inStrip(w.rect.left, w.rect.right, rec.sides, rec.C, vw) && shows(kids[i].el, rec.el);
    if (rec.clips && where.some(revealed)) return false;
    kids.forEach((k, i) => {
      if (!sameRect(where[i].rect, k.rect)) {
        const pin = record(k.el, 'pin');
        pin.owner = rec;
        rec.pins.push(pin);
        // Most enter with a transition (a toast sliding up). It keeps
        // running, so the box is compared at the same point of it.
        const placed = withoutTransitions([k.el], () => pinBack(pin, where[i].rect, where[i].place, rec.sides.left ? rec.C : 0), { keepRunning: true });
        if (!placed) {
          rec.pins.pop();
          revert(k.el);
          return; // tried again on a later scan
        }
      }
      rec.seen.add(k.el);
    });
    return true;
  };

  /** Whether `el` contains a position: fixed box (a slide-out menu, a modal). */
  D.hasFixedDescendant = function hasFixedDescendant(el) {
    const all = el.getElementsByTagName('*');
    if (all.length > 300) return true; // too big to check cheaply: assume so
    for (const node of all) {
      if (getComputedStyle(node).position === 'fixed') return true;
    }
    return false;
  };

  /** Adds an identity translate to a fixed band so WebKit paints its whole layer. */
  D.lift = function lift(rec) {
    withoutTransitions([rec.el], () => setStyles(rec, { translate: '0px 0px' }));
    rec.lifted = true;
  };

  /** Takes the identity translate off again, leaving the rest of the extension. */
  D.unlift = function unlift(rec) {
    if (!rec.lifted) return;
    const orig = rec.saved.get('translate');
    // Unless the page has set its own translate since.
    if (ours(rec.el.style, 'translate', rec.applied.get('translate'))) {
      if (orig && orig.value) rec.el.style.setProperty('translate', orig.value, orig.priority);
      else rec.el.style.removeProperty('translate');
    }
    rec.saved.delete('translate');
    rec.applied.delete('translate');
    rec.lifted = false;
    rec.el.setAttribute(MARK, JSON.stringify([...rec.saved].map(([p, o]) => [p, o.value, o.priority])));
  };

  /** Drops lifts whose band has gained a fixed descendant. Cheap; safe to call often. */
  D.checkLifts = function checkLifts() {
    for (const rec of records.values()) {
      if (rec.lifted && D.hasFixedDescendant(rec.el)) D.unlift(rec);
    }
  };

  /** Whether a change to `prop` would be animated: its transition entry (or `all`'s) has a duration. */
  function animates(cs, prop) {
    const names = splitList(cs.transitionProperty || 'all');
    const durations = splitList(cs.transitionDuration || '0s');
    let duration = 0;
    names.forEach((name, i) => {
      if (name === 'all' || name === prop) duration = parseFloat(durations[i % durations.length]) || 0;
    });
    return duration > 0;
  }

  /**
   * Whether the page now gives a lifted band a translate of its own, read
   * with the identity translate off for a moment. Zero durations keep that
   * from starting anything, and the page's running transitions (a colour
   * change on scroll) carry on with the band still lifted.
   */
  function bringsTranslate(rec) {
    const el = rec.el;
    const style = el.style;
    const value = rec.applied.get('translate');
    if (!ours(style, 'translate', value)) return false; // the page has set its own since: it shows already
    // Looking writes styles, which come back here as a restyle: a state
    // looked at already is skipped.
    const state = () => `${el.getAttribute('class')}|${el.getAttribute('style')}`;
    if (rec.looked === state()) return false;
    const orig = rec.saved.get('translate');
    const brings = withoutTransitions([el], () => {
      if (orig && orig.value) style.setProperty('translate', orig.value, orig.priority);
      else style.removeProperty('translate');
      const own = getComputedStyle(el).translate;
      style.setProperty('translate', value, 'important');
      return own !== 'none';
    }, { keepRunning: true });
    rec.looked = state();
    return brings;
  }

  /** Marks an applied element for re-measuring from the page's own styles on the next scan. */
  D.markDirty = function markDirty(el) {
    const rec = records.get(el);
    // <body> changes class all the time (scroll states, an open menu), and
    // reverting it reverts everything inside. stillValid's checks of its box
    // and styles are left to catch what matters.
    if (!rec || el === document.body) return;
    const owner = rec.owner || rec;
    owner.dirty = true;
    // The identity translate would hide a `translate` the restyle brings in
    // and stop its transition from running. Take it off now; it goes back
    // on when the band is extended again.
    if (owner.lifted && animates(getComputedStyle(owner.el), 'translate') && bringsTranslate(owner)) D.unlift(owner);
  };
})();
