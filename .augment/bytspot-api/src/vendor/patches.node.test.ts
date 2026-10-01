import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePatchCode, patchInput, patchInputBlockers, patchKind, patchUrl, toPatchDto } from './patches';

test('a patch code reads the same typed in any case, with spaces or dashes', () => {
  assert.equal(normalizePatchCode('abcd-2345'), 'ABCD2345');
  assert.equal(normalizePatchCode(' AB CD 23 45 '), 'ABCD2345');
  assert.equal(normalizePatchCode('ABCD0123'), undefined, 'codes never contain 0 or 1');
  assert.equal(normalizePatchCode('ABC'), undefined);
  assert.equal(normalizePatchCode(42), undefined);
});

test('the printed link is the guest app with the code on the end', () => {
  assert.match(patchUrl('ABCD2345'), /^https:\/\/[^/]+\/at\/ABCD2345$/);
});

test('anything that is not a partner link is a patch', () => {
  assert.equal(patchKind('partner'), 'partner');
  assert.equal(patchKind('PARTNER'), 'patch');
  assert.equal(patchKind(undefined), 'patch');
});

test('a partner link must name the partner; a patch needs only a place and a label', () => {
  const partner = patchInput.parse({ kind: 'partner', locationId: 'loc_1', label: 'Front desk' });
  assert.deepEqual(patchInputBlockers(partner), ['Name the partner']);
  const patch = patchInput.parse({ locationId: 'loc_1', label: 'Front door' });
  assert.equal(patch.kind, 'patch');
  assert.deepEqual(patchInputBlockers(patch), []);
  assert.equal(patchInput.safeParse({ locationId: 'loc_1', label: '' }).success, false);
});

test('a patch is shown with its place, its service, and what it brought in', () => {
  const dto = toPatchDto(
    {
      id: 'pat_1',
      sellerId: 'sel_1',
      locationId: 'loc_1',
      windowId: 'win_1',
      code: 'ABCD2345',
      kind: 'partner',
      label: 'Front desk',
      partnerName: 'Hotel Indigo',
      scans: 12,
      lastScannedAt: new Date('2026-10-01T20:00:00Z'),
      createdAt: new Date('2026-09-30T12:00:00Z'),
      createdBySeatId: 'seat_1',
      archivedAt: null,
      location: { label: 'Main room' },
      window: { skuTemplateId: 'dining.table', title: 'Chef counter', durationMins: null },
    },
    { asks: 3, bookings: 2, bookedCents: 9000 },
  );
  assert.equal(dto.place, 'Main room');
  assert.equal(dto.service, 'Chef counter');
  assert.equal(dto.partnerName, 'Hotel Indigo');
  assert.equal(dto.url.endsWith('/at/ABCD2345'), true);
  assert.deepEqual([dto.scans, dto.asks, dto.bookings, dto.bookedCents], [12, 3, 2, 9000]);
});
