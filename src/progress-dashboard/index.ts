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
  return new ProgressDashboardService({
    profile: new SQLiteUserProfileRepository(adapter),
    conversations: new SQLiteConversationRepository(adapter),
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    progress: new SQLiteProgressRepository(adapter),
  });
}

// Default composition bootstrap. The dynamic import and adapter lifecycle
// live HERE — behind composition — never inside UI screens.
let defaultServicePromise: Promise<ProgressDashboardService> | null = null;

/**
 * Compose the dashboard on the default local database. Safe to call
 * repeatedly: the adapter initialization and service composition happen
 * once and are reused.
 */
export function createDefaultProgressDashboardService(): Promise<ProgressDashboardService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      return createProgressDashboardService(adapter);
    })();
  }
  return defaultServicePromise;
}
