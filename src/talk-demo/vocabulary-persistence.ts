/**
 * src/talk-demo/vocabulary-persistence.ts
 *
 * Bridge service between the Talk conversation flow and SQLite local vocabulary persistence.
 * Uses the existing SQLiteVocabularyRepository and SQLiteUserProfileRepository.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
} from '../data/local/sqlite/repositories';
import type {
  Meaning,
  UsageExample,
  VocabularyItem,
} from '../domain/models/vocabulary';
import type { ConversationFeedbackVocabulary } from '../providers/ai';
import type {
  ReviewRepository,
  UserProfileRepository,
  VocabularyRepository,
} from '../repositories';

export interface VocabularyPersistenceOptions {
  readonly vocabularyRepository?: VocabularyRepository;
  readonly reviewRepository?: ReviewRepository;
  readonly userProfileRepository?: UserProfileRepository;
  readonly databaseAdapter?: DatabaseAdapter;
  readonly learnerId?: string;
}

let defaultAdapterInstance: DatabaseAdapter | null = null;
let defaultAdapterInitPromise: Promise<void> | null = null;

async function getDefaultDatabaseAdapter(): Promise<DatabaseAdapter> {
  if (!defaultAdapterInstance) {
    const { ExpoSqliteAdapter } = await import(
      '../data/local/sqlite/ExpoSqliteAdapter'
    );
    defaultAdapterInstance = new ExpoSqliteAdapter({
      databaseName: 'ai_english_tutor.db',
    });
  }
  if (!defaultAdapterInitPromise) {
    defaultAdapterInitPromise = defaultAdapterInstance.init();
  }
  await defaultAdapterInitPromise;
  return defaultAdapterInstance;
}

/**
 * Creates a vocabulary persistence service backed by the existing repository layer.
 */
export function createVocabularyPersistenceService(
  options?: VocabularyPersistenceOptions
) {
  let resolvedLearnerId: string | null = options?.learnerId ?? null;
  let resolvedVocabRepo: VocabularyRepository | null =
    options?.vocabularyRepository ?? null;
  let resolvedUserRepo: UserProfileRepository | null =
    options?.userProfileRepository ?? null;

  async function ensureDependencies(): Promise<{
    vocabRepo: VocabularyRepository;
    learnerId: string;
    adapter?: DatabaseAdapter;
  } | null> {
    try {
      let adapter = options?.databaseAdapter;
      if (!adapter && (!resolvedVocabRepo || (!resolvedLearnerId && !resolvedUserRepo))) {
        adapter = await getDefaultDatabaseAdapter();
      }

      if (!resolvedVocabRepo && adapter) {
        resolvedVocabRepo = new SQLiteVocabularyRepository(adapter);
      }

      if (!resolvedUserRepo && adapter) {
        resolvedUserRepo = new SQLiteUserProfileRepository(adapter);
      }

      if (!resolvedLearnerId && resolvedUserRepo) {
        try {
          const profile = await resolvedUserRepo.get();
          if (profile && profile.id) {
            resolvedLearnerId = profile.id;
          }
        } catch {
          // No user profile exists: do NOT create a fake/fabricated profile.
          resolvedLearnerId = null;
        }
      }

      if (!resolvedVocabRepo || !resolvedLearnerId) {
        return null;
      }

      return {
        vocabRepo: resolvedVocabRepo,
        learnerId: resolvedLearnerId,
        adapter,
      };
    } catch {
      return null;
    }
  }

  return {
    async saveVocabulary(
      vocab: ConversationFeedbackVocabulary
    ): Promise<VocabularyItem | null> {
      if (!vocab || !vocab.headword) {
        return null;
      }

      const normalizedHeadword = vocab.headword.trim();
      if (!normalizedHeadword) {
        return null;
      }

      const deps = await ensureDependencies();
      if (!deps) {
        return null;
      }

      const { vocabRepo, learnerId } = deps;

      try {
        const examples: UsageExample[] = vocab.example?.trim()
          ? [
              {
                text: vocab.example.trim(),
                source: 'original-conversation',
              },
            ]
          : [];

        const meaning: Meaning = {
          definition: vocab.meaning?.trim() || normalizedHeadword,
          examples,
          usageNotes: [],
          register: 'neutral',
          domain: 'everyday',
          review: {
            state: 'new',
            reviewCount: 0,
            consecutiveCorrect: 0,
          },
        };

        const itemInput: Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt'> = {
          learnerId,
          headword: normalizedHeadword,
          type: vocab.type || 'word',
          meanings: [meaning],
          pronunciation: {},
          synonyms: [],
          antonyms: [],
          relatedExpressions: [],
          source: {
            addedBy: 'ai-suggested',
            addedAt: new Date().toISOString(),
          },
          tags: ['talk-session'],
        };

        const savedItem = await vocabRepo.upsert(itemInput);

        // Schedule review item for this saved word
        if (savedItem && deps.adapter) {
          try {
            const reviewRepo = options?.reviewRepository ?? new SQLiteReviewRepository(deps.adapter);
            if (reviewRepo.upsert) {
              await reviewRepo.upsert({
                learnerId,
                kind: 'vocabulary',
                referenceId: savedItem.id,
                prompt: `What word matches this definition: "${vocab.meaning?.trim() || normalizedHeadword}"?`,
                expectedResponse: normalizedHeadword,
                state: 'learning',
                dueAt: new Date().toISOString(),
                reviewCount: 0,
                consecutiveCorrect: 0,
                outcomeHistory: [],
              });
            }
          } catch {
            // Review item scheduling is non-blocking
          }
        }

        return savedItem;
      } catch {
        return null;
      }
    },
  };
}
