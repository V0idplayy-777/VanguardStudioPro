import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// When running behind the Arena/E2B preview proxy the dev server is reached over
// https on port 443, so the HMR client has to be told to connect there.
const behindProxy = process.env.VSP_PROXY === '1';

export default defineConfig({
  // Relative base so the same build works at a domain root, under a GitHub Pages
  // project path (/<repo>/), or opened from any sub-folder.
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: behindProxy ? { clientPort: 443, protocol: 'wss' } : undefined,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
});
