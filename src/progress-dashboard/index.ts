/**
 * src/progress-dashboard/index.ts
 *
 * Public surface of the Real Progress Dashboard: view-model types, the
 * read-only dashboard service, and composition factories that wire the
 * EXISTING SQLite repositories. UI screens never touch SQLite types.
 *
 * DATABASE OWNERSHIP (Wave 2): the default composition reuses the CANONICAL
 * application database owner instead of opening its own adapter.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { getApplicationDatabase } from '../data/local/sqlite/ApplicationDatabase';
import {
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteWeaknessRepository,
  SQLiteConversationRepository,
  SQLiteProgressRepository,
} from '../data/local/sqlite/repositories';
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

// Default composition bootstrap. The adapter lifecycle lives behind the
// CANONICAL owner — never inside UI screens and never a second connection.
let defaultServicePromise: Promise<ProgressDashboardService> | null = null;

/**
 * Compose the dashboard on the canonical application database. Safe to call
 * repeatedly: the shared initialization and service composition happen once
 * and are reused; a failed bootstrap releases the cached promise so a later
 * attempt retries.
 */
export function createDefaultProgressDashboardService(): Promise<ProgressDashboardService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const adapter = await getApplicationDatabase().getAdapter();
      return createProgressDashboardService(adapter);
    })().catch((error: unknown) => {
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
