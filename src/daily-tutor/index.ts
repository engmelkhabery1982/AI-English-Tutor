/**
 * src/daily-tutor/index.ts
 *
 * Public surface of the Daily AI Tutor Loop.
 *
 * DATABASE OWNERSHIP (Wave 2): the default composition reuses the CANONICAL
 * application database owner instead of opening its own adapter.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { getApplicationDatabase } from '../data/local/sqlite/ApplicationDatabase';
import {
  SQLiteConversationRepository,
  SQLiteDailyTutorRepository,
  SQLiteExpressionRepository,
  SQLiteMistakeRepository,
  SQLiteProgressRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createLearnerModel } from '../learner-model';
import type { AppRepositories } from '../repositories';
import { DailyTutorService } from './service';

export * from './types';
export * from './date';
export * from './planner';
export * from './completion';
export * from './navigation';
export * from './view';
export * from './launch';
export * from './service';

/**
 * Assemble the EXISTING repository facade on one adapter — the same shape
 * the other composition factories use similar to before.
 */
function createAppRepositories(adapter: DatabaseAdapter): AppRepositories {
  return {
    profile: new SQLiteUserProfileRepository(adapter),
    conversations: new SQLiteConversationRepository(adapter),
    mistakes: new SQLiteMistakeRepository(adapter),
    pronunciation: new SQLitePronunciationRepository(adapter),
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    lessons: { get: async () => null, list: async () => [] },
    exercises: { get: async () => null, list: async () => [] },
    progress: new SQLiteProgressRepository(adapter),
  };
}

/**
 * Compose the Daily Tutor service on an existing adapter + repository set.
 */
export function createDailyTutorService(
  adapter: DatabaseAdapter,
  options?: {
    readonly repositories?: AppRepositories;
  },
): DailyTutorService {
  const repositories = options?.repositories ?? createAppRepositories(adapter);
  const learnerModel = createLearnerModel(repositories);
  const dailyTutorRepository = new SQLiteDailyTutorRepository(adapter);
  return new DailyTutorService({
    repository: dailyTutorRepository,
    learnerModel,
    profile: { get: () => repositories.profile.get() },
  });
}

// Default composition bootstrap. The adapter lifecycle lives HERE behind the
// CANONICAL owner — never inside UI screens and never a second connection.
let defaultServicePromise: Promise<DailyTutorService> | null = null;

/** Compose the service on the canonical application database (reused app-wide). */
export function createDefaultDailyTutorService(): Promise<DailyTutorService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const adapter = await getApplicationDatabase().getAdapter();
      return createDailyTutorService(adapter);
    })().catch((error: unknown) => {
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
