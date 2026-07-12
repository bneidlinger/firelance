// Host night (M6 s5): one command between "friends are on Discord" and a
// join link in the chat. Builds everything, starts the real match server
// (vale_full / prototype / 11 bots — humans swap into bot seats), opens a
// cloudflared quick tunnel, and prints the URL to paste.
//
//   npm run host
//
// No cloudflared? The script says how to get it and still prints the LAN URL.

import { execSync, spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const PORT = 8787;

console.log('\n⚒  Building client + server...');
execSync('npm run build', { stdio: 'inherit' });

console.log('\n🏰 Starting Firelance (vale_full · prototype · 11 bots)...');
const server = spawn(
  process.execPath,
  ['dist/server.mjs', '--config', 'prototype', '--bots', '11', '--static', 'packages/client/dist'],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

let tunnel = null;
try {
  tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch {
  tunnel = null;
}

let announced = false;
const announce = (url) => {
  if (announced) return;
  announced = true;
  console.log('\n════════════════════════════════════════════════════');
  console.log('  SEND YOUR FRIENDS:');
  console.log(`\n     ${url}\n`);
  if (lan) console.log(`  same wifi: http://${lan}:${PORT}`);
  console.log(`  you:       http://localhost:${PORT}`);
  console.log('════════════════════════════════════════════════════');
  console.log('  Ctrl+C ends the night (server + tunnel).\n');
};

if (tunnel) {
  // cloudflared prints the quick-tunnel URL on stderr.
  const scan = (chunk) => {
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) announce(m[0]);
  };
  tunnel.stdout.on('data', scan);
  tunnel.stderr.on('data', scan);
  tunnel.on('error', () => fallback());
  setTimeout(() => {
    if (!announced) fallback();
  }, 15000);
} else {
  fallback();
}

function fallback() {
  if (announced) return;
  console.log('\n⚠  No cloudflared tunnel (install: winget install Cloudflare.cloudflared).');
  announce(
    lan ? `http://${lan}:${PORT}  (LAN only)` : `http://localhost:${PORT}  (this machine only)`,
  );
}

const shutdown = () => {
  tunnel?.kill();
  server.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', shutdown);
