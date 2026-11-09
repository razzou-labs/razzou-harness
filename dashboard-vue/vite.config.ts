import vueJsx from '@vitejs/plugin-vue-jsx';
import { defineConfig } from 'vite';

// The second dashboard, in Vue and Quasar: built beside the first into dist/web/next, and
// served by the daemon at /next/ (§14.4). Its components are TSX, so tsc checks them.
export default defineConfig({
  root: import.meta.dirname,
  base: '/next/',
  plugins: [vueJsx()],
  define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  // One bundle, served from localhost: its size doesn't matter. The licenses of the
  // libraries bundled into it ship beside it, as their licenses require.
  build: { outDir: '../dist/web/next', emptyOutDir: true, chunkSizeWarningLimit: 4000, license: { fileName: 'THIRD-PARTY-LICENSES.md' } },
});
