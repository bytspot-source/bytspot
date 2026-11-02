import type { z } from 'zod';

/** A tool call the model asked for. `arguments` is already JSON-parsed when possible. */
export interface ToolCall { id: string; name: string; arguments: unknown }

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/** Tool definition in provider-neutral form: name, description, JSON Schema for arguments. */
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** 'auto' lets the model pick; 'none' forbids tool calls. */
  toolChoice?: 'auto' | 'none';
}

export interface ChatResponse { content: string | null; toolCalls: ToolCall[] }

export interface StructuredRequest<T> {
  messages: ChatMessage[];
  /** Validated with zod after the provider returns; providers may also pass it as JSON Schema. */
  schema: z.ZodType<T>;
  /** Stable name for the schema (also the FakeProvider queue key). */
  name: string;
}

/**
 * The only thing the engine knows about an LLM. Adding a provider = one file
 * implementing these two methods.
 */
export interface LLMProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  structured<T>(request: StructuredRequest<T>): Promise<T>;
}
