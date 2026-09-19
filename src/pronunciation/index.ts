/**
 * src/pronunciation/index.ts
 *
 * Public surface of the Pronunciation Engine (Phase 1): types, the
 * baseline transcript-comparison provider, the engine, and a composition
 * factory that wires the EXISTING SQLite repositories. Screens never
 * touch SQLite: they receive an injected engine or await
 * createDefaultPronunciationEngine().
 */

import {
  appDatabaseLifecycleToken,
  getAppDatabase,
} from '../data/local/sqlite/app-database';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
} from '../data/local/sqlite/repositories';
import { createSuccessObservationRecorder } from '../reassessment/success-recorder';
import { createRecoverableSingleFlight } from '../shared/single-flight';
import { createTranscriptComparisonPronunciationProvider } from './baseline-provider';
import { PronunciationEngine } from './engine';

export * from './types';
export * from './baseline-provider';
export * from './engine';
export * from './feedback';

/**
 * Compose a PronunciationEngine on the given adapter using the EXISTING
 * repositories. The baseline provider is deterministic and offline —
 * zero cost, zero network.
 *
 * WP-4 production wiring: the EXISTING success-observation recorder is
 * composed over the SAME weakness repository this engine already uses, so an
 * explicit supported positive result (clear intelligibility from a real
 * evidence source) persists strength evidence on the canonical app database.
 * No second database, no second repository stack and no fabricated
 * confidence: without a real learner the engine still persists nothing.
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

// Default composition bootstrap — the canonical application database owns the
// adapter lifecycle (see src/data/local/sqlite/app-database.ts); this factory
// only builds the engine ON that shared adapter and caches the instance.
// A failed bootstrap is not cached, so a later call retries.
const defaultEngine = createRecoverableSingleFlight(
  async () => {
    const { adapter } = await getAppDatabase();
    return createPronunciationEngine(adapter);
  },
  // Cached for ONE database lifecycle only (see app-database.ts).
  { lifecycleToken: appDatabaseLifecycleToken },
);

/** Compose the engine on the canonical app database (reused across calls). */
export function createDefaultPronunciationEngine(): Promise<PronunciationEngine> {
  return defaultEngine();
}
