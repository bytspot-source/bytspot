const { test, expect } = require('@playwright/test');

test.describe('Bytspot Landing Page', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the landing page
    await page.goto('/');
    
    // Wait for the page to be fully loaded
    await page.waitForLoadState('networkidle');
    
    // Wait for animations to settle
    await page.waitForTimeout(2000);
  });

  test('landing page smoke and full screenshot', async ({ page }) => {
    await page.screenshot({ path: 'screenshots/landing-page-full.png', fullPage: true });
    await expect(page.locator('text=Bytspot')).toBeVisible();
    await expect(page.locator('text=Start Matching')).toBeVisible();
    await expect(page.locator('input[placeholder^="Search"]')).toBeVisible();
  });

  test('top header present', async ({ page }) => {
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
    await nav.screenshot({ path: 'screenshots/navigation.png' });
    await expect(page.locator('text=Bytspot')).toBeVisible();
  });

  test('should capture navigation section', async ({ page }) => {
    // Take screenshot of navigation
    const nav = page.locator('nav');
    await nav.screenshot({ path: 'screenshots/navigation.png' });

    // Test navigation interactions
    await expect(page.locator('text=Bytspot')).toBeVisible();
  });

  test('should capture hero section with search', async ({ page }) => {
    // Take screenshot of hero section
    const heroSection = page.locator('div.max-w-3xl').nth(1); // Second max-w-3xl div is hero
    await heroSection.screenshot({ path: 'screenshots/hero-section.png' });

    // Test search functionality
    const searchInput = page.locator('input[placeholder^="Search"]');
    await searchInput.fill('downtown parking');
    await searchInput.screenshot({ path: 'screenshots/search-filled.png' });
    
    // Test search button
    const findButton = page.locator('text=Find');
    await expect(findButton).toBeVisible();
  });

  test('should capture statistics section', async ({ page }) => {
    // Scroll to stats section
    await page.locator('text=50K+').scrollIntoViewIfNeeded();
    
    // Take screenshot of statistics
    const statsSection = page.locator('div:has-text("50K+"):has-text("1.2M+"):has-text("4.9★")').first();
    await statsSection.screenshot({ path: 'screenshots/statistics.png' });
  });

  test('should capture features section', async ({ page }) => {
    // Scroll to features section
    await page.locator('text=Smart Parking').scrollIntoViewIfNeeded();
    
    // Take screenshot of features
    const featuresSection = page.locator('div:has-text("Smart Parking"):has-text("Venue Discovery"):has-text("Premium Services")').first();
    await featuresSection.screenshot({ path: 'screenshots/features.png' });

    // Test hover effects on feature cards
    const smartParkingCard = page.locator('text=Smart Parking').locator('..').locator('..');
    await smartParkingCard.hover();
    await page.waitForTimeout(500);
    await smartParkingCard.screenshot({ path: 'screenshots/smart-parking-hover.png' });
  });

  test('should capture call-to-action section', async ({ page }) => {
    // Scroll to CTA
    await page.locator('text=Start Matching').scrollIntoViewIfNeeded();
    
    // Take screenshot of CTA
    const ctaSection = page.locator('text=Start Matching').locator('..');
    await ctaSection.screenshot({ path: 'screenshots/cta-section.png' });

    // Test CTA button hover
    const startButton = page.locator('text=Start Matching');
    await startButton.hover();
    await page.waitForTimeout(500);
    await startButton.screenshot({ path: 'screenshots/start-matching-hover.png' });
  });

  test('should capture footer section', async ({ page }) => {
    // Scroll to footer
    await page.locator('text=© 2025 Bytspot').scrollIntoViewIfNeeded();
    
    // Take screenshot of footer
    const footer = page.locator('footer');
    await footer.screenshot({ path: 'screenshots/footer.png' });
  });

  test('should test responsive design on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(1000);
    
    // Take mobile screenshot
    await page.screenshot({ 
      path: 'screenshots/landing-page-mobile.png', 
      fullPage: true 
    });

    // Verify mobile layout
    await expect(page.locator('text=Bytspot')).toBeVisible();
    await expect(page.locator('text=Start Matching')).toBeVisible();
  });

  test('should test responsive design on tablet', async ({ page }) => {
    // Set tablet viewport
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(1000);
    
    // Take tablet screenshot
    await page.screenshot({ 
      path: 'screenshots/landing-page-tablet.png', 
      fullPage: true 
    });
  });

  test('should test dark theme consistency', async ({ page }) => {
    // Take screenshot focusing on dark theme elements
    await page.screenshot({ 
      path: 'screenshots/dark-theme-full.png', 
      fullPage: true 
    });

    // Verify dark theme colors are applied
    const body = page.locator('body');
    const backgroundColor = await body.evaluate(el => getComputedStyle(el).backgroundColor);
    console.log('Background color:', backgroundColor);
  });

  test('should test interactive elements', async ({ page }) => {
    // Test search input interaction
    const searchInput = page.locator('input[placeholder^="Search"]');
    await searchInput.click();
    await searchInput.fill('test search query');
    await page.screenshot({ path: 'screenshots/search-interaction.png' });

    // Hover Start Matching CTA
    const startButton = page.locator('text=Start Matching');
    await startButton.hover();
    await page.waitForTimeout(300);
    await startButton.screenshot({ path: 'screenshots/start-matching-hover-2.png' });
  });
});
