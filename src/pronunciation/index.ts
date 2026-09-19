/**
 * src/pronunciation/index.ts
 *
 * Public surface of the Pronunciation Engine (Phase 1).
 *
 * DATABASE OWNERSHIP (Wave 2): the default composition reuses the CANONICAL
 * application database owner instead of opening its own adapter.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { getApplicationDatabase } from '../data/local/sqlite/ApplicationDatabase';
import {
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
} from '../data/local/sqlite/repositories';
import { createSuccessObservationRecorder } from '../reassessment/success-recorder';
import { createTranscriptComparisonPronunciationProvider } from './baseline-provider';
import { PronunciationEngine } from './engine';

export * from './types';
export * from './baseline-provider';
export * from './engine';
export * from './feedback';

/**
 * Compose a PronunciationEngine on the given adapter using the EXISTING
 * repositories. The baseline provider is deterministic and offline.
 */
export function createPronunciationEngine(adapter: DatabaseAdapter): PronunciationEngine {
  const pronunciation = new SQLitePronunciationRepository(adapter);
  const weaknesses = new SQLiteWeaknessRepository(adapter);
  return new PronunciationEngine({
    successRecorder: createSuccessObservationRecorder(weaknesses),
    provider: createTranscriptComparisonPronunciationProvider(),
    pronunciation: {
      recordObservation: (input) => pronunciation.recordObservation(input),
      listWeaknesses: (learnerId, opts) => pronunciation.listWeaknesses(learnerId, opts),
    },
    weaknesses,
    review: new SQLiteReviewRepository(adapter),
    profile: new SQLiteUserProfileRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
  });
}

// Default composition bootstrap — the adapter lifecycle lives behind the
// CANONICAL owner, never inside UI screens.
let defaultEnginePromise: Promise<PronunciationEngine> | null = null;

/** Compose the engine on the canonical application database (reused app-wide). */
export function createDefaultPronunciationEngine(): Promise<PronunciationEngine> {
  if (!defaultEnginePromise) {
    defaultEnginePromise = (async () => {
      const adapter = await getApplicationDatabase().getAdapter();
      return createPronunciationEngine(adapter);
    })().catch((error: unknown) => {
      defaultEnginePromise = null;
      throw error;
    });
  }
  return defaultEnginePromise;
}
