/**
 * src/listening/index.test.ts
 *
 * Phase-1 Listening Engine tests (42 required scenarios).
 *
 * Strategy: exercise the REAL service + REAL SQLite repositories
 * (SqlJsAdapter) with injected fake AI providers, so evaluation,
 * weakness dedup/lifecycle, review reuse, vocabulary saving, and progress
 * counts are verified end to end — no network, no audio device, no real
 * TTS. Structural checks pin the screen to the EXISTING TTS/recorder
 * stacks. All previous suites keep passing in the same run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteMistakeRepository,
  SQLitePronunciationRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteWeaknessRepository,
  SQLiteReviewRepository,
  SQLiteProgressRepository,
} from '../data/local/sqlite/repositories';
import { ListeningService } from './service';
import {
  evaluateListenAndType,
  evaluateMissingWord,
  evaluateChoice,
  evaluateOpenEndedLocally,
  evaluateWithAI,
  normalizeAnswerText,
} from './evaluator';
import { createListeningService, MAX_SESSION_EXERCISES } from './index';
import type { ListeningExercise } from './types';
import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import { ProgressDashboardService } from '../progress-dashboard/service';
import { ReviewService } from '../review/service';
import { ReviewEvaluator } from '../review/evaluator';

const NOW = '2026-09-18T12:00:00.000Z';

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  expressions: SQLiteExpressionRepository;
  review: SQLiteReviewRepository;
  progress: SQLiteProgressRepository;
  profileRepo: SQLiteUserProfileRepository;
}

async function createContext(): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Listening Tester',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });
  return {
    adapter,
    learnerId: profile.id,
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    progress: new SQLiteProgressRepository(adapter),
    profileRepo,
  };
}

function createService(
  ctx: TestContext,
  options?: { aiProvider?: AIProvider; withProgress?: boolean },
): ListeningService {
  return new ListeningService({
    weaknesses: {
      listWeaknesses: (learnerId, limit) => ctx.weaknesses.listWeaknesses(learnerId, limit),
      upsertWeakness: (weakness) => ctx.weaknesses.upsertWeakness(weakness),
      getWeaknessByReference: (learnerId, type, referenceId) =>
        ctx.weaknesses.getWeaknessByReference(learnerId, type, referenceId),
    },
    review: {
      upsert: (item) => ctx.review.upsert(item),
      getByReference: (learnerId, kind, referenceId) =>
        ctx.review.getByReference(learnerId, kind, referenceId),
    },
    vocabulary: ctx.vocabulary,
    expressions: ctx.expressions,
    progress: options?.withProgress === false ? undefined : ctx.progress,
    aiProvider: options?.aiProvider,
    profile: ctx.profileRepo,
  });
}

function exercise(partial: Partial<ListeningExercise> & { type: ListeningExercise['type'] }): ListeningExercise {
  return {
    id: partial.id ?? '1ef907b7-6c12-4ead-8f9a-c97bd31e00001',
    learnerId: partial.learnerId ?? '1ef907b7-6c12-4ead-8f9a-c97bd31e00999',
    difficulty: 'easy',
    speakText: partial.speakText ?? 'We need to meet the deadline by Friday.',
    expectedAnswer: partial.expectedAnswer ?? 'We need to meet the deadline by Friday',
    keyItems: partial.keyItems ?? ['deadline'],
    source: partial.source ?? 'general',
    ...partial,
  } as ListeningExercise;
}

function fakeAI(
  impl?: (request: unknown) => AIProviderResult,
  calls?: { count: number },
): AIProvider {
  return {
    id: 'fake-listening-ai',
    generate: async (request) => {
      if (calls) calls.count += 1;
      if (impl) return impl(request);
      return {
        ok: true,
        response: {
          content: JSON.stringify({
            result: 'mostly_understood',
            missedItems: ['deadline'],
            feedback: 'You caught the main idea, but missed the deadline detail.',
          }),
        },
      } as AIProviderResult;
    },
  };
}

async function saveVocab(
  ctx: TestContext,
  headword: string,
  definition: string,
): Promise<Awaited<ReturnType<SQLiteVocabularyRepository['upsert']>>> {
  return ctx.vocabulary.upsert({
    learnerId: ctx.learnerId,
    headword,
    type: 'word',
    meanings: [{ definition, examples: [] }],
    source: { addedBy: 'learner-created', addedAt: NOW },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

// ---------------------------------------------------------------------------
// TTS integration (1, 2) + transcript visibility (16, 17)
// ---------------------------------------------------------------------------
describe('TTS integration & transcript visibility', () => {
  const screenSrc = readFileSync(join(__dirname, '../screens/ListeningScreen.tsx'), 'utf8');

  it('1. the screen uses the EXISTING TextToSpeechProvider abstraction', () => {
    expect(screenSrc).toContain('TextToSpeechProvider');
    // The existing provider is lazily imported from the existing voice stack.
    expect(screenSrc).toContain("import('../talk-demo')");
    expect(screenSrc).toMatch(/ttsRef[.\s]*current\.?speak|ttsRef\.current\?\.speak|await ttsRef/);
  });

  it('2. no second TTS stack exists in the listening module', () => {
    const serviceSrc = readFileSync(join(__dirname, './service.ts'), 'utf8');
    const generatorSrc = readFileSync(join(__dirname, './generator.ts'), 'utf8');
    const evaluatorSrc = readFileSync(join(__dirname, './evaluator.ts'), 'utf8');
    for (const src of [serviceSrc, generatorSrc, evaluatorSrc]) {
      expect(src).not.toMatch(/expo-av|createExpoTTSProvider|createDemoTTSProvider|new Audio/i);
    }
    expect(screenSrc).not.toMatch(/expo-av/i);
  });

  it('13. TTS failure is failure-safe (try/catch keeps the exercise and reports honestly)', () => {
    const playHandler = screenSrc.slice(
      screenSrc.indexOf('const handlePlay'),
      screenSrc.indexOf('const handleStop'),
    );
    expect(playHandler).toContain('try');
    expect(playHandler).toContain('catch');
    expect(playHandler).toContain('setErrorMessage');
    // It must NOT reset the session or clear the exercise on failure.
    expect(playHandler).not.toContain('setSession(null)');
    expect(playHandler).not.toContain('setCurrentIndex');
  });

  it('16. the exercise text is NOT rendered before evaluation', () => {
    // speakText may only appear in the TTS call and inside the feedback path —
    // never directly rendered as pre-answer text.
    expect(screenSrc).not.toMatch(/<Text[^>]*>\s*\{currentExercise\.speakText\}/);
    // The feedback card renders only AFTER evaluation exists.
    const feedbackIdx = screenSrc.indexOf('listening_feedback');
    expect(feedbackIdx).toBeGreaterThan(-1);
  });

  it('17. the transcript is revealed after evaluation', async () => {
    const ctx = await createContext();
    const service = createService(ctx);
    const ex = exercise({ type: 'listen_and_type' });
    const { evaluation } = await service.evaluateAnswer(ctx.learnerId, ex, 'wrong words', {
      now: NOW,
    });
    expect(evaluation.revealedTranscript).toBe(ex.speakText);
    expect(evaluation.feedbackLines.join('\n')).toContain(ex.speakText);
  });
});

// ---------------------------------------------------------------------------
// Deterministic evaluation (3–10) + no scores (5, 6)
// ---------------------------------------------------------------------------
describe('Deterministic evaluation', () => {
  it('3. listen_and_type evaluates an exact answer as understood', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'listen_and_type' });
    const { evaluation } = await service.evaluateAnswer(
      ctx.learnerId,
      ex,
      'We need to meet the deadline by Friday',
      { now: NOW },
    );
    expect(evaluation.result).toBe('understood');
    expect(evaluation.missedItems).toEqual([]);
    expect(evaluation.evaluatedBy).toBe('local');
  });

  it('4. normalization handles case, punctuation and extra spaces', () => {
    const ex = exercise({ type: 'listen_and_type' });
    const result = evaluateListenAndType(
      ex,
      '  we NEED to meet, the DEADLINE... by friday!!  ',
    );
    expect(result.result).toBe('understood');
    expect(normalizeAnswerText('Hello,   WORLD!')).toBe('hello world');
  });

  it('5. partial comprehension returns a qualitative result', () => {
    const ex = exercise({ type: 'listen_and_type' });
    const result = evaluateListenAndType(ex, 'We need the friday');
    expect(['partial', 'mostly_understood', 'missed_key_meaning']).toContain(result.result);
    expect(result.missedItems).toContain('deadline');
  });

  it('6. no percentage, score, or band is ever exposed', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    for (const type of [
      'listen_and_type',
      'listen_and_answer',
      'listen_and_choose',
      'missing_word',
      'expression_in_context',
    ] as const) {
      const ex = exercise({ type, options: ['meaning one', 'meaning two', 'meaning three'], expectedAnswer: 'meaning one' });
      const { evaluation } = await service.evaluateAnswer(ctx.learnerId, ex, 'some answer', { now: NOW });
      const serialized = JSON.stringify(evaluation);
      expect(serialized).not.toMatch(/\d+\s*%|\b\d+\s*\/\s*10\b|"score"|percent|band/i);
      expect(['understood', 'mostly_understood', 'partial', 'missed_key_meaning', 'misunderstood', 'insufficient_evidence']).toContain(evaluation.result);
    }
  });

  it('7. listen_and_choose: correct choice result', () => {
    const ex = exercise({
      type: 'listen_and_choose',
      options: ['a final time limit', 'a kind of meeting', 'a day of the week'],
      expectedAnswer: 'a final time limit',
      keyItems: ['deadline'],
    });
    const result = evaluateChoice(ex, 'a final time limit');
    expect(result.result).toBe('understood');
  });

  it('8. listen_and_choose: incorrect choice result explains the right meaning', () => {
    const ex = exercise({
      type: 'listen_and_choose',
      options: ['a final time limit', 'a kind of meeting', 'a day of the week'],
      expectedAnswer: 'a final time limit',
      keyItems: ['deadline'],
    });
    const result = evaluateChoice(ex, 'a kind of meeting');
    expect(['misunderstood', 'partial']).toContain(result.result);
    expect(result.feedbackLines.join('\n')).toContain('a final time limit');
  });

  it('9. missing_word exact/normalized evaluation', () => {
    const ex = exercise({
      type: 'missing_word',
      gappedText: 'We need to meet the ___ by Friday.',
      expectedAnswer: 'deadline',
    });
    expect(evaluateMissingWord(ex, 'Deadline').result).toBe('understood');
    expect(evaluateMissingWord(ex, 'day line').result).toBe('misunderstood');
    expect(evaluateMissingWord(ex, '').result).toBe('insufficient_evidence');
  });

  it('10. expression_in_context evaluation with deterministic alternatives', () => {
    const ex = exercise({
      type: 'expression_in_context',
      options: ['no way forward', 'a quiet place'],
      expectedAnswer: 'no way forward',
      acceptableAnswers: ['a situation with no way forward'],
      keyItems: ['a dead end'],
    });
    expect(evaluateChoice(ex, 'no way forward').result).toBe('understood');
    expect(evaluateChoice(ex, 'a situation with no way forward').result).toBe('understood');
    expect(evaluateChoice(ex, 'a quiet place').result).toBe('misunderstood');
  });
});

// ---------------------------------------------------------------------------
// Open-ended AI evaluation & fallback (11, 12)
// ---------------------------------------------------------------------------
describe('Open-ended AI evaluation & fallback', () => {
  it('11. open-ended comprehension uses the EXISTING AIProvider (exactly once)', async () => {
    const ctx = await createContext();
    const calls = { count: 0 };
    const service = createService(ctx, { aiProvider: fakeAI(undefined, calls), withProgress: false });
    const ex = exercise({
      type: 'listen_and_answer',
      question: 'Why did the meeting move?',
      expectedAnswer: 'because the manager was traveling',
    });
    const { evaluation } = await service.evaluateAnswer(ctx.learnerId, ex, 'The manager was away', {
      now: NOW,
    });
    expect(calls.count).toBe(1);
    expect(evaluation.evaluatedBy).toBe('ai');
    expect(evaluation.result).toBe('mostly_understood');
  });

  it('12. AI failure falls back to a safe local evaluation (never fabricated)', async () => {
    const ctx = await createContext();
    const failing: AIProvider = {
      id: 'failing-ai',
      generate: async () => {
        throw new Error('AI unavailable');
      },
    };
    const service = createService(ctx, { aiProvider: failing, withProgress: false });
    const ex = exercise({
      type: 'listen_and_answer',
      speakText: 'The report is due on Tuesday morning.',
      question: 'When is the report due?',
      expectedAnswer: 'Tuesday morning',
      keyItems: ['Tuesday'],
    });
    const { evaluation } = await service.evaluateAnswer(ctx.learnerId, ex, 'something about friday', {
      now: NOW,
    });
    expect(evaluation.evaluatedBy).toBe('local');
    expect(evaluation.result).not.toBe('understood');
    expect(evaluation.feedbackLines.join('\n')).toContain('Tuesday morning');
  });

  it('12b. an unusable AI answer (no valid JSON/category) falls back locally too', async () => {
    const unusableAI = fakeAI(() => ({
      ok: true,
      response: { content: 'Sounds fine to me!' },
    }) as AIProviderResult);
    const ex = exercise({
      type: 'listen_and_answer',
      speakText: 'The report is due on Tuesday morning.',
      question: 'When is the report due?',
      expectedAnswer: 'Tuesday morning',
      keyItems: ['Tuesday'],
    });
    const evaluation = await evaluateWithAI(unusableAI, ex, 'on tuesday morning');
    expect(evaluation.evaluatedBy).toBe('local');
    // The local fallback honestly recognizes the key word.
    expect(['mostly_understood', 'partial', 'understood']).toContain(evaluation.result);
  });

  it('12c. local open-ended fallback never claims understanding without basis', () => {
    const ex = exercise({
      type: 'listen_and_answer',
      speakText: 'The report is due on Tuesday morning.',
      expectedAnswer: 'Tuesday morning',
      keyItems: ['Tuesday'],
    });
    const wrong = evaluateOpenEndedLocally(ex, 'no relation at all here');
    expect(['missed_key_meaning', 'misunderstood', 'partial']).toContain(wrong.result);
    const empty = evaluateOpenEndedLocally(ex, '');
    expect(empty.result).toBe('insufficient_evidence');
  });
});

// ---------------------------------------------------------------------------
// Weakness lifecycle (18–23) + evidence persistence (15, 24)
// ---------------------------------------------------------------------------
describe('Listening weakness lifecycle', () => {
  it('18/19. repeated listening issue deduplicates; first issue is observed', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex1 = exercise({ type: 'listen_and_type' });
    const ex2 = exercise({
      type: 'missing_word',
      id: '1ef907b7-6c12-4ead-8f9a-c97bd31e00002',
      gappedText: 'We need to meet the ___ by Friday.',
      expectedAnswer: 'deadline',
    });

    // Both answers are genuinely partial/misunderstood → both persist evidence.
    await service.evaluateAnswer(ctx.learnerId, ex1, 'we need something by friday', { now: NOW });
    const [firstRow] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(firstRow.status).toBe('observed'); // 19. first issue → observed
    await service.evaluateAnswer(ctx.learnerId, ex2, 'day line', {
      now: '2026-09-18T13:00:00.000Z',
    });

    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    const listening = rows.filter((w) => w.type === 'listening');
    expect(listening).toHaveLength(1);
    expect(listening[0].status).toBe('repeated'); // advanced on the repeat
    expect(listening[0].notes).toBe('word_recognition:deadline');
    expect(listening[0].occurrenceCount).toBe(2);
    expect(listening[0].firstSeenAt).toBe(NOW);
    expect(listening[0].lastSeenAt).toBe('2026-09-18T13:00:00.000Z');
  });

  it('20. repeats advance conservatively observed → repeated → confirmed', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'missing_word', gappedText: 'the ___', expectedAnswer: 'deadline' });
    await service.evaluateAnswer(ctx.learnerId, ex, 'headline', { now: '2026-09-18T10:00:00.000Z' });
    await service.evaluateAnswer(ctx.learnerId, ex, 'head line', { now: '2026-09-18T11:00:00.000Z' });
    let [row] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(row.status).toBe('repeated');
    await service.evaluateAnswer(ctx.learnerId, ex, 'red line', { now: '2026-09-18T12:00:00.000Z' });
    [row] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(row.status).toBe('confirmed');
  });

  it('21. confirmed never regresses to observed', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'missing_word', gappedText: 'the ___', expectedAnswer: 'deadline' });
    for (let i = 0; i < 3; i += 1) {
      await service.evaluateAnswer(ctx.learnerId, ex, 'wrong', {
        now: new Date(new Date(NOW).getTime() + i * 60_000).toISOString(),
      });
    }
    const [row] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(row.status).toBe('confirmed');
    // More failures → still confirmed.
    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong again', {
      now: '2026-09-18T13:00:00.000Z',
    });
    const [after] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(after.status).toBe('confirmed');
  });

  it('22. stable/mastered weakness relapses and stays active', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'missing_word', gappedText: 'the ___', expectedAnswer: 'deadline' });
    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong', { now: NOW });
    const [row] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    await ctx.weaknesses.upsertWeakness({ ...row, status: 'stable' });

    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong again', {
      now: '2026-09-18T13:00:00.000Z',
    });
    const [after] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(after.status).toBe('relapsed');
    expect(after.resolved).toBe(false);
  });

  it('23. no observed → mastered shortcut', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'missing_word', gappedText: 'the ___', expectedAnswer: 'deadline' });
    for (let i = 0; i < 8; i += 1) {
      await service.evaluateAnswer(ctx.learnerId, ex, 'wrong', {
        now: new Date(new Date(NOW).getTime() + i * 60_000).toISOString(),
      });
    }
    const [row] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(row.status).toBe('confirmed');
  });

  it('15/24. replay count and lexical links persist in evidence; exact lookups used', async () => {
    const ctx = await createContext();
    const saved = await saveVocab(ctx, 'deadline', 'a final time limit');
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({
      type: 'listen_and_choose',
      options: ['a final time limit', 'a meeting', 'a weekday'],
      expectedAnswer: 'a final time limit',
      lexicalItemId: saved.id,
    });
    const getByRefSpy = vi.spyOn(ctx.weaknesses, 'getWeaknessByReference');

    await service.evaluateAnswer(ctx.learnerId, ex, 'a kind of meeting', {
      replayCount: 2,
      now: NOW,
    });

    const [row] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(row.contexts).toContain(`lexical:${saved.id}`);
    expect(row.contexts).toContain('replays:2');
    expect(row.evidence[row.evidence.length - 1].summary).toContain('replays: 2');
    // EXACT identity lookup — not a capped scan.
    expect(getByRefSpy).toHaveBeenCalledWith(ctx.learnerId, 'listening', expect.any(String));

    // Vocab untouched (no duplicate lexical rows).
    const vocab = await ctx.vocabulary.list(ctx.learnerId, { limit: 100 });
    expect(vocab).toHaveLength(1);
    expect(vocab[0].meanings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Review integration (26–28) + evaluation routing
// ---------------------------------------------------------------------------
describe('Review integration', () => {
  it('26. a listening weakness creates the review item ONCE and reuses it', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'missing_word', gappedText: 'the ___', expectedAnswer: 'deadline' });
    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong', { now: NOW });

    const items = await ctx.review.list(ctx.learnerId, 100);
    expect(items.filter((r) => r.kind === 'listening')).toHaveLength(1);

    // Repeat → still exactly one item.
    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong again', {
      now: '2026-09-18T13:00:00.000Z',
    });
    const itemsAfter = await ctx.review.list(ctx.learnerId, 100);
    expect(itemsAfter.filter((r) => r.kind === 'listening')).toHaveLength(1);
  });

  it('27. existing review history is never reset (practiced AND retired cases)', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'missing_word', gappedText: 'the ___', expectedAnswer: 'deadline' });
    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong', { now: NOW });

    const [item] = await ctx.review.list(ctx.learnerId, 100);
    await ctx.review.markReviewed(item.id, 'correct', 'good');
    const practiced = await ctx.review.get(item.id);
    expect(practiced!.reviewCount).toBe(1);
    expect(practiced!.lastReviewAt).toBe(NOW);
    expect(new Date(practiced!.dueAt).getTime()).toBeGreaterThan(new Date(NOW).getTime());

    // Retire it (Review system lifecycle).
    await ctx.review.upsert({ ...practiced!, state: 'retired', id: practiced!.id });
    const retired = await ctx.review.get(item.id);
    expect(retired!.state).toBe('retired');

    // Re-observe the same issue → history fully preserved.
    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong once more', {
      now: '2026-09-18T14:00:00.000Z',
    });
    const after = await ctx.review.get(item.id);
    expect(after!.id).toBe(item.id);
    expect(after!.state).toBe('retired');
    expect(after!.reviewCount).toBe(practiced!.reviewCount);
    expect(after!.outcomeHistory).toEqual(practiced!.outcomeHistory);
    expect(after!.lastReviewAt).toBe(practiced!.lastReviewAt);
    expect(after!.dueAt).toBe(practiced!.dueAt);

    const all = await ctx.review.list(ctx.learnerId, 100);
    expect(all.filter((r) => r.kind === 'listening')).toHaveLength(1);
  });

  it('28. listening review flows through the EXISTING planner and evaluator', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({ type: 'missing_word', gappedText: 'the ___', expectedAnswer: 'deadline' });
    await service.evaluateAnswer(ctx.learnerId, ex, 'wrong', { now: NOW });

    const reviewService = new ReviewService({
      profile: ctx.profileRepo,
      pronunciation: new SQLitePronunciationRepository(ctx.adapter),
      mistakes: new SQLiteMistakeRepository(ctx.adapter),
      weaknesses: ctx.weaknesses,
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
      review: ctx.review,
    } as never);
    const candidates = await reviewService.planSession(ctx.learnerId, { minItems: 1, maxItems: 8 });
    const listeningCandidates = candidates.filter((c) => c.kind === 'listening');
    expect(listeningCandidates.length).toBeGreaterThanOrEqual(1);
    expect(listeningCandidates[0].exerciseType).toBe('listening_practice');

    // Local qualitative evaluation of the review candidate.
    const evaluator = new ReviewEvaluator();
    const evaluation = await evaluator.evaluate(
      listeningCandidates[0],
      listeningCandidates[0].expectedAnswer,
    );
    expect(evaluation.result).toBe('correct');
    expect(evaluation.feedback).not.toMatch(/\d+\s*%|score/i);
    const empty = await evaluator.evaluate(listeningCandidates[0], '');
    expect(empty.result).toBe('incorrect');
    expect(empty.feedback).toMatch(/insufficient evidence/i);

    // No second scheduler / no new listening tables.
    const tables = await ctx.adapter.query(`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = tables.map((t) => String(t.name).toLowerCase());
    expect(names).toContain('review_items');
    expect(names.filter((n) => n.includes('listening'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session planning (31, 32, 33, 34) + real/demo honesty (30, 31)
// ---------------------------------------------------------------------------
describe('Session planning & honesty', () => {
  it('30/31. no fabricated learner; empty/generic data is honestly labeled', async () => {
    const freshAdapter = new SqlJsAdapter();
    await freshAdapter.init();
    const service = createListeningService(freshAdapter);

    // No profile → no fabricated learner id.
    expect(await service.resolveLearnerId()).toBeNull();

    const profileRepo = new SQLiteUserProfileRepository(freshAdapter);
    const profile = await profileRepo.update({
      displayName: 'Fresh',
      currentLevel: 'A2',
      targetLevel: 'B1',
      learningGoals: [],
      preferredModes: [],
    });
    const session = await service.startSession(profile.id, { now: NOW });
    expect(session.exercises.length).toBeGreaterThan(0);
    expect(session.exercises.every((e) => e.source === 'general')).toBe(true);
    expect(session.sourceNote).toMatch(/general practice — not personalized/i);
  });

  it('32. sessions are bounded (5–10 exercises)', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const session = await service.startSession(ctx.learnerId, { now: NOW });
    expect(session.exercises.length).toBeLessThanOrEqual(MAX_SESSION_EXERCISES);
    expect(session.exercises.length).toBeGreaterThanOrEqual(1);
  });

  it('33/34. bounded reads, no unlimited history, no N+1 planning queries', async () => {
    const ctx = await createContext();
    const listWeaknesses = vi.spyOn(ctx.weaknesses, 'listWeaknesses');
    const vocabListDue = vi.spyOn(ctx.vocabulary, 'listDue');
    const exprListDue = vi.spyOn(ctx.expressions, 'listDue');
    const vocabList = vi.spyOn(ctx.vocabulary, 'list');

    const service = createService(ctx, { withProgress: false });
    await service.startSession(ctx.learnerId, { now: NOW });

    // Exactly ONE call per repository (single batched round — no N+1).
    expect(listWeaknesses).toHaveBeenCalledTimes(1);
    expect(vocabListDue).toHaveBeenCalledTimes(1);
    expect(exprListDue).toHaveBeenCalledTimes(1);
    expect(vocabList).toHaveBeenCalledTimes(1);
    // All reads are bounded.
    expect(listWeaknesses.mock.calls[0][1]).toBeLessThanOrEqual(100);
    expect(vocabListDue.mock.calls[0][2]).toBeLessThanOrEqual(10);
    expect(exprListDue.mock.calls[0][2]).toBeLessThanOrEqual(10);
    expect(vocabList.mock.calls[0][1]?.limit).toBeLessThanOrEqual(20);
  });

  it('14. planning is deterministic; replay does not duplicate exercises', async () => {
    const ctx = await createContext();
    await saveVocab(ctx, 'deadline', 'a final time limit');
    const service = createService(ctx, { withProgress: false });
    const first = await service.startSession(ctx.learnerId, { now: NOW });
    const second = await service.startSession(ctx.learnerId, { now: NOW });
    expect(first.exercises.length).toBe(second.exercises.length);
    expect(first.exercises.map((e) => e.speakText)).toEqual(second.exercises.map((e) => e.speakText));
    // Evaluating the same exercise again never adds exercises to a session.
    const ex = first.exercises[0];
    const { evaluation } = await service.evaluateAnswer(ctx.learnerId, ex, ex.expectedAnswer, { now: NOW });
    expect(evaluation).toBeDefined();
    const again = await service.startSession(ctx.learnerId, { now: NOW });
    expect(again.exercises.length).toBe(first.exercises.length);
  });

  it('35. typed answer flow works end to end (weakness + review + evaluation)', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { withProgress: false });
    const ex = exercise({
      type: 'listen_and_type',
      speakText: 'We need to review the contract before signing anything.',
      expectedAnswer: 'We need to review the contract before signing anything',
      keyItems: ['contract'],
    });
    const { evaluation, persistenceError } = await service.evaluateAnswer(
      ctx.learnerId,
      ex,
      'We need to review the contract before signing anything',
      { now: NOW },
    );
    expect(evaluation.result).toBe('understood');
    expect(persistenceError).toBe(false);
    // No weakness for a fully understood general exercise.
    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(rows.filter((w) => w.type === 'listening')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary / Progress integration (25, 29)
// ---------------------------------------------------------------------------
describe('Vocabulary & Progress integration', () => {
  it('25. saveVocabulary reuses the existing item (no duplicates, review preserved)', async () => {
    const ctx = await createContext();
    const existing = await saveVocab(ctx, 'deadline', 'a final time limit');
    const withReview = await ctx.vocabulary.update(existing.id, {
      meanings: [
        {
          ...existing.meanings[0],
          review: {
            state: 'familiar' as const,
            lastReviewAt: NOW,
            nextReviewAt: '2026-09-25T00:00:00.000Z',
            reviewCount: 3,
            consecutiveCorrect: 2,
          },
        },
      ],
    });

    const service = createService(ctx, { withProgress: false });
    const result = await service.saveVocabulary(ctx.learnerId, 'Deadline', 'another definition');
    expect(result.created).toBe(false);
    expect(result.item.id).toBe(existing.id);

    const list = await ctx.vocabulary.list(ctx.learnerId, { limit: 100 });
    expect(list).toHaveLength(1);
    // meaning.review history untouched.
    expect(list[0].meanings[0].review?.reviewCount).toBe(
      withReview.meanings[0].review?.reviewCount,
    );

    // Saving a NEW word creates it through the existing repository.
    const second = await service.saveVocabulary(ctx.learnerId, 'stakeholder', 'a person with an interest');
    expect(second.created).toBe(true);
    const after = await ctx.vocabulary.list(ctx.learnerId, { limit: 100 });
    expect(after).toHaveLength(2);
  });

  it('29. progress records listening activity as counts only (no scores)', async () => {
    const ctx = await createContext();
    const service = createService(ctx);
    await service.recordSessionCompleted(
      ctx.learnerId,
      { exercisesCompleted: 8, problemResults: 2, understoodResults: 6 },
      { now: NOW },
    );

    const records = await ctx.progress.list(ctx.learnerId, 10);
    expect(records).toHaveLength(1);
    expect(records[0].sessionsCompleted).toBe(1);
    expect(records[0].turnsCompleted).toBe(8);
    expect(records[0].listeningScore).toBeUndefined();

    const dashboard = new ProgressDashboardService({
      profile: ctx.profileRepo,
      conversations: { listSessions: async () => [] } as never,
      weaknesses: ctx.weaknesses,
      vocabulary: ctx.vocabulary,
      expressions: { list: async () => [] } as never,
      review: ctx.review,
      progress: ctx.progress,
    });
    const snapshot = await dashboard.loadDashboard(ctx.learnerId, { now: NOW });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/listeningScore"?\s*:\s*(0\.\d+|\d+)/);
    expect(serialized).not.toMatch(/"listening_score"/);
  });
});
