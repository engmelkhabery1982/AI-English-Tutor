/**
 * src/adaptive-lessons/types.ts
 *
 * Adaptive Lessons Engine (Phase 1) — domain model.
 *
 * CORE PRINCIPLES
 * - The lesson is an ORCHESTRATION layer. Every step points at an EXISTING
 *   capability (Review, Listening, Pronunciation evidence, the Conversation
 *   stack, saved lexical data). No step type implies a second exercise
 *   engine, a second scheduler, or a second weakness model.
 * - Deterministic and explainable: each personalized step carries a
 *   human-readable reason derived from real stored evidence.
 * - Honest: `personalized` is only true when a step is backed by real
 *   learner data. Fallback content is labeled general and never claims
 *   personalization.
 * - No scores, percentages, bands, XP, streaks, badges or learner ratings —
 *   anywhere in this model. Progress is expressed as counts of steps and
 *   counts of items actually practiced.
 * - Internal ids (`AdaptiveLessonStepTarget.id`) are references to EXISTING
 *   domain rows. They are for service lookups only and must never be
 *   rendered to the learner.
 */

import type {
  CefrLevelInput,
  ConversationMode,
  IsoDate,
  WeaknessStatus,
} from '../domain/shared/types';
import type { ReviewItem } from '../domain/models/learning';
import type { CoachingContext } from '../learner-model';
import type { EvaluationResult, ReviewItemCandidate } from '../review/types';
import type { ListeningEvaluation, ListeningExercise } from '../listening/types';
import type {
  ConversationFeedback,
  ConversationFeedbackCorrection,
} from '../providers/ai/types';
import type { PronunciationTurnOutcome } from '../pronunciation/types';

/* ------------------------------------------------------------------ *
 * Step taxonomy
 * ------------------------------------------------------------------ */

/**
 * The small Phase-1 set of lesson step types.
 *
 * `wrap_up` is the closing reflection/summary step of a lesson. It is part
 * of the lesson structure (the learner sees "1. … 2. … 5. Wrap-up") but it
 * never fabricates practice: it only reports what really happened.
 */
export type AdaptiveLessonStepType =
  | 'review'
  | 'listening'
  | 'speaking'
  | 'pronunciation'
  | 'vocabulary'
  | 'expression'
  | 'wrap_up';

/**
 * Which EXISTING system executes a step. This is the anti-duplication
 * contract of Phase 1: a step may only name a capability that already
 * exists in the application.
 */
export type AdaptiveLessonCapability =
  /** Existing Adaptive Review: planning, qualitative evaluation, scheduling. */
  | 'review-service'
  /** Existing Listening Engine: bounded exercises + qualitative evaluation. */
  | 'listening-service'
  /** EXISTING Pronunciation Engine: qualitative transcript-comparison evidence. */
  | 'pronunciation-engine'
  /** Existing Conversation / AIProvider stack (targeted speaking practice). */
  | 'conversation-stack'
  /** The lesson's own completion summary — no external engine, no data. */
  | 'lesson-summary';

/**
 * Honest provenance of a step: what real stored evidence produced it.
 * `general` means built-in fallback content (never personalized).
 */
export type AdaptiveLessonStepSource =
  | 'weakness'
  | 'due_review'
  | 'due_vocabulary'
  | 'due_expression'
  | 'pronunciation_weakness'
  | 'listening_weakness'
  | 'learning_goal'
  /** Reuses real material already selected elsewhere in the same lesson. */
  | 'lesson_context'
  | 'general'
  | 'wrap_up';

/** Machine-readable planning rule that produced a step (explainability). */
export type AdaptiveLessonReasonCode =
  | 'relapsed_weakness'
  | 'confirmed_weakness'
  | 'active_training_weakness'
  | 'repeated_weakness'
  | 'due_review'
  | 'due_vocabulary'
  | 'due_expression'
  | 'listening_retraining'
  | 'pronunciation_retraining'
  | 'natural_phrasing'
  | 'fluency_practice'
  | 'learning_goal'
  | 'general_balance'
  | 'wrap_up';

/** Real, countable evidence behind a reason. Counts only — never scores. */
export interface AdaptiveLessonReasonEvidence {
  /** Persisted occurrence count of a weakness, when the step targets one. */
  readonly occurrenceCount?: number;
  /** Persisted lifecycle state of a weakness, when the step targets one. */
  readonly weaknessStatus?: WeaknessStatus;
  /** Real number of due items of the relevant kind. */
  readonly dueCount?: number;
}

/**
 * Why a step is in the lesson. `message` is written for the learner:
 * no internal ids, no "the AI decided this", no invented claims.
 */
export interface AdaptiveLessonReason {
  readonly code: AdaptiveLessonReasonCode;
  readonly message: string;
  readonly source: AdaptiveLessonStepSource;
  readonly evidence?: AdaptiveLessonReasonEvidence;
}

/** What kind of EXISTING domain object a step targets. */
export type AdaptiveLessonStepTargetKind =
  | 'learner_weakness'
  | 'pronunciation_weakness'
  | 'review_item'
  | 'vocabulary_item'
  | 'expression_item'
  | 'none';

/**
 * Reference to an EXISTING domain object. `id` is internal (service
 * lookups); `label` is the only part that may be shown to the learner.
 */
export interface AdaptiveLessonStepTarget {
  readonly kind: AdaptiveLessonStepTargetKind;
  readonly id?: string;
  readonly label?: string;
}

/** Bounded execution limits for a step (small lessons, small subsets). */
export interface AdaptiveLessonStepBounds {
  /** Maximum number of underlying items/exercises this step may use. */
  readonly maxItems: number;
}

/** One ordered step of an adaptive lesson. */
export interface AdaptiveLessonStep {
  /** Deterministic, plan-scoped id (in-memory only; never persisted). */
  readonly id: string;
  readonly type: AdaptiveLessonStepType;
  /** Short human label, e.g. "Listening retraining". */
  readonly title: string;
  readonly reason: AdaptiveLessonReason;
  /** The EXISTING capability that executes this step. */
  readonly capability: AdaptiveLessonCapability;
  readonly source: AdaptiveLessonStepSource;
  /** True ONLY when derived from real stored learner evidence. */
  readonly personalized: boolean;
  readonly target: AdaptiveLessonStepTarget;
  readonly bounds: AdaptiveLessonStepBounds;
  /**
   * Filter applied to the EXISTING review queue for review-family steps
   * (review / vocabulary / expression / pronunciation). Never invents
   * items: it only narrows what the existing planner already produced.
   */
  readonly reviewKindFilter?: ReviewItem['kind'];
  /** Human-safe practice target text (a word, expression, or phrase). */
  readonly targetText?: string;
}

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

/**
 * Honest classification of how much of the lesson comes from real learner
 * evidence. Surfaced in the UI so fallback content never masquerades as
 * personalization.
 */
export type AdaptiveLessonSourceMode = 'personalized' | 'mixed' | 'general';

/** Size label only. Precise minute estimates are never fabricated. */
export type AdaptiveLessonSizeLabel = 'short' | 'standard';

/** Focus areas of a lesson, used by the Home "Today's Practice" summary. */
export type AdaptiveLessonFocusArea =
  | 'Review'
  | 'Listening'
  | 'Speaking'
  | 'Pronunciation'
  | 'Vocabulary'
  | 'Expressions';

/** One line of the lesson focus summary (real labels/counts only). */
export interface AdaptiveLessonFocus {
  readonly area: AdaptiveLessonFocusArea;
  readonly detail: string;
  /** Real count when one honestly exists (e.g. 3 due expressions). */
  readonly count?: number;
}

/** Real signal counts used while planning (evidence, not ratings). */
export interface AdaptiveLessonSignalSummary {
  readonly activeWeaknesses: number;
  readonly relapsedWeaknesses: number;
  readonly confirmedWeaknesses: number;
  readonly dueReviewItems: number;
  readonly dueVocabulary: number;
  readonly dueExpressions: number;
  readonly pronunciationTargets: number;
  readonly listeningTargets: number;
  readonly savedVocabulary: number;
  readonly savedExpressions: number;
}

/** A complete, bounded, ordered lesson plan. */
export interface AdaptiveLessonPlan {
  /** Deterministic id derived from the planning input (in-memory only). */
  readonly id: string;
  readonly learnerId: string;
  readonly createdAt: IsoDate;
  readonly title: string;
  readonly steps: readonly AdaptiveLessonStep[];
  readonly sourceMode: AdaptiveLessonSourceMode;
  /** Honest sentence about where the lesson content came from. */
  readonly sourceNote: string;
  readonly sizeLabel: AdaptiveLessonSizeLabel;
  readonly focus: readonly AdaptiveLessonFocus[];
  readonly signals: AdaptiveLessonSignalSummary;
}

/* ------------------------------------------------------------------ *
 * Planning input (assembled from EXISTING learner state)
 * ------------------------------------------------------------------ */

/** Human-safe label for a persisted weakness (parsed from stored identity). */
export interface AdaptiveLessonWeaknessTarget {
  readonly weaknessId: string;
  /** Parsed identity kind, e.g. "word_recognition" (listening weaknesses). */
  readonly identityKind?: string;
  /**
   * The word/phrase the weakness is about. For identity-style notes
   * ("word_recognition:deadline") this is the parsed target; for correction
   * evidence it is the learner's original phrase (both are real stored text).
   */
  readonly label?: string;
  /** Real recency of the stored evidence (planner tie-break only). */
  readonly lastSeenAt?: IsoDate;
}

/**
 * A pronunciation practice target read from the EXISTING Pronunciation
 * Engine evidence (pronunciation_weaknesses). Qualitative only: occurrence
 * counts, never scores.
 */
export interface AdaptiveLessonPronunciationTarget {
  readonly pronunciationWeaknessId: string;
  /** Linked learner-weakness id (type 'pronunciation'), when one exists. */
  readonly weaknessId?: string;
  readonly weaknessStatus?: WeaknessStatus;
  readonly occurrenceCount: number;
  /** Stored dedup identity, e.g. "word_stress:development". */
  readonly identity: string;
  /** Human-readable practice target, e.g. "development". */
  readonly target: string;
  /** Qualitative issue label, e.g. "word stress". */
  readonly issueLabel: string;
  /** Real example words persisted with the evidence, when any. */
  readonly wordExamples: readonly string[];
}

/** Bounded snapshot of due review items (existing review queue rows). */
export interface AdaptiveLessonDueReviewSummary {
  readonly total: number;
  readonly byKind: Readonly<Partial<Record<ReviewItem['kind'], number>>>;
}

/**
 * Everything the planner is allowed to know. Assembled by the service from
 * ONE refreshed LearnerModel snapshot (`getCoachingContext()` plus bounded
 * supporting reads). The planner itself is pure and makes no I/O and no AI
 * call, which keeps it deterministic for identical input.
 */
export interface AdaptiveLessonPlanningInput {
  /** The primary signal source: LearnerModel.getCoachingContext(). */
  readonly coaching: CoachingContext;
  /** False when no learner profile exists (honest no-profile state). */
  readonly hasProfile: boolean;
  /** Weakness id → human-safe target label (from persisted identities). */
  readonly weaknessTargets: readonly AdaptiveLessonWeaknessTarget[];
  /** Persisted Pronunciation Engine evidence (bounded). */
  readonly pronunciationTargets: readonly AdaptiveLessonPronunciationTarget[];
  /** Bounded view of the EXISTING due review queue. */
  readonly dueReview: AdaptiveLessonDueReviewSummary;
  readonly now: IsoDate;
}

/** Planner tuning options — always clamped to the Phase-1 hard bounds. */
export interface AdaptiveLessonPlannerOptions {
  /** Requested maximum total steps; clamped to HARD_MAX_LESSON_STEPS. */
  readonly maxSteps?: number;
  /** Requested practice-step target; clamped to Phase-1 bounds. */
  readonly targetPracticeSteps?: number;
}

/* ------------------------------------------------------------------ *
 * Session / execution
 * ------------------------------------------------------------------ */

/** Lifecycle of one step inside a running lesson. */
export type AdaptiveLessonStepStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  /** The owning practice system had nothing real to serve for this step. */
  | 'unavailable';

/** Per-step state. Counts are real; nothing here is a score. */
export interface AdaptiveLessonStepState {
  readonly stepId: string;
  readonly status: AdaptiveLessonStepStatus;
  readonly startedAt?: IsoDate;
  readonly completedAt?: IsoDate;
  /** Real number of underlying items the learner actually practiced. */
  readonly practicedItems: number;
  /** Honest note (e.g. "Skipped by learner", "Nothing was due for this"). */
  readonly note?: string;
}

/** A running (in-memory) lesson. Recoverable while the app is open. */
export interface AdaptiveLessonSession {
  readonly id: string;
  readonly learnerId: string;
  readonly plan: AdaptiveLessonPlan;
  readonly startedAt: IsoDate;
  readonly completedAt?: IsoDate;
  readonly currentIndex: number;
  readonly steps: readonly AdaptiveLessonStepState[];
}

/** Derived, count-only progress view ("3 of 5 lesson steps"). */
export interface AdaptiveLessonProgress {
  readonly totalSteps: number;
  readonly completedSteps: number;
  readonly skippedSteps: number;
  readonly unavailableSteps: number;
  readonly remainingSteps: number;
  /** Real number of underlying practice items completed across steps. */
  readonly practicedItems: number;
  /**
   * Practice steps in this lesson — the structural `wrap_up` step excluded.
   * Completing wrap-up is never practice and never inflates progress.
   */
  readonly totalPracticeSteps: number;
  /**
   * Completed PRACTICE steps: wrap-up excluded, unavailable steps excluded,
   * and only steps where at least one real item was practiced.
   */
  readonly practiceStepsCompleted: number;
  readonly label: string;
  readonly isComplete: boolean;
}

/** Honest completion summary. Counts only — no percentage, no rating. */
export interface AdaptiveLessonSummary {
  readonly lessonId: string;
  readonly sourceMode: AdaptiveLessonSourceMode;
  readonly stepsCompleted: number;
  readonly stepsSkipped: number;
  readonly stepsUnavailable: number;
  readonly totalSteps: number;
  /** Practice steps in the lesson (structural wrap-up excluded). */
  readonly totalPracticeSteps: number;
  /**
   * Completed practice steps only — wrap-up never counts as practice, and a
   * step with zero practiced items never counts either.
   */
  readonly practiceStepsCompleted: number;
  readonly itemsPracticed: number;
  readonly reviewItemsPracticed: number;
  readonly listeningExercisesPracticed: number;
  readonly speakingPromptsAnswered: number;
  readonly pronunciationTargetsPracticed: number;
  readonly lexicalItemsPracticed: number;
  /** Human-readable summary lines (real activity only). */
  readonly lines: readonly string[];
  /** True when a real progress record was written for this lesson. */
  readonly persistedProgress: boolean;
  readonly completedAt: IsoDate;
}

/** Material the UI needs to run one step, produced by EXISTING systems. */
export type AdaptiveLessonStepMaterial =
  | {
      readonly kind: 'review';
      readonly step: AdaptiveLessonStep;
      readonly candidates: readonly ReviewItemCandidate[];
      readonly note?: string;
      /**
       * Provenance for a weakness-targeted step. `true` only when a served
       * candidate is genuinely linked (by persisted id/reference) to the
       * weakness that created the step. `false` means the step honestly
       * degraded to other real practice and must NOT be presented as the
       * targeted item from the learner's history. Absent for steps that were
       * never targeted at one specific weakness.
       */
      readonly targetMatched?: boolean;
    }
  | {
      readonly kind: 'listening';
      readonly step: AdaptiveLessonStep;
      readonly exercises: readonly ListeningExercise[];
      readonly sourceNote: string;
    }
  | {
      /** Repeat-the-target practice served by the EXISTING Pronunciation Engine. */
      readonly kind: 'pronunciation';
      readonly step: AdaptiveLessonStep;
      /** The real stored target word/phrase. */
      readonly target: string;
      /** Qualitative issue label from stored evidence (e.g. "development - word stress"). */
      readonly issueLabel?: string;
      /** Real example words stored with the evidence, when any. */
      readonly wordExamples: readonly string[];
      readonly note?: string;
    }
  | {
      readonly kind: 'speaking';
      readonly step: AdaptiveLessonStep;
      readonly prompt: string;
      /** False when no real AI provider is configured (never Demo). */
      readonly aiAvailable: boolean;
      readonly note?: string;
    }
  | {
      readonly kind: 'wrap_up';
      readonly step: AdaptiveLessonStep;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: 'unavailable';
      readonly step: AdaptiveLessonStep;
      readonly message: string;
    };

/* ------------------------------------------------------------------ *
 * Speaking practice (existing Conversation / AIProvider stack)
 * ------------------------------------------------------------------ */

/** Qualitative speaking outcome. Mirrors the EXISTING correction philosophy. */
export interface AdaptiveSpeakingFeedback {
  /** 'ai' only when a real provider answered; never a fabricated judgment. */
  readonly evaluatedBy: 'ai' | 'unavailable';
  readonly reply?: string;
  readonly correction?: ConversationFeedbackCorrection | null;
  readonly coachingNote?: string | null;
  /** Raw existing feedback, when a real provider produced it. */
  readonly feedback?: ConversationFeedback | null;
  /** Compact qualitative lines for the UI (no numbers, no ratings). */
  readonly lines: readonly string[];
}

/**
 * Port to the EXISTING conversation stack. The default composition builds
 * this from ConversationEngine → ConversationOrchestrator → AIProvider.
 * When no real provider is configured, `available` is false and no feedback
 * is invented (there is deliberately NO silent Demo fallback).
 */
export interface AdaptiveLessonSpeakingPort {
  readonly available: boolean;
  evaluate(input: {
    readonly prompt: string;
    readonly answer: string;
    readonly mode: ConversationMode;
  }): Promise<AdaptiveSpeakingFeedback>;
}

/**
 * Port to the EXISTING Pronunciation Engine. The default composition passes
 * the real engine; tests may pass a fake. The engine owns observation dedup,
 * the weakness lifecycle and review scheduling — the lesson only asks it to
 * analyze one repeat attempt and shows the qualitative result.
 */
export interface AdaptiveLessonPronunciationPort {
  analyzeSpokenTurn(input: {
    transcript: string;
    expectedText?: string;
    context?: string;
    mode?: ConversationMode;
    now?: IsoDate;
  }): Promise<PronunciationTurnOutcome | null>;
}

/* ------------------------------------------------------------------ *
 * Service surface
 * ------------------------------------------------------------------ */

/** Result of planning: an honest discriminated union (never a fake plan). */
export type AdaptiveLessonPlanResult =
  | {
      readonly status: 'no-profile';
      readonly message: string;
      readonly plan: null;
    }
  | {
      readonly status: 'planned';
      readonly plan: AdaptiveLessonPlan;
      readonly message?: string;
    }
  | {
      readonly status: 'unavailable';
      readonly message: string;
      readonly plan: null;
    };

/** Home "Today's Practice" view-model (reflects real plan availability). */
export type AdaptiveTodayPractice =
  | {
      readonly status: 'no-profile';
      readonly message: string;
      readonly plan: null;
      readonly canStart: false;
    }
  | {
      readonly status: 'unavailable';
      readonly message: string;
      readonly plan: null;
      readonly canStart: false;
    }
  | {
      readonly status: 'ready';
      readonly plan: AdaptiveLessonPlan;
      readonly canStart: true;
      readonly headline: string;
      readonly focusLines: readonly string[];
      readonly structureLines: readonly string[];
      readonly stepCount: number;
      readonly sizeLabel: AdaptiveLessonSizeLabel;
      readonly sourceMode: AdaptiveLessonSourceMode;
      /** True only when the lesson really is personalized. */
      readonly claimsPersonalization: boolean;
      /** Resume point when an unfinished lesson is still in memory. */
      readonly resume?: {
        readonly stepNumber: number;
        readonly totalSteps: number;
      };
    };

/**
 * Result of submitting an answer: the updated session snapshot plus the
 * outcome produced by the OWNING existing system (never a lesson-local
 * re-implementation of evaluation).
 */
export interface AdaptiveLessonSubmitOutcome {
  readonly session: AdaptiveLessonSession;
  readonly result: AdaptiveLessonAnswerResult;
}

/** Outcome of submitting an answer through the OWNING existing system. */
export type AdaptiveLessonAnswerResult =
  | {
      readonly kind: 'review';
      readonly evaluation: EvaluationResult;
      readonly persisted: boolean;
      readonly persistenceError: boolean;
      /**
       * True when this is a repeated submission of an item already answered in
       * this lesson: the cached first result is returned and NOTHING was
       * persisted or counted a second time.
       */
      readonly duplicate?: boolean;
    }
  | {
      readonly kind: 'listening';
      readonly evaluation: ListeningEvaluation;
      readonly persistenceError: boolean;
      /** True for a repeated submission — nothing was evaluated or counted again. */
      readonly duplicate?: boolean;
    }
  | {
      readonly kind: 'speaking';
      readonly feedback: AdaptiveSpeakingFeedback;
      /** True for a repeated submission — the provider was not called again. */
      readonly duplicate?: boolean;
    }
  | {
      readonly kind: 'pronunciation';
      /** Qualitative feedback lines from the EXISTING engine (never scores). */
      readonly lines: readonly string[];
      /** True when the engine honestly could not judge this attempt. */
      readonly unavailable: boolean;
      /** Real number of observations detected in this attempt. */
      readonly observationsDetected: number;
      /** True for a repeated submission — the engine was not called again. */
      readonly duplicate?: boolean;
    }
  | {
      readonly kind: 'none';
      readonly message: string;
    };

/** Learner-profile level info the planner may use (real stored values). */
export interface AdaptiveLessonProfileView {
  readonly learnerId: string;
  readonly displayName: string;
  readonly currentLevel: CefrLevelInput;
  readonly targetLevel: CefrLevelInput;
  readonly learningGoals: readonly string[];
  readonly preferredModes: readonly ConversationMode[];
}

export type { ReviewItemCandidate, EvaluationResult, ListeningExercise, ListeningEvaluation };
