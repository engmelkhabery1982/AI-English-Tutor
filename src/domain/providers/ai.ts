/**
 * src/domain/providers/ai.ts
 *
 * AIProvider interface.
 *
 * Vendor-agnostic contract for any text-based AI capability.
 * Implementations may wrap OpenAI, a local model, a free provider,
 * or any future backend. The learning app must never import a
 * vendor SDK directly.
 */

import type { Uuid } from '../shared/types';

/** A single message in a conversation with the AI. */
export interface AIMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** A tool/function the AI may call. */
export interface AITool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>; // JSON schema
}

/** A tool call returned by the AI. */
export interface AIToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

/** Generation options. */
export interface AIChatOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly systemPrompt?: string;
  readonly tools?: readonly AITool[];
  readonly conversationId?: Uuid;
  readonly learnerId?: Uuid;
  readonly mode?: 'natural' | 'coach' | 'intensive';
  readonly topic?: string;
}

/** A streaming chunk of assistant text. */
export interface AIChatChunk {
  readonly delta: string;
  readonly done: boolean;
  readonly toolCalls?: readonly AIToolCall[];
  readonly finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
  };
}

/** Response metadata returned alongside generated text. */
export interface AIChatResponse {
  readonly text: string;
  readonly toolCalls?: readonly AIToolCall[];
  readonly finishReason?: string;
  readonly usage?: AIChatChunk['usage'];
  readonly model?: string;
  readonly latencyMs?: number;
}

/** Embedding vector for semantic retrieval. */
export interface AIEmbedding {
  readonly vector: readonly number[];
  readonly model?: string;
  readonly dimensions: number;
}

/** Embedding options. */
export interface AIEmbedOptions {
  readonly text: string;
  readonly model?: string;
}

/**
 * AIProvider
 *
 * Replaceable interface for any text AI backend.
 * Implementations live in src/services/providers/* and must NOT
 * leak vendor SDK types into the domain layer.
 */
export interface AIProvider {
  readonly providerId: string;
  readonly capabilities: readonly (
    | 'chat'
    | 'stream'
    | 'embed'
    | 'function-calling'
  )[];

  /**
   * Generate a single assistant response.
   * Resolves with the full text (and any tool calls).
   */
  chat(messages: readonly AIMessage[], options?: AIChatOptions): Promise<AIChatResponse>;

  /**
   * Stream assistant text token-by-token.
   * Yields AIChatChunk values until `done` is true.
   */
  stream(
    messages: readonly AIMessage[],
    options?: AIChatOptions,
  ): AsyncIterable<AIChatChunk>;

  /**
   * Generate an embedding vector for a text string.
   * Optional: only required by retrieval-augmented features.
   */
  embed?(text: string, options?: AIEmbedOptions): Promise<AIEmbedding>;

  /**
   * Health check. Returns true if the provider is usable right now.
   */
  healthcheck(): Promise<boolean>;
}

/** Factory signature for creating an AI provider instance. */
export type AIProviderFactory = (config: Record<string, unknown>) => AIProvider;