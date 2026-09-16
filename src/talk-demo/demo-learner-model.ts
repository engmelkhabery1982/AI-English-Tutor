/**
 * src/talk-demo/demo-learner-model.ts
 *
 * Minimal deterministic demo adapter for LearnerModel.
 * Satisfies the LearnerModel contract for ConversationEngine without database or runtime persistence.
 */

import type {
  CoachingContext,
  CoachingContextOptions,
  DashboardSnapshot,
  LearnerModel,
  LexicalSummary,
  ProgressSummary,
  WeaknessSummary,
} from '../learner-model';
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
import type { IsoDate, Uuid } from '../domain/shared/types';

const FIXED_DATE: IsoDate = '2026-01-01T00:00:00.000Z';
const DEMO_LEARNER_ID: Uuid = '00000000-0000-0000-0000-000000000001';

const DEMO_PROFILE: UserProfile = {
  id: DEMO_LEARNER_ID,
  displayName: 'Learner',
  targetLanguage: 'en',
  currentLevel: 'B1',
  targetLevel: 'B2',
  learningGoals: ['fluency', 'natural conversation'],
  preferredModes: ['natural', 'coach', 'intensive'],
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
};

const DEMO_COACHING_CONTEXT: CoachingContext = {
  profile: {
    learnerId: DEMO_LEARNER_ID,
    displayName: 'Learner',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: ['fluency', 'natural conversation'],
    preferredModes: ['natural', 'coach', 'intensive'],
  },
  activeWeaknesses: [],
  strengths: [],
  vocabularyFocus: [],
  expressionFocus: [],
  recentProgress: null,
  dueReviewCount: 0,
  generatedAt: FIXED_DATE,
};

const EMPTY_WEAKNESS_SUMMARY: WeaknessSummary = {
  total: 0,
  active: 0,
  mastered: 0,
  resolved: 0,
  byStatus: {
    observed: 0,
    repeated: 0,
    confirmed: 0,
    active_training: 0,
    improving: 0,
    stable: 0,
    mastered: 0,
    relapsed: 0,
  },
};

const EMPTY_LEXICAL_SUMMARY: LexicalSummary = {
  totalItems: 0,
  totalMeanings: 0,
  reviewedMeanings: 0,
  masteredMeanings: 0,
  dueMeanings: 0,
};

const EMPTY_PROGRESS_SUMMARY: ProgressSummary = {
  recordsCount: 0,
  latest: null,
  totalSessionsCompleted: 0,
  totalTurnsCompleted: 0,
  totalNewWordsLearned: 0,
  totalWeaknessesImproved: 0,
  totalWeaknessesWorsened: 0,
};

const DEMO_DASHBOARD_SNAPSHOT: DashboardSnapshot = {
  profile: DEMO_PROFILE,
  weaknessSummary: EMPTY_WEAKNESS_SUMMARY,
  vocabularySummary: EMPTY_LEXICAL_SUMMARY,
  expressionSummary: EMPTY_LEXICAL_SUMMARY,
  progressSummary: EMPTY_PROGRESS_SUMMARY,
  dueReviewCount: 0,
};

/**
 * Deterministic demo implementation of LearnerModel.
 */
class DemoLearnerModel implements LearnerModel {
  readonly profile: UserProfile = DEMO_PROFILE;
  readonly strengths: readonly LearnerStrength[] = [];
  readonly weaknesses: readonly LearnerWeakness[] = [];
  readonly mistakes: readonly GrammarMistake[] = [];
  readonly pronunciationWeaknesses: readonly PronunciationWeakness[] = [];
  readonly vocabulary: readonly VocabularyItem[] = [];
  readonly expressions: readonly ExpressionItem[] = [];
  readonly reviewQueue: readonly ReviewItem[] = [];
  readonly progress: readonly ProgressRecord[] = [];
  readonly latestProgress: ProgressRecord | null = null;

  async refresh(): Promise<void> {
    // No-op for demo
  }

  subscribe(_listener: () => void): () => void {
    return () => {
      // Unsubscribe no-op
    };
  }

  getActiveWeaknesses(): readonly LearnerWeakness[] {
    return [];
  }

  getStrengths(): readonly LearnerStrength[] {
    return [];
  }

  getSavedVocabulary(): readonly VocabularyItem[] {
    return [];
  }

  getDueReview(): readonly ReviewItem[] {
    return [];
  }

  getRecentProgress(_limit?: number): readonly ProgressRecord[] {
    return [];
  }

  getLatestProgress(): ProgressRecord | null {
    return null;
  }

  getWeaknessSummary(): WeaknessSummary {
    return EMPTY_WEAKNESS_SUMMARY;
  }

  getVocabularySummary(): LexicalSummary {
    return EMPTY_LEXICAL_SUMMARY;
  }

  getExpressionSummary(): LexicalSummary {
    return EMPTY_LEXICAL_SUMMARY;
  }

  getProgressSummary(): ProgressSummary {
    return EMPTY_PROGRESS_SUMMARY;
  }

  getDashboardSnapshot(): DashboardSnapshot {
    return DEMO_DASHBOARD_SNAPSHOT;
  }

  getCoachingContext(_options?: CoachingContextOptions): CoachingContext {
    return DEMO_COACHING_CONTEXT;
  }
}

/**
 * Factory for creating a deterministic DemoLearnerModel instance.
 */
export function createDemoLearnerModel(): LearnerModel {
  return new DemoLearnerModel();
}
