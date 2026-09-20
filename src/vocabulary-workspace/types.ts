/**
 * src/vocabulary-workspace/types.ts
 *
 * Types for the Vocabulary & Expressions Workspace.
 *
 * The workspace is a VIEW over the existing vocabulary/expression
 * repositories. It never duplicates persistence: the authoritative
 * review state remains `meaning.review` on the domain models. Derived
 * fields here (review buckets, due detection) are computed from that
 * persisted state at load time and are never stored anywhere.
 */

import type { IsoDate, Uuid } from '../domain/shared/types';
import type { ExpressionItem, VocabularyItem } from '../domain/models/vocabulary';

/** Which repository an entry came from (by shape of its type, not a new field). */
export type WorkspaceItemKind = 'vocabulary' | 'expression';

/**
 * Category filter values. These mirror the EXISTING vocabulary types
 * exactly — no new categories are invented. Stored on
 * VocabularyItem['type'] / ExpressionItem['type'].
 */
export type VocabularyCategoryFilter =
  | 'all'
  | 'word'
  | 'phrase'
  | 'phrasal_verb'
  | 'idiom'
  | 'common_expression'
  | 'collocation'
  | 'linking_expression'
  | 'professional_expression';

/**
 * Review-state filter / derived bucket, computed from meaning.review.
 * 'due'    — at least one meaning has review.nextReviewAt <= now
 * 'learning' — item still being learned (new/learning/struggling, not due)
 * 'familiar' — all reviewed meanings are familiar or better (not mastered-only)
 * 'mastered' — every reviewed meaning is mastered or retired
 */
export type WorkspaceReviewBucket = 'due' | 'learning' | 'familiar' | 'mastered';

export type ReviewStateFilter = 'all' | WorkspaceReviewBucket;

/** One listable workspace entry (vocabulary word or expression). */
export interface WorkspaceEntry {
  readonly id: Uuid;
  readonly kind: WorkspaceItemKind;
  /** headword (vocabulary) or expression text. */
  readonly title: string;
  /** The existing stored type — never invented. */
  readonly type: VocabularyItem['type'];
  /** First meaning definition, shown on the card. */
  readonly primaryMeaning: string;
  readonly meaningCount: number;
  /** Derived bucket from meaning.review (not persisted anywhere). */
  readonly reviewBucket: WorkspaceReviewBucket;
  /** Earliest nextReviewAt across meanings, when any exists. */
  readonly nextReviewAt: IsoDate | null;
  /** Sum of per-meaning reviewCount. */
  readonly reviewCount: number;
  /** Primary meaning's consecutiveCorrect (details show per-meaning values). */
  readonly consecutiveCorrect: number;
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
  readonly addedBy: string;
  /**
   * Work Order 2 — where the SAVE itself came from: the stored provenance
   * (`source.saveSource`) when present, otherwise derived deterministically
   * from `addedBy`. 'manual_learner' → "Saved by me", 'detected' →
   * "Detected from practice". Derivation only — nothing is re-persisted here.
   */
  readonly saveSource: 'manual_learner' | 'detected_practice';
  /** Origin feature of a learner save, when recorded (e.g. 'listening'). */
  readonly saveOrigin: string | null;
  /** True when the stored item is marked as containing generated text. */
  readonly containsGeneratedText: boolean;
  /** Usage context captured at save time, when present. */
  readonly contextSentence: string | null;
  /** The full persisted domain item, for the details view. */
  readonly item: VocabularyItem | ExpressionItem;
}

/** Header summary counts (counts only — no scores or percentages). */
export interface WorkspaceSummary {
  readonly totalSaved: number;
  readonly dueNow: number;
  readonly learning: number;
  readonly familiar: number;
  readonly mastered: number;
}

export interface WorkspaceSnapshot {
  readonly entries: readonly WorkspaceEntry[];
  readonly summary: WorkspaceSummary;
  readonly generatedAt: IsoDate;
}

export interface WorkspaceFilters {
  readonly category?: VocabularyCategoryFilter;
  readonly reviewState?: ReviewStateFilter;
  readonly searchQuery?: string;
}

/** Result of asking the existing Adaptive Review system whether practice is possible. */
export type PracticeDecision =
  | { readonly status: 'items-available'; readonly itemCount: number }
  | { readonly status: 'caught-up' }
  | { readonly status: 'unavailable' };

/** What the UI should do for the Practice action. */
export type PracticeAction = 'navigate-review' | 'show-caught-up' | 'none';

export const EMPTY_WORKSPACE_SUMMARY: WorkspaceSummary = {
  totalSaved: 0,
  dueNow: 0,
  learning: 0,
  familiar: 0,
  mastered: 0,
};
