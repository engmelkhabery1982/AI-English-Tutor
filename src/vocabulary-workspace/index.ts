/**
 * src/vocabulary-workspace/index.ts
 *
 * Public surface of the Vocabulary & Expressions Workspace:
 * types, pure view helpers, the workspace service, and composition
 * factories that wire the EXISTING SQLite repositories plus the EXISTING
 * Adaptive Review service. No new persistence layer is introduced.
 *
 * UI screens must not touch SQLite types directly: they either receive an
 * injected VocabularyWorkspaceService or await
 * createDefaultVocabularyWorkspaceService(), which owns the adapter
 * bootstrap and learner resolution behind the service.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
} from '../data/local/sqlite/repositories';
import { createReviewService } from '../review/factory';
import { VocabularyWorkspaceService } from './service';

export * from './types';
export * from './service';

/**
 * Compose a VocabularyWorkspaceService on top of the existing SQLite
 * repositories and the existing Adaptive Review service factory.
 * Learner resolution and review-row cleanup go through the same
 * repository layer.
 */
export function createVocabularyWorkspaceService(
  adapter: DatabaseAdapter,
): VocabularyWorkspaceService {
  return new VocabularyWorkspaceService({
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: createReviewService(adapter),
    profile: new SQLiteUserProfileRepository(adapter),
    reviewCleanup: new SQLiteReviewRepository(adapter),
  });
}

// Default composition bootstrap. The dynamic import and adapter lifecycle
// live HERE — behind composition — never inside UI screens.
let defaultServicePromise: Promise<VocabularyWorkspaceService> | null = null;

/**
 * Compose the workspace on the default local database. Safe to call
 * repeatedly: the adapter initialization and service composition happen
 * once and are reused.
 */
export function createDefaultVocabularyWorkspaceService(): Promise<VocabularyWorkspaceService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      return createVocabularyWorkspaceService(adapter);
    })();
  }
  return defaultServicePromise;
}
