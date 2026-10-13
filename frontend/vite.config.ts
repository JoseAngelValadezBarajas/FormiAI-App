import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': process.env.FORMIAI_API_TARGET || 'http://127.0.0.1:8000' } },
  test: { exclude: ['e2e/**', 'node_modules/**'] },
});
