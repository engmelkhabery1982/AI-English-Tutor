/**
 * src/fluency/support-policy.ts
 *
 * WP-3 progressive de-scaffolding policy: small, pure, testable.
 *
 * RULES
 * - PURE: no I/O, no AI call, no clock read, no randomness. Same inputs
 *   always produce the same support level.
 * - BOUNDED: the output is always one of guided | supported | independent.
 * - NEVER DE-SCAFFOLD ON WEAK EVIDENCE:
 *   - a failed attempt never changes support;
 *   - a demo/offline attempt (feedback the real tutor never produced) never
 *     changes support;
 *   - support NEVER decreases because of one success: a decrease requires
 *     CONSECUTIVE_STRONG_REQUIRED consecutive strong committed attempts.
 * - A "strong" attempt = the task was really completed (all task points
 *   covered, detected deterministically) AND the real correction was absent
 *   or minor. Response length is deliberately NOT an input.
 * - This is NOT a mastery model: it only decides how many cues the NEXT
 *   attempt shows. It writes nothing, persists nothing, and levels nothing.
 */

import type { CefrLevelInput } from '../domain/shared/types';
import type { FluencySupportLevel } from './types';

/** Consecutive strong attempts required before support steps down once. */
export const CONSECUTIVE_STRONG_REQUIRED = 2;

/** All support levels, from most to least supported (the total bound). */
export const SUPPORT_LEVELS: readonly FluencySupportLevel[] = [
  'guided',
  'supported',
  'independent',
];

export interface StrongAttemptInput {
  /** All required task points were covered (deterministic detection). */
  readonly completed: boolean;
  /** Real correction severity of the attempt (null = no correction). */
  readonly correctionSeverity: 'incorrect' | 'unnatural' | 'minor' | null;
}

/**
 * True when an attempt is strong enough to count towards de-scaffolding:
 * really completed AND (no correction or only a minor one). Pure.
 */
export function isStrongAttempt(input: StrongAttemptInput): boolean {
  if (!input.completed) return false;
  return input.correctionSeverity === null || input.correctionSeverity === 'minor';
}

export interface SupportPolicyInput {
  /** Stored working level (initial support only — never a proficiency claim). */
  readonly learnerLevel: CefrLevelInput;
  /** 1-based number of the attempt that was just committed. */
  readonly attemptNumber: number;
  /** Support the just-committed attempt ran with. */
  readonly priorSupport: FluencySupportLevel;
  /** False for demo/offline attempts (feedback was never real). */
  readonly isRealAI: boolean;
  /** True when the attempt failed (failed STT/AI, refused, stale). */
  readonly failed: boolean;
  /**
   * Trailing run of consecutive strong COMMITTED attempts, INCLUDING the one
   * that just committed. Reset to 0 by any weak/failed/demo attempt.
   */
  readonly consecutiveStrongAttempts: number;
}

/**
 * Starting support for a task, from the stored working level only.
 * A1/A2/unknown start guided; B1+ start supported. Nothing ever starts
 * independent: every task begins with at least some support.
 */
export function initialSupportLevel(
  learnerLevel: CefrLevelInput,
): FluencySupportLevel {
  switch (learnerLevel) {
    case 'B1':
    case 'B2':
    case 'C1':
    case 'C2':
      return 'supported';
    case 'A1':
    case 'A2':
    case 'unknown':
    default:
      return 'guided';
  }
}

/** One deterministic step down (independent is the floor). */
export function stepDownSupport(
  level: FluencySupportLevel,
): FluencySupportLevel {
  switch (level) {
    case 'guided':
      return 'supported';
    case 'supported':
      return 'independent';
    case 'independent':
      return 'independent';
  }
}

/**
 * Resolve the support level for the NEXT attempt. Deterministic and bounded:
 * the result is always one of the three levels, and identical inputs always
 * yield the identical level.
 */
export function resolveSupportLevel(input: SupportPolicyInput): FluencySupportLevel {
  // Failed or demo attempts never move support in either direction.
  if (input.failed) return input.priorSupport;
  if (!input.isRealAI) return input.priorSupport;
  // Before the second committed attempt no run of consecutive strong attempts
  // can exist yet, so support cannot decrease.
  if (input.attemptNumber < CONSECUTIVE_STRONG_REQUIRED) return input.priorSupport;
  // One success is never enough: the run must reach the required length.
  if (input.consecutiveStrongAttempts < CONSECUTIVE_STRONG_REQUIRED) {
    return input.priorSupport;
  }
  return stepDownSupport(input.priorSupport);
}
