import type { ChatRequest, ChatResponse, LLMProvider, StructuredRequest, ToolCall } from './types';

/** One scripted assistant turn: either tool calls or final text. */
export type FakeTurn = { toolCalls: Array<{ name: string; arguments: unknown }> } | { content: string };

export interface FakeScript {
  /** Chat turns, consumed in order. A function gets the request (for inspection) and step index. */
  chat?: FakeTurn[] | ((request: ChatRequest, step: number) => FakeTurn);
  /** Structured outputs keyed by schema name, consumed in order per key. */
  structured?: Record<string, unknown[]>;
  /** Make every call throw, to simulate the LLM being down. */
  down?: boolean;
}

/** Deterministic, offline LLMProvider for tests. Records every call. */
export class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly calls: Array<{ kind: 'chat'; request: ChatRequest } | { kind: 'structured'; name: string; request: StructuredRequest<unknown> }> = [];
  private step = 0;
  private ids = 0;
  private readonly queues: Record<string, unknown[]>;

  constructor(private readonly script: FakeScript = {}) {
    this.queues = Object.fromEntries(Object.entries(script.structured ?? {}).map(([k, v]) => [k, [...v]]));
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push({ kind: 'chat', request });
    if (this.script.down) throw new Error('FakeProvider: down');
    const index = this.step++;
    const chat = this.script.chat;
    const turn: FakeTurn | undefined = typeof chat === 'function' ? chat(request, index) : chat?.[index];
    if (!turn || 'content' in turn) return { content: turn && 'content' in turn ? turn.content : 'done', toolCalls: [] };
    const toolCalls: ToolCall[] = turn.toolCalls.map((c) => ({ id: `call_${++this.ids}`, name: c.name, arguments: c.arguments }));
    return { content: null, toolCalls };
  }

  async structured<T>(request: StructuredRequest<T>): Promise<T> {
    this.calls.push({ kind: 'structured', name: request.name, request: request as StructuredRequest<unknown> });
    if (this.script.down) throw new Error('FakeProvider: down');
    const queue = this.queues[request.name];
    if (!queue?.length) throw new Error(`FakeProvider: no scripted output for "${request.name}"`);
    return request.schema.parse(queue.shift());
  }
}
