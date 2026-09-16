/**
 * src/providers/ai/gemini/index.ts
 *
 * Real Gemini AI Provider implementation for Google Gemini models via direct REST fetch.
 * Implements the provider-neutral AIProvider interface without external SDK dependencies.
 */

import type {
  AIFinishReason,
  AIProvider,
  AIProviderErrorCode,
  AIProviderResult,
  AIUsage,
  ConversationRequest,
} from '../types';
import {
  createAIProviderError,
  createAIProviderFailure,
  createAIProviderResponse,
  createAIProviderSuccess,
} from '../index';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_PROVIDER_ID,
  type GeminiAIProviderConfig,
} from './types';

export { DEFAULT_GEMINI_MODEL, GEMINI_PROVIDER_ID };
export type { GeminiAIProviderConfig };

/**
 * Sanitizes an error message ensuring the API key is never leaked.
 */
function sanitizeErrorMessage(message: string, apiKey?: string): string {
  if (!message) return 'Unknown error occurred';
  let sanitized = message;
  if (apiKey && apiKey.trim().length > 0) {
    sanitized = sanitized.split(apiKey).join('[REDACTED]');
  }
  return sanitized;
}

/**
 * Maps Gemini finishReason string to standard AIFinishReason.
 */
function mapFinishReason(rawReason?: string): AIFinishReason | undefined {
  if (!rawReason) return 'completed';
  switch (rawReason.toUpperCase()) {
    case 'STOP':
      return 'completed';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'blocked';
    case 'CANCELLED':
      return 'cancelled';
    case 'OTHER':
    default:
      return 'unknown';
  }
}

/**
 * Concrete implementation of the Gemini AIProvider.
 */
class GeminiAIProvider implements AIProvider {
  readonly id = GEMINI_PROVIDER_ID;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpointBaseUrl: string;

  constructor(config: GeminiAIProviderConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new Error('Gemini AI Provider requires a non-empty apiKey.');
    }
    this.apiKey = config.apiKey.trim();
    this.model = config.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.endpointBaseUrl =
      config.endpointBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  async generate(request: ConversationRequest): Promise<AIProviderResult> {
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      return createAIProviderFailure(
        createAIProviderError(
          'invalid_request',
          'Gemini provider requires a valid ConversationRequest with non-empty messages.',
          false
        )
      );
    }

    const url = `${this.endpointBaseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;

    const contents = request.messages.map((turn) => ({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    }));

    const bodyPayload: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: 1000,
      },
    };

    if (request.systemPrompt && request.systemPrompt.trim().length > 0) {
      bodyPayload.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(bodyPayload),
      });

      if (!response.ok) {
        return this.handleHttpError(response.status, await this.safeReadText(response));
      }

      const resJson = await response.json().catch(() => null);
      if (!resJson || typeof resJson !== 'object') {
        return createAIProviderFailure(
          createAIProviderError(
            'unknown',
            'Received malformed JSON response from Gemini service.',
            false
          )
        );
      }

      // Check candidates
      const candidate = resJson.candidates?.[0];
      if (!candidate) {
        const blockReason = resJson.promptFeedback?.blockReason;
        const msg = blockReason
          ? `Request was blocked by Gemini safety filters (${blockReason}).`
          : 'Gemini returned an empty candidates list.';
        return createAIProviderFailure(
          createAIProviderError('unknown', msg, false)
        );
      }

      // Extract parts text
      const parts = candidate.content?.parts;
      const text = Array.isArray(parts)
        ? parts.map((p: { text?: string }) => p.text || '').join('')
        : '';

      if (!text || text.trim().length === 0) {
        return createAIProviderFailure(
          createAIProviderError(
            'unknown',
            'Gemini candidate contains no text content.',
            false
          )
        );
      }

      const finishReason = mapFinishReason(candidate.finishReason);

      let usage: AIUsage | undefined;
      if (resJson.usageMetadata && typeof resJson.usageMetadata === 'object') {
        const u = resJson.usageMetadata;
        if (
          typeof u.promptTokenCount === 'number' ||
          typeof u.candidatesTokenCount === 'number' ||
          typeof u.totalTokenCount === 'number'
        ) {
          usage = {
            ...(typeof u.promptTokenCount === 'number' && { inputTokens: u.promptTokenCount }),
            ...(typeof u.candidatesTokenCount === 'number' && { outputTokens: u.candidatesTokenCount }),
            ...(typeof u.totalTokenCount === 'number' && { totalTokens: u.totalTokenCount }),
          };
        }
      }

      const aiResponse = createAIProviderResponse(text, {
        finishReason,
        usage,
      });

      return createAIProviderSuccess(aiResponse);
    } catch (err: unknown) {
      return this.handleNetworkException(err);
    }
  }

  private handleHttpError(status: number, responseBody: string): AIProviderResult {
    let code: AIProviderErrorCode = 'unknown';
    let retryable = false;

    if (status === 400) {
      code = 'invalid_request';
      retryable = false;
    } else if (status === 401 || status === 403) {
      code = 'authentication';
      retryable = false;
    } else if (status === 429) {
      code = 'rate_limit';
      retryable = true;
    } else if (status >= 500 && status < 600) {
      code = 'unavailable';
      retryable = true;
    }

    let parsedMessage = `Gemini request failed with HTTP status ${status}.`;
    if (responseBody) {
      try {
        const parsed = JSON.parse(responseBody);
        if (parsed?.error?.message && typeof parsed.error.message === 'string') {
          parsedMessage = parsed.error.message;
        }
      } catch {
        parsedMessage = responseBody.slice(0, 200);
      }
    }

    const sanitizedMessage = sanitizeErrorMessage(parsedMessage, this.apiKey);

    return createAIProviderFailure(
      createAIProviderError(code, sanitizedMessage, retryable)
    );
  }

  private handleNetworkException(err: unknown): AIProviderResult {
    let code: AIProviderErrorCode = 'unavailable';
    let retryable = true;
    let message = 'Network request to Gemini service failed.';

    if (err instanceof Error) {
      const lower = err.message.toLowerCase();
      if (
        err.name === 'AbortError' ||
        lower.includes('timeout') ||
        lower.includes('aborted')
      ) {
        code = 'timeout';
        retryable = true;
        message = 'Request to Gemini timed out.';
      } else {
        message = err.message;
      }
    }

    return createAIProviderFailure(
      createAIProviderError(code, sanitizeErrorMessage(message, this.apiKey), retryable)
    );
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}

/**
 * Factory for creating a Gemini AIProvider instance.
 */
export function createGeminiAIProvider(config: GeminiAIProviderConfig): AIProvider {
  return new GeminiAIProvider(config);
}
