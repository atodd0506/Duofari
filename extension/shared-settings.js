// Settings shared by the content scripts, the popup and the background script.
//
// Everything lives in storage.local (storage.sync doesn't sync in Safari).
// Content scripts listen for changes and re-apply immediately.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});

  D.DEFAULTS = Object.freeze({
    enabled: true,
    disabledSites: [],      // hostnames where the user turned Duofari off
    enabledSites: [],       // hostnames the user turned on despite the built-in exclusions
    bands: true,            // header bars, hero sections and other full-width backgrounds
    media: true,            // the lead image and cover-fitted images and video
    allImages: false,       // every full-width image, not just the lead one (trims top and bottom)
    breakout: false,        // photos inside page margins grow to the full width (changes layout)
    landscapeSide: 'auto',  // which edge Safari's column is on in landscape: 'auto' | 'left' | 'right'
    desktopPages: false,    // also adjust pages laid out at desktop width
    holdSteady: true,       // block sideways panning of the page itself while not zoomed
    debug: false,           // outline what was extended and hatch the column
    force: false,           // act as if on an iPhone Duo (testing on other devices)
    forceColumn: 84,        // column width used with `force`, in points
    device: null,           // screen info from the containing app (survives fingerprinting protection)
  });

  /**
   * Web apps that draw their own full-screen UI and don't benefit from
   * having parts of it reach under Safari's controls. Users can still turn
   * Duofari on for them from the popup.
   */
  D.EXCLUDED_SITES = Object.freeze([
    'docs.google.com', 'sheets.google.com', 'slides.google.com', 'drive.google.com', 'mail.google.com',
    'calendar.google.com', 'maps.google.com', 'earth.google.com', 'meet.google.com',
    'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'teams.microsoft.com',
    'www.figma.com', 'figma.com', 'www.canva.com', 'excalidraw.com', 'app.diagrams.net',
    'www.icloud.com', 'icloud.com', 'beta.icloud.com', 'music.apple.com', 'tv.apple.com',
    'www.photopea.com', 'vscode.dev', 'github.dev', 'codepen.io', 'codesandbox.io', 'stackblitz.com',
    'web.whatsapp.com', 'app.slack.com', 'discord.com', 'www.notion.so',
  ]);

  D.api = globalThis.browser || globalThis.chrome || null;

  D.loadSettings = async function loadSettings() {
    const storage = D.api && D.api.storage && D.api.storage.local;
    if (!storage) return { ...D.DEFAULTS, ...(globalThis.__duofariTestSettings || {}) };
    try {
      const stored = await storage.get(D.DEFAULTS);
      return { ...D.DEFAULTS, ...stored };
    } catch (error) {
      console.warn('[Duofari] could not read settings', error);
      return { ...D.DEFAULTS };
    }
  };

  D.saveSettings = async function saveSettings(patch) {
    const storage = D.api && D.api.storage && D.api.storage.local;
    if (!storage) return;
    await storage.set(patch);
  };

  D.onSettingsChanged = function onSettingsChanged(callback) {
    const storage = D.api && D.api.storage;
    if (!storage || !storage.onChanged) return;
    storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const patch = {};
      for (const key of Object.keys(changes)) {
        if (key in D.DEFAULTS) patch[key] = changes[key].newValue;
      }
      if (Object.keys(patch).length) callback(patch);
    });
  };

  /** 'on', 'off' (the user turned it off here) or 'excluded' (built-in list). */
  D.siteState = function siteState(settings, hostname) {
    const list = (key) => (Array.isArray(settings[key]) ? settings[key] : []);
    if (list('disabledSites').includes(hostname)) return 'off';
    if (D.EXCLUDED_SITES.includes(hostname) && !list('enabledSites').includes(hostname)) return 'excluded';
    return 'on';
  };

  /** The settings patch that turns Duofari on or off for one site. */
  D.sitePatch = function sitePatch(settings, hostname, on) {
    const disabled = new Set(settings.disabledSites || []);
    const enabled = new Set(settings.enabledSites || []);
    if (on) {
      disabled.delete(hostname);
      if (D.EXCLUDED_SITES.includes(hostname)) enabled.add(hostname);
    } else {
      enabled.delete(hostname);
      if (!D.EXCLUDED_SITES.includes(hostname)) disabled.add(hostname);
    }
    return { disabledSites: [...disabled], enabledSites: [...enabled] };
  };
})();
