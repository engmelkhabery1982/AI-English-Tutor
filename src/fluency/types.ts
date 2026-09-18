/**
 * src/fluency/types.ts
 *
 * WP-3 (Fluency / Automaticity / Interaction) domain model.
 *
 * CORE PRINCIPLES
 * - Fluency training is an ORCHESTRATION layer over the EXISTING systems:
 *   SpeakingPracticeService (which itself owns ConversationEngine,
 *   ConversationOrchestrator, ConversationSession), VoiceSessionCoordinator,
 *   LearnerModel (read-only, behind the speaking service), conversation memory
 *   and learning persistence. No second engine, session, voice coordinator,
 *   learner model, mastery store or AI provider — anywhere.
 * - No numeric fluency scores, improvement percentages, XP, stars, streaks,
 *   points or CEFR changes — anywhere.
 * - Repetition trains AUTOMATICITY (retrieval + less support), never
 *   memorization scoring. Improvement is only ever described with the bounded
 *   qualitative statements in ./evidence.ts, each gated on real evidence.
 * - Response length is descriptive evidence only: a longer answer is never
 *   automatically better, and length never feeds the support policy.
 * - The de-scaffolding policy (./support-policy.ts) is PURE and deterministic:
 *   same inputs always yield the same bounded support level.
 * - Repair (./repair-policy.ts) is never faked: a clarification prompt needs a
 *   real evidence reason or an explicit repair-exercise scenario contract, and
 *   scripted misunderstanding is always labeled as deliberate practice.
 * - LearningPersistenceService (behind the speaking service) remains the SOLE
 *   mutation owner. This module never calls it: comparison and repetition
 *   bookkeeping are read-only and can never double-count evidence.
 */

import type { CefrLevelInput, IsoDate } from '../domain/shared/types';
import type { ConversationFeedback } from '../providers/ai/types';
import type { ConversationSession } from '../conversation-session';
import type { SpeakingPracticeSummary } from '../deep-speaking/types';

/* ------------------------------------------------------------------ *
 * Support levels (bounded de-scaffolding output)
 * ------------------------------------------------------------------ */

/** Bounded support a fluency task may show. Nothing else exists. */
export type FluencySupportLevel = 'guided' | 'supported' | 'independent';

/* ------------------------------------------------------------------ *
 * Fluency session phase (explicit domain state, not React effects)
 * ------------------------------------------------------------------ */

/**
 * Explicit phase of ONE fluency task practice.
 *
 * - ready:        no task started yet.
 * - preparing:    the task is being prepared (underlying practice + opening).
 * - speaking:     the task is shown and the microphone is the primary action
 *                 (the learner may also type). This names the PRACTICE phase —
 *                 actual recording/STT/TTS lifecycle stays owned by the
 *                 EXISTING VoiceSessionCoordinator and is never duplicated here.
 * - processing:   a learner attempt was submitted and the tutor reply is in
 *                 flight (single-flight: exactly one at a time).
 * - feedback:     the tutor reply + real structured feedback are available.
 * - repeat_ready: feedback was acknowledged; Repeat / Next / Finish are valid.
 * - completed:    the task practice was finalized (idempotent summary kept).
 * - error:        the last operation failed honestly (no attempt was counted,
 *                 no evidence was written); retry is allowed from here.
 */
export type FluencyPhase =
  | 'ready'
  | 'preparing'
  | 'speaking'
  | 'processing'
  | 'feedback'
  | 'repeat_ready'
  | 'completed'
  | 'error';

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

/** What kind of deliberate practice a task is. */
export type FluencyTaskKind = 'repetition' | 'monologue' | 'repair';

/** One required task point (deterministic keyword coverage, never AI-judged). */
export interface FluencyTaskPoint {
  readonly id: string;
  readonly label: string;
  /**
   * Deterministic coverage signals: the point counts as covered when ANY
   * keyword is found in the learner's committed transcript (normalized,
   * case-insensitive). Keywords are descriptive evidence, never a score.
   */
  readonly keywords: readonly string[];
}

/** One target expression the learner is invited to reuse naturally. */
export interface FluencyTargetExpression {
  readonly expression: string;
  readonly meaning: string;
}

/**
 * Optional explicit repair-exercise contract.
 *
 * Present ONLY for tasks whose declared learning goal IS clarification/repair
 * practice. It is the ONLY license for the tutor layer to deliberately prompt
 * for clarification, and the UI must show `practiceLabel` so scripted
 * misunderstanding is never presented as a genuine failure to understand.
 */
export interface FluencyRepairContract {
  readonly isRepairExercise: true;
  readonly practiceLabel: string;
  readonly learnerGoal: string;
}

export interface FluencyTask {
  /** Stable identity: NEVER changes across repetitions of this task. */
  readonly id: string;
  readonly kind: FluencyTaskKind;
  readonly title: string;
  /** The task prompt shown to the learner (Attempt 1, Attempt 2, ...). */
  readonly prompt: string;
  /** 2-3 points to cover (bounded, see MAX_TASK_POINTS). */
  readonly taskPoints: readonly FluencyTaskPoint[];
  /** Bounded reusable target language (see MAX_TASK_TARGET_EXPRESSIONS). */
  readonly targetExpressions: readonly FluencyTargetExpression[];
  /** Opening idea shown as support (never a full model answer). */
  readonly openingIdea: string;
  /** Bounded sequencing phrases (support, not a script). */
  readonly sequencingPhrases: readonly string[];
  /** Closing prompt shown as support. */
  readonly closingPrompt: string;
  /** Present only when this task IS a declared repair exercise. */
  readonly repairContract?: FluencyRepairContract;
  /**
   * Optional transfer task: a RELATED context with the SAME learning target
   * (avoids memorization). Absent when the task has no transfer variant.
   */
  readonly transferTaskId?: string;
  /** The stable learning target (shared with the transfer variant). */
  readonly learningTarget: string;
}

/**
 * Support cues actually shown for an attempt. Bounded by support level
 * (see cuesForSupport): guided shows everything, supported shows fewer cues,
 * independent shows the task only.
 */
export interface FluencyCues {
  readonly openingIdea: string | null;
  readonly taskPoints: readonly FluencyTaskPoint[];
  readonly targetExpressions: readonly FluencyTargetExpression[];
  readonly sequencingPhrases: readonly string[];
  readonly closingPrompt: string | null;
  /** True when the attempt runs with the task prompt only (no cues). */
  readonly taskOnly: boolean;
}

/* ------------------------------------------------------------------ *
 * Attempts & evidence (committed attempts only)
 * ------------------------------------------------------------------ */

/** Qualitative correction presence of ONE committed attempt (no scores). */
export type FluencyCorrectionPresence =
  | { readonly present: false }
  | { readonly present: true; readonly severity: 'incorrect' | 'unnatural' | 'minor' };

/**
 * Structured evidence of ONE committed learner attempt.
 *
 * Recorded ONLY when the underlying ConversationSession really committed the
 * turn (real learner turn + real tutor reply). Failed STT, failed AI, replay
 * and stale results never create evidence.
 */
export interface FluencyAttemptEvidence {
  readonly attemptNumber: number;
  readonly taskId: string;
  /** The learner's committed transcript (exactly as submitted). */
  readonly transcript: string;
  /** Descriptive only — never a quality signal by itself. */
  readonly wordCount: number;
  /** Task-point ids covered deterministically (see FluencyTaskPoint). */
  readonly pointsCovered: readonly string[];
  /** Target expressions found deterministically in the transcript. */
  readonly targetExpressionsUsed: readonly string[];
  readonly correction: FluencyCorrectionPresence;
  /**
   * Real qualitative pronunciation lines produced by the EXISTING engine for
   * this attempt (verbatim). Empty when pronunciation was unavailable — the
   * comparison then omits pronunciation instead of inventing it.
   */
  readonly pronunciationLines: readonly string[];
  /**
   * True only when a REAL AI provider produced the feedback. Demo/offline
   * attempts are counted (the attempt really happened) but NEVER trusted for
   * evaluative claims, comparisons or de-scaffolding.
   */
  readonly trusted: boolean;
  readonly committedAt: IsoDate;
}

/* ------------------------------------------------------------------ *
 * Repetition comparison (real structured evidence only)
 * ------------------------------------------------------------------ */

/**
 * Qualitative comparison of two consecutive committed attempts of the SAME
 * task. There is deliberately no numeric delta, no percentage and no rating:
 * `lines` are descriptive evidence lines plus the bounded allowed claims from
 * ./evidence.ts, each emitted only when directly supported.
 */
export interface FluencyComparison {
  readonly taskId: string;
  readonly previousAttempt: number;
  readonly currentAttempt: number;
  /** Learner-facing lines (evidence + allowed claims + notices). */
  readonly lines: readonly string[];
  /** True only when at least one evidence line (not just a notice) exists. */
  readonly hasEvidence: boolean;
  readonly generatedAt: IsoDate;
}

/** Deterministic repeat prompt for the next round of the SAME task. */
export interface FluencyRepeatPrompt {
  readonly taskId: string;
  readonly nextAttemptNumber: number;
  readonly supportLevel: FluencySupportLevel;
  readonly text: string;
}

/* ------------------------------------------------------------------ *
 * Repair / clarification
 * ------------------------------------------------------------------ */

/** Which conversational surface a repair decision is evaluated for. */
export type FluencyRepairSurface = 'talk' | 'fluency';

/** Why a clarification prompt is (or is not) allowed. */
export type FluencyRepairReason =
  | 'talk-never-fakes'
  | 'no-evidence'
  | 'insufficient-content'
  | 'real-correction'
  | 'repair-exercise';

export interface FluencyRepairDecision {
  readonly allowed: boolean;
  readonly reason: FluencyRepairReason;
  /** True only for an explicit repair-exercise scenario (labeled practice). */
  readonly scripted: boolean;
  /**
   * The practice label the UI MUST show when `scripted` is true, so the
   * learner knows the misunderstanding is deliberate practice.
   */
  readonly practiceLabel: string | null;
  /** The clarification prompt (guidance), present only when allowed. */
  readonly prompt: string | null;
}

/** Bounded, contextual communication-strategy support (never dumped mid-turn). */
export interface FluencyRepairMove {
  readonly id: string;
  readonly label: string;
  readonly examples: readonly string[];
}

/* ------------------------------------------------------------------ *
 * Session snapshot & summary
 * ------------------------------------------------------------------ */

/**
 * Explicit domain snapshot of the fluency practice: task identity, attempt
 * number and support level are FIRST-CLASS state here, never hidden only in
 * React effects. Voice recording/STT/TTS state is deliberately ABSENT: it
 * stays owned by the existing VoiceSessionCoordinator.
 */
export interface FluencySessionSnapshot {
  readonly phase: FluencyPhase;
  readonly taskId: string | null;
  readonly taskKind: FluencyTaskKind | null;
  /** Number of COMMITTED attempts for the current task (failed work = 0). */
  readonly attemptNumber: number;
  readonly supportLevel: FluencySupportLevel;
  /** True only when a real AI provider backs this practice. */
  readonly isRealAI: boolean;
  readonly hasActiveAttempt: boolean;
  readonly lastError: string | null;
  /** Consecutive strong committed attempts (de-scaffolding input). */
  readonly consecutiveStrongAttempts: number;
}

/** What submitting an attempt produced (or honestly refused). */
export type FluencyAttemptResult =
  | {
      readonly ok: true;
      readonly evidence: FluencyAttemptEvidence;
      /** Real structured feedback (null in demo: nothing invented). */
      readonly feedback: ConversationFeedback | null;
      /** The committed tutor reply text. */
      readonly tutorReply: string;
      /** Present from the second committed attempt of the task on. */
      readonly comparison: FluencyComparison | null;
      readonly repair: FluencyRepairDecision;
      readonly supportLevel: FluencySupportLevel;
    }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'failed' | 'stale' | 'refused';
      readonly errorMessage: string;
    };

/**
 * Final summary of ONE fluency task practice. Real counts + qualitative
 * evidence only: attempts, support trajectory, evidence lines. No scores.
 */
export interface FluencySummary {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly taskKind: FluencyTaskKind;
  /** Number of committed attempts (real count, never inflated). */
  readonly attempts: number;
  readonly startedSupport: FluencySupportLevel;
  readonly endedSupport: FluencySupportLevel;
  /** Support level per committed attempt (bounded, real trajectory). */
  readonly supportTrajectory: readonly FluencySupportLevel[];
  /** Bounded recent comparisons (evidence lines only, never scores). */
  readonly comparisons: readonly FluencyComparison[];
  readonly hasEvidence: boolean;
  readonly isDemo: boolean;
  readonly notice: string;
  /** The EXISTING speaking-practice summary (memory owner output). */
  readonly underlying: SpeakingPracticeSummary | null;
  readonly generatedAt: IsoDate;
}

/* ------------------------------------------------------------------ *
 * Re-exports for convenience
 * ------------------------------------------------------------------ */

export type { CefrLevelInput, ConversationFeedback, ConversationSession, IsoDate };
