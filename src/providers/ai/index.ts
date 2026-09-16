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
  AIStreamCallback,
  AIUsage,
  ConversationFeedback,
  ConversationFeedbackCorrection,
  ConversationFeedbackVocabulary,
  ConversationRequest,
  CreateAIProviderResponseOptions,
  VocabularyCategory,
} from './types';

export type {
  AIFinishReason,
  AIProvider,
  AIProviderError,
  AIProviderErrorCode,
  AIProviderResponse,
  AIProviderResult,
  AIStreamCallback,
  AIUsage,
  ConversationFeedback,
  ConversationFeedbackCorrection,
  ConversationFeedbackVocabulary,
  ConversationRequest,
  CreateAIProviderResponseOptions,
  VocabularyCategory,
};

/**
 * Validates and creates a provider-neutral AIProviderResponse.
 *
 * - Rejects empty or whitespace-only content.
 * - Preserves non-empty content exactly as supplied without trimming.
 * - Defensively copies optional feedback and usage metadata.
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

  let feedback: ConversationFeedback | null | undefined = options?.feedback;
  if (feedback) {
    feedback = {
      ...(feedback.correction !== undefined && {
        correction: feedback.correction
          ? {
              original: feedback.correction.original,
              improved: feedback.correction.improved,
              explanation: feedback.correction.explanation,
              severity: feedback.correction.severity,
            }
          : null,
      }),
      ...(feedback.vocabulary !== undefined && {
        vocabulary: feedback.vocabulary
          ? {
              headword: feedback.vocabulary.headword,
              type: feedback.vocabulary.type,
              meaning: feedback.vocabulary.meaning,
              example: feedback.vocabulary.example,
            }
          : null,
      }),
      ...(feedback.coachingNote !== undefined && {
        coachingNote: feedback.coachingNote,
      }),
    };
  }

  return {
    content,
    ...(feedback !== undefined && { feedback }),
    ...(options?.rawText !== undefined && { rawText: options.rawText }),
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
 * Creates a successful AIProviderResult wrapping a defensive copy of AIProviderResponse.
 */
export function createAIProviderSuccess(response: AIProviderResponse): AIProviderResult {
  let usage: AIUsage | undefined;
  if (response.usage) {
    const rawUsage = response.usage;
    usage = {
      ...(typeof rawUsage.inputTokens === 'number' && { inputTokens: rawUsage.inputTokens }),
      ...(typeof rawUsage.outputTokens === 'number' && { outputTokens: rawUsage.outputTokens }),
      ...(typeof rawUsage.totalTokens === 'number' && { totalTokens: rawUsage.totalTokens }),
    };
  }

  let feedback: ConversationFeedback | null | undefined = response.feedback;
  if (feedback) {
    feedback = {
      ...(feedback.correction !== undefined && {
        correction: feedback.correction
          ? {
              original: feedback.correction.original,
              improved: feedback.correction.improved,
              explanation: feedback.correction.explanation,
              severity: feedback.correction.severity,
            }
          : null,
      }),
      ...(feedback.vocabulary !== undefined && {
        vocabulary: feedback.vocabulary
          ? {
              headword: feedback.vocabulary.headword,
              type: feedback.vocabulary.type,
              meaning: feedback.vocabulary.meaning,
              example: feedback.vocabulary.example,
            }
          : null,
      }),
      ...(feedback.coachingNote !== undefined && {
        coachingNote: feedback.coachingNote,
      }),
    };
  }

  const responseCopy: AIProviderResponse = {
    content: response.content,
    ...(feedback !== undefined && { feedback }),
    ...(response.rawText !== undefined && { rawText: response.rawText }),
    ...(response.finishReason !== undefined && { finishReason: response.finishReason }),
    ...(usage !== undefined && { usage }),
  };

  return {
    ok: true,
    response: responseCopy,
  };
}

/**
 * Creates a failed AIProviderResult wrapping a defensive copy of AIProviderError.
 */
export function createAIProviderFailure(error: AIProviderError): AIProviderResult {
  const errorCopy: AIProviderError = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };

  return {
    ok: false,
    error: errorCopy,
  };
}
