/**
 * src/deep-speaking/types.ts
 *
 * Domain model for Deep Speaking Practice / Speaking Coach (Phase 1).
 *
 * CORE PRINCIPLES
 * - Deep Speaking is an ORCHESTRATION / TRAINING layer over the EXISTING
 *   ConversationEngine, ConversationSession, AIProvider, LearnerModel, voice
 *   stack, conversation memory and learning persistence. No second engine,
 *   no second session, no second scheduler, no second memory system.
 * - No numeric speaking scores, fluency percentages, CEFR changes, XP, streaks
 *   or badges — anywhere.
 * - `personalized` is only true when a plan materially uses REAL stored learner
 *   evidence (weaknesses, due expressions/vocabulary, goals, recent memory).
 *   Demo learner data is never personalized.
 * - The planner is PURE: no I/O, no AI call, no clock read (caller supplies now).
 * - Weakness lifecycle is NEVER mutated by this module — reading only.
 */

import type {
  ConversationMode,
  IsoDate,
  WeaknessStatus,
} from '../domain/shared/types';
import type { LearnerWeakness } from '../domain/models/learner';
import type { SkillDomain } from '../curriculum/types';
import type {
  DifficultyProfile,
  ProgressionLevel,
} from '../learning-progression/types';
import type { CoachingContext, CoachingRecentConversation } from '../learner-model';
import type { ConversationFeedback, ConversationFeedbackVocabulary } from '../providers/ai/types';
import type { ConversationSession, ConversationSessionResult } from '../conversation-session';
import type { FinalizeConversationResult } from '../talk-demo/conversation-memory';

/* ------------------------------------------------------------------ *
 * Practice types
 * ------------------------------------------------------------------ */

export type SpeakingPracticeType =
  | 'free_conversation'
  | 'guided_topic'
  | 'role_play'
  | 'explain_and_expand'
  | 'opinion_and_reasoning'
  | 'problem_solution'
  | 'retell_or_summarize'
  | 'reformulation'
  | 'target_expression_practice'
  | 'weakness_retraining';

export type SpeakingPracticeSource = 'personalized' | 'mixed' | 'general';

/* ------------------------------------------------------------------ *
 * Focus / targets
 * ------------------------------------------------------------------ */

export type SpeakingFocusArea =
  | 'Grammar'
  | 'Vocabulary'
  | 'Expressions'
  | 'Fluency'
  | 'Confidence'
  | 'Pronunciation'
  | 'Listening';

export interface SpeakingFocus {
  readonly area: SpeakingFocusArea;
  readonly detail: string;
  readonly count?: number;
}

export interface SpeakingTargetExpression {
  readonly itemId: string;
  readonly headword: string;
  readonly meaning: string;
  readonly reason: string;
}

export interface SpeakingWeaknessTarget {
  readonly weaknessId: string;
  readonly type: LearnerWeakness['type'];
  readonly label?: string;
  readonly status: WeaknessStatus;
  readonly occurrenceCount: number;
  readonly reason: string;
}

/* ------------------------------------------------------------------ *
 * Turn goals
 * ------------------------------------------------------------------ */

export type SpeakingTurnGoalKind =
  | 'open'
  | 'follow_up'
  | 'expand'
  | 'reformulate'
  | 'target_expression'
  | 'weakness_retraining'
  | 'wrap_up';

export interface SpeakingTurnGoal {
  readonly turnIndex: number;
  readonly goal: SpeakingTurnGoalKind;
  readonly instruction: string;
  readonly optional?: boolean;
}

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

export interface SpeakingPracticePlan {
  readonly id: string;
  readonly learnerId: string;
  readonly createdAt: IsoDate;
  readonly practiceType: SpeakingPracticeType;
  readonly topic: string;
  /** Tutor opening instruction (sent via session.openConversation). */
  readonly scenarioPrompt: string;
  readonly coachingMode: ConversationMode;
  readonly source: SpeakingPracticeSource;
  readonly sourceNote: string;
  readonly focusAreas: readonly SpeakingFocus[];
  readonly targetExpressions: readonly SpeakingTargetExpression[];
  readonly weaknessTargets: readonly SpeakingWeaknessTarget[];
  readonly targetTurns: number;
  readonly hardMaxTurns: number;
  readonly turnGoals: readonly SpeakingTurnGoal[];
  readonly recentMemoryNote?: string;
  /**
   * WP-1: bounded working-level guidance the coach is given. Absent for every
   * caller that does not supply already-resolved progression input, in which
   * case the plan and the coaching prompt are byte-identical to before.
   */
  readonly progression?: SpeakingProgressionGuidance;
  readonly seedFromAdaptiveLesson?: SpeakingPracticeSeed;
  /**
   * Set when the practice conducts a Professional English scenario. Carried so
   * the session, the coaching prompt and the summary can state honestly which
   * scenario ran — it never adds scores or performance claims.
   */
  readonly professionalScenario?: SpeakingProfessionalScenario;
}

export type SpeakingPracticePlanResult =
  | { readonly status: 'no-profile'; readonly message: string; readonly plan: null }
  | { readonly status: 'planned'; readonly plan: SpeakingPracticePlan }
  | { readonly status: 'unavailable'; readonly message: string; readonly plan: null };

/* ------------------------------------------------------------------ *
 * Planning input
 * ------------------------------------------------------------------ */

export interface SpeakingPlanningInput {
  readonly coaching: CoachingContext;
  readonly hasProfile: boolean;
  readonly recentConversations: readonly CoachingRecentConversation[];
  readonly now: IsoDate;
  /**
   * False only when the supplied learner state is NOT real stored evidence
   * (e.g. the deterministic demo learner model). Such a plan is NEVER labeled
   * `personalized`/`mixed`: it degrades to honest general practice and carries
   * no learner-specific focus, targets or memory note.
   */
  readonly evidenceIsReal?: boolean;
  /**
   * WP-1: already-resolved progression guidance (working level + difficulty
   * profile + bounded saved lexicon). The owning service assembles it from the
   * snapshot it already loaded; it is never resolved or fetched here.
   */
  readonly progression?: SpeakingProgressionGuidance;
}

/**
 * Optional seed handed over from an EXISTING Adaptive Lesson speaking step.
 * It only names the existing step and its real target text — it never carries
 * learner evidence of its own.
 */
export interface SpeakingPracticeSeed {
  readonly stepId: string;
  readonly targetText: string;
  readonly prompt?: string;
}

/**
 * Bounded professional scenario content coming from the Professional English
 * content layer (src/professional-english). Additive: the Deep Speaking
 * planner only fills the fields it already knows how to use (topic, scenario
 * prompt, bounded lexical targets, coaching prompt context).
 *
 * HONESTY RULES
 * - This carries SCENARIO CONTENT ONLY. It is never learner evidence, so it
 *   must never by itself justify a 'personalized' source label.
 * - `targetExpressions` is already bounded by the content layer (at most
 *   MAX_TARGET_EXPRESSIONS) and in the plan it only fills the slots not taken
 *   by the learner's real saved expressions — it never replaces them.
 * - `challengeEvents` are bounded scenario guidance for the tutor: they are
 *   never a trigger for extra AI requests and are never forced.
 * - There are deliberately no scores, percentages or exam bands here.
 */
export interface SpeakingProfessionalScenario {
  /** Stable professional scenario id (e.g. 'negotiation'). */
  readonly scenarioId: string;
  readonly title: string;
  /** The situation the conversation takes place in. */
  readonly situation: string;
  /** The role the learner plays. */
  readonly learnerRole: string;
  /** The role the tutor plays (the counterparty). */
  readonly counterpartyRole: string;
  /** What the learner should achieve in the scenario. */
  readonly objective: string;
  /** Qualitative scenario difficulty (not an exam band, not a score). */
  readonly difficulty: 'simple' | 'moderate' | 'complex';
  /** Qualitative coaching posture from the content layer (context only). */
  readonly coachingPosture: string;
  /** Scenario coaching notes from the content catalog. */
  readonly coachingNotes: string;
  /** The scenario's speaking goals (bounded by the catalog). */
  readonly speakingGoals: readonly { readonly id: string; readonly description: string }[];
  /** The scenario's useful-language goals (bounded by the catalog). */
  readonly languageGoals: readonly { readonly id: string; readonly description: string }[];
  /** Bounded scenario language targets (practice context, not saved vocabulary). */
  readonly targetExpressions: readonly string[];
  /** Bounded scenario guidance for the tutor (never forced, never announced). */
  readonly challengeEvents: readonly { readonly id: string; readonly description: string }[];
  /** Real profession/industry context, present only when the learner has one. */
  readonly professionalContext?: string;
}

/**
 * WP-1: ALREADY-RESOLVED progression guidance for the speaking coach.
 *
 * This is pure data assembled by the existing service/context layer from the
 * learner snapshot it already loaded (working level, loaded negative evidence,
 * already-bounded saved lexicon). The planner never resolves it and performs no
 * read of its own, so `planSpeakingPractice` stays pure.
 *
 * HONESTY RULES
 * - `workingLevel` is a stored WORKING LEVEL, never proof of proficiency: the
 *   prompt describes HOW the tutor should speak, not what the learner can do.
 * - `knownVocabulary` is a BOUNDED list of saved items. It is never the
 *   learner's complete vocabulary and the prompt says so.
 * - `newLanguageBudget` bounds deliberately introduced target language; it is
 *   not a claim that every other word is known.
 * - `targetSkill` is present ONLY when an existing curriculum skill is genuinely
 *   mapped. It is never guessed to make guidance look richer.
 * - There is deliberately no score, band, percentage or fluency number here.
 */
export interface SpeakingProgressionGuidance {
  readonly workingLevel: ProgressionLevel;
  readonly difficultyProfile: DifficultyProfile;
  /** Bounded, deduplicated saved-lexicon context (see MAX_KNOWN_VOCABULARY). */
  readonly knownVocabulary: readonly string[];
  readonly targetSkill?: SpeakingCurriculumTarget;
}

/** A genuinely mapped existing curriculum skill (never guessed). */
export interface SpeakingCurriculumTarget {
  readonly domain: SkillDomain;
  readonly skillId?: string;
}

export interface SpeakingPlannerOptions {
  readonly practiceType?: SpeakingPracticeType;
  readonly seed?: SpeakingPracticeSeed;
  readonly targetTurns?: number;
  /**
   * Additive (Professional English content layer): bounded professional
   * scenario content that the EXISTING pipeline conducts. Existing callers
   * never set this — behaviour without it is unchanged.
   */
  readonly professionalScenario?: SpeakingProfessionalScenario;
}

/* ------------------------------------------------------------------ *
 * Session / progress / summary
 * ------------------------------------------------------------------ */

export interface SpeakingPracticeSession {
  readonly id: string;
  readonly plan: SpeakingPracticePlan;
  readonly startedAt: IsoDate;
  /** The EXISTING ConversationSession that owns the conversation. */
  readonly conversationSession: ConversationSession;
  readonly learnerTurnCount: number;
  readonly completed: boolean;
  readonly endedAt?: IsoDate;
}

export interface SpeakingPracticeProgress {
  readonly totalTurns: number;
  readonly learnerTurns: number;
  readonly remaining: number;
  readonly isComplete: boolean;
  readonly label: string;
}

/**
 * Summary sections. There is deliberately no "what went well" section: the
 * existing feedback model corrects selectively, so the absence of a correction
 * is not evidence of good grammar, naturalness or fluency.
 */
export type SpeakingSummarySectionId =
  | 'corrections'
  | 'expressions'
  | 'practice_next';

export interface SpeakingSummarySection {
  readonly id: SpeakingSummarySectionId;
  readonly title: string;
  readonly items: readonly string[];
}

export interface SpeakingPracticeSummary {
  readonly sessionId: string;
  readonly planId: string;
  readonly practiceType: SpeakingPracticeType;
  readonly source: SpeakingPracticeSource;
  readonly learnerTurns: number;
  readonly tutorTurns: number;
  readonly sections: readonly SpeakingSummarySection[];
  readonly hasEvidence: boolean;
  readonly isDemo: boolean;
  readonly notice: string;
  readonly persistence: FinalizeConversationResult;
  readonly generatedAt: IsoDate;
}

/* ------------------------------------------------------------------ *
 * Turn-level feedback (qualitative, no scores)
 * ------------------------------------------------------------------ */

export interface SpeakingTurnFeedback {
  readonly feedback: ConversationFeedback | null;
  readonly correctionSeverity?: ConversationFeedback['correction'] extends infer C
    ? C extends null | undefined
      ? never
      : C extends { severity: infer S }
        ? S
        : never
    : never;
  readonly isRealAI: boolean;
}

/* ------------------------------------------------------------------ *
 * Re-exports for convenience
 * ------------------------------------------------------------------ */

export type {
  CoachingContext,
  CoachingRecentConversation,
  ConversationSession,
  ConversationSessionResult,
  ConversationFeedback,
  ConversationFeedbackVocabulary,
  FinalizeConversationResult,
};
