#!/usr/bin/env node
// Renders the popup against a stand-in for Safari's extension APIs and checks
// each state it can be in: active, not running yet, no site access or only
// the popup's temporary access (then granting it), pages it can't change, and
// web apps it leaves alone. Writes screenshots to test/output/popup/.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import { serve } from './lib/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'extension');
const OUT = join(HERE, 'output', 'popup');

const messages = JSON.parse(await readFile(join(EXT, '_locales', 'en', 'messages.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));

const activeStatus = (hostname, extra = {}) => ({
  hostname,
  active: true,
  reason: 'active',
  column: 84,
  side: 'right',
  landscape: false,
  counts: { band: 3, media: 1 },
  truncated: false,
  diagnostics: { columnPoints: 84, layoutWidth: 382 },
  ...extra,
});

const CASES = [
  {
    name: 'active',
    tab: { id: 1, url: 'https://example.com/story' },
    status: activeStatus('example.com'),
    expect: { title: 'Extended 3 bars and 1 image', site: true },
  },
  {
    name: 'one-of-each',
    tab: { id: 1, url: 'https://example.com/story' },
    status: activeStatus('example.com', { counts: { band: 1, media: 0, breakout: 0 } }),
    expect: { title: 'Extended 1 bar', site: true },
  },
  {
    name: 'not-duo',
    tab: { id: 1, url: 'https://example.com/' },
    status: { ...activeStatus('example.com'), active: false, reason: 'not-duo', column: 0, side: null },
    expect: { title: 'Not an iPhone Duo', site: true },
  },
  {
    name: 'site-off',
    settings: { disabledSites: ['example.com'] },
    tab: { id: 1, url: 'https://example.com/' },
    status: { ...activeStatus('example.com'), active: false, reason: 'site-disabled' },
    expect: { title: 'Off for this site', site: false },
  },
  {
    name: 'excluded-site',
    tab: { id: 1, url: 'https://docs.google.com/document/d/1' },
    status: { ...activeStatus('docs.google.com'), active: false, reason: 'excluded-site' },
    expect: { title: 'Off for this web app', site: false, note: true },
  },
  {
    name: 'unsupported',
    tab: { id: 1, url: 'safari-web-extension://abc/page.html' },
    status: null,
    expect: { title: 'Duofari can’t change this kind of page' },
  },
  {
    name: 'not-run-yet',
    tab: { id: 1, url: 'https://example.com/' },
    status: null,
    expect: { title: 'Duofari hasn’t run on this page yet', action: 'Apply to This Page' },
    click: { inject: true, status: activeStatus('example.com'), title: 'Extended 3 bars and 1 image' },
  },
  {
    // Denied in Safari's settings: no temporary access either, so the address is hidden.
    name: 'no-access',
    granted: [],
    tab: { id: 1, url: '' },
    status: null,
    expect: { title: 'Duofari can’t see this site yet', action: 'Allow on All Websites' },
    click: { grant: true, inject: true, status: activeStatus('example.com'), title: 'Extended 3 bars and 1 image' },
  },
  {
    // Safari's default "Ask": opening the popup gave the tab temporary access,
    // so the address shows and the content scripts run, until the next site.
    name: 'this-page-only',
    granted: [],
    tab: { id: 1, url: 'https://example.com/story' },
    status: activeStatus('example.com'),
    expect: { title: 'Extended 3 bars and 1 image', detail: messages.statusThisPageOnly.message, action: 'Allow on All Websites', site: true },
    click: { grant: true, status: activeStatus('example.com'), title: 'Extended 3 bars and 1 image' },
  },
  {
    name: 'site-allowed',
    granted: ['*://example.com/*'],
    tab: { id: 1, url: 'https://example.com/story' },
    status: activeStatus('example.com'),
    expect: { title: 'Extended 3 bars and 1 image', detail: 'Safari’s controls take 84 points on the right.', site: true },
  },
  {
    // Safari's Start Page or an empty tab, with access to all websites. A
    // site set to Deny while all others are allowed looks just the same.
    name: 'start-page',
    tab: { id: 1, url: '' },
    status: null,
    expect: { title: 'Duofari can’t see this page', detail: messages.statusHiddenDetail.message },
  },
  {
    name: 'svg-file',
    tab: { id: 1, url: 'https://example.com/logo.svg' },
    status: { hostname: 'example.com', active: false, reason: 'unsupported-document' },
    expect: { title: 'Duofari can’t change this kind of page' },
  },
  {
    name: 'pdf',
    tab: { id: 1, url: 'https://example.com/paper.pdf' },
    status: null,
    expect: { title: 'Duofari can’t change this kind of page' },
  },
  {
    // A PDF at an address without .pdf: there is nothing to run in, and a
    // reload would only lose the reader's place.
    name: 'pdf-no-suffix',
    injectFails: true,
    tab: { id: 1, url: 'https://arxiv.org/pdf/2401.00001' },
    status: null,
    expect: { title: 'Duofari hasn’t run on this page yet', action: 'Apply to This Page' },
    click: { inject: true, status: null, title: 'Duofari can’t change this kind of page' },
  },
  {
    name: 'dark',
    dark: true,
    tab: { id: 1, url: 'https://example.com/story' },
    status: activeStatus('example.com'),
    expect: { title: 'Extended 3 bars and 1 image', site: true },
    open: true,
  },
];

/** Installs a stand-in for the parts of `browser.*` the popup uses. */
function mockBrowser({ messages, manifest, scenario }) {
  const store = { ...(scenario.settings || {}) };
  const calls = (globalThis.__calls = { injected: [], requested: [], saved: [], sent: [], reloaded: [] });
  let status = scenario.status;
  let tab = scenario.tab;
  // Host access the user granted for good (all websites unless the case says
  // otherwise). The temporary access opening the popup gives a tab doesn't
  // count here: Safari's permissions.contains() leaves it out.
  const granted = new Set(scenario.granted || ['*://*/*']);
  const host = (pattern) => /^[^:]+:\/\/([^/]*)/.exec(pattern)[1];
  const covered = (origin) => granted.has('*://*/*') || granted.has(`*://${host(origin)}/*`);
  globalThis.__setScenario = (next) => {
    if ('status' in next) status = next.status;
    if ('tab' in next) tab = next.tab;
  };
  globalThis.browser = {
    i18n: {
      getUILanguage: () => 'en',
      getMessage(key, subs) {
        const entry = messages[key];
        if (!entry) return '';
        const list = subs === undefined ? [] : [].concat(subs);
        return entry.message.replace(/\$(\d)/g, (_, n) => list[n - 1] ?? '');
      },
    },
    runtime: {
      getManifest: () => manifest,
      sendMessage: async (message) => { calls.sent.push(message); },
    },
    storage: {
      local: {
        get: async () => ({ ...store }),
        set: async (patch) => { Object.assign(store, patch); calls.saved.push(patch); },
      },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => [tab],
      sendMessage: async () => {
        if (!status) throw new Error('Could not establish connection. Receiving end does not exist.');
        return status;
      },
      reload: async (id) => { calls.reloaded.push(id); },
    },
    permissions: {
      contains: async ({ origins = [] }) => origins.every(covered),
      request: async (perms) => {
        calls.requested.push(perms);
        for (const origin of perms.origins || []) granted.add(origin);
        return true;
      },
    },
    scripting: {
      executeScript: async ({ files }) => {
        calls.injected.push(files);
        if (scenario.injectFails) throw new Error('Cannot access contents of the page.');
        return [];
      },
    },
  };
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const server = await serve(EXT);
await mkdir(OUT, { recursive: true });
const failures = [];

for (const scenario of CASES) {
  const context = await browser.newContext({
    viewport: { width: 382, height: 700 },
    deviceScaleFactor: 2,
    colorScheme: scenario.dark ? 'dark' : 'light',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(mockBrowser, { messages, manifest, scenario });
  await page.goto(`${server.origin}/popup.html`);
  const fail = (what) => failures.push(`${scenario.name}: ${what}`);

  const title = page.locator('#status-title');
  try {
    await page.waitForFunction((t) => document.getElementById('status-title').textContent === t, scenario.expect.title, { timeout: 3000 });
  } catch {
    fail(`status reads “${await title.textContent()}”, expected “${scenario.expect.title}”`);
  }
  if ('detail' in scenario.expect) {
    const detail = await page.locator('#status-detail').textContent();
    if (detail !== scenario.expect.detail) fail(`detail reads “${detail}”, expected “${scenario.expect.detail}”`);
  }
  const action = page.locator('#status-action');
  if (scenario.expect.action) {
    if (!(await action.isVisible())) fail('no action button');
    else if ((await action.textContent()) !== scenario.expect.action) fail(`action reads “${await action.textContent()}”`);
  } else if (await action.isVisible()) {
    fail('unexpected action button');
  }
  if ('site' in scenario.expect) {
    if (!(await page.locator('#site-group').isVisible())) fail('site switch hidden');
    else if ((await page.locator('#site').isChecked()) !== scenario.expect.site) fail('site switch in the wrong position');
    if (!!scenario.expect.note !== (await page.locator('#site-note').isVisible())) fail('web-app note shown wrongly');
  }
  const untranslated = await page.evaluate(() => [...document.querySelectorAll('[data-i18n]')]
    .filter((el) => !el.textContent.trim()).map((el) => el.dataset.i18n));
  if (untranslated.length) fail(`empty strings: ${untranslated.join(', ')}`);

  if (scenario.open) {
    await page.locator('details.more > summary').click();
    await page.locator('details.diagnostics > summary').click();
    const text = await page.locator('#diagnostics-text').textContent();
    if (!/Duofari \d/.test(text) || !/columnPoints: 84/.test(text)) fail(`diagnostics read “${text}”`);
    // The segmented control and switches save to storage.
    await page.locator('.segmented button[data-value="left"]').click();
    await page.locator('#breakout').click({ force: true });
    const saved = await page.evaluate(() => globalThis.__calls.saved);
    if (!saved.some((p) => p.landscapeSide === 'left')) fail('landscape side not saved');
    if (!saved.some((p) => p.breakout === true)) fail('breakout not saved');
    if ((await page.locator('.segmented button[data-value="left"]').getAttribute('aria-checked')) !== 'true') fail('segment not selected');
  }

  // Turning the site switch off saves a per-site patch.
  if (scenario.name === 'active') {
    await page.locator('#site').click({ force: true });
    const saved = await page.evaluate(() => globalThis.__calls.saved);
    if (!saved.some((p) => Array.isArray(p.disabledSites) && p.disabledSites.includes('example.com'))) fail('site switch did not save');
  }

  await writeFile(join(OUT, `${scenario.name}.png`), await page.screenshot({ fullPage: true }));

  // (A missing action button was reported above.)
  if (scenario.click && (await action.isVisible())) {
    await page.evaluate((next) => globalThis.__setScenario(next), {
      status: scenario.click.status,
      tab: { id: 1, url: 'https://example.com/' },
    });
    await action.click();
    // Once it has worked, nothing is left to offer.
    try {
      await page.waitForFunction((t) => document.getElementById('status-title').textContent === t &&
        document.getElementById('status-action').hidden, scenario.click.title, { timeout: 3000 });
    } catch {
      fail(`after the action the status reads “${await title.textContent()}”${(await action.isVisible()) ? `, still offering “${await action.textContent()}”` : ''}`);
    }
    const calls = await page.evaluate(() => globalThis.__calls);
    if (scenario.click.grant && !calls.requested.some((p) => p.origins && p.origins.includes('*://*/*'))) fail('did not ask for site access');
    if (scenario.click.inject) {
      const files = calls.injected[0] || [];
      const expected = manifest.content_scripts[0].js;
      if (JSON.stringify(files) !== JSON.stringify(expected)) fail(`injected ${JSON.stringify(files)}`);
    }
    if (calls.reloaded.length) fail('reloaded the tab');
    await writeFile(join(OUT, `${scenario.name}-after.png`), await page.screenshot({ fullPage: true }));
  }

  const sent = await page.evaluate(() => globalThis.__calls.sent);
  if (!sent.some((m) => m.type === 'duofari:refresh-device')) fail('did not ask the app for device details');
  for (const e of errors) fail(`script error: ${e}`);
  console.log(`${failures.some((f) => f.startsWith(`${scenario.name}:`)) ? '✗' : '✓'} ${scenario.name}`);
  await context.close();
}

await server.close();
await browser.close();
for (const f of failures) console.log(`    ${f}`);
console.log(failures.length ? `\n${failures.length} popup check(s) failed` : '\nAll popup checks passed');
process.exit(failures.length ? 1 : 0);
