import { describe, it, expect } from 'vitest';
import '../server.js';

const app = globalThis.__bff_app;

describe('Docs & OpenAPI endpoints', () => {
  it('serves bff-valet.yaml', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi/bff-valet.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/yaml/);
    expect(res.body).toMatch(/openapi:\s*3\.0\.3/);
  });
  it('serves upstream-valet.yaml', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi/upstream-valet.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/openapi:\s*3\.0\.3/);
  });
  it('serves Redoc HTML for BFF and Upstream', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/docs/bff-valet' });
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['content-type']).toMatch(/text\/html/);
    expect(res1.body).toMatch(/Redoc.init/);
    const res2 = await app.inject({ method: 'GET', url: '/docs/upstream-valet' });
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toMatch(/Redoc.init/);
  });
  it('serves Swagger UI for BFF and Upstream', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/swagger/bff-valet' });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['content-type']).toMatch(/text\/html/);
    expect(r1.body).toMatch(/SwaggerUIBundle/);
    const r2 = await app.inject({ method: 'GET', url: '/swagger/upstream-valet' });
    expect(r2.statusCode).toBe(200);
    expect(r2.body).toMatch(/SwaggerUIBundle/);
  });
  it('serves docs landing page with links', async () => {
    const r = await app.inject({ method: 'GET', url: '/docs' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toMatch(/\/docs\/bff-valet/);
    expect(r.body).toMatch(/\/docs\/upstream-valet/);
    expect(r.body).toMatch(/\/swagger\/bff-valet/);
    expect(r.body).toMatch(/\/swagger\/upstream-valet/);
  });


});

