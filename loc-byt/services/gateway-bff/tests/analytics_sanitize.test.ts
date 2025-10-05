import { describe, it, expect } from 'vitest';
// Import the mobile sanitizer directly
import { sanitizeProps } from '../../../apps/mobile/src/analytics';

describe('analytics sanitizeProps (management-only)', () => {
  it('removes identifiers and sensitive props', () => {
    const out = sanitizeProps({ session_id: 'cs_123', sessionId: 'x', email: 'a@b.com', phone: '123', selected: 'a,b' });
    expect(out).toEqual({});
  });

  it('quantizes coordinates at any depth to ~1.1km (2 decimals)', () => {
    const out = sanitizeProps({ lat: 37.12345, lng: -122.98765, nested: { latitude: 40.12345, longitude: -70.98765 }, place_lat: 10.1299 });
    expect(out).toEqual({ lat: 37.12, lng: -122.99, nested: { latitude: 40.12, longitude: -70.99 }, place_lat: 10.13 });
  });

  it('collapses error strings to reason codes and drops message fields', () => {
    const out = sanitizeProps({ error: 'Timeout while fetching', message: 'detailed message', user_message: 'blah', error_message: 'network down' });
    expect(out).toEqual({ reason: 'network' });
  });

  it('drops any key containing "message" anywhere (camelCase, suffix, nested)', () => {
    const out = sanitizeProps({ systemMessage: 'x', other_message: 'y', nested: { customUserMessage: 'z', keep: 1 }, deep: { SomeMESSAGEField: 'nope' } });
    expect(out).toEqual({ nested: { keep: 1 } });
  });

  it('preserves non-sensitive fields', () => {
    const out = sanitizeProps({ total: 1800, payment_method: 'card_visa', meta: { has_valet: true } });
    expect(out).toEqual({ total: 1800, payment_method: 'card_visa', meta: { has_valet: true } });
  });
});

