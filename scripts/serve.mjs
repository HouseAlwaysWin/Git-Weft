// Static server for dist/, so the preview harness can be opened in a browser - and so the UI probe
// can serve the same files in-process, on a port of its own.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Serve dist/ on `port`, resolving with the server once it is listening.
 *
 * Port 0 asks the system for a free one, which is what the probe does: it neither needs this
 * started separately nor collides with a preview somebody already has open on 4173.
 */
export function serveDist(port = 4173) {
  const server = createServer(async (req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const name = requested === '/' ? 'preview.html' : requested.replace(/^\/+/, '');
    const file = resolve(join(root, name));

    // Refuse anything that escapes dist/.
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  return new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(port, () => ready(server));
  });
}

// Run directly, it behaves as it always has: the preview on 4173 until stopped. Compared without
// case, because Windows spells the same drive both ways depending on who resolved the path.
const direct = process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (direct) {
  await serveDist(4173);
  console.log('weft preview on http://localhost:4173/');
}
