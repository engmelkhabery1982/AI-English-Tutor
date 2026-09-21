/**
 * src/shared/safe-retry.ts
 *
 * ONE conservative retry policy for provider work that belongs to a learner
 * turn (STT, tutor generation, practice startup).
 *
 * RULES (deliberately narrow)
 * - At most ONE short automatic retry, and only when ALL of these hold:
 *     1. nothing has been committed yet (`committed()` is false — the caller
 *        proves no learner turn/evidence exists for this operation),
 *     2. the failure class is transient (service busy / timeout / interrupted
 *        connection — see `classifyProviderFailure().autoRetryable`),
 *     3. the provider itself did not report the failure as non-retryable.
 * - Quota (429), credential, configuration, content-block and cancellation
 *   failures are NEVER replayed automatically: the learner decides via Retry.
 * - When the commit state is UNCERTAIN the operation is never replayed: the
 *   caller must ask the learner to retry explicitly, and only after verifying
 *   that nothing was committed.
 * - The helper is re-entrancy-safe per call site: it never runs two attempts
 *   concurrently, and it never retries a retry.
 *
 * It is a pure orchestration helper: no timers beyond the injected delay, no
 * provider knowledge, no persistence.
 */

import {
  classifyProviderFailure,
  type ProviderFailure,
  type ProviderFailureInput,
  type ProviderFailureSurface,
} from '../providers/failures';
import {
  noteAutomaticRetry,
  type RequestDiagnosticsType,
} from '../providers/request-diagnostics';

/** Default maximum number of AUTOMATIC retries (one — never a loop). */
export const DEFAULT_MAX_AUTOMATIC_RETRIES = 1;
/** Short pause before the single automatic retry (provider-friendly). */
export const DEFAULT_AUTOMATIC_RETRY_DELAY_MS = 400;

export interface SafeRetryAttempt {
  /** 1 for the first run, 2 for the single automatic retry. */
  readonly index: number;
  /** True when this attempt is the automatic retry. */
  readonly automatic: boolean;
}

export interface SafeRetryOptions<T> {
  /** The operation. Must be safe to call again while nothing was committed. */
  readonly run: (attempt: SafeRetryAttempt) => Promise<T>;
  /**
   * Reads the failure out of a result. Return null/undefined when the result is
   * a success. The value is classified by the ONE provider-failure path.
   */
  readonly failureOf: (result: T) => ProviderFailureInput | string | null | undefined;
  /** Wording surface used for learner messages. */
  readonly surface?: ProviderFailureSurface;
  /**
   * True once a learner turn/evidence MAY have been committed for this
   * operation. Automatic retry is then refused — the commit state is uncertain
   * or already done, and replaying could duplicate a learner turn.
   */
  readonly committed?: () => boolean;
  readonly maxAutomaticRetries?: number;
  readonly delayMs?: number;
  /** Injectable sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Observability hook for the single automatic retry. */
  readonly onAutomaticRetry?: (info: {
    readonly failure: ProviderFailure;
    readonly nextAttempt: number;
  }) => void;
  /**
   * INTERNAL dev/debug label: when set, the single automatic retry (if it
   * happens) is counted per type in src/providers/request-diagnostics.
   * Never changes retry behaviour itself.
   */
  readonly diagnosticsType?: RequestDiagnosticsType;
}

export interface SafeRetryOutcome<T> {
  /** The result of the LAST attempt that ran. */
  readonly result: T;
  /** How many attempts ran (1, or 2 with the single automatic retry). */
  readonly attempts: number;
  /** 0 or 1. */
  readonly automaticRetries: number;
  /** Classified failure of the final attempt (null when it succeeded). */
  readonly failure: ProviderFailure | null;
  /** True when the final attempt succeeded. */
  readonly ok: boolean;
  /** True when an automatic retry was refused because work may be committed. */
  readonly blockedByCommitState: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `run()` once, plus AT MOST one automatic retry when (and only when) the
 * failure is transient and nothing was committed.
 */
export async function runWithSafeRetry<T>(
  options: SafeRetryOptions<T>,
): Promise<SafeRetryOutcome<T>> {
  const surface = options.surface ?? 'generic';
  const maxAutomaticRetries = Math.max(0, options.maxAutomaticRetries ?? DEFAULT_MAX_AUTOMATIC_RETRIES);
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_AUTOMATIC_RETRY_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;

  let result = await options.run({ index: 1, automatic: false });
  let failure = toFailure(options.failureOf(result), surface);
  let attempts = 1;
  let automaticRetries = 0;
  let blockedByCommitState = false;

  if (failure && failure.autoRetryable && maxAutomaticRetries > 0) {
    if (options.committed?.() === true) {
      // Commit state is uncertain or already done: never replay automatically.
      blockedByCommitState = true;
    } else {
      automaticRetries = 1;
      attempts = 2;
      if (options.diagnosticsType) noteAutomaticRetry(options.diagnosticsType);
      options.onAutomaticRetry?.({ failure, nextAttempt: 2 });
      if (delayMs > 0) await sleep(delayMs);
      result = await options.run({ index: 2, automatic: true });
      failure = toFailure(options.failureOf(result), surface);
    }
  }

  return {
    result,
    attempts,
    automaticRetries,
    failure,
    ok: failure === null,
    blockedByCommitState,
  };
}

function toFailure(
  input: ProviderFailureInput | string | null | undefined,
  surface: ProviderFailureSurface,
): ProviderFailure | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string' && input.trim().length === 0) return null;
  return classifyProviderFailure(input, surface);
}

/**
 * Whether an EXPLICIT learner Retry is currently allowed for a failure class.
 *
 * Cancellations caused by our own lifecycle (`replaced`) are not "failures" the
 * learner should retry blindly: the caller decides (usually it is silent).
 */
export function canLearnerRetry(failure: ProviderFailure | null): boolean {
  return failure !== null && failure.retryable;
}
