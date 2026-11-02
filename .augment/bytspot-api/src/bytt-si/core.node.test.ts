import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { handoffUrl } from '../trpc/mobilityRouter';
import { crowdInfo } from './core/crowd';
import { rideLinks } from './core/deepLinks';
import { honestyViolations } from './core/honesty';
import { normalizeConstraints, parseMoneyAndParty } from './core/intent';
import { loadSystemPrompt, SYSTEM_PROMPT } from './prompt';
import { assertPartial } from './testing/assert';
import { NOW } from './testing/helpers';

describe('bytt-si intent parsing in code', () => {
  it('reads "$60 each" and "for 4" and turns it into a group total', () => {
    assert.deepEqual(parseMoneyAndParty('dinner and drinks for 4 under $60 each'), { perPersonCents: 6000, totalCents: null, partySize: 4 });
    assertPartial(normalizeConstraints(null, { message: 'drinks for four, $60 each', now: NOW }).constraints, { partySize: 4, budgetCents: 24000, areaLabel: 'Midtown, Atlanta' });
  });
  it('code-read budget wins over a wrong model read', () => {
    const { constraints } = normalizeConstraints({ mode: 'plan', intent: 'x', needs: [], startsAt: null, endsAt: null, areaLabel: null, partySize: 4, budgetPerPersonCents: null, budgetTotalCents: 6000, radiusMiles: null, preferences: [] }, { message: 'for 4 under $60 each', now: NOW });
    assert.equal(constraints.budgetCents, 24000);
  });
  it('does not read a time as a party size', () => {
    assert.equal(parseMoneyAndParty('dinner for 8pm').partySize, null);
  });
  it('drops an end before the start', () => {
    const { constraints, notices } = normalizeConstraints({ mode: 'plan', intent: 'x', needs: [], startsAt: '2026-11-06T21:00:00-05:00', endsAt: '2026-11-06T20:00:00-05:00', areaLabel: 'Midtown', partySize: null, budgetPerPersonCents: null, budgetTotalCents: null, radiusMiles: null, preferences: [] }, { message: 'x', now: NOW });
    assert.equal(constraints.endsAt, null);
    assert.equal(notices[0].code, 'assumption');
  });
});

describe('bytt-si crowd labels', () => {
  it('typical is never labeled live', () => {
    assert.equal(crowdInfo({ level: 4, source: 'typical' })!.label, 'Usually packed around this time (typical, not live)');
  });
  it('a live source without an observation time is typical', () => {
    assert.equal(crowdInfo({ level: 3, source: 'sensor' })!.source, 'typical');
  });
  it('a stale live reading (over 30 min) is typical', () => {
    assert.equal(crowdInfo({ level: 2, source: 'sensor', observedAt: '2026-11-06T21:00:00-05:00' }, '2026-11-06T21:31:00-05:00')!.source, 'typical');
    assert.equal(crowdInfo({ level: 2, source: 'sensor', observedAt: '2026-11-06T21:00:00-05:00' }, '2026-11-06T21:30:00-05:00')!.source, 'live');
  });
  it('live only with a live source and a time', () => {
    assertPartial(crowdInfo({ level: 2, source: 'user_report', observedAt: '2026-11-06T21:00:00-05:00' }), { source: 'live', label: 'Live: active as of 9:00 PM' });
  });
});

describe('bytt-si honesty guard', () => {
  const facts = { liveNames: [], otherNames: ['Rooftop'], allowedCents: [5400] };
  it('flags live claims without live data', () => {
    assert.ok(honestyViolations("It's packed right now", facts).includes('live_claim'));
    assert.ok(honestyViolations('Live crowd: busy', facts).includes('live_claim'));
    assert.deepEqual(honestyViolations('Usually busy around this time', facts), []);
  });
  it('allows a live claim only about a place with live data', () => {
    const mixed = { liveNames: ['Speakeasy'], otherNames: ['Rooftop'], allowedCents: [] };
    assert.deepEqual(honestyViolations('Speakeasy is quiet right now', mixed), []);
    assert.ok(honestyViolations('Rooftop is packed right now', mixed).includes('live_claim'));
  });
  it('flags availability and invented prices', () => {
    assert.ok(honestyViolations('Tables are available at 7', facts).includes('availability_claim'));
    assert.ok(honestyViolations('About $20 each', facts).includes('unverified_price'));
    assert.deepEqual(honestyViolations('About $54 each', facts), []);
  });
});

describe('bytt-si deep links', () => {
  it('ride links match mobilityRouter.handoffUrl exactly', () => {
    const dest = { lat: 33.785, lng: -84.3832, name: 'Rooftop', address: '1 Peachtree St NE' };
    const [uber, lyft] = rideLinks({ latitude: dest.lat, longitude: dest.lng, name: dest.name, address: dest.address });
    assert.equal(uber.url, handoffUrl('uber', dest));
    assert.equal(lyft.url, handoffUrl('lyft', dest));
  });
});

describe('bytt-si system prompt', () => {
  it('SYSTEM_PROMPT is exactly prompt/system.md (the md file is the source of truth)', () => {
    const md = readFileSync(join(__dirname, 'prompt', 'system.md'), 'utf8').trim();
    assert.equal(SYSTEM_PROMPT, md);
    assert.equal(loadSystemPrompt(), md);
  });
  it('names the six skills and the honesty rules', () => {
    for (const s of ['discovery', 'budget', 'people', 'scheduling', 'routing', 'bookables']) assert.ok(SYSTEM_PROMPT.includes(`- ${s}`));
    assert.match(SYSTEM_PROMPT, /Never present typical crowd data as live/);
    assert.match(SYSTEM_PROMPT, /proposed Plan/);
  });
});

describe('bytt-si module boundaries', () => {
  it('runtime code never imports the SAMPLE test fixtures or fakes', () => {
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? (f === 'testing' ? [] : walk(p)) : [p];
    });
    const runtime = walk(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.node.test.ts'));
    assert.ok(runtime.length > 10);
    for (const file of runtime) assert.doesNotMatch(readFileSync(file, 'utf8'), /from '[./]*testing\//, file);
  });
});
