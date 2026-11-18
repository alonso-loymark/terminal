import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  // Keep Rust compiler output visible when running `tauri dev`.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WebView2 is an evergreen Chromium.
    target: 'es2022',
    // xterm + its WebGL renderer are legitimately a few hundred KB.
    chunkSizeWarningLimit: 1024,
  },
});
