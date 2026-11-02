import { z } from 'zod';
import type { ChatMessage, ChatRequest, ChatResponse, LLMProvider, StructuredRequest, ToolCall } from './types';

export interface OpenAIProviderOptions {
  /** Defaults to process.env.OPENAI_API_KEY. Never hard-code a key. */
  apiKey?: string;
  /** Defaults to process.env.OPENAI_MODEL, then 'gpt-4o-mini'. */
  model?: string;
  /** Defaults to process.env.OPENAI_BASE_URL, then https://api.openai.com/v1. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

function toWire(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant', content: message.content,
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })) } : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/** OpenAI Chat Completions adapter (tool calls + JSON-schema structured output). No SDK dependency. */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAIProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OpenAIProvider: OPENAI_API_KEY is not set.');
    this.apiKey = apiKey;
    this.model = options.model || process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
    this.baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async post(body: Record<string, unknown>): Promise<{ content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }> {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, ...body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`OpenAIProvider: HTTP ${response.status}`);
    const json = await response.json() as { choices?: Array<{ message?: { content: string | null; tool_calls?: never } }> };
    const message = json.choices?.[0]?.message;
    if (!message) throw new Error('OpenAIProvider: empty response');
    return message;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const message = await this.post({
      messages: request.messages.map(toWire),
      ...(request.tools?.length ? {
        tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: request.toolChoice ?? 'auto',
      } : {}),
    });
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: parseArgs(c.function.arguments) }));
    return { content: message.content ?? null, toolCalls };
  }

  async structured<T>(request: StructuredRequest<T>): Promise<T> {
    const message = await this.post({
      messages: request.messages.map(toWire),
      response_format: { type: 'json_schema', json_schema: { name: request.name, strict: false, schema: z.toJSONSchema(request.schema, { io: 'input' }) } },
    });
    if (!message.content) throw new Error('OpenAIProvider: structured output was empty');
    return request.schema.parse(JSON.parse(message.content));
  }
}
