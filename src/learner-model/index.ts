/**
 * src/learner-model/index.ts
 *
 * Concrete read-only LearnerModel implementation and factory with query and summary API.
 */

import type {
  GrammarMistake,
  LearnerStrength,
  LearnerWeakness,
  PronunciationWeakness,
  UserProfile,
} from '../domain/models/learner';
import type {
  WeaknessStatus,
} from '../domain/shared/types';
import type {
  ExpressionItem,
  VocabularyItem,
} from '../domain/models/vocabulary';
import type {
  ProgressRecord,
  ReviewItem,
} from '../domain/models/learning';
import type { AppRepositories } from '../repositories';

export interface WeaknessSummary {
  readonly total: number;
  readonly active: number;
  readonly mastered: number;
  readonly resolved: number;
  readonly byStatus: Readonly<Record<WeaknessStatus, number>>;
}

export interface LexicalSummary {
  readonly totalItems: number;
  readonly totalMeanings: number;
  readonly reviewedMeanings: number;
  readonly masteredMeanings: number;
  readonly dueMeanings: number;
}

export interface ProgressSummary {
  readonly recordsCount: number;
  readonly latest: ProgressRecord | null;
  readonly totalSessionsCompleted: number;
  readonly totalTurnsCompleted: number;
  readonly totalNewWordsLearned: number;
  readonly totalWeaknessesImproved: number;
  readonly totalWeaknessesWorsened: number;
}

export interface DashboardSnapshot {
  readonly profile: UserProfile;
  readonly weaknessSummary: WeaknessSummary;
  readonly vocabularySummary: LexicalSummary;
  readonly expressionSummary: LexicalSummary;
  readonly progressSummary: ProgressSummary;
  readonly dueReviewCount: number;
}

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

  /**
   * Active weaknesses query:
   * Returns current active weaknesses excluding resolved and mastered states.
   */
  getActiveWeaknesses(): readonly LearnerWeakness[];

  /**
   * Strengths query:
   * Returns current persisted strength snapshot.
   */
  getStrengths(): readonly LearnerStrength[];

  /**
   * Saved vocabulary query:
   * Returns current vocabulary snapshot.
   */
  getSavedVocabulary(): readonly VocabularyItem[];

  /**
   * Due review queue query:
   * Returns the reviewQueue already loaded during refresh without recalculation.
   */
  getDueReview(): readonly ReviewItem[];

  /**
   * Recent progress query:
   * Deterministic ordering by recordedAt newest-first with optional positive limit.
   */
  getRecentProgress(limit?: number): readonly ProgressRecord[];

  /**
   * Latest progress query:
   * Returns exactly the currently loaded latestProgress snapshot.
   */
  getLatestProgress(): ProgressRecord | null;

  /**
   * Weakness summary query:
   * Returns aggregated statistics from the current weakness snapshot.
   */
  getWeaknessSummary(): WeaknessSummary;

  /**
   * Vocabulary summary query:
   * Returns lexical item and meaning counts derived from the vocabulary snapshot.
   */
  getVocabularySummary(): LexicalSummary;

  /**
   * Expression summary query:
   * Returns lexical item and meaning counts derived from the expression snapshot.
   */
  getExpressionSummary(): LexicalSummary;

  /**
   * Progress summary query:
   * Returns aggregated metrics across progress records and latest progress.
   */
  getProgressSummary(): ProgressSummary;

  /**
   * Dashboard snapshot query:
   * Combines all current summary metrics and loaded queue counts into a unified view.
   */
  getDashboardSnapshot(): DashboardSnapshot;
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

const ALL_WEAKNESS_STATUSES: readonly WeaknessStatus[] = [
  'observed',
  'repeated',
  'confirmed',
  'active_training',
  'improving',
  'stable',
  'mastered',
  'relapsed',
];

function summarizeLexicalItems(
  items: readonly { readonly meanings: readonly { readonly review?: { readonly state: string; readonly nextReviewAt?: string } }[] }[],
  nowMs: number,
): LexicalSummary {
  let totalMeanings = 0;
  let reviewedMeanings = 0;
  let masteredMeanings = 0;
  let dueMeanings = 0;

  for (const item of items) {
    if (!item.meanings) continue;
    for (const meaning of item.meanings) {
      totalMeanings++;
      const review = meaning.review;
      if (!review) continue;

      reviewedMeanings++;

      if (review.state === 'mastered') {
        masteredMeanings++;
      }

      if (review.nextReviewAt) {
        const nextTime = Date.parse(review.nextReviewAt);
        if (!Number.isNaN(nextTime) && nextTime <= nowMs) {
          dueMeanings++;
        }
      }
    }
  }

  return {
    totalItems: items.length,
    totalMeanings,
    reviewedMeanings,
    masteredMeanings,
    dueMeanings,
  };
}

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

  getActiveWeaknesses(): readonly LearnerWeakness[] {
    return this.snapshot.weaknesses.filter(
      (w) => !w.resolved && w.status !== 'mastered',
    );
  }

  getStrengths(): readonly LearnerStrength[] {
    return [...this.snapshot.strengths];
  }

  getSavedVocabulary(): readonly VocabularyItem[] {
    return [...this.snapshot.vocabulary];
  }

  getDueReview(): readonly ReviewItem[] {
    return [...this.snapshot.reviewQueue];
  }

  getRecentProgress(limit?: number): readonly ProgressRecord[] {
    const sorted = [...this.snapshot.progress].sort(
      (a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime(),
    );
    if (typeof limit === 'number' && limit >= 0) {
      return sorted.slice(0, limit);
    }
    return sorted;
  }

  getLatestProgress(): ProgressRecord | null {
    return this.snapshot.latestProgress;
  }

  getWeaknessSummary(): WeaknessSummary {
    const byStatus = ALL_WEAKNESS_STATUSES.reduce(
      (acc, status) => {
        acc[status] = 0;
        return acc;
      },
      {} as Record<WeaknessStatus, number>,
    );

    let active = 0;
    let mastered = 0;
    let resolved = 0;

    for (const weakness of this.snapshot.weaknesses) {
      if (weakness.status in byStatus) {
        byStatus[weakness.status]++;
      }
      if (weakness.resolved) {
        resolved++;
      }
      if (weakness.status === 'mastered') {
        mastered++;
      }
      if (!weakness.resolved && weakness.status !== 'mastered') {
        active++;
      }
    }

    return {
      total: this.snapshot.weaknesses.length,
      active,
      mastered,
      resolved,
      byStatus,
    };
  }

  getVocabularySummary(): LexicalSummary {
    const nowMs = Date.now();
    return summarizeLexicalItems(this.snapshot.vocabulary, nowMs);
  }

  getExpressionSummary(): LexicalSummary {
    const nowMs = Date.now();
    return summarizeLexicalItems(this.snapshot.expressions, nowMs);
  }

  getProgressSummary(): ProgressSummary {
    let totalSessionsCompleted = 0;
    let totalTurnsCompleted = 0;
    let totalNewWordsLearned = 0;
    let totalWeaknessesImproved = 0;
    let totalWeaknessesWorsened = 0;

    for (const record of this.snapshot.progress) {
      totalSessionsCompleted += record.sessionsCompleted;
      totalTurnsCompleted += record.turnsCompleted;
      totalNewWordsLearned += record.newWordsLearned;
      totalWeaknessesImproved += record.weaknessesImproved;
      totalWeaknessesWorsened += record.weaknessesWorsened;
    }

    return {
      recordsCount: this.snapshot.progress.length,
      latest: this.snapshot.latestProgress,
      totalSessionsCompleted,
      totalTurnsCompleted,
      totalNewWordsLearned,
      totalWeaknessesImproved,
      totalWeaknessesWorsened,
    };
  }

  getDashboardSnapshot(): DashboardSnapshot {
    return {
      profile: { ...this.snapshot.profile },
      weaknessSummary: this.getWeaknessSummary(),
      vocabularySummary: this.getVocabularySummary(),
      expressionSummary: this.getExpressionSummary(),
      progressSummary: this.getProgressSummary(),
      dueReviewCount: this.snapshot.reviewQueue.length,
    };
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
