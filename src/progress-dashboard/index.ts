/**
 * src/progress-dashboard/index.ts
 *
 * Public surface of the Real Progress Dashboard: view-model types, the
 * read-only dashboard service, and composition factories that wire the
 * EXISTING SQLite repositories. UI screens never touch SQLite types:
 * they either receive an injected ProgressDashboardService or await
 * createDefaultProgressDashboardService(), which owns the adapter
 * bootstrap behind the service (same discipline as the vocabulary
 * workspace).
 */

import {
  appDatabaseLifecycleToken,
  getAppDatabase,
} from '../data/local/sqlite/app-database';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteWeaknessRepository,
  SQLiteConversationRepository,
  SQLiteProgressRepository,
} from '../data/local/sqlite/repositories';
import { createRecoverableSingleFlight } from '../shared/single-flight';
import { ProgressDashboardService } from './service';

export * from './types';
export * from './service';

/**
 * Compose a ProgressDashboardService on top of the existing SQLite
 * repositories. Read-only: no repository method here writes anything.
 */
export function createProgressDashboardService(
  adapter: DatabaseAdapter,
): ProgressDashboardService {
  const conversations = new SQLiteConversationRepository(adapter);
  const weaknesses = new SQLiteWeaknessRepository(adapter);
  const vocabulary = new SQLiteVocabularyRepository(adapter);
  const expressions = new SQLiteExpressionRepository(adapter);
  const review = new SQLiteReviewRepository(adapter);
  const progress = new SQLiteProgressRepository(adapter);

  return new ProgressDashboardService({
    profile: new SQLiteUserProfileRepository(adapter),
    conversations,
    weaknesses,
    vocabulary,
    expressions,
    review,
    progress,
    // Exact aggregate reads — totals stay correct beyond any display limit.
    conversationStats: (learnerId, opts) => conversations.getActivityStats(learnerId, opts),
    vocabularyBuckets: (learnerId, opts) => vocabulary.getBucketCounts(learnerId, opts),
    vocabularyCreatedCount: (learnerId, opts) => vocabulary.countCreated(learnerId, opts),
    expressionBuckets: (learnerId, opts) => expressions.getBucketCounts(learnerId, opts),
    expressionCreatedCount: (learnerId, opts) => expressions.countCreated(learnerId, opts),
    weaknessStatusCounts: (learnerId) => weaknesses.getUnresolvedStatusCounts(learnerId),
    weaknessCreatedCount: (learnerId, opts) => weaknesses.countUnresolved(learnerId, opts),
    weaknessEvidenceCount: (learnerId, opts) => weaknesses.countEvidence(learnerId, opts),
    dueReviewCount: (learnerId, now) => review.countDue(learnerId, now),
    reviewedCount: (learnerId, opts) => review.countReviewed(learnerId, opts),
    progressRecordCount: (learnerId, opts) => progress.countRecords(learnerId, opts),
  });
}

// Default composition bootstrap. The canonical application database owns the
// adapter lifecycle (see src/data/local/sqlite/app-database.ts); this factory
// only builds the dashboard ON that shared adapter and caches the instance.
// A failed bootstrap is not cached, so a later call retries.
const defaultService = createRecoverableSingleFlight(
  async () => {
    const { adapter } = await getAppDatabase();
    return createProgressDashboardService(adapter);
  },
  // Cached for ONE database lifecycle only (see app-database.ts).
  { lifecycleToken: appDatabaseLifecycleToken },
);

/**
 * Compose the dashboard on the canonical app database. Safe to call
 * repeatedly: the shared adapter and this service instance are reused.
 */
export function createDefaultProgressDashboardService(): Promise<ProgressDashboardService> {
  return defaultService();
}
