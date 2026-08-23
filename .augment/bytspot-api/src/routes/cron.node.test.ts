import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../config';
import { verifyCronSecret } from './cron';

const req = (authorization?: string) => ({ headers: authorization ? { authorization } : {} });

test('An unset cron secret rejects every caller, including one sending nothing', () => {
  const original = config.cronSecret;
  (config as { cronSecret: string }).cronSecret = '';
  try {
    // The regression: an empty expected secret used to match an absent header.
    assert.equal(verifyCronSecret(req()), false);
    assert.equal(verifyCronSecret(req('Bearer ')), false);
    assert.equal(verifyCronSecret(req('Bearer anything')), false);
  } finally {
    (config as { cronSecret: string }).cronSecret = original;
  }
});

test('A configured cron secret admits only the exact token', () => {
  const original = config.cronSecret;
  (config as { cronSecret: string }).cronSecret = 'correct-horse';
  try {
    assert.equal(verifyCronSecret(req('Bearer correct-horse')), true);
    assert.equal(verifyCronSecret(req('Bearer correct-hors')), false);
    assert.equal(verifyCronSecret(req('Bearer correct-horsey')), false);
    assert.equal(verifyCronSecret(req('correct-horse')), false);
    assert.equal(verifyCronSecret(req()), false);
  } finally {
    (config as { cronSecret: string }).cronSecret = original;
  }
});
