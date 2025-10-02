import { test, expect } from '@playwright/test';

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

function sse({ event, data }) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test.describe('Create order flow', () => {
  test('creates order and reacts to SSE update', async ({ page }) => {
    // Stub GET/POST /api/valet/orders
    await page.route(match('/api/valet/orders'), async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 101, status: 'pending' })
        });
      }
      // Return empty active orders initially
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([])
      });
    });

    // Stub SSE stream with created + status updated events
    await page.route(match('/stream'), (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: [
          sse({ event: 'order_created', data: { id: 101, status: 'pending' } }),
          sse({ event: 'order_updated', data: { id: 101, status: 'assigned' } }),
        ].join(''),
      })
    );

    await page.goto('/');

    await page.fill('#make', 'Honda');
    await page.fill('#lat', '33.7000');
    await page.fill('#lng', '-84.4000');
    await page.click('#create');

    await expect(page.getByText('Created order #101')).toBeVisible();
    await expect(page.locator('#events .event')).toContainText(['order_created', 'order_updated']);
  });
});

