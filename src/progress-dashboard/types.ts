/**
 * src/progress-dashboard/types.ts
 *
 * View-model types for the Real Progress Dashboard.
 *
 * The dashboard is a READ-ONLY view over existing persisted learner data.
 * Every number here is a real count or timestamp derived from existing
 * repositories — no scores, percentages, or fabricated indicators.
 * SQLite rows are never exposed to the UI directly.
 */

import type { IsoDate, Uuid, WeaknessStatus } from '../domain/shared/types';
import type { LearnerWeakness } from '../domain/models/learner';
import type { ReviewItem } from '../domain/models/learning';

/** Supported dashboard time windows for activity/trend sections. */
export type DashboardWindow = '7d' | '30d' | 'all';

export const DEFAULT_WINDOW: DashboardWindow = '30d';

export const WINDOW_LABELS: Readonly<Record<DashboardWindow, string>> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};

/** Kind of a merged-activity timeline entry (derived from persisted data). */
export type ActivityEventKind =
  | 'session'
  | 'vocabulary'
  | 'expression'
  | 'weakness'
  | 'review'
  | 'progress';

/** One entry of the merged, read-only recent-activity timeline. */
export interface ActivityEventView {
  readonly id: string;
  readonly at: IsoDate;
  readonly kind: ActivityEventKind;
  readonly title: string;
  readonly detail?: string;
}

/** Count-based overview cards (real counts only). */
export interface OverviewStats {
  /** Sessions persisted with a finished status (completed/summarized). */
  readonly sessionsCompleted: number;
  /** Sum of persisted session turnCount. */
  readonly conversationTurns: number;
  readonly vocabularySaved: number;
  readonly expressionsSaved: number;
  readonly reviewsDue: number;
  /** Unresolved weaknesses (mirrors the existing learner-model definition). */
  readonly activeWeaknesses: number;
}

/** Learning-status counts from the authoritative meaning.review buckets. */
export interface LexicalStatusCounts {
  readonly total: number;
  readonly due: number;
  readonly learning: number;
  readonly familiar: number;
  readonly mastered: number;
}

/** Presentation group of the persisted weakness lifecycle states. */
export type WeaknessPresentationGroup =
  | 'needs_attention' // observed / repeated / confirmed / active_training
  | 'improving' // improving
  | 'stable_mastered' // stable / mastered
  | 'relapsed'; // relapsed

export interface WeaknessGroupCount {
  readonly group: WeaknessPresentationGroup;
  readonly label: string;
  readonly count: number;
}

/** One weakness list entry — persisted lifecycle state is preserved as-is. */
export interface WeaknessCardView {
  readonly id: Uuid;
  readonly type: LearnerWeakness['type'];
  readonly status: WeaknessStatus;
  readonly occurrenceCount: number;
  readonly firstSeenAt: IsoDate;
  readonly lastSeenAt: IsoDate;
  readonly updatedAt: IsoDate;
  /** Persisted notes (e.g. the original mistake text) when available. */
  readonly notes?: string;
  readonly contexts: readonly string[];
  /** Most recent persisted evidence entry, when any exists. */
  readonly latestEvidence?: {
    readonly at: IsoDate;
    readonly summary?: string;
  };
}

/** Review status: due counts, upcoming items, and recently reviewed outcomes. */
export interface ReviewStatusView {
  readonly dueCount: number;
  readonly upcoming: readonly {
    readonly id: Uuid;
    readonly kind: ReviewItem['kind'];
    readonly prompt: string;
    readonly dueAt: IsoDate;
  }[];
  /** Items with a persisted lastReviewAt, newest first. */
  readonly recentlyReviewed: readonly {
    readonly id: Uuid;
    readonly kind: ReviewItem['kind'];
    readonly lastReviewAt: IsoDate;
    readonly lastResult?: 'correct' | 'partial' | 'incorrect';
  }[];
}

/** One simple, dependency-free trend bucket. */
export interface TrendBucket {
  readonly label: string;
  readonly rangeStart: IsoDate;
  readonly rangeEnd: IsoDate;
  readonly total: number;
  readonly sessions: number;
  readonly vocabulary: number;
  readonly expressions: number;
  readonly reviews: number;
}

/**
 * A persisted progress record reduced to its RELIABLE count fields.
 * Legacy numeric skill-score fields (listeningScore, speakingScore, …)
 * are intentionally NOT carried into the view model.
 */
export interface ProgressRecordView {
  readonly recordedAt: IsoDate;
  readonly windowStart: IsoDate;
  readonly windowEnd: IsoDate;
  readonly sessionsCompleted: number;
  readonly turnsCompleted: number;
  readonly newWordsLearned: number;
  readonly weaknessesImproved: number;
  readonly weaknessesWorsened: number;
  readonly notes?: string;
}

/** Full dashboard view model. */
export interface ProgressDashboardSnapshot {
  readonly learnerId: Uuid;
  readonly window: DashboardWindow;
  /** Start of the activity/trend window (null for all-time). */
  readonly windowStart: IsoDate | null;
  readonly generatedAt: IsoDate;
  /**
   * True when overview/trend totals come from exact aggregate queries and
   * may be labeled as all-time. False when totals are derived from bounded
   * detail lists — the UI must present them as limited, never all-time.
   */
  readonly aggregatesExact: boolean;
  readonly overview: OverviewStats;
  readonly vocabularyStatus: LexicalStatusCounts;
  readonly expressionStatus: LexicalStatusCounts;
  readonly weaknessGroups: readonly WeaknessGroupCount[];
  readonly weaknessCards: readonly WeaknessCardView[];
  readonly reviewStatus: ReviewStatusView;
  /** Merged read-only timeline, newest first, bounded. */
  readonly recentActivity: readonly ActivityEventView[];
  readonly trends: readonly TrendBucket[];
  readonly recentProgress: readonly ProgressRecordView[];
}

/** Whether the UI should offer the "Review now" action. */
export type ReviewNowAction = 'navigate-review' | 'show-caught-up';
