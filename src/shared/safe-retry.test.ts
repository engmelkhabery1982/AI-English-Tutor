/**
 * src/shared/safe-retry.test.ts
 *
 * Tests for the ONE conservative retry policy (Work Order 1, item 4).
 *
 * Pinned behaviour
 * - at most ONE short automatic retry, and never a retry loop;
 * - only transient classes are replayed (service busy / timeout / connection);
 * - quota, credential, configuration, content-block and our own cancellations are
 *   NEVER replayed automatically — the learner decides via an explicit Retry;
 * - a provider that reports `retryable: false` is authoritative;
 * - nothing is replayed once work MAY have been committed (uncertain commit
 *   state), because a replay could duplicate a learner turn;
 * - exceptions are not swallowed: the caller owns the honest failure result.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  canLearnerRetry,
  DEFAULT_AUTOMATIC_RETRY_DELAY_MS,
  DEFAULT_MAX_AUTOMATIC_RETRIES,
  runWithSafeRetry,
  type SafeRetryAttempt,
} from './safe-retry';
import { classifyProviderFailure } from '../providers/failures';

interface StubResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly retryable?: boolean;
}

const ok = (): StubResult => ({ ok: true });
const fail = (error: string, retryable?: boolean): StubResult => ({
  ok: false,
  error,
  ...(retryable === undefined ? {} : { retryable }),
});

/** Collects the attempts and an injectable sleep so no test waits in real time. */
function harness(results: readonly StubResult[]) {
  const attempts: SafeRetryAttempt[] = [];
  const sleeps: number[] = [];
  let index = 0;
  return {
    attempts,
    sleeps,
    run: async (attempt: SafeRetryAttempt): Promise<StubResult> => {
      attempts.push(attempt);
      const result = results[Math.min(index, results.length - 1)] ?? ok();
      index += 1;
      return result;
    },
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
    },
    failureOf: (result: StubResult) =>
      result.ok
        ? null
        : {
            message: result.error ?? null,
            ...(result.retryable === undefined ? {} : { retryable: result.retryable }),
          },
  };
}

describe('runWithSafeRetry — the single automatic retry', () => {
  it('runs once and reports success without retrying', async () => {
    const stub = harness([ok()]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(outcome.automaticRetries).toBe(0);
    expect(outcome.failure).toBeNull();
    expect(outcome.blockedByCommitState).toBe(false);
    expect(stub.attempts).toEqual([{ index: 1, automatic: false }]);
    expect(stub.sleeps).toEqual([]);
  });

  it('replays ONE transient failure and stops after a short delay', async () => {
    const stub = harness([fail('Service unavailable, please try again later'), ok()]);
    const onAutomaticRetry = vi.fn();
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
      surface: 'tutor',
      onAutomaticRetry,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.automaticRetries).toBe(1);
    expect(stub.attempts).toEqual([
      { index: 1, automatic: false },
      { index: 2, automatic: true },
    ]);
    expect(stub.sleeps).toEqual([DEFAULT_AUTOMATIC_RETRY_DELAY_MS]);
    expect(onAutomaticRetry).toHaveBeenCalledTimes(1);
    expect(onAutomaticRetry.mock.calls[0]?.[0]).toMatchObject({ nextAttempt: 2 });
  });

  it('never turns into a retry loop when the failure persists', async () => {
    const stub = harness([fail('Request timed out after 20000ms')]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(2);
    expect(outcome.automaticRetries).toBe(1);
    expect(outcome.failure?.kind).toBe('timeout');
    expect(stub.attempts).toHaveLength(2);
  });

  it('still performs at most ONE retry even if a caller asks for more', async () => {
    const stub = harness([fail('Network request failed')]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
      maxAutomaticRetries: 5,
    });

    expect(outcome.attempts).toBe(2);
    expect(DEFAULT_MAX_AUTOMATIC_RETRIES).toBe(1);
  });

  it('can be configured to never retry automatically', async () => {
    const stub = harness([fail('Network request failed')]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
      maxAutomaticRetries: 0,
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.automaticRetries).toBe(0);
    expect(outcome.ok).toBe(false);
  });

  it('skips the delay entirely when delayMs is 0', async () => {
    const stub = harness([fail('socket hang up'), ok()]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
      delayMs: 0,
    });

    expect(outcome.ok).toBe(true);
    expect(stub.sleeps).toEqual([]);
  });
});

describe('runWithSafeRetry — classes that are never replayed automatically', () => {
  const NEVER_RETRIED: readonly [string, string][] = [
    ['quota / 429', 'Gemini request failed with status 429: You exceeded your current quota'],
    ['rejected credential', 'Gemini request failed with status 403: API key not valid'],
    ['not configured', 'No AI provider is configured on this device, so the tutor cannot answer.'],
    ['malformed payload', 'Gemini response contained empty candidates'],
    ['no speech recognised', 'Audio too short or silent'],
    ['content blocked', 'The response was blocked by a safety filter'],
    ['our own cancellation', 'This conversation was replaced before the turn finished, so the turn was discarded.'],
    ['unknown', 'pipeline stage 3 returned undefined for candidate[0].parts'],
  ];

  it.each(NEVER_RETRIED)('does not auto-retry %s', (_label, message) => {
    return (async () => {
      const stub = harness([fail(message)]);
      const outcome = await runWithSafeRetry<StubResult>({
        run: stub.run,
        failureOf: stub.failureOf,
        sleep: stub.sleep,
      });
      expect(outcome.attempts).toBe(1);
      expect(outcome.automaticRetries).toBe(0);
      expect(outcome.ok).toBe(false);
      expect(outcome.failure).not.toBeNull();
    })();
  });

  it('honours a provider that reports the failure as not retryable', async () => {
    const stub = harness([fail('Service unavailable, try again later', false)]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.failure?.retryable).toBe(false);
    expect(outcome.failure?.autoRetryable).toBe(false);
  });
});

describe('runWithSafeRetry — commit-state protection', () => {
  it('refuses the automatic replay once work may have committed', async () => {
    const stub = harness([fail('Service unavailable, try again later')]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
      committed: () => true,
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.automaticRetries).toBe(0);
    expect(outcome.blockedByCommitState).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(stub.sleeps).toEqual([]);
  });

  it('re-evaluates the commit state at failure time, not at start', async () => {
    let committed = false;
    const stub = harness([fail('Request timed out'), ok()]);
    // The first attempt streamed reply content: the commit state is uncertain now.
    const run = async (attempt: SafeRetryAttempt): Promise<StubResult> => {
      const result = await stub.run(attempt);
      if (attempt.index === 1) committed = true;
      return result;
    };
    const outcome = await runWithSafeRetry<StubResult>({
      run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
      committed: () => committed,
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.blockedByCommitState).toBe(true);
  });

  it('replays when the commit state proves nothing was committed', async () => {
    let committedTurns = 0;
    const stub = harness([fail('Network request failed'), ok()]);
    const outcome = await runWithSafeRetry<StubResult>({
      run: stub.run,
      failureOf: stub.failureOf,
      sleep: stub.sleep,
      committed: () => committedTurns > 0,
    });

    expect(committedTurns).toBe(0);
    expect(outcome.attempts).toBe(2);
    expect(outcome.ok).toBe(true);
    expect(outcome.blockedByCommitState).toBe(false);
  });
});

describe('runWithSafeRetry — failures are never swallowed', () => {
  it('propagates an exception so the caller reports it honestly', async () => {
    await expect(
      runWithSafeRetry<StubResult>({
        run: async () => {
          throw new Error('socket hang up');
        },
        failureOf: () => null,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('socket hang up');
  });

  it('treats an empty failure text as a success (nothing to classify)', async () => {
    const outcome = await runWithSafeRetry<StubResult>({
      run: async () => ({ ok: false, error: '   ' }),
      failureOf: (result) => (result.ok ? null : (result.error ?? null)),
      sleep: async () => undefined,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.failure).toBeNull();
  });
});

describe('canLearnerRetry — the explicit learner Retry decision', () => {
  it('allows a Retry for failures that can still work', () => {
    expect(canLearnerRetry(classifyProviderFailure('Request timed out', 'tutor'))).toBe(true);
    expect(
      canLearnerRetry(classifyProviderFailure('status 429 quota exceeded', 'tutor')),
    ).toBe(true);
    expect(canLearnerRetry(classifyProviderFailure('Audio too short or silent', 'speech'))).toBe(true);
  });

  it('refuses a Retry for our own cancellation and for configuration problems', () => {
    expect(
      canLearnerRetry(
        classifyProviderFailure(
          'This conversation was replaced before the turn finished, so the turn was discarded.',
          'tutor',
        ),
      ),
    ).toBe(false);
    expect(
      canLearnerRetry(classifyProviderFailure('status 403 API key not valid', 'tutor')),
    ).toBe(false);
  });

  it('refuses a Retry when there is no failure at all', () => {
    expect(canLearnerRetry(null)).toBe(false);
  });
});
