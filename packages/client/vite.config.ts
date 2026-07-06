import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
