/**
 * Skill Map + Curriculum Core — domain model (Phase 1).
 *
 * Pure, deterministic, dependency-free domain for the AI English Tutor
 * curriculum. There is deliberately:
 *   - NO persistence, NO SQLite, NO repositories
 *   - NO AI, NO network
 *   - NO React / navigation
 *   - NO numeric mastery score, percentage, XP, or CEFR mapping
 *
 * Skill strength is expressed ONLY through a qualitative lifecycle state.
 */

/**
 * The six top-level skill domains. Exactly these six, in stable order.
 * Learners typically progress across all of them; the curriculum planner
 * works on individual skills, never on a domain-level score.
 */
export type SkillDomain =
  | 'grammar'
  | 'vocabulary'
  | 'expressions'
  | 'speaking'
  | 'listening'
  | 'pronunciation';

/** Every supported domain, in stable declaration order (exactly six). */
export const CURRICULUM_DOMAINS: readonly SkillDomain[] = [
  'grammar',
  'vocabulary',
  'expressions',
  'speaking',
  'listening',
  'pronunciation',
] as const;

/**
 * Qualitative skill lifecycle.
 *
 * This mirrors the project's existing learning philosophy (the same eight
 * states used by the learner model) as a LOCAL, compatible type. It is defined
 * here rather than imported so the curriculum core stays acyclic and free of
 * any repository/domain coupling.
 *
 * Deliberately NOT an exam band and NOT a numeric score.
 */
export type SkillLifecycleState =
  | 'observed'
  | 'repeated'
  | 'confirmed'
  | 'active_training'
  | 'improving'
  | 'stable'
  | 'mastered'
  | 'relapsed';

/** Every lifecycle state, in stable declaration order. */
export const SKILL_LIFECYCLE_STATES: readonly SkillLifecycleState[] = [
  'observed',
  'repeated',
  'confirmed',
  'active_training',
  'improving',
  'stable',
  'mastered',
  'relapsed',
] as const;

/**
 * Identifier of a system that can produce evidence about a skill.
 * These are identifiers ONLY — no persistence is read in this phase.
 */
export type SkillEvidenceSource =
  | 'conversation'
  | 'adaptive_lesson'
  | 'review'
  | 'listening'
  | 'pronunciation'
  | 'vocabulary'
  | 'deep_speaking';

/** How a skill is best practised. Qualitative, not scored. */
export type PracticeMode =
  | 'guided_dialogue'
  | 'role_play'
  | 'drill'
  | 'shadowing'
  | 'listening_task'
  | 'review'
  | 'free_speaking'
  | 'reading_aloud';

/** A single skill in the map. Immutable, data-driven, extensible. */
export interface SkillNode {
  /** Stable, unique identifier, e.g. "present_tense". */
  readonly id: string;
  readonly domain: SkillDomain;
  readonly title: string;
  readonly description: string;
  /** Skill ids that should normally be established first. */
  readonly prerequisites: readonly string[];
  /** Optional loose associations (never blocking). */
  readonly relatedSkills: readonly string[];
  /** Systems that can observe this skill. Identifiers only. */
  readonly evidenceSources: readonly SkillEvidenceSource[];
  readonly recommendedPracticeTypes: readonly PracticeMode[];
}

/**
 * A detached/partial skill definition used for building a catalog or for
 * graph validation in isolation. Every field except `id` is optional so
 * fragments can be validated without full definitions.
 */
export interface SkillFragment {
  readonly id: string;
  readonly domain?: SkillDomain;
  readonly prerequisites?: readonly string[];
  readonly relatedSkills?: readonly string[];
}

/** Problem categories the graph validator can report. */
export type SkillGraphIssueKind =
  | 'duplicate_id'
  | 'empty_id'
  | 'self_prerequisite'
  | 'duplicate_prerequisite'
  | 'missing_prerequisite'
  | 'unknown_domain'
  | 'cycle';

/** A single validation finding. Qualitative and human-readable. */
export interface SkillGraphIssue {
  readonly kind: SkillGraphIssueKind;
  /** The skill the issue is attached to (best-effort). */
  readonly skillId: string;
  readonly message: string;
  /** For `cycle` issues: the ordered ids forming the cycle. */
  readonly cycle?: readonly string[];
}

/** Result of validating a skill graph. */
export interface SkillGraphValidation {
  readonly valid: boolean;
  readonly issues: readonly SkillGraphIssue[];
}

/** A learner's evidence about ONE skill. Metadata only — never a score. */
export interface SkillEvidenceSnapshot {
  readonly skillId: string;
  readonly lifecycleState: SkillLifecycleState;
  /** Optional ISO timestamp of the last observation. */
  readonly lastObservedAt?: string;
  /**
   * Optional count of observations for this skill.
   * METADATA ONLY — never converted into a score, percentage, CEFR band, or
   * rating anywhere in this module.
   */
  readonly evidenceCount?: number;
}

/** Qualitative learning-goal hints that can bias planning. */
export type LearningGoalHint =
  | 'everyday_fluency'
  | 'workplace_communication'
  | 'listening_comprehension'
  | 'pronunciation_clarity'
  | 'vocabulary_growth'
  | 'grammar_accuracy'
  | 'speaking_confidence';

/** Every supported learning-goal hint, in stable order. */
export const LEARNING_GOAL_HINTS: readonly LearningGoalHint[] = [
  'everyday_fluency',
  'workplace_communication',
  'listening_comprehension',
  'pronunciation_clarity',
  'vocabulary_growth',
  'grammar_accuracy',
  'speaking_confidence',
] as const;

/** Input to the deterministic curriculum planner. */
export interface CurriculumPlannerInput {
  readonly evidence?: readonly SkillEvidenceSnapshot[];
  /** Skill ids the learner is currently struggling with (qualitative). */
  readonly activeWeaknesses?: readonly string[];
  /** Skill ids practised recently (used only to avoid immediate repetition). */
  readonly recentlyPractised?: readonly string[];
  /** Restrict the plan to a single domain when supplied. */
  readonly requestedDomain?: SkillDomain;
  /** Maximum number of recommended items. */
  readonly maxItems?: number;
  /** Optional qualitative goal hints. */
  readonly learningGoals?: readonly LearningGoalHint[];
  /** Explicit reference time. Never read from the system clock. */
  readonly now?: string;
}

/** Why a skill was recommended — honest, qualitative, traceable. */
export interface CurriculumReason {
  readonly code: CurriculumReasonCode;
  readonly message: string;
}

/** Stable reason codes so callers can render or translate them. */
export type CurriculumReasonCode =
  | 'relapsed'
  | 'confirmed'
  | 'active_training'
  | 'repeated'
  | 'observed'
  | 'improving_in_rotation'
  | 'stable_maintenance'
  | 'prerequisite_for_blocked'
  | 'learning_goal_domain'
  | 'new_skill'
  | 'domain_focus'
  | 'active_weakness'
  | 'recently_practised';

/**
 * Planner-only qualitative status. Deliberately DISTINCT from the learning
 * lifecycle: `unobserved` means the planner has no evidence at all, so it is
 * never fabricated as the real `observed` evidence state.
 */
export type PlannerSkillStatus = 'evidenced' | 'unobserved';

/** One recommended skill in the plan. */
export interface CurriculumRecommendation {
  readonly skillId: string;
  readonly domain: SkillDomain;
  readonly title: string;
  /**
   * The EVIDENCED lifecycle state, or `null` when the learner has no evidence
   * for this skill. A no-evidence skill is never fabricated as `observed`.
   */
  readonly lifecycleState: SkillLifecycleState | null;
  /**
   * Planner-only status. `unobserved` distinguishes a brand-new skill from one
   * with real (even if minimal) evidence.
   */
  readonly status: PlannerSkillStatus;
  readonly reasons: readonly CurriculumReason[];
  /** Skill ids that blocked this item, if any. */
  readonly blockedByPrerequisites: readonly string[];
}

/** The deterministic output of the planner. */
export interface CurriculumPlan {
  readonly recommendations: readonly CurriculumRecommendation[];
  /** Domain filter applied, when the caller requested one. */
  readonly requestedDomain?: SkillDomain;
  /** Goal hints that actually changed the plan (may be empty). */
  readonly appliedLearningGoals: readonly LearningGoalHint[];
  /** Human-readable notes about what was and was not applied. */
  readonly notes: readonly string[];
}
