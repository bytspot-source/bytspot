const { test } = require('@playwright/test');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

// Quick static preview of the landing page without running a dev server
// Produces screenshots under loc-byt/screenshots

test('Preview static landing HTML (full page)', async ({ page }) => {
  const filePath = path.resolve(__dirname, '..', 'voice-landing-preview.html');
  const url = pathToFileURL(filePath).toString();

  // Ensure screenshots directory exists
  const shotsDir = path.resolve(__dirname, '..', 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);

  await page.screenshot({ path: path.join(shotsDir, 'static-preview-full.png'), fullPage: true });
});

// Optional: Mobile-sized snapshot for iOS-like view

test('Preview static landing HTML (iPhone width)', async ({ page }) => {
  const filePath = path.resolve(__dirname, '..', 'voice-landing-preview.html');
  const url = pathToFileURL(filePath).toString();

  const shotsDir = path.resolve(__dirname, '..', 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);

  await page.screenshot({ path: path.join(shotsDir, 'static-preview-iphone.png'), fullPage: true });
});


// Optional: Tablet-sized snapshot

test('Preview static landing HTML (iPad portrait)', async ({ page }) => {
  const filePath = path.resolve(__dirname, '..', 'voice-landing-preview.html');
  const url = pathToFileURL(filePath).toString();

  const shotsDir = path.resolve(__dirname, '..', 'screenshots');
  fs.mkdirSync(shotsDir, { recursive: true });

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(url);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);

  await page.screenshot({ path: path.join(shotsDir, 'static-preview-tablet.png'), fullPage: true });
});
