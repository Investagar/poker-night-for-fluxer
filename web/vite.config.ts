import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    license: { fileName: 'third-party-licenses.md' },
    rolldownOptions: {
      output: {
        postBanner: () => `/*!\n${readFileSync(new URL('../LICENSE', import.meta.url), 'utf8').trimEnd()}\n\nBundled dependency licenses: /third-party-licenses.md\n*/`,
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/auth': backend,
      '/api': backend,
      '/ws': { target: backend, ws: true },
    },
  },
});
