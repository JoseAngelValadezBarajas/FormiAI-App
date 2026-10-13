import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 90_000,
  use: { baseURL: process.env.FORMIAI_E2E_URL ?? 'http://127.0.0.1:5173', screenshot: 'only-on-failure', video: 'retain-on-failure' },
});
