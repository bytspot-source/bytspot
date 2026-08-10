import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createCallerFactory } from './trpc';
import { appRouter } from './router';
import { db } from '../lib/db';
import type { Context } from './context';

const idempotencyKey = '00000000-0000-4000-8000-000000000001';
const draftInput = {
  idempotencyKey,
  templateId: 'listening-party' as const,
  title: 'First Listen',
  tagline: 'One moment. Your people.',
  startsAt: '2026-08-10T20:00:00Z',
  venueName: 'The Loft',
  locationDisclosure: 'public' as const,
  capacity: 80,
  accessMode: 'free-rsvp' as const,
  requiredMembershipTier: 'green' as const,
  hostDestinations: { musicUrl: 'https://music.example.com/host' },
  audienceCircleIds: ['circle-1'],
  itinerary: [{ title: 'Doors open', offsetMinutes: 0 }],
  ticketTiers: [],
  cohosts: [],
  templateConfig: { kind: 'listening-party' as const, format: 'listening-session' },
  source: 'host-studio' as const,
};
const partyDraft = { id: 'party-1', hostUserId: 'test-user-id', idempotencyKey, status: 'draft' };
const createCaller = createCallerFactory(appRouter);
const authenticatedContext: Context = { user: { userId: 'test-user-id', email: 'test@bytspot.com' } };
const party = db.party as any;
const partyMedia = db.partyMedia as any;
const partyGuest = db.partyGuest as any;
const prisma = db as any;

function caller() {
  return createCaller(authenticatedContext);
}

beforeEach(() => {
  party.findUnique = async () => null;
  party.findFirst = async () => null;
  party.create = async () => ({ id: 'party-1' });
  party.updateMany = async () => ({ count: 1 });
  partyMedia.deleteMany = async () => ({ count: 0 });
  partyMedia.upsert = async () => ({ id: 'media-1' });
  partyMedia.findUnique = async () => null;
  partyGuest.count = async () => 0;
  prisma.$transaction = async (callback: any) => callback({ party, partyMedia });
});

test('Party draft creation requires authentication', async () => {
  const publicCaller = createCaller({ user: null });
  await assert.rejects(() => publicCaller.events.drafts.create(draftInput), { code: 'UNAUTHORIZED' });
});

test('Party draft creation persists the authenticated host and refreshes a retryable draft', async () => {
  let createData: any;
  party.create = async ({ data }: any) => {
    createData = data;
    return { id: 'party-1' };
  };
  assert.deepEqual(await caller().events.drafts.create(draftInput), { id: 'party-1' });
  assert.equal(createData.hostUserId, 'test-user-id');
  assert.equal(createData.idempotencyKey, idempotencyKey);
  assert.equal(createData.locationDisclosure, 'public');
  assert.deepEqual(createData.hostDestinations, { musicUrl: 'https://music.example.com/host' });

  party.findUnique = async () => partyDraft;
  party.create = async () => { throw new Error('must not create duplicate draft'); };
  let updated: any;
  party.updateMany = async ({ data }: any) => {
    updated = data;
    return { count: 1 };
  };
  assert.deepEqual(await caller().events.drafts.create({ ...draftInput, title: 'Edited First Listen' }), { id: 'party-1' });
  assert.equal(updated.title, 'Edited First Listen');
});

test('Draft retries do not update content after publishing wins the race', async () => {
  const publishedParty = { ...partyDraft, status: 'published', passCode: 'BYT-EXISTING' };
  party.findUnique = async () => partyDraft;
  party.updateMany = async () => ({ count: 0 });
  party.findFirst = async () => publishedParty;

  assert.deepEqual(await caller().events.drafts.create({ ...draftInput, title: 'Too Late To Change' }), { id: 'party-1' });
});

test('Party draft creation accepts iOS standard templates and Black tier', async () => {
  await assert.doesNotReject(() => caller().events.drafts.create({
    ...draftInput, templateId: 'comedy-night', requiredMembershipTier: 'black', templateConfig: { kind: 'standard' },
  }));
  await assert.doesNotReject(() => caller().events.drafts.create({
    ...draftInput, templateId: 'premiere', templateConfig: { kind: 'standard' },
  }));
});

test('Party draft creation accepts withheld locations and rejects insecure official destinations', async () => {
  await assert.doesNotReject(() => caller().events.drafts.create({
    ...draftInput, locationDisclosure: 'withheld', templateId: 'comedy-night', templateConfig: { kind: 'standard' },
  }));
  await assert.rejects(() => caller().events.drafts.create({
    ...draftInput, hostDestinations: { websiteUrl: 'http://not-secure.example.com' },
  }));
  await assert.rejects(() => caller().events.drafts.create({
    ...draftInput, locationDisclosure: 'after-approval', accessMode: 'free-rsvp',
  }));
});

test('Public Party invitations redact protected venues and project only official destinations', async () => {
  party.findFirst = async () => ({
    id: 'party-1', title: 'Secret Set', tagline: 'See you there.', templateId: 'pop-up', requiredMembershipTier: 'black',
    startsAt: new Date('2026-08-10T20:00:00Z'), venueName: 'Never Return This Venue', locationDisclosure: 'withheld',
    accessMode: 'paid-ticket', capacity: 40, hostDestinations: { musicUrl: 'https://music.example.com/host', primarySocial: { platform: 'Instagram', url: 'https://instagram.com/host' } },
    itinerary: [{ title: 'Doors', offsetMinutes: 0 }], ticketTiers: [{ name: 'First Drop', priceCents: 2500, quantity: 40, requiredMembershipTier: 'green' }],
    host: { name: 'Host' }, media: [],
  });
  const invite = await createCaller({ user: null }).events.invite({ partyId: 'party-1' });
  assert.equal(invite.locationDisclosure, 'withheld');
  assert.equal(invite.locationLabel, null);
  assert.deepEqual(invite.host.destinations, { musicUrl: 'https://music.example.com/host', primarySocial: { platform: 'Instagram', url: 'https://instagram.com/host' } });
});

test('Party draft creation rejects mismatched template configuration', async () => {
  await assert.rejects(() => caller().events.drafts.create({
    ...draftInput,
    templateConfig: { kind: 'standard' as const },
  }));
});

test('Party media reset and upload require a host-owned draft', async () => {
  party.findFirst = async () => partyDraft;
  let resetPartyId = '';
  partyMedia.deleteMany = async ({ where }: any) => {
    resetPartyId = where.partyId;
    return { count: 1 };
  };
  assert.deepEqual(await caller().events.media.reset({ partyId: 'party-1' }), { status: 'ready' });
  assert.equal(resetPartyId, 'party-1');

  let uploaded: any;
  partyMedia.upsert = async (input: any) => {
    uploaded = input;
    return { id: 'media-1' };
  };
  assert.deepEqual(await caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:image/jpeg;base64,/9j/',
  }), { url: 'https://bytspot-api.onrender.com/media/parties/media-1' });
  assert.equal(uploaded.create.mimeType, 'image/jpeg');
  assert.equal(uploaded.create.byteSize, 3);
});

test('Party media upload rejects unsupported, mislabeled, and non-owner content', async () => {
  party.findFirst = async () => partyDraft;
  await assert.rejects(() => caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:text/plain;base64,QUJD',
  }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:image/jpeg;base64,QUJD',
  }), { code: 'BAD_REQUEST' });

  party.findFirst = async () => null;
  party.updateMany = async () => ({ count: 0 });
  await assert.rejects(() => caller().events.media.reset({ partyId: 'party-1' }), { code: 'NOT_FOUND' });
});

test('Party publishing atomically produces one allowed share link and pass code', async () => {
  party.findFirst = async () => partyDraft;
  let updateWhere: any;
  party.updateMany = async ({ where }: any) => {
    updateWhere = where;
    return { count: 1 };
  };
  const result = await caller().events.publish({ partyId: 'party-1', idempotencyKey });
  assert.equal(result.id, 'party-1');
  assert.equal(result.shareUrl, 'https://bytspot.app/party/party-1');
  assert.match(result.passCode, /^BYT-[A-F0-9]{10}$/);
  assert.deepEqual(updateWhere, { id: 'party-1', hostUserId: 'test-user-id', status: 'draft' });
});

test('A concurrent publish returns the already-issued Party Pass', async () => {
  let calls = 0;
  party.findFirst = async () => {
    calls += 1;
    return calls === 1 ? partyDraft : { ...partyDraft, status: 'published', passCode: 'BYT-EXISTING' };
  };
  party.updateMany = async () => ({ count: 0 });
  assert.deepEqual(await caller().events.publish({ partyId: 'party-1', idempotencyKey }), {
    id: 'party-1', shareUrl: 'https://bytspot.app/party/party-1', passCode: 'BYT-EXISTING',
  });
});

test('A complete iOS retry returns a published Party Pass without changing media', async () => {
  const publishedParty = { ...partyDraft, status: 'published', passCode: 'BYT-EXISTING' };
  party.findUnique = async () => publishedParty;
  party.findFirst = async () => publishedParty;
  party.updateMany = async () => ({ count: 0 });
  partyMedia.findUnique = async () => ({ id: 'media-1' });
  let deleteCalls = 0;
  let upsertCalls = 0;
  partyMedia.deleteMany = async () => {
    deleteCalls += 1;
    return { count: 0 };
  };
  partyMedia.upsert = async () => {
    upsertCalls += 1;
    return { id: 'media-1' };
  };

  assert.deepEqual(await caller().events.drafts.create(draftInput), { id: 'party-1' });
  assert.deepEqual(await caller().events.media.reset({ partyId: 'party-1' }), { status: 'published' });
  assert.deepEqual(await caller().events.media.upload({
    partyId: 'party-1', kind: 'cover', dataUri: 'data:image/jpeg;base64,/9j/',
  }), { url: 'https://bytspot-api.onrender.com/media/parties/media-1' });
  assert.deepEqual(await caller().events.publish({ partyId: 'party-1', idempotencyKey }), {
    id: 'party-1', shareUrl: 'https://bytspot.app/party/party-1', passCode: 'BYT-EXISTING',
  });
  assert.equal(deleteCalls, 0);
  assert.equal(upsertCalls, 0);
});

test('Party publishing retries a pass-code uniqueness collision', async () => {
  party.findFirst = async () => partyDraft;
  let attempts = 0;
  party.updateMany = async () => {
    attempts += 1;
    if (attempts === 1) throw { code: 'P2002' };
    return { count: 1 };
  };
  const result = await caller().events.publish({ partyId: 'party-1', idempotencyKey });
  assert.match(result.passCode, /^BYT-[A-F0-9]{10}$/);
  assert.equal(attempts, 2);
});