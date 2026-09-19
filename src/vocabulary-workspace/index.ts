/**
 * src/vocabulary-workspace/index.ts
 *
 * Public surface of the Vocabulary & Expressions Workspace.
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
  deleteLexicalItemWithReviews,
} from '../data/local/sqlite/repositories';
import { createReviewService } from '../review/factory';
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

// Default composition bootstrap. The adapter lifecycle lives behind the
// CANONICAL owner — never inside UI screens and never a second connection.
let defaultServicePromise: Promise<VocabularyWorkspaceService> | null = null;

/**
 * Compose the workspace on the canonical application database. Safe to call
 * repeatedly: the shared initialization and service composition happen once
 * and are reused; a failed bootstrap releases the cached promise so a later
 * attempt retries.
 */
export function createDefaultVocabularyWorkspaceService(): Promise<VocabularyWorkspaceService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const adapter = await getApplicationDatabase().getAdapter();
      return createVocabularyWorkspaceService(adapter);
    })().catch((error: unknown) => {
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
