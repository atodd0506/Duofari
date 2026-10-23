#!/usr/bin/env node
// Draws the JPEG photos used by the test fixtures (raster images, so Duofari
// treats them as photos rather than graphics). Deterministic output.
//
//   node scripts/build-fixture-images.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from '../test/lib/playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'fixtures', 'img');
await mkdir(out, { recursive: true });

// Each picture: a landscape with distinct colour bands at known x positions,
// so tests can tell which part of the picture shows under the column.
const PICTURES = {
  hero: { w: 1600, h: 800, sky: '#7fb3e6', hill: '#3c6e3f', sun: '#ffd23f' },
  photo: { w: 1200, h: 800, sky: '#9ac7d9', hill: '#5b7d3a', sun: '#ff9f43' },
  banner: { w: 2000, h: 500, sky: '#3a3f7a', hill: '#e2588c', sun: '#ffe066' },
  square: { w: 800, h: 800, sky: '#c9b3e6', hill: '#6e3c63', sun: '#ffd23f' },
};

// The App Store story's hero: a row of app icons on a grey gradient, wide
// enough that a cover crop hides more icons beside the visible ones.
const APPSTORE = `const g = c.getContext('2d'), W = c.width, H = c.height;
  const grd = g.createLinearGradient(0, 0, W, 0); grd.addColorStop(0, '#4a4a4f'); grd.addColorStop(1, '#8a8a90');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const colors = ['#e33', '#f2f2f2', '#222', '#fff', '#f5b400', '#2b7de9', '#e33', '#f2f2f2'];
  for (let i = 0; i < colors.length; i++) {
    const x = 60 + i * 200, y = 120, s = 160;
    g.fillStyle = colors[i]; g.beginPath(); g.roundRect(x, y, s, s, 36); g.fill();
    if (i === 2) { g.strokeStyle = '#7d3'; g.lineWidth = 14; g.beginPath(); g.arc(x + s / 2, y + s / 2, 52, 0, 7); g.stroke(); }
    if (i === 3) { g.fillStyle = '#111'; g.font = 'italic 44px Georgia'; g.fillText('Classify', x + 8, y + 96); }
  }`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [name, p] of Object.entries(PICTURES)) {
  await page.setViewportSize({ width: p.w, height: p.h });
  await page.setContent(`<body style="margin:0"><canvas id=c width=${p.w} height=${p.h}></canvas><script>{
    const g = c.getContext('2d'), W = ${p.w}, H = ${p.h};
    g.fillStyle = '${p.sky}'; g.fillRect(0, 0, W, H);
    g.fillStyle = '${p.sun}'; g.beginPath(); g.arc(W * 0.78, H * 0.25, H * 0.12, 0, 7); g.fill();
    g.fillStyle = '${p.hill}'; g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) g.lineTo(x, H * 0.62 - Math.sin(x / W * 9) * H * 0.12);
    g.lineTo(W, H); g.fill();
    // A marker stripe every tenth of the width, for checking what shows where.
    for (let i = 1; i < 10; i++) { g.fillStyle = i % 2 ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.25)'; g.fillRect(W * i / 10 - 2, H * 0.85, 4, H * 0.15); }
  }</script></body>`);
  const buf = await page.locator('#c').screenshot({ type: 'jpeg', quality: 82 });
  await writeFile(join(out, `${name}.jpg`), buf);
  console.log('wrote', `test/fixtures/img/${name}.jpg`, buf.length, 'bytes');
}
await page.setViewportSize({ width: 1660, height: 900 });
await page.setContent(`<body style="margin:0"><canvas id=c width=1660 height=900></canvas><script>{${APPSTORE}}</script></body>`);
const buf = await page.locator('#c').screenshot({ type: 'jpeg', quality: 82 });
await writeFile(join(out, 'appstore-hero.jpg'), buf);
console.log('wrote test/fixtures/img/appstore-hero.jpg', buf.length, 'bytes');
await browser.close();
