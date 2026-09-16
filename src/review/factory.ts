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
import { createDemoAIProvider } from '../providers/ai/demo';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import { getGeminiApiKey } from '../talk-demo';

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

  if (isDemo) {
    const provider = createDemoAIProvider();
    return new ReviewService(repos, provider);
  }

  const key = getGeminiApiKey();
  if (key) {
    const provider = createGeminiAIProvider({ apiKey: key });
    return new ReviewService(repos, provider);
  } else {
    const provider = createDemoAIProvider();
    return new ReviewService(repos, provider);
  }
}
