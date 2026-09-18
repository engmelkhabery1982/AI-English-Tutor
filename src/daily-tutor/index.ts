/**
 * src/daily-tutor/index.ts
 *
 * Public surface of the Daily AI Tutor Loop.
 *
 * COMPOSITION RULES FOLLOWED HERE (same as every existing engine)
 * - Reuse, never rebuild: the LearnerModel, the curriculum planner, the
 *   Review/Listening/Adaptive Lesson/Deep Speaking/Professional English
 *   flows and the SQLite repository layer are composed as-is. The Daily
 *   Tutor owns ONLY daily-session orchestration state (its own additive
 *   repository over the same database).
 * - Screens never touch SQLite: they receive an injected DailyTutorService
 *   or await createDefaultDailyTutorService(), which owns the adapter
 *   bootstrap and is shared app-wide (the same pattern that makes Adaptive
 *   Lessons and Deep Speaking recoverable across navigation).
 * - No AI is used for planning: the daily plan is deterministic and local.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
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
 * the other composition factories use. The Daily Tutor adds only its own
 * additive repository next to it; every other repository stays the real,
 * shared one so the LearnerModel reads exactly what the other engines read.
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
 * The learner model reads the SAME repositories every other engine uses;
 * the Daily Tutor repository is the only new (additive) store.
 */
export function createDailyTutorService(
  adapter: DatabaseAdapter,
  options?: {
    /** Explicit repositories override (tests/embedding). */
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

// Default composition bootstrap. The dynamic Expo SQLite import and adapter
// lifecycle live HERE — behind composition — never inside UI screens. The
// promise is shared so Home and the Daily Tutor screen see ONE service (and
// therefore one in-flight plan/session), exactly like the other engines.
let defaultServicePromise: Promise<DailyTutorService> | null = null;

/** Compose the service on the default local database (reused across calls). */
export function createDefaultDailyTutorService(): Promise<DailyTutorService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      return createDailyTutorService(adapter);
    })();
  }
  return defaultServicePromise;
}
