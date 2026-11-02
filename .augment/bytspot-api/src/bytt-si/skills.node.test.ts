import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bookablesSkill, budgetSkill, discoverySkill, peopleSkill, routingSkill, schedulingSkill, SKILLS, toToolDefinition } from './skills';
import { assertPartial } from './testing/assert';
import { skillContext } from './testing/helpers';

describe('bytt-si skill registry', () => {
  it('exposes exactly the six skills as tools with JSON schemas', () => {
    assert.deepEqual(SKILLS.map((s) => s.name), ['discovery', 'budget', 'people', 'scheduling', 'routing', 'bookables']);
    for (const skill of SKILLS) {
      const def = toToolDefinition(skill);
      assert.ok(def.description.length > 20);
      assert.equal(def.parameters.type, 'object');
    }
  });
});

describe('bytt-si discovery', () => {
  const drinks = () => discoverySkill.input.parse({ needKind: 'drinks', query: 'bar' });
  it('returns candidates inside the radius only, nearest first', async () => {
    const out = await discoverySkill.run(drinks(), skillContext());
    discoverySkill.output.parse(out);
    assert.equal(out.status, 'ok');
    assert.ok(!out.candidates.some((c) => c.name === 'SAMPLE Far Away Bar'));
    const d = out.candidates.map((c) => c.distanceMeters);
    assert.deepEqual([...d].sort((a, b) => a - b), d);
  });
  it('labels typical crowd as typical and never live', async () => {
    const out = await discoverySkill.run(drinks(), skillContext());
    const rooftop = out.candidates.find((c) => c.name === 'SAMPLE Rooftop Lounge')!;
    assertPartial(rooftop.crowd, { source: 'typical' });
    assert.match(rooftop.crowd!.label, /typical, not live/);
    assertPartial(out.candidates.find((c) => c.name === 'SAMPLE Speakeasy 10th')!.crowd, { source: 'live' });
  });
  it('downgrades an old live reading to typical', async () => {
    const out = await discoverySkill.run(drinks(), skillContext({}, {}, '2026-11-06T23:00:00-05:00'));
    assertPartial(out.candidates.find((c) => c.name === 'SAMPLE Speakeasy 10th')!.crowd, { source: 'typical' });
  });
  it('fills missing crowd from the CrowdPort and always labels it typical, even if the port says live', async () => {
    const ctx = skillContext({ crowd: { level: 3, source: 'sensor', observedAt: '2026-11-06T21:05:00-05:00' } });
    const out = await discoverySkill.run(discoverySkill.input.parse({ needKind: 'dining', query: 'dinner' }), ctx);
    const taqueria = out.candidates.find((c) => c.name === 'SAMPLE Taqueria Midtown')!;
    assertPartial(taqueria.crowd, { source: 'typical', level: 3 });
    assert.match(taqueria.crowd!.label, /typical, not live/);
  });
  it('says the provider is unavailable instead of returning anything', async () => {
    const out = await discoverySkill.run(discoverySkill.input.parse({ needKind: 'dining', query: 'dinner' }), skillContext({ placesDown: true }));
    assert.equal(out.status, 'unavailable');
    assert.deepEqual(out.candidates, []);
    assert.match(out.message!, /unavailable/);
  });
  it('hides open/closed when results are stale', async () => {
    const out = await discoverySkill.run(discoverySkill.input.parse({ needKind: 'dining', query: 'dinner' }), skillContext({ placesStale: true }));
    assert.equal(out.status, 'stale');
    assert.ok(out.candidates.every((c) => c.isOpen === null));
  });
  it('finds Bytspot events with stated start, capability and selection id', async () => {
    const out = await discoverySkill.run(discoverySkill.input.parse({ needKind: 'event', query: 'jazz' }), skillContext());
    assertPartial(out.candidates[0], { kind: 'event', startsAt: '2026-11-06T22:00:00-05:00', durationMins: 90, bookableId: 'party:SAMPLE_event_jazz', capability: 'book', priceCents: null });
  });
});

describe('bytt-si budget', () => {
  const ctx = skillContext();
  it('fits under the group total', async () => {
    const out = await budgetSkill.run({ stops: [{ title: 'A', priceCents: 3400, priceBasis: 'estimate' }, { title: 'B', priceCents: 2000, priceBasis: 'estimate' }] }, ctx);
    assertPartial(out, { verdict: 'fits', perPersonCents: 5400, totalCents: 21600, basis: 'estimate' });
  });
  it('breaks over budget', async () => {
    assert.equal((await budgetSkill.run({ stops: [{ title: 'A', priceCents: 9500, priceBasis: 'estimate' }] }, ctx)).verdict, 'breaks');
  });
  it('stays unknown when a stop has no price', async () => {
    const out = await budgetSkill.run({ stops: [{ title: 'A', priceCents: 1000, priceBasis: 'estimate' }, { title: 'B', priceCents: null, priceBasis: null }] }, ctx);
    assert.equal(out.verdict, 'unknown');
  });
});

describe('bytt-si people', () => {
  it('returns the circle and merged preferences', async () => {
    const out = await peopleSkill.run(peopleSkill.input.parse({}), skillContext());
    assert.equal(out.members.length, 3);
    assert.deepEqual(out.preferences, ['no shellfish', 'vegetarian']);
    assert.equal(out.partySizeHint, 4);
  });
  it('reports names it could not find instead of guessing', async () => {
    const out = await peopleSkill.run({ names: ['Ama', 'Yaw'] }, skillContext());
    assert.deepEqual(out.members.map((m) => m.displayName), ['SAMPLE Ama']);
    assert.deepEqual(out.unresolved, ['Yaw']);
  });
  it('is honest when the people provider is down', async () => {
    assertPartial(await peopleSkill.run({ names: [] }, skillContext({ peopleDown: true })), { status: 'unavailable', members: [] });
  });
});

describe('bytt-si scheduling', () => {
  const ctx = skillContext();
  it('orders stops in the window with travel and keeps fixed event starts', async () => {
    const out = await schedulingSkill.run(schedulingSkill.input.parse({ stops: [
      { id: 'a', title: 'Dinner', needKind: 'dining', latitude: 33.7845, longitude: -84.3838 },
      { id: 'b', title: 'Jazz', latitude: 33.7818, longitude: -84.3825, durationMins: 90, fixedStartsAt: '2026-11-06T22:00:00-05:00' },
    ] }), ctx);
    assert.equal(out.stops[0].startsAt, '2026-11-06T19:00:00-05:00');
    assertPartial(out.stops[1], { startsAt: '2026-11-06T22:00:00-05:00', timeSource: 'fixed' });
    assert.equal(out.verdict, 'fits');
  });
  it('breaks when the stops do not fit the window', async () => {
    const out = await schedulingSkill.run(schedulingSkill.input.parse({ endsAt: '2026-11-06T20:00:00-05:00', stops: [
      { id: 'a', title: 'Dinner', needKind: 'dining', latitude: 33.7845, longitude: -84.3838 },
      { id: 'b', title: 'Drinks', needKind: 'drinks', latitude: 33.7850, longitude: -84.3832 },
    ] }), ctx);
    assert.equal(out.verdict, 'breaks');
    assert.equal(out.checks.find((c) => c.check === 'window')!.verdict, 'breaks');
  });
  it('breaks when a fixed start cannot be reached in time', async () => {
    const out = await schedulingSkill.run(schedulingSkill.input.parse({ stops: [
      { id: 'a', title: 'Dinner', needKind: 'dining', latitude: 33.7845, longitude: -84.3838 },
      { id: 'b', title: 'Show', latitude: 33.7818, longitude: -84.3825, durationMins: 60, fixedStartsAt: '2026-11-06T20:00:00-05:00' },
    ] }), ctx);
    assert.equal(out.checks.find((c) => c.check === 'overlap')!.verdict, 'breaks');
  });
  it('falls back to a straight-line estimate when routing is down', async () => {
    const out = await schedulingSkill.run(schedulingSkill.input.parse({ stops: [
      { id: 'a', title: 'A', latitude: 33.7845, longitude: -84.3838 }, { id: 'b', title: 'B', latitude: 33.7818, longitude: -84.3825 },
    ] }), skillContext({ routingDown: true }));
    assert.ok((out.stops[1].travelMinsBefore ?? 0) > 0);
  });
});

describe('bytt-si routing', () => {
  it('gives travel and Uber/Lyft deep links with no fares', async () => {
    const out = await routingSkill.run({ to: { latitude: 33.7850, longitude: -84.3832, name: 'SAMPLE Rooftop Lounge', address: null } }, skillContext());
    assert.equal(out.status, 'ok');
    assert.equal(out.travel!.mode, 'walk');
    assert.deepEqual(out.rideLinks.map((l) => new URL(l.url).hostname), ['m.uber.com', 'ride.lyft.com']);
    assert.ok(out.rideLinks.every((l) => l.fareChecked === false));
  });
  it('uses the RoutingPort ride links when the port provides them', async () => {
    const ctx = skillContext({ rideLinks: true });
    const out = await routingSkill.run({ to: { latitude: 33.785, longitude: -84.383, name: 'X' } }, ctx);
    assert.ok(out.rideLinks.every((l) => l.url.includes('from-port')));
  });
  it('still gives links but says routing is unavailable', async () => {
    const out = await routingSkill.run({ to: { latitude: 33.785, longitude: -84.383, name: 'X' } }, skillContext({ routingDown: true }));
    assertPartial(out, { status: 'unavailable', travel: null });
    assert.equal(out.rideLinks.length, 2);
  });
});

describe('bytt-si bookables', () => {
  it('returns Bytspot bookables and excludes details-only rows', async () => {
    const out = await bookablesSkill.run({ placeId: 'SAMPLE_bar_speakeasy' }, skillContext());
    assert.deepEqual(out.bytspot.map((b) => b.bookableId), ['BYT-SAMPLE-BOOTH-1']);
    assert.equal(out.bytspot[0].fitsParty, true);
  });
  it('returns OpenTable/Resy as deep links with availability unchecked', async () => {
    const out = await bookablesSkill.run({ placeId: 'SAMPLE_dinner_southern' }, skillContext());
    assert.deepEqual(out.deeplinks, [{ kind: 'deeplink', provider: 'opentable', label: 'OpenTable', url: 'https://www.opentable.com/r/sample-southern-kitchen', availabilityChecked: false }]);
    assert.match(out.message, /availability is not checked/);
  });
  it('drops a table link that is not on the provider host', async () => {
    assert.deepEqual((await bookablesSkill.run({ placeId: 'SAMPLE_dinner_steak' }, skillContext())).deeplinks, []);
  });
  it('says booking info is unavailable when the port is down', async () => {
    assert.equal((await bookablesSkill.run({ placeId: 'SAMPLE_dinner_southern' }, skillContext({ bookablesDown: true }))).status, 'unavailable');
  });
});
