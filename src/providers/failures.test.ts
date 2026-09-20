/**
 * src/providers/failures.test.ts
 *
 * Tests for the ONE provider-failure path (Work Order 1, item 2).
 *
 * What is pinned here
 * - every failure class named in the work order (429, 503, timeout, network,
 *   invalid credential, malformed response, STT no-speech, unknown) maps to a
 *   bounded kind with a concise, actionable, learner-safe sentence;
 * - a raw provider payload (JSON, HTTP status line, quota object, stack trace,
 *   key material) can NEVER become the learner-facing message, but stays
 *   available as bounded diagnostic detail;
 * - honest app-owned wording (conversation lifecycle, configuration notices,
 *   microphone permission) is preserved verbatim instead of being flattened;
 * - the retry policy is conservative: quota/credential/configuration/cancelled
 *   failures are never auto-retried, and a provider that reports
 *   `retryable: false` is authoritative.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  isConfigurationFailure,
  isLearnerSafeMessage,
  isReplacementFailure,
  isTransientProviderFailure,
  learnerMessageForFailure,
  PROVIDER_FAILURE_MESSAGES,
  toTechnicalDetail,
  type ProviderFailureKind,
  type ProviderFailureSurface,
} from './failures';
import {
  CONVERSATION_ABANDONED_MESSAGE,
  CONVERSATION_OPENING_DISCARDED_MESSAGE,
} from '../conversation-session';

const SURFACES: readonly ProviderFailureSurface[] = [
  'speech',
  'tutor',
  'practice',
  'assessment',
  'generic',
];

describe('provider failure classification — every class named in the work order', () => {
  it('maps HTTP 429 / quota to rate_limited and never auto-retries it', () => {
    const failure = classifyProviderFailure(
      { message: 'Gemini request failed with status 429: {"error":{"code":429,"message":"You exceeded your current quota"}}' },
      'tutor',
    );
    expect(failure.kind).toBe('rate_limited');
    expect(failure.httpStatus).toBe(429);
    expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.rate_limited.tutor);
    expect(failure.autoRetryable).toBe(false);
    expect(isTransientProviderFailure(failure)).toBe(false);
    expect(failure.inputPreserved).toBe(true);
    // The raw quota object stays diagnostic only.
    expect(failure.message).not.toContain('quota');
    expect(failure.message).not.toContain('{');
    expect(failure.technical).toContain('429');
  });

  it('maps HTTP 503 / overloaded to service_busy and allows ONE automatic retry', () => {
    const failure = classifyProviderFailure(
      { message: 'Gemini STT request failed with status 503: service overloaded' },
      'speech',
    );
    expect(failure.kind).toBe('service_busy');
    expect(failure.httpStatus).toBe(503);
    expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.service_busy.speech);
    expect(failure.retryable).toBe(true);
    expect(failure.autoRetryable).toBe(true);
    expect(isTransientProviderFailure(failure)).toBe(true);
  });

  it('maps our own timeout to timeout', () => {
    const failure = classifyProviderFailure({ message: 'Request timed out after 20000ms' }, 'tutor');
    expect(failure.kind).toBe('timeout');
    expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.timeout.tutor);
    expect(failure.autoRetryable).toBe(true);
  });

  it('maps an interrupted connection to network', () => {
    for (const message of [
      'Failed to fetch from host generativelanguage.googleapis.com',
      'Network request failed',
      'socket hang up',
    ]) {
      const failure = classifyProviderFailure({ message }, 'tutor');
      expect(failure.kind).toBe('network');
      expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.network.tutor);
      expect(failure.autoRetryable).toBe(true);
    }
  });

  it('maps a rejected credential to invalid_credentials and points at Settings', () => {
    const failure = classifyProviderFailure(
      { message: 'Gemini request failed with status 403: API key not valid' },
      'tutor',
    );
    expect(failure.kind).toBe('invalid_credentials');
    expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.invalid_credentials.tutor);
    expect(failure.message).toContain('Settings');
    expect(failure.needsConfiguration).toBe(true);
    expect(isConfigurationFailure(failure)).toBe(true);
    // Retrying with the same rejected key cannot work.
    expect(failure.retryable).toBe(false);
    expect(failure.autoRetryable).toBe(false);
  });

  it('maps a malformed provider payload to malformed_response', () => {
    for (const message of [
      'Gemini response contained empty candidates',
      'Unexpected token < in JSON at position 0',
      'Invalid JSON payload received',
      'The reply could not be parsed',
    ]) {
      const failure = classifyProviderFailure({ message }, 'tutor');
      expect(failure.kind).toBe('malformed_response');
      expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.malformed_response.tutor);
      expect(failure.autoRetryable).toBe(false);
    }
  });

  it('maps a rejected request body (HTTP 400) to malformed_response', () => {
    const failure = classifyProviderFailure(
      { message: 'Gemini request failed with status 400: Invalid field in request body' },
      'tutor',
    );
    expect(failure.httpStatus).toBe(400);
    expect(failure.kind).toBe('malformed_response');
    expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.malformed_response.tutor);
    expect(failure.message).not.toContain('Invalid field');
  });

  it('maps STT no-speech to unrecognized_speech with a type-instead option', () => {
    for (const message of ['Audio too short or silent', 'No speech was recognized', 'Audio was not clear']) {
      const failure = classifyProviderFailure({ message }, 'speech');
      expect(failure.kind).toBe('unrecognized_speech');
      expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.unrecognized_speech.speech);
      expect(failure.message.toLowerCase()).toContain('type your answer');
      expect(failure.autoRetryable).toBe(false);
    }
  });

  it('maps anything unrecognised to unknown and keeps honest app wording', () => {
    // An already-safe app-owned sentence is preserved verbatim (the catalog must
    // not flatten honest domain wording such as "This speaking task is not
    // available." into generic provider text).
    const preserved = classifyProviderFailure(
      { message: 'This speaking task is not available.' },
      'practice',
    );
    expect(preserved.kind).toBe('unknown');
    expect(preserved.message).toBe('This speaking task is not available.');
    expect(preserved.autoRetryable).toBe(false);

    // Anything technical (or too long) falls back to the bounded catalog sentence.
    const catalog = classifyProviderFailure(
      { message: 'pipeline stage 3 returned undefined for candidate[0].parts' },
      'assessment',
    );
    expect(catalog.kind).toBe('unknown');
    expect(catalog.message).toBe(PROVIDER_FAILURE_MESSAGES.unknown.assessment);
  });

  it('classifies a missing/empty failure into the safe unknown sentence', () => {
    expect(classifyProviderFailure(null, 'tutor').kind).toBe('unknown');
    expect(classifyProviderFailure({ message: '   ' }, 'tutor').message).toBe(
      PROVIDER_FAILURE_MESSAGES.unknown.tutor,
    );
    expect(classifyProviderFailure(undefined, 'speech').message).toBe(
      PROVIDER_FAILURE_MESSAGES.unknown.speech,
    );
  });
});

describe('provider failure classification — raw payloads never reach the learner', () => {
  const RAW_PAYLOADS: readonly string[] = [
    '{"error":{"code":429,"message":"You exceeded your current quota.","status":"RESOURCE_EXHAUSTED"}}',
    'HTTP 500 Internal Server Error\n  at async Object.<anonymous> (src/providers/ai/gemini/index.ts:88:11)',
    'Gemini request failed with status 400: {"error":{"code":400,"message":"Invalid JSON payload received"}}',
    'TypeError: Cannot read properties of undefined (reading "candidates")',
    'usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 0 } finishReason: SAFETY',
  ];

  it.each(RAW_PAYLOADS)('keeps a learner-safe sentence for %s', (raw) => {
    const failure = classifyProviderFailure({ message: raw }, 'tutor');
    expect(failure.message.length).toBeLessThanOrEqual(180);
    expect(failure.message).not.toMatch(/[{}\[\]]/);
    expect(failure.message).not.toMatch(/\n/);
    expect(failure.message).not.toMatch(/at\s+async|TypeError|candidates|usageMetadata|finishReason/i);
    expect(failure.message).not.toMatch(/https?:\/\//);
    expect(isLearnerSafeMessage(failure.message)).toBe(true);
    // …while the diagnostic detail is preserved (bounded, single line).
    expect(failure.technical).not.toBeNull();
    expect(failure.technical).not.toMatch(/\n/);
  });

  it('never renders a message that contains technical markers, even for app-owned kinds', () => {
    // "unknown" preserves app wording ONLY when that wording is already safe.
    const failure = classifyProviderFailure(
      { message: 'TypeError: undefined is not an object (evaluating "result.text")' },
      'generic',
    );
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toBe(PROVIDER_FAILURE_MESSAGES.unknown.generic);
    expect(failure.message).not.toContain('TypeError');
  });

  it('redacts a long secret-looking token in the diagnostic detail', () => {
    const detail = toTechnicalDetail('key=AIzaSyABCDEFGH1234567890abcdefghijklmno failed');
    expect(detail).toContain('[REDACTED]');
    expect(detail).not.toContain('AIzaSyABCDEFGH1234567890abcdefghijklmno');
  });

  it('bounds the diagnostic detail', () => {
    const detail = toTechnicalDetail('x'.repeat(4000));
    expect(detail).not.toBeNull();
    expect((detail ?? '').length).toBeLessThanOrEqual(241);
  });
});

describe('provider failure classification — honest app-owned wording is preserved', () => {
  it('preserves the conversation-replaced lifecycle message verbatim', () => {
    const failure = classifyProviderFailure({ message: CONVERSATION_ABANDONED_MESSAGE }, 'tutor');
    expect(failure.kind).toBe('replaced');
    expect(failure.message).toBe(CONVERSATION_ABANDONED_MESSAGE);
    expect(isReplacementFailure(failure)).toBe(true);
    // Our own cancellation is never replayed automatically.
    expect(failure.retryable).toBe(false);
    expect(failure.autoRetryable).toBe(false);
  });

  it('preserves the discarded-opening lifecycle message verbatim', () => {
    const failure = classifyProviderFailure(
      { code: 'cancelled', message: CONVERSATION_OPENING_DISCARDED_MESSAGE },
      'tutor',
    );
    expect(failure.kind).toBe('replaced');
    expect(failure.message).toBe(CONVERSATION_OPENING_DISCARDED_MESSAGE);
  });

  it('preserves the honest no-provider-configured notice', () => {
    const message = 'No AI provider is configured on this device, so the tutor cannot answer.';
    const failure = classifyProviderFailure({ message, retryable: false }, 'tutor');
    expect(failure.kind).toBe('not_configured');
    expect(failure.message).toBe(message);
    expect(failure.needsConfiguration).toBe(true);
    expect(failure.retryable).toBe(false);
  });

  it('treats microphone permission as a device permission, never as a credential', () => {
    const failure = classifyProviderFailure(
      { message: 'Microphone permission is required to record your answer.' },
      'speech',
    );
    expect(failure.kind).not.toBe('invalid_credentials');
    expect(failure.needsConfiguration).toBe(false);
    // The learner keeps the honest wording that the permission UI relies on.
    expect(failure.message).toContain('Microphone permission is required');
    expect(/permission|microphone access/i.test(failure.message)).toBe(true);
  });

  it('maps a bare "unavailable" code with configuration wording to not_configured', () => {
    const failure = classifyProviderFailure(
      { code: 'unavailable', message: 'Speech recognition is not configured on this device.' },
      'speech',
    );
    expect(failure.kind).toBe('not_configured');
    expect(failure.message).toContain('not configured');
  });
});

describe('provider failure classification — inputs, surfaces and retry policy', () => {
  it('accepts a plain string, an AIProviderError shape and an STTResult shape', () => {
    expect(classifyProviderFailure('Request timed out', 'tutor').kind).toBe('timeout');
    expect(
      classifyProviderFailure({ code: 'rate_limit', message: 'Slow down', retryable: true }, 'tutor')
        .kind,
    ).toBe('rate_limited');
    // An STTResult-shaped failure carries the text under `error`.
    expect(
      classifyProviderFailure({ error: 'Audio too short or silent' }, 'speech').kind,
    ).toBe('unrecognized_speech');
    expect(
      classifyProviderFailure({ error: { message: 'Request timed out', code: 'timeout' } }, 'tutor').kind,
    ).toBe('timeout');
  });

  it('trusts an explicit httpStatus over the text', () => {
    const failure = classifyProviderFailure(
      { httpStatus: 429, message: 'Something went wrong' },
      'tutor',
    );
    expect(failure.kind).toBe('rate_limited');
    expect(failure.httpStatus).toBe(429);
  });

  it('honours a provider that reports the failure as not retryable', () => {
    const failure = classifyProviderFailure(
      { message: 'Service unavailable, try again later', retryable: false },
      'tutor',
    );
    expect(failure.kind).toBe('service_busy');
    expect(failure.retryable).toBe(false);
    expect(failure.autoRetryable).toBe(false);
  });

  it('only ever auto-retries the transient classes', () => {
    const transient: readonly ProviderFailureKind[] = ['service_busy', 'timeout', 'network'];
    const never: readonly ProviderFailureKind[] = [
      'rate_limited',
      'invalid_credentials',
      'not_configured',
      'malformed_response',
      'unrecognized_speech',
      'blocked',
      'replaced',
      'unknown',
    ];
    for (const kind of transient) {
      expect(isTransientProviderFailure(kind)).toBe(true);
    }
    for (const kind of never) {
      expect(isTransientProviderFailure(kind)).toBe(false);
    }
  });

  it('produces a distinct, complete sentence for every kind and surface', () => {
    for (const kind of Object.keys(PROVIDER_FAILURE_MESSAGES) as ProviderFailureKind[]) {
      for (const surface of SURFACES) {
        const message = PROVIDER_FAILURE_MESSAGES[kind][surface];
        expect(message.length).toBeGreaterThan(20);
        expect(message.length).toBeLessThanOrEqual(180);
        expect(isLearnerSafeMessage(message)).toBe(true);
        // Actionable: it either tells the learner what to do or where to go.
        expect(/try again|settings|type your answer|rephras|not lost|nothing was|no attempt|was not/i.test(message)).toBe(
          true,
        );
      }
    }
  });

  it('exposes learnerMessageForFailure as the single message helper', () => {
    expect(learnerMessageForFailure('Request timed out', 'practice')).toBe(
      PROVIDER_FAILURE_MESSAGES.timeout.practice,
    );
    expect(learnerMessageForFailure(null, 'practice')).toBe(
      PROVIDER_FAILURE_MESSAGES.unknown.practice,
    );
  });
});

// A classification can travel through safe-retry as a code without losing its policy.
describe('classified failure round-trip', () => {
  it.each(['rate_limited', 'service_busy', 'invalid_credentials', 'malformed_response'] as const)('preserves %s', kind => {
    expect(classifyProviderFailure({ code: kind }).kind).toBe(kind);
  });
});
