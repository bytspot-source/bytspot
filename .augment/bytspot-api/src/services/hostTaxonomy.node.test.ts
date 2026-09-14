import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostCategoryIds, hostDiscoveryTags, hostTypeDefinition, hostTypeIds } from './hostTaxonomy';

test('HOST discovery uses the same recognized pairs as write validation', () => {
  assert.equal(hostTypeIds.length, 32);
  assert.equal(hostCategoryIds.length, 10);
  for (const hostType of hostTypeIds) {
    const definition = hostTypeDefinition(hostType);
    assert.ok(definition);
    assert.deepEqual(hostDiscoveryTags({ hostType, hostCategory: definition.category, unrelated: 'omit' }), {
      hostType, hostCategory: definition.category,
    });
  }
});

test('shared taxonomy preserves approval-only and public door rules', () => {
  const restricted = new Set(['house', 'rooftop-party', 'pool', 'birthday', 'garage-meet']);
  for (const hostType of hostTypeIds) {
    assert.deepEqual(hostTypeDefinition(hostType)?.doors, restricted.has(hostType)
      ? ['private-approval'] : ['free-rsvp', 'paid-ticket', 'private-approval']);
  }
});

test('prototype keys and inherited or malformed tags never become discovery metadata', () => {
  for (const hostType of ['toString', 'constructor', '__proto__', 'valueOf', '', null, [], 42]) {
    assert.equal(hostTypeDefinition(hostType), undefined);
    assert.deepEqual(hostDiscoveryTags({ hostType, hostCategory: 'social' }), {});
  }
  assert.deepEqual(hostDiscoveryTags(Object.create({ hostType: 'meetup', hostCategory: 'social' })), {});
  for (const config of [null, undefined, [], 'meetup', 42, {},
    { hostType: 'meetup' }, { hostCategory: 'social' },
    { hostType: 'workshop', hostCategory: 'social' },
    { hostType: 'meetup', hostCategory: null },
    { hostType: 'Meetup', hostCategory: 'social' },
  ]) assert.deepEqual(hostDiscoveryTags(config), {});
});
