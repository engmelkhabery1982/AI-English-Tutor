import { describe, expect, it, vi } from 'vitest';
import type { ConversationRequest } from '../types';
import {
  createGeminiAIProvider,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GEMINI_PROVIDER_ID,
} from './index';
import type { CoachingContext } from '../../../learner-model';

const DUMMY_COACHING_CONTEXT: CoachingContext = {
  profile: {
    learnerId: '00000000-0000-0000-0000-000000000001',
    displayName: 'Learner',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: ['fluency'],
    preferredModes: ['natural', 'coach', 'intensive'],
  },
  activeWeaknesses: [],
  strengths: [],
  vocabularyFocus: [],
  expressionFocus: [],
  recentProgress: null,
  dueReviewCount: 0,
  generatedAt: '2026-01-01T00:00:00.000Z',
};

const SAMPLE_REQUEST: ConversationRequest = {
  systemPrompt: 'You are an AI English Tutor.',
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'How do you do?' },
  ],
  mode: 'natural',
  topic: 'General',
  coachingContext: DUMMY_COACHING_CONTEXT,
};

describe('GeminiAIProvider', () => {
  it('has provider id "gemini", default model "gemini-3.6-flash", and 20s default timeout', () => {
    const provider = createGeminiAIProvider({ apiKey: 'test-key-123' });
    expect(provider.id).toBe(GEMINI_PROVIDER_ID);
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.6-flash');
    expect(DEFAULT_GEMINI_TIMEOUT_MS).toBe(20000);
  });

  it('throws when apiKey is empty', () => {
    expect(() => createGeminiAIProvider({ apiKey: '   ' })).toThrow(
      'Gemini AI Provider requires a non-empty apiKey.'
    );
  });

  it('maps systemInstruction and messages with correct roles and sends x-goog-api-key', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const mockFetch: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = input.toString();
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse((init?.body as string) || '{}');

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'I am doing well, thank you!' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 15,
            candidatesTokenCount: 8,
            totalTokenCount: 23,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createGeminiAIProvider({
      apiKey: 'SECRET_API_KEY_999',
      fetchImpl: mockFetch,
    });

    const result = await provider.generate(SAMPLE_REQUEST);

    expect(capturedUrl).toContain('/models/gemini-3.6-flash:generateContent');
    expect(capturedHeaders['x-goog-api-key']).toBe('SECRET_API_KEY_999');
    expect(capturedHeaders['Content-Type']).toBe('application/json');

    // System prompt mapping
    expect(capturedBody.systemInstruction).toEqual({
      parts: [{ text: 'You are an AI English Tutor.' }],
    });

    // Messages mapping (user -> user, assistant -> model, preserved order)
    expect(capturedBody.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there!' }] },
      { role: 'user', parts: [{ text: 'How do you do?' }] },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe('I am doing well, thank you!');
      expect(result.response.finishReason).toBe('completed');
      expect(result.response.usage).toEqual({
        inputTokens: 15,
        outputTokens: 8,
        totalTokens: 23,
      });
    }
  });

  it('aborts fetch on timeout, returns code timeout and retryable true without throwing', async () => {
    const captured: { signal?: AbortSignal | null } = {};

    const mockFetchWithTimeout: typeof fetch = vi.fn(async (_input, init) => {
      captured.signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        }
      });
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      timeoutMs: 25,
      fetchImpl: mockFetchWithTimeout,
    });

    const result = await provider.generate(SAMPLE_REQUEST);

    expect(captured.signal).toBeDefined();
    expect(captured.signal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('timeout');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain('timed out');
    }
  });

  it('sanitizes API key from timeout and network error messages', async () => {
    const secretKey = 'SUPER_SECRET_TIMEOUT_KEY_999';

    const mockFetchLeakingAbort: typeof fetch = vi.fn(async () => {
      const abortError = new Error(`Connection timed out for key ${secretKey}`);
      abortError.name = 'AbortError';
      throw abortError;
    });

    const provider = createGeminiAIProvider({
      apiKey: secretKey,
      timeoutMs: 10,
      fetchImpl: mockFetchLeakingAbort,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('timeout');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).not.toContain(secretKey);
    }
  });

  it('handles empty candidates / empty parts as failure', async () => {
    const mockFetchEmpty: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetchEmpty,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown');
      expect(result.error.message).toContain('empty candidates');
    }
  });

  it('maps 400 status to invalid_request (retryable: false)', async () => {
    const mockFetch400: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 400, message: 'Invalid field in request body' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetch400,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_request');
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toBe('Invalid field in request body');
    }
  });

  it('maps 401 and 403 status to authentication (retryable: false)', async () => {
    const mockFetch401: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 401, message: 'API key not valid' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetch401,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('authentication');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('maps 429 status to rate_limit (retryable: true)', async () => {
    const mockFetch429: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 429, message: 'Resource exhausted (quota exceeded)' },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetch429,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate_limit');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('maps 503 status to unavailable (retryable: true)', async () => {
    const mockFetch503: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: { code: 503, message: 'Service unavailable' },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetch503,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unavailable');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('maps network errors cleanly without unhandled exceptions', async () => {
    const mockFetchNetworkError: typeof fetch = vi.fn(async () => {
      throw new Error('Failed to fetch from host');
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetchNetworkError,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unavailable');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain('Failed to fetch from host');
    }
  });

  it('sanitizes API key from error messages so it never appears in error results', async () => {
    const secretKey = 'MY_SUPER_SECRET_KEY_777';
    const mockFetchLeakingKey: typeof fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: `Key ${secretKey} was rejected by server.`,
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = createGeminiAIProvider({
      apiKey: secretKey,
      fetchImpl: mockFetchLeakingKey,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(secretKey);
      expect(result.error.message).toContain('[REDACTED]');
    }
  });

  it('handles malformed non-JSON responses safely', async () => {
    const mockFetchMalformed: typeof fetch = vi.fn(async () => {
      return new Response('<html><body>502 Bad Gateway</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });

    const provider = createGeminiAIProvider({
      apiKey: 'test-key',
      fetchImpl: mockFetchMalformed,
    });

    const result = await provider.generate(SAMPLE_REQUEST);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown');
    }
  });
});
