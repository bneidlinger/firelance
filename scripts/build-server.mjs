import { build } from 'esbuild';

// Bundle the authoritative server into a single ESM file (dist/server.mjs).
// - tsconfig paths resolve @shared/* and @bots/* into the bundle
// - `ws` is bundled too (pure JS); its OPTIONAL native accelerators stay
//   external — ws falls back to JS implementations when they're absent
// - the createRequire banner lets bundled CJS (ws) require node builtins
//   from ESM output — without it the bundle throws "Dynamic require of
//   'events' is not supported" at startup
await build({
  entryPoints: ['packages/server/src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  tsconfig: 'tsconfig.base.json',
  external: ['bufferutil', 'utf-8-validate'],
  outfile: 'dist/server.mjs',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
