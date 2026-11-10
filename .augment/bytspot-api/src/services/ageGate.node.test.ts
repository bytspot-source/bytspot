import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageInYears, ageProblem, alcoholLicenceProblem, minimumAgeFor, parseBirthDate, partyAgeRule, provenMinimumAge, sessionSellsAlcohol } from './ageGate';

const now = new Date('2026-11-10T12:00:00Z');
const dob = (iso: string) => new Date(`${iso}T00:00:00Z`);

test('calendar age turns over on the birthday, not before', () => {
  assert.equal(ageInYears(dob('2005-11-10'), now), 21);
  assert.equal(ageInYears(dob('2005-11-11'), now), 20);
  assert.equal(ageInYears(dob('2008-11-10'), now), 18);
});

test('the party age rule comes from templateConfig.hostAge and defaults to all-ages', () => {
  assert.equal(partyAgeRule({ hostAge: '21-plus' }), '21-plus');
  assert.equal(partyAgeRule({ hostAge: '18-plus' }), '18-plus');
  assert.equal(partyAgeRule({ hostAge: 'nonsense' }), 'all-ages');
  assert.equal(partyAgeRule(null), 'all-ages');
  assert.equal(minimumAgeFor('all-ages'), 0);
  assert.equal(minimumAgeFor('18-plus'), 18);
  assert.equal(minimumAgeFor('21-plus'), 21);
  assert.equal(minimumAgeFor('all-ages', true), 21, 'alcohol is 21 whatever the party says');
});

test('21+ needs a birth date; an 18+ confirmation is not enough', () => {
  assert.match(ageProblem({ birthDate: null, ageConfirmedAt: now }, 21, now)!, /date of birth/);
  assert.match(ageProblem({ birthDate: dob('2006-01-01'), ageConfirmedAt: null }, 21, now)!, /21\+ only/);
  assert.equal(ageProblem({ birthDate: dob('2000-01-01'), ageConfirmedAt: null }, 21, now), null);
});

test('18+ accepts a confirmation or a birth date, and refuses unknown age', () => {
  assert.equal(ageProblem({ birthDate: null, ageConfirmedAt: now }, 18, now), null);
  assert.match(ageProblem({ birthDate: null, ageConfirmedAt: null }, 18, now)!, /Confirm your age/);
  assert.match(ageProblem({ birthDate: dob('2010-01-01'), ageConfirmedAt: now }, 18, now)!, /18\+ only/, 'a birth date beats a checkbox');
  assert.equal(provenMinimumAge({ birthDate: null, ageConfirmedAt: null }), null);
});

test('all-ages requires nothing', () => {
  assert.equal(ageProblem({ birthDate: null, ageConfirmedAt: null }, 0, now), null);
});

test('birth dates are validated and the signup floor applies', () => {
  assert.ok('date' in parseBirthDate('2000-02-29', now));
  assert.ok('problem' in parseBirthDate('2001-02-29', now), 'not a real date');
  assert.ok('problem' in parseBirthDate('02/03/2000', now));
  assert.ok('problem' in parseBirthDate('2030-01-01', now));
  assert.match((parseBirthDate('2016-01-01', now) as { problem: string }).problem, /or older/);
});

test('bottle sessions are alcohol and need a verified licence', () => {
  assert.equal(sessionSellsAlcohol({ bottleCount: 2 }), true);
  assert.equal(sessionSellsAlcohol({ bottleCount: 0 }), false);
  assert.ok(alcoholLicenceProblem({ alcoholLicenceVerifiedAt: null }));
  assert.ok(alcoholLicenceProblem(null));
  assert.equal(alcoholLicenceProblem({ alcoholLicenceVerifiedAt: now }), null);
});
