/**
 * src/daily-tutor/completion.ts
 *
 * Minimal, backward-compatible completion handshake between the Daily Tutor
 * and the EXISTING child activity screens (Review, Listening, Adaptive
 * Lesson, Deep Speaking).
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
 * The inbox is deliberately in-memory (app-lifetime). A completion that is
 * reported but never applied (app killed in between) loses nothing: the
 * child's own learning evidence was already persisted exactly once by the
 * child system, and the daily activity simply remains resumable/skippable.
 */

import type { DailyTutorChildCompletion } from './types';

/**
 * Completed activity ids already reported (first report wins). Guards
 * against double reports from double taps / re-renders racing the drain.
 */
const reportedActivityIds = new Set<string>();

/** Completions waiting to be drained by the Daily Tutor screen. */
let pending: DailyTutorChildCompletion[] = [];

/** Report ONE real child-workflow completion. Idempotent per activity. */
export function reportDailyTutorCompletion(completion: DailyTutorChildCompletion): void {
  if (!completion?.ref?.sessionId || !completion.ref.activityId || !completion.ref.kind) {
    return; // Malformed ref: ignore safely.
  }
  if (reportedActivityIds.has(completion.ref.activityId)) {
    return; // Already reported once — never twice for the same activity.
  }
  reportedActivityIds.add(completion.ref.activityId);
  pending.push(completion);
}

/** Take (and clear) all completions reported since the last drain. */
export function drainDailyTutorCompletions(): readonly DailyTutorChildCompletion[] {
  const drained = pending;
  pending = [];
  return drained;
}

/** Number of completions waiting (diagnostics/tests). */
export function pendingDailyTutorCompletionCount(): number {
  return pending.length;
}

/**
 * Reset the inbox completely (tests only — never called in app code).
 * Clears both the queue and the reported-id memory so each test starts
 * from a clean inbox.
 */
export function resetDailyTutorCompletionInboxForTests(): void {
  pending = [];
  reportedActivityIds.clear();
}
