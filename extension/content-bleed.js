// Extends an element's painted box into Safari's column without moving its
// content, verifying every change and rolling back anything that misbehaves.
//
// All changes are inline `!important` declarations. They reach into shadow
// roots and beat ordinary site CSS, and each original value is saved so a
// change can be reverted exactly.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});

  const EPS = 0.75;          // px tolerance when comparing layout boxes
  const EDGE_EPS = 1.25;     // px tolerance when checking an extended edge
  const ABS_SCAN_LIMIT = 2000;
  const ABS_KEEP_LIMIT = 400;

  /** @type {Map<Element, Record>} every element Duofari has modified */
  const records = new Map();
  D.records = records;

  // ---------------------------------------------------------------------------
  // Inline style bookkeeping

  function record(el, kind) {
    let rec = records.get(el);
    if (!rec) {
      rec = {
        el, kind, recipe: '', saved: new Map(), applied: new Map(),
        hadStyle: el.hasAttribute('style'), styleAttr: el.getAttribute('style'),
        pins: [], owner: null, expect: null,
        reapplies: [],
      };
      records.set(el, rec);
    }
    return rec;
  }

  function setStyles(rec, props) {
    const style = rec.el.style;
    for (const [prop, value] of Object.entries(props)) {
      if (!rec.saved.has(prop)) {
        rec.saved.set(prop, { value: style.getPropertyValue(prop), priority: style.getPropertyPriority(prop) });
      }
      style.setProperty(prop, value, 'important');
      rec.applied.set(prop, value);
    }
  }

  function restoreStyles(rec) {
    const style = rec.el.style;
    for (const [prop, orig] of rec.saved) {
      if (orig.value) style.setProperty(prop, orig.value, orig.priority);
      else style.removeProperty(prop);
    }
    rec.saved.clear();
    rec.applied.clear();
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
    for (const pin of rec.pins) revert(pin.el);
    rec.pins = [];
    restoreStyles(rec);
    records.delete(el);
  }
  D.revert = revert;

  D.revertAll = function revertAll() {
    for (const el of [...records.keys()]) revert(el);
  };

  /** True when the site has since overwritten one of our declarations. */
  D.stylesIntact = function stylesIntact(rec) {
    const style = rec.el.style;
    for (const [prop, value] of rec.applied) {
      if (style.getPropertyPriority(prop) !== 'important') return false;
      if (normalise(style.getPropertyValue(prop)) !== normalise(value)) return false;
    }
    return true;
  };

  function normalise(value) {
    return String(value).replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers

  const px = (value) => parseFloat(value) || 0;

  function boxes(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth);
    const pl = px(cs.paddingLeft), pr = px(cs.paddingRight);
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      contentLeft: r.left + bl + pl, contentRight: r.right - br - pr, cs,
    };
  }
  D.boxes = boxes;

  const close = (a, b, eps = EPS) => Math.abs(a - b) <= eps;

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

  const HIDDEN_SCAN_LIMIT = 12000;

  /**
   * Whether a clipping element currently hides content in the strip the
   * column would open up. Content Duofari extended itself doesn't count.
   */
  function hidesOverflow(el, sides, C, vw) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    let seen = 0;
    let node = walker.nextNode();
    while (node) {
      if (++seen > HIDDEN_SCAN_LIMIT) return true; // too big to be sure: assume it does
      if (records.has(node) || (node.hasAttribute && node.hasAttribute('data-duofari-ui'))) {
        node = skipSubtree(walker, node);
        continue;
      }
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const inRight = sides.right && r.right > vw + 0.5 && r.left < vw + C;
        const inLeft = sides.left && r.left < -0.5 && r.right > -C;
        if ((inRight || inLeft) && shows(node, el)) return true;
        // A descendant that clips within the viewport keeps its own overflow hidden.
        if (r.left >= -0.5 && r.right <= vw + 0.5 && clips(node, getComputedStyle(node))) {
          node = skipSubtree(walker, node);
          continue;
        }
      }
      node = walker.nextNode();
    }
    return false;
  }

  /** Whether `node` paints at all: not hidden, and no ancestor up to `root` fully transparent. */
  function shows(node, root) {
    const own = getComputedStyle(node);
    if (own.visibility === 'hidden' || own.visibility === 'collapse') return false;
    for (let n = node; n && n !== root; n = parentOf(n)) {
      if (parseFloat(getComputedStyle(n).opacity) === 0) return false;
    }
    return true;
  }

  function skipSubtree(walker, node) {
    walker.currentNode = node;
    let next = walker.nextSibling();
    let up = node;
    while (!next && (up = walker.parentNode())) {
      if (up === walker.root) return null;
      next = walker.nextSibling();
    }
    return next;
  }

  /** True if `el` has no visible text and nothing interactive: pure artwork. */
  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,video[controls],[role=button],[role=link],[tabindex],iframe';

  function isArt(el) {
    if (el.matches(INTERACTIVE)) return false;
    if (/^(img|video|picture|canvas|svg)$/i.test(el.localName)) return true;
    if ((el.textContent || '').trim()) return false;
    return !el.querySelector(INTERACTIVE);
  }
  D.isArt = isArt;

  /**
   * Absolutely positioned boxes whose containing block is `el`. Their position
   * depends on el's padding box, which the padding recipe enlarges.
   */
  function absoluteChildren(el, cs) {
    if (!containsAbsolute(cs)) return [];
    const fixedToo = containsFixed(cs);
    const out = [];
    const stack = [...el.children].reverse();
    if (el.shadowRoot) stack.push(...el.shadowRoot.children);
    let seen = 0;
    while (stack.length && seen < ABS_SCAN_LIMIT && out.length < ABS_KEEP_LIMIT) {
      const node = stack.pop();
      seen++;
      const ncs = getComputedStyle(node);
      if (ncs.display === 'none') continue;
      const positioned = ncs.position === 'absolute' || (fixedToo && ncs.position === 'fixed');
      if (positioned) {
        out.push({
          el: node, rect: node.getBoundingClientRect(), offsetLeft: node.offsetLeft, offsetTop: node.offsetTop,
          offsetWidth: node.offsetWidth, marginLeft: px(ncs.marginLeft), art: isArt(node),
        });
      }
      // Descendants of a nested containing block are positioned against it.
      if (positioned || containsAbsolute(ncs)) continue;
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return out;
  }

  function sameRect(a, b) {
    return close(a.left, b.left) && close(a.top, b.top) && close(a.width, b.width) && close(a.height, b.height);
  }

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

  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const round = (n) => Math.round(n * 100) / 100;

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
   * block's padding box grew. Text and controls are put back exactly where
   * they were; pure artwork is allowed to grow with the box.
   */
  function pinMoved(owner, absKids, sides, C, ownerWidth) {
    const moved = absKids.filter((k) => k.el.isConnected && !sameRect(k.rect, k.el.getBoundingClientRect()));
    // Backdrop artwork that spans its box (a hero image at inset: 0) should
    // grow with it. Everything else keeps the place the site gave it, so
    // smaller decorations don't slide under controls that stayed put.
    const toPin = moved.filter((k) => !(k.art && k.rect.width >= 0.9 * ownerWidth));
    for (const kid of toPin) {
      const rec = record(kid.el, 'pin');
      rec.owner = owner;
      owner.pins.push(rec);
      const shift = sides.left ? C : 0;
      setStyles(rec, {
        left: `${round(kid.offsetLeft - kid.marginLeft + shift)}px`,
        right: 'auto',
        width: `${round(kid.offsetWidth)}px`,
        'box-sizing': 'border-box',
      });
    }
    return toPin.every((k) => sameRect(k.rect, k.el.getBoundingClientRect()));
  }

  /**
   * Extends a box-like element (a band or a clipping wrapper).
   * @returns {string|null} the recipe that worked, or null (element reverted)
   */
  D.extendBox = function extendBox(el, kind, sides, C, { recipes = ['padding', 'border'], backdrop = true, layoutWidth } = {}) {
    const before = boxes(el);
    const absKids = absoluteChildren(el, before.cs);
    // Growing a clipping box's padding box widens its clip, which would show
    // whatever it was hiding past the edge (off-canvas menus, the rest of a
    // tab strip) under the column.
    const vw = layoutWidth !== undefined ? layoutWidth : before.right;
    const revealsHidden = clips(el, before.cs) && hidesOverflow(el, sides, C, vw);
    for (const recipe of recipes) {
      if (recipe === 'padding' && revealsHidden) continue;
      for (const compensate of [false, true]) {
        const rec = record(el, kind);
        const props = sideProps(before.cs, sides, C, recipe);
        if (recipe === 'border') {
          props['background-clip'] = 'border-box';
          if (backdrop) props['background-origin'] = 'border-box';
        }
        if (compensate) {
          // The element has an explicit width, a border-box max-width or
          // similar. Pin its border-box width to the extended size.
          const n = (sides.left ? 1 : 0) + (sides.right ? 1 : 0);
          Object.assign(props, {
            'box-sizing': 'border-box',
            width: `${round(before.width + n * C)}px`,
            'max-width': 'none',
            'min-width': '0px',
          });
        }
        setStyles(rec, props);
        const after = boxes(el);
        let ok = extendedAsExpected(before, after, sides, C) && contentUnchanged(before, after);
        if (ok && recipe === 'padding' && absKids.length) ok = pinMoved(rec, absKids, sides, C, before.width);
        if (ok) {
          rec.recipe = recipe;
          rec.kind = kind;
          rec.sides = { ...sides };
          rec.C = C;
          rec.expect = expectation(el, after);
          return recipe;
        }
        revert(el);
        // Only retry with width compensation when the content box moved
        // or the box didn't grow; any other failure won't be fixed by it.
        if (!compensate && extendedAsExpected(before, after, sides, C) && contentUnchanged(before, after)) break;
      }
    }
    return null;
  };

  /** Widens a full-width image or background video, keeping its height. */
  D.extendMedia = function extendMedia(el, sides, C, { style = 'fill' } = {}) {
    const before = boxes(el);
    const rec = record(el, 'media');
    if (style === 'mirror' && !(sides.left && sides.right)) {
      setStyles(rec, { '-webkit-box-reflect': `${sides.right ? 'right' : 'left'} 0px` });
      rec.recipe = 'mirror';
      rec.sides = { ...sides };
      rec.C = C;
      rec.expect = expectation(el, before);
      return 'mirror';
    }
    const n = (sides.left ? 1 : 0) + (sides.right ? 1 : 0);
    const props = {
      'box-sizing': 'border-box',
      width: `${round(before.width + n * C)}px`,
      height: `${round(before.height)}px`,
      'max-width': 'none',
      'min-width': '0px',
      'max-height': 'none',
      'flex-shrink': '0',
    };
    if (sides.right) props['margin-right'] = `${round(px(before.cs.marginRight) - C)}px`;
    if (sides.left) props['margin-left'] = `${round(px(before.cs.marginLeft) - C)}px`;
    if (before.cs.objectFit === 'fill' || before.cs.objectFit === 'cover') props['object-fit'] = 'cover';
    setStyles(rec, props);
    const after = boxes(el);
    if (!extendedAsExpected(before, after, sides, C)) {
      revert(el);
      return null;
    }
    rec.recipe = 'fill';
    rec.sides = { ...sides };
    rec.C = C;
    rec.expect = expectation(el, after);
    return 'fill';
  };

  /**
   * Breaks an image inset by page margins out to the full screen width,
   * keeping its aspect ratio. Returns the height change (for scroll
   * compensation), or null if it couldn't be done cleanly.
   */
  D.breakOut = function breakOut(el, sides, C, layoutWidth) {
    const before = boxes(el);
    const parent = parentOf(el);
    const parentBefore = parent ? parent.getBoundingClientRect() : null;
    const targetLeft = sides.left ? -C : 0;
    const targetRight = layoutWidth + (sides.right ? C : 0);
    const width = targetRight - targetLeft;
    const height = before.height * (width / before.width);
    const rec = record(el, 'breakout');
    const props = {
      'box-sizing': 'border-box',
      width: `${round(width)}px`,
      height: `${round(height)}px`,
      'max-width': 'none',
      'min-width': '0px',
      'max-height': 'none',
      'flex-shrink': '0',
      'margin-left': `${round(px(before.cs.marginLeft) - (before.left - targetLeft))}px`,
      'margin-right': `${round(px(before.cs.marginRight) - (targetRight - before.right))}px`,
    };
    if (before.cs.objectFit === 'fill' || before.cs.objectFit === 'cover') props['object-fit'] = 'cover';
    setStyles(rec, props);
    const after = boxes(el);
    const grew = after.height - before.height;
    let ok = close(after.left, targetLeft, EDGE_EPS) && close(after.right, targetRight, EDGE_EPS) &&
      close(after.top, before.top) && close(after.height, height, EDGE_EPS);
    if (ok && parent && parentBefore) {
      // The parent must make room for the taller image, or it would overlap
      // whatever follows it.
      const parentAfter = parent.getBoundingClientRect();
      ok = close(parentAfter.height - parentBefore.height, grew, EDGE_EPS) || parentAfter.bottom >= after.bottom - EPS;
    }
    if (!ok) {
      revert(el);
      return null;
    }
    rec.recipe = 'grow';
    rec.sides = { ...sides };
    rec.C = C;
    rec.expect = expectation(el, after);
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
   * put them and its parent's content box hasn't moved. Height changes are
   * fine for boxes (headers that shrink on scroll); media heights are ours.
   */
  D.stillValid = function stillValid(rec) {
    const el = rec.el;
    if (!el.isConnected || !D.stylesIntact(rec)) return false;
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
      if (!pin.el.isConnected || !D.stylesIntact(pin)) return false;
    }
    return true;
  };
})();
