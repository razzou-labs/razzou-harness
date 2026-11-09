import vueJsx from '@vitejs/plugin-vue-jsx';
import { defineConfig } from 'vite';

// The dashboard, in Vue and Quasar: built into dist/web, which the daemon serves (§14.4).
// Its components are TSX, so tsc checks them.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [vueJsx()],
  define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  // One bundle, served from localhost: its size doesn't matter. The licenses of the
  // libraries bundled into it ship beside it, as their licenses require.
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 4000, license: { fileName: 'THIRD-PARTY-LICENSES.md' } },
});
