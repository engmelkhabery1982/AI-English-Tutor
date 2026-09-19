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
  deleteLexicalItemWithReviews,
} from '../data/local/sqlite/repositories';
import { createReviewService } from '../review/factory';
import { createRecoverableSingleFlight } from '../shared/single-flight';
import { VocabularyWorkspaceService } from './service';

export * from './types';
export * from './service';

/**
 * Compose a VocabularyWorkspaceService on top of the existing SQLite
 * repositories and the existing Adaptive Review service factory.
 * Learner resolution and the atomic item+review delete go through the
 * same data layer.
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
    pronunciationNotes: new SQLiteWeaknessRepository(adapter),
    // Atomic delete: lexical item + matching review rows in ONE transaction.
    atomicDelete: (lexicalItemId, kind) =>
      deleteLexicalItemWithReviews(adapter, lexicalItemId, kind),
  });
}

// Default composition bootstrap. The canonical application database owns the
// adapter lifecycle (see src/data/local/sqlite/app-database.ts); this factory
// only builds the workspace ON that shared adapter and caches the instance.
// A failed bootstrap is not cached, so a later call retries.
const defaultService = createRecoverableSingleFlight(
  async () => {
    const { adapter } = await getAppDatabase();
    return createVocabularyWorkspaceService(adapter);
  },
  // Cached for ONE database lifecycle only (see app-database.ts).
  { lifecycleToken: appDatabaseLifecycleToken },
);

/**
 * Compose the workspace on the canonical app database. Safe to call
 * repeatedly: the shared adapter and this service instance are reused.
 */
export function createDefaultVocabularyWorkspaceService(): Promise<VocabularyWorkspaceService> {
  return defaultService();
}
