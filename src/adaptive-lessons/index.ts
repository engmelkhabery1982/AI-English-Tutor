/**
 * src/adaptive-lessons/index.ts
 *
 * Public surface of the Adaptive Lessons Engine (Phase 1): the domain model,
 * the deterministic planner, the speaking-prompt templates, the existing
 * conversation-stack speaking port, the orchestration service, and the
 * composition factories that wire it all to the EXISTING systems.
 *
 * COMPOSITION RULES FOLLOWED HERE
 * - Reuse, never rebuild: ReviewService, ListeningService, the LearnerModel,
 *   the conversation stack and the existing Talk evidence pathway are all
 *   composed as-is. This module owns no second scheduler, evaluator or store.
 * - No silent demo fallback: the AI provider is Gemini when a real key is
 *   configured, and otherwise UNDEFINED. Every consuming system already
 *   behaves honestly without a provider (local deterministic review
 *   evaluation, "feedback unavailable" for speaking). A demo provider would
 *   fabricate corrections, so it is never injected here.
 * - UI screens never touch SQLite: they receive an injected
 *   AdaptiveLessonService or await createDefaultAdaptiveLessonService(),
 *   which owns the adapter bootstrap and is shared app-wide (that shared
 *   instance is what makes an unfinished lesson recoverable).
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteConversationRepository,
  SQLiteExpressionRepository,
  SQLiteMistakeRepository,
  SQLiteProgressRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createLearnerModel } from '../learner-model';
import { createListeningService } from '../listening';
import { createPronunciationEngine } from '../pronunciation';
import type { AIProvider, ConversationFeedback } from '../providers/ai';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import type { AppRepositories } from '../repositories';
import { ReviewService } from '../review';
import { getGeminiApiKey } from '../talk-demo';
import { createLearningPersistenceService } from '../talk-demo/learning-persistence';
import { AdaptiveLessonService } from './service';
import { createConversationSpeakingPort } from './speaking';

export * from './types';
export * from './planner';
export * from './prompts';
export * from './speaking';
export * from './voice';
export * from './service';

/**
 * Assemble the EXISTING repository facade on one adapter. Same shape the
 * other composition factories use — no new persistence layer, no new tables.
 */
function createAppRepositories(adapter: DatabaseAdapter): AppRepositories {
  return {
    profile: new SQLiteUserProfileRepository(adapter),
    conversations: new SQLiteConversationRepository(adapter),
    mistakes: new SQLiteMistakeRepository(adapter),
    pronunciation: new SQLitePronunciationRepository(adapter),
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    // Curriculum content is intentionally NOT part of Phase 1.
    lessons: { get: async () => null, list: async () => [] },
    exercises: { get: async () => null, list: async () => [] },
    progress: new SQLiteProgressRepository(adapter),
  };
}

/**
 * Real provider only. Returns undefined when no key is configured so that no
 * consuming system can silently switch to fabricated demo output.
 */
function resolveLessonAIProvider(): AIProvider | undefined {
  const key = getGeminiApiKey();
  return key ? createGeminiAIProvider({ apiKey: key }) : undefined;
}

export interface AdaptiveLessonCompositionOptions {
  /** Explicit provider injection (tests / custom builds) wins over the key. */
  readonly aiProvider?: AIProvider;
  /** Force "no provider" even when a key exists (honest offline behavior). */
  readonly disableAI?: boolean;
}

/**
 * Compose the Adaptive Lessons Engine on top of the existing systems.
 *
 * - Review steps      → existing ReviewService (bounded candidate pool)
 * - Listening steps   → existing ListeningService (bounded exercises)
 * - Pronunciation     → existing PronunciationEngine (qualitative repeats)
 * - Speaking steps    → existing ConversationEngine/Orchestrator/Session
 * - Speaking evidence → existing Talk learning-persistence pathway
 * - Lesson completion → existing ProgressRepository (one honest record)
 */
export function createAdaptiveLessonService(
  adapter: DatabaseAdapter,
  options?: AdaptiveLessonCompositionOptions,
): AdaptiveLessonService {
  const repos = createAppRepositories(adapter);
  const learnerModel = createLearnerModel(repos);
  const aiProvider = options?.disableAI ? undefined : (options?.aiProvider ?? resolveLessonAIProvider());
  const profileRepo = repos.profile;

  // ReviewService with an optional provider: when undefined it evaluates
  // locally and deterministically (existing behavior) — never a demo model.
  const reviewService = new ReviewService(repos, aiProvider);
  const listeningService = createListeningService(
    adapter,
    aiProvider ? { aiProvider } : undefined,
  );

  return new AdaptiveLessonService({
    learnerModel,
    profile: { get: () => profileRepo.get() },
    review: reviewService,
    listening: listeningService,
    // Existing engine, existing deterministic offline provider: qualitative
    // transcript comparison only, and it owns its own evidence persistence.
    pronunciation: createPronunciationEngine(adapter),
    speaking: createConversationSpeakingPort({
      learnerModel,
      ...(aiProvider ? { aiProvider } : {}),
    }),
    // Real corrections only, persisted through the EXISTING Talk pathway
    // (which owns dedup, weakness creation and review scheduling).
    speakingEvidence: {
      async recordFeedbackEvidence(feedback: ConversationFeedback): Promise<void> {
        let learnerId: string | null = null;
        try {
          const profile = await profileRepo.get();
          learnerId = profile?.id ? profile.id : null;
        } catch {
          learnerId = null;
        }
        if (!learnerId) return;
        await createLearningPersistenceService(adapter, learnerId).recordFeedbackEvidence(feedback);
      },
    },
    progress: { record: (record) => repos.progress.record(record) },
  });
}

// Default composition bootstrap. The dynamic Expo SQLite import and adapter
// lifecycle live HERE — behind composition — never inside UI screens. The
// promise is shared so Home and the lesson screen see ONE service instance
// (and therefore one in-memory lesson).
let defaultServicePromise: Promise<AdaptiveLessonService> | null = null;

/** Compose the engine on the default local database (reused across calls). */
export function createDefaultAdaptiveLessonService(): Promise<AdaptiveLessonService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      return createAdaptiveLessonService(adapter);
    })();
  }
  return defaultServicePromise;
}
