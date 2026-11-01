import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesMusicWindow, musicEntry, musicListing, musicSetTimeProblem } from './partyMusic';

const hour = 60 * 60 * 1000;
const base = new Date('2026-11-06T22:00:00Z');
const party = (over: Record<string, unknown> = {}) => ({
  musicKind: 'dj', musicGenres: ['afrobeats'], musicSetStartsAt: null,
  startsAt: base, endsAt: new Date(base.getTime() + 4 * hour), accessMode: 'free-rsvp', audienceCircleIds: [] as string[], ...over,
});
const window = { from: new Date(base.getTime() - 2 * hour).toISOString(), until: new Date(base.getTime() + 8 * hour).toISOString() };

test('A party that is already underway still counts for tonight, one that has ended does not', () => {
  assert.equal(matchesMusicWindow(party({ startsAt: new Date(base.getTime() - 5 * hour), endsAt: new Date(base.getTime() - hour) }), { ...window, from: base.toISOString() }), false);
  assert.equal(matchesMusicWindow(party({ startsAt: new Date(base.getTime() - hour) }), { ...window, from: base.toISOString() }), true);
  // No end time: treated as running six hours, never forever.
  assert.equal(matchesMusicWindow(party({ startsAt: new Date(base.getTime() - 7 * hour), endsAt: null }), { ...window, from: base.toISOString() }), false);
});

test('Kind and genre filters: a party with both kinds answers either', () => {
  assert.equal(matchesMusicWindow(party({ musicKind: 'both' }), { ...window, kinds: ['live'] }), true);
  assert.equal(matchesMusicWindow(party(), { ...window, kinds: ['live'] }), false);
  assert.equal(matchesMusicWindow(party(), { ...window, genres: ['jazz'] }), false);
  assert.equal(matchesMusicWindow(party(), { ...window, genres: ['jazz', 'afrobeats'] }), true);
});

test('Music surfaces are public only and need a declared kind', () => {
  assert.equal(matchesMusicWindow(party({ accessMode: 'private-approval' }), window), false);
  assert.equal(matchesMusicWindow(party({ audienceCircleIds: ['c1'] }), window), false);
  assert.equal(matchesMusicWindow(party({ musicKind: null, musicGenres: [] }), window), false);
  assert.equal(matchesMusicWindow(party({ musicKind: 'karaoke' }), window), false);
});

test('Unknown stored genres are dropped rather than shown', () => {
  assert.deepEqual(musicListing({ musicKind: 'live', musicGenres: ['jazz', 'polka'], musicSetStartsAt: null }), { kind: 'live', genres: ['jazz'], setStartsAt: null });
});

test('The set time must fall inside the Party', () => {
  assert.equal(musicSetTimeProblem(null, party()), null);
  assert.equal(musicSetTimeProblem(base, party()), null);
  assert.match(musicSetTimeProblem(new Date(base.getTime() - 1), party()) ?? '', /before the Party/);
  assert.match(musicSetTimeProblem(new Date(base.getTime() + 4 * hour), party()) ?? '', /before the Party ends/);
});

test('Entry is free unless the host sold paid tickets, and quotes only a real price', () => {
  assert.deepEqual(musicEntry('free-rsvp', []), { kind: 'free', fromCents: null });
  assert.deepEqual(musicEntry('paid-ticket', [{ priceCents: 3000 }, { priceCents: 0 }, { priceCents: 2000 }]), { kind: 'ticket', fromCents: 2000 });
  assert.deepEqual(musicEntry('paid-ticket', 'not-a-list'), { kind: 'ticket', fromCents: null });
});
