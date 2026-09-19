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
 *
 * LIFECYCLE AWARENESS (optional)
 * Feature compositions are built ON the canonical application database. When
 * that database closes, the connection they were built on is dead, so a cached
 * service must NOT survive it. Pass `lifecycleToken` (see
 * `appDatabaseLifecycleToken()` in src/data/local/sqlite/app-database.ts) and a
 * cached success is only reused while the token is unchanged; after a close the
 * next call recomposes on the new lifecycle. In-flight compositions are shared
 * only within the SAME token, so a caller arriving after a close never adopts a
 * composition that may belong to the previous connection.
 */

export interface RecoverableSingleFlightOptions {
  /**
   * Identity of the lifecycle the cached value belongs to. Read on every call;
   * compared by identity. When it changes, the cached value (or in-flight
   * attempt) from the previous lifecycle is discarded and a fresh composition
   * starts. Omit it for values that are not tied to a lifecycle.
   */
  readonly lifecycleToken?: () => unknown;
}

/**
 * Create a single-flight accessor for one lazily composed value.
 *
 * @param compose builds the value once per successful composition.
 * @param options optional lifecycle token invalidating cached successes.
 */
export function createRecoverableSingleFlight<T>(
  compose: () => Promise<T>,
  options: RecoverableSingleFlightOptions = {},
): () => Promise<T> {
  const lifecycleToken = options.lifecycleToken;
  let entry: { readonly promise: Promise<T>; readonly token: unknown } | null = null;

  return function getOrCompose(): Promise<T> {
    const token = lifecycleToken?.();
    // Reuse only a composition that belongs to the CURRENT lifecycle. Without a
    // token this is the plain "cached success / shared in-flight attempt" slot.
    if (entry && (!lifecycleToken || entry.token === token)) return entry.promise;

    const attempt = compose();
    const created = { promise: attempt, token };
    entry = created;
    void attempt.then(
      () => {
        // A close during composition invalidates the value (it may be built on
        // a connection that is no longer the current lifecycle): never cache it.
        if (entry === created && lifecycleToken && lifecycleToken() !== token) {
          entry = null;
        }
      },
      () => {
        // Clear only the failed attempt (a newer one may already be recorded).
        if (entry === created) entry = null;
      },
    );
    return attempt;
  };
}
