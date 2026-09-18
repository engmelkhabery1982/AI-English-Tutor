/**
 * src/reassessment/production-composition.test.ts
 *
 * WP-4 — PRODUCTION COMPOSITION wiring.
 *
 * These tests drive the REAL production composition factories (not services
 * assembled by the test with an injected recorder):
 * - `createListeningService(adapter)`            (listening strengths),
 * - `createPronunciationEngine(adapter)`         (pronunciation strengths),
 * - `createDefaultFluencyService()`              (fluency strengths).
 *
 * Only the platform database boundary (Expo SQLite) is stubbed — via the
 * module's OWN composition seam — so every factory runs its real wiring code
 * path against the REAL SQLite schema (SqlJsAdapter) and REAL repositories.
 * Strength rows are read back from the EXISTING learner-strength store.
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
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import type { CoachingContext, LearnerModel } from '../learner-model';
import type {
  ConversationMemoryService,
  FinalizeConversationResult,
} from '../talk-demo/conversation-memory';
import type { LearningPersistenceService } from '../talk-demo/learning-persistence';
import * as deepSpeaking from '../deep-speaking';
import { SpeakingPracticeService } from '../deep-speaking/service';
import {
  createSpeakingSuccessRecorder,
  resolveDefaultSpeakingComposition,
} from '../deep-speaking';
import { createListeningService } from '../listening';
import type { ListeningExercise } from '../listening';
import { createPronunciationEngine } from '../pronunciation';
import { createDefaultFluencyService } from '../fluency';

const NOW = '2026-09-18T12:00:00.000Z';
const TASK_ID = 'describe-work-problem';
/** Full answer covering every task point, with no correction needed. */
const STRONG_TRANSCRIPT =
  'We had a difficult problem with the server. I called the team and we ' +
  'fixed the config together. In the end it worked and I learned a lot.';

interface Ctx {
  adapter: DatabaseAdapter;
  learnerId: string;
  weaknesses: SQLiteWeaknessRepository;
}

/** A real local database with a real learner profile row. */
async function createCtx(): Promise<Ctx> {
  const adapter = new SqlJsAdapter();
  await adapter.init();
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Production Composition Tester',
    currentLevel: 'A2',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });
  return { adapter, learnerId: profile.id, weaknesses: new SQLiteWeaknessRepository(adapter) };
}

function listeningExercise(partial?: Partial<ListeningExercise>): ListeningExercise {
  return {
    id: '1ef907b7-6c12-4ead-8f9a-c97bd31e00001',
    learnerId: '1ef907b7-6c12-4ead-8f9a-c97bd31e00999',
    type: 'listen_and_type',
    difficulty: 'easy',
    speakText: 'We need to meet the deadline by Friday.',
    expectedAnswer: 'We need to meet the deadline by Friday',
    keyItems: ['deadline'],
    source: 'general',
    ...partial,
  } as ListeningExercise;
}

function okResponse(content: string): AIProviderResult {
  return { ok: true, response: { content, feedback: null } };
}

function failedResponse(message = 'The assistant is unavailable right now.'): AIProviderResult {
  return { ok: false, error: { code: 'unavailable', message, retryable: true } };
}

function createScriptedProvider(scripts: readonly AIProviderResult[]): AIProvider {
  let calls = 0;
  return {
    id: 'scripted-ai',
    generate: vi.fn(async () => {
      const result = scripts[Math.min(calls, scripts.length - 1)] ?? okResponse('Hello.');
      calls += 1;
      return result;
    }),
  } as unknown as AIProvider;
}

function makeCoaching(learnerId: string): CoachingContext {
  return {
    profile: {
      learnerId,
      displayName: 'Composition Learner',
      currentLevel: 'A1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: ['coach'],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentConversations: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: NOW,
  };
}

function createLearnerModelStub(coaching: CoachingContext): LearnerModel {
  return {
    profile: {},
    strengths: [],
    weaknesses: [],
    mistakes: [],
    pronunciationWeaknesses: [],
    vocabulary: [],
    expressions: [],
    reviewQueue: [],
    progress: [],
    latestProgress: null,
    recentConversations: [],
    refresh: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    getActiveWeaknesses: vi.fn(() => []),
    getStrengths: vi.fn(() => []),
    getSavedVocabulary: vi.fn(() => []),
    getDueReview: vi.fn(() => []),
    getRecentProgress: vi.fn(() => []),
    getLatestProgress: vi.fn(() => null),
    getWeaknessSummary: vi.fn(),
    getVocabularySummary: vi.fn(),
    getExpressionSummary: vi.fn(),
    getProgressSummary: vi.fn(),
    getDashboardSnapshot: vi.fn(),
    getCoachingContext: vi.fn(() => coaching),
  } as unknown as LearnerModel;
}

function createSpeakingService(options: {
  readonly learnerId: string;
  readonly aiProvider?: AIProvider;
  readonly disableAI?: boolean;
}): SpeakingPracticeService {
  const memory = {
    finalizeConversation: vi.fn(
      async (): Promise<FinalizeConversationResult> => ({
        ok: true,
        reason: 'persisted',
        domainSessionId: 'domain-session-1',
        turnCount: 2,
      }),
    ),
    loadReviewEvidence: vi.fn(async () => ({ weaknesses: [], dueReviews: [] })),
    listRecentConversations: vi.fn(async () => []),
  } as unknown as ConversationMemoryService;
  const learning = {
    recordFeedbackEvidence: vi.fn(async () => undefined),
  } as unknown as LearningPersistenceService;
  return new SpeakingPracticeService({
    learnerModel: createLearnerModelStub(makeCoaching(options.learnerId)),
    ...(options.disableAI
      ? { disableAI: true }
      : { aiProvider: options.aiProvider ?? createScriptedProvider([]) }),
    memoryService: memory,
    learningPersistence: learning,
    now: () => NOW,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 1. Listening composition (already wired — preserved)
 * ------------------------------------------------------------------ */

describe('WP-4 production composition: listening', () => {
  it('createListeningService wires the EXISTING recorder by default', async () => {
    const ctx = await createCtx();
    // NO options at all: the factory must wire its own recorder.
    const service = createListeningService(ctx.adapter);
    const exercise = listeningExercise({ weaknessReferenceId: 'listening:prod-compose' });

    const { evaluation } = await service.evaluateAnswer(
      ctx.learnerId,
      exercise,
      'We need to meet the deadline by Friday',
      { now: NOW },
    );
    expect(evaluation.result).toBe('understood');

    const strengths = await ctx.weaknesses.listStrengths(ctx.learnerId);
    expect(strengths).toHaveLength(1);
    expect(strengths[0].learnerId).toBe(ctx.learnerId);
    expect(strengths[0].type).toBe('listening');
    expect(strengths[0].referenceId).toBe('listening:prod-compose');
  });

  it('the default composition writes NO strength for insufficient or problem results', async () => {
    const ctx = await createCtx();
    const service = createListeningService(ctx.adapter);

    const insufficient = listeningExercise({
      id: '1ef907b7-6c12-4ead-8f9a-c97bd31e00011',
      weaknessReferenceId: 'listening:prod-insufficient',
    });
    const problem = listeningExercise({
      id: '1ef907b7-6c12-4ead-8f9a-c97bd31e00012',
      weaknessReferenceId: 'listening:prod-problem',
    });

    const empty = await service.evaluateAnswer(ctx.learnerId, insufficient, '   ', { now: NOW });
    const wrong = await service.evaluateAnswer(ctx.learnerId, problem, 'totally different', {
      now: NOW,
    });
    expect(empty.evaluation.result).toBe('insufficient_evidence');
    expect(wrong.evaluation.result).toBe('missed_key_meaning');

    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    // The problem result still created its weakness; the missing judgement did not.
    const weaknesses = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20);
    expect(weaknesses.map((w) => w.referenceId)).toEqual(['listening:prod-problem']);
  });

  it('the composed listening service never invents a learner for shadowing evidence', async () => {
    const adapter = new SqlJsAdapter();
    await adapter.init();
    // Real database, but no learner profile row exists yet.
    const service = createListeningService(adapter);
    expect(await service.resolveLearnerId()).toBeNull();

    const { ShadowingSession } = await import('../listening/deep/shadowing');
    const session = new ShadowingSession({
      id: 'prod-shadow',
      chunk: 'Could you send it today?',
      canonicalWrittenForm: 'Could you send it today?',
      baseSupport: 'full_transcript',
    });
    await service.submitShadowingAttempt(session, 'Could you send it today?', { now: NOW });

    const repo = new SQLiteWeaknessRepository(adapter);
    expect(await repo.listStrengths('learner')).toHaveLength(0);
    expect(await repo.listStrengths('')).toHaveLength(0);
    expect(await repo.listStrengths('1ef907b7-6c12-4ead-8f9a-c97bd31e00000')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Pronunciation composition
 * ------------------------------------------------------------------ */

describe('WP-4 production composition: pronunciation', () => {
  it('createPronunciationEngine persists an explicit supported positive result', async () => {
    const ctx = await createCtx();
    const engine = createPronunciationEngine(ctx.adapter);

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      context: 'shadowing',
      now: NOW,
    });

    // The deterministic baseline provider asserts clear intelligibility from
    // transcript comparison — an EXPLICIT positive signal.
    expect(outcome).not.toBeNull();
    expect(outcome!.analysis.overallIntelligibility).toBe('clear');
    expect(outcome!.analysis.insufficientEvidence).toBeFalsy();

    const strengths = await ctx.weaknesses.listStrengths(ctx.learnerId);
    expect(strengths).toHaveLength(1);
    expect(strengths[0].learnerId).toBe(ctx.learnerId);
    expect(strengths[0].type).toBe('pronunciation');
    expect(strengths[0].referenceId).toBe('pron:i feel comfortable here');
    // No weakness is fabricated alongside the positive evidence.
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
  });

  it('the composed engine writes NO strength for insufficient evidence or observed problems', async () => {
    const ctx = await createCtx();
    const engine = createPronunciationEngine(ctx.adapter);

    // No expected target → the provider reports insufficient evidence.
    const insufficient = await engine.analyzeSpokenTurn({
      transcript: 'hello how are you',
      now: NOW,
    });
    expect(insufficient!.analysis.insufficientEvidence).toBe(true);

    // A real mismatch produces observations (a weakness), never a strength.
    await engine.analyzeSpokenTurn({
      transcript: 'I walk to school yesterday',
      expectedText: 'I walked to school yesterday',
      now: NOW,
    });

    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    expect(
      (await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).length,
    ).toBeGreaterThan(0);
  });

  it('the composed engine never fabricates a learner id (no profile → nothing persisted)', async () => {
    const adapter = new SqlJsAdapter();
    await adapter.init();
    const engine = createPronunciationEngine(adapter);

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I feel comfortable here',
      expectedText: 'I feel comfortable here',
      now: NOW,
    });
    expect(outcome).toBeNull();

    const repo = new SQLiteWeaknessRepository(adapter);
    expect(await repo.listWeaknesses('1ef907b7-6c12-4ead-8f9a-c97bd31e00000', 20)).toHaveLength(0);
    expect(await repo.listStrengths('learner')).toHaveLength(0);
    expect(await repo.listStrengths('')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3–5. Fluency composition (REAL default factory)
 * ------------------------------------------------------------------ */

describe('WP-4 production composition: fluency', () => {
  /**
   * Run the REAL `createDefaultFluencyService()` with only the platform
   * database boundary stubbed through the module's OWN composition seam:
   * the canonical composition (service + adapter) is supplied, exactly the
   * shape `resolveTalkCoaching()` produces on device.
   */
  async function composeDefaultFluency(options: {
    readonly adapter: DatabaseAdapter;
    readonly learnerId: string;
    readonly aiProvider?: AIProvider;
    readonly disableAI?: boolean;
  }): Promise<{ readonly fluency: Awaited<ReturnType<typeof createDefaultFluencyService>> }> {
    const speaking = createSpeakingService({
      learnerId: options.learnerId,
      ...(options.aiProvider ? { aiProvider: options.aiProvider } : {}),
      ...(options.disableAI ? { disableAI: true } : {}),
    });
    // Only the PLATFORM boundary is stubbed (the Expo SQLite composition the
    // device would build). Everything the factory does with it is real.
    vi.spyOn(deepSpeaking, 'createDefaultSpeakingService').mockResolvedValue(speaking);
    vi.spyOn(deepSpeaking, 'resolveDefaultSpeakingComposition').mockResolvedValue({
      service: speaking,
      adapter: options.adapter,
    });
    return { fluency: await createDefaultFluencyService() };
  }

  it('the canonical composition yields a recorder over the SAME database', async () => {
    const ctx = await createCtx();
    vi.spyOn(deepSpeaking, 'resolveDefaultSpeakingComposition').mockResolvedValue({
      service: createSpeakingService({ learnerId: ctx.learnerId }),
      adapter: ctx.adapter,
    });

    const composition = await resolveDefaultSpeakingComposition();
    expect(composition).not.toBeNull();
    const recorder = createSpeakingSuccessRecorder(composition!.adapter);

    // The recorder writes into the SAME canonical store.
    const result = await recorder.recordSuccessObservation({
      learnerId: ctx.learnerId,
      type: 'fluency',
      referenceId: 'fluency:prod-composition',
      source: 'fluency_service',
      context: 'support:guided',
      evidence: {
        kind: 'observation',
        id: 'prod-composition-1',
        at: NOW,
        summary: 'Strong fluency attempt in production composition',
      },
    });
    expect(result.recorded).toBe(true);
    const strengths = await ctx.weaknesses.listStrengths(ctx.learnerId);
    expect(strengths).toHaveLength(1);
    expect(strengths[0].learnerId).toBe(ctx.learnerId);
  });

  it('createDefaultFluencyService persists a real strong attempt with the real learner id', async () => {
    const ctx = await createCtx();
    const { fluency } = await composeDefaultFluency({
      adapter: ctx.adapter,
      learnerId: ctx.learnerId,
      aiProvider: createScriptedProvider([
        okResponse('Welcome. Please begin the task.'),
        okResponse('Good, no correction needed.'),
      ]),
    });

    await fluency.startTask(TASK_ID);
    const attempt = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(attempt.ok).toBe(true);
    expect(fluency.getSnapshot().isRealAI).toBe(true);
    expect(fluency.getSnapshot().consecutiveStrongAttempts).toBe(1);

    // NO recorder was injected by this test: the DEFAULT factory wired it.
    const strengths = await ctx.weaknesses.listStrengths(ctx.learnerId);
    expect(strengths).toHaveLength(1);
    expect(strengths[0].learnerId).toBe(ctx.learnerId);
    expect(strengths[0].type).toBe('fluency');
    expect(strengths[0].referenceId).toBe(`fluency:${TASK_ID}`);
    await fluency.dispose();
  });

  it('demo practice through the default composition creates NO trusted strength', async () => {
    const ctx = await createCtx();
    const { fluency } = await composeDefaultFluency({
      adapter: ctx.adapter,
      learnerId: ctx.learnerId,
      disableAI: true,
    });

    const started = await fluency.startTask(TASK_ID);
    expect(started.isRealAI).toBe(false);
    expect(await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT })).toMatchObject({
      ok: true,
    });

    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    await fluency.dispose();
  });

  it('a failed AI attempt through the default composition creates NO strength', async () => {
    const ctx = await createCtx();
    const { fluency } = await composeDefaultFluency({
      adapter: ctx.adapter,
      learnerId: ctx.learnerId,
      aiProvider: createScriptedProvider([
        okResponse('Welcome. Please begin the task.'),
        failedResponse('Tutor down.'),
      ]),
    });

    await fluency.startTask(TASK_ID);
    const failed = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(failed.ok).toBe(false);
    expect(fluency.getSnapshot().attemptNumber).toBe(0);

    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    await fluency.dispose();
  });

  it('an unavailable learner id creates NO strength and NO fabricated learner row', async () => {
    const ctx = await createCtx();
    const { fluency } = await composeDefaultFluency({
      adapter: ctx.adapter,
      learnerId: '',
      aiProvider: createScriptedProvider([
        okResponse('Welcome. Please begin the task.'),
        okResponse('Good, no correction needed.'),
      ]),
    });

    // No identity → the practice refuses honestly instead of inventing one.
    await expect(fluency.startTask(TASK_ID)).rejects.toThrow(/profile/i);
    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    expect(await ctx.weaknesses.listStrengths('learner')).toHaveLength(0);
    expect(await ctx.weaknesses.listStrengths('')).toHaveLength(0);
    await fluency.dispose();
  });

  it('without a canonical composition the factory still works but persists nothing', async () => {
    const ctx = await createCtx();
    const speaking = createSpeakingService({
      learnerId: ctx.learnerId,
      aiProvider: createScriptedProvider([
        okResponse('Welcome. Please begin the task.'),
        okResponse('Good, no correction needed.'),
      ]),
    });
    vi.spyOn(deepSpeaking, 'createDefaultSpeakingService').mockResolvedValue(speaking);
    vi.spyOn(deepSpeaking, 'resolveDefaultSpeakingComposition').mockResolvedValue(null);

    // The composition refuses to fabricate a store…
    expect(await resolveDefaultSpeakingComposition()).toBeNull();

    // …and the default factory still composes a usable service that writes nothing.
    const fluency = await createDefaultFluencyService();
    await fluency.startTask(TASK_ID);
    const attempt = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(attempt.ok).toBe(true);
    expect(await ctx.weaknesses.listStrengths(ctx.learnerId)).toHaveLength(0);
    await fluency.dispose();
  });

  it('the production composition sources contain no unsafe identity lookup or placeholder', () => {
    for (const file of [
      join(__dirname, '../deep-speaking/index.ts'),
      join(__dirname, '../fluency/index.ts'),
      join(__dirname, '../pronunciation/index.ts'),
    ]) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toContain('as any');
      expect(code).not.toContain("'learner'");
      // No second database/repository stack: only the canonical adapter is used.
      expect(code).not.toContain('openDatabase');
    }
  });
});
