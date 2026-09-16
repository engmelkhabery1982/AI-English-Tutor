/**
 * src/providers/ai/index.ts
 *
 * Public API and helpers for the provider-neutral AI Provider abstraction layer.
 */

import type {
  AIFinishReason,
  AIProvider,
  AIProviderError,
  AIProviderErrorCode,
  AIProviderResponse,
  AIProviderResult,
  AIUsage,
  ConversationRequest,
  CreateAIProviderResponseOptions,
} from './types';

export type {
  AIFinishReason,
  AIProvider,
  AIProviderError,
  AIProviderErrorCode,
  AIProviderResponse,
  AIProviderResult,
  AIUsage,
  ConversationRequest,
  CreateAIProviderResponseOptions,
};

/**
 * Validates and creates a provider-neutral AIProviderResponse.
 *
 * - Rejects empty or whitespace-only content.
 * - Preserves non-empty content exactly as supplied without trimming.
 * - Defensively copies optional usage metadata.
 */
export function createAIProviderResponse(
  content: string,
  options?: CreateAIProviderResponseOptions
): AIProviderResponse {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('AI response content cannot be empty or whitespace only.');
  }

  let usage: AIUsage | undefined;
  if (options?.usage) {
    const rawUsage = options.usage;
    usage = {
      ...(typeof rawUsage.inputTokens === 'number' && { inputTokens: rawUsage.inputTokens }),
      ...(typeof rawUsage.outputTokens === 'number' && { outputTokens: rawUsage.outputTokens }),
      ...(typeof rawUsage.totalTokens === 'number' && { totalTokens: rawUsage.totalTokens }),
    };
  }

  return {
    content,
    ...(options?.finishReason !== undefined && { finishReason: options.finishReason }),
    ...(usage !== undefined && { usage }),
  };
}

/**
 * Validates and creates a provider-neutral AIProviderError.
 *
 * - Rejects empty or whitespace-only error message.
 */
export function createAIProviderError(
  code: AIProviderErrorCode,
  message: string,
  retryable: boolean
): AIProviderError {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('AI provider error message cannot be empty or whitespace only.');
  }

  return {
    code,
    message,
    retryable,
  };
}

/**
 * Creates a successful AIProviderResult wrapping an AIProviderResponse.
 */
export function createAIProviderSuccess(response: AIProviderResponse): AIProviderResult {
  return {
    ok: true,
    response,
  };
}

/**
 * Creates a failed AIProviderResult wrapping an AIProviderError.
 */
export function createAIProviderFailure(error: AIProviderError): AIProviderResult {
  return {
    ok: false,
    error,
  };
}
