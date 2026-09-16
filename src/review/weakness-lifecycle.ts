/**
 * src/review/weakness-lifecycle.ts
 *
 * Conservative state transitions and spaced repetition calculations
 * for the Weakness Lifecycle:
 *
 * observed -> repeated -> confirmed -> active_training -> improving -> stable -> mastered -> relapsed
 */

import type { IsoDate, WeaknessStatus } from '../domain/shared/types';
import type { QualitativeResult } from './types';

export interface WeaknessTransitionResult {
  readonly nextStatus: WeaknessStatus;
  readonly nextConsecutiveCorrect: number;
  readonly nextSeverity: number;
}

/**
 * Transition a learner weakness conservative lifecycle based on practice outcome.
 *
 * Requirements:
 * - Practicing an observed, repeated, or confirmed weakness puts it into active_training.
 * - Correct answer advances consecutive correct count.
 *   - active_training -> improving (after 1+ correct)
 *   - improving -> stable (after 3+ consecutive correct)
 *   - stable -> mastered (after 5+ consecutive correct)
 *   - mastered -> mastered
 *   - relapsed -> active_training (re-engaged in training)
 * - Incorrect answer resets consecutive correct count to 0:
 *   - mastered -> relapsed (detected regression)
 *   - stable -> relapsed (detected regression)
 *   - improving -> active_training (reverts to active training)
 *   - active_training -> active_training
 *   - relapsed -> relapsed
 * - Partial answer preserves current status and consecutive correct count.
 * - Severity gradually decreases on success (min 0.1) and increases on failure (max 1.0).
 */
export function transitionWeaknessLifecycle(
  currentStatus: WeaknessStatus,
  outcome: QualitativeResult,
  currentConsecutiveCorrect: number = 0,
  currentSeverity: number = 0.5,
): WeaknessTransitionResult {
  if (outcome === 'correct') {
    const nextConsecutiveCorrect = currentConsecutiveCorrect + 1;
    const nextSeverity = Math.max(0.1, Number((currentSeverity - 0.1).toFixed(2)));

    let nextStatus: WeaknessStatus;
    switch (currentStatus) {
      case 'observed':
      case 'repeated':
      case 'confirmed':
        nextStatus = 'active_training';
        break;
      case 'active_training':
        nextStatus = nextConsecutiveCorrect >= 1 ? 'improving' : 'active_training';
        break;
      case 'improving':
        nextStatus = nextConsecutiveCorrect >= 3 ? 'stable' : 'improving';
        break;
      case 'stable':
        nextStatus = nextConsecutiveCorrect >= 5 ? 'mastered' : 'stable';
        break;
      case 'mastered':
        nextStatus = 'mastered';
        break;
      case 'relapsed':
        nextStatus = 'active_training';
        break;
      default:
        nextStatus = 'active_training';
    }

    return { nextStatus, nextConsecutiveCorrect, nextSeverity };
  }

  if (outcome === 'incorrect') {
    const nextConsecutiveCorrect = 0;
    const nextSeverity = Math.min(1.0, Number((currentSeverity + 0.1).toFixed(2)));

    let nextStatus: WeaknessStatus;
    switch (currentStatus) {
      case 'mastered':
      case 'stable':
        nextStatus = 'relapsed';
        break;
      case 'improving':
        nextStatus = 'active_training';
        break;
      case 'active_training':
      case 'relapsed':
        nextStatus = currentStatus;
        break;
      case 'observed':
      case 'repeated':
      case 'confirmed':
      default:
        nextStatus = 'active_training';
        break;
    }

    return { nextStatus, nextConsecutiveCorrect, nextSeverity };
  }

  // outcome === 'partial'
  let nextStatus: WeaknessStatus = currentStatus;
  if (['observed', 'repeated', 'confirmed'].includes(currentStatus)) {
    nextStatus = 'active_training';
  }

  return {
    nextStatus,
    nextConsecutiveCorrect: currentConsecutiveCorrect,
    nextSeverity: currentSeverity,
  };
}

/**
 * Calculates the next spaced repetition interval in days.
 */
export function calculateNextIntervalDays(
  consecutiveCorrect: number,
  outcome: QualitativeResult,
): number {
  if (outcome === 'incorrect' || outcome === 'partial') {
    return 1;
  }

  if (consecutiveCorrect <= 1) return 1;
  if (consecutiveCorrect === 2) return 3;
  if (consecutiveCorrect === 3) return 7;
  if (consecutiveCorrect === 4) return 14;
  return 30; // 5+ consecutive correct
}

/**
 * Calculates the next ISO review timestamp based on days interval.
 */
export function calculateNextReviewDate(
  baseDate: string | Date = new Date(),
  intervalDays: number = 1,
): IsoDate {
  const baseMs = typeof baseDate === 'string' ? Date.parse(baseDate) : baseDate.getTime();
  const safeBaseMs = isNaN(baseMs) ? Date.now() : baseMs;
  const nextMs = safeBaseMs + intervalDays * 24 * 60 * 60 * 1000;
  return new Date(nextMs).toISOString();
}
