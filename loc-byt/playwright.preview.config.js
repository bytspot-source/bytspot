// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Preview config: serves the built app via `vite preview`
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'Mobile Safari', use: { ...devices['iPhone 12'] } },
  ],
  webServer: [
    {
      command: 'npm run build',
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'npm run preview:serve',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});

