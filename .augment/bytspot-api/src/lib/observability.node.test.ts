import test from 'node:test';
import assert from 'node:assert/strict';

import { captureError, initErrorTracking, isErrorTrackingEnabled } from './observability';

test('Error tracking stays off without a DSN, and never blocks boot', () => {
  assert.equal(isErrorTrackingEnabled(), false);
  assert.doesNotThrow(() => initErrorTracking());
});

test('Reporting a failure never becomes a second failure', () => {
  assert.doesNotThrow(() => captureError(new Error('boom'), { route: '/trpc/x', method: 'POST' }));
  assert.doesNotThrow(() => captureError('not an error'));
  assert.doesNotThrow(() => captureError(undefined));
});
