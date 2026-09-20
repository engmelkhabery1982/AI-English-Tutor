/**
 * src/learner-agency/save-to-review.ts
 *
 * Work Order 2 — the ONE reusable Save to Review capability.
 *
 * A learner can save any language item (word, phrase, idiom, collocation,
 * expression, or a complete sentence) from ANY surface, whether or not they
 * answered correctly. There is exactly one implementation of the persistence
 * rules here — screens must not duplicate them.
 *
 * PERSISTENCE OWNERSHIP (nothing is re-invented):
 * - lexical rows go through the EXISTING Vocabulary/Expression repositories
 *   (the `lexical_items` table and its (learner, headword, type) unique
 *   index are the only store);
 * - queueing into Review uses the EXISTING Review repository and mirrors the
 *   ONE established creation rule: an item is queued only when no review row
 *   for it exists yet (never reset, never duplicated);
 * - save provenance ("Saved by me" vs "Detected from practice", origin,
 *   context sentence, generated-text marker) rides inside the persisted
 *   `source` JSON of the lexical item — reliable, already round-tripped by
 *   the repository layer.
 *
 * REVIEW SEMANTICS SAFETY (hard contract, asserted by tests):
 * saving NEVER marks anything learned/mastered, NEVER completes a review,
 * NEVER creates a weakness, NEVER writes proficiency evidence, NEVER changes
 * an assessment/level, NEVER counts as a recall or a practice attempt. It
 * means exactly one thing: "I want to learn/review this."
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
} from '../data/local/sqlite/repositories';
import type { Meaning, VocabularyItem } from '../domain/models/vocabulary';
import type { ExpressionItem } from '../domain/models/vocabulary';
import type { ExampleSource, IsoDate, VocabularySource } from '../domain/shared/types';
import type {
  ExpressionRepository,
  ReviewRepository,
  UserProfileRepository,
  VocabularyRepository,
} from '../repositories';
import type {
  SaveLanguageItemInput,
  SaveLanguageItemResult,
} from './types';
import { savedItemReviewPrompt } from './types';

/** Types stored as vocabulary items; everything else is an expression item. */
const VOCABULARY_ROUTED_TYPES: ReadonlySet<string> = new Set<string>([
  'word',
  'phrase',
  'phrasal_verb',
  'sentence',
]);

/** Deterministic repository routing for one category (one rule, everywhere). */
export function saveRouteForType(itemType: string): 'vocabulary' | 'expression' {
  return VOCABULARY_ROUTED_TYPES.has(itemType) ? 'vocabulary' : 'expression';
}

/** Deterministic text identity: trim + collapse whitespace + lowercase. */
export function normalizeSavedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The stored headword/expression keeps the learner's exact text. */
function preserveExactText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed;
}

const ALLOWED_TYPES: ReadonlySet<string> = new Set<string>([
  'word',
  'phrase',
  'phrasal_verb',
  'idiom',
  'common_expression',
  'collocation',
  'linking_expression',
  'professional_expression',
  'sentence',
]);

export interface SaveToReviewServiceOptions {
  /** Explicit repositories (tests/embedding). */
  readonly vocabularyRepository?: VocabularyRepository;
  readonly expressionRepository?: ExpressionRepository;
  readonly reviewRepository?: ReviewRepository;
  readonly userProfileRepository?: UserProfileRepository;
  readonly databaseAdapter?: DatabaseAdapter;
  /** Resolve the current learner id (defaults to the profile repository). */
  readonly resolveLearnerId?: () => Promise<string | null>;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => IsoDate;
}

export interface SaveToReviewService {
  /**
   * Save one language item for review. Deterministic duplicate behavior:
   * an identical (learner, text, type) item is never stored twice — the call
   * returns `{ duplicate: true, reason: 'already_saved' }` and touches no
   * review state at all.
   */
  save(input: SaveLanguageItemInput): Promise<SaveLanguageItemResult>;
  /** Exact "did the learner already save this?" lookup. Read-only. */
  isSaved(
    learnerId: string,
    text: string,
    itemType: string,
  ): Promise<{ saved: boolean; id: string | null; manual: boolean }>;
}

/** Build the persisted provenance for one save. */
function buildSource(input: SaveLanguageItemInput, now: IsoDate): VocabularySource {
  const manual = (input.source ?? 'manual_learner') === 'manual_learner';
  return {
    addedBy: manual ? 'learner-created' : 'ai-suggested',
    addedAt: now,
    saveSource: manual ? 'manual_learner' : 'detected_practice',
    saveOrigin: input.origin,
    ...(input.originRef ? { saveOriginRef: input.originRef } : {}),
    ...(input.contextSentence
      ? { contextSentence: preserveExactText(input.contextSentence) }
      : {}),
    containsGeneratedText: input.meaningIsGenerated === true,
    originalText: input.originalText,
    generatedBy: input.generatedBy,
    selectedSenseId: input.selectedSenseId,
  };
}

/** Example provenance: learner context vs tutor-generated wording. */
function exampleSourceFor(input: SaveLanguageItemInput): ExampleSource {
  return input.meaningIsGenerated === true ? 'ai-generated' : 'learner-created';
}

/** Build the ONE meaning for a saved item (never a dictionary claim). */
function buildMeaning(input: SaveLanguageItemInput): Meaning {
  const definition = (input.selectedMeaning ?? '').trim();
  const usageNotes: string[] = [];
  if ((input.explanation ?? '').trim().length > 0) {
    usageNotes.push(input.explanation!.trim());
  }
  if ((input.usageNote ?? '').trim().length > 0) {
    usageNotes.push(input.usageNote!.trim());
  }
  if (input.meaningIsGenerated === true) {
    usageNotes.push('Tutor-generated note for review — not a dictionary definition.');
  }
  const examples = [input.example, ...(input.additionalExamples ?? []), input.contextSentence]
    .map((value) => (value ?? '').trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .map((text) => ({ text, source: text === input.contextSentence?.trim() && input.contextSource ? input.contextSource : exampleSourceFor(input) }));

  return {
    // An empty definition stays the exact text: never a fabricated meaning.
    definition: definition.length > 0 ? definition : preserveExactText(input.text),
    examples,
    usageNotes,
    register: 'neutral',
    domain: 'everyday',
    // A NEW meaning only: review counters start empty and saving never
    // mutates an existing meaning's state (the repository preserves it).
    review: { state: 'new', reviewCount: 0, consecutiveCorrect: 0 },
  };
}

/**
 * Creates the reusable Save to Review service over the EXISTING repositories.
 */
export function createSaveToReviewService(
  options?: SaveToReviewServiceOptions,
): SaveToReviewService {
  let adapter: DatabaseAdapter | null = options?.databaseAdapter ?? null;
  let vocabRepo: VocabularyRepository | null = options?.vocabularyRepository ?? null;
  let exprRepo: ExpressionRepository | null = options?.expressionRepository ?? null;
  let reviewRepo: ReviewRepository | null = options?.reviewRepository ?? null;
  let profileRepo: UserProfileRepository | null = options?.userProfileRepository ?? null;
  let injectedRepos = Boolean(
    options?.vocabularyRepository ||
      options?.expressionRepository ||
      options?.reviewRepository ||
      options?.userProfileRepository,
  );

  async function ensureRepos(): Promise<{
    vocab: VocabularyRepository;
    expr: ExpressionRepository;
    review: ReviewRepository;
    profile: UserProfileRepository;
  } | null> {
    try {
      if (!adapter && !injectedRepos) {
        const { getAppDatabase } = await import('../data/local/sqlite/app-database');
        adapter = (await getAppDatabase()).adapter;
      }
      if (adapter) {
        vocabRepo ??= new SQLiteVocabularyRepository(adapter);
        exprRepo ??= new SQLiteExpressionRepository(adapter);
        reviewRepo ??= new SQLiteReviewRepository(adapter);
        profileRepo ??= new SQLiteUserProfileRepository(adapter);
      }
      if (!vocabRepo || !exprRepo || !reviewRepo || !profileRepo) return null;
      return { vocab: vocabRepo, expr: exprRepo, review: reviewRepo, profile: profileRepo };
    } catch {
      return null;
    }
  }

  async function resolveLearner(
    input: SaveLanguageItemInput,
    profile: UserProfileRepository,
  ): Promise<string | null> {
    if (input.learnerId && input.learnerId.trim().length > 0) return input.learnerId;
    if (options?.resolveLearnerId) {
      try {
        return await options.resolveLearnerId();
      } catch {
        return null;
      }
    }
    try {
      const loaded = await profile.get();
      return loaded?.id ?? null;
    } catch {
      return null;
    }
  }

  async function queueForReview(
    review: ReviewRepository,
    learnerId: string,
    itemId: string,
    kind: 'vocabulary' | 'expression',
    promptText: string,
    meaning: string | null,
    now: IsoDate,
  ): Promise<boolean> {
    if (!review.upsert) return false;
    try {
      // Existence first: saving must NEVER reset or duplicate an existing
      // review row (its due date and outcome history belong to review).
      if (review.getByReference) {
        const existing = await review.getByReference(learnerId, kind, itemId);
        if (existing) return false;
      }
      await review.upsert({
        learnerId,
        kind,
        referenceId: itemId,
        prompt: savedItemReviewPrompt(promptText, meaning),
        expectedResponse: promptText,
        state: 'learning',
        dueAt: now,
        reviewCount: 0,
        consecutiveCorrect: 0,
        outcomeHistory: [],
      });
      return true;
    } catch {
      // Queueing is best-effort: the save itself already persisted.
      return false;
    }
  }

  return {
    async save(input: SaveLanguageItemInput): Promise<SaveLanguageItemResult> {
      const text = preserveExactText(input?.text ?? '');
      if (
        !input ||
        text.length === 0 ||
        !ALLOWED_TYPES.has(input.itemType) ||
        !input.origin
      ) {
        return { ok: false, reason: 'invalid_input' };
      }

      const repos = await ensureRepos();
      if (!repos) return { ok: false, reason: 'persistence_failed' };
      const now = (options?.now ?? (() => new Date().toISOString()))();
      const learnerId = await resolveLearner({ ...input, text }, repos.profile);
      if (!learnerId) return { ok: false, reason: 'no_profile' };

      const route = saveRouteForType(input.itemType);
      try {
        // Deterministic duplicate handling BEFORE any write: identical
        // (learner, text, type) → already saved, nothing else changes.
        if (route === 'vocabulary') {
          const existing = repos.vocab.getByHeadword
            ? await repos.vocab.getByHeadword(
                learnerId,
                text,
                input.itemType as VocabularyItem['type'],
              )
            : null;
          if (existing) {
            return {
              ok: true,
              id: existing.id,
              duplicate: true,
              reason: 'already_saved',
              reviewQueued: false,
            };
          }
        } else {
          const existing = repos.expr.getByExpression
            ? await repos.expr.getByExpression(
                learnerId,
                text,
                input.itemType as ExpressionItem['type'],
              )
            : null;
          if (existing) {
            return {
              ok: true,
              id: existing.id,
              duplicate: true,
              reason: 'already_saved',
              reviewQueued: false,
            };
          }
        }

        const source = buildSource({ ...input, text }, now);
        const meaning = buildMeaning({ ...input, text });
        let itemId: string;
        if (route === 'vocabulary') {
          const saved = await repos.vocab.upsert({
            learnerId,
            headword: text,
            type: input.itemType as VocabularyItem['type'],
            meanings: [meaning],
            pronunciation: {},
            synonyms: [],
            antonyms: [],
            relatedExpressions: [],
            source,
            tags: ['saved-by-learner'],
          });
          itemId = saved.id;
        } else {
          const saved = await repos.expr.upsert({
            learnerId,
            expression: text,
            type: input.itemType as ExpressionItem['type'],
            meanings: [meaning],
            pronunciation: {},
            naturalAlternatives: [],
            register: 'neutral',
            domain: 'everyday',
            source,
            tags: ['saved-by-learner'],
          });
          itemId = saved.id;
        }

        const reviewQueued = await queueForReview(
          repos.review,
          learnerId,
          itemId,
          route,
          text,
          meaning.definition === text ? null : meaning.definition,
          now,
        );

        return {
          ok: true,
          id: itemId,
          duplicate: false,
          reason: 'created',
          reviewQueued,
        };
      } catch {
        return { ok: false, reason: 'persistence_failed' };
      }
    },

    async isSaved(learnerId, text, itemType) {
      const repos = await ensureRepos();
      const needle = normalizeSavedText(text ?? '');
      if (!repos || needle.length === 0 || !ALLOWED_TYPES.has(itemType)) {
        return { saved: false, id: null, manual: false };
      }
      try {
        const exact = preserveExactText(text ?? '');
        if (saveRouteForType(itemType) === 'vocabulary') {
          const found = repos.vocab.getByHeadword
            ? ((await repos.vocab.getByHeadword(
                learnerId,
                exact,
                itemType as VocabularyItem['type'],
              )) ??
              (needle !== exact
                ? await repos.vocab.getByHeadword(
                    learnerId,
                    needle,
                    itemType as VocabularyItem['type'],
                  )
                : null))
            : null;
          if (found) {
            return {
              saved: true,
              id: found.id,
              manual: found.source?.saveSource === 'manual_learner',
            };
          }
        } else {
          const found = repos.expr.getByExpression
            ? ((await repos.expr.getByExpression(
                learnerId,
                exact,
                itemType as ExpressionItem['type'],
              )) ??
              (needle !== exact
                ? await repos.expr.getByExpression(
                    learnerId,
                    needle,
                    itemType as ExpressionItem['type'],
                  )
                : null))
            : null;
          if (found) {
            return {
              saved: true,
              id: found.id,
              manual: found.source?.saveSource === 'manual_learner',
            };
          }
        }
        return { saved: false, id: null, manual: false };
      } catch {
        return { saved: false, id: null, manual: false };
      }
    },
  };
}

/**
 * Exact-text headword match used for the deterministic duplicate identity.
 * `getByHeadword`/`getByExpression` compare stored text directly; saving with
 * different surrounding whitespace is the SAME item after normalization, so the
 * service stores the normalized exact text (never a re-cased variant).
 */
export const SAVED_ITEM_TAGS: readonly string[] = ['saved-by-learner'] as const;
