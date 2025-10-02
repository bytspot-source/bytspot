// @ts-check
// Playwright config for dashboard E2E. Uses webServer to run the dashboard locally.

/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: 'node index.js',
    env: { PORT: '4173' },
    port: 4173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
};

export default config;

