// A tiny static file server for the test fixtures.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
};

export async function serve(root, { host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = normalize(join(root, decodeURIComponent(url.pathname)));
      if (url.pathname.endsWith('/')) path = join(path, 'index.html');
      const base = normalize(root).replace(/[\\/]+$/, '');
      if (path !== base && !path.startsWith(base + sep)) throw new Error('outside root');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;
  return { origin: `http://127.0.0.1:${actual}`, port: actual, close: () => new Promise((r) => server.close(r)) };
}
