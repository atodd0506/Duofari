#!/usr/bin/env node
// Renders scripts/icon.svg and scripts/toolbar-icon.svg into every PNG the
// extension and the containing app need. Uses Playwright's Chromium.
//
//   node scripts/build-icons.mjs
//
// Playwright is resolved from the local node_modules or a global install.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../test/lib/playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await loadPlaywright();

const iconSvg = await readFile(join(root, 'scripts/icon.svg'), 'utf8');
const toolbarSvg = await readFile(join(root, 'scripts/toolbar-icon.svg'), 'utf8');

const variants = {
  // App Store icon: full square, iOS applies the mask.
  app: (svg) => svg,
  // Dark appearance: deeper background.
  dark: (svg) => svg.replace('#0A84FF', '#1C1C1E').replace('#0040A8', '#000000'),
  // Tinted appearance: grayscale artwork on black, iOS tints it.
  tinted: (svg) => svg.replace('#0A84FF', '#000000').replace('#0040A8', '#000000'),
};

async function render(page, svg, size, { rounded = false, grayscale = false } = {}) {
  const radius = rounded ? Math.round(size * 0.225) : 0;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${radius}px;overflow:hidden;${grayscale ? 'filter:grayscale(1) brightness(1.15);' : ''}">
      ${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}
    </div></body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

const out = async (rel, buf) => {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, buf);
  console.log('wrote', rel);
};

// Web extension icons (shown in Safari's extension list and settings).
for (const size of [48, 64, 96, 128, 256, 512]) {
  await out(`extension/images/icon-${size}.png`, await render(page, iconSvg, size, { rounded: true }));
}
// Toolbar icons (Safari's extensions menu).
for (const size of [16, 19, 32, 38, 48, 72]) {
  await out(`extension/images/toolbar-${size}.png`, await render(page, toolbarSvg, size));
}
// Containing app icons and the in-app logo.
const appset = 'apple/Duofari/Assets.xcassets/AppIcon.appiconset';
await out(`${appset}/AppIcon-1024.png`, await render(page, variants.app(iconSvg), 1024));
await out(`${appset}/AppIcon-1024-dark.png`, await render(page, variants.dark(iconSvg), 1024));
await out(`${appset}/AppIcon-1024-tinted.png`, await render(page, variants.tinted(iconSvg), 1024, { grayscale: true }));
const logoset = 'apple/Duofari/Assets.xcassets/Logo.imageset';
for (const scale of [1, 2, 3]) {
  await out(`${logoset}/Logo@${scale}x.png`, await render(page, iconSvg, 72 * scale, { rounded: true }));
}
await out(`${logoset}/Contents.json`, Buffer.from(JSON.stringify({
  images: [1, 2, 3].map((s) => ({ filename: `Logo@${s}x.png`, idiom: 'universal', scale: `${s}x` })),
  info: { author: 'xcode', version: 1 },
}, null, 2) + '\n'));

await browser.close();
