import assert from 'node:assert/strict';
import test from 'node:test';
import { WINDOW_INTENTS, setIntentInput } from './windowIntent';

/**
 * The vocabulary a seller may speak.
 *
 * The route refuses the unbuilt words, and the CHECK constraint refuses them
 * again. Two gates on purpose: a careless route must not be able to store a
 * promise the platform cannot keep.
 */

test('a seller may only say what the platform can honour', () => {
  assert.deepEqual([...WINDOW_INTENTS], ['request', 'none']);

  // Built, so sayable.
  assert.equal(setIntentInput.safeParse({ intent: 'request' }).success, true);
  // Declining is sayable, because a gate that can only say yes gates nothing.
  assert.equal(setIntentInput.safeParse({ intent: 'none' }).success, true);
});

test('words whose rail does not exist are refused at the door', () => {
  // Each of these is a real intent a vendor will eventually want. None of them
  // has anything behind it yet, so none may be stored.
  for (const intent of ['book', 'order', 'redirect', 'details']) {
    assert.equal(setIntentInput.safeParse({ intent }).success, false, `${intent} must not be accepted yet`);
  }

  // Nor any near-miss of the one word that works.
  for (const intent of ['REQUEST', 'Request', ' request', '', null, undefined, 1, {}]) {
    assert.equal(setIntentInput.safeParse({ intent }).success, false);
  }
});
