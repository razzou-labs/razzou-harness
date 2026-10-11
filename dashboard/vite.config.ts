import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built into the package, and served by the daemon from dist/web (§14.4).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  // One bundle, served from localhost: its size doesn't matter. The licenses of the
  // libraries bundled into it ship beside it, as their licenses require.
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 2000, license: { fileName: 'THIRD-PARTY-LICENSES.md' } },
});
