#!/usr/bin/env node
// Serves the test pages to a phone on the same network, for checking Duofari
// on iPhone Duo or in the Simulator:
//
//   node test/serve.mjs [port]
//
// then open the printed address in Safari. /device/ is the device check;
// /fixtures/ holds the pages the automated tests use.

import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './lib/server.mjs';

const port = Number(process.argv[2]) || 8080;
const server = await serve(dirname(fileURLToPath(import.meta.url)), { host: '0.0.0.0', port });
const addresses = Object.values(networkInterfaces()).flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
console.log('Open one of these in Safari on iPhone Duo (same Wi-Fi network):');
for (const address of addresses.length ? addresses : ['localhost']) {
  console.log(`  http://${address}:${server.port}/device/`);
}
console.log(`Fixtures: http://${addresses[0] || 'localhost'}:${server.port}/fixtures/appstore-story.html`);
console.log('In the Simulator, localhost works too. Press Ctrl-C to stop.');
