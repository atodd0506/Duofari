// Settings shared by the content scripts and the popup.
//
// Everything lives in storage.local (storage.sync doesn't sync in Safari).
// Content scripts listen for changes and re-apply immediately.

(function () {
  'use strict';
  const D = (globalThis.Duofari = globalThis.Duofari || {});

  D.DEFAULTS = Object.freeze({
    enabled: true,
    disabledSites: [],      // hostnames where Duofari is off
    bands: true,            // header bars, hero sections and other full-width backgrounds
    media: true,            // full-width images and background video
    breakout: true,         // images inset by page margins break out to the full width
    imageStyle: 'fill',     // 'fill' widens the picture; 'mirror' reflects its edge into the column
    landscapeSide: 'auto',  // which edge Safari's column is on in landscape: 'auto' | 'left' | 'right'
    desktopPages: false,    // also adjust pages laid out at desktop width
    debug: false,           // outline extended elements and hatch the column
    force: false,           // pretend to be an iPhone Duo (for testing on other devices)
    forceColumn: 84,        // column width used with `force`, in points
  });

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

  D.siteDisabled = function siteDisabled(settings, hostname) {
    return Array.isArray(settings.disabledSites) && settings.disabledSites.includes(hostname);
  };
})();
