// Duofari's settings sheet. Reads and writes storage.local; the content
// script picks up changes immediately.

(function () {
  'use strict';
  const D = globalThis.Duofari;
  const api = D.api;
  let settings = { ...D.DEFAULTS };
  let hostname = '';

  const REASONS = {
    'not-duo': ['Not an iPhone Duo', 'Duofari only adjusts pages on iPhone Duo.'],
    'no-column': ['Nothing to extend here', 'Safari is using the full width of the screen, so there’s no side column.'],
    'unexpected-width': ['Nothing to extend here', 'Safari’s side column isn’t showing next to this page.'],
    'desktop-layout': ['Desktop layout', 'This page is laid out for a wider screen. Turn on “Also adjust desktop-layout pages” to include it.'],
    'disabled': ['Duofari is off', ''],
    'site-disabled': ['Off for this site', ''],
    'zoomed': ['Paused while zoomed in', 'Zoom back out to see the page extended.'],
    'starting': ['Checking this page…', ''],
  };

  function $(id) { return document.getElementById(id); }

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
    $('breakout').disabled = off || !settings.media;
    if (hostname) {
      $('site-row').hidden = false;
      $('site-name').textContent = hostname;
      $('site').checked = !D.siteDisabled(settings, hostname);
    }
  }

  async function save(patch) {
    Object.assign(settings, patch);
    render();
    await D.saveSettings(patch);
    setTimeout(refreshStatus, 400);
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
    $('site').addEventListener('change', () => {
      const sites = new Set(settings.disabledSites || []);
      if ($('site').checked) sites.delete(hostname);
      else sites.add(hostname);
      save({ disabledSites: [...sites] });
    });
  }

  function showStatus(state, title, detail) {
    $('status').dataset.state = state;
    $('status-title').textContent = title;
    $('status-detail').textContent = detail;
  }

  async function refreshStatus() {
    let status = null;
    try {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id !== undefined) status = await api.tabs.sendMessage(tab.id, { type: 'duofari:status' });
    } catch {
      status = null;
    }
    if (!status) {
      showStatus('warn', 'Reload this page', 'Duofari adjusts pages as they load. Pages opened before it was turned on, or before you allowed it on this site, need a reload.');
      return;
    }
    hostname = status.hostname;
    render();
    if (status.active) {
      const c = status.counts || {};
      const side = status.left && status.right ? 'both sides' : status.right ? 'on the right' : 'on the left';
      const parts = [];
      if (c.band) parts.push(`${c.band} ${c.band === 1 ? 'bar' : 'bars'}`);
      const images = (c.media || 0) + (c.breakout || 0);
      if (images) parts.push(`${images} ${images === 1 ? 'image' : 'images'}`);
      showStatus('on', parts.length ? `Extended ${parts.join(' and ')}` : 'Active, nothing to extend yet',
        `Safari’s controls take ${Math.round(status.column)} points ${side}.`);
    } else {
      const [title, detail] = REASONS[status.reason] || ['Not active', ''];
      showStatus('off', title, detail);
    }
  }

  (async function init() {
    settings = await D.loadSettings();
    render();
    bind();
    refreshStatus();
  })();
})();
