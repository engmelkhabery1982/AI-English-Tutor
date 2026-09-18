/**
 * src/fluency/service.test.ts
 *
 * WP-3 FluencyPracticeService tests: task repetition, attempt commitment,
 * sustained monologue, repair completion, de-scaffolding, transfer,
 * staleness, demo honesty and evidence-ownership — through the REAL
 * SpeakingPracticeService (ConversationEngine, ConversationOrchestrator,
 * ConversationSession) with injected fake AI providers and injected
 * memory/learning ports. No network, no Gemini, no microphone, no database.
 */

import { describe, it, expect, vi } from 'vitest';

import type {
  AIProvider,
  AIProviderResult,
  ConversationFeedback,
} from '../providers/ai/types';
import type { ConversationRequest } from '../conversation-engine';
import type {
  CoachingContext,
  LearnerModel,
} from '../learner-model';
import type {
  ConversationMemoryService,
  FinalizeConversationResult,
} from '../talk-demo/conversation-memory';
import type { LearningPersistenceService } from '../talk-demo/learning-persistence';
import * as deepSpeaking from '../deep-speaking';
import { SpeakingPracticeService } from '../deep-speaking/service';

import type { CefrLevelInput } from '../domain/shared/types';
import type { FluencyPracticeService } from './service';
import {
  createFluencyPracticeService,
  practiceTypeForFluencyTask,
} from './service';
import { createDefaultFluencyService } from './index';
import { getFluencyTask } from './tasks';
import { MAX_ROUNDS_PER_TASK } from './tasks';

const NOW = '2026-09-18T10:00:00.000Z';
const LEARNER_ID = '11111111-1111-4111-8111-111111111111';

const TASK_ID = 'describe-work-problem';
const OTHER_TASK_ID = 'tell-recent-story';
const TRANSFER_SOURCE_ID = 'explain-project-delay';
const TRANSFER_TARGET_ID = 'explain-supplier-delay';
const REPAIR_TASK_ID = 'repair-giving-directions';

/** Thin answer: covers one task point, earns a correction. */
const WEAK_TRANSCRIPT = 'We had a problem at work with the server.';
/** Full answer: covers every point, reuses a target expression. */
const STRONG_TRANSCRIPT =
  'We had a difficult problem with the server. I called the team and we ' +
  'fixed the config together. In the end it worked and I learned a lot.';
/** Genuinely insufficient content (repair trigger). */
const THIN_TRANSCRIPT = 'It broke.';

/* ------------------------------------------------------------------ *
 * Harness (mirrors the deep-speaking suite: real stack, fake edges)
 * ------------------------------------------------------------------ */

function makeCoaching(level: CefrLevelInput = 'A1'): CoachingContext {
  return {
    profile: {
      learnerId: LEARNER_ID,
      displayName: 'Test Learner',
      currentLevel: level,
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
    recentConversations: coaching.recentConversations ?? [],
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

function okResponse(content: string, feedback?: ConversationFeedback | null): AIProviderResult {
  return { ok: true, response: { content, feedback: feedback ?? null } };
}

function failedResponse(message = 'The assistant is unavailable right now.'): AIProviderResult {
  return { ok: false, error: { code: 'unavailable', message, retryable: true } };
}

function correctionFeedback(
  severity: 'incorrect' | 'unnatural' | 'minor',
): ConversationFeedback {
  return {
    correction: {
      original: 'I have went',
      improved: 'I went',
      explanation: 'Use the past simple here.',
      severity,
    },
  };
}

/** Scripted fake AI provider (call N consumes script[N]; last repeats). */
function createScriptedProvider(scripts: readonly AIProviderResult[]): {
  readonly provider: AIProvider;
  readonly requests: ConversationRequest[];
} {
  const requests: ConversationRequest[] = [];
  const generate = vi.fn(async (request: ConversationRequest) => {
    const callIndex = requests.length;
    requests.push(request);
    return scripts[Math.min(callIndex, scripts.length - 1)] ?? okResponse('Hello.');
  });
  return {
    provider: { id: 'scripted-ai', generate } as unknown as AIProvider,
    requests,
  };
}

/** Manually-gated fake AI provider (for staleness tests). */
function createManualProvider(): {
  readonly provider: AIProvider;
  readonly requests: ConversationRequest[];
  readonly pendingCount: () => number;
  readonly resolveNext: (result: AIProviderResult) => void;
} {
  const requests: ConversationRequest[] = [];
  const waiters: ((result: AIProviderResult) => void)[] = [];
  const generate = vi.fn(
    async (request: ConversationRequest): Promise<AIProviderResult> =>
      new Promise<AIProviderResult>((resolve) => {
        requests.push(request);
        waiters.push(resolve);
      }),
  );
  return {
    provider: { id: 'manual-ai', generate } as unknown as AIProvider,
    requests,
    pendingCount: () => waiters.length,
    resolveNext: (result: AIProviderResult) => {
      const waiter = waiters.shift();
      if (!waiter) throw new Error('No pending AI call to resolve.');
      waiter(result);
    },
  };
}

function createMemoryHarness(): {
  readonly service: ConversationMemoryService;
  readonly finalizeSpy: ReturnType<typeof vi.fn>;
} {
  const finalizeSpy = vi.fn(
    async (): Promise<FinalizeConversationResult> => ({
      ok: true,
      reason: 'persisted',
      domainSessionId: 'domain-session-1',
      turnCount: 3,
    }),
  );
  const service = {
    finalizeConversation: finalizeSpy,
    loadReviewEvidence: vi.fn(async () => ({ weaknesses: [], dueReviews: [] })),
    listRecentConversations: vi.fn(async () => []),
  } as unknown as ConversationMemoryService;
  return { service, finalizeSpy };
}

function createLearningHarness(): {
  readonly service: LearningPersistenceService;
  readonly recordSpy: ReturnType<typeof vi.fn>;
} {
  const recordSpy = vi.fn(async () => undefined);
  return { service: { recordFeedbackEvidence: recordSpy }, recordSpy };
}

interface FluencyHarness {
  readonly fluency: FluencyPracticeService;
  readonly speaking: SpeakingPracticeService;
  readonly finalizeSpy: ReturnType<typeof vi.fn>;
  readonly recordSpy: ReturnType<typeof vi.fn>;
  readonly requests: ConversationRequest[];
}

function composeFluency(scripts: readonly AIProviderResult[]): FluencyHarness & {
  readonly scripted: ReturnType<typeof createScriptedProvider>;
} {
  const scripted = createScriptedProvider(scripts);
  const memory = createMemoryHarness();
  const learning = createLearningHarness();
  const speaking = new SpeakingPracticeService({
    learnerModel: createLearnerModelStub(makeCoaching()),
    aiProvider: scripted.provider,
    memoryService: memory.service,
    learningPersistence: learning.service,
    now: () => NOW,
  });
  const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
  return {
    fluency,
    speaking,
    finalizeSpy: memory.finalizeSpy,
    recordSpy: learning.recordSpy,
    requests: scripted.requests,
    scripted,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ------------------------------------------------------------------ *
 * Task identity & practice-type mapping
 * ------------------------------------------------------------------ */

describe('fluency task identity', () => {
  it('maps every fluency task kind onto an existing practice type', () => {
    const repetition = getFluencyTask(TASK_ID);
    const monologue = getFluencyTask(OTHER_TASK_ID);
    const repair = getFluencyTask(REPAIR_TASK_ID);
    if (!repetition || !monologue || !repair) throw new Error('catalog task missing');
    expect(practiceTypeForFluencyTask(repetition)).toBe('reformulation');
    expect(practiceTypeForFluencyTask(monologue)).toBe('explain_and_expand');
    expect(practiceTypeForFluencyTask(repair)).toBe('reformulation');
  });

  it('keeps the same speaking task identity across repetitions', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good — tell me more.', correctionFeedback('minor')),
      okResponse('Well done.'),
    ]);
    const started = await fluency.startTask(TASK_ID);
    expect(started.task.id).toBe(TASK_ID);
    expect(fluency.getSnapshot().taskId).toBe(TASK_ID);

    const first = await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('first attempt failed');
    expect(first.evidence.taskId).toBe(TASK_ID);

    const repeat = fluency.requestRepeat();
    expect(repeat.taskId).toBe(TASK_ID);
    expect(repeat.nextAttemptNumber).toBe(2);
    expect(fluency.getSnapshot().taskId).toBe(TASK_ID);

    const second = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('second attempt failed');
    expect(second.evidence.taskId).toBe(TASK_ID);
    expect(second.evidence.attemptNumber).toBe(2);

    const attempts = fluency.getAttempts();
    expect(attempts.map((attempt) => attempt.taskId)).toEqual([TASK_ID, TASK_ID]);
    expect(attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2]);
  });

  it('refuses an unknown task without changing state', async () => {
    const { fluency } = composeFluency([okResponse('Hello.')]);
    await expect(fluency.startTask('no-such-task')).rejects.toThrow();
    expect(fluency.getSnapshot().phase).toBe('ready');
    expect(fluency.getTask()).toBeNull();
    expect(fluency.getCues()).toBeNull();
  });

  it('reports an honest error when the tutor opening fails', async () => {
    const { fluency } = composeFluency([failedResponse('Opening failed.')]);
    await expect(fluency.startTask(TASK_ID)).rejects.toThrow('Opening failed.');
    const snapshot = fluency.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.attemptNumber).toBe(0);
    expect(fluency.getAttempts()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Attempt commitment (exactly-once, honest failures)
 * ------------------------------------------------------------------ */

describe('fluency attempt commitment', () => {
  it('advances the attempt count exactly once per committed attempt', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good.'),
    ]);
    await fluency.startTask(TASK_ID);
    expect(fluency.getSnapshot().attemptNumber).toBe(0);

    const result = await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(result.ok).toBe(true);
    expect(fluency.getSnapshot().attemptNumber).toBe(1);
    expect(fluency.getAttempts()).toHaveLength(1);
    expect(fluency.getPhase()).toBe('feedback');
  });

  it('refuses a concurrent double submit (one attempt at a time)', async () => {
    const memory = createMemoryHarness();
    const learning = createLearningHarness();
    const manual = createManualProvider();
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: manual.provider,
      memoryService: memory.service,
      learningPersistence: learning.service,
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });

    const starting = fluency.startTask(TASK_ID);
    await flush();
    manual.resolveNext(okResponse('Welcome. Please begin.'));
    await starting;

    const first = fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    await expect(
      fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT }),
    ).rejects.toThrow('already being processed');
    manual.resolveNext(okResponse('Good.'));
    const result = await first;
    expect(result.ok).toBe(true);
    expect(fluency.getSnapshot().attemptNumber).toBe(1);
  });

  it('failed STT (empty transcript) does not advance the attempt', async () => {
    const { fluency, requests } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good.'),
    ]);
    await fluency.startTask(TASK_ID);
    const callsBefore = requests.length;
    const result = await fluency.submitAttempt({ transcript: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('empty attempt unexpectedly ok');
    expect(result.reason).toBe('empty');
    expect(fluency.getSnapshot().attemptNumber).toBe(0);
    expect(fluency.getAttempts()).toEqual([]);
    expect(fluency.getPhase()).toBe('speaking');
    // No AI call was wasted on nothing.
    expect(requests.length).toBe(callsBefore);
  });

  it('failed AI does not fabricate a successful attempt or feedback', async () => {
    const { fluency, recordSpy } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      failedResponse('The tutor is unavailable.'),
      okResponse('Recovered.'),
    ]);
    await fluency.startTask(TASK_ID);
    const result = await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('failed attempt unexpectedly ok');
    expect(result.reason).toBe('failed');
    expect(fluency.getSnapshot().attemptNumber).toBe(0);
    expect(fluency.getAttempts()).toEqual([]);
    expect(fluency.getLastFeedback()).toBeNull();
    expect(fluency.getComparison()).toBeNull();
    expect(fluency.getSnapshot().phase).toBe('error');
    // Provider failure is not learner evidence.
    expect(recordSpy).not.toHaveBeenCalled();

    // Retry from the error phase works normally.
    const retry = await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(retry.ok).toBe(true);
    expect(fluency.getSnapshot().attemptNumber).toBe(1);
  });

  it('requires acknowledging feedback before submitting from it, but repeat reopens speaking', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good.'),
      okResponse('Again good.'),
    ]);
    await fluency.startTask(TASK_ID);
    await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(fluency.getPhase()).toBe('feedback');
    await expect(
      fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT }),
    ).rejects.toThrow();

    const prompt = fluency.requestRepeat();
    expect(prompt.nextAttemptNumber).toBe(2);
    expect(fluency.getPhase()).toBe('speaking');
    const second = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(second.ok).toBe(true);
    expect(fluency.getSnapshot().attemptNumber).toBe(2);
  });

  it('bounds repetition rounds per task', async () => {
    const scripts: AIProviderResult[] = [
      okResponse('Welcome. Please begin the task.'),
    ];
    for (let i = 0; i < MAX_ROUNDS_PER_TASK; i += 1) {
      scripts.push(okResponse(`Reply ${i}.`));
    }
    const { fluency } = composeFluency(scripts);
    await fluency.startTask(TASK_ID);
    for (let round = 1; round <= MAX_ROUNDS_PER_TASK; round += 1) {
      if (round > 1) fluency.requestRepeat();
      const result = await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
      expect(result.ok).toBe(true);
    }
    expect(fluency.getSnapshot().attemptNumber).toBe(MAX_ROUNDS_PER_TASK);
    expect(() => fluency.requestRepeat()).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Sustained monologue over the existing session architecture
 * ------------------------------------------------------------------ */

describe('fluency sustained monologue', () => {
  it('runs on the existing ConversationSession (no second session)', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Tell your story.'),
      okResponse('Nice story.'),
    ]);
    await fluency.startTask(OTHER_TASK_ID);
    const session = fluency.getConversationSession();
    expect(session).not.toBeNull();
    if (!session) throw new Error('no session exposed');
    // The EXISTING session interface — the surface the voice stack needs.
    expect(typeof session.send).toBe('function');
    expect(typeof session.openConversation).toBe('function');
    expect(typeof session.getHistory).toBe('function');
    expect(typeof session.getLastFeedback).toBe('function');
    expect(typeof session.abandon).toBe('function');
    expect(['natural', 'coach', 'intensive']).toContain(session.getConfig().mode);
  });

  it('commits exactly one conversation turn per learner monologue', async () => {
    const { fluency, requests } = composeFluency([
      okResponse('Welcome. Tell your story.'),
      okResponse('Nice story, thanks.'),
      okResponse('Even better told.'),
    ]);
    await fluency.startTask(OTHER_TASK_ID);
    const session = fluency.getConversationSession();
    if (!session) throw new Error('no session exposed');
    expect(session.getHistory()).toHaveLength(1); // the tutor opening only
    expect(requests).toHaveLength(1);

    await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    // Exactly one learner turn + one tutor reply — the tutor never fires
    // several turns for a single sustained monologue.
    expect(session.getHistory()).toHaveLength(3);
    expect(requests).toHaveLength(2);
    expect(session.getHistory().filter((turn) => turn.role === 'user')).toHaveLength(1);

    fluency.requestRepeat();
    await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(session.getHistory()).toHaveLength(5);
    expect(requests).toHaveLength(3);
    expect(session.getHistory().filter((turn) => turn.role === 'user')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Repetition comparison & de-scaffolding through the service
 * ------------------------------------------------------------------ */

describe('fluency comparison and de-scaffolding', () => {
  it('compares the second attempt from real structured evidence (no numeric claim)', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Thanks.', correctionFeedback('incorrect')),
      okResponse('Much fuller.'),
    ]);
    await fluency.startTask(TASK_ID);
    await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(fluency.getComparison()).toBeNull();
    fluency.requestRepeat();
    const second = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('second attempt failed');
    expect(second.comparison).not.toBeNull();
    const text = (second.comparison?.lines ?? []).join('\n');
    expect(text).toContain('More complete');
    expect(text).toContain('Fewer corrections');
    expect(text).not.toMatch(/\d+\s*%/);
    expect(text.toLowerCase()).not.toContain('score');
    expect(fluency.getComparison()).toEqual(second.comparison);
  });

  it('decreases support across consecutive strong attempts', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good, no correction.'),
      okResponse('Good again.'),
    ]);
    const started = await fluency.startTask(TASK_ID);
    expect(started.supportLevel).toBe('guided');
    await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    // One strong attempt is never enough.
    expect(fluency.getSnapshot().supportLevel).toBe('guided');
    fluency.requestRepeat();
    await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(fluency.getSnapshot().supportLevel).toBe('supported');
    expect(fluency.getSnapshot().consecutiveStrongAttempts).toBe(2);
    // Fewer cues are actually shown at the lower support level.
    const cues = fluency.getCues();
    expect(cues?.targetExpressions).toEqual([]);
    expect(cues?.taskOnly).toBe(false);
  });

  it('does not decrease support on a failed attempt', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good, no correction.'),
      failedResponse('Tutor down.'),
      okResponse('Good again.'),
    ]);
    await fluency.startTask(TASK_ID);
    await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    fluency.requestRepeat();
    const failed = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(failed.ok).toBe(false);
    expect(fluency.getSnapshot().supportLevel).toBe('guided');
    // A weak (corrected) attempt also holds support steady.
    const { fluency: second } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Corrected.', correctionFeedback('incorrect')),
      okResponse('Corrected again.', correctionFeedback('incorrect')),
    ]);
    await second.startTask(TASK_ID);
    await second.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    second.requestRepeat();
    await second.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(second.getSnapshot().supportLevel).toBe('guided');
    expect(second.getSnapshot().consecutiveStrongAttempts).toBe(0);
  });

  it('starts higher-level learners with less support when the level is known', async () => {
    const { fluency } = composeFluency([okResponse('Welcome.')]);
    const started = await fluency.startTask(TASK_ID, { learnerLevel: 'B2' });
    expect(started.supportLevel).toBe('supported');
    expect(fluency.getSnapshot().supportLevel).toBe('supported');
  });
});

/* ------------------------------------------------------------------ *
 * Clarification / repair attempts complete normally
 * ------------------------------------------------------------------ */

describe('fluency clarification attempts', () => {
  it('a clarification/reformulation attempt completes like any normal attempt', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome. Explain the way.'),
      okResponse('Thanks.'),
      okResponse('Clearer now.'),
    ]);
    await fluency.startTask(TASK_ID);
    const first = await fluency.submitAttempt({ transcript: THIN_TRANSCRIPT });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('first attempt failed');
    // Genuinely insufficient content triggers honest (unscripted) repair.
    expect(first.repair.allowed).toBe(true);
    expect(first.repair.scripted).toBe(false);
    expect(first.repair.prompt).not.toBeNull();

    fluency.requestRepeat();
    const second = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('repair follow-up failed');
    expect(second.evidence.attemptNumber).toBe(2);
    expect(fluency.getSnapshot().attemptNumber).toBe(2);
  });

  it('a declared repair exercise labels its deliberate clarification', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome to repair practice.'),
      okResponse('Thanks.'),
    ]);
    await fluency.startTask(REPAIR_TASK_ID);
    const first = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('repair attempt failed');
    expect(first.repair.allowed).toBe(true);
    expect(first.repair.scripted).toBe(true);
    expect(first.repair.practiceLabel).toContain('on purpose');
    expect(first.repair.prompt).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Evidence ownership (no double counting, demo honesty)
 * ------------------------------------------------------------------ */

describe('fluency evidence ownership', () => {
  it('records each genuinely new attempt once (never double-counted by comparison)', async () => {
    const firstFeedback = correctionFeedback('incorrect');
    const secondFeedback = correctionFeedback('minor');
    const { fluency, recordSpy } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Thanks.', firstFeedback),
      okResponse('Thanks again.', secondFeedback),
    ]);
    await fluency.startTask(TASK_ID);
    await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenLastCalledWith(firstFeedback);

    fluency.requestRepeat();
    // Reading the comparison and cues never persists anything.
    expect(fluency.getComparison()).toBeNull();
    fluency.getCues();
    expect(recordSpy).toHaveBeenCalledTimes(1);

    await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(recordSpy).toHaveBeenCalledTimes(2);
    expect(recordSpy).toHaveBeenLastCalledWith(secondFeedback);
    // The comparison built for the second attempt added no extra call.
    expect(fluency.getComparison()).not.toBeNull();
    expect(recordSpy).toHaveBeenCalledTimes(2);
  });

  it('creates no learner weakness when the provider fails', async () => {
    const { fluency, recordSpy } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      failedResponse('Tutor down.'),
    ]);
    await fluency.startTask(TASK_ID);
    await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('demo practice counts attempts but makes no personalized improvement claim', async () => {
    const memory = createMemoryHarness();
    const learning = createLearningHarness();
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      disableAI: true,
      memoryService: memory.service,
      learningPersistence: learning.service,
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    const started = await fluency.startTask(TASK_ID);
    expect(started.isRealAI).toBe(false);
    expect(fluency.getSnapshot().isRealAI).toBe(false);

    const first = await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('demo attempt failed');
    expect(first.feedback).toBeNull();
    expect(first.evidence.trusted).toBe(false);

    fluency.requestRepeat();
    const second = await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('demo repeat failed');
    // Attempts are counted honestly...
    expect(fluency.getSnapshot().attemptNumber).toBe(2);
    // ...but never compared evaluatively and never de-scaffolded.
    expect(second.comparison?.hasEvidence).toBe(false);
    const text = (second.comparison?.lines ?? []).join('\n');
    expect(text).toContain('Offline demo attempts are not compared');
    expect(text).not.toContain('More complete');
    expect(fluency.getSnapshot().supportLevel).toBe('guided');
    expect(learning.recordSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Staleness (New Task / Exit invalidate in-flight work)
 * ------------------------------------------------------------------ */

describe('fluency staleness', () => {
  it('a stale attempt cannot mutate the next task (New Task invalidates)', async () => {
    const memory = createMemoryHarness();
    const learning = createLearningHarness();
    const manual = createManualProvider();
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: manual.provider,
      memoryService: memory.service,
      learningPersistence: learning.service,
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });

    const starting = fluency.startTask(TASK_ID);
    await flush();
    manual.resolveNext(okResponse('Welcome to task one.'));
    await starting;

    const attempt = fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    await flush();
    expect(manual.pendingCount()).toBe(1);

    // New Task while the attempt is in flight: the old work is invalidated.
    const next = fluency.startTask(OTHER_TASK_ID);
    await flush();
    // The late AI result for the OLD attempt arrives now.
    manual.resolveNext(okResponse('Late reply for the old task.'));
    const stale = await attempt;
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('stale attempt unexpectedly committed');
    expect(stale.reason).toBe('stale');

    // The new task still needs its own opening.
    manual.resolveNext(okResponse('Welcome to task two.'));
    await next;

    const snapshot = fluency.getSnapshot();
    expect(snapshot.taskId).toBe(OTHER_TASK_ID);
    expect(snapshot.attemptNumber).toBe(0);
    expect(fluency.getAttempts()).toEqual([]);
    expect(fluency.getPhase()).toBe('speaking');
  });

  it('Exit/unmount invalidates an in-flight attempt', async () => {
    const memory = createMemoryHarness();
    const learning = createLearningHarness();
    const manual = createManualProvider();
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: manual.provider,
      memoryService: memory.service,
      learningPersistence: learning.service,
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });

    const starting = fluency.startTask(TASK_ID);
    await flush();
    manual.resolveNext(okResponse('Welcome.'));
    await starting;

    const attempt = fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    await flush();
    await fluency.dispose();
    manual.resolveNext(okResponse('Late reply after exit.'));
    const stale = await attempt;
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('post-exit attempt unexpectedly committed');
    expect(stale.reason).toBe('stale');
    expect(fluency.getAttempts()).toEqual([]);

    await expect(
      fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT }),
    ).rejects.toThrow('closed');
  });
});

/* ------------------------------------------------------------------ *
 * Transfer, completion, memory integrity
 * ------------------------------------------------------------------ */

describe('fluency transfer and completion', () => {
  it('transfers to the related context with the same target (support carried)', async () => {
    const { fluency } = composeFluency([
      okResponse('Welcome to the delay task.'),
      okResponse('Good.'),
      okResponse('Good again.'),
      okResponse('Welcome to the supplier task.'),
    ]);
    await fluency.startTask(TRANSFER_SOURCE_ID);
    // A delay-task strong answer: covers cause/impact/next-steps.
    const delayStrong =
      'The project is delayed because the supplier is late. This affects our ' +
      'delivery deadline. We will fix the schedule and I will keep you updated.';
    await fluency.submitAttempt({ transcript: delayStrong });
    fluency.requestRepeat();
    await fluency.submitAttempt({ transcript: delayStrong });
    expect(fluency.getSnapshot().supportLevel).toBe('supported');

    const transfer = await fluency.startTransfer();
    expect(transfer).not.toBeNull();
    expect(transfer?.task.id).toBe(TRANSFER_TARGET_ID);
    expect(transfer?.task.learningTarget).toBe(
      getFluencyTask(TRANSFER_SOURCE_ID)?.learningTarget,
    );
    // Attempts reset for the new identity; earned support is carried.
    expect(fluency.getSnapshot().taskId).toBe(TRANSFER_TARGET_ID);
    expect(fluency.getSnapshot().attemptNumber).toBe(0);
    expect(fluency.getSnapshot().supportLevel).toBe('supported');
  });

  it('honestly reports a task without a transfer variant', async () => {
    const { fluency } = composeFluency([okResponse('Welcome.')]);
    await fluency.startTask(TASK_ID);
    await expect(fluency.startTransfer()).resolves.toBeNull();
  });

  it('finalizes memory exactly once and keeps committed turns unduplicated', async () => {
    const { fluency, finalizeSpy } = composeFluency([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Thanks.', correctionFeedback('minor')),
      okResponse('Thanks again.'),
    ]);
    await fluency.startTask(TASK_ID);
    await fluency.submitAttempt({ transcript: WEAK_TRANSCRIPT });
    fluency.requestRepeat();
    await fluency.submitAttempt({ transcript: STRONG_TRANSCRIPT });

    const session = fluency.getConversationSession();
    if (!session) throw new Error('no session exposed');
    // Opening + 2 attempts × (learner + tutor): nothing duplicated.
    expect(session.getHistory().filter((turn) => turn.role === 'user')).toHaveLength(2);

    const summary = await fluency.complete();
    expect(summary.taskId).toBe(TASK_ID);
    expect(summary.attempts).toBe(2);
    expect(summary.supportTrajectory).toEqual(['guided', 'guided']);
    expect(summary.comparisons).toHaveLength(1);
    expect(summary.hasEvidence).toBe(true);
    expect(summary.isDemo).toBe(false);
    expect(summary.notice).toContain('Saved');
    expect(summary.underlying).not.toBeNull();
    expect(finalizeSpy).toHaveBeenCalledTimes(1);

    // Idempotent: the same summary, no second finalization.
    const again = await fluency.complete();
    expect(again).toBe(summary);
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(fluency.getPhase()).toBe('completed');
  });

  it('completes an unattempted task honestly', async () => {
    const { fluency } = composeFluency([okResponse('Welcome.')]);
    await fluency.startTask(TASK_ID);
    const summary = await fluency.complete();
    expect(summary.attempts).toBe(0);
    expect(summary.hasEvidence).toBe(false);
    expect(summary.notice).toContain('No attempts');
  });
  it('createDefaultFluencyService creates a usable fresh service after dispose (Blocker 2 regression)', async () => {
    const mockSpeaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching('A1')),
      aiProvider: createScriptedProvider([okResponse('Welcome.')]).provider,
      memoryService: createMemoryHarness().service,
      now: () => NOW,
    });
    vi.spyOn(deepSpeaking, 'createDefaultSpeakingService').mockResolvedValue(mockSpeaking);

    const service1 = await createDefaultFluencyService();
    const start1 = await service1.startTask('describe-work-problem');
    expect(start1.task.id).toBe('describe-work-problem');
    await service1.complete();
    await service1.dispose();

    await expect(service1.startTask('describe-work-problem')).rejects.toThrow('closed');

    const service2 = await createDefaultFluencyService();
    expect(service2).not.toBe(service1);
    const start2 = await service2.startTask('describe-work-problem');
    expect(start2.task.id).toBe('describe-work-problem');
    expect(service2.getSnapshot().phase).toBe('speaking');
    await service2.dispose();
  });

  it('startTask extracts real working level from Deep Speaking plan (Blocker 3)', async () => {
    const coaching = makeCoaching('B2');
    const scripted = createScriptedProvider([okResponse('Welcome.')]);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(coaching),
      aiProvider: scripted.provider,
      memoryService: createMemoryHarness().service,
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    const started = await fluency.startTask(TASK_ID);
    expect(started.supportLevel).toBe('supported');
    expect(fluency.getSnapshot().supportLevel).toBe('supported');
  });
});
