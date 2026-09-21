/**
 * Package 2 (J) — provider request / quota diagnostics.
 *
 * Verifies the INTERNAL dev/debug counters: typed request counting (incl.
 * model id and token usage when the provider returns it), quota (429)
 * flagging, automatic-retry counting, disabled-by-default behaviour and the
 * hard privacy rule — never an API key, transcript, prompt or audio payload.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const speechBehavior = vi.hoisted(() => ({ mode: 'done' as 'done' | 'error' }));
vi.mock('expo-speech', () => ({
  speak: (
    _text: string,
    opts: { onDone?: () => void; onError?: (err: Error) => void },
  ) => {
    if (speechBehavior.mode === 'error') opts.onError?.(new Error('playback failed'));
    else opts.onDone?.();
  },
  stop: async () => {},
}));

import {
  beginRequestDiagnostics,
  getRequestDiagnosticsLog,
  getRequestDiagnosticsSummary,
  noteAutomaticRetry,
  resetRequestDiagnostics,
  setRequestDiagnosticsEnabled,
} from './request-diagnostics';
import { createGeminiAIProvider } from './ai/gemini';
import { GeminiSTTProvider } from './stt/gemini';
import { ExpoTTSProvider } from './tts/expo';
import { runWithSafeRetry } from '../shared/safe-retry';
import type { ConversationRequest } from '../conversation-engine';

const API_KEY = 'SECRET-KEY-abc123';

function requestWith(diagnosticsType?: ConversationRequest['diagnosticsType']): ConversationRequest {
  return {
    systemPrompt: 'SYSTEM-PROMPT-SECRET-CONTENT',
    messages: [{ role: 'user', content: 'PROMPT-BODY-SECRET' }],
    mode: 'coach',
    topic: 'Diagnostics test',
    coachingContext: {} as ConversationRequest['coachingContext'],
    ...(diagnosticsType ? { diagnosticsType } : {}),
  };
}

function stubFetch(response: {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
}): typeof fetch {
  return vi.fn(async () => ({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: async () => JSON.stringify(response.body),
    json: async () => response.body,
  })) as unknown as typeof fetch;
}

const SUCCESS_BODY = {
  candidates: [
    { content: { parts: [{ text: 'Hello there.' }] }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
};

beforeEach(() => {
  setRequestDiagnosticsEnabled(true);
  resetRequestDiagnostics();
  speechBehavior.mode = 'done';
});

afterAll(() => {
  setRequestDiagnosticsEnabled(null);
});

describe('provider request diagnostics', () => {
  it('counts a tutor-text request with model, timing and provider-reported usage', async () => {
    const provider = createGeminiAIProvider({ apiKey: API_KEY, fetchImpl: stubFetch({ ok: true, status: 200, statusText: 'OK', body: SUCCESS_BODY }) });
    const result = await provider.generate(requestWith('dictionary'));
    expect(result.ok).toBe(true);
    const log = getRequestDiagnosticsLog();
    expect(log).toHaveLength(1);
    expect(log[0].type).toBe('dictionary');
    expect(log[0].providerId).toBe('gemini');
    expect(log[0].model).toBeTruthy();
    expect(log[0].ok).toBe(true);
    expect(log[0].failureKind).toBeNull();
    expect(log[0].rateLimited).toBe(false);
    expect(log[0].durationMs).not.toBeNull();
    expect(log[0].endedAt).not.toBeNull();
    expect(log[0].usage?.totalTokens).toBe(16);
  });

  it('defaults unlabelled provider requests to tutor_text', async () => {
    const provider = createGeminiAIProvider({ apiKey: API_KEY, fetchImpl: stubFetch({ ok: true, status: 200, statusText: 'OK', body: SUCCESS_BODY }) });
    await provider.generate(requestWith());
    expect(getRequestDiagnosticsLog()[0].type).toBe('tutor_text');
  });

  it('flags quota (429) failures as rate limited', async () => {
    const provider = createGeminiAIProvider({
      apiKey: API_KEY,
      fetchImpl: stubFetch({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: { error: { message: 'RESOURCE_EXHAUSTED: quota exceeded' } },
      }),
    });
    const result = await provider.generate(requestWith('lesson_generation'));
    expect(result.ok).toBe(false);
    const entry = getRequestDiagnosticsLog()[0];
    expect(entry.type).toBe('lesson_generation');
    expect(entry.ok).toBe(false);
    expect(entry.rateLimited).toBe(true);
    expect(entry.failureKind).toBe('rate_limit');
    expect(entry.usage).toBeNull();
  });

  it('counts STT transcription requests', async () => {
    const stt = new GeminiSTTProvider({
      apiKey: API_KEY,
      fetchImpl: stubFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: { candidates: [{ content: { parts: [{ text: 'TRANSCRIPT-SECRET hello' }] } }] },
      }),
    });
    const result = await stt.transcribe({ base64: 'QUFESU8tU0VDUkVU' });
    expect(result.ok).toBe(true);
    const entry = getRequestDiagnosticsLog()[0];
    expect(entry.type).toBe('stt');
    expect(entry.providerId).toBe('gemini-stt');
    expect(entry.ok).toBe(true);
  });

  it('does not count local STT validation failures as provider requests', async () => {
    const stt = new GeminiSTTProvider({ apiKey: API_KEY, fetchImpl: stubFetch({ ok: true, status: 200, statusText: 'OK', body: SUCCESS_BODY }) });
    const result = await stt.transcribe({ base64: '' });
    expect(result.ok).toBe(false);
    expect(getRequestDiagnosticsLog()).toHaveLength(0);
  });

  it('counts local TTS playback success and failure', async () => {
    const tts = new ExpoTTSProvider();
    await tts.speak('SPOKEN-TEXT-SECRET');
    expect(getRequestDiagnosticsLog()[0]).toMatchObject({ type: 'tts', ok: true });

    resetRequestDiagnostics();
    speechBehavior.mode = 'error';
    await tts.speak('SPOKEN-TEXT-SECRET');
    const entry = getRequestDiagnosticsLog()[0];
    expect(entry.type).toBe('tts');
    expect(entry.ok).toBe(false);
    expect(entry.failureKind).toBe('playback_error');
    expect(entry.rateLimited).toBe(false);
  });

  it('counts automatic retries per type, and never retries quota failures', async () => {
    let attempt = 0;
    const outcome = await runWithSafeRetry<string>({
      diagnosticsType: 'tutor_text',
      committed: () => false,
      sleep: async () => {},
      run: async () => {
        attempt += 1;
        return attempt === 1 ? 'Service is busy, try again later' : 'done';
      },
      failureOf: result => (result === 'done' ? null : result),
    });
    expect(outcome.attempts).toBe(2);
    const summary = getRequestDiagnosticsSummary().find(s => s.type === 'tutor_text');
    expect(summary?.automaticRetries).toBe(1);

    resetRequestDiagnostics();
    const quota = await runWithSafeRetry<string>({
      diagnosticsType: 'tutor_text',
      committed: () => false,
      sleep: async () => {},
      run: async () => '429 quota exceeded',
      failureOf: result => result,
    });
    expect(quota.attempts).toBe(1);
    expect(getRequestDiagnosticsSummary().find(s => s.type === 'tutor_text')?.automaticRetries ?? 0).toBe(0);
  });

  it('is disabled by default outside development and records nothing', () => {
    setRequestDiagnosticsEnabled(null);
    const g = globalThis as { __DEV__?: unknown; __REQUEST_DIAGNOSTICS__?: unknown };
    const dev = g.__DEV__;
    const optIn = g.__REQUEST_DIAGNOSTICS__;
    g.__DEV__ = undefined;
    g.__REQUEST_DIAGNOSTICS__ = undefined;
    try {
      expect(beginRequestDiagnostics({ type: 'tutor_text' })).toBeNull();
      noteAutomaticRetry('stt');
      expect(getRequestDiagnosticsLog()).toHaveLength(0);
      expect(getRequestDiagnosticsSummary()).toHaveLength(0);
    } finally {
      g.__DEV__ = dev;
      g.__REQUEST_DIAGNOSTICS__ = optIn;
      setRequestDiagnosticsEnabled(true);
    }
  });

  it('never records API keys, prompts, transcripts or audio payloads', async () => {
    const provider = createGeminiAIProvider({ apiKey: API_KEY, fetchImpl: stubFetch({ ok: true, status: 200, statusText: 'OK', body: SUCCESS_BODY }) });
    await provider.generate(requestWith('dictionary'));
    const stt = new GeminiSTTProvider({
      apiKey: API_KEY,
      fetchImpl: stubFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: { candidates: [{ content: { parts: [{ text: 'TRANSCRIPT-SECRET hello' }] } }] },
      }),
    });
    await stt.transcribe({ base64: 'QUFESU8tU0VDUkVU' });
    const serialized = JSON.stringify(getRequestDiagnosticsLog());
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('SYSTEM-PROMPT-SECRET-CONTENT');
    expect(serialized).not.toContain('PROMPT-BODY-SECRET');
    expect(serialized).not.toContain('TRANSCRIPT-SECRET');
    expect(serialized).not.toContain('QUFESU8tU0VDUkVU');
  });
});
