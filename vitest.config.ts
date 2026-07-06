import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./packages/shared/src', import.meta.url)),
      '@bots': fileURLToPath(new URL('./packages/bots/src', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/server/test/**/*.test.ts'],
    environment: 'node',
  },
});
