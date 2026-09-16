/**
 * src/providers/ai/types.ts
 *
 * Provider-neutral interfaces and types for the AI Provider abstraction layer.
 * Decouples the Conversation Engine from any vendor SDK, HTTP client, or specific AI service.
 */

import type { ConversationRequest } from '../../conversation-engine';

/**
 * Standard provider-neutral finish reasons for AI generation.
 */
export type AIFinishReason =
  | 'completed'
  | 'length'
  | 'blocked'
  | 'cancelled'
  | 'unknown';

/**
 * Optional provider-neutral token usage metadata.
 * Values are only transported if provided by the underlying provider.
 */
export interface AIUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Allowed vocabulary and expression categories matching domain models.
 */
export type VocabularyCategory =
  | 'word'
  | 'phrase'
  | 'phrasal_verb'
  | 'idiom'
  | 'common_expression'
  | 'collocation'
  | 'linking_expression'
  | 'professional_expression';

/**
 * Structured correction feedback extracted from assistant response.
 */
export interface ConversationFeedbackCorrection {
  readonly original: string;
  readonly improved: string;
  readonly explanation: string;
  readonly severity: 'incorrect' | 'unnatural' | 'minor';
}

/**
 * Structured vocabulary/expression feedback extracted from assistant response.
 */
export interface ConversationFeedbackVocabulary {
  readonly headword: string;
  readonly type: VocabularyCategory;
  readonly meaning: string;
  readonly example: string;
}

/**
 * Structured coaching feedback extracted from assistant response.
 */
export interface ConversationFeedback {
  readonly correction?: ConversationFeedbackCorrection | null;
  readonly vocabulary?: ConversationFeedbackVocabulary | null;
  readonly coachingNote?: string | null;
}

/**
 * Standard provider-neutral AI response structure.
 */
export interface AIProviderResponse {
  readonly content: string;
  readonly feedback?: ConversationFeedback | null;
  readonly rawText?: string;
  readonly finishReason?: AIFinishReason;
  readonly usage?: AIUsage;
}

/**
 * Standard provider-neutral error category codes.
 */
export type AIProviderErrorCode =
  | 'invalid_request'
  | 'authentication'
  | 'rate_limit'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

/**
 * Provider-neutral error descriptor.
 * Never exposes raw SDK exceptions, API keys, URLs, or internal headers.
 */
export interface AIProviderError {
  readonly code: AIProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Explicit discriminated union representing the outcome of an AI generation request.
 */
export type AIProviderResult =
  | {
      readonly ok: true;
      readonly response: AIProviderResponse;
    }
  | {
      readonly ok: false;
      readonly error: AIProviderError;
    };

/**
 * Callback function receiving incremental text chunks during streaming generation.
 */
export type AIStreamCallback = (chunk: string) => void;

/**
 * Core provider-neutral AIProvider interface.
 * Implemented by concrete provider adapters (e.g. Gemini, Demo).
 */
export interface AIProvider {
  readonly id: string;

  generate(request: ConversationRequest): Promise<AIProviderResult>;
  generateStream?(
    request: ConversationRequest,
    onChunk: AIStreamCallback
  ): Promise<AIProviderResult>;
}

/**
 * Options for creating an AIProviderResponse.
 */
export interface CreateAIProviderResponseOptions {
  readonly feedback?: ConversationFeedback | null;
  readonly rawText?: string;
  readonly finishReason?: AIFinishReason;
  readonly usage?: AIUsage;
}

export type { ConversationRequest };
