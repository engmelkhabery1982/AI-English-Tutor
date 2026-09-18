/**
 * src/review/evidence-identity.ts
 *
 * Deterministic, retry-safe identity for review practice evidence.
 *
 * The persisted `weakness_evidence` table is keyed by its own id and stores
 * exactly what the learner really did. Deriving that id from the review item
 * id made a second review of the same item collide with the first (the insert
 * threw after the schedule had already advanced, so the evidence row was
 * silently lost). Identity is therefore derived from the ATTEMPT:
 *
 *   - the same attempt delivered twice (double submit, retry after an error,
 *     a late duplicate callback) derives the SAME id → one row, no duplicate;
 *   - two legitimate attempts derive DIFFERENT ids → both are kept, and no
 *     historical row is ever overwritten (the insert never replaces).
 *
 * Nothing here uses randomness: identity is a pure function of the attempt.
 * Callers that own the attempt (the Review screen captures ONE attempt id per
 * item attempt) must pass it, so a retry reuses it and a later review of the
 * same item is a genuinely new attempt.
 */

/** FNV-1a over UTF-16 code units — small, dependency-free, deterministic. */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Unit separator: cannot appear in the identifiers/answers being joined. */
const PART_SEPARATOR = '\u241f';

export interface ReviewAttemptIdentityInput {
  /** Stable identity of ONE attempt, owned by the caller (preferred). */
  readonly attemptId?: string;
  readonly learnerId: string;
  readonly referenceId: string;
  readonly candidateId: string;
  /** Schedule snapshot of the attempt — it changes between real attempts. */
  readonly reviewCount: number;
  readonly consecutiveCorrect: number;
  readonly userAnswer: string;
  readonly result: string;
}

/**
 * Deterministic attempt key.
 *
 * Preferred path: the caller's per-attempt id (a retry of the same attempt
 * reuses it, a new attempt gets a new one). Fallback path (callers that do not
 * track attempts): a pure function of the candidate snapshot, the normalized
 * answer and the evaluation result, so a repeated delivery of the same
 * observation collapses into one attempt instead of duplicating evidence.
 */
export function deriveReviewAttemptKey(input: ReviewAttemptIdentityInput): string {
  const explicit = input.attemptId?.trim();
  if (explicit) {
    return `attempt${PART_SEPARATOR}${explicit}`;
  }
  return [
    'observed',
    input.learnerId,
    input.referenceId,
    input.candidateId,
    String(input.reviewCount),
    String(input.consecutiveCorrect),
    input.userAnswer.trim().toLowerCase().replace(/\s+/g, ' '),
    input.result,
  ].join(PART_SEPARATOR);
}

/**
 * A deterministic UUID (v4-shaped, no randomness) derived from the attempt
 * parts. Valid for every repository that validates ids, and stable across
 * retries of the same attempt.
 */
export function deriveReviewEvidenceId(parts: readonly string[]): string {
  const input = parts.join(PART_SEPARATOR);
  const segments = [
    fnv1a32(input, 0x811c9dc5),
    fnv1a32(input, 0x9e3779b9),
    fnv1a32(input, 0x85ebca6b),
    fnv1a32(input, 0xc2b2ae35),
  ];
  const hex = segments.map((value) => value.toString(16).padStart(8, '0')).join('');
  const variant = '89ab'[(segments[0] >>> 28) & 0x3];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
