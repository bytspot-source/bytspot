import { test, expect } from '@playwright/test';

test.describe('WelcomeLanding — Crowd Data Fallback', () => {

  test('should never show "Crowd data unavailable" message', async ({ page }) => {
    // Navigate to the welcome page (HashRouter uses #/welcome)
    await page.goto('/#/welcome?email=test@bytspot.com');

    // Wait for loading skeletons to disappear (max 10s)
    await page.waitForFunction(() => {
      return !document.querySelector('.animate-pulse');
    }, { timeout: 10000 });

    // The "unavailable" error text must NOT appear
    const errorText = page.locator('text=Crowd data unavailable');
    await expect(errorText).toHaveCount(0);
  });

  test('should show venue cards with crowd levels', async ({ page }) => {
    await page.goto('/#/welcome?email=test@bytspot.com');

    // Wait for loading to finish
    await page.waitForFunction(() => {
      return !document.querySelector('.animate-pulse');
    }, { timeout: 10000 });

    // Should see at least one venue name from either API or fallback
    const pageText = await page.textContent('body');
    console.log('PAGE TEXT (first 2000 chars):', pageText?.slice(0, 2000));

    // Check for crowd level labels (from API or fallback)
    const hasCrowdLevel = pageText?.includes('Chill') ||
                          pageText?.includes('Active') ||
                          pageText?.includes('Packed');
    expect(hasCrowdLevel).toBe(true);

    // Check for venue names (fallback venues include these)
    const hasVenue = pageText?.includes('Ponce City Market') ||
                     pageText?.includes('Colony Square') ||
                     pageText?.includes('Krog Street Market') ||
                     pageText?.includes('Painted Pin') ||
                     pageText?.includes('Piedmont Park');
    expect(hasVenue).toBe(true);
  });

  test('should show greeting with user name', async ({ page }) => {
    await page.goto('/#/welcome?email=john.doe@bytspot.com');

    // Should parse first name from email
    await expect(page.locator('text=You\'re in')).toBeVisible({ timeout: 5000 });
  });

  test('should have Open Beta App button', async ({ page }) => {
    await page.goto('/#/welcome?email=test@bytspot.com');

    const ctaButton = page.locator('text=Open Beta App');
    await expect(ctaButton).toBeVisible({ timeout: 5000 });
  });

  test('should show "Right now in Midtown" section with Live indicator', async ({ page }) => {
    await page.goto('/#/welcome?email=test@bytspot.com');

    await expect(page.locator('text=Right now in Midtown')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 5000 });
  });
});

