import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { z } from 'zod';
import { FakeProvider } from './llm/fake';
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from './llm/openai';

const okResponse = (message: unknown) => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
function fetchMock(respond: () => Response) {
  const calls: Array<[string, RequestInit]> = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push([url, init]); return respond(); }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('bytt-si OpenAIProvider', () => {
  const saved = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL };
  afterEach(() => {
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = saved.model;
  });

  it('takes the key from options or env and defaults the model to gpt-4o-mini', () => {
    delete process.env.OPENAI_MODEL;
    assert.equal(new OpenAIProvider({ apiKey: 'k', fetch: fetchMock(() => okResponse({})).fn }).model, DEFAULT_OPENAI_MODEL);
    assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-4o-mini');
    process.env.OPENAI_MODEL = 'gpt-4.1-mini';
    assert.equal(new OpenAIProvider({ apiKey: 'k' }).model, 'gpt-4.1-mini');
    assert.equal(new OpenAIProvider({ apiKey: 'k', model: 'explicit' }).model, 'explicit');
  });
  it('refuses to start without a key', () => {
    delete process.env.OPENAI_API_KEY;
    assert.throws(() => new OpenAIProvider({ apiKey: '' }), /OPENAI_API_KEY/);
  });
  it('sends tools and parses tool calls', async () => {
    const mock = fetchMock(() => okResponse({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'discovery', arguments: '{"needKind":"dining","query":"x"}' } }] }));
    const provider = new OpenAIProvider({ apiKey: 'test-key', fetch: mock.fn, model: 'm' });
    const out = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'discovery', description: 'd', parameters: { type: 'object' } }] });
    assert.deepEqual(out.toolCalls, [{ id: 'c1', name: 'discovery', arguments: { needKind: 'dining', query: 'x' } }]);
    const [url, init] = mock.calls[0];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-key');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, 'm');
    assert.equal(body.tools[0].function.name, 'discovery');
  });
  it('requests JSON-schema output and validates it with zod', async () => {
    const mock = fetchMock(() => okResponse({ content: '{"answer":"hi"}' }));
    const provider = new OpenAIProvider({ apiKey: 'test-key', fetch: mock.fn });
    assert.deepEqual(await provider.structured({ name: 'quick_answer', schema: z.object({ answer: z.string() }), messages: [] }), { answer: 'hi' });
    assert.equal(JSON.parse(mock.calls[0][1].body as string).response_format.type, 'json_schema');
  });
  it('throws on HTTP errors', async () => {
    const provider = new OpenAIProvider({ apiKey: 'test-key', fetch: fetchMock(() => new Response('no', { status: 503 })).fn });
    await assert.rejects(() => provider.chat({ messages: [] }), /503/);
  });
});

describe('bytt-si FakeProvider', () => {
  it('replays scripted turns deterministically', async () => {
    const fake = new FakeProvider({ chat: [{ toolCalls: [{ name: 'budget', arguments: {} }] }, { content: 'done' }], structured: { x: [{ a: 1 }] } });
    assert.deepEqual((await fake.chat({ messages: [] })).toolCalls[0], { id: 'call_1', name: 'budget', arguments: {} });
    assert.equal((await fake.chat({ messages: [] })).content, 'done');
    assert.deepEqual(await fake.structured({ name: 'x', schema: z.object({ a: z.number() }), messages: [] }), { a: 1 });
    await assert.rejects(() => fake.structured({ name: 'x', schema: z.object({ a: z.number() }), messages: [] }), /no scripted output/);
  });
});
