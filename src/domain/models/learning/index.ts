/**
 * src/domain/models/learning/index.ts
 *
 * Learning domain interfaces: lessons, exercises, review items,
 * progress records, and the adaptive-learning inputs/outputs.
 *
 * NOTE: The actual adaptive algorithms are NOT implemented here.
 * These interfaces define the contract the Learning Engine will
 * implement once the Learner Model and repositories exist.
 */

import type {
  ConversationMode,
  IsoDate,
  MasteryState,
  Uuid,
} from '../../shared/types';

/** A lesson (future feature). */
export interface Lesson {
  readonly id: Uuid;
  readonly title: string;
  readonly description?: string;
  readonly targetLevel?: string;
  readonly focusAreas: readonly string[]; // e.g. "for-vs-since"
  readonly exerciseIds: readonly Uuid[];
  readonly estimatedMinutes: number;
  readonly createdAt: IsoDate;
}

/** An exercise (future feature). */
export interface Exercise {
  readonly id: Uuid;
  readonly lessonId?: Uuid;
  readonly type:
    | 'grammar-in-conversation'
    | 'pronunciation-drill'
    | 'speaking-drill'
    | 'vocabulary-practice'
    | 'listening-practice'
    | 'fluency-challenge'
    | 'storytelling'
    | 'role-play'
    | 'professional-scenario';
  readonly prompt: string;
  readonly expectedAnswer?: string;
  readonly hints?: readonly string[];
  readonly targetWeaknessIds?: readonly Uuid[];
  readonly targetVocabularyIds?: readonly Uuid[];
  readonly estimatedSeconds: number;
  readonly createdAt: IsoDate;
}

/**
 * A spaced-repetition review item surfaced to the learner.
 *
 * Carries the full review history so future algorithms can compute
 * difficulty, ease, and optimal intervals from real evidence
 * rather than guesses.
 */
export interface ReviewItem {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly kind:
    | 'vocabulary'
    | 'expression'
    | 'grammar'
    | 'pronunciation'
    /** Phase 1 listening retraining: re-listen and recognize words/meanings. */
    | 'listening';
  readonly referenceId: Uuid;
  readonly prompt: string;
  readonly expectedResponse?: string;
  readonly contextTopic?: string;
  readonly state: MasteryState;
  readonly dueAt: IsoDate;
  readonly createdAt: IsoDate;
  readonly lastReviewAt?: IsoDate;
  readonly reviewCount: number;
  readonly consecutiveCorrect: number;
  readonly easeFactor?: number;
  readonly outcomeHistory: readonly ReviewOutcome[];
}

/** A single review attempt outcome. */
export interface ReviewOutcome {
  readonly at: IsoDate;
  readonly result: 'correct' | 'incorrect' | 'partial';
  readonly latencyMs?: number;
  readonly note?: string;
}

/** A single progress measurement snapshot (aggregate over a window). */
export interface ProgressRecord {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly recordedAt: IsoDate;
  readonly windowStart: IsoDate;
  readonly windowEnd: IsoDate;
  readonly sessionsCompleted: number;
  readonly turnsCompleted: number;
  readonly listeningScore?: number; // 0..1
  readonly speakingScore?: number; // 0..1
  readonly fluencyScore?: number; // 0..1
  readonly confidenceScore?: number; // 0..1
  readonly pronunciationScore?: number; // 0..1
  readonly grammarScore?: number; // 0..1
  readonly vocabularyScore?: number; // 0..1
  readonly newWordsLearned: number;
  readonly weaknessesImproved: number;
  readonly weaknessesWorsened: number;
  readonly notes?: string;
}

/**
 * A single learning activity event.
 *
 * Progress is an event stream, not just window aggregates. Each
 * event records what the learner actually did, for how long, and
 * what was practiced. Values are never fabricated: they come from
 * real conversation turns, real review attempts, and real drills.
 */
export type LearningActivityType =
  | 'conversation'
  | 'listening'
  | 'speaking-drill'
  | 'pronunciation-drill'
  | 'vocabulary-practice'
  | 'review'
  | 'lesson'
  | 'fluency-challenge';

export interface ProgressEvent {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly recordedAt: IsoDate;
  readonly activityType: LearningActivityType;
  readonly sessionId?: Uuid;
  readonly durationSeconds?: number;
  readonly turnsCompleted?: number;
  readonly vocabularyIds: readonly Uuid[];
  readonly weaknessIds: readonly Uuid[];
  readonly grammarObservations: readonly Uuid[];
  readonly pronunciationObservations: readonly Uuid[];
  readonly fluencyObservations: readonly Uuid[];
  readonly notes?: string;
}

/** Input contract for the (future) adaptive learning engine. */
export interface LearningContext {
  readonly learnerId: Uuid;
  readonly currentLevel: string;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly recentMistakes: readonly Uuid[];
  readonly vocabularyDue: readonly Uuid[];
  readonly recentSessions: readonly Uuid[];
  readonly mode?: ConversationMode;
  readonly topic?: string;
}

/** Output contract for the (future) adaptive learning engine. */
export interface LearningRecommendation {
  readonly activities: readonly LearningActivity[];
  readonly rationale: string;
  readonly generatedAt: IsoDate;
}

/** A single recommended learning activity. */
export interface LearningActivity {
  readonly id: Uuid;
  readonly type: Exercise['type'];
  readonly title: string;
  readonly description?: string;
  readonly targetWeaknessIds?: readonly Uuid[];
  readonly targetVocabularyIds?: readonly Uuid[];
  readonly estimatedMinutes: number;
  readonly priority: number; // 0..1
}

export type { ConversationMode };