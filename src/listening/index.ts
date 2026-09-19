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
 *
 * DATABASE OWNERSHIP (Wave 2): the default composition reuses the CANONICAL
 * application database owner (ApplicationDatabase) instead of opening its own
 * adapter. One connection, one migration run, and a failed bootstrap releases
 * the cached promise so the next attempt retries cleanly.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { getApplicationDatabase } from '../data/local/sqlite/ApplicationDatabase';
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

// Default composition bootstrap — adapter lifecycle lives behind
// composition, never inside UI screens.
let defaultServicePromise: Promise<ListeningService> | null = null;

/** Compose the service on the CANONICAL application database (reused app-wide). */
export function createDefaultListeningService(): Promise<ListeningService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const adapter = await getApplicationDatabase().getAdapter();
      return createListeningService(adapter);
    })().catch((error: unknown) => {
      // Release the cached promise so a later attempt retries instead of the
      // feature being disabled for the whole app run.
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
