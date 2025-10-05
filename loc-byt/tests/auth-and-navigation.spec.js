const { test, expect } = require('@playwright/test');

// This test drives a minimal auth + registration to reach discovery,
// then verifies bottom nav + MapMenuSlideUp + Insider routing.

test.describe('Auth ➜ Registration ➜ Discovery ➜ Footer Nav', () => {
  test.beforeEach(async ({ page, context }) => {
    // Skip splash quickly
    await context.addInitScript(() => {
      try { localStorage.setItem('bytspot_seen_splash', 'true'); } catch {}
    });
  });

  test('happy path to discovery and nav actions', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Landing smoke
    await expect(page.locator('text=Start Matching')).toBeVisible();

    // Go to auth
    await page.getByText('Start Matching', { exact: true }).click();

    // Auth modal visible
    await expect(page.getByText('Welcome Back')).toBeVisible();

    // Continue with phone (SMS)
    await page.getByRole('button', { name: 'Continue with phone (SMS)' }).click();

    // Enter phone and send code
    await page.getByLabel('Phone number').fill('+14155550131');
    await page.getByRole('button', { name: 'Send Code' }).click();

    // Enter OTP and verify
    await page.getByLabel('Verification code').fill('123456');
    await page.getByRole('button', { name: 'Verify & Continue' }).click();

    // Registration: grant required Location permission
    await expect(page.getByText('Location Services')).toBeVisible();
    await page.getByRole('button', { name: 'Grant Permission' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Notifications (optional): just continue
    await expect(page.getByText('Push Notifications')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Camera (optional): just continue
    await expect(page.getByText('Camera Access')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Preferences: pick one and Start Discovering
    await expect(page.getByText('What interests you?')).toBeVisible();
    await page.getByText('Smart Parking').click();
    await page.getByRole('button', { name: 'Start Discovering' }).click();

    // We should land on discovery and see the footer nav
    const footerNav = page.locator('nav[aria-label="Main navigation"]');
    await expect(footerNav).toBeVisible();

    // Open Insider via footer
    await page.getByRole('button', { name: 'Open insider analytics' }).click();
    await expect(page.getByTestId('insider-page')).toBeVisible();

    // Open Map menu via footer (requires location permission)
    await page.getByRole('button', { name: 'Open map view' }).click();

    // Map slide-up sheet: pick Smart Parking to go to Map
    await page.getByText(/Smart Parking/i).first().click();

    // Expect we've navigated to map page
    await expect(page.getByTestId('map-page')).toBeVisible();
  });
});

