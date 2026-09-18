/**
 * src/daily-tutor/completion.ts
 *
 * Completion handshake between the Daily Tutor and the EXISTING child
 * activity screens (Review, Listening, Adaptive Lesson, Deep Speaking).
 *
 * DESIGN
 * - Daily Tutor passes a serializable `DailyTutorActivityRef` to a child via
 *   ordinary navigation params. Nothing else is required — the child screen
 *   remains the owner of its actual learning session.
 * - When (and ONLY when) the child's OWN workflow really completes, the child
 *   reports that fact here with the ref it received. Opening the child
 *   screen is never completion; the report happens at the child's real
 *   completion point.
 * - The Daily Tutor screen drains this inbox when it regains focus and asks
 *   the DailyTutorService to apply the completions. Applying is idempotent
 *   and validates everything (see service).
 * - Standalone use of every child screen is unchanged: with no ref param no
 *   report is ever made, and the inbox is never involved.
 *
 * RETRY SAFETY (the core invariant)
 * - A REAL child completion stays retryable until the DailyTutorService has
 *   successfully persisted/applied it (or permanently rejected it as
 *   stale/foreign/malformed).
 * - Drain therefore does NOT discard anything: drained completions move to
 *   an "unacknowledged" state and are RE-QUEUED automatically whenever
 *   their application fails, so the next Daily Tutor focus retries them.
 * - Only an explicit acknowledgement (applied or permanently rejected)
 *   frees the activity id for future reports.
 *
 * The inbox is deliberately in-memory (app-lifetime, no extra storage). An
 * app kill can never duplicate child learning evidence: the child system
 * persisted its own evidence exactly once when it completed; at worst the
 * daily ACTIVITY simply remains resumable/skippable until the learner
 * completes it again.
 */

import type { DailyTutorCompletionBatchResult, DailyTutorService } from './service';
import type { DailyTutorChildCompletion } from './types';

/** Completions waiting to be drained by the Daily Tutor screen. */
let pending: DailyTutorChildCompletion[] = [];

/**
 * Drained completions that are not yet finally dispositioned (applied or
 * permanently rejected). Keyed by activity id — the retry state.
 */
const unacknowledged = new Map<string, DailyTutorChildCompletion>();

/** Report ONE real child-workflow completion. */
export function reportDailyTutorCompletion(completion: DailyTutorChildCompletion): void {
  if (!completion?.ref?.sessionId || !completion.ref.activityId || !completion.ref.kind) {
    return; // Malformed ref: ignore safely.
  }
  const activityId = completion.ref.activityId;
  if (unacknowledged.has(activityId)) {
    return; // Already awaiting application — never two copies of one report.
  }
  if (pending.some((entry) => entry.ref.activityId === activityId)) {
    return; // Already queued — first report wins.
  }
  pending.push(completion);
}

/**
 * Take all completions reported since the last drain. The drained entries
 * are NOT discarded: they become unacknowledged and stay retryable until
 * acknowledged (applied/permanently rejected) or re-queued on failure.
 */
export function drainDailyTutorCompletions(): readonly DailyTutorChildCompletion[] {
  const drained = pending;
  pending = [];
  for (const completion of drained) {
    const activityId = completion.ref.activityId;
    if (!unacknowledged.has(activityId)) {
      unacknowledged.set(activityId, completion);
    }
  }
  return drained;
}

/**
 * Acknowledge completions as finally dispositioned — successfully applied,
 * or permanently rejected by the service (stale/foreign/mismatched/without
 * real practice). Acknowledgement is what makes the activity id reportable
 * again for a genuinely NEW child completion.
 */
export function acknowledgeDailyTutorCompletions(activityIds: readonly string[]): void {
  for (const activityId of activityIds) {
    unacknowledged.delete(activityId);
  }
}

/**
 * Re-queue completions whose application failed (storage unavailable,
 * service error, …). They return to the pending queue and are retried on
 * the next drain; nothing is lost.
 */
export function requeueDailyTutorCompletions(
  completions: readonly DailyTutorChildCompletion[],
): void {
  for (const completion of completions) {
    if (!completion?.ref?.activityId) continue;
    const activityId = completion.ref.activityId;
    // Only re-queue what is still awaiting disposition for this id.
    const awaiting = unacknowledged.get(activityId);
    if (!awaiting) continue; // Already acknowledged or never drained.
    if (!pending.some((entry) => entry.ref.activityId === activityId)) {
      pending.push(awaiting);
    }
    unacknowledged.delete(activityId);
  }
}

/**
 * Number of completions not yet finally dispositioned (pending or
 * unacknowledged) — diagnostics/tests.
 */
export function pendingDailyTutorCompletionCount(): number {
  return pending.length + unacknowledged.size;
}

/**
 * The drain-and-apply cycle the Daily Tutor screen runs when it gains
 * focus: drain the inbox, apply through the service, then acknowledge what
 * was finally dispositioned and re-queue everything that must be retried.
 *
 * Never throws: if the whole application call fails, every drained
 * completion is re-queued for the next focus.
 */
export async function applyDrainedDailyTutorCompletions(
  applier: Pick<DailyTutorService, 'applyChildCompletions'>,
): Promise<DailyTutorCompletionBatchResult | null> {
  const drained = drainDailyTutorCompletions();
  if (drained.length === 0) return null;
  try {
    const result = await applier.applyChildCompletions(drained);
    acknowledgeDailyTutorCompletions([
      ...result.appliedActivityIds,
      ...result.rejectedActivityIds,
    ]);
    requeueDailyTutorCompletions(result.retryable);
    return result;
  } catch {
    // Whole batch failed (service unavailable, unexpected error): every
    // completion stays retryable for the next focus.
    requeueDailyTutorCompletions(drained);
    return null;
  }
}

/**
 * Reset the inbox completely (tests only — never called in app code).
 * Clears the queue, the retry state and the acknowledgement memory so each
 * test starts from a clean inbox.
 */
export function resetDailyTutorCompletionInboxForTests(): void {
  pending = [];
  unacknowledged.clear();
}
