import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envDir: '.meeting-master-env',
  envPrefix: 'MEETING_MASTER_PUBLIC_',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: { ignored: ['**/.local/**'] },
  },
  test: {
    environment: 'jsdom',
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/**/*.test.mjs'],
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
