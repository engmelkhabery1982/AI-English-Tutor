/**
 * src/pronunciation/index.test.ts
 *
 * Phase-1 Pronunciation Engine tests (32 required scenarios).
 *
 * Strategy: exercise the REAL engine + REAL SQLite repositories
 * (SqlJsAdapter) with an INJECTED fake provider, so dedup, lifecycle,
 * persistence, lexical linking, review scheduling, and dashboard reads are
 * verified end to end — no network, microphone, or TTS. Structural checks
 * pin the screens to the existing recorder/STT wiring. The existing
 * Voice/Talk/Review/Vocabulary/Progress suites must keep passing in the
 * same run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteMistakeRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
} from '../data/local/sqlite/repositories';
import { PronunciationEngine, observationIdentity } from './engine';
import { createTranscriptComparisonPronunciationProvider } from './baseline-provider';
import { buildPronunciationFeedback } from './feedback';
import { createPronunciationEngine } from './index';
import type { PronunciationAnalysis, PronunciationProvider } from './types';
import {
  createSuccessObservationRecorder,
  type SuccessObservationRecorder,
} from '../reassessment';
import { ReviewService } from '../review/service';
import { VocabularyWorkspaceService } from '../vocabulary-workspace/service';
import { SQLiteExpressionRepository } from '../data/local/sqlite/repositories';
import { ReviewEvaluator } from '../review/evaluator';
import { ProgressDashboardService } from '../progress-dashboard/service';
import type { VocabularyItem } from '../domain/models/vocabulary';

// Cross-platform equivalent of the CommonJS __dirname (Windows-safe:
// fileURLToPath handles drive letters and percent-encoded segments that
// URL.pathname mangles).
const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = '2026-09-17T12:00:00.000Z';

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  pronunciation: SQLitePronunciationRepository;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  review: SQLiteReviewRepository;
  profileRepo: SQLiteUserProfileRepository;
}

async function createContext(): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();

  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Pronunciation Tester',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });

  return {
    adapter,
    learnerId: profile.id,
    pronunciation: new SQLitePronunciationRepository(adapter),
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    profileRepo,
  };
}

/** Compose the real engine on a context with an arbitrary provider. */
function createEngine(
  ctx: TestContext,
  provider: PronunciationProvider,
  options?: {
    /** WP-4: the EXISTING success-observation recorder (strength evidence). */
    successRecorder?: SuccessObservationRecorder;
  },
): PronunciationEngine {
  return new PronunciationEngine({
    provider,
    pronunciation: {
      recordObservation: (input) => ctx.pronunciation.recordObservation(input),
      listWeaknesses: (learnerId, opts) => ctx.pronunciation.listWeaknesses(learnerId, opts),
    },
    weaknesses: ctx.weaknesses,
    review: ctx.review,
    profile: ctx.profileRepo,
    vocabulary: ctx.vocabulary,
    ...(options?.successRecorder ? { successRecorder: options.successRecorder } : {}),
  });
}

/** Deterministic fake provider for engine tests. */
function fakeProvider(
  analysis: Partial<PronunciationAnalysis> | ((input: { transcript: string; expectedText?: string }) => PronunciationAnalysis),
): PronunciationProvider {
  return {
    id: 'fake-pronunciation-provider',
    analyze: async (input) =>
      typeof analysis === 'function'
        ? analysis(input)
        : {
            provider: 'fake-pronunciation-provider',
            evidenceLevel: 'transcript_comparison',
            observations: [],
            ...analysis,
          },
  };
}

function wordObservation(target = 'comfortable'): PronunciationAnalysis['observations'][number] {
  return {
    type: 'word_pronunciation',
    target,
    observed: 'comf-ta-ble',
    description: `The transcript suggests "${target}" may have been pronounced unclearly (transcript-derived, not acoustic).`,
    evidence: 'stt_substitution',
    confidence: 'medium',
    coachingHint: `Try saying "${target}" slowly, syllable by syllable.`,
  };
}

async function saveVocab(ctx: TestContext, headword: string): Promise<VocabularyItem> {
  return ctx.vocabulary.upsert({
    learnerId: ctx.learnerId,
    headword,
    type: 'word',
    meanings: [{ definition: `definition of ${headword}`, examples: [] }],
    source: { addedBy: 'learner-created', addedAt: NOW },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

// ---------------------------------------------------------------------------
// Provider & evidence model (scenarios 1–4, 17, 24)
// ---------------------------------------------------------------------------
describe('Pronunciation provider & evidence model', () => {
  it('1. works with an injected fake provider (provider-neutral engine)', async () => {
    const ctx = await createContext();
    const engine = createEngine(
      ctx,
      fakeProvider({ observations: [wordObservation()] }),
    );
    expect(engine.providerId).toBe('fake-pronunciation-provider');

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I feel comf-ta-ble here',
      expectedText: 'I feel comfortable here',
      now: NOW,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.unavailable).toBe(false);
    expect(outcome!.analysis.observations).toHaveLength(1);
  });

  it('2. reports insufficient evidence instead of fabricating an issue', async () => {
    const ctx = await createContext();
    const provider = createTranscriptComparisonPronunciationProvider();

    // No transcript at all
    const empty = await provider.analyze({ learnerId: ctx.learnerId, transcript: '' });
    expect(empty.insufficientEvidence).toBe(true);
    expect(empty.observations).toHaveLength(0);

    // Transcript without an expected text — nothing to compare against
    const noExpected = await provider.analyze({
      learnerId: ctx.learnerId,
      transcript: 'hello how are you',
    });
    expect(noExpected.insufficientEvidence).toBe(true);
    expect(noExpected.observations).toHaveLength(0);

    // Matching transcript → explicitly clear, no invented issue
    const clear = await provider.analyze({
      learnerId: ctx.learnerId,
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
    });
    expect(clear.insufficientEvidence).toBeFalsy();
    expect(clear.observations).toHaveLength(0);
    expect(clear.overallIntelligibility).toBe('clear');
  });

  it('3. labels transcript-derived observations with their evidence source', async () => {
    const provider = createTranscriptComparisonPronunciationProvider();
    const analysis = await provider.analyze({
      learnerId: '1ef907b7-6c12-4ead-8f9a-c97bd31e83f3',
      transcript: 'I walk to school yesterday',
      expectedText: 'I walked to school yesterday',
    });
    expect(analysis.insufficientEvidence).toBeFalsy();
    expect(analysis.observations.length).toBeGreaterThan(0);
    for (const observation of analysis.observations) {
      expect(observation.evidence).not.toBe('acoustic');
      expect(['transcript_comparison', 'stt_substitution']).toContain(observation.evidence);
    }
    // The -ed ending drives an 'ending' observation.
    expect(analysis.observations.some((o) => o.type === 'ending')).toBe(true);
  });

  it('4. never treats AI explanations as acoustic evidence', async () => {
    const provider = createTranscriptComparisonPronunciationProvider();
    // A transcript that merely CONTAINS tutor-style explanation text is still
    // only ever compared as text — no acoustic claims can appear.
    const analysis = await provider.analyze({
      learnerId: '1ef907b7-6c12-4ead-8f9a-c97bd31e83f3',
      transcript: 'The tutor said my vowels need work',
      expectedText: 'The tutor said my vowels need work',
    });
    expect(analysis.evidenceLevel).not.toBe('acoustic');
    for (const observation of analysis.observations) {
      expect(observation.evidence).not.toBe('acoustic');
      expect(observation.evidence).not.toBe('ai_explanation_only');
    }
    expect(analysis.notes).toMatch(/transcript/i);
  });

  it('17. produces no numeric scores anywhere in the provider result', async () => {
    const provider = createTranscriptComparisonPronunciationProvider();
    const analysis = await provider.analyze({
      learnerId: '1ef907b7-6c12-4ead-8f9a-c97bd31e83f3',
      transcript: 'I walk to school yesterday and develop comf-ta-ble habits',
      expectedText: 'I walked to school yesterday and developed comfortable habits',
    });
    const serialized = JSON.stringify(analysis);
    expect(serialized).not.toMatch(/"(score|accuracy|confidenceScore|percentage|percent)"/i);
    for (const observation of analysis.observations) {
      expect(['low', 'medium', 'high']).toContain(observation.confidence);
    }
  });

  it('24. real-mode composition selects the baseline provider with no demo fallback', async () => {
    const ctx = await createContext();
    const engine = createPronunciationEngine(ctx.adapter);
    expect(engine.providerId).toBe('transcript-comparison-baseline');

    // Even garbage input produces an honest result, never a fabricated one.
    const outcome = await engine.analyzeSpokenTurn({
      transcript: '',
      expectedText: 'anything',
      now: NOW,
    });
    // Empty transcript → the engine skips (no learner turn worth analyzing)
    // or reports insufficient evidence — never a fake diagnosis.
    if (outcome) {
      expect(outcome.analysis.insufficientEvidence).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Persistence, dedup & lifecycle (scenarios 5–11, 25, 26)
// ---------------------------------------------------------------------------
describe('Pronunciation persistence, dedup & lifecycle', () => {
  it('5. dedups repeated issues into one stable identity', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));

    const input = { transcript: 'comf-ta-ble', expectedText: 'comfortable', now: NOW };
    await engine.analyzeSpokenTurn(input);
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T13:00:00.000Z' });
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T14:00:00.000Z' });

    const rows = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0].targetSound).toBe(observationIdentity(wordObservation()));
    expect(rows[0].occurrenceCount).toBe(3);
  });

  it('6. increases occurrence and evidence counts on repeats', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    const input = { transcript: 'comf-ta-ble', expectedText: 'comfortable', now: NOW };

    await engine.analyzeSpokenTurn(input);
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T13:00:00.000Z' });

    const [row] = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 50 });
    expect(row.occurrenceCount).toBe(2);
    expect(row.wordExamples.length).toBeGreaterThanOrEqual(2);
    expect(row.firstSeenAt).toBe(NOW);
    expect(row.lastSeenAt).toBe('2026-09-17T13:00:00.000Z');

    const learnerWeaknesses = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(learnerWeaknesses.filter((w) => w.type === 'pronunciation')).toHaveLength(1);
    expect(learnerWeaknesses[0].evidence.length).toBe(2);
  });

  it('7. marks the first observation as "observed"', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });

    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(weakness.type).toBe('pronunciation');
    expect(weakness.status).toBe('observed');
    expect(weakness.resolved).toBe(false);
  });

  it('8. advances repeats conservatively through the existing lifecycle', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    const input = { transcript: 'comf-ta-ble', expectedText: 'comfortable' };

    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T10:00:00.000Z' });
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T11:00:00.000Z' });
    const statusesAfterTwo = (await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100)).map(
      (w) => w.status,
    );
    expect(statusesAfterTwo).toEqual(['repeated']);

    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T12:00:00.000Z' });
    const statusesAfterThree = (await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100)).map(
      (w) => w.status,
    );
    expect(statusesAfterThree).toEqual(['confirmed']);
  });

  it('9. never shortcuts observed → mastered', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    const input = { transcript: 'comf-ta-ble', expectedText: 'comfortable' };

    // Many repeats in a row must NEVER jump to mastered.
    for (let i = 0; i < 6; i += 1) {
      await engine.analyzeSpokenTurn({
        ...input,
        now: new Date(new Date(NOW).getTime() + i * 60_000).toISOString(),
      });
    }
    const statuses = (await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100)).map(
      (w) => w.status,
    );
    expect(statuses).toEqual(['confirmed']);
  });

  it('10. a relapsed weakness stays active (resolved === false)', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));

    // First observation creates the weakness.
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T10:00:00.000Z',
    });
    // Simulate the existing lifecycle having brought it to 'stable'.
    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    await ctx.weaknesses.upsertWeakness({ ...weakness, status: 'stable' });

    // The issue reappears in a later turn.
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T12:00:00.000Z',
    });

    const [after] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(after.status).toBe('relapsed');
    expect(after.resolved).toBe(false);
  });

  it('11. persists through repository reload', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });

    // Fresh repository instances over the SAME adapter see the same rows.
    const reloadedPron = new SQLitePronunciationRepository(ctx.adapter);
    const reloadedWeak = new SQLiteWeaknessRepository(ctx.adapter);
    const pronRows = await reloadedPron.listWeaknesses(ctx.learnerId, { limit: 50 });
    const weakRows = await reloadedWeak.listWeaknesses(ctx.learnerId, 100);
    expect(pronRows).toHaveLength(1);
    expect(weakRows).toHaveLength(1);
    expect(weakRows[0].referenceId).toBe(pronRows[0].id);
  });

  it('25. never fabricates a learner id (no profile → nothing persisted)', async () => {
    const adapter = new SqlJsAdapter();
    await adapter.init();
    const engine = createPronunciationEngine(adapter); // fresh DB, no profile

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });
    expect(outcome).toBeNull();

    const pronRepo = new SQLitePronunciationRepository(adapter);
    const rows = await pronRepo.listWeaknesses('1ef907b7-6c12-4ead-8f9a-c97bd31e83f3', {
      limit: 50,
    });
    expect(rows).toHaveLength(0);
  });

  it('26. a provider error is non-destructive (nothing persisted, no throw)', async () => {
    const ctx = await createContext();
    const engine = createEngine(
      ctx,
      fakeProvider(() => {
        throw new Error('provider exploded');
      }),
    );

    await expect(
      engine.analyzeSpokenTurn({
        transcript: 'comf-ta-ble',
        expectedText: 'comfortable',
        now: NOW,
      }),
    ).resolves.toSatisfy?.(() => true); // must not throw

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });
    expect(outcome!.unavailable).toBe(true);
    expect(outcome!.analysis.insufficientEvidence).toBe(true);

    const pronRows = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 50 });
    const weakRows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(pronRows).toHaveLength(0);
    expect(weakRows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Talk/Voice integration & feedback behavior (scenarios 12–16, 18)
// ---------------------------------------------------------------------------
describe('Talk/Voice integration & qualitative feedback', () => {
  it('12. persists an observation for a spoken turn (the call TalkScreen makes)', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I feel comf-ta-ble with it',
      expectedText: 'I feel comfortable with it',
      mode: 'coach',
      now: NOW,
    });
    expect(outcome!.feedbackLines.length).toBeGreaterThan(0);
    const rows = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 50 });
    expect(rows).toHaveLength(1);
  });

  it('13. an analysis failure does not fail the conversation', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider(() => {
      throw new Error('STT unavailable');
    }));
    // The engine itself must not throw — TalkScreen continues regardless.
    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'hello',
      expectedText: 'hello',
      now: NOW,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.unavailable).toBe(true);
    expect(outcome!.feedbackLines).toEqual([]);
  });

  it('14. natural mode limits feedback to at most one line', () => {
    const analysis: PronunciationAnalysis = {
      provider: 'fake',
      evidenceLevel: 'transcript_comparison',
      observations: [wordObservation(), wordObservation('development')],
    };
    expect(buildPronunciationFeedback(analysis, 'natural')).toHaveLength(1);
    // Clear speech stays silent in natural mode.
    expect(buildPronunciationFeedback({ ...analysis, observations: [] }, 'natural')).toEqual([]);
  });

  it('15. coach mode surfaces meaningful feedback when evidence exists', () => {
    const analysis: PronunciationAnalysis = {
      provider: 'fake',
      evidenceLevel: 'transcript_comparison',
      observations: [wordObservation()],
    };
    const lines = buildPronunciationFeedback(analysis, 'coach');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toContain('comfortable');
  });

  it('16. intensive mode surfaces more detail (hints included)', () => {
    const analysis: PronunciationAnalysis = {
      provider: 'fake',
      evidenceLevel: 'transcript_comparison',
      observations: [wordObservation(), wordObservation('development')],
    };
    const lines = buildPronunciationFeedback(analysis, 'intensive');
    expect(lines.length).toBeGreaterThan(buildPronunciationFeedback(analysis, 'coach').length);
    expect(lines.some((l) => /suggestion|try/i.test(l))).toBe(true);
  });

  it('18. user-visible feedback never contains numeric scores', () => {
    const analysis: PronunciationAnalysis = {
      provider: 'fake',
      evidenceLevel: 'transcript_comparison',
      observations: [wordObservation()],
    };
    for (const mode of ['natural', 'coach', 'intensive'] as const) {
      for (const line of buildPronunciationFeedback(analysis, mode)) {
        expect(line).not.toMatch(/\d+\s*%/);
        expect(line).not.toMatch(/\b\d+\s*\/\s*10\b/);
        expect(line).not.toMatch(/\bscore\b/i);
        expect(line).not.toMatch(/CEFR\s*[ABC]\d/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Review integration (scenarios 19–21)
// ---------------------------------------------------------------------------
describe('Review integration', () => {
  it('19. pronunciation candidates flow through the EXISTING review planner', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });

    const service = new ReviewService({
      profile: ctx.profileRepo,
      pronunciation: ctx.pronunciation,
      weaknesses: ctx.weaknesses,
      vocabulary: ctx.vocabulary,
      expressions: new (Object.getPrototypeOf(ctx.vocabulary).constructor)(ctx.adapter),
      mistakes: new SQLiteMistakeRepository(ctx.adapter),
      review: ctx.review,
    } as never);
    const candidates = await service.planSession(ctx.learnerId, { minItems: 1, maxItems: 5 });
    const pronunciationCandidates = candidates.filter(
      (c) => c.exerciseType === 'pronunciation_repeat',
    );
    expect(pronunciationCandidates.length).toBe(1);
    expect(pronunciationCandidates[0].kind).toBe('pronunciation');
    expect(pronunciationCandidates[0].referenceId).toBeTruthy();
  });

  it('20. uses the existing review scheduler — no second scheduler, no new tables', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });

    // The item was scheduled through the EXISTING review_items table.
    const due = await ctx.review.listDue(ctx.learnerId, NOW);
    expect(due.some((item) => item.kind === 'pronunciation')).toBe(true);

    // No new persistence tables were invented for pronunciation tracking.
    const tablesResult = await ctx.adapter.query(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    const tableNames = tablesResult.map((r) => String(r.name).toLowerCase());
    expect(tableNames).toContain('review_items');
    expect(tableNames.filter((n) => n.includes('observation'))).toEqual([]);
    expect(tableNames.filter((n) => n.includes('schedule') && n !== 'review_items')).toEqual([]);
  });

  it('21. voice answers reuse the existing recorder/STT flow and evaluate qualitatively', async () => {
    // Structural: ReviewScreen still wires the existing recorder + STT and
    // only fills the answer box from the transcript (no silent auto-submit).
    const source = readFileSync(join(__dirname, '../screens/ReviewScreen.tsx'), 'utf8');
    expect(source).toContain('createExpoAudioRecorder');
    expect(source).toContain('setUserAnswer(sttRes.transcript)');
    expect(source).not.toMatch(/setUserAnswer\(sttRes\.transcript\)[^;]*;[^]*?handleSubmitAnswer\(\)/);

    // Behavioral: an STT-style transcript evaluates qualitatively (no score).
    const ctx = await createContext();
    const evaluator = new ReviewEvaluator();
    const candidate = {
      id: '1ef907b7-6c12-4ead-8f9a-c97bd31e83f3',
      learnerId: ctx.learnerId,
      kind: 'pronunciation' as const,
      exerciseType: 'pronunciation_repeat' as const,
      referenceId: '1ef907b7-6c12-4ead-8f9a-c97bd31e83f4',
      prompt: 'Listen and repeat clearly: "comfortable"',
      expectedAnswer: 'comfortable',
      dueAt: NOW,
      severity: 0.5,
      status: 'active_training' as const,
      consecutiveCorrect: 0,
      reviewCount: 1,
    };
    const good = await evaluator.evaluate(candidate, 'comfortable');
    expect(['correct', 'partial']).toContain(good.result);
    expect(good.feedback).not.toMatch(/\d+\s*%/);

    const empty = await evaluator.evaluate(candidate, '');
    expect(empty.result).toBe('incorrect');
    expect(empty.feedback).toMatch(/insufficient evidence/i);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary & Progress integration (scenarios 22–23)
// ---------------------------------------------------------------------------
describe('Vocabulary & Progress integration', () => {
  it('22. links evidence to a saved word without duplicating vocabulary rows', async () => {
    const ctx = await createContext();
    const saved = await saveVocab(ctx, 'comfortable');
    const before = await ctx.vocabulary.list(ctx.learnerId, { limit: 100 });
    expect(before).toHaveLength(1);

    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });

    const after = await ctx.vocabulary.list(ctx.learnerId, { limit: 100 });
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(saved.id);
    expect(after[0].meanings.length).toBe(saved.meanings.length);

    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(weakness.contexts.some((c) => c === `lexical:${saved.id}`)).toBe(true);

    // The workspace surfaces the linked note read-only (details view),
    // derived from the SAME weakness rows — nothing duplicated.
    const workspace = new VocabularyWorkspaceService({
      vocabulary: ctx.vocabulary,
      expressions: new SQLiteExpressionRepository(ctx.adapter),
      profile: ctx.profileRepo,
      pronunciationNotes: ctx.weaknesses,
    });
    const notes = await workspace.getPronunciationNotes({
      id: saved.id,
    } as Parameters<VocabularyWorkspaceService['getPronunciationNotes']>[0]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('comfortable');
    // Unlinked items have no notes.
    const other = await workspace.getPronunciationNotes({
      id: '1ef907b7-6c12-4ead-8f9a-c97bd31e99ff',
    } as Parameters<VocabularyWorkspaceService['getPronunciationNotes']>[0]);
    expect(other).toEqual([]);
  });

  it('23. the progress dashboard reads pronunciation state as counts only', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });

    const service = new ProgressDashboardService({
      profile: ctx.profileRepo,
      conversations: { listSessions: async () => [] } as never,
      weaknesses: ctx.weaknesses,
      vocabulary: ctx.vocabulary,
      expressions: { list: async () => [] } as never,
      review: ctx.review,
      progress: { list: async () => [] } as never,
    });
    const snapshot = await service.loadDashboard(ctx.learnerId, { now: NOW });
    const pronunciationCards = snapshot.weaknessCards.filter((c) => c.type === 'pronunciation');
    expect(pronunciationCards).toHaveLength(1);
    expect(pronunciationCards[0].status).toBe('observed');
    expect(pronunciationCards[0].occurrenceCount).toBe(1);
    const serialized = JSON.stringify(snapshot.weaknessCards);
    expect(serialized).not.toMatch(/"(pronunciationScore|speakingScore|accuracy)"/);
  });
});
// ---------------------------------------------------------------------------
// Integrity fixes: review history preservation, evidence persistence,
// exact lifecycle lookup (post-Phase-1 hardening)
// ---------------------------------------------------------------------------
describe('Review history preservation (integrity)', () => {
  it('A. re-observing a practiced issue preserves the full review history and schedule', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));

    // First observation → creates the initial review item.
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });
    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    const created = await ctx.review.getByReference(ctx.learnerId, 'pronunciation', weakness.id);
    expect(created).not.toBeNull();

    // Practice it once: reviewCount/history/lastReviewAt update, dueAt moves to the future.
    const practiced = await ctx.review.markReviewed(created!.id, 'correct', 'nice attempt');
    expect(practiced.reviewCount).toBe(1);
    expect(practiced.outcomeHistory).toHaveLength(1);
    expect(practiced.lastReviewAt).toBe(NOW);
    expect(new Date(practiced.dueAt).getTime()).toBeGreaterThan(new Date(NOW).getTime());
    const snapshot = practiced;

    // The SAME pronunciation issue is observed again (future-scheduled item!).
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T13:00:00.000Z',
    });

    const afterRepeat = await ctx.review.get(created!.id);
    expect(afterRepeat).not.toBeNull();
    expect(afterRepeat!.reviewCount).toBe(snapshot.reviewCount); // unchanged (1)
    expect(afterRepeat!.outcomeHistory).toEqual(snapshot.outcomeHistory); // unchanged
    expect(afterRepeat!.lastReviewAt).toBe(snapshot.lastReviewAt); // unchanged
    expect(afterRepeat!.dueAt).toBe(snapshot.dueAt); // future schedule preserved
    expect(afterRepeat!.consecutiveCorrect).toBe(snapshot.consecutiveCorrect);

    // And still exactly ONE review row for this issue.
    const all = await ctx.review.list(ctx.learnerId, 100);
    expect(all.filter((r) => r.kind === 'pronunciation')).toHaveLength(1);
  });

  it('B. the first observation creates the initial review item', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });
    const all = await ctx.review.list(ctx.learnerId, 100);
    const pronunciationItems = all.filter((r) => r.kind === 'pronunciation');
    expect(pronunciationItems).toHaveLength(1);
    expect(pronunciationItems[0].reviewCount).toBe(0);
    expect(pronunciationItems[0].outcomeHistory).toEqual([]);
  });

  it('C. repeated observations never create duplicate review rows', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    const input = { transcript: 'comf-ta-ble', expectedText: 'comfortable' };
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T10:00:00.000Z' });
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T11:00:00.000Z' });
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T12:00:00.000Z' });

    const all = await ctx.review.list(ctx.learnerId, 100);
    expect(all.filter((r) => r.kind === 'pronunciation')).toHaveLength(1);
  });
});

describe('Evidence source persistence (integrity)', () => {
  it('keeps stt_substitution evidence after repository reload', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, createTranscriptComparisonPronunciationProvider());
    await engine.analyzeSpokenTurn({
      transcript: 'I walk to school yesterday',
      expectedText: 'I walked to school yesterday',
      now: NOW,
    });

    const reloaded = new SQLitePronunciationRepository(ctx.adapter);
    const rows = await reloaded.listWeaknesses(ctx.learnerId, { limit: 50 });
    const endingRow = rows.find((r) => r.targetSound.startsWith('ending:'));
    expect(endingRow).toBeDefined();
    expect(endingRow!.evidenceLog).toHaveLength(1);
    expect(endingRow!.evidenceLog![0].source).toBe('stt_substitution');
    expect(endingRow!.evidenceLog![0].at).toBe(NOW);
  });

  it('keeps transcript_comparison evidence for unrecognized targets', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, createTranscriptComparisonPronunciationProvider());
    await engine.analyzeSpokenTurn({
      transcript: 'florbidax',
      expectedText: 'comfortable',
      now: NOW,
    });

    const reloaded = new SQLitePronunciationRepository(ctx.adapter);
    const rows = await reloaded.listWeaknesses(ctx.learnerId, { limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0].evidenceLog![0].source).toBe('transcript_comparison');
    expect(rows[0].evidenceLog![0].confidence).toBe('low');
  });

  it('appends evidence per occurrence (never resets it)', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    const input = { transcript: 'comf-ta-ble', expectedText: 'comfortable' };
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T10:00:00.000Z' });
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T11:00:00.000Z' });

    const reloaded = new SQLitePronunciationRepository(ctx.adapter);
    const rows = await reloaded.listWeaknesses(ctx.learnerId, { limit: 50 });
    expect(rows[0].evidenceLog).toHaveLength(2);
    expect(rows[0].evidenceLog![0].source).toBe('stt_substitution');
    expect(rows[0].evidenceLog![0].confidence).toBe('medium');
    expect(rows[0].evidenceLog![1].at).toBe('2026-09-17T11:00:00.000Z');
  });

  it('ai_explanation_only is never persisted as pronunciation evidence', async () => {
    const ctx = await createContext();
    const engine = createEngine(
      ctx,
      fakeProvider({
        observations: [
          {
            type: 'vowel',
            target: 'comfortable',
            description: 'AI explains the /ʌ/ vowel — explanation only, nothing heard.',
            evidence: 'ai_explanation_only',
            confidence: 'high',
          },
        ],
      }),
    );
    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });
    // Feedback may still be informational, but NOTHING is persisted.
    const pronRows = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 50 });
    const weakRows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(pronRows).toHaveLength(0);
    expect(weakRows).toHaveLength(0);
    expect(outcome).not.toBeNull();
  });
});

describe('Exact weakness lookup (integrity)', () => {
  it('finds the pronunciation weakness beyond the 100-row list cap and preserves lifecycle', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));

    // First observation → weakness created (status observed).
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T10:00:00.000Z',
    });
    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(weakness.status).toBe('observed');

    // Flood with 120 UNRELATED grammar weaknesses (newer than the target).
    for (let i = 0; i < 120; i += 1) {
      await ctx.weaknesses.upsertWeakness({
        learnerId: ctx.learnerId,
        type: 'grammar',
        referenceId: `1ef907b7-6c12-4ead-8f9a-c97bd3${String(i).padStart(5, '0')}`,
        status: 'observed',
        severity: 0.3,
        occurrenceCount: 1,
        lastSeenAt: NOW,
        firstSeenAt: NOW,
        contexts: [],
        evidence: [],
        resolved: false,
      });
    }

    // The capped list no longer contains the pronunciation weakness…
    const capped = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(capped.filter((w) => w.type === 'pronunciation')).toHaveLength(0);

    // …but the EXACT lookup still finds it.
    const exact = await ctx.weaknesses.getWeaknessByReference(
      ctx.learnerId,
      'pronunciation',
      weakness.referenceId,
    );
    expect(exact).not.toBeNull();
    expect(exact!.id).toBe(weakness.id);
    expect(exact!.status).toBe('observed');

    // Re-observing advances the lifecycle (observed → repeated) — NOT reset.
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T12:00:00.000Z',
    });
    const after = await ctx.weaknesses.getWeaknessByReference(
      ctx.learnerId,
      'pronunciation',
      weakness.referenceId,
    );
    expect(after!.status).toBe('repeated');
    expect(after!.occurrenceCount).toBe(2);

    // And no duplicate learner-weakness row was created.
    const all = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 500);
    expect(all.filter((w) => w.type === 'pronunciation')).toHaveLength(1);
  });

  it('never regresses relapsed → observed (relapsed stays active)', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T10:00:00.000Z',
    });
    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    await ctx.weaknesses.upsertWeakness({ ...weakness, status: 'relapsed' });

    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T12:00:00.000Z',
    });
    const after = await ctx.weaknesses.getWeaknessByReference(
      ctx.learnerId,
      'pronunciation',
      weakness.referenceId,
    );
    expect(after!.status).toBe('relapsed');
    expect(after!.resolved).toBe(false);
  });

  it('confirmed stays confirmed on further observation (no regression)', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));
    const input = { transcript: 'comf-ta-ble', expectedText: 'comfortable' };
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T10:00:00.000Z' });
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T11:00:00.000Z' });
    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T12:00:00.000Z' });
    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    expect(weakness.status).toBe('confirmed');

    await engine.analyzeSpokenTurn({ ...input, now: '2026-09-17T13:00:00.000Z' });
    const after = await ctx.weaknesses.getWeaknessByReference(
      ctx.learnerId,
      'pronunciation',
      weakness.referenceId,
    );
    expect(after!.status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// Retired-review edge case (final integrity fix): a retired pronunciation
// review still counts as existing — re-observing the issue must never
// recreate or reset it.
// ---------------------------------------------------------------------------
describe('Retired review history preservation (integrity)', () => {
  it('2. getByReference finds an existing pronunciation review even if retired', async () => {
    const ctx = await createContext();
    const referenceId = '1ef907b7-6c12-4ead-8f9a-c97bd31e00aa';
    await ctx.review.upsert({
      learnerId: ctx.learnerId,
      kind: 'pronunciation',
      referenceId,
      prompt: 'Listen and repeat clearly: "comfortable"',
      expectedResponse: 'comfortable',
      state: 'retired',
      dueAt: NOW,
      reviewCount: 4,
      consecutiveCorrect: 3,
      lastReviewAt: NOW,
      outcomeHistory: [
        { at: NOW, result: 'correct', note: 'practice 1' },
        { at: NOW, result: 'correct', note: 'practice 2' },
      ],
    });

    const found = await ctx.review.getByReference(ctx.learnerId, 'pronunciation', referenceId);
    expect(found).not.toBeNull();
    expect(found!.state).toBe('retired');
    expect(found!.reviewCount).toBe(4);
  });

  it('1. re-observing an issue with a retired review preserves all history (no reset, no duplicate)', async () => {
    const ctx = await createContext();
    const engine = createEngine(ctx, fakeProvider({ observations: [wordObservation()] }));

    // Create the pronunciation review through the normal flow and practice it twice.
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });
    const [weakness] = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 100);
    const created = await ctx.review.getByReference(ctx.learnerId, 'pronunciation', weakness.id);
    expect(created).not.toBeNull();

    await ctx.review.markReviewed(created!.id, 'correct', 'first try');
    await ctx.review.markReviewed(created!.id, 'correct', 'second try');

    // Retire it (as the Review system does when an item leaves rotation).
    const practiced = await ctx.review.get(created!.id);
    expect(practiced!.reviewCount).toBe(2);
    const retired = await ctx.review.upsert({
      learnerId: practiced!.learnerId,
      kind: practiced!.kind,
      referenceId: practiced!.referenceId,
      prompt: practiced!.prompt,
      expectedResponse: practiced!.expectedResponse,
      contextTopic: practiced!.contextTopic,
      state: 'retired',
      dueAt: practiced!.dueAt,
      lastReviewAt: practiced!.lastReviewAt,
      reviewCount: practiced!.reviewCount,
      consecutiveCorrect: practiced!.consecutiveCorrect,
      outcomeHistory: practiced!.outcomeHistory,
      id: practiced!.id,
    });
    expect(retired.state).toBe('retired');

    // Snapshot of the complete retired history.
    const beforeRetiredRow = await ctx.review.get(created!.id);
    const historySnapshot = beforeRetiredRow!.outcomeHistory;

    // The SAME pronunciation issue is observed again.
    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: '2026-09-17T13:00:00.000Z',
    });

    // Same single row, fully preserved.
    const after = await ctx.review.getByReference(ctx.learnerId, 'pronunciation', weakness.id);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(created!.id);
    expect(after!.state).toBe('retired');
    expect(after!.reviewCount).toBe(2); // preserved
    expect(after!.consecutiveCorrect).toBe(beforeRetiredRow!.consecutiveCorrect); // preserved
    expect(after!.outcomeHistory).toEqual(historySnapshot); // preserved
    expect(after!.lastReviewAt).toBe(beforeRetiredRow!.lastReviewAt); // preserved
    expect(after!.dueAt).toBe(beforeRetiredRow!.dueAt); // preserved

    const all = await ctx.review.list(ctx.learnerId, 100);
    expect(all.filter((r) => r.kind === 'pronunciation')).toHaveLength(1); // no duplicate

    // The weakness lifecycle still advances (observed → repeated) even though
    // the review item is left untouched.
    const weaknessAfter = await ctx.weaknesses.getWeaknessByReference(
      ctx.learnerId,
      'pronunciation',
      weakness.referenceId,
    );
    expect(weaknessAfter!.status).toBe('repeated');
    expect(weaknessAfter!.occurrenceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// WP-4 evidence integrity — Blocker 4: pronunciation success can NEVER be
// inferred from the absence of negative observations. The engine only writes
// strength when the EXISTING provider contract reports an explicit positive
// signal (`overallIntelligibility: 'clear'`) from a supported evidence source.
// ---------------------------------------------------------------------------
describe('WP-4 pronunciation success evidence integrity (Blocker 4)', () => {
  function engineWithRecorder(ctx: TestContext, provider: PronunciationProvider): PronunciationEngine {
    return createEngine(ctx, provider, {
      successRecorder: createSuccessObservationRecorder(ctx.weaknesses),
    });
  }

  it('zero negative observations alone => NO strength (absence of a weakness is not evidence)', async () => {
    const ctx = await createContext();
    // A provider that reports no problems but asserts NO positive signal.
    const engine = engineWithRecorder(ctx, fakeProvider({ observations: [] }));

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      now: NOW,
    });

    expect(outcome).not.toBeNull();
    expect(outcome!.analysis.observations).toHaveLength(0);
    expect(outcome!.analysis.insufficientEvidence).toBeFalsy();
    // No explicit positive signal exists in this result.
    expect(outcome!.analysis.overallIntelligibility).toBeUndefined();

    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    // …and no weakness is fabricated either.
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);

    // 'partially_clear' / 'unclear' are equally not positive success evidence.
    for (const intelligibility of ['partially_clear', 'unclear'] as const) {
      const other = await createContext();
      const otherEngine = engineWithRecorder(
        other,
        fakeProvider({ observations: [], overallIntelligibility: intelligibility }),
      );
      await otherEngine.analyzeSpokenTurn({
        transcript: 'I feel comfortable here',
        expectedText: 'I feel comfortable here',
        now: NOW,
      });
      expect(await other.weaknesses.listStrengths(other.learnerId)).toHaveLength(0);
    }
  });

  it('insufficient evidence => NO strength', async () => {
    const ctx = await createContext();
    // The REAL baseline provider with no expected target: it honestly reports
    // insufficient evidence instead of inventing a judgement.
    const engine = engineWithRecorder(ctx, createTranscriptComparisonPronunciationProvider());

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'hello how are you',
      now: NOW,
    });
    expect(outcome!.analysis.insufficientEvidence).toBe(true);
    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);

    // An explicit provider claim of insufficient evidence is refused as well.
    const explicit = await createContext();
    const explicitEngine = engineWithRecorder(
      explicit,
      fakeProvider({
        observations: [],
        overallIntelligibility: 'clear',
        insufficientEvidence: true,
      }),
    );
    await explicitEngine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      now: NOW,
    });
    expect(await explicit.weaknesses.listStrengths(explicit.learnerId)).toHaveLength(0);
  });

  it('provider failure => NO strength', async () => {
    const ctx = await createContext();
    const engine = engineWithRecorder(
      ctx,
      fakeProvider(() => {
        throw new Error('provider exploded');
      }),
    );

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      now: NOW,
    });
    expect(outcome!.unavailable).toBe(true);
    expect(outcome!.analysis.insufficientEvidence).toBe(true);

    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
  });

  it('an EXPLICIT supported positive signal => strength (the only accepted path)', async () => {
    const ctx = await createContext();
    const engine = engineWithRecorder(
      ctx,
      fakeProvider({
        observations: [],
        overallIntelligibility: 'clear',
        evidenceLevel: 'transcript_comparison',
      }),
    );

    await engine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      context: 'shadowing',
      now: NOW,
    });

    const strengths = await ctx.weaknesses.listStrengths(ctx.learnerId);
    expect(strengths).toHaveLength(1);
    expect(strengths[0].learnerId).toBe(ctx.learnerId);
    expect(strengths[0].type).toBe('pronunciation');
    expect(strengths[0].referenceId).toBe('pron:i feel comfortable here');
    await expect(
      ctx.weaknesses.listWeaknesses(ctx.learnerId, 20),
    ).resolves.toHaveLength(0);
  });

  it('the REAL baseline provider produces that signal only on an exact match (production path)', async () => {
    const ctx = await createContext();
    const engine = engineWithRecorder(ctx, createTranscriptComparisonPronunciationProvider());

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      now: NOW,
    });
    expect(outcome!.analysis.overallIntelligibility).toBe('clear');
    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(1);

    // A mismatching repeat is judged as a problem and NEVER as strength.
    const other = await createContext();
    const otherEngine = engineWithRecorder(
      other,
      createTranscriptComparisonPronunciationProvider(),
    );
    await otherEngine.analyzeSpokenTurn({
      transcript: 'I walk to school yesterday',
      expectedText: 'I walked to school yesterday',
      now: NOW,
    });
    expect(await other.weaknesses.listStrengths(other.learnerId)).toHaveLength(0);
    expect(
      (await other.weaknesses.listWeaknesses(other.learnerId, 20)).length,
    ).toBeGreaterThan(0);
  });

  it('inference-only evidence can never ground a success claim', async () => {
    const ctx = await createContext();
    const engine = engineWithRecorder(
      ctx,
      fakeProvider({
        evidenceLevel: 'ai_explanation_only',
        overallIntelligibility: 'clear',
        observations: [
          {
            type: 'vowel',
            description: 'The tutor explained that vowels should be longer here.',
            evidence: 'ai_explanation_only',
            inferenceOnly: true,
          },
        ],
      }),
    );

    await engine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      now: NOW,
    });

    // No strength from an explanation-only result.
    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    // Inference-only observations are still never persisted as weaknesses.
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
  });

  it('an issued observation is never replaced by a strength claim', async () => {
    const ctx = await createContext();
    const engine = engineWithRecorder(
      ctx,
      fakeProvider({
        observations: [wordObservation('comfortable')],
        overallIntelligibility: 'clear',
      }),
    );

    await engine.analyzeSpokenTurn({
      transcript: 'comf-ta-ble',
      expectedText: 'comfortable',
      now: NOW,
    });

    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    expect(await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 20 })).toHaveLength(1);
  });
});
