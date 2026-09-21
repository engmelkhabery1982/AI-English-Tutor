/**
 * src/voice/mic-intent.ts
 *
 * ONE queued microphone intent for the session-transition race.
 *
 * When the learner taps the microphone while a conversation/session transition
 * is running, the tap is neither lost nor acted on immediately: exactly ONE
 * intent is kept, bound to the switch token of the transition that was active
 * when the tap arrived. Only the settlement of THAT SAME transition may
 * consume the intent:
 * - a superseded/stale transition can never consume it (token mismatch),
 * - a NEWER transition clears it at its start, so a queued intent can never
 *   start a recording on a session the learner has already moved past,
 * - the slot holds at most one intent: repeated taps while switching never
 *   queue more than one execution.
 *
 * The queue is a plain synchronous object (no timers, no async): it exists so
 * the behavior is deterministic and unit-testable without a renderer.
 */
export class MicIntentQueue {
  private intentSwitchToken: number | null = null;

  /**
   * Records the learner's mic tap against the transition that is active right
   * now. Re-queueing during the SAME transition is idempotent (single slot);
   * queueing for a different transition replaces the older intent.
   */
  queue(switchToken: number): void {
    this.intentSwitchToken = switchToken;
  }

  /** True while any mic intent is waiting to be executed. */
  get pending(): boolean {
    return this.intentSwitchToken !== null;
  }

  /**
   * Consumes the intent IFF it belongs to the transition identified by
   * `switchToken`. A stale or already-replaced intent is never consumed.
   * Returns true exactly once per queued intent.
   */
  consume(switchToken: number): boolean {
    if (this.intentSwitchToken !== switchToken) return false;
    this.intentSwitchToken = null;
    return true;
  }

  /**
   * Drops any pending intent. Called when a NEWER transition starts (the older
   * intent belonged to a transition that no longer owns the surface) or when a
   * transition ends without installing its session (nothing to record into).
   */
  clear(): void {
    this.intentSwitchToken = null;
  }
}

export function createMicIntentQueue(): MicIntentQueue {
  return new MicIntentQueue();
}
