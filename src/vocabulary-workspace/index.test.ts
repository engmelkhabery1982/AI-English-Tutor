/**
 * src/vocabulary-workspace/index.test.ts
 *
 * Tests for the Vocabulary & Expressions Workspace.
 *
 * Strategy: exercise the workspace service against the REAL SQLite
 * repositories (SqlJsAdapter) so persistence fidelity (edit, delete,
 * review updates, Talk-saved items) is verified end to end — with no
 * network, microphone, or TTS. Pure view helpers (buckets, filtering,
 * search, summary, practice action) are tested directly.
 *
 * Existing Talk / Review / Voice behavior is covered by their own suites
 * which must continue passing unchanged (validated in the same run).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteConversationRepository,
  SQLiteMistakeRepository,
  SQLitePronunciationRepository,
  SQLiteWeaknessRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteProgressRepository,
  deleteLexicalItemWithReviews,
} from '../data/local/sqlite/repositories';
import { ReviewService } from '../review/service';
import { createVocabularyPersistenceService } from '../talk-demo/vocabulary-persistence';
import type { VocabularyRepository } from '../repositories';
import type { VocabularyItem, ExpressionItem } from '../domain/models/vocabulary';
import {
  VocabularyWorkspaceService,
  deriveReviewBucket,
  filterWorkspaceEntries,
  summarizeWorkspace,
  resolvePracticeAction,
  toWorkspaceEntry,
} from './service';
import type { WorkspaceEntry } from './types';

const NOW = '2026-09-17T12:00:00.000Z';
const PAST = '2026-09-10T12:00:00.000Z';
const FUTURE = '2026-09-24T12:00:00.000Z';

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  vocabulary: SQLiteVocabularyRepository;
  expressions: SQLiteExpressionRepository;
  service: VocabularyWorkspaceService;
}

async function createContext(): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();

  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Workspace Tester',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });

  const vocabulary = new SQLiteVocabularyRepository(adapter);
  const expressions = new SQLiteExpressionRepository(adapter);
  const reviewRepo = new SQLiteReviewRepository(adapter);
  const service = new VocabularyWorkspaceService({
    vocabulary,
    expressions,
    review: buildReviewService(adapter),
    profile: profileRepo,
    reviewCleanup: reviewRepo,
    // Same wiring the real composition uses: atomic item+review delete.
    atomicDelete: (lexicalItemId, kind) =>
      deleteLexicalItemWithReviews(adapter, lexicalItemId, kind),
  });

  return { adapter, learnerId: profile.id, vocabulary, expressions, service };
}

function buildReviewService(adapter: DatabaseAdapter): ReviewService {
  return new ReviewService({
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
  });
}

async function saveVocabItem(
  ctx: TestContext,
  overrides?: Partial<Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt' | 'learnerId'>>,
): Promise<VocabularyItem> {
  return ctx.vocabulary.upsert({
    learnerId: ctx.learnerId,
    headword: 'run',
    type: 'word',
    meanings: [
      {
        definition: 'to move quickly on foot',
        examples: [],
        usageNotes: [],
        register: 'neutral',
        domain: 'everyday',
      },
    ],
    pronunciation: {},
    synonyms: [],
    antonyms: [],
    relatedExpressions: [],
    source: { addedBy: 'learner-created', addedAt: NOW },
    tags: [],
    ...overrides,
  });
}

async function saveExpressionItem(
  ctx: TestContext,
  overrides?: Partial<Omit<ExpressionItem, 'id' | 'createdAt' | 'updatedAt' | 'learnerId'>>,
): Promise<ExpressionItem> {
  return ctx.expressions.upsert({
    learnerId: ctx.learnerId,
    expression: 'hit the nail on the head',
    type: 'idiom',
    meanings: [
      {
        definition: 'to describe exactly what is causing a problem',
        examples: [],
        usageNotes: [],
        register: 'informal',
        domain: 'everyday',
      },
    ],
    naturalAlternatives: [],
    source: { addedBy: 'learner-created', addedAt: NOW },
    tags: [],
    ...overrides,
  });
}

describe('Vocabulary & Expressions Workspace', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    ctx = await createContext();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- 1. EMPTY WORKSPACE --- 22. NO AUTOMATIC DEMO FALLBACK ---
  it('1. an empty workspace returns zero entries and zeroed summary without fabricating anything', async () => {
    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);

    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.summary).toEqual({
      totalSaved: 0,
      dueNow: 0,
      learning: 0,
      familiar: 0,
      mastered: 0,
    });

    // Honest caught-up decision from the existing review planner — no demo items.
    const decision = await ctx.service.getPracticeDecision(ctx.learnerId);
    expect(decision).toEqual({ status: 'caught-up' });
    expect(resolvePracticeAction(decision)).toBe('show-caught-up');
  });

  // --- 2. VOCABULARY ITEM DISPLAYED ---
  it('2. a saved vocabulary item appears with title, type, primary meaning and bucket', async () => {
    await saveVocabItem(ctx);

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries).toHaveLength(1);

    const entry = snapshot.entries[0];
    expect(entry.kind).toBe('vocabulary');
    expect(entry.title).toBe('run');
    expect(entry.type).toBe('word');
    expect(entry.primaryMeaning).toBe('to move quickly on foot');
    expect(entry.reviewBucket).toBe('learning');
    expect(entry.meaningCount).toBe(1);
    expect(snapshot.summary.totalSaved).toBe(1);
    expect(snapshot.summary.learning).toBe(1);
  });

  // --- 3. EXPRESSION DISPLAYED ---
  it('3. a saved expression appears as an expression entry with its stored type', async () => {
    await saveExpressionItem(ctx);

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries).toHaveLength(1);

    const entry = snapshot.entries[0];
    expect(entry.kind).toBe('expression');
    expect(entry.title).toBe('hit the nail on the head');
    expect(entry.type).toBe('idiom');
    expect(entry.primaryMeaning).toBe('to describe exactly what is causing a problem');
  });

  // --- 4. CATEGORY FILTERING ---
  it('4. category filtering shows only items of the selected existing type', async () => {
    await saveVocabItem(ctx);
    await saveVocabItem(ctx, { headword: 'look up', type: 'phrasal_verb' });
    await saveExpressionItem(ctx);
    await saveExpressionItem(ctx, {
      expression: 'break the ice',
      type: 'common_expression',
      meanings: [
        {
          definition: 'to start a conversation in an awkward situation',
          examples: [],
          usageNotes: [],
        },
      ],
    });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries).toHaveLength(4);

    const idioms = filterWorkspaceEntries(snapshot.entries, { category: 'idiom' });
    expect(idioms).toHaveLength(1);
    expect(idioms[0].title).toBe('hit the nail on the head');

    const words = filterWorkspaceEntries(snapshot.entries, { category: 'word' });
    expect(words).toHaveLength(1);
    expect(words[0].title).toBe('run');

    const phrasalVerbs = filterWorkspaceEntries(snapshot.entries, { category: 'phrasal_verb' });
    expect(phrasalVerbs.map((e) => e.title)).toEqual(['look up']);

    const everything = filterWorkspaceEntries(snapshot.entries, { category: 'all' });
    expect(everything).toHaveLength(4);
  });

  // --- 5. REVIEW-STATE FILTERING ---
  it('5. review-state filtering buckets items by derived meaning.review state', async () => {
    await saveVocabItem(ctx, {
      headword: 'due-item',
      meanings: [
        {
          definition: 'due definition',
          examples: [],
          usageNotes: [],
          review: { state: 'learning', reviewCount: 1, consecutiveCorrect: 0, nextReviewAt: PAST },
        },
      ],
    });
    await saveVocabItem(ctx, {
      headword: 'learning-item',
      meanings: [
        {
          definition: 'learning definition',
          examples: [],
          usageNotes: [],
          review: { state: 'learning', reviewCount: 1, consecutiveCorrect: 0 },
        },
      ],
    });
    await saveVocabItem(ctx, {
      headword: 'familiar-item',
      meanings: [
        {
          definition: 'familiar definition',
          examples: [],
          usageNotes: [],
          review: { state: 'familiar', reviewCount: 4, consecutiveCorrect: 2, nextReviewAt: FUTURE },
        },
      ],
    });
    await saveVocabItem(ctx, {
      headword: 'mastered-item',
      meanings: [
        {
          definition: 'mastered definition',
          examples: [],
          usageNotes: [],
          review: { state: 'mastered', reviewCount: 8, consecutiveCorrect: 6, nextReviewAt: FUTURE },
        },
      ],
    });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.summary).toEqual({
      totalSaved: 4,
      dueNow: 1,
      learning: 1,
      familiar: 1,
      mastered: 1,
    });

    const byBucket = (bucket: 'due' | 'learning' | 'familiar' | 'mastered') =>
      filterWorkspaceEntries(snapshot.entries, { reviewState: bucket }).map((e) => e.title);

    expect(byBucket('due')).toEqual(['due-item']);
    expect(byBucket('learning')).toEqual(['learning-item']);
    expect(byBucket('familiar')).toEqual(['familiar-item']);
    expect(byBucket('mastered')).toEqual(['mastered-item']);
  });

  // --- 6. DUE ITEM DETECTION --- 7. FUTURE ITEM NOT DUE ---
  it('6. an item with a past meaning.nextReviewAt is detected as due', async () => {
    await saveVocabItem(ctx, {
      meanings: [
        {
          definition: 'to move quickly on foot',
          examples: [],
          usageNotes: [],
          review: { state: 'learning', reviewCount: 2, consecutiveCorrect: 0, nextReviewAt: PAST },
        },
      ],
    });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries[0].reviewBucket).toBe('due');
    expect(snapshot.entries[0].nextReviewAt).toBe(PAST);
    expect(snapshot.summary.dueNow).toBe(1);
  });

  it('7. an item scheduled in the future is not due', async () => {
    await saveVocabItem(ctx, {
      meanings: [
        {
          definition: 'to move quickly on foot',
          examples: [],
          usageNotes: [],
          review: { state: 'familiar', reviewCount: 3, consecutiveCorrect: 2, nextReviewAt: FUTURE },
        },
      ],
    });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries[0].reviewBucket).toBe('familiar');
    expect(snapshot.entries[0].nextReviewAt).toBe(FUTURE);
    expect(snapshot.summary.dueNow).toBe(0);
  });

  // --- 8/9/10. SEARCH ---
  it('8. search matches by headword', async () => {
    await saveVocabItem(ctx);
    await saveVocabItem(ctx, { headword: 'sprint' });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    const results = filterWorkspaceEntries(snapshot.entries, { searchQuery: 'RUN' });
    expect(results.map((e) => e.title)).toEqual(['run']);

    const noResults = filterWorkspaceEntries(snapshot.entries, { searchQuery: 'zebra' });
    expect(noResults).toHaveLength(0);
  });

  it('9. search matches by expression text', async () => {
    await saveExpressionItem(ctx);
    await saveVocabItem(ctx);

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    const results = filterWorkspaceEntries(snapshot.entries, { searchQuery: 'nail' });
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('expression');
    expect(results[0].title).toBe('hit the nail on the head');
  });

  it('10. search matches by meaning definition and example text', async () => {
    await saveVocabItem(ctx, {
      headword: 'dash',
      meanings: [
        {
          definition: 'to run very fast over a short distance',
          examples: [{ text: 'She dashed across the road.', source: 'learner-created' }],
          usageNotes: [],
        },
      ],
    });
    await saveVocabItem(ctx, { headword: 'walk' });

    const byMeaning = filterWorkspaceEntries(await ctx.service.loadWorkspace(ctx.learnerId, NOW).then((s) => s.entries), {
      searchQuery: 'very fast',
    });
    expect(byMeaning.map((e) => e.title)).toEqual(['dash']);

    const byExample = filterWorkspaceEntries(await ctx.service.loadWorkspace(ctx.learnerId, NOW).then((s) => s.entries), {
      searchQuery: 'dashed across',
    });
    expect(byExample.map((e) => e.title)).toEqual(['dash']);
  });

  // --- 11. ITEM DETAILS EXPOSE PERSISTED REVIEW DATA ---
  it('11. details expose the persisted per-meaning review data without invention', async () => {
    const saved = await saveVocabItem(ctx, {
      meanings: [
        {
          definition: 'to move quickly on foot',
          partOfSpeech: 'verb',
          examples: [{ text: 'I run every morning.', source: 'original-conversation' }],
          usageNotes: [],
          review: {
            state: 'familiar',
            lastReviewAt: PAST,
            nextReviewAt: FUTURE,
            reviewCount: 5,
            consecutiveCorrect: 3,
          },
        },
      ],
    });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    const entry = snapshot.entries.find((e) => e.id === saved.id);
    expect(entry).toBeDefined();

    const meaning = entry!.item.meanings[0];
    expect(meaning.partOfSpeech).toBe('verb');
    expect(meaning.examples[0].text).toBe('I run every morning.');
    expect(meaning.examples[0].source).toBe('original-conversation');
    expect(meaning.review).toEqual({
      state: 'familiar',
      lastReviewAt: PAST,
      nextReviewAt: FUTURE,
      reviewCount: 5,
      consecutiveCorrect: 3,
    });
    expect(entry!.createdAt).toBe(saved.createdAt);
    expect(entry!.addedBy).toBe('learner-created');
  });

  // --- 12. EDIT MEANING PERSISTS ---
  it('12. editing a meaning definition persists through the repository layer', async () => {
    const saved = await saveVocabItem(ctx);

    await ctx.service.updateMeaningContent({
      entryId: saved.id,
      kind: 'vocabulary',
      meaningIndex: 0,
      definition: 'to move fast on foot, faster than walking',
    });

    const reloaded = await ctx.vocabulary.get(saved.id);
    expect(reloaded?.meanings[0].definition).toBe('to move fast on foot, faster than walking');

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    const entry = snapshot.entries.find((e) => e.id === saved.id);
    expect(entry?.primaryMeaning).toBe('to move fast on foot, faster than walking');
  });

  // --- 13. EDIT EXAMPLES PERSISTS ---
  it('13. editing examples persists; new examples are recorded as learner-created', async () => {
    const saved = await saveVocabItem(ctx, {
      meanings: [
        {
          definition: 'to move quickly on foot',
          examples: [{ text: 'Old example.', source: 'original-conversation' }],
          usageNotes: [],
        },
      ],
    });

    await ctx.service.updateMeaningContent({
      entryId: saved.id,
      kind: 'vocabulary',
      meaningIndex: 0,
      exampleTexts: ['Edited example.', 'Brand new example.'],
    });

    const reloaded = await ctx.vocabulary.get(saved.id);
    const examples = reloaded?.meanings[0].examples ?? [];
    expect(examples).toHaveLength(2);
    expect(examples[0].text).toBe('Edited example.');
    expect(examples[0].source).toBe('original-conversation'); // provenance preserved
    expect(examples[1].text).toBe('Brand new example.');
    expect(examples[1].source).toBe('learner-created');
    expect(examples[1].createdAt).toBe(NOW);
  });

  // --- 14. EDIT PRESERVES REVIEW HISTORY ---
  it('14. editing never resets reviewCount, consecutiveCorrect, review state or nextReviewAt', async () => {
    const saved = await saveVocabItem(ctx, {
      meanings: [
        {
          definition: 'original definition',
          examples: [{ text: 'Original example.', source: 'original-conversation' }],
          usageNotes: [],
          review: {
            state: 'familiar',
            lastReviewAt: PAST,
            nextReviewAt: FUTURE,
            reviewCount: 7,
            consecutiveCorrect: 4,
            masteredAt: undefined,
          },
        },
      ],
    });

    await ctx.service.updateMeaningContent({
      entryId: saved.id,
      kind: 'vocabulary',
      meaningIndex: 0,
      definition: 'edited definition',
      exampleTexts: ['Edited example.'],
    });

    const reloaded = await ctx.vocabulary.get(saved.id);
    const review = reloaded?.meanings[0].review;
    expect(review).toEqual({
      state: 'familiar',
      lastReviewAt: PAST,
      nextReviewAt: FUTURE,
      reviewCount: 7,
      consecutiveCorrect: 4,
      masteredAt: undefined,
    });
  });

  it('14b. editing an expression meaning works through the expression repository', async () => {
    const saved = await saveExpressionItem(ctx, {
      meanings: [
        {
          definition: 'original expression meaning',
          examples: [],
          usageNotes: [],
          review: { state: 'learning', reviewCount: 2, consecutiveCorrect: 1 },
        },
      ],
    });

    const updatedEntry = await ctx.service.updateMeaningContent({
      entryId: saved.id,
      kind: 'expression',
      meaningIndex: 0,
      definition: 'edited expression meaning',
    });

    expect(updatedEntry.primaryMeaning).toBe('edited expression meaning');
    const reloaded = await ctx.expressions.get(saved.id);
    expect(reloaded?.meanings[0].definition).toBe('edited expression meaning');
    // review history preserved through the expression repo as well
    expect(reloaded?.meanings[0].review?.reviewCount).toBe(2);
    expect(reloaded?.meanings[0].review?.consecutiveCorrect).toBe(1);
  });

  it('14c. edit failures surface and never fake a persisted update', async () => {
    const saved = await saveVocabItem(ctx);

    await expect(
      ctx.service.updateMeaningContent({
        entryId: saved.id,
        kind: 'vocabulary',
        meaningIndex: 5,
        definition: 'out of range',
      }),
    ).rejects.toThrow('Meaning not found');

    await expect(
      ctx.service.updateMeaningContent({
        entryId: saved.id,
        kind: 'vocabulary',
        meaningIndex: 0,
        definition: '   ',
      }),
    ).rejects.toThrow('Definition cannot be empty');

    await expect(
      ctx.service.updateMeaningContent({
        entryId: '41b6d2ae-0b6a-4d47-9a56-3f1d2f4a9c10',
        kind: 'vocabulary',
        meaningIndex: 0,
        definition: 'missing item',
      }),
    ).rejects.toThrow('Item not found');

    // Original content untouched by the failed edits.
    const reloaded = await ctx.vocabulary.get(saved.id);
    expect(reloaded?.meanings[0].definition).toBe('to move quickly on foot');
  });

  // --- 15. DELETE SUCCEEDS ---
  it('15. deleting an item removes it and its meanings through the repository layer', async () => {
    const kept = await saveVocabItem(ctx);
    const removed = await saveVocabItem(ctx, { headword: 'obsolete' });

    const deleted = await ctx.service.deleteEntry({ entryId: removed.id, kind: 'vocabulary' });
    expect(deleted).toBe(true);

    expect(await ctx.vocabulary.get(removed.id)).toBeNull();
    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries.map((e) => e.title)).toEqual(['run']);
    expect(snapshot.summary.totalSaved).toBe(1);
    expect(kept.id).toBeDefined();

    // Deleting the same id again reports false (nothing deleted).
    expect(await ctx.service.deleteEntry({ entryId: removed.id, kind: 'vocabulary' })).toBe(false);
  });

  it('15b. deleting an expression item works through the expression repository', async () => {
    const saved = await saveExpressionItem(ctx);

    const deleted = await ctx.service.deleteEntry({ entryId: saved.id, kind: 'expression' });
    expect(deleted).toBe(true);
    expect(await ctx.expressions.get(saved.id)).toBeNull();

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries).toHaveLength(0);
  });

  // --- 16. DELETE FAILURE LEAVES ITEM INTACT ---
  it('16. a delete failure is surfaced and the item remains visible', async () => {
    const saved = await saveVocabItem(ctx);

    const failingDeleteRepo: VocabularyRepository = {
      upsert: (item) => ctx.vocabulary.upsert(item),
      get: (id) => ctx.vocabulary.get(id),
      list: (learnerId, opts) => ctx.vocabulary.list(learnerId, opts),
      listDue: (learnerId, now, limit) => ctx.vocabulary.listDue(learnerId, now, limit),
      update: (id, patch) => ctx.vocabulary.update(id, patch),
      delete: async () => {
        throw new Error('SQLite delete failed');
      },
    };
    const failingService = new VocabularyWorkspaceService({
      vocabulary: failingDeleteRepo,
      expressions: ctx.expressions,
    });

    await expect(
      failingService.deleteEntry({ entryId: saved.id, kind: 'vocabulary' }),
    ).rejects.toThrow('SQLite delete failed');

    // Item is still persisted and still visible in the workspace.
    expect(await ctx.vocabulary.get(saved.id)).not.toBeNull();
    const snapshot = await failingService.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries.map((e) => e.title)).toContain('run');
  });

  it('16b. a repository without delete support reports an error instead of lying', async () => {
    const saved = await saveVocabItem(ctx);

    const noDeleteRepo: VocabularyRepository = {
      upsert: (item) => ctx.vocabulary.upsert(item),
      get: (id) => ctx.vocabulary.get(id),
      list: (learnerId, opts) => ctx.vocabulary.list(learnerId, opts),
      listDue: (learnerId, now, limit) => ctx.vocabulary.listDue(learnerId, now, limit),
      update: (id, patch) => ctx.vocabulary.update(id, patch),
      // delete intentionally omitted
    };
    const service = new VocabularyWorkspaceService({
      vocabulary: noDeleteRepo,
      expressions: ctx.expressions,
    });

    await expect(service.deleteEntry({ entryId: saved.id, kind: 'vocabulary' })).rejects.toThrow(
      'not supported',
    );
    expect(await ctx.vocabulary.get(saved.id)).not.toBeNull();
  });

  // --- 3. DELETE INTEGRITY: no orphaned review rows resurface in Review ---
  it('16c. deleting a lexical item removes its review rows and history but keeps unrelated reviews', async () => {
    const reviewRepo = new SQLiteReviewRepository(ctx.adapter);

    // Two lexical items, each with a pending review item (as Talk saves do).
    const target = await saveVocabItem(ctx, { headword: 'target word' });
    const other = await saveVocabItem(ctx, { headword: 'other word' });
    const expression = await saveExpressionItem(ctx);

    await reviewRepo.upsert({
      learnerId: ctx.learnerId,
      kind: 'vocabulary',
      referenceId: target.id, // relevant: must be removed with the item
      prompt: 'What word matches this definition?',
      expectedResponse: 'target word',
      state: 'learning',
      dueAt: NOW,
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });
    await reviewRepo.upsert({
      learnerId: ctx.learnerId,
      kind: 'vocabulary',
      referenceId: other.id, // unrelated vocab review: must remain
      prompt: 'What word matches this definition?',
      expectedResponse: 'other word',
      state: 'learning',
      dueAt: NOW,
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });
    await reviewRepo.upsert({
      learnerId: ctx.learnerId,
      kind: 'expression',
      referenceId: expression.id, // unrelated expression review: must remain
      prompt: 'Complete the expression.',
      expectedResponse: 'hit the nail on the head',
      state: 'learning',
      dueAt: NOW,
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });
    await reviewRepo.upsert({
      learnerId: ctx.learnerId,
      kind: 'grammar',
      referenceId: '0d8b29d6-1c3e-4a2f-9b7d-5e6f8091a2b3', // weakness review: must remain
      prompt: 'Correct the mistake in this sentence: "Yesterday I go".',
      expectedResponse: 'Yesterday I went',
      state: 'learning',
      dueAt: NOW,
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    // Give both the target review and the unrelated grammar review history rows.
    const allBefore = await reviewRepo.list(ctx.learnerId);
    const targetReview = allBefore.find((r) => r.referenceId === target.id);
    const grammarReview = allBefore.find((r) => r.kind === 'grammar');
    expect(targetReview).toBeDefined();
    expect(grammarReview).toBeDefined();
    await reviewRepo.markReviewed(targetReview!.id, 'partial', 'so close');
    await reviewRepo.markReviewed(grammarReview!.id, 'correct', 'nice');

    // Delete the lexical item through the workspace service.
    const deleted = await ctx.service.deleteEntry({ entryId: target.id, kind: 'vocabulary' });
    expect(deleted).toBe(true);

    // 1) Lexical item gone.
    expect(await ctx.vocabulary.get(target.id)).toBeNull();

    // 2) Its review item gone (no orphan resurfacing in Review)...
    const remaining = await reviewRepo.list(ctx.learnerId);
    expect(remaining.some((r) => r.referenceId === target.id)).toBe(false);

    // 3) ...along with its review_history rows.
    const targetHistory = await ctx.adapter.query(
      `SELECT * FROM review_history WHERE review_item_id = ?`,
      [targetReview!.id],
    );
    expect(targetHistory).toHaveLength(0);

    // 4) Unrelated reviews remain: other vocab, expression, grammar...
    expect(remaining.some((r) => r.referenceId === other.id && r.kind === 'vocabulary')).toBe(true);
    expect(remaining.some((r) => r.referenceId === expression.id && r.kind === 'expression')).toBe(true);
    expect(remaining.some((r) => r.id === grammarReview!.id && r.kind === 'grammar')).toBe(true);

    // 5) ...including their history (the grammar history must survive).
    const grammarHistory = await ctx.adapter.query(
      `SELECT * FROM review_history WHERE review_item_id = ?`,
      [grammarReview!.id],
    );
    expect(grammarHistory.length).toBeGreaterThan(0);

    // 6) The surviving lexical items are untouched.
    expect(await ctx.vocabulary.get(other.id)).not.toBeNull();
    expect(await ctx.expressions.get(expression.id)).not.toBeNull();
  });

  it('16d. deleting without review-cleanup wiring still removes the item (graceful degradation)', async () => {
    const saved = await saveVocabItem(ctx);
    const reviewRepo = new SQLiteReviewRepository(ctx.adapter);
    await reviewRepo.upsert({
      learnerId: ctx.learnerId,
      kind: 'vocabulary',
      referenceId: saved.id,
      prompt: 'prompt',
      expectedResponse: 'run',
      state: 'learning',
      dueAt: NOW,
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    const bareService = new VocabularyWorkspaceService({
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
    });
    expect(await bareService.deleteEntry({ entryId: saved.id, kind: 'vocabulary' })).toBe(true);
    expect(await ctx.vocabulary.get(saved.id)).toBeNull();
  });

  // --- 3b. ATOMICITY: a mid-transaction failure rolls back everything ---
  it('16e. a forced delete failure inside the transaction rolls back item, review rows and history', async () => {
    const reviewRepo = new SQLiteReviewRepository(ctx.adapter);

    // lexical item exists…
    const saved = await saveVocabItem(ctx, { headword: 'atomic word' });
    // …with a related review item…
    await reviewRepo.upsert({
      learnerId: ctx.learnerId,
      kind: 'vocabulary',
      referenceId: saved.id,
      prompt: 'What word matches this definition?',
      expectedResponse: 'atomic word',
      state: 'learning',
      dueAt: NOW,
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });
    // …that already has review history.
    const reviewBefore = (await reviewRepo.list(ctx.learnerId)).find(
      (r) => r.referenceId === saved.id,
    );
    expect(reviewBefore).toBeDefined();
    await reviewRepo.markReviewed(reviewBefore!.id, 'correct', 'history row');

    const historyBefore = await ctx.adapter.query(
      `SELECT * FROM review_history WHERE review_item_id = ?`,
      [reviewBefore!.id],
    );
    expect(historyBefore.length).toBeGreaterThan(0);

    // Force a failure INSIDE the real transaction: the adapter forwards
    // every call to the real SQLite adapter but appends one poisoned step
    // after the production delete steps, so the production steps have all
    // executed when the failure fires and the real ROLLBACK path runs.
    const poisoningAdapter: DatabaseAdapter = {
      backend: ctx.adapter.backend,
      path: ctx.adapter.path,
      connected: ctx.adapter.connected,
      init: () => ctx.adapter.init(),
      execute: (sql, params) => ctx.adapter.execute(sql, params),
      query: (sql, params) => ctx.adapter.query(sql, params),
      close: () => ctx.adapter.close(),
      transaction: (steps) =>
        ctx.adapter.transaction([
          ...steps,
          { sql: 'DELETE FROM table_that_does_not_exist' },
        ]),
    };

    const failingService = new VocabularyWorkspaceService({
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
      atomicDelete: (lexicalItemId, kind) =>
        deleteLexicalItemWithReviews(poisoningAdapter, lexicalItemId, kind),
    });

    await expect(
      failingService.deleteEntry({ entryId: saved.id, kind: 'vocabulary' }),
    ).rejects.toThrow();

    // Nothing was lost: lexical item still exists…
    expect(await ctx.vocabulary.get(saved.id)).not.toBeNull();

    // …related review still exists…
    const reviewAfter = (await reviewRepo.list(ctx.learnerId)).find(
      (r) => r.referenceId === saved.id,
    );
    expect(reviewAfter).toBeDefined();

    // …and review history still exists.
    const historyAfter = await ctx.adapter.query(
      `SELECT * FROM review_history WHERE review_item_id = ?`,
      [reviewBefore!.id],
    );
    expect(historyAfter.length).toBe(historyBefore.length);

    // The un-poisoned atomic delete still succeeds afterwards.
    expect(await ctx.service.deleteEntry({ entryId: saved.id, kind: 'vocabulary' })).toBe(true);
    expect(await ctx.vocabulary.get(saved.id)).toBeNull();
    expect(
      (await reviewRepo.list(ctx.learnerId)).some((r) => r.referenceId === saved.id),
    ).toBe(false);
  });

  it('16f. the non-atomic fallback (cleanup then delete) still works when no atomic delete is composed', async () => {
    const reviewRepo = new SQLiteReviewRepository(ctx.adapter);
    const saved = await saveVocabItem(ctx, { headword: 'fallback word' });
    await reviewRepo.upsert({
      learnerId: ctx.learnerId,
      kind: 'vocabulary',
      referenceId: saved.id,
      prompt: 'prompt',
      expectedResponse: 'fallback word',
      state: 'learning',
      dueAt: NOW,
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    const fallbackService = new VocabularyWorkspaceService({
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
      reviewCleanup: reviewRepo,
    });
    expect(await fallbackService.deleteEntry({ entryId: saved.id, kind: 'vocabulary' })).toBe(true);
    expect(await ctx.vocabulary.get(saved.id)).toBeNull();
    expect(
      (await reviewRepo.list(ctx.learnerId)).some((r) => r.referenceId === saved.id),
    ).toBe(false);
  });

  // --- 2b. LEARNER RESOLUTION LIVES BEHIND THE SERVICE ---
  it('2b. getActiveLearnerId resolves the real profile and never fabricates one', async () => {
    await expect(ctx.service.getActiveLearnerId()).resolves.toBe(ctx.learnerId);
  });

  it('2c. a service composed without a profile repository reports no learner', async () => {
    const bareService = new VocabularyWorkspaceService({
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
    });
    await expect(bareService.getActiveLearnerId()).resolves.toBeNull();
  });

  // --- 17. TALK-SAVED VOCABULARY APPEARS ---
  it('17. vocabulary saved from the Talk flow appears in the workspace without extra sync', async () => {
    const talkPersistence = createVocabularyPersistenceService({
      databaseAdapter: ctx.adapter,
      learnerId: ctx.learnerId,
    });

    const saved = await talkPersistence.saveVocabulary({
      headword: 'follow up',
      type: 'phrasal_verb',
      meaning: 'to check back on something later',
      example: 'I will follow up with you next week.',
    });
    expect(saved).not.toBeNull();

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    const entry = snapshot.entries.find((e) => e.title === 'follow up');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('phrasal_verb');
    expect(entry!.primaryMeaning).toBe('to check back on something later');
    expect(entry!.reviewBucket).toBe('learning');
    // Listed exactly once even though vocabulary and expressions share a table.
    expect(snapshot.entries).toHaveLength(1);
  });

  // --- 18. TALK-SAVED EXPRESSION APPEARS ---
  it('18. a Talk-saved expression-type item appears under its expression category', async () => {
    const talkPersistence = createVocabularyPersistenceService({
      databaseAdapter: ctx.adapter,
      learnerId: ctx.learnerId,
    });

    await talkPersistence.saveVocabulary({
      headword: 'piece of cake',
      type: 'idiom',
      meaning: 'something very easy to do',
      example: 'The test was a piece of cake.',
    });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    expect(snapshot.entries).toHaveLength(1);

    const entry = snapshot.entries[0];
    expect(entry.title).toBe('piece of cake');
    expect(entry.type).toBe('idiom');
    expect(entry.kind).toBe('expression');

    const idioms = filterWorkspaceEntries(snapshot.entries, { category: 'idiom' });
    expect(idioms).toHaveLength(1);
  });

  // --- 19. REVIEWED ITEM REFLECTS UPDATED meaning.review ---
  it('19. after a review practice result, the workspace reflects the updated meaning.review', async () => {
    const saved = await saveVocabItem(ctx);

    const candidate = {
      id: saved.id,
      learnerId: ctx.learnerId,
      kind: 'vocabulary' as const,
      referenceId: saved.id,
      exerciseType: 'vocabulary_recall' as const,
      prompt: 'What word matches this definition?',
      expectedAnswer: 'run',
      dueAt: NOW,
      consecutiveCorrect: 0,
      reviewCount: 0,
    };

    await ctx.service.getPracticeDecision(ctx.learnerId); // existing planner path
    const reviewService = buildReviewService(ctx.adapter);
    await reviewService.recordPracticeResult(ctx.learnerId, candidate, 'run', {
      result: 'correct',
      feedback: 'Correct!',
    });

    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);
    const entry = snapshot.entries.find((e) => e.id === saved.id);
    expect(entry).toBeDefined();

    // Persisted review result visible in the workspace view:
    const review = entry!.item.meanings[0].review;
    expect(review?.reviewCount).toBe(1);
    expect(review?.consecutiveCorrect).toBe(1);
    expect(review?.nextReviewAt).toBeTruthy();
    expect(review!.nextReviewAt! > NOW).toBe(true); // scheduled in the future now
    expect(entry!.reviewBucket).toBe('familiar'); // familiar after a correct answer, not due
    expect(snapshot.summary.dueNow).toBe(0);
  });

  // --- 20. PRACTICE USES THE EXISTING REVIEW FLOW ---
  it('20. practice decision comes from the existing Adaptive Review planner and marks nothing reviewed', async () => {
    await saveVocabItem(ctx); // never reviewed -> planner can use it

    const decision = await ctx.service.getPracticeDecision(ctx.learnerId);
    expect(decision.status).toBe('items-available');
    if (decision.status === 'items-available') {
      expect(decision.itemCount).toBeGreaterThan(0);
    }
    expect(resolvePracticeAction(decision)).toBe('navigate-review');

    // Deciding to practice must not mutate any review state.
    const reloaded = await ctx.vocabulary.get((await ctx.vocabulary.list(ctx.learnerId))[0].id);
    expect(reloaded?.meanings[0].review?.reviewCount ?? 0).toBe(0);
    expect(reloaded?.meanings[0].review?.nextReviewAt).toBeUndefined();
  });

  it('20b. unavailable review wiring resolves to no action', () => {
    expect(resolvePracticeAction({ status: 'unavailable' })).toBe('none');
  });

  // --- 21. NO DUE ITEMS -> CAUGHT UP ---
  it('21. when the existing planner has nothing to offer, the workspace is caught up', async () => {
    await saveVocabItem(ctx, {
      meanings: [
        {
          definition: 'to move quickly on foot',
          examples: [],
          usageNotes: [],
          review: { state: 'mastered', reviewCount: 9, consecutiveCorrect: 8, nextReviewAt: FUTURE },
        },
      ],
    });

    const decision = await ctx.service.getPracticeDecision(ctx.learnerId);
    expect(decision).toEqual({ status: 'caught-up' });
    expect(resolvePracticeAction(decision)).toBe('show-caught-up');
  });

  // --- 22. NO AUTOMATIC DEMO FALLBACK (deeper) ---
  it('22. a learner with a profile but no data gets honest empty states, never demo items', async () => {
    const snapshot = await ctx.service.loadWorkspace(ctx.learnerId, NOW);

    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.summary.totalSaved).toBe(0);
    // Filtering an empty workspace yields empty results for every category and state.
    for (const category of ['word', 'idiom', 'phrasal_verb'] as const) {
      expect(filterWorkspaceEntries(snapshot.entries, { category })).toHaveLength(0);
    }
    for (const reviewState of ['due', 'learning', 'familiar', 'mastered'] as const) {
      expect(filterWorkspaceEntries(snapshot.entries, { reviewState })).toHaveLength(0);
    }
  });
});

// --- PURE VIEW HELPER TESTS (no DB) ---

describe('workspace view helpers', () => {
  const now = NOW;

  function makeEntry(): WorkspaceEntry {
    const item: VocabularyItem = {
      id: 'd1f0b2c4-3a91-4cde-8f10-2b7c5d6e4a01',
      learnerId: '0e2c1a54-4f2b-4d88-9b31-6a5c8e7d2f10',
      headword: 'run',
      type: 'word',
      meanings: [
        {
          definition: 'to move quickly on foot',
          examples: [],
          usageNotes: [],
        },
      ],
      source: { addedBy: 'learner-created', addedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    return toWorkspaceEntry(item, 'vocabulary', now, );
  }

  it('deriveReviewBucket: mixed meanings stay learning until every reviewed meaning is familiar/mastered', () => {
    const mixed = [
      { definition: 'a', examples: [], usageNotes: [], review: { state: 'mastered' as const, reviewCount: 5, consecutiveCorrect: 5 } },
      { definition: 'b', examples: [], usageNotes: [], review: { state: 'learning' as const, reviewCount: 1, consecutiveCorrect: 0 } },
    ];
    expect(deriveReviewBucket(mixed, now)).toBe('learning');

    const familiarPlus = [
      { definition: 'a', examples: [], usageNotes: [], review: { state: 'familiar' as const, reviewCount: 3, consecutiveCorrect: 2 } },
      { definition: 'b', examples: [], usageNotes: [], review: { state: 'mastered' as const, reviewCount: 5, consecutiveCorrect: 5 } },
    ];
    expect(deriveReviewBucket(familiarPlus, now)).toBe('familiar');

    const noReview = [{ definition: 'a', examples: [], usageNotes: [] }];
    expect(deriveReviewBucket(noReview, now)).toBe('learning');
  });

  it('deriveReviewBucket: any meaning past its nextReviewAt makes the item due', () => {
    const meanings = [
      { definition: 'a', examples: [], usageNotes: [], review: { state: 'mastered' as const, reviewCount: 9, consecutiveCorrect: 9 } },
      { definition: 'b', examples: [], usageNotes: [], review: { state: 'learning' as const, reviewCount: 1, consecutiveCorrect: 0, nextReviewAt: PAST } },
    ];
    expect(deriveReviewBucket(meanings, now)).toBe('due');
  });

  it('summarizeWorkspace: buckets are exclusive and sum to the total', () => {
    const entries = [
      makeEntry(),
      { ...makeEntry(), reviewBucket: 'due' as const },
      { ...makeEntry(), reviewBucket: 'familiar' as const },
      { ...makeEntry(), reviewBucket: 'mastered' as const },
    ];
    const summary = summarizeWorkspace(entries);
    expect(summary).toEqual({
      totalSaved: 4,
      dueNow: 1,
      learning: 1,
      familiar: 1,
      mastered: 1,
    });
  });

  it('filterWorkspaceEntries: search is case-insensitive and trimmed; whitespace queries are ignored', () => {
    const entry = makeEntry();
    expect(filterWorkspaceEntries([entry], { searchQuery: '  RUN  ' })).toHaveLength(1);
    expect(filterWorkspaceEntries([entry], { searchQuery: '   ' })).toHaveLength(1);
    expect(filterWorkspaceEntries([entry], { searchQuery: 'quickly' })).toHaveLength(1);
    expect(filterWorkspaceEntries([entry], { searchQuery: 'swim' })).toHaveLength(0);
  });

  it('toWorkspaceEntry: items without meanings stay honest (empty primary meaning, zero counts)', () => {
    const item: VocabularyItem = {
      id: 'd1f0b2c4-3a91-4cde-8f10-2b7c5d6e4a02',
      learnerId: '0e2c1a54-4f2b-4d88-9b31-6a5c8e7d2f10',
      headword: 'ghost',
      type: 'word',
      meanings: [],
      source: { addedBy: 'system', addedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    const entry = toWorkspaceEntry(item, 'vocabulary', now);
    expect(entry.primaryMeaning).toBe('');
    expect(entry.meaningCount).toBe(0);
    expect(entry.reviewCount).toBe(0);
    expect(entry.nextReviewAt).toBeNull();
    expect(entry.reviewBucket).toBe('learning');
  });
});
