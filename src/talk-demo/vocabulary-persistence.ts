/**
 * src/talk-demo/vocabulary-persistence.ts
 *
 * Bridge service between the Talk conversation flow and SQLite local vocabulary persistence.
 * Uses the existing SQLiteVocabularyRepository and SQLiteUserProfileRepository.
 * Hardened to preserve SRS history on re-save.
 */

import {
  appDatabaseLifecycleToken,
  getAppDatabase,
  type AppDatabaseLifecycleToken,
} from '../data/local/sqlite/app-database';
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

/**
 * The default database adapter is the CANONICAL application database adapter
 * (see src/data/local/sqlite/app-database.ts) — this bridge never opens a
 * second connection to the same file. A failed initialization is not cached by
 * the owner, so a later call retries.
 */
async function getDefaultDatabaseAdapter(): Promise<DatabaseAdapter> {
  return (await getAppDatabase()).adapter;
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
  /**
   * Database lifecycle the memoized repositories were built on. After an
   * app-level close/reopen they are rebuilt on the NEW adapter; an injected
   * repository is never dropped (the caller owns it).
   */
  let resolvedLifecycle: AppDatabaseLifecycleToken | null = null;

  async function ensureDependencies(): Promise<{
    vocabRepo: VocabularyRepository;
    learnerId: string;
    adapter?: DatabaseAdapter;
  } | null> {
    try {
      const lifecycle = appDatabaseLifecycleToken();
      if (resolvedLifecycle !== null && resolvedLifecycle !== lifecycle) {
        if (!options?.vocabularyRepository) resolvedVocabRepo = null;
        if (!options?.userProfileRepository) resolvedUserRepo = null;
      }
      resolvedLifecycle = lifecycle;

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
        // Exact identity lookup – never capped list – to preserve SRS history
        if (vocabRepo.getByHeadword) {
          try {
            const existing = await vocabRepo.getByHeadword(learnerId, normalizedHeadword, vocab.type || 'word');
            if (existing) {
              return existing;
            }
          } catch {
            // lookup failure is non-blocking
          }
        }

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

        if (savedItem && deps.adapter) {
          try {
            const reviewRepo = options?.reviewRepository ?? new SQLiteReviewRepository(deps.adapter);
            if (reviewRepo.upsert) {
              const now = new Date().toISOString();
              let shouldCreate = true;
              if (reviewRepo.getByReference) {
                try {
                  const existingReview = await reviewRepo.getByReference(learnerId, 'vocabulary', savedItem.id);
                  if (existingReview) shouldCreate = false;
                } catch {}
              }
              if (shouldCreate) {
                await reviewRepo.upsert({
                  learnerId,
                  kind: 'vocabulary',
                  referenceId: savedItem.id,
                  prompt: `What word matches this definition: "${vocab.meaning?.trim() || normalizedHeadword}"?`,
                  expectedResponse: normalizedHeadword,
                  state: 'learning',
                  dueAt: now,
                  reviewCount: 0,
                  consecutiveCorrect: 0,
                  outcomeHistory: [],
                });
              }
            }
          } catch {
            // non-blocking
          }
        }

        return savedItem;
      } catch {
        return null;
      }
    },
  };
}
