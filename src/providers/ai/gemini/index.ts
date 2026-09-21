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
  AIStreamCallback,
  AIUsage,
  ConversationRequest,
} from '../types';
import {
  createAIProviderError,
  createAIProviderFailure,
  createAIProviderResponse,
  createAIProviderSuccess,
} from '../index';
import { FeedbackStreamFilter, parseFeedbackAndContent } from '../feedback';
import {
  beginRequestDiagnostics,
  finishRequestDiagnostics,
  type RequestDiagnosticsOutcome,
} from '../../request-diagnostics';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GEMINI_PROVIDER_ID,
  type GeminiAIProviderConfig,
} from './types';

export { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_TIMEOUT_MS, GEMINI_PROVIDER_ID };
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
/** Maps a provider result onto the INTERNAL diagnostics outcome. */
function aiResultOutcome(result: AIProviderResult): RequestDiagnosticsOutcome {
  if (!result.ok) {
    return {
      ok: false,
      failureKind: result.error.code,
      rateLimited: result.error.code === 'rate_limit',
    };
  }
  return { ok: true, usage: result.response.usage ?? null };
}

class GeminiAIProvider implements AIProvider {
  readonly id = GEMINI_PROVIDER_ID;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpointBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: GeminiAIProviderConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new Error('Gemini AI Provider requires a non-empty apiKey.');
    }
    this.apiKey = config.apiKey.trim();
    this.model = config.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.endpointBaseUrl =
      config.endpointBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    this.timeoutMs =
      typeof config.timeoutMs === 'number' && config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_GEMINI_TIMEOUT_MS;
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
    // INTERNAL dev/debug request counters only — never part of the request.
    const diagnostics = beginRequestDiagnostics({
      type: request.diagnosticsType ?? 'tutor_text',
      providerId: this.id,
      model: this.model,
    });
    const result = await this.performGenerate(request);
    finishRequestDiagnostics(diagnostics, aiResultOutcome(result));
    return result;
  }

  private async performGenerate(request: ConversationRequest): Promise<AIProviderResult> {
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
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
      const rawText = Array.isArray(parts)
        ? parts.map((p: { text?: string }) => p.text || '').join('')
        : '';

      if (!rawText || rawText.trim().length === 0) {
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

      const parsedOutput = parseFeedbackAndContent(rawText);

      const aiResponse = createAIProviderResponse(parsedOutput.content, {
        feedback: parsedOutput.feedback,
        rawText: parsedOutput.rawText,
        finishReason,
        usage,
      });

      return createAIProviderSuccess(aiResponse);
    } catch (err: unknown) {
      return this.handleNetworkException(err);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async generateStream(
    request: ConversationRequest,
    onChunk: AIStreamCallback
  ): Promise<AIProviderResult> {
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      return createAIProviderFailure(
        createAIProviderError(
          'invalid_request',
          'Gemini provider requires a valid ConversationRequest with non-empty messages.',
          false
        )
      );
    }
    // INTERNAL dev/debug request counters only — never part of the request.
    const diagnostics = beginRequestDiagnostics({
      type: request.diagnosticsType ?? 'tutor_text',
      providerId: this.id,
      model: this.model,
    });
    const result = await this.performGenerateStream(request, onChunk);
    finishRequestDiagnostics(diagnostics, aiResultOutcome(result));
    return result;
  }

  private async performGenerateStream(
    request: ConversationRequest,
    onChunk: AIStreamCallback
  ): Promise<AIProviderResult> {
    const url = `${this.endpointBaseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;

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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    const filter = new FeedbackStreamFilter(onChunk);
    let lastFinishReason: AIFinishReason | undefined;
    let lastUsage: AIUsage | undefined;

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
          Accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });

      if (!response.ok) {
        return this.handleHttpError(response.status, await this.safeReadText(response));
      }

      // Check if response has readable stream body
      const body = response.body;
      if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.startsWith('data:')) {
              const jsonStr = line.slice(5).trim();
              if (jsonStr) {
                try {
                  const parsed = JSON.parse(jsonStr);
                  const candidate = parsed.candidates?.[0];
                  if (candidate) {
                    if (candidate.finishReason) {
                      lastFinishReason = mapFinishReason(candidate.finishReason);
                    }
                    const parts = candidate.content?.parts;
                    if (Array.isArray(parts)) {
                      for (const part of parts) {
                        if (typeof part.text === 'string' && part.text.length > 0) {
                          filter.push(part.text);
                        }
                      }
                    }
                  }
                  if (parsed.usageMetadata) {
                    const u = parsed.usageMetadata;
                    lastUsage = {
                      ...(typeof u.promptTokenCount === 'number' && { inputTokens: u.promptTokenCount }),
                      ...(typeof u.candidatesTokenCount === 'number' && { outputTokens: u.candidatesTokenCount }),
                      ...(typeof u.totalTokenCount === 'number' && { totalTokens: u.totalTokenCount }),
                    };
                  }
                } catch {
                  // Ignore JSON parse error on partial chunks
                }
              }
            }
          }
        }

        if (buffer.trim().length > 0) {
          const line = buffer.trim();
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (jsonStr) {
              try {
                const parsed = JSON.parse(jsonStr);
                const candidate = parsed.candidates?.[0];
                if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
                  for (const part of candidate.content.parts) {
                    if (part.text) filter.push(part.text);
                  }
                }
              } catch {
                // Ignore trailing parse error
              }
            }
          }
        }
      } else {
        // Fallback for non-stream / mock environments
        const fullText = await this.safeReadText(response);
        if (fullText.startsWith('[') || fullText.startsWith('{')) {
          try {
            const parsed = JSON.parse(fullText);
            const arrayPayload = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of arrayPayload) {
              const candidate = item.candidates?.[0];
              if (candidate) {
                if (candidate.finishReason) {
                  lastFinishReason = mapFinishReason(candidate.finishReason);
                }
                const parts = candidate.content?.parts;
                if (Array.isArray(parts)) {
                  for (const part of parts) {
                    if (typeof part.text === 'string') {
                      filter.push(part.text);
                    }
                  }
                }
              }
            }
          } catch {
            filter.push(fullText);
          }
        } else {
          // Plain text lines or SSE text fallback
          const lines = fullText.split('\n');
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.startsWith('data:')) {
              const jsonStr = line.slice(5).trim();
              if (jsonStr) {
                try {
                  const parsed = JSON.parse(jsonStr);
                  const candidate = parsed.candidates?.[0];
                  if (candidate?.content?.parts && Array.isArray(candidate.content.parts)) {
                    for (const part of candidate.content.parts) {
                      if (part.text) filter.push(part.text);
                    }
                  }
                } catch {
                  // ignore
                }
              }
            }
          }
        }
      }

      const parsedOutput = filter.finish();

      if (!parsedOutput.content && !parsedOutput.rawText) {
        return createAIProviderFailure(
          createAIProviderError(
            'unknown',
            'Gemini candidate contains no text content.',
            false
          )
        );
      }

      const aiResponse = createAIProviderResponse(parsedOutput.content, {
        feedback: parsedOutput.feedback,
        rawText: parsedOutput.rawText,
        finishReason: lastFinishReason || 'completed',
        usage: lastUsage,
      });

      return createAIProviderSuccess(aiResponse);
    } catch (err: unknown) {
      return this.handleNetworkException(err);
    } finally {
      clearTimeout(timeoutId);
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
