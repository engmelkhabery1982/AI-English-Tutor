/**
 * src/learning-progression/evidence.ts
 *
 * Pure helpers that normalize ALREADY-LOADED learner rows into the narrow
 * evidence shape the difficulty resolver understands.
 *
 * These helpers deliberately take STRUCTURAL inputs (type/status/resolved)
 * instead of importing the learner-model module, so any owning service can
 * pass the rows it already loaded without creating a dependency on another
 * engine and without any extra read.
 */

import type { SkillDomain } from '../curriculum/types';
import type { WeaknessStatus } from '../domain/shared/types';
import type {
  LearnerProgressionEvidence,
  ProgressionWeaknessEvidence,
} from './types';

/**
 * The curriculum domain a learner-weakness type belongs to.
 *
 * Only the EXISTING weakness types are mapped; anything unknown returns
 * null so it can never be silently attributed to a domain.
 */
export function weaknessTypeToDomain(type: string): SkillDomain | null {
  switch (type) {
    case 'grammar':
      return 'grammar';
    case 'vocabulary':
      return 'vocabulary';
    case 'natural_expression':
      return 'expressions';
    case 'pronunciation':
      return 'pronunciation';
    case 'listening':
      return 'listening';
    case 'fluency':
    case 'confidence':
      return 'speaking';
    default:
      return null;
  }
}

/**
 * Statuses that represent REAL, repeated negative evidence.
 *
 * A single sighting (`observed`) is deliberately excluded: one observation is
 * not enough to justify changing how practice is delivered.
 */
export const URGENT_NEGATIVE_STATUSES: readonly WeaknessStatus[] = [
  'relapsed',
  'confirmed',
  'active_training',
  'repeated',
] as const;

const URGENT_NEGATIVE: ReadonlySet<string> = new Set<string>(URGENT_NEGATIVE_STATUSES);

/** Lifecycle statuses that count as real, repeated difficulty. */
export function isUrgentNegativeStatus(status: string): boolean {
  return URGENT_NEGATIVE.has(status);
}

/**
 * Build the resolver input from already-loaded learner-weakness rows.
 *
 * Rows whose type cannot be mapped to a domain are dropped (never guessed).
 * Resolved rows are kept in the snapshot but never count as active negative
 * evidence.
 */
export function toProgressionEvidence(
  rows: readonly {
    readonly type: string;
    readonly status: string;
    readonly resolved: boolean;
  }[],
): LearnerProgressionEvidence {
  const weaknesses: ProgressionWeaknessEvidence[] = [];
  for (const row of rows) {
    const domain = weaknessTypeToDomain(row.type);
    if (!domain) continue;
    weaknesses.push({
      domain,
      status: row.status as WeaknessStatus,
      resolved: row.resolved === true,
    });
  }
  return { weaknesses };
}

/**
 * Real negative evidence count for a domain (or for every domain when the
 * caller does not scope one). Unresolved rows in an urgent negative status
 * only.
 */
export function urgentNegativeEvidenceCount(
  evidence: LearnerProgressionEvidence | null | undefined,
  domain?: SkillDomain,
): number {
  if (!evidence || !Array.isArray(evidence.weaknesses)) return 0;
  let count = 0;
  for (const row of evidence.weaknesses) {
    if (row.resolved) continue;
    if (domain !== undefined && row.domain !== domain) continue;
    if (!isUrgentNegativeStatus(row.status)) continue;
    count += 1;
  }
  return count;
}

/** True when real, repeated negative evidence exists for the domain. */
export function hasUrgentNegativeEvidence(
  evidence: LearnerProgressionEvidence | null | undefined,
  domain?: SkillDomain,
): boolean {
  return urgentNegativeEvidenceCount(evidence, domain) > 0;
}
