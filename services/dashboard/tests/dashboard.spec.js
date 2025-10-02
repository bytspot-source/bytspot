import { test, expect } from '@playwright/test';

// Utility to stub API responses by URL pathname and query
function match(pathname) {
  return (url) => {
    try {
      const u = typeof url === 'string' ? new URL(url) : url;
      return u.pathname === pathname;
    } catch {
      return false;
    }
  };
}

// Simple SSE payload helper
function sse({ event, data }) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test.describe('Dashboard smoke', () => {
  test('loads, shows active orders, view events, and receives stream', async ({ page }) => {
    // Intercept active orders
    await page.route(match('/api/valet/orders'), async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get('status') === 'active') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 1, status: 'pending', pickup_lat: 33.7488, pickup_lng: -84.3877 },
            { id: 2, status: 'assigned', pickup_lat: 33.75, pickup_lng: -84.39 },
          ]),
        });
      }
      return route.continue();
    });

    // Intercept order events for #1
    await page.route(match('/api/valet/orders/1/events'), (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 11, type: 'assigned', payload: { driver: 'Sam' }, created_at: '2025-01-01T00:00:00Z' },
          { id: 10, type: 'pending', payload: {}, created_at: '2025-01-01T00:00:00Z' },
        ]),
      })
    );

    // Intercept SSE stream with a single event
    await page.route(match('/stream'), (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          sse({ event: 'order_created', data: { id: 3, status: 'pending' } }),
          sse({ event: 'order_updated', data: { id: 1, status: 'en_route' } }),
        ].join(''),
      })
    );

    // Go to dashboard
    await page.goto('/');

    // Orders list populated
    await expect(page.getByText('2 active')).toBeVisible();
    const items = page.locator('#orders li');
    await expect(items).toHaveCount(2);

    // View order #1 events
    await page.getByRole('button', { name: 'View' }).first().click();
    await expect(page.getByText('#1')).toBeVisible();
    await expect(page.getByText('assigned')).toBeVisible();

    // Live stream area shows messages
    await expect(page.locator('#events .event')).toHaveCount(2);
  });
});

