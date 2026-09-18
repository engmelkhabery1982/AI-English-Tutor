/**
 * src/review/factory.ts
 *
 * Composition factory to assemble repositories, resolve API keys,
 * and instantiate ReviewService with real or demo AI providers.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteReviewRepository,
  SQLiteMistakeRepository,
  SQLiteWeaknessRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteProgressRepository,
  SQLiteUserProfileRepository,
  SQLiteConversationRepository,
  SQLitePronunciationRepository,
} from '../data/local/sqlite/repositories';
import { ReviewService } from './service';
import { resolveReviewAIProvider } from './providers';

/**
 * Composes the Review service on the canonical database.
 *
 * Real mode WITHOUT a configured AI provider no longer falls back to the
 * offline demo tutor: the EXISTING deterministic local evaluators grade the
 * item, and nothing scripted is ever presented as an evaluation of the
 * learner's real answer. Demo AI is reachable only through explicit Demo Mode
 * (the surface advertises it and demo practice is never persisted).
 */
export function createReviewService(adapter: DatabaseAdapter, isDemo: boolean = false): ReviewService {
  const repos = {
    profile: new SQLiteUserProfileRepository(adapter),
    conversations: new SQLiteConversationRepository(adapter),
    mistakes: new SQLiteMistakeRepository(adapter),
    pronunciation: new SQLitePronunciationRepository(adapter),
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    lessons: { get: async () => null, list: async () => [] },
    exercises: { get: async () => null, list: async () => [] },
    progress: new SQLiteProgressRepository(adapter),
  };

  // Same honest resolution the screen uses for voice: real key → Gemini;
  // explicit demo → demo; otherwise NO scripted provider (deterministic local
  // evaluation only).
  const aiProvider = resolveReviewAIProvider({ isDemo });
  return new ReviewService(repos, aiProvider);
}
