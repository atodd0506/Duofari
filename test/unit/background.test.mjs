// Unit tests for the background script: it asks the containing app for the
// real screen size and stores it, but only when the answer is new. Every open
// tab starts over from the page's own layout when the stored device changes,
// and the popup asks again each time it opens.
//
//   node --test "test/unit/*.test.mjs"   # or: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

const DUO = { screenWidth: 466, screenHeight: 678, scale: 3, model: 'iPhone19,1' };

/** Runs background.js against a stand-in for `browser.*` with the app answering `reply`. */
function loadBackground(reply, stored = {}) {
  const store = structuredClone(stored);
  const writes = [];
  const listeners = [];
  const browser = {
    runtime: {
      sendNativeMessage: async () => reply,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: {
        get: async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
        set: async (patch) => {
          writes.push(patch);
          Object.assign(store, structuredClone(patch));
        },
      },
    },
  };
  vm.runInContext(readFileSync(join(EXT, 'background.js'), 'utf8'), vm.createContext({ browser, console }), { filename: 'background.js' });
  // What the popup sends each time it opens.
  const popupOpened = () => new Promise((resolve) => listeners[0]({ type: 'duofari:refresh-device' }, {}, resolve));
  return { store, writes, popupOpened };
}

test('stores the device the app reports once, however often the popup opens', async () => {
  const bg = loadBackground(DUO);
  await bg.popupOpened();
  await bg.popupOpened();
  await bg.popupOpened();
  assert.equal(bg.writes.length, 1);
  assert.deepEqual(bg.store.device, DUO);
});

test('rewrites the device only when the answer changes', async () => {
  // Older versions stamped the stored device with the time it was checked.
  const bg = loadBackground(DUO, { device: { ...DUO, checked: 1 } });
  await bg.popupOpened();
  assert.deepEqual(bg.store.device, DUO);
  await bg.popupOpened();
  assert.equal(bg.writes.length, 1);
});
