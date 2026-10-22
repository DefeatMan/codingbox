import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e', timeout: 120_000, fullyParallel: false, workers: 1,
  expect: { timeout: 15_000 },
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', screenshot: 'only-on-failure', trace: 'retain-on-failure', viewport: { width: 1440, height: 1000 } },
  reporter: 'list',
});
