/**
 * src/shared/single-flight.ts
 *
 * The ONE composition helper every feature default factory uses for its
 * app-wide service instance.
 *
 * GUARANTEES
 * - Concurrent callers share a single in-flight composition (one service).
 * - A SUCCESSFUL composition is cached and reused.
 * - A FAILED composition is NOT cached: the slot is cleared, the rejection is
 *   surfaced to the caller unchanged, and the next call retries. A transient
 *   bootstrap failure (e.g. the database could not be opened) therefore never
 *   poisons the app for the rest of the session.
 * - There is no automatic retry loop and no automatic recovery action: a retry
 *   only ever happens on an explicit later request.
 */

/**
 * Create a single-flight accessor for one lazily composed value.
 *
 * @param compose builds the value once per successful composition.
 */
export function createRecoverableSingleFlight<T>(
  compose: () => Promise<T>,
): () => Promise<T> {
  let cached: Promise<T> | null = null;

  return function getOrCompose(): Promise<T> {
    if (cached) return cached;

    const attempt = compose();
    cached = attempt;
    void attempt.then(
      () => undefined,
      () => {
        // Clear only the failed attempt (a newer one may already be recorded).
        if (cached === attempt) cached = null;
      },
    );
    return attempt;
  };
}
