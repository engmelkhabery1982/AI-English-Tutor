/**
 * src/learner-model/index.ts
 *
 * Concrete read-only LearnerModel implementation and factory.
 */

import type {
  GrammarMistake,
  LearnerStrength,
  LearnerWeakness,
  PronunciationWeakness,
  UserProfile,
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

interface LearnerModelSnapshot {
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
}

const DEFAULT_PROFILE: UserProfile = {
  id: '',
  displayName: '',
  targetLanguage: 'en',
  targetLevel: 'unknown',
  currentLevel: 'unknown',
  learningGoals: [],
  preferredModes: [],
  createdAt: '',
  updatedAt: '',
};

const DEFAULT_SNAPSHOT: LearnerModelSnapshot = {
  profile: DEFAULT_PROFILE,
  strengths: [],
  weaknesses: [],
  mistakes: [],
  pronunciationWeaknesses: [],
  vocabulary: [],
  expressions: [],
  reviewQueue: [],
  progress: [],
  latestProgress: null,
};

class ReadOnlyLearnerModel implements LearnerModel {
  private readonly repos: AppRepositories;
  private readonly subscribers = new Set<() => void>();
  private snapshot: LearnerModelSnapshot = DEFAULT_SNAPSHOT;

  constructor(repos: AppRepositories) {
    this.repos = repos;
  }

  get profile(): UserProfile {
    return this.snapshot.profile;
  }

  get strengths(): readonly LearnerStrength[] {
    return this.snapshot.strengths;
  }

  get weaknesses(): readonly LearnerWeakness[] {
    return this.snapshot.weaknesses;
  }

  get mistakes(): readonly GrammarMistake[] {
    return this.snapshot.mistakes;
  }

  get pronunciationWeaknesses(): readonly PronunciationWeakness[] {
    return this.snapshot.pronunciationWeaknesses;
  }

  get vocabulary(): readonly VocabularyItem[] {
    return this.snapshot.vocabulary;
  }

  get expressions(): readonly ExpressionItem[] {
    return this.snapshot.expressions;
  }

  get reviewQueue(): readonly ReviewItem[] {
    return this.snapshot.reviewQueue;
  }

  get progress(): readonly ProgressRecord[] {
    return this.snapshot.progress;
  }

  get latestProgress(): ProgressRecord | null {
    return this.snapshot.latestProgress;
  }

  async refresh(): Promise<void> {
    const profile = await this.repos.profile.get();
    const learnerId = profile.id;
    const nowIso = new Date().toISOString();

    const [
      strengths,
      weaknesses,
      mistakes,
      pronunciationWeaknesses,
      vocabulary,
      expressions,
      reviewQueue,
      progress,
      latestProgress,
    ] = await Promise.all([
      this.repos.weaknesses.listStrengths(learnerId),
      this.repos.weaknesses.listWeaknesses(learnerId),
      this.repos.mistakes.listMistakes(learnerId),
      this.repos.pronunciation.listWeaknesses(learnerId),
      this.repos.vocabulary.list(learnerId),
      this.repos.expressions.list(learnerId),
      this.repos.review.listDue(learnerId, nowIso),
      this.repos.progress.list(learnerId),
      this.repos.progress.latest(learnerId),
    ]);

    this.snapshot = {
      profile,
      strengths,
      weaknesses,
      mistakes,
      pronunciationWeaknesses,
      vocabulary,
      expressions,
      reviewQueue,
      progress,
      latestProgress,
    };

    this.notifySubscribers();
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private notifySubscribers(): void {
    const currentListeners = Array.from(this.subscribers);
    for (const listener of currentListeners) {
      try {
        listener();
      } catch {
        // Individual listener errors must not interrupt other listeners or corrupt model state.
      }
    }
  }
}

export function createLearnerModel(repos: AppRepositories): LearnerModel {
  return new ReadOnlyLearnerModel(repos);
}
