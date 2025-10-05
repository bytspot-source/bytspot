// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Static preview config: no dev server, navigates to file:// URLs
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // No webServer here; tests navigate to file:// URLs directly
});

