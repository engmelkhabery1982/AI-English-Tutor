/**
 * src/domain/models/vocabulary/index.ts
 *
 * Vocabulary and expression domain interfaces.
 *
 * A vocabulary item is intentionally NOT "word = one translation".
 * It supports multiple meanings, multiple usages, multiple example
 * contexts, learner-created examples, AI-generated examples, and
 * spaced-repetition review scheduling.
 *
 * MASTERY IS PER-MEANING. A lexical item like "run" can have one
 * meaning mastered (operate a machine) while another is still new
 * (flee quickly). The item-level `review` field is a convenience
 * aggregate; per-meaning `review` on each Meaning is authoritative.
 */

import type {
  IsoDate,
  Meaning,
  PronunciationMetadata,
  ReviewSchedule,
  Uuid,
  UsageExample,
  VocabularySource,
} from '../../shared/types';

/** A vocabulary word or phrase the learner knows / is learning. */
export interface VocabularyItem {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly headword: string; // e.g. "run"
  readonly type: 'word' | 'phrase' | 'phrasal-verb' | 'idiom' | 'expression' | 'collocation';
  readonly meanings: readonly Meaning[];
  readonly pronunciation?: PronunciationMetadata;
  readonly synonyms?: readonly string[];
  readonly antonyms?: readonly string[];
  readonly relatedExpressions?: readonly Uuid[]; // links to other VocabularyItem ids
  /** Convenience aggregate. Per-meaning review is authoritative. */
  readonly review: ReviewSchedule;
  readonly source: VocabularySource;
  readonly tags?: readonly string[]; // e.g. "business", "travel", "A2"
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/** A natural English expression (collocation, idiom, everyday phrase). */
export interface ExpressionItem {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly expression: string; // e.g. "hit the nail on the head"
  readonly type: 'idiom' | 'collocation' | 'everyday-phrase' | 'professional-phrase' | 'linking-expression' | 'phrasal-verb';
  readonly meanings: readonly Meaning[];
  readonly pronunciation?: PronunciationMetadata;
  readonly naturalAlternatives?: readonly string[]; // textbook alternatives
  readonly register?: 'formal' | 'informal' | 'neutral' | 'professional';
  readonly domain?: string;
  /** Convenience aggregate. Per-meaning review is authoritative. */
  readonly review: ReviewSchedule;
  readonly source: VocabularySource;
  readonly tags?: readonly string[];
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/** Builder helper to construct a fresh vocabulary item. */
export type NewVocabularyItem = Omit<
  VocabularyItem,
  'id' | 'createdAt' | 'updatedAt' | 'review'
> & {
  readonly review?: Partial<ReviewSchedule>;
};

/** Builder helper to construct a fresh expression item. */
export type NewExpressionItem = Omit<
  ExpressionItem,
  'id' | 'createdAt' | 'updatedAt' | 'review'
> & {
  readonly review?: Partial<ReviewSchedule>;
};

export type { Meaning, UsageExample, PronunciationMetadata };