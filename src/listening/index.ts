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
import { ListeningService } from './service';

export * from './types';
export * from './evaluator';
export * from './generator';
export * from './service';

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
  options?: { aiProvider?: ListeningServiceDepsHint['aiProvider'] },
): ListeningService {
  const weaknesses = new SQLiteWeaknessRepository(adapter);
  const review = new SQLiteReviewRepository(adapter);
  return new ListeningService({
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
  });
}

type ListeningServiceDepsHint = ConstructorParameters<typeof ListeningService>[0];

// Default composition bootstrap — adapter lifecycle lives behind
// composition, never inside UI screens.
let defaultServicePromise: Promise<ListeningService> | null = null;

/** Compose the service on the default local database (reused across calls). */
export function createDefaultListeningService(): Promise<ListeningService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      return createListeningService(adapter);
    })();
  }
  return defaultServicePromise;
}
