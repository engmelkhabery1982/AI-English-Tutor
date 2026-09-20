/**
 * src/learner-agency/save-to-review.test.ts
 *
 * Work Order 2 — the ONE reusable Save to Review service, tested against the
 * REAL SQLite stack (sql.js) through the existing repositories.
 *
 * Pinned behaviors (acceptance criteria):
 * - all six item kinds save and come back with the EXACT learner text, type,
 *   context sentence, origin feature, created date and manual-save marker;
 * - saving is independent of mistakes: a correctly-answered, never-missed
 *   phrase still saves;
 * - deterministic duplicates: a second identical save returns
 *   `already_saved`, creates NO second row and touches NO review state;
 * - saving NEVER marks learned, NEVER completes review, NEVER creates a
 *   weakness/proficiency record, NEVER changes the profile level, and NEVER
 *   counts as a recall/attempt;
 * - "Saved by me" vs "Detected from practice" derive deterministically;
 * - generated text is persisted with its honest marker.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
} from '../data/local/sqlite/repositories';
import { createSaveToReviewService } from './save-to-review';
import { describeSaveSource } from './types';
import { toWorkspaceEntry } from '../vocabulary-workspace/service';
import type { VocabularyItem } from '../domain/models/vocabulary';
import type { ExpressionItem } from '../domain/models/vocabulary';

const FIXED_NOW = '2026-02-02T10:00:00.000Z';

describe('save-to-review service (real SQLite)', () => {
  let adapter: SqlJsAdapter;
  let profileRepo: SQLiteUserProfileRepository;
  let vocabRepo: SQLiteVocabularyRepository;
  let exprRepo: SQLiteExpressionRepository;
  let reviewRepo: SQLiteReviewRepository;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    profileRepo = new SQLiteUserProfileRepository(adapter);
    vocabRepo = new SQLiteVocabularyRepository(adapter);
    exprRepo = new SQLiteExpressionRepository(adapter);
    reviewRepo = new SQLiteReviewRepository(adapter);
    await profileRepo.update({
      displayName: 'Agency Tester',
      nativeLanguage: 'es',
      targetLanguage: 'en',
      targetLevel: 'B1',
      currentLevel: 'A2',
      learningGoals: ['fluency'],
      preferredModes: ['natural', 'coach'],
    });
    const profile = await profileRepo.get();
    learnerId = profile.id;
  });

  afterEach(async () => {
    await adapter.close();
  });

  function makeService() {
    return createSaveToReviewService({
      vocabularyRepository: vocabRepo,
      expressionRepository: exprRepo,
      reviewRepository: reviewRepo,
      userProfileRepository: profileRepo,
      now: () => FIXED_NOW,
    });
  }

  async function countWhere(sql: string): Promise<number> {
    const rows = await adapter.query(sql, []);
    const first = rows[0] as Record<string, unknown> | undefined;
    return Number(first?.count ?? 0);
  }

  it('saves all six required kinds with the full item contract', async () => {
    const service = makeService();
    const kinds = [
      { text: 'reschedule', type: 'word', context: 'Can we reschedule tomorrow?' },
      { text: 'a quick win', type: 'phrase', context: 'Let us find a quick win.' },
      { text: 'break the ice', type: 'idiom', context: 'He cracked a joke to break the ice.' },
      { text: 'heavy rain', type: 'collocation', context: 'We were stuck in heavy rain.' },
      { text: 'Could you walk me through it?', type: 'common_expression', context: 'Could you walk me through it?' },
      { text: 'I would have called, but my phone died.', type: 'sentence', context: 'I would have called, but my phone died.' },
    ] as const;

    for (const kind of kinds) {
      const result = await service.save({
        learnerId,
        text: kind.text,
        itemType: kind.type,
        origin: 'vocabulary',
        contextSentence: kind.context,
      });
      expect(result.ok, `save ${kind.type} ${kind.text}`).toBe(true);
      if (!result.ok) continue;
      expect(result.duplicate).toBe(false);
      expect(result.reason).toBe('created');

      // Exact source text round-trips through the existing repositories.
      const found =
        result.id !== undefined
          ? (await vocabRepo.get(result.id)) ?? (await exprRepo.get(result.id))
          : null;
      expect(found).not.toBeNull();
      const storedText =
        found && 'headword' in found ? (found as VocabularyItem).headword : (found as ExpressionItem).expression;
      expect(storedText).toBe(kind.text);
      expect(found?.type).toBe(kind.type);
      // Created date is stored; the SAVE marker carries the deterministic
      // service clock (the repository stamps its own row time).
      expect(found?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(found?.source?.addedAt).toBe(FIXED_NOW);
      expect(found?.source?.saveSource).toBe('manual_learner');
      expect(found?.source?.addedBy).toBe('learner-created');
      expect(found?.source?.saveOrigin).toBe('vocabulary');
      expect(found?.source?.contextSentence).toBe(kind.context);
      expect(found?.source?.containsGeneratedText).toBe(false);
    }
  });

  it('saves even when the learner answered correctly (no mistake required)', async () => {
    // No mistake/weakness rows exist for this learner at all — the save path
    // must not care.
    const before = await countWhere('SELECT COUNT(*) AS count FROM grammar_mistakes');
    const service = makeService();
    const result = await service.save({
      learnerId,
      text: 'by the way',
      itemType: 'common_expression',
      origin: 'talk',
      contextSentence: 'By the way, the meeting moved to noon.',
      selectedMeaning: 'used to add something casually',
    });
    expect(result.ok).toBe(true);
    const after = await countWhere('SELECT COUNT(*) AS count FROM grammar_mistakes');
    expect(after).toBe(before);
  });

  it('duplicate saves are deterministic: one row, already_saved, review state untouched', async () => {
    const service = makeService();
    const input = {
      learnerId,
      text: 'take it slow',
      itemType: 'phrase' as const,
      origin: 'talk' as const,
      contextSentence: 'Let us take it slow this week.',
    };
    const first = await service.save(input);
    expect(first.ok && first.reason === 'created').toBe(true);

    // Same text with different surrounding whitespace → SAME item.
    const second = await service.save({ ...input, text: '  take   it  slow ' });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.duplicate).toBe(true);
      expect(second.reason).toBe('already_saved');
      expect(second.reviewQueued).toBe(false);
      expect(second.id).toBeDefined();
    }

    const rows = await adapter.query(
      `SELECT COUNT(*) AS count FROM lexical_items WHERE learner_id = ? AND headword = ?`,
      [learnerId, 'take it slow'],
    );
    expect(Number(rows[0].count)).toBe(1);

    const reviewRows = await adapter.query(
      `SELECT COUNT(*) AS count FROM review_items WHERE learner_id = ? AND expected_response = ?`,
      [learnerId, 'take it slow'],
    );
    expect(Number(reviewRows[0].count)).toBe(1);
  });

  it('re-saving does not reset an existing review row (mastered stays mastered)', async () => {
    const service = makeService();
    const saved = await service.save({
      learnerId,
      text: 'follow up',
      itemType: 'phrasal_verb',
      origin: 'talk',
      contextSentence: 'I will follow up tomorrow.',
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    // The learner actually reviews the card and masters it.
    const existing = await reviewRepo.getByReference(learnerId, 'vocabulary', saved.id);
    expect(existing).not.toBeNull();
    if (!existing) return;
    await reviewRepo.upsert({
      ...existing,
      state: 'mastered',
      reviewCount: 5,
      consecutiveCorrect: 3,
      outcomeHistory: Array.from({ length: 5 }, (_unused, index) => ({
        at: `2026-05-0${index + 1}T00:00:00.000Z`,
        result: 'correct' as const,
      })),
      dueAt: '2026-05-05T00:00:00.000Z',
    });

    // Saving the SAME phrase again must not touch any of that.
    const again = await service.save({
      learnerId,
      text: 'follow up',
      itemType: 'phrasal_verb',
      origin: 'listening',
      contextSentence: 'Different context now.',
    });
    expect(again.ok && again.duplicate).toBe(true);

    const after = await reviewRepo.getByReference(learnerId, 'vocabulary', saved.id);
    expect(after?.state).toBe('mastered');
    expect(after?.reviewCount).toBe(5);
    expect(after?.consecutiveCorrect).toBe(3);
    expect(after?.dueAt).toBe('2026-05-05T00:00:00.000Z');

    // And the saved lexical item keeps its FIRST saved context (no rewrite).
    const item = await vocabRepo.get(saved.id);
    expect(item?.source?.contextSentence).toBe('I will follow up tomorrow.');
  });

  it('queues into review exactly once with an honest prompt and learning state', async () => {
    const service = makeService();
    const saved = await service.save({
      learnerId,
      text: 'sleep on it',
      itemType: 'idiom',
      origin: 'review_feedback',
      contextSentence: 'Let me sleep on it and answer tomorrow.',
      selectedMeaning: 'think about something before deciding',
    });
    expect(saved.ok && saved.reviewQueued).toBe(true);
    if (!saved.ok) return;
    const review = await reviewRepo.getByReference(
      learnerId,
      // idiom routes to the expression repository
      'expression',
      saved.id,
    );
    expect(review).not.toBeNull();
    expect(review?.state).toBe('learning');
    expect(review?.reviewCount).toBe(0);
    expect(review?.consecutiveCorrect).toBe(0);
    expect(review?.prompt).toContain('sleep on it');
    expect(review?.prompt).toContain('think about something before deciding');
  });

  it('saving never marks learned, never creates weakness/proficiency, never moves the level', async () => {
    const service = makeService();
    const profileBefore = await profileRepo.get();
    const weaknessCountBefore = await countWhere(
      'SELECT COUNT(*) AS count FROM learner_weaknesses',
    );
    const progressBefore = await countWhere('SELECT COUNT(*) AS count FROM progress_records');

    const saved = await service.save({
      learnerId,
      text: 'kind reminder',
      itemType: 'collocation',
      origin: 'vocabulary',
      contextSentence: 'Just a kind reminder about the deadline.',
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const item = await exprRepo.get(saved.id) ?? await vocabRepo.get(saved.id);
    expect(item).not.toBeNull();
    // The saved meaning's own review state stays NEW — never mastered.
    const meaning = item?.meanings?.[0];
    expect(meaning?.review?.state).toBe('new');
    expect(meaning?.review?.reviewCount).toBe(0);

    const weaknessCountAfter = await countWhere('SELECT COUNT(*) AS count FROM learner_weaknesses');
    expect(weaknessCountAfter).toBe(weaknessCountBefore);
    const progressAfter = await countWhere('SELECT COUNT(*) AS count FROM progress_records');
    expect(progressAfter).toBe(progressBefore);
    const profileAfter = await profileRepo.get();
    expect(profileAfter.currentLevel).toBe(profileBefore.currentLevel);
  });

  it('derives Saved by me vs Detected from practice deterministically', async () => {
    const service = makeService();
    const manual = await service.save({
      learnerId,
      text: 'ping me',
      itemType: 'phrase',
      origin: 'talk',
      contextSentence: 'Ping me when you are done.',
    });
    const detected = await service.save({
      learnerId,
      text: 'at your earliest convenience',
      itemType: 'common_expression',
      origin: 'talk',
      source: 'detected_practice',
      contextSentence: 'Please reply at your earliest convenience.',
    });
    expect(manual.ok && detected.ok).toBe(true);
    if (!manual.ok || !detected.ok) return;

    const manualItem = await vocabRepo.get(manual.id);
    const detectedItem = await exprRepo.get(detected.id);
    expect(manualItem?.source?.saveSource).toBe('manual_learner');
    expect(detectedItem?.source?.saveSource).toBe('detected_practice');
    expect(detectedItem?.source?.addedBy).toBe('ai-suggested');

    expect(describeSaveSource(manualItem?.source?.saveSource).label).toBe('Saved by me');
    expect(describeSaveSource(detectedItem?.source?.saveSource).label).toBe(
      'Detected from practice',
    );

    // Workspace derivation: legacy rows (no marker) classify from addedBy only.
    const manualEntry = toWorkspaceEntry(manualItem as VocabularyItem, 'vocabulary', FIXED_NOW);
    expect(manualEntry.saveSource).toBe('manual_learner');
    const detectedEntry = toWorkspaceEntry(detectedItem as ExpressionItem, 'expression', FIXED_NOW);
    expect(detectedEntry.saveSource).toBe('detected_practice');
    expect(detectedEntry.saveOrigin).toBe('talk');
    expect(detectedEntry.containsGeneratedText).toBe(false);
    expect(detectedEntry.contextSentence).toBe('Please reply at your earliest convenience.');

    // Legacy vocabulary row without the marker → derived from addedBy, never invented.
    const legacy = await vocabRepo.upsert({
      learnerId,
      headword: 'legacy word',
      type: 'word',
      meanings: [
        {
          definition: 'stored before WO2',
          examples: [],
          usageNotes: [],
          register: 'neutral',
          domain: 'everyday',
          review: { state: 'new', reviewCount: 0, consecutiveCorrect: 0 },
        },
      ],
      pronunciation: {},
      synonyms: [],
      antonyms: [],
      relatedExpressions: [],
      source: { addedBy: 'ai-suggested', addedAt: FIXED_NOW },
      tags: [],
    } as never);
    const legacyEntry = toWorkspaceEntry(legacy, 'vocabulary', FIXED_NOW);
    expect(legacyEntry.saveSource).toBe('detected_practice');
  });

  it('marks AI-generated text honestly on the saved item', async () => {
    const service = makeService();
    const saved = await service.save({
      learnerId,
      text: 'it depends on the context',
      itemType: 'sentence',
      origin: 'listening',
      contextSentence: 'It depends on the context we discussed.',
      selectedMeaning: 'the answer changes with the situation',
      meaningIsGenerated: true,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const item = await vocabRepo.get(saved.id);
    expect(item?.source?.containsGeneratedText).toBe(true);
    const notes = item?.meanings?.[0]?.usageNotes ?? [];
    expect(notes.join(' ')).toContain('not a dictionary');
    const examples = item?.meanings?.[0]?.examples ?? [];
    expect(examples.some((example) => example.source === 'ai-generated')).toBe(true);
  });

  it('resolves the learner from the profile when none is given, and fails honestly without a profile', async () => {
    const service = makeService();
    const saved = await service.save({
      learnerId: '',
      text: 'touch base',
      itemType: 'idiom',
      origin: 'talk',
    });
    expect(saved.ok).toBe(true);

    // No profile at all → honest no_profile, nothing written.
    const bareAdapter = new SqlJsAdapter(':memory:');
    await bareAdapter.init();
    const bareService = createSaveToReviewService({
      databaseAdapter: bareAdapter,
      now: () => FIXED_NOW,
    });
    const failed = await bareService.save({
      learnerId: '',
      text: 'orphan save',
      itemType: 'word',
      origin: 'talk',
    });
    expect(failed).toEqual({ ok: false, reason: 'no_profile' });
    await bareAdapter.close();
  });

  it('rejects invalid input without any write', async () => {
    const service = makeService();
    expect(
      await service.save({ learnerId, text: '   ', itemType: 'word', origin: 'talk' }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      await service.save({
        learnerId,
        text: 'ok text',
        itemType: 'paragraph' as never,
        origin: 'talk',
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    const rows = await adapter.query('SELECT COUNT(*) AS count FROM lexical_items', []);
    expect(Number(rows[0].count)).toBe(0);
  });

  it('isSaved finds manual items regardless of surrounding whitespace', async () => {
    const service = makeService();
    expect((await service.isSaved(learnerId, 'double check', 'phrase')).saved).toBe(false);
    await service.save({
      learnerId,
      text: 'double check',
      itemType: 'phrase',
      origin: 'talk',
      contextSentence: 'Let me double check the numbers.',
    });
    const hit = await service.isSaved(learnerId, '  double   check ', 'phrase');
    expect(hit.saved).toBe(true);
    expect(hit.manual).toBe(true);
  });
});
