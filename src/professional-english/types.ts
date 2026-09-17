/**
 * Professional English Core — domain model.
 *
 * Step 1 defines the deterministic domain model only:
 * - scenario categories and qualitative professional levels
 * - the scenario definition shape
 * - the learner profile + planner input
 * - the generated scenario plan
 *
 * There are deliberately NO numeric skill scores, percentages, CEFR
 * mappings, persistence, or AI/network dependency in this module. The
 * planner is a pure, deterministic function.
 */

/** Professional speaking situations the tutor can stage. */
export type ScenarioCategory =
  | 'meeting'
  | 'project_update'
  | 'presentation'
  | 'interview'
  | 'negotiation'
  | 'client_discussion'
  | 'stakeholder_discussion'
  | 'problem_solving'
  | 'reporting'
  | 'email_discussion'
  | 'site_discussion'
  | 'claim_discussion'
  | 'contract_discussion'
  | 'technical_explanation'
  | 'leadership_conversation';

/** Every supported category, in stable declaration order. */
export const SCENARIO_CATEGORIES: readonly ScenarioCategory[] = [
  'meeting',
  'project_update',
  'presentation',
  'interview',
  'negotiation',
  'client_discussion',
  'stakeholder_discussion',
  'problem_solving',
  'reporting',
  'email_discussion',
  'site_discussion',
  'claim_discussion',
  'contract_discussion',
  'technical_explanation',
  'leadership_conversation',
] as const;

/**
 * Qualitative professional level. Deliberately NOT an exam band or a
 * numeric score — it only shapes how much scaffolding a scenario gets.
 */
export type ProfessionalLevel = 'foundation' | 'developing' | 'independent' | 'advanced';

/** Ordered from least to most experienced; used for qualitative ordering. */
export const PROFESSIONAL_LEVELS: readonly ProfessionalLevel[] = [
  'foundation',
  'developing',
  'independent',
  'advanced',
] as const;

/** Complexity of the situation a scenario presents. */
export type DifficultyBand = 'simple' | 'moderate' | 'complex';

/** Ordered from least to most demanding; used for qualitative ordering. */
export const DIFFICULTY_ORDER: readonly DifficultyBand[] = [
  'simple',
  'moderate',
  'complex',
] as const;

/** How a scenario is meant to be practised. */
export type PracticeType =
  | 'guided_dialogue'
  | 'role_play'
  | 'structured_exchange'
  | 'open_discussion'
  | 'simulated_call'
  | 'prepared_monologue'
  | 'question_and_answer';

/** Coaching postures the tutor can adopt during a scenario. */
export type CoachingMode = 'supportive' | 'balanced' | 'challenging';

/** What a learner is working towards. Kept qualitative. */
export type LearningGoal =
  | 'everyday_fluency'
  | 'workplace_communication'
  | 'client_communication'
  | 'meetings_and_updates'
  | 'presentations'
  | 'interviews'
  | 'negotiation'
  | 'technical_discussion'
  | 'leadership'
  | 'reporting_and_writing';

/** A reusable speaking target within a scenario. */
export interface SpeakingGoal {
  /** Stable, machine-friendly identifier. */
  readonly id: string;
  /** Human-readable description of the speaking behaviour. */
  readonly description: string;
}

/** A reusable "useful language" target (functional language to practise). */
export interface LanguageGoal {
  readonly id: string;
  readonly description: string;
}

/**
 * A challenge injected into a scenario to keep the practice adaptive.
 * `minComplexityRank` is a qualitative gate: the challenge is included once
 * the scenario's difficulty rank reaches this level. Higher ranks are always
 * allowed to include lower-rank challenges; the planner decides inclusion.
 */
export interface ChallengeEvent {
  readonly id: string;
  readonly description: string;
  /** Qualitative gate expressed as an index into DIFFICULTY_ORDER. */
  readonly minComplexityRank: number;
}

/** Optional per-scenario difficulty override. */
export interface CategoryDifficultyDescriptor {
  readonly band: DifficultyBand;
  readonly reasoning: string;
}

/** An immutable, data-driven scenario specification. */
export interface ScenarioDefinition {
  /** Stable id, e.g. "meeting". */
  readonly id: ScenarioCategory;
  readonly category: ScenarioCategory;
  readonly title: string;
  /** The situation the conversation takes place in. */
  readonly situation: string;
  /** The role the learner plays. */
  readonly learnerRole: string;
  /** The role the tutor (or counterparty) plays. */
  readonly counterpartyRole: string;
  /** What the learner should achieve by the end of the scenario. */
  readonly objective: string;
  readonly speakingGoals: readonly SpeakingGoal[];
  readonly languageGoals: readonly LanguageGoal[];
  /** Scenario-level target expressions the planner may sample from. */
  readonly targetExpressions: readonly string[];
  readonly challengeEvents: readonly ChallengeEvent[];
  readonly practiceType: PracticeType;
  readonly difficulty: CategoryDifficultyDescriptor;
  readonly coachingNotes: string;
}

/** What the caller knows about the learner. Every field is optional. */
export interface LearnerProfile {
  readonly level?: ProfessionalLevel;
  readonly goals?: readonly LearningGoal[];
  /** Free-text profession or industry, when available. */
  readonly profession?: string;
  /** Qualitative description of areas that need work (no scores). */
  readonly weaknesses?: readonly string[];
  readonly targetExpressions?: readonly string[];
  readonly coachingMode?: CoachingMode;
  readonly scenarioDifficulty?: DifficultyBand | ProfessionalLevel;
}

/** Input to the deterministic planner. */
export interface PlannerInput {
  readonly category: ScenarioCategory;
  readonly learner?: LearnerProfile;
  /** Maximum number of target expressions in the plan. Defaults to 6. */
  readonly maxTargetExpressions?: number;
}

/**
 * The deterministic scenario plan produced by the planner.
 *
 * Note the absence of any numeric skill score or percentage: only the
 * qualitative `difficulty` descriptor is carried.
 */
export interface ScenarioPlan {
  readonly scenarioId: ScenarioCategory;
  readonly category: ScenarioCategory;
  readonly title: string;
  readonly situation: string;
  readonly learnerRole: string;
  readonly counterpartyRole: string;
  readonly objective: string;
  readonly speakingGoals: readonly SpeakingGoal[];
  readonly languageGoals: readonly LanguageGoal[];
  readonly targetExpressions: readonly string[];
  readonly challengeEvents: readonly ChallengeEvent[];
  readonly practiceType: PracticeType;
  readonly difficulty: DifficultyBand;
  readonly difficultyDescriptor: CategoryDifficultyDescriptor;
  readonly coachingMode: CoachingMode;
  readonly coachingNotes: string;
  /**
   * Optional profession/industry context carried for the future execution
   * layer. At this step it does NOT alter the deterministic scenario,
   * examples, or register — it is context only, never an applied adaptation.
   */
  readonly professionalContext?: string;
  /** Human-readable, qualitative rationale for personalization choices. */
  readonly personalizationNotes: readonly string[];
  /** True when no category matched and the general fallback was used. */
  readonly isFallback: boolean;
}
