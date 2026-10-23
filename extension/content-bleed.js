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
  const ABS_SCAN_LIMIT = 2000;
  const ABS_KEEP_LIMIT = 400;
  const HIDDEN_SCAN_LIMIT = 12000;
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
    rec.el.setAttribute(MARK, JSON.stringify([...rec.saved].map(([p, o]) => [p, o.value, o.priority])));
  }

  function restoreStyles(rec) {
    const style = rec.el.style;
    for (const [prop, orig] of rec.saved) {
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
    for (const [prop, value] of rec.applied) {
      if (style.getPropertyPriority(prop) !== 'important') return false;
      if (normalise(style.getPropertyValue(prop)) !== normalise(value)) return false;
    }
    return true;
  };

  function normalise(value) {
    return String(value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Runs `fn` with CSS transitions switched off on `els`. Transitions would
   * animate our changes (and make the boxes we measure report their start
   * values), and also animate reverts. Once the new style has been computed,
   * restoring the transition property starts nothing.
   */
  function withoutTransitions(els, fn) {
    const saved = [];
    for (const el of els) {
      if (!el || !el.style || entryAttrs.has(el)) continue;
      saved.push([el, el.style.getPropertyValue('transition'), el.style.getPropertyPriority('transition'), el.getAttribute('style')]);
      entryAttrs.set(el, el.getAttribute('style'));
      el.style.setProperty('transition', 'none', 'important');
    }
    try {
      return fn();
    } finally {
      for (const [el, value, priority, attr] of saved) {
        entryAttrs.delete(el);
        getComputedStyle(el).transitionProperty; // flush the style with transitions off
        if (value) el.style.setProperty('transition', value, priority);
        else el.style.removeProperty('transition');
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
      if (records.has(node) || node.hasAttribute('data-duofari-ui')) {
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

  /**
   * Absolutely positioned boxes whose containing block is `el`. Their position
   * depends on el's padding box, which the padding recipe enlarges. "Cover"
   * layers fill that padding box (a hero image at inset: 0, a dimming
   * overlay) and are meant to grow with it.
   */
  function absoluteChildren(el, cs, before) {
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
        const rect = node.getBoundingClientRect();
        const art = isArt(node);
        const cover = art && close(rect.left, before.padLeft, 1.5) && close(rect.right, before.padRight, 1.5);
        out.push({
          el: node, rect, art, cover, offsetLeft: node.offsetLeft, offsetWidth: node.offsetWidth, marginLeft: px(ncs.marginLeft),
          // How much of a cover-fitted picture is cropped away, measured before
          // the box grows, so it can be revealed rather than rescaled.
          slack: cover && /^(img|video)$/.test(node.localName) ? D.coverSlack(node) : null,
        });
      }
      // Descendants of a nested containing block are positioned against it.
      if (positioned || containsAbsolute(ncs)) continue;
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return out;
  }

  /** Positioned ::before/::after boxes, read from their computed insets. */
  function pseudoBoxes(el, before) {
    const out = [];
    for (const which of ['::before', '::after']) {
      const cs = getComputedStyle(el, which);
      if (!cs || cs.content === 'none' || cs.content === 'normal' || cs.display === 'none') continue;
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      const box = { which, left: cs.left, right: cs.right, width: cs.width, top: cs.top, height: cs.height };
      const padWidth = before.padRight - before.padLeft;
      box.cover = close(px(cs.left), 0, 1.5) && close(px(cs.width), padWidth, 1.5);
      out.push(box);
    }
    return out;
  }

  function pseudosStayed(el, pseudos) {
    for (const p of pseudos) {
      if (p.cover) continue;
      const cs = getComputedStyle(el, p.which);
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
   * background-origin per layer for an extended box: layers that scale with
   * the box (gradients, cover, percentages, tiles) take the whole border box;
   * a positioned no-repeat image (an icon, a centred logo) keeps the padding
   * box, so it stays exactly where it was and only the colour extends.
   */
  function backgroundOrigins(cs) {
    const images = splitList(cs.backgroundImage || 'none');
    const sizes = splitList(cs.backgroundSize || 'auto');
    const repeats = splitList(cs.backgroundRepeat || 'repeat');
    const origins = splitList(cs.backgroundOrigin || 'padding-box');
    return images.map((image, i) => {
      const size = sizes[i % sizes.length];
      const repeat = repeats[i % repeats.length];
      const scales = !/url\(/.test(image) || /cover|%/.test(size) || !/no-repeat/.test(repeat);
      return scales ? 'border-box' : origins[i % origins.length];
    }).join(', ');
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
      const shift = sides.left ? owner.C : 0;
      setStyles(rec, {
        left: `${round(kid.offsetLeft - kid.marginLeft + shift)}px`,
        right: 'auto',
        width: `${round(kid.offsetWidth)}px`,
        'box-sizing': 'border-box',
      });
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
   * back if anything but the painted box changed.
   * @returns {string|null} the recipe that worked, or null (element reverted)
   */
  D.extendBox = function extendBox(el, kind, sides, C, { recipes = ['border', 'padding'], layoutWidth } = {}) {
    const before = boxes(el);
    const absKids = absoluteChildren(el, before.cs, before);
    const pseudos = pseudoBoxes(el, before);
    const sample = contentSample(el);
    const vw = layoutWidth !== undefined ? layoutWidth : before.right;
    // Cover layers only grow with the padding box. Extending just the border
    // would leave a seam of the bare background beside them.
    const hasCover = absKids.some((k) => k.cover) || pseudos.some((p) => p.cover);
    let order = hasCover ? recipes.filter((r) => r === 'padding') : recipes.slice();
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
      if (recipe === 'padding' && revealsHidden) continue;
      const tries = cached && cached.recipe === recipe ? [cached.compensate, !cached.compensate] : [false, true];
      for (const compensate of tries) {
        const result = withoutTransitions([el], () => {
          const rec = record(el, kind);
          rec.C = C;
          const props = sideProps(before.cs, sides, C, recipe);
          if (recipe === 'border') {
            props['background-clip'] = 'border-box';
            props['background-origin'] = backgroundOrigins(before.cs);
          }
          if (compensate) Object.assign(props, compensation(el, before, sides, C));
          setStyles(rec, props);
          const after = boxes(el);
          const geometryOk = extendedAsExpected(before, after, sides, C) && contentUnchanged(before, after);
          let ok = geometryOk && sampleStayed(sample) && pseudosStayed(el, pseudos);
          if (ok && recipe === 'padding' && absKids.length) ok = pinMoved(rec, absKids, sides);
          if (ok) {
            rec.recipe = recipe;
            rec.kind = kind;
            rec.sides = { ...sides };
            rec.expect = expectation(el, after);
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
   * put them and its parent's content box hasn't moved. Height changes are
   * fine for boxes (headers that shrink on scroll); media heights are ours.
   */
  D.stillValid = function stillValid(rec) {
    const el = rec.el;
    if (rec.dirty || !el.isConnected || !D.stylesIntact(rec)) return false;
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

  /**
   * Positioned children that appeared after a box was extended with the
   * padding recipe (a menu or search panel opened later) are laid out against
   * the grown padding box. Put any that now reach into the column back where
   * the original box would have placed them. Returns false if one can't be.
   */
  D.repinLatecomers = function repinLatecomers(rec, vw) {
    if (rec.recipe !== 'padding' || !rec.el.isConnected) return true;
    const cs = getComputedStyle(rec.el);
    if (!containsAbsolute(cs)) return true;
    const now = boxes(rec.el);
    const pinned = new Set(rec.pins.map((p) => p.el));
    const C = rec.C;
    for (const kid of absoluteChildren(rec.el, cs, now)) {
      if (kid.cover || pinned.has(kid.el) || records.has(kid.el)) continue;
      const r = kid.rect;
      const intrudes = (rec.sides.right && r.right > vw + 0.5 && r.left < vw + C) ||
        (rec.sides.left && r.left < -0.5 && r.right > -C);
      if (!intrudes || !(r.width > 0 && r.height > 0)) continue;
      const kcs = getComputedStyle(kid.el);
      const pin = record(kid.el, 'pin');
      pin.owner = rec;
      rec.pins.push(pin);
      const props = {};
      if (rec.sides.right) props.right = `${round(px(kcs.right) + C)}px`;
      if (rec.sides.left) props.left = `${round(px(kcs.left) + C)}px`;
      withoutTransitions([kid.el], () => setStyles(pin, props));
      const after = kid.el.getBoundingClientRect();
      const fixed = rec.sides.right ? after.right <= vw + 0.5 : after.left >= -0.5;
      if (!fixed) {
        // Positioned by its other edge: it reached past the box on its own.
        rec.pins.pop();
        revert(kid.el);
      }
    }
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
    if (orig && orig.value) rec.el.style.setProperty('translate', orig.value, orig.priority);
    else rec.el.style.removeProperty('translate');
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

  /** Marks an applied element for re-measuring from the page's own styles on the next scan. */
  D.markDirty = function markDirty(el) {
    const rec = records.get(el);
    if (rec) (rec.owner || rec).dirty = true;
  };
})();
