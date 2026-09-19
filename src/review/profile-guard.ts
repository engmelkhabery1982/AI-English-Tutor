/**
 * src/review/profile-guard.ts
 *
 * First-launch profile handling for the Review surface.
 *
 * `SQLiteUserProfileRepository.get()` THROWS when no profile exists yet
 * ("No user profile found. Call update() first to create one."). On a
 * fresh install that is a NORMAL state, not a database failure — but a
 * raw throw would fall into Review's generic error paths ("Could not
 * load your saved reviews..."). The repository contract (and its tests)
 * intentionally keep the throw, so Review classifies the known condition
 * HERE instead of silently auto-creating a profile or masking errors.
 *
 * Honesty rules:
 * - only the repository's known no-profile condition is classified
 *   `missing`;
 * - every OTHER failure (SQL errors, locks, adapter errors) is
 *   re-thrown untouched so genuine database failures keep surfacing;
 * - nothing here creates, persists, or fabricates learner data.
 */

/** Distinctive marker of the repository's known no-profile error. */
export const PROFILE_NOT_FOUND_MARKER = 'No user profile found';

/** True ONLY for the repository's known "no profile yet" error. */
export function isProfileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(PROFILE_NOT_FOUND_MARKER)
  );
}

export type ReviewProfileOutcome =
  | { readonly status: 'ok'; readonly learnerId: string }
  /** No profile exists yet — a normal first-launch state, not an error. */
  | { readonly status: 'missing' };

/**
 * Reads the learner profile for a Review entry point (dashboard metric
 * load, session start).
 *
 * - profile present                      → `{ status: 'ok', learnerId }`
 * - no profile yet (known throw, or a
 *   defensive null/id-less result)       → `{ status: 'missing' }`
 * - any other failure                    → re-thrown (genuine database error)
 */
export async function readReviewLearnerProfile(
  repository: { get(): Promise<unknown> },
): Promise<ReviewProfileOutcome> {
  let profile: unknown;
  try {
    profile = await repository.get();
  } catch (error) {
    if (isProfileNotFoundError(error)) return { status: 'missing' };
    throw error;
  }
  const candidate = profile as { id?: unknown } | null | undefined;
  if (candidate && typeof candidate.id === 'string' && candidate.id.length > 0) {
    return { status: 'ok', learnerId: candidate.id };
  }
  return { status: 'missing' };
}
