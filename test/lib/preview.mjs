// Draws Safari's iPhone Duo side column over page screenshots, so a test run
// can show what the page looks like on the folded phone with and without
// Duofari.
//
// The column is drawn from Mike Piontek's Xcode 27.1 simulator screenshots:
// the camera at the top, a capsule holding the clock and Wi-Fi, then glass
// Back and Reader buttons. Without Duofari Safari fills the column with a
// colour sampled from the page; with content underneath, the controls turn
// to glass over it.

export async function capturePair(page, { C, vw, vh }) {
  // Chromium captures beyond the viewport by briefly resizing the view, which
  // fires `resize`. Pages that lay themselves out in script would reflow for
  // the screenshot, so hold those events back while it's taken.
  const y = await page.evaluate(() => {
    const stop = (e) => e.stopImmediatePropagation();
    globalThis.__duofariHoldResize = stop;
    globalThis.addEventListener('resize', stop, true);
    if (globalThis.visualViewport) globalThis.visualViewport.addEventListener('resize', stop, true);
    return globalThis.scrollY;
  });
  const shot = await page.screenshot({ fullPage: true, clip: { x: 0, y, width: vw + C, height: vh } });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const stop = globalThis.__duofariHoldResize;
    globalThis.removeEventListener('resize', stop, true);
    if (globalThis.visualViewport) globalThis.visualViewport.removeEventListener('resize', stop, true);
  });
  return shot;
}

export async function pageBackground(page) {
  return page.evaluate(() => {
    for (const el of [document.body, document.documentElement]) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
    }
    return 'rgb(255, 255, 255)';
  });
}

/**
 * @param browser  Playwright browser
 * @param {object} o { before: Buffer (vw × vh), after: Buffer ((vw + C) × vh), fill: css colour, C, vw, vh, title }
 * @returns {Promise<Buffer>} a PNG with the two phones side by side
 */
export async function renderPreview(browser, { before, after, fill, C, vw, vh, title = '' }) {
  const page = await browser.newPage({ viewport: { width: 1100, height: vh + 140 }, deviceScaleFactor: 2 });
  const b64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
  const W = vw + C;
  const column = (glass) => `
    <div class="col ${glass ? 'glass' : ''}" style="left:${vw}px;width:${C}px">
      <div class="pill"><div class="cam"></div><div class="time">9:41</div>
        <svg class="wifi" viewBox="0 0 24 24"><path d="M12 18.5a1.5 1.5 0 1 0 0 .01zM7.8 14.6a6 6 0 0 1 8.4 0l-1.4 1.4a4 4 0 0 0-5.6 0zM4.9 11.7a10 10 0 0 1 14.2 0l-1.4 1.4a8 8 0 0 0-11.4 0z" fill="currentColor"/></svg>
      </div>
      <div class="btn" style="top:${Math.round(vh * 0.42)}px"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div class="btn" style="top:${Math.round(vh * 0.42) + 64}px"><svg viewBox="0 0 24 24"><path d="M4 6c3-1.5 5.5-1.5 8 0v13c-2.5-1.5-5-1.5-8 0zM20 6c-3-1.5-5.5-1.5-8 0v13c2.5-1.5 5-1.5 8 0z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></div>
      <div class="btn" style="bottom:22px"><svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>
    </div>`;
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; background: #e9e9ee; font: 600 14px -apple-system, system-ui, sans-serif; color: #333; }
    .row { display: flex; gap: 48px; padding: 20px 40px; align-items: flex-start; }
    .cap { margin: 0 0 10px; }
    .phone { position: relative; width: ${W}px; height: ${vh}px; overflow: hidden; border-radius: 34px 34px 0 0;
      box-shadow: 0 0 0 10px #1c1c1e, 0 18px 40px rgba(0,0,0,.25); background: ${fill}; }
    .phone > img { position: absolute; left: 0; top: 0; }
    .col { position: absolute; top: 0; bottom: 0; }
    .pill { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); width: 48px; height: 104px;
      border-radius: 24px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding-top: 7px; box-sizing: border-box; color: #111; }
    .cam { width: 26px; height: 26px; border-radius: 13px; background: #000; }
    .time { font: 600 13px -apple-system, system-ui; }
    .wifi { width: 20px; height: 20px; }
    .btn { position: absolute; left: 50%; transform: translateX(-50%); width: 48px; height: 48px; border-radius: 24px;
      display: grid; place-items: center; color: #111; background: rgba(255,255,255,.55); box-shadow: 0 0 0 .5px rgba(0,0,0,.12); }
    .btn svg { width: 22px; height: 22px; }
    .glass .pill, .glass .btn { background: rgba(255,255,255,.28); -webkit-backdrop-filter: blur(10px) saturate(1.6);
      backdrop-filter: blur(10px) saturate(1.6); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.6), 0 1px 6px rgba(0,0,0,.12); }
    h1 { font-size: 16px; margin: 16px 40px 0; }
  </style></head><body>
    <h1>${title}</h1>
    <div class="row">
      <div><p class="cap">Safari on iPhone Duo (folded)</p>
        <div class="phone"><img src="${b64(before)}" width="${vw}" height="${vh}">${column(false)}</div></div>
      <div><p class="cap">With Duofari</p>
        <div class="phone"><img src="${b64(after)}" width="${W}" height="${vh}">${column(true)}</div></div>
    </div></body></html>`);
  await page.waitForTimeout(100);
  const png = await page.screenshot({ fullPage: true });
  await page.close();
  return png;
}
