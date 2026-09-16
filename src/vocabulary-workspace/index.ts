/**
 * src/vocabulary-workspace/index.ts
 *
 * Public surface of the Vocabulary & Expressions Workspace:
 * types, pure view helpers, the workspace service, and a composition
 * factory that wires the EXISTING SQLite repositories plus the EXISTING
 * Adaptive Review service. No new persistence layer is introduced.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
} from '../data/local/sqlite/repositories';
import { createReviewService } from '../review/factory';
import { VocabularyWorkspaceService } from './service';

export * from './types';
export * from './service';

/**
 * Compose a VocabularyWorkspaceService on top of the existing SQLite
 * repositories and the existing Adaptive Review service factory.
 */
export function createVocabularyWorkspaceService(
  adapter: DatabaseAdapter,
): VocabularyWorkspaceService {
  return new VocabularyWorkspaceService({
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: createReviewService(adapter),
  });
}
