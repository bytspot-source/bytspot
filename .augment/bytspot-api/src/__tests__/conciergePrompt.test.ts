import { describe, expect, it } from 'vitest';
import { buildSystemPrompt as buildTrpcSystemPrompt } from '../trpc/router';
import { buildSystemPrompt as buildRestSystemPrompt } from '../routes/concierge';

const venue = {
  id: 'venue-1',
  name: 'Patch Lounge',
  category: 'lounge',
  address: 'Midtown ATL',
  crowd: { level: 2, label: 'Relaxed', waitMins: 5 },
};

describe('concierge system prompt safety layer', () => {
  it('keeps the tRPC concierge prompt scoped to safe, verified app behavior', () => {
    const prompt = buildTrpcSystemPrompt([venue], { vibe: 'luxury', walk: 'short', group: '2' });

    expect(prompt).toContain('Prioritize user safety, consent, and privacy');
    expect(prompt).toContain('Never ask for passwords, raw card numbers, CVV');
    expect(prompt).toContain('Never give medical, legal, or financial advice');
    expect(prompt).toContain('Mention "Patch Verified" only when the data explicitly supports it');
    expect(prompt).toContain('never claim an action is complete unless the app/backend confirms it');
    expect(prompt).toContain('Do not claim persistent memory or saved preferences');
    expect(prompt).toContain('You MUST respond with valid JSON only');
  });

  it('keeps the legacy REST concierge prompt aligned with the same guardrails', () => {
    const prompt = buildRestSystemPrompt([venue], { vibe: 'premium', walk: 'any', group: '4' });

    expect(prompt).toContain('Prioritize user safety, consent, and privacy');
    expect(prompt).toContain('Never ask for passwords, raw card numbers, CVV');
    expect(prompt).toContain('Never give medical, legal, or financial advice');
    expect(prompt).toContain('Mention "Patch Verified" only when the data explicitly supports it');
    expect(prompt).toContain('never claim an action is complete unless the app/backend confirms it');
    expect(prompt).toContain('Do not claim persistent memory or saved preferences');
    expect(prompt).toContain('You MUST respond with valid JSON only');
  });
});