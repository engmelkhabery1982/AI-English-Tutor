/**
 * src/daily-tutor/types.ts
 *
 * Daily AI Tutor Loop — domain model.
 *
 * The Daily Tutor is an ORCHESTRATION layer, not a learning engine:
 * - It decides WHAT to practise today (an ordered, bounded set of activities)
 *   from REAL stored learner evidence.
 * - Every activity routes into an EXISTING system (Review, Adaptive Lessons,
 *   Listening, Pronunciation Engine evidence, Deep Speaking, Professional
 *   English → Deep Speaking). Nothing here re-implements those systems.
 * - It persists ONLY Daily Tutor session/activity completion. Learning
 *   evidence (review state, weaknesses, conversation memory, progress
 *   records) is persisted exactly once by the system that owns it.
 *
 * Honesty rules (mirrors the rest of the repository):
 * - No numeric scores, percentages, XP, streaks, CEFR claims or fabricated
 *   improvement. Progress is count-based and qualitative ("2 of 4 activities").
 * - Estimated minutes are honest PLANNING estimates, never measurements.
 * - `sourceMode` claims personalization only when real stored evidence
 *   materially shaped the plan.
 */

/** Local calendar date key, 'YYYY-MM-DD'. */
export type DailyTutorDateKey = string;

/**
 * The activity kinds the Daily Tutor can schedule. Each one routes into an
 * existing engine/workflow — see `src/daily-tutor/navigation.ts` for the
 * concrete child route mapping.
 */
export type DailyActivityKind =
  | 'review'
  | 'vocabulary'
  | 'expressions'
  | 'adaptive_lesson'
  | 'listening'
  | 'pronunciation'
  | 'deep_speaking'
  | 'professional_english'
  | 'weakness_retraining';

/** Every supported activity kind, in stable declaration order. */
export const DAILY_ACTIVITY_KINDS: readonly DailyActivityKind[] = [
  'review',
  'vocabulary',
  'expressions',
  'adaptive_lesson',
  'listening',
  'pronunciation',
  'deep_speaking',
  'professional_english',
  'weakness_retraining',
] as const;

/** Lifecycle of ONE activity inside a daily session. */
export type DailyActivityStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

/** Lifecycle of a whole daily session. */
export type DailySessionStatus = 'planned' | 'in_progress' | 'completed' | 'abandoned';

/** Where a plan's content came from (honest personalization claim). */
export type DailyTutorSourceMode = 'personalized' | 'mixed' | 'general';

/**
 * Serializable routing context for one activity — the smallest context the
 * CHILD WORKFLOW ACTUALLY CONSUMES, handed over at launch and persisted with
 * the session so resume needs no re-planning.
 *
 * TARGET-FIDELITY CONTRACT: a target field may only claim what the launched
 * child is genuinely conditioned on. The Daily Tutor decides WHAT (the kind
 * +, where supported, a bounded focus); the child engine always owns HOW it
 * selects material. If an engine cannot be conditioned on a planned focus,
 * the planner must NOT put that focus here (nor in the title/reason) — the
 * activity is then worded generically instead.
 */
export interface DailyTutorActivityTarget {
  /**
   * Review-family emphasis for the existing Review flow. The Review screen
   * filters its planned candidates by this kind and bounds the count — the
   * child is genuinely conditioned on it.
   */
  readonly reviewKind?: 'vocabulary' | 'expression' | 'grammar';
  /** Bounded review subset size (consumed by the existing Review planner). */
  readonly reviewLimit?: number;
  /**
   * Curriculum skill provenance. Only set when the launched child is
   * actually conditioned on this skill — i.e. deep_speaking activities whose
   * practice type is mapped from this exact skill. Never set for
   * adaptive_lesson/listening/pronunciation activities (those engines pick
   * their own material and cannot be conditioned on a skill id).
   */
  readonly skillId?: string;
  /** Curriculum domain of the skill, when the skillId is set. */
  readonly domain?: string;
  /**
   * Speaking practice type for the Deep Speaking family — the child engine
   * plans its scenario from this type, so the child IS conditioned on it.
   */
  readonly practiceType?: string;
  /**
   * Professional English scenario category (from real goals). The launch
   * builds the scenario for exactly this category through the existing PE
   * planner, so the child IS conditioned on it.
   */
  readonly professionalCategory?: string;
}

/** ONE planned activity inside a daily session (pure plan data). */
export interface DailyTutorActivityPlan {
  /** Stable id: deterministic from learner/date/kind. */
  readonly id: string;
  readonly kind: DailyActivityKind;
  readonly title: string;
  /** Honest, human-readable reason this activity was chosen. */
  readonly reason: string;
  /** Honest planning estimate — never a measurement. */
  readonly estimatedMinutes: number;
  readonly target: DailyTutorActivityTarget;
}

/** ONE activity with its persisted execution state. */
export interface DailyTutorActivity extends DailyTutorActivityPlan {
  readonly status: DailyActivityStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  /**
   * Real item count reported by the child workflow at completion time, when
   * it provided one (e.g. review items practised, learner turns). Daily
   * Tutor session data only — the child system remains the owner of the
   * underlying learning evidence.
   */
  readonly practicedItems?: number;
}

/** The full plan for ONE learner on ONE local date. */
export interface DailyTutorPlan {
  readonly learnerId: string;
  readonly dateKey: DailyTutorDateKey;
  /** Honest one-line reason for today's plan. */
  readonly headline: string;
  readonly sourceMode: DailyTutorSourceMode;
  /** Sum of the activity estimates — an honest planning estimate. */
  readonly estimatedMinutes: number;
  readonly activities: readonly DailyTutorActivityPlan[];
}

/** A persisted daily session: the plan plus execution state. */
export interface DailyTutorSession {
  readonly id: string;
  readonly learnerId: string;
  readonly dateKey: DailyTutorDateKey;
  readonly status: DailySessionStatus;
  readonly headline: string;
  readonly sourceMode: DailyTutorSourceMode;
  readonly estimatedMinutes: number;
  readonly activities: readonly DailyTutorActivity[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/* ------------------------------------------------------------------ *
 * Planning input (REAL evidence only — never fabricated)
 * ------------------------------------------------------------------ */

/** One real, unresolved weakness summarized for planning. */
export interface DailyTutorWeaknessEvidence {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly severity: number;
  readonly occurrenceCount: number;
  /** Honest display label when the persisted row provides one. */
  readonly label?: string;
}

/** Due-review counts by kind (existing review semantics). */
export interface DailyTutorDueReviewCounts {
  readonly vocabulary: number;
  readonly expression: number;
  readonly grammar: number;
  readonly pronunciation: number;
  readonly listening: number;
}

/** A recent persisted daily session summarized for deprioritization. */
export interface DailyTutorRecentSession {
  readonly dateKey: DailyTutorDateKey;
  readonly kinds: readonly DailyActivityKind[];
}

/** A recent persisted conversation (summary only, no transcripts). */
export interface DailyTutorRecentConversation {
  readonly mode: string;
  readonly topic?: string;
}

/**
 * Everything the deterministic planner may look at. Every field is REAL
 * stored learner evidence (or a deterministic date/rotation input) — the
 * planner never invents data and never reads the clock.
 */
export interface DailyTutorPlanningInput {
  readonly learnerId: string;
  readonly dateKey: DailyTutorDateKey;
  readonly learningGoals: readonly string[];
  readonly dueVocabularyCount: number;
  readonly dueExpressionCount: number;
  readonly dueOtherReviewCount: number;
  readonly dueReview: DailyTutorDueReviewCounts;
  readonly activeWeaknesses: readonly DailyTutorWeaknessEvidence[];
  /** Unresolved pronunciation evidence rows (existing Pronunciation Engine). */
  readonly unresolvedPronunciationCount: number;
  /** Top unresolved pronunciation practice labels, bounded. */
  readonly pronunciationTargets: readonly string[];
  /** Recommendations from the EXISTING curriculum planner (input, not duplicated). */
  readonly curriculum: {
    readonly skillId: string;
    readonly domain: string;
    readonly title: string;
    readonly lifecycleState: string | null;
  }[];
  /** Recent daily sessions (most recent first), used for variety/deprioritization. */
  readonly recentSessions: readonly DailyTutorRecentSession[];
  /** Recent persisted conversations (summary only). */
  readonly recentConversations: readonly DailyTutorRecentConversation[];
}

/** Result of the pure planner. */
export interface DailyTutorPlanResult {
  readonly plan: DailyTutorPlan;
}

/* ------------------------------------------------------------------ *
 * Child-activity completion handshake
 * ------------------------------------------------------------------ */

/**
 * The serializable reference Daily Tutor passes to a child activity. The
 * child echoes it back when ITS OWN workflow really completes — opening the
 * child screen is never completion.
 */
export interface DailyTutorActivityRef {
  readonly sessionId: string;
  readonly activityId: string;
  /** The daily activity kind the child was launched for (echoed back). */
  readonly kind: DailyActivityKind;
}

/** One real completion reported by a child workflow. */
export interface DailyTutorChildCompletion {
  readonly ref: DailyTutorActivityRef;
  readonly completedAt: string;
  /**
   * Real count of practiced items from the child's own summary. An explicit
   * 0 means the child finished without practicing anything, which must NOT
   * complete the daily activity. This field is REQUIRED for a completion to
   * settle an activity: a completion without a real positive count is not
   * completion evidence.
   */
  readonly itemsPracticed?: number;
  readonly note?: string;
}

/**
 * Params the Daily Tutor passes into the Review tab (existing Review flow):
 * the completion handshake ref plus an optional bounded review subset
 * (kind emphasis + item limit) the Review planner is genuinely conditioned
 * on. Present ONLY on Daily Tutor launches; standalone tab use is unchanged.
 */
export interface DailyTutorReviewLaunch extends DailyTutorActivityRef {
  readonly reviewKind?: 'vocabulary' | 'expression' | 'grammar';
  readonly reviewLimit?: number;
}
