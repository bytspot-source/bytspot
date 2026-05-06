import { describe, expect, it } from 'vitest';
import { isAllowedCorsOrigin, parseCorsOrigins } from './cors';

describe('CORS helpers', () => {
  it('includes local preview and Capacitor origins by default', () => {
    const origins = parseCorsOrigins('https://bytspot.com', 'https://beta.bytspot.com');

    expect(origins).toContain('http://localhost:3000');
    expect(origins).toContain('http://127.0.0.1:3000');
    expect(origins).toContain('http://127.0.0.1:4173');
    expect(origins).toContain('http://localhost:4173');
    expect(origins).toContain('capacitor://localhost');
    expect(origins).toContain('https://bytspot-beta-app.onrender.com');
    expect(origins).toContain('https://bytspot.app');
    expect(origins).toContain('https://www.bytspot.app');
    expect(origins).toContain('https://bytspot.com');
    expect(origins).toContain('https://beta.bytspot.com');
  });

  it('deduplicates repeated origins', () => {
    const origins = parseCorsOrigins('https://bytspot.com, https://bytspot.com', 'https://bytspot.com');
    expect(origins.filter((origin) => origin === 'https://bytspot.com')).toHaveLength(1);
  });

  it('allows requests without an Origin header', () => {
    expect(isAllowedCorsOrigin(undefined, ['https://bytspot.com'])).toBe(true);
  });

  it('allows configured origins and rejects unknown ones', () => {
    const allowedOrigins = parseCorsOrigins('https://bytspot.com');
    expect(isAllowedCorsOrigin('http://127.0.0.1:4173', allowedOrigins)).toBe(true);
    expect(isAllowedCorsOrigin('https://evil.example', allowedOrigins)).toBe(false);
  });
});
