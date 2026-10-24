// Duofari's settings sheet. Reads and writes storage.local (the content script
// picks up changes immediately), shows what Duofari did on the current page,
// and helps when it can't run there yet.

(function () {
  'use strict';
  const D = globalThis.Duofari;
  const api = D.api;
  const CONTENT_SCRIPTS = (api && api.runtime && api.runtime.getManifest)
    ? api.runtime.getManifest().content_scripts[0].js
    : [];

  let settings = { ...D.DEFAULTS };
  let tab = null;
  let hostname = '';
  let diagnostics = null;

  const $ = (id) => document.getElementById(id);

  /** A localized string, or the given English fallback. */
  function t(key, fallback, subs) {
    try {
      const msg = api && api.i18n && api.i18n.getMessage(key, subs);
      if (msg) return msg;
    } catch {
      // fall through
    }
    return subs === undefined ? fallback : String(fallback).replace(/\$1/g, subs);
  }

  function localize() {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n, el.textContent);
    }
  }

  const locale = (api && api.i18n && api.i18n.getUILanguage && api.i18n.getUILanguage()) || navigator.language || 'en';
  const plural = new Intl.PluralRules(locale);
  const list = Intl.ListFormat ? new Intl.ListFormat(locale, { type: 'conjunction' }) : { format: (items) => items.join(', ') };
  function count(n, key, one, other) {
    const form = plural.select(n) === 'one' ? 'One' : 'Other';
    return t(`${key}${form}`, form === 'One' ? one : other, String(n));
  }

  const REASONS = {
    'not-duo': ['reasonNotDuo', 'Not an iPhone Duo', 'reasonNotDuoDetail', 'Duofari only changes pages on iPhone Duo, beside Safari’s side controls.'],
    'no-column': ['reasonNoColumn', 'Nothing to extend here', 'reasonNoColumnDetail', 'Safari is using the full width of the screen. Fold iPhone Duo to use Duofari on the outer display.'],
    'unexpected-width': ['reasonNoColumn', 'Nothing to extend here', 'reasonUnexpectedDetail', 'Safari’s side column isn’t showing next to this page.'],
    'desktop-layout': ['reasonDesktop', 'Desktop layout', 'reasonDesktopDetail', 'This page is laid out for a wider screen. Turn on “Also adjust desktop-layout pages” under More to include it.'],
    'start-side': ['reasonStartSide', 'Controls on the wrong side', 'reasonStartSideDetail', 'Pages can only reach under controls on the side where their lines end, so Duofari leaves this one alone.'],
    'reduced-transparency': ['reasonTransparency', 'Reduce Transparency is on', 'reasonTransparencyDetail', 'Safari’s side column is opaque, so nothing under it would show.'],
    'unstable': ['reasonUnstable', 'Paused on this page', 'reasonUnstableDetail', 'The page kept changing size as Duofari worked, so it stepped back.'],
    'disabled': ['reasonDisabled', 'Duofari is off', 'reasonDisabledDetail', 'Turn it on under More.'],
    'site-disabled': ['reasonSiteOff', 'Off for this site', 'reasonSiteOffDetail', 'Turn it back on above.'],
    'excluded-site': ['reasonExcluded', 'Off for this web app', 'reasonExcludedDetail', 'Turn it on above if you’d like to try it here.'],
    'zoomed': ['reasonZoomed', 'Paused while zoomed in', 'reasonZoomedDetail', 'Zoom back out to see the page extended.'],
    'unsupported-document': ['statusUnsupported', 'Duofari can’t change this kind of page', 'statusUnsupportedDetail', 'It works on websites, not on Safari’s own pages, Reader or PDFs.'],
    'starting': ['statusChecking', 'Checking this page…', '', ''],
  };

  function render() {
    for (const input of document.querySelectorAll('input[data-setting]')) {
      input.checked = !!settings[input.dataset.setting];
    }
    for (const group of document.querySelectorAll('.segmented[data-setting]')) {
      for (const button of group.querySelectorAll('button')) {
        button.setAttribute('aria-checked', String(settings[group.dataset.setting] === button.dataset.value));
      }
    }
    const off = !settings.enabled;
    for (const input of document.querySelectorAll('input[data-setting]:not(#enabled), #site')) input.disabled = off;
    $('allImages').disabled = off || !settings.media;
    $('breakout').disabled = off || !settings.media;
    if (hostname) {
      $('site-group').hidden = false;
      $('site-name').textContent = hostname;
      const state = D.siteState(settings, hostname);
      $('site').checked = state === 'on';
      $('site-note').hidden = !D.EXCLUDED_SITES.includes(hostname);
    }
  }

  async function save(patch) {
    Object.assign(settings, patch);
    render();
    await D.saveSettings(patch);
    setTimeout(refreshStatus, 450);
  }

  function bind() {
    for (const input of document.querySelectorAll('input[data-setting]')) {
      input.addEventListener('change', () => save({ [input.dataset.setting]: input.checked }));
    }
    for (const group of document.querySelectorAll('.segmented[data-setting]')) {
      group.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-value]');
        if (button) save({ [group.dataset.setting]: button.dataset.value });
      });
      group.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const buttons = [...group.querySelectorAll('button')];
        const index = buttons.findIndex((b) => b.dataset.value === settings[group.dataset.setting]);
        const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
        next.focus();
        save({ [group.dataset.setting]: next.dataset.value });
      });
    }
    $('site').addEventListener('change', () => save(D.sitePatch(settings, hostname, $('site').checked)));
    $('copy-diagnostics').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('diagnostics-text').textContent);
        $('copy-diagnostics').textContent = t('copied', 'Copied');
      } catch {
        // Selecting the text lets the user copy it by hand.
        const range = document.createRange();
        range.selectNodeContents($('diagnostics-text'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    });
  }

  function showStatus(state, title, detail, action) {
    $('status').dataset.state = state;
    $('status-title').textContent = title;
    $('status-detail').textContent = detail || '';
    const button = $('status-action');
    button.hidden = !action;
    if (action) {
      button.textContent = action.label;
      button.onclick = action.run;
    }
  }

  function showDiagnostics(extra) {
    const lines = Object.entries({ ...(diagnostics || {}), ...extra }).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    const manifest = api && api.runtime && api.runtime.getManifest ? api.runtime.getManifest() : { version: '?' };
    $('diagnostics-text').textContent = [`Duofari ${manifest.version}`, ...lines].join('\n');
  }

  async function inject() {
    if (!tab || !api.scripting) return false;
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS });
      return true;
    } catch {
      return false;
    }
  }

  async function askStatus() {
    try {
      return await api.tabs.sendMessage(tab.id, { type: 'duofari:status' });
    } catch {
      return null;
    }
  }

  /**
   * Whether Safari lets Duofari run on the site for good. Opening the popup
   * also grants the tab temporary access (activeTab): Safari then shows its
   * address and runs the content scripts, but only until the tab moves to
   * another site. permissions.contains() leaves that grant out.
   */
  async function hasAccess(url) {
    try {
      const site = url && new URL(url);
      return await api.permissions.contains({ origins: [site ? `${site.protocol}//${site.hostname}/*` : '*://*/*'] });
    } catch {
      return !!url; // can't tell: go by whether Safari shows the address
    }
  }

  async function refreshStatus() {
    try {
      [tab] = await api.tabs.query({ active: true, currentWindow: true });
    } catch {
      tab = null;
    }
    if (!tab || tab.id === undefined) {
      showStatus('warn', t('statusNoPage', 'No page open'), '');
      return;
    }
    // Without any access to the site Safari hides the tab's address.
    const url = tab.url || '';
    const unsupported = () => showStatus('off', t('statusUnsupported', 'Duofari can’t change this kind of page'),
      t('statusUnsupportedDetail', 'It works on websites, not on Safari’s own pages, Reader or PDFs.'));
    if (url && !/^https?:/i.test(url)) {
      unsupported();
      showDiagnostics({ url });
      return;
    }

    const [access, status] = await Promise.all([hasAccess(url), askStatus()]);
    const allow = {
      label: t('actionAllow', 'Allow on All Websites'),
      run: async () => {
        let granted = false;
        try {
          granted = await api.permissions.request({ origins: ['*://*/*'] });
        } catch {
          granted = false;
        }
        if (granted) await inject();
        setTimeout(refreshStatus, 600);
      },
    };
    if (!status) {
      if (!access) {
        showStatus('warn', t('statusNoAccess', 'Duofari can’t see this site yet'),
          t('statusNoAccessDetail', 'Allow it on all websites so it can extend pages as they open.'), allow);
      } else if (!url) {
        // Safari's Start Page or an empty tab, or a site the user set to Deny
        // while allowing all others: Safari hides the address either way.
        showStatus('off', t('statusHidden', 'Duofari can’t see this page'),
          t('statusHiddenDetail', 'This is Safari’s Start Page, or a website set to Deny in Settings › Apps › Safari › Extensions › Duofari.'));
      } else if (/\.pdf$/i.test(new URL(url).pathname)) {
        unsupported();
      } else {
        showStatus('warn', t('statusNotRun', 'Duofari hasn’t run on this page yet'),
          t('statusNotRunDetail', 'Pages opened before Duofari was turned on need a moment, or a reload.'), {
            label: t('actionApply', 'Apply to This Page'),
            run: async () => {
              // Nothing to run in (a PDF at an address without .pdf, Reader):
              // reloading would only lose the reader's place.
              if (await inject()) setTimeout(refreshStatus, 800);
              else unsupported();
            },
          });
      }
      showDiagnostics({ url: url || '(hidden)' });
      return;
    }

    hostname = status.hostname;
    diagnostics = status.diagnostics;
    render();
    showDiagnostics({ reason: status.reason, counts: status.counts });

    // Running only on the temporary access that opening the popup gave:
    // it stops on the next site unless the user allows it for good.
    const temporary = !access && status.reason !== 'unsupported-document';
    const note = temporary ? t('statusThisPageOnly', 'For now Duofari can see only this page. Allow it on all websites so it can extend pages as they open.') : '';
    const action = temporary ? allow : null;
    if (status.active) {
      const c = status.counts || {};
      const images = (c.media || 0) + (c.breakout || 0);
      const parts = [];
      if (c.band) parts.push(count(c.band, 'countBars', '$1 bar', '$1 bars'));
      if (images) parts.push(count(images, 'countImages', '$1 image', '$1 images'));
      const title = parts.length
        ? t('statusExtended', 'Extended $1', list.format(parts))
        : t('statusNothingYet', 'On, nothing to extend yet');
      const points = String(Math.round(status.column));
      showStatus('on', title, note || (status.side === 'left'
        ? t('statusColumnLeft', 'Safari’s controls take $1 points on the left.', points)
        : t('statusColumnRight', 'Safari’s controls take $1 points on the right.', points)), action);
    } else {
      const [titleKey, title, detailKey, detail] = REASONS[status.reason] || ['statusOff', 'Not active', '', ''];
      showStatus('off', t(titleKey, title), note || (detailKey ? t(detailKey, detail) : detail), action);
    }
  }

  (async function init() {
    localize();
    settings = await D.loadSettings();
    render();
    bind();
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('ready')));
    // Make sure the content scripts know the real screen size (Private Browsing hides it).
    try { api.runtime.sendMessage({ type: 'duofari:refresh-device' }); } catch { /* optional */ }
    refreshStatus();
  })();
})();
