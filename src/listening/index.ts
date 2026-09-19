/**
 * src/listening/index.ts
 *
 * Public surface of the Listening Engine (Phase 1) + composition factories
 * that wire the EXISTING SQLite repositories. Screens never touch SQLite:
 * they receive an injected service or await createDefaultListeningService().
 *
 * Audio playback always goes through the EXISTING TextToSpeechProvider
 * abstraction (talk-demo) — this module adds no second TTS stack and no
 * new dependency.
 */

import {
  appDatabaseLifecycleToken,
  getAppDatabase,
} from '../data/local/sqlite/app-database';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { AIProvider } from '../providers/ai/types';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import { getGeminiApiKey } from '../talk-demo';
import {
  SQLiteExpressionRepository,
  SQLiteProgressRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createPronunciationEngine } from '../pronunciation';
import { createRecoverableSingleFlight } from '../shared/single-flight';
import { ListeningService } from './service';
import { createSuccessObservationRecorder, type SuccessObservationRecorder } from '../reassessment';

export * from './types';
export * from './evaluator';
export * from './ai-material';
export * from './generator';
export * from './service';
// WP-2 additive surface: deep listening (long discourse, multi-speaker,
// speech rate, connected speech, shadowing). It reuses this engine's
// evaluation and persistence — it is not a second engine.
export * from './deep';

/**
 * Compose a ListeningService on the given adapter using the EXISTING
 * repositories (exact lookups included — getByReference /
 * getWeaknessByReference).
 */
/**
 * Resolve the default AI provider for listening using the EXISTING
 * composition already used by Talk/Review: Gemini when an API key is
 * configured, otherwise NO provider (the deterministic local evaluator
 * remains valid). There is deliberately NO silent Demo fallback and no
 * fabricated AI result here.
 */
function resolveDefaultListeningAI(): AIProvider | undefined {
  const key = getGeminiApiKey();
  return key ? createGeminiAIProvider({ apiKey: key }) : undefined;
}

export function createListeningService(
  adapter: DatabaseAdapter,
  options?: {
    aiProvider?: ListeningServiceDepsHint['aiProvider'];
    successRecorder?: SuccessObservationRecorder;
  },
): ListeningService {
  const weaknesses = new SQLiteWeaknessRepository(adapter);
  const review = new SQLiteReviewRepository(adapter);
  // WP-2: the EXISTING pronunciation engine is composed ONLY as the shadowing
  // port, so pronunciation evidence keeps its existing owner. It adds no voice
  // stack and no second pronunciation engine.
  const pronunciation = createPronunciationEngine(adapter);
  return new ListeningService({
    pronunciation: {
      analyzeSpokenTurn: (input) => pronunciation.analyzeSpokenTurn(input),
    },
    weaknesses: {
      listWeaknesses: (learnerId, limit) => weaknesses.listWeaknesses(learnerId, limit),
      upsertWeakness: (weakness) => weaknesses.upsertWeakness(weakness),
      getWeaknessByReference: (learnerId, type, referenceId) =>
        weaknesses.getWeaknessByReference(learnerId, type, referenceId),
    },
    review: {
      upsert: (item) => review.upsert(item),
      getByReference: (learnerId, kind, referenceId) =>
        review.getByReference(learnerId, kind, referenceId),
    },
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    progress: new SQLiteProgressRepository(adapter),
    profile: new SQLiteUserProfileRepository(adapter),
    // Explicitly injected provider wins; otherwise reuse the EXISTING
    // real provider composition (Gemini when configured, else none).
    aiProvider: options?.aiProvider ?? resolveDefaultListeningAI(),
    successRecorder: options?.successRecorder ?? createSuccessObservationRecorder(weaknesses),
  });
}

type ListeningServiceDepsHint = ConstructorParameters<typeof ListeningService>[0];

// Default composition bootstrap — the canonical application database owns the
// adapter lifecycle (see src/data/local/sqlite/app-database.ts); this factory
// only builds the service ON that shared adapter and caches the instance.
// A failed bootstrap is not cached, so a later call retries.
const defaultService = createRecoverableSingleFlight(
  async () => {
    const { adapter } = await getAppDatabase();
    return createListeningService(adapter);
  },
  // Cached for ONE database lifecycle only (see app-database.ts).
  { lifecycleToken: appDatabaseLifecycleToken },
);

/** Compose the service on the canonical app database (reused across calls). */
export function createDefaultListeningService(): Promise<ListeningService> {
  return defaultService();
}
