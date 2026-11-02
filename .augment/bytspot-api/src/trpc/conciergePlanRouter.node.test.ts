import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config';
import { createEngine } from '../bytt-si/engine';
import { FakeProvider } from '../bytt-si/llm/fake';
import { createFakePorts } from '../bytt-si/testing/fakePorts';
import { discoverBoth, fridayIntent, fridaySelection } from '../bytt-si/testing/helpers';
import { createBackendEngine } from '../bytt-si/backend';
import type { Context } from './context';
import { conciergePlanOpenTo, conciergePlanOutput, conciergePlanRouter, createConciergePlanRouter } from './conciergePlanRouter';
import { appRouter } from './router';
import { resetLocalRateLimitForTests } from './trpc';

const original = {
  conciergeDiscoveryEnabled: config.conciergeDiscoveryEnabled, conciergePlanEnabled: config.conciergePlanEnabled,
  conciergeAudience: config.conciergeAudience, conciergePilotUserIds: config.conciergePilotUserIds, openaiApiKey: config.openaiApiKey,
};
test.afterEach(() => { Object.assign(config, original); resetLocalRateLimitForTests(); });
const openAll = () => Object.assign(config, { conciergeDiscoveryEnabled: true, conciergePlanEnabled: true, conciergeAudience: 'everyone', conciergePilotUserIds: '' });

const member: Context = { user: { userId: 'plan-test-user', email: 'member@example.test' }, clientRateLimitKey: 'plan-test' };
const ask = { message: 'Friday dinner and drinks in Midtown for 4, under $60 each', location: { lat: 33.7838, lng: -84.383 } };

function fakeEngine() {
  let built = 0;
  const engineFor = () => {
    built += 1;
    return createEngine({ llm: new FakeProvider({ structured: { intent: [fridayIntent()], plan_selection: [fridaySelection()] }, chat: [discoverBoth] }), ports: createFakePorts() });
  };
  return { engineFor, built: () => built };
}

test('concierge.plan is mounted next to the unchanged discover and chat mutations, and needs sign-in', async () => {
  const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
  assert.equal(procedures['concierge.plan']._def.type, 'mutation');
  assert.equal(procedures['concierge.discover']._def.type, 'mutation');
  assert.equal(procedures['concierge.chat']._def.type, 'mutation');
  await assert.rejects(() => appRouter.createCaller({ user: null, clientRateLimitKey: 'plan-anon' }).concierge.plan(ask), { code: 'UNAUTHORIZED' });
});

test('the CONCIERGE_PLAN_ENABLED flag defaults OFF and the off reply runs no engine', async () => {
  assert.equal(original.conciergePlanEnabled, false, 'default must be off');
  Object.assign(config, { conciergeDiscoveryEnabled: true, conciergeAudience: 'everyone', conciergePlanEnabled: false });
  const fake = fakeEngine();
  const out = await createConciergePlanRouter({ engineFor: fake.engineFor }).createCaller(member).plan(ask);
  assert.deepEqual(out, { version: 1, status: 'unavailable', reply: 'Concierge plans are not enabled yet. You can browse places in Discover.', result: null });
  assert.equal(fake.built(), 0);
});

test('CONCIERGE_PLAN_ENABLED alone opens concierge.plan, regardless of discovery flag or pilot list', async () => {
  Object.assign(config, { conciergePlanEnabled: true, conciergeDiscoveryEnabled: false, conciergeAudience: 'pilot', conciergePilotUserIds: '' });
  assert.equal(conciergePlanOpenTo(), true);
  const fake = fakeEngine();
  const out = await createConciergePlanRouter({ engineFor: fake.engineFor }).createCaller(member).plan(ask);
  assert.equal(out.status, 'ok');
  assert.equal(fake.built(), 1);
  Object.assign(config, { conciergePlanEnabled: false });
  assert.equal(conciergePlanOpenTo(), false);
});

test('when enabled it returns a ProposedPlan that matches the wire contract', async () => {
  openAll();
  const out = await createConciergePlanRouter({ engineFor: fakeEngine().engineFor }).createCaller(member).plan(ask);
  conciergePlanOutput.parse(out);
  assert.equal(out.status, 'ok');
  assert.equal(out.result?.kind, 'plan');
  if (out.result?.kind !== 'plan') return;
  assert.equal(out.result.budgetCents, 24000);
  assert.deepEqual(out.result.items.map((i) => i.title), ['SAMPLE Southern Kitchen', 'SAMPLE Rooftop Lounge']);
});

test('without an OpenAI key the real engine is not built and the guest is told plainly', async () => {
  openAll();
  Object.assign(config, { openaiApiKey: '' });
  assert.equal(createBackendEngine(member), null);
  const out = await conciergePlanRouter.createCaller(member).plan(ask);
  assert.deepEqual(out, { version: 1, status: 'unavailable', reply: 'Concierge plans are unavailable right now. Nothing was made up.', result: null });
});

test('validates input', async () => {
  openAll();
  const caller = createConciergePlanRouter({ engineFor: fakeEngine().engineFor }).createCaller(member);
  await assert.rejects(() => caller.plan({ message: '   ' }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller.plan({ message: 'x'.repeat(2001) }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller.plan({ ...ask, location: { lat: 91, lng: 0 } }), { code: 'BAD_REQUEST' });
  await assert.rejects(() => caller.plan({ ...ask, venues: [] } as never), { code: 'BAD_REQUEST' });
});

test('has its own per-user 10-per-minute rate limit', async () => {
  Object.assign(config, { conciergePlanEnabled: false });
  const caller = createConciergePlanRouter({ engineFor: fakeEngine().engineFor }).createCaller({ ...member, user: { ...member.user!, userId: 'plan-rate-test' } });
  for (let n = 0; n < 10; n++) await caller.plan(ask);
  await assert.rejects(() => caller.plan(ask), { code: 'TOO_MANY_REQUESTS' });
});

test('concierge.plan answers unavailable when planning runs past the hard limit', async () => {
  openAll();
  const out = await createConciergePlanRouter({ engineFor: () => ({ handle: () => new Promise(() => {}) }), timeoutMs: 5 }).createCaller(member).plan(ask);
  assert.deepEqual(out, { version: 1, status: 'unavailable', reply: 'That took too long to plan. Try again, or ask for fewer stops. Nothing was made up.', result: null });
});
