import { defineConfig } from '@playwright/test';

// Frontend-only: Vite serves the app, every /api request is answered by the test, and the proxy target
// is an unroutable port so nothing can reach a backend or the research root even by mistake.
export default defineConfig({
  testDir: '.', testMatch: 'sync.spec.ts', timeout: 60_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5199' },
  webServer: {
    command: 'npx vite --port 5199 --strictPort --host 127.0.0.1',
    cwd: '..', url: 'http://127.0.0.1:5199', reuseExistingServer: false,
    env: { FORMIAI_API_TARGET: 'http://127.0.0.1:9' },
  },
  outputDir: '../test-results/sync-run',
});
