/**
 * src/learner-model/index.ts
 *
 * LearnerModel facade placeholder.
 *
 * Future responsibilities:
 * - aggregate strengths / weaknesses / vocabulary / progress
 * - expose a query API for the Learning Engine
 * - notify listeners when the model changes
 *
 * The model is NOT implemented yet. This file defines the shape
 * the Learning Engine and UI will depend on.
 */

import type {
  LearnerStrength,
  LearnerWeakness,
  UserProfile,
} from '../domain/models/learner';
import type {
  GrammarMistake,
  PronunciationWeakness,
} from '../domain/models/learner';
import type {
  ExpressionItem,
  VocabularyItem,
} from '../domain/models/vocabulary';
import type {
  ProgressRecord,
  ReviewItem,
} from '../domain/models/learning';
import type { AppRepositories } from '../repositories';

export interface LearnerModel {
  readonly profile: UserProfile;
  readonly strengths: readonly LearnerStrength[];
  readonly weaknesses: readonly LearnerWeakness[];
  readonly mistakes: readonly GrammarMistake[];
  readonly pronunciationWeaknesses: readonly PronunciationWeakness[];
  readonly vocabulary: readonly VocabularyItem[];
  readonly expressions: readonly ExpressionItem[];
  readonly reviewQueue: readonly ReviewItem[];
  readonly progress: readonly ProgressRecord[];
  readonly latestProgress: ProgressRecord | null;

  /** Refresh the in-memory snapshot from repositories. */
  refresh(): Promise<void>;

  /** Subscribe to model change events. */
  subscribe(listener: () => void): () => void;
}

/** Factory signature for creating a LearnerModel bound to repositories. */
export type LearnerModelFactory = (repos: AppRepositories) => LearnerModel;