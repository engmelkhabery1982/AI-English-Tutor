/**
 * src/review/types.ts
 *
 * Types for the Adaptive Review & Retraining System.
 */

import type { IsoDate, Uuid, WeaknessStatus } from '../domain/shared/types';
import type { ReviewItem } from '../domain/models/learning';

/** Supported interactive exercise types for review */
export type ReviewExerciseType =
  | 'vocabulary_recall'
  | 'expression_use'
  | 'fill_the_gap'
  | 'sentence_correction'
  | 'natural_phrasing';

/** Qualitative evaluation result (no numeric scores) */
export type QualitativeResult = 'correct' | 'partial' | 'incorrect';

/** Evaluation output from local or AI evaluator */
export interface EvaluationResult {
  readonly result: QualitativeResult;
  readonly feedback: string;
  readonly explanation?: string;
  readonly suggestedCorrection?: string;
}

/** An interactive review item candidate prepared for a session */
export interface ReviewItemCandidate {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly kind: ReviewItem['kind'];
  readonly exerciseType: ReviewExerciseType;
  readonly referenceId: Uuid;
  readonly prompt: string;
  readonly contextTopic?: string;
  readonly contextSentence?: string;
  readonly definition?: string;
  readonly expectedAnswer: string;
  readonly alternativeAnswers?: readonly string[];
  readonly explanation?: string;
  readonly dueAt: IsoDate;
  readonly severity?: number;
  readonly status?: WeaknessStatus;
  readonly consecutiveCorrect: number;
  readonly reviewCount: number;
  readonly easeFactor?: number;
}

/** Status summary for the review dashboard */
export interface ReviewDashboardSummary {
  readonly totalDue: number;
  readonly dueVocabularyCount: number;
  readonly dueExpressionCount: number;
  readonly activeWeaknessCount: number;
  readonly categories: readonly {
    readonly key: 'vocabulary' | 'expression' | 'grammar';
    readonly label: string;
    readonly dueCount: number;
  }[];
}

/** Recorded item in a completed or ongoing review session */
export interface ReviewSessionItemRecord {
  readonly candidate: ReviewItemCandidate;
  readonly userAnswer: string;
  readonly evaluation: EvaluationResult;
  readonly answeredAt: IsoDate;
  readonly latencyMs?: number;
}

/** Final summary of a completed review session */
export interface ReviewSessionSummary {
  readonly totalItems: number;
  readonly correctCount: number;
  readonly partialCount: number;
  readonly incorrectCount: number;
  readonly improvedWeaknessCount: number;
  readonly masteredCount: number;
  readonly items: readonly ReviewSessionItemRecord[];
  readonly startedAt: IsoDate;
  readonly completedAt: IsoDate;
}

/** Bounding constraints for review session planning */
export interface ReviewPlannerOptions {
  readonly minItems?: number; // default 8
  readonly maxItems?: number; // default 12
  readonly targetItems?: number; // default 10
  readonly now?: IsoDate;
}
