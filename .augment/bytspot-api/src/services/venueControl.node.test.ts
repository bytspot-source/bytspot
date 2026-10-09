import assert from 'node:assert/strict';
import { test } from 'node:test';
import { venueControl } from './venueControl';

test('only a team-approved venue is Bytspot-controlled; anything else is listed', () => {
  assert.equal(venueControl({ controlledAt: new Date('2026-10-01T12:00:00Z') }), 'bytspot');
  assert.equal(venueControl({ controlledAt: '2026-10-01T12:00:00.000Z' }), 'bytspot');
  assert.equal(venueControl({ controlledAt: null }), 'listed');
  assert.equal(venueControl({ controlledAt: undefined }), 'listed');
  assert.equal(venueControl({}), 'listed');
  assert.equal(venueControl({ controlledAt: '' }), 'listed');
  assert.equal(venueControl({ controlledAt: new Date('not a date') }), 'listed');
});
