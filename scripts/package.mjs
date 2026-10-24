#!/usr/bin/env node
// Packs extension/ into dist/Duofari-<version>.zip: the web extension on its
// own, for App Store Connect's Safari web extension upload or for loading in
// Safari's developer settings. Checks the manifest's file references first.
//
//   node scripts/package.mjs
//
// The Xcode project in apple/ bundles the same folder, so a build from Xcode
// and the zip always carry identical extension code.

import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const IGNORE = new Set(['.DS_Store', 'Thumbs.db']);

// CRC-32 as ZIP uses it. zlib.crc32 only exists from Node 22.2, and
// package.json allows any Node 22.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function listFiles(dir) {
  const out = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Every file the manifest points at, so a typo fails here rather than in Safari. */
function referencedFiles(manifest) {
  const files = [];
  const add = (value) => { if (typeof value === 'string') files.push(value); };
  Object.values(manifest.icons || {}).forEach(add);
  if (manifest.action) {
    add(manifest.action.default_popup);
    Object.values(manifest.action.default_icon || {}).forEach(add);
  }
  (manifest.background && manifest.background.scripts || []).forEach(add);
  add(manifest.background && manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) {
    (script.js || []).forEach(add);
    (script.css || []).forEach(add);
  }
  if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
  return files;
}

/** A minimal ZIP writer (deflate, no zip64): enough for a few hundred kilobytes of extension. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // A fixed timestamp keeps the archive byte-for-byte reproducible.
  const time = 0;
  const date = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const manifest = JSON.parse(await readFile(join(EXT, 'manifest.json'), 'utf8'));
const files = await listFiles(EXT);
const names = new Set(files.map((f) => relative(EXT, f).split(sep).join('/')));
const missing = referencedFiles(manifest).filter((f) => !names.has(f.replace(/^\.?\//, '')));
if (missing.length) {
  console.error(`manifest.json refers to missing files: ${missing.join(', ')}`);
  process.exit(1);
}
for (const file of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.error(`${relative(ROOT, file)} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
}

const entries = [];
for (const file of files) {
  entries.push({ name: relative(EXT, file).split(sep).join('/'), data: await readFile(file) });
}
const archive = zip(entries);
await mkdir(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', `Duofari-${manifest.version}.zip`);
await writeFile(out, archive);
const size = (await stat(out)).size;
console.log(`Wrote ${relative(ROOT, out)} (${entries.length} files, ${(size / 1024).toFixed(1)} KB)`);
