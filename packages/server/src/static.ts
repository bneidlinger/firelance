import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

// Tiny static file server for the built client (packages/client/dist), so a
// single origin serves both the page and the WebSocket — one URL for friends,
// tunnel-friendly (cloudflared terminates TLS, we speak plain http/ws).

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  const rootAbs = resolve(root);
  const urlPath = (req.url ?? '/').split('?')[0]!;
  // Normalize and contain within root (no ../ escapes).
  let filePath = normalize(join(rootAbs, decodeURIComponent(urlPath)));
  if (!filePath.startsWith(rootAbs)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback: everything unknown gets index.html.
    filePath = join(rootAbs, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404).end('client not built — run: npm -w @firelance/client run build');
      return;
    }
  }
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}
