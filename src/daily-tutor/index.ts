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

import { getAppDatabase } from '../data/local/sqlite/app-database';
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
import { createRecoverableSingleFlight } from '../shared/single-flight';
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

// Default composition bootstrap — the canonical application database owns the
// adapter lifecycle (see src/data/local/sqlite/app-database.ts). The service
// instance is shared so Home and the Daily Tutor screen see ONE service (and
// therefore one in-flight plan/session). A failed bootstrap is not cached, so
// a later call retries.
const defaultService = createRecoverableSingleFlight(async () => {
  const { adapter } = await getAppDatabase();
  return createDailyTutorService(adapter);
});

/** Compose the service on the canonical app database (reused across calls). */
export function createDefaultDailyTutorService(): Promise<DailyTutorService> {
  return defaultService();
}
