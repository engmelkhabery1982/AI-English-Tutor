/**
 * src/deep-speaking/index.test.ts
 *
 * Deep Speaking Practice / Speaking Coach (Phase 1) tests.
 *
 * Strategy:
 * - The planner is tested as the PURE function it is (synthetic coaching
 *   snapshots) so bounds, priority, determinism, honesty and "no I/O" are
 *   pinned exactly.
 * - The service is tested through the REAL ConversationEngine,
 *   ConversationOrchestrator and ConversationSession with injected fake AI
 *   providers and injected memory/learning/persistence ports. No network, no
 *   Gemini, no microphone, no database.
 * - Structural checks pin the screen, navigation and the adaptive-lesson entry
 *   to the EXISTING systems (no second engine/session/voice/memory, no SQLite
 *   in screens, no score vocabulary).
 *
 * All previously existing suites keep passing in the same run.
 */

import { describe, it, expect, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import type {
  AIProvider,
  AIProviderResult,
  ConversationFeedback,
} from '../providers/ai';
import type { ConversationRequest } from '../conversation-engine';
import { createConversationEngine } from '../conversation-engine';
import type { ConversationSession } from '../conversation-session';
import type {
  CoachingActiveWeakness,
  CoachingContext,
  CoachingExpressionFocus,
  CoachingRecentConversation,
  CoachingVocabularyFocus,
  LearnerModel,
} from '../learner-model';
import type {
  ConversationMemoryService,
  FinalizeConversationResult,
} from '../talk-demo/conversation-memory';
import type { LearningPersistenceService } from '../talk-demo/learning-persistence';
import type { ProgressRecord } from '../domain/models/learning';

import {
  HARD_MAX_TURNS,
  MAX_RECENT_CONVERSATIONS,
  MAX_TARGET_EXPRESSIONS,
  MAX_TARGET_TURNS,
  MAX_WEAKNESS_TARGETS,
  MIN_TARGET_TURNS,
  planSpeakingPractice,
} from './planner';
import {
  TURN_GOAL_INSTRUCTIONS,
  buildSpeakingCoachingPrompt,
  defaultCoachingModeForType,
  isShortAnswer,
  practiceTypeForGoal,
  shouldReformulate,
} from './prompts';
import {
  SpeakingPracticeService,
  type SpeakingProgressPort,
} from './service';
import { createSpeakingService } from './index';
import type { SpeakingPracticePlan, SpeakingPracticeType } from './types';

const NOW = '2026-02-01T10:00:00.000Z';
const LEARNER_ID = '11111111-1111-4111-8111-111111111111';

const ALL_PRACTICE_TYPES: readonly SpeakingPracticeType[] = [
  'free_conversation',
  'guided_topic',
  'role_play',
  'explain_and_expand',
  'opinion_and_reasoning',
  'problem_solution',
  'retell_or_summarize',
  'reformulation',
  'target_expression_practice',
  'weakness_retraining',
];

/* ------------------------------------------------------------------ *
 * Synthetic learner state
 * ------------------------------------------------------------------ */

function makeCoaching(overrides: Partial<CoachingContext> = {}): CoachingContext {
  const base: CoachingContext = {
    profile: {
      learnerId: LEARNER_ID,
      displayName: 'Test Learner',
      currentLevel: 'B1',
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
  return { ...base, ...overrides };
}

function makeWeakness(
  partial: Partial<CoachingActiveWeakness> & { id: string; status: CoachingActiveWeakness['status'] },
): CoachingActiveWeakness {
  return {
    type: 'grammar',
    referenceId: `ref-${partial.id}`,
    severity: 0.5,
    occurrenceCount: 2,
    contexts: [`context of ${partial.id}`],
    ...partial,
  };
}

function makeExpressionFocus(
  partial: Partial<CoachingExpressionFocus> & { itemId: string; expression: string },
): CoachingExpressionFocus {
  return {
    type: 'common_expression',
    meaningDefinition: 'a stored meaning',
    reviewState: 'learning',
    nextReviewAt: null,
    ...partial,
  };
}

function makeVocabularyFocus(
  partial: Partial<CoachingVocabularyFocus> & { itemId: string; headword: string },
): CoachingVocabularyFocus {
  return {
    type: 'word',
    meaningDefinition: 'a stored vocabulary meaning',
    reviewState: 'learning',
    nextReviewAt: null,
    ...partial,
  };
}

function makeRecentConversation(index: number): CoachingRecentConversation {
  return {
    sessionId: `session-${index}`,
    mode: 'coach',
    topic: `topic ${index}`,
    startedAt: NOW,
    endedAt: NOW,
    turnCount: index + 1,
  };
}

/* ------------------------------------------------------------------ *
 * Fake learner model / provider / ports
 * ------------------------------------------------------------------ */

function createLearnerModelStub(coaching: CoachingContext): {
  readonly model: LearnerModel;
  readonly refreshSpy: ReturnType<typeof vi.fn>;
  readonly getCoachingContextSpy: ReturnType<typeof vi.fn>;
} {
  const refreshSpy = vi.fn(async () => undefined);
  const getCoachingContextSpy = vi.fn(() => coaching);
  const model = {
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
    refresh: refreshSpy,
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
    getCoachingContext: getCoachingContextSpy,
  } as unknown as LearnerModel;
  return { model, refreshSpy, getCoachingContextSpy };
}

interface FakeProvider {
  readonly provider: AIProvider;
  readonly requests: ConversationRequest[];
}

function createFakeProvider(
  responder: (request: ConversationRequest, callIndex: number) => AIProviderResult,
): FakeProvider {
  const requests: ConversationRequest[] = [];
  const generate = vi.fn(async (request: ConversationRequest) => {
    const callIndex = requests.length;
    requests.push(request);
    return responder(request, callIndex);
  });
  return {
    provider: { id: 'fake-ai', generate } as unknown as AIProvider,
    requests,
  };
}

function okResponse(content: string, feedback?: ConversationFeedback | null): AIProviderResult {
  return { ok: true, response: { content, feedback: feedback ?? null } };
}

function failedResponse(message = 'The assistant is unavailable right now.'): AIProviderResult {
  return { ok: false, error: { code: 'unavailable', message, retryable: true } };
}

function createMemoryServiceHarness(): {
  readonly service: ConversationMemoryService;
  readonly finalizeSpy: ReturnType<typeof vi.fn>;
  readonly reviewEvidenceSpy: ReturnType<typeof vi.fn>;
} {
  const finalizeSpy = vi.fn(
    async (): Promise<FinalizeConversationResult> => ({
      ok: true,
      reason: 'persisted',
      domainSessionId: 'domain-session-1',
      turnCount: 1,
    }),
  );
  const reviewEvidenceSpy = vi.fn(async () => ({ weaknesses: [], dueReviews: [] }));
  const service: ConversationMemoryService = {
    finalizeConversation: finalizeSpy as unknown as ConversationMemoryService['finalizeConversation'],
    listRecentConversations: vi.fn(async () => []),
    loadReviewEvidence: reviewEvidenceSpy as unknown as ConversationMemoryService['loadReviewEvidence'],
  };
  return { service, finalizeSpy, reviewEvidenceSpy };
}

interface Harness {
  readonly service: SpeakingPracticeService;
  readonly model: LearnerModel;
  readonly coaching: CoachingContext;
  readonly refreshSpy: ReturnType<typeof vi.fn>;
  readonly recordFeedbackEvidence: ReturnType<typeof vi.fn>;
  readonly finalizeSpy: ReturnType<typeof vi.fn>;
  readonly progressRecord: ReturnType<typeof vi.fn>;
  readonly memoryService: ConversationMemoryService;
}

function createHarness(options: {
  readonly coaching?: CoachingContext;
  readonly aiProvider?: AIProvider;
  readonly disableAI?: boolean;
  readonly evidenceIsReal?: boolean;
  readonly withProgress?: boolean;
} = {}): Harness {
  const coaching = options.coaching ?? makeCoaching();
  const { model, refreshSpy } = createLearnerModelStub(coaching);
  const memory = createMemoryServiceHarness();
  const recordFeedbackEvidence = vi.fn(async () => undefined);
  const learningPersistence: LearningPersistenceService = {
    recordFeedbackEvidence:
      recordFeedbackEvidence as unknown as LearningPersistenceService['recordFeedbackEvidence'],
  };
  const progressRecord = vi.fn(async (record: Omit<ProgressRecord, 'id'>) => ({
    id: 'progress-1',
    ...record,
  }));
  const progress: SpeakingProgressPort = {
    record: progressRecord as unknown as SpeakingProgressPort['record'],
  };

  // The class takes the full dependency set: memory, learning persistence and
  // the clock are injected so no SQLite/network/Expo module is ever touched.
  const service = new SpeakingPracticeService({
    learnerModel: model,
    ...(options.aiProvider ? { aiProvider: options.aiProvider } : {}),
    ...(options.disableAI ? { disableAI: true } : {}),
    ...(options.evidenceIsReal === false ? { evidenceIsReal: false } : {}),
    memoryService: memory.service,
    learningPersistence,
    ...(options.withProgress === false ? {} : { progress }),
    now: () => NOW,
  });

  return {
    service,
    model,
    coaching,
    refreshSpy,
    recordFeedbackEvidence,
    finalizeSpy: memory.finalizeSpy,
    progressRecord,
    memoryService: memory.service,
  };
}

async function startHarnessSession(harness: Harness, plan?: SpeakingPracticePlan) {
  const resolved =
    plan ??
    (await (async () => {
      const result = await harness.service.planPractice({ practiceType: 'guided_topic' });
      if (result.status !== 'planned') throw new Error('plan expected');
      return result.plan;
    })());
  return harness.service.startPractice(resolved);
}

function summarizeText(plan: SpeakingPracticePlan): string {
  return [
    plan.practiceType,
    plan.topic,
    plan.sourceNote,
    plan.recentMemoryNote ?? '',
    ...plan.focusAreas.map((focus) => `${focus.area}: ${focus.detail}`),
    ...plan.targetExpressions.map((item) => `${item.headword} — ${item.meaning} — ${item.reason}`),
    ...plan.weaknessTargets.map((item) => `${item.type} — ${item.reason}`),
    ...plan.turnGoals.map((goal) => goal.instruction),
  ].join('\n');
}

/* ================================================================== *
 * Planner
 * ================================================================== */

describe('Deep Speaking planner', () => {
  it('1. builds a personalized plan from real stored evidence', () => {
    const coaching = makeCoaching({
      activeWeaknesses: [makeWeakness({ id: 'w1', status: 'confirmed', type: 'grammar' })],
      expressionFocus: [makeExpressionFocus({ itemId: 'e1', expression: 'in the long run' })],
      profile: {
        learnerId: LEARNER_ID,
        displayName: 'Test Learner',
        currentLevel: 'B1',
        targetLevel: 'B2',
        learningGoals: ['presentations at work'],
        preferredModes: ['coach'],
      },
    });
    const result = planSpeakingPractice(
      { coaching, hasProfile: true, recentConversations: [], now: NOW },
      { practiceType: 'guided_topic' },
    );
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.source).toBe('personalized');
    expect(result.plan.sourceNote).toMatch(/your own practice history/i);
    expect(result.plan.weaknessTargets.length).toBeGreaterThan(0);
    expect(result.plan.targetExpressions.length).toBeGreaterThan(0);
  });

  it('2. builds an honest general plan when there is no learner evidence', () => {
    const result = planSpeakingPractice(
      { coaching: makeCoaching(), hasProfile: true, recentConversations: [], now: NOW },
      { practiceType: 'guided_topic' },
    );
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.source).toBe('general');
    expect(result.plan.sourceNote).toMatch(/not enough stored evidence/i);
    expect(result.plan.weaknessTargets).toHaveLength(0);
    expect(result.plan.targetExpressions).toHaveLength(0);
    expect(result.plan.focusAreas).toHaveLength(0);
  });

  it('2b. never labels demo/unknown learner state as personalized', () => {
    // A demo-shaped profile (learner id + goals, no weaknesses) must degrade to
    // honest general practice: demo data is never personalization.
    const coaching = makeCoaching({
      profile: {
        learnerId: LEARNER_ID,
        displayName: 'Learner',
        currentLevel: 'B1',
        targetLevel: 'B2',
        learningGoals: ['fluency', 'natural conversation'],
        preferredModes: ['natural'],
      },
    });
    const result = planSpeakingPractice(
      {
        coaching,
        hasProfile: true,
        recentConversations: [makeRecentConversation(0)],
        now: NOW,
        evidenceIsReal: false,
      },
      { practiceType: 'free_conversation' },
    );
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.source).toBe('general');
    expect(result.plan.focusAreas).toHaveLength(0);
    expect(result.plan.targetExpressions).toHaveLength(0);
    expect(result.plan.recentMemoryNote).toBeUndefined();
  });

  it('3. reports mixed honestly: real evidence plus open general practice', () => {
    const withRecentMemory = planSpeakingPractice(
      {
        coaching: makeCoaching(),
        hasProfile: true,
        recentConversations: [makeRecentConversation(0)],
        now: NOW,
      },
      { practiceType: 'guided_topic' },
    );
    expect(withRecentMemory.status).toBe('planned');
    if (withRecentMemory.status !== 'planned') return;
    expect(withRecentMemory.plan.source).toBe('mixed');

    const openEndedWithEvidence = planSpeakingPractice(
      {
        coaching: makeCoaching({
          activeWeaknesses: [makeWeakness({ id: 'w1', status: 'observed' })],
        }),
        hasProfile: true,
        recentConversations: [],
        now: NOW,
      },
      { practiceType: 'free_conversation' },
    );
    expect(openEndedWithEvidence.status).toBe('planned');
    if (openEndedWithEvidence.status !== 'planned') return;
    expect(openEndedWithEvidence.plan.source).toBe('mixed');
    expect(openEndedWithEvidence.plan.sourceNote).toMatch(/partly built from your practice history/i);
  });

  it('4. supports every one of the ten practice types', () => {
    expect(ALL_PRACTICE_TYPES).toHaveLength(10);
    for (const practiceType of ALL_PRACTICE_TYPES) {
      const result = planSpeakingPractice(
        {
          coaching: makeCoaching({
            activeWeaknesses: [makeWeakness({ id: 'w1', status: 'confirmed' })],
            expressionFocus: [makeExpressionFocus({ itemId: 'e1', expression: 'as a rule' })],
          }),
          hasProfile: true,
          recentConversations: [],
          now: NOW,
        },
        { practiceType },
      );
      expect(result.status, practiceType).toBe('planned');
      if (result.status !== 'planned') continue;
      expect(result.plan.practiceType, practiceType).toBe(practiceType);
      expect(result.plan.scenarioPrompt.length, practiceType).toBeGreaterThan(0);
      expect(result.plan.turnGoals.length, practiceType).toBeGreaterThan(0);
    }
  });

  it('5. keeps target turns inside 6–12', () => {
    const evidenceVolumes = [0, 1, 2, 3, 5, 6, 8, 9, 12];
    for (const volume of evidenceVolumes) {
      const weaknesses = Array.from({ length: Math.min(volume, 4) }, (_, index) =>
        makeWeakness({ id: `w${index}`, status: 'confirmed' }),
      );
      const expressions = Array.from({ length: Math.min(Math.max(volume - 4, 0), 6) }, (_, index) =>
        makeExpressionFocus({ itemId: `e${index}`, expression: `expression ${index}` }),
      );
      const result = planSpeakingPractice({
        coaching: makeCoaching({ activeWeaknesses: weaknesses, expressionFocus: expressions }),
        hasProfile: true,
        recentConversations: [],
        now: NOW,
      });
      expect(result.status).toBe('planned');
      if (result.status !== 'planned') continue;
      expect(result.plan.targetTurns).toBeGreaterThanOrEqual(MIN_TARGET_TURNS);
      expect(result.plan.targetTurns).toBeLessThanOrEqual(MAX_TARGET_TURNS);
    }
  });

  it('5b. clamps caller-provided target turns into the 6–12 window', () => {
    const coaching = makeCoaching();
    const low = planSpeakingPractice(
      { coaching, hasProfile: true, recentConversations: [], now: NOW },
      { targetTurns: 1 },
    );
    const high = planSpeakingPractice(
      { coaching, hasProfile: true, recentConversations: [], now: NOW },
      { targetTurns: 99 },
    );
    expect(low.status).toBe('planned');
    expect(high.status).toBe('planned');
    if (low.status !== 'planned' || high.status !== 'planned') return;
    expect(low.plan.targetTurns).toBe(MIN_TARGET_TURNS);
    expect(high.plan.targetTurns).toBe(MAX_TARGET_TURNS);
  });

  it('6. exposes the hard maximum of 15 learner turns', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching(),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(HARD_MAX_TURNS).toBe(15);
    expect(result.plan.hardMaxTurns).toBe(15);
  });

  it('7. selects at most two weakness targets', () => {
    const weaknesses = ['relapsed', 'confirmed', 'active_training', 'repeated', 'observed'].map(
      (status, index) =>
        makeWeakness({
          id: `w${index}`,
          status: status as CoachingActiveWeakness['status'],
        }),
    );
    const result = planSpeakingPractice({
      coaching: makeCoaching({ activeWeaknesses: weaknesses }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.weaknessTargets).toHaveLength(MAX_WEAKNESS_TARGETS);
  });

  it('8. selects at most three lexical targets', () => {
    const expressions = Array.from({ length: 8 }, (_, index) =>
      makeExpressionFocus({ itemId: `e${index}`, expression: `expression ${index}` }),
    );
    const vocabulary = Array.from({ length: 8 }, (_, index) =>
      makeVocabularyFocus({ itemId: `v${index}`, headword: `word ${index}` }),
    );
    const result = planSpeakingPractice({
      coaching: makeCoaching({ expressionFocus: expressions, vocabularyFocus: vocabulary }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.targetExpressions).toHaveLength(MAX_TARGET_EXPRESSIONS);
  });

  it('9. prioritizes relapsed weaknesses', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        activeWeaknesses: [
          makeWeakness({ id: 'observed', status: 'observed', occurrenceCount: 9 }),
          makeWeakness({ id: 'relapsed', status: 'relapsed', occurrenceCount: 1 }),
          makeWeakness({ id: 'confirmed', status: 'confirmed', occurrenceCount: 5 }),
        ],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.weaknessTargets[0]?.weaknessId).toBe('relapsed');
  });

  it('10. prioritizes confirmed weaknesses over active_training/repeated/observed', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        activeWeaknesses: [
          makeWeakness({ id: 'observed', status: 'observed', occurrenceCount: 7 }),
          makeWeakness({ id: 'repeated', status: 'repeated', occurrenceCount: 7 }),
          makeWeakness({ id: 'active', status: 'active_training', occurrenceCount: 7 }),
          makeWeakness({ id: 'confirmed', status: 'confirmed', occurrenceCount: 2 }),
        ],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.weaknessTargets[0]?.weaknessId).toBe('confirmed');
    expect(result.plan.weaknessTargets[1]?.weaknessId).toBe('active');
  });

  it('11. supports active_training weaknesses (they can be targeted)', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        activeWeaknesses: [makeWeakness({ id: 'active', status: 'active_training' })],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.weaknessTargets[0]?.status).toBe('active_training');
  });

  it('12. supports repeated weaknesses (they can be targeted)', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        activeWeaknesses: [makeWeakness({ id: 'repeated', status: 'repeated' })],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.weaknessTargets[0]?.status).toBe('repeated');
  });

  it('13. excludes mastered weaknesses', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        activeWeaknesses: [
          makeWeakness({ id: 'mastered', status: 'mastered', occurrenceCount: 20 }),
        ],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.weaknessTargets).toHaveLength(0);
  });

  it('14. excludes stable weaknesses and speaking-irrelevant types', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        activeWeaknesses: [
          makeWeakness({ id: 'stable', status: 'stable' }),
          makeWeakness({ id: 'listening', status: 'confirmed', type: 'listening' }),
          makeWeakness({ id: 'pronunciation', status: 'confirmed', type: 'pronunciation' }),
        ],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.weaknessTargets).toHaveLength(0);
  });

  it('15. preserves stored meanings exactly (never invents a meaning)', () => {
    const storedMeaning = 'to decide something after thinking for a long time';
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        expressionFocus: [
          makeExpressionFocus({
            itemId: 'e1',
            expression: 'sleep on it',
            meaningDefinition: storedMeaning,
            nextReviewAt: NOW,
          }),
        ],
        vocabularyFocus: [
          makeVocabularyFocus({
            itemId: 'v1',
            headword: 'reluctant',
            meaningDefinition: 'not wanting to do something',
          }),
        ],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.targetExpressions[0]?.headword).toBe('sleep on it');
    expect(result.plan.targetExpressions[0]?.meaning).toBe(storedMeaning);
    expect(result.plan.targetExpressions.map((item) => item.meaning)).not.toContain('');
  });

  it('15b. prefers due stored expressions and never calls a non-due item "due"', () => {
    const result = planSpeakingPractice({
      coaching: makeCoaching({
        expressionFocus: [
          makeExpressionFocus({ itemId: 'later', expression: 'later item', nextReviewAt: '2099-01-01T00:00:00.000Z' }),
          makeExpressionFocus({ itemId: 'due', expression: 'due item', nextReviewAt: '2026-01-01T00:00:00.000Z' }),
        ],
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.targetExpressions[0]?.itemId).toBe('due');
    expect(result.plan.targetExpressions[0]?.reason).toMatch(/due for review/i);
    expect(result.plan.targetExpressions[1]?.reason).not.toMatch(/due/i);
  });

  it('16. lets learning goals influence the scenario', () => {
    const meetings = planSpeakingPractice({
      coaching: makeCoaching({
        profile: {
          learnerId: LEARNER_ID,
          displayName: 'Test Learner',
          currentLevel: 'B1',
          targetLevel: 'B2',
          learningGoals: ['speak confidently in meetings at work'],
          preferredModes: ['coach'],
        },
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(meetings.status).toBe('planned');
    if (meetings.status !== 'planned') return;
    expect(meetings.plan.practiceType).toBe('role_play');

    const travel = planSpeakingPractice({
      coaching: makeCoaching({
        profile: {
          learnerId: LEARNER_ID,
          displayName: 'Test Learner',
          currentLevel: 'B1',
          targetLevel: 'B2',
          learningGoals: ['travel english'],
          preferredModes: ['coach'],
        },
      }),
      hasProfile: true,
      recentConversations: [],
      now: NOW,
    });
    expect(travel.status).toBe('planned');
    if (travel.status !== 'planned') return;
    expect(travel.plan.practiceType).toBe(practiceTypeForGoal('travel english'));
  });

  it('17. lets the preferred conversation mode influence the coaching mode', () => {
    const natural = planSpeakingPractice(
      {
        coaching: makeCoaching({
          profile: {
            learnerId: LEARNER_ID,
            displayName: 'Test Learner',
            currentLevel: 'B1',
            targetLevel: 'B2',
            learningGoals: [],
            preferredModes: ['natural', 'intensive'],
          },
        }),
        hasProfile: true,
        recentConversations: [],
        now: NOW,
      },
      { practiceType: 'guided_topic' },
    );
    expect(natural.status).toBe('planned');
    if (natural.status !== 'planned') return;
    expect(natural.plan.coachingMode).toBe('natural');

    // Correction-focused types stay intensive (their purpose), regardless.
    expect(defaultCoachingModeForType('reformulation', ['natural'])).toBe('intensive');
    expect(defaultCoachingModeForType('weakness_retraining', ['natural'])).toBe('intensive');
  });

  it('18. bounds recent conversation summaries to 3 (and nothing beyond them leaks in)', () => {
    const three = Array.from({ length: 3 }, (_, index) => makeRecentConversation(index));
    const ten = [...three, ...Array.from({ length: 7 }, (_, index) => makeRecentConversation(index + 3))];
    const coaching = makeCoaching();
    const withThree = planSpeakingPractice({
      coaching,
      hasProfile: true,
      recentConversations: three,
      now: NOW,
    });
    const withTen = planSpeakingPractice({
      coaching,
      hasProfile: true,
      recentConversations: ten,
      now: NOW,
    });
    expect(withThree.status).toBe('planned');
    expect(withTen.status).toBe('planned');
    if (withThree.status !== 'planned' || withTen.status !== 'planned') return;
    expect(withTen.plan).toEqual(withThree.plan);
    const note = withTen.plan.recentMemoryNote ?? '';
    expect(note).toContain('topic 0');
    expect(note).toContain('topic 1');
    expect(note).toContain('topic 2');
    expect(note).not.toContain('topic 3');
    expect(MAX_RECENT_CONVERSATIONS).toBe(3);
  });

  it('19. is deterministic: identical input produces an identical plan', () => {
    const coaching = makeCoaching({
      activeWeaknesses: [makeWeakness({ id: 'w1', status: 'relapsed' })],
      expressionFocus: [makeExpressionFocus({ itemId: 'e1', expression: 'on the whole' })],
      recentConversations: [makeRecentConversation(0)],
    });
    const input = {
      coaching,
      hasProfile: true,
      recentConversations: [makeRecentConversation(0)],
      now: NOW,
    };
    const first = planSpeakingPractice(input, { targetTurns: 9 });
    const second = planSpeakingPractice(input, { targetTurns: 9 });
    expect(first).toEqual(second);
    if (first.status !== 'planned' || second.status !== 'planned') return;
    expect(first.plan.id).toBe(second.plan.id);
    expect(first.plan.createdAt).toBe(NOW);
  });

  it('20. performs no I/O (no clock read, no fetch, no database, no AI)', () => {
    const fetchSpy = vi.fn();
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    try {
      const result = planSpeakingPractice({
        coaching: makeCoaching({
          activeWeaknesses: [makeWeakness({ id: 'w1', status: 'confirmed' })],
        }),
        hasProfile: true,
        recentConversations: [makeRecentConversation(0)],
        now: NOW,
      });
      expect(result.status).toBe('planned');
      if (result.status !== 'planned') return;
      // The caller-supplied `now` is used as-is: the planner never reads a clock.
      expect(result.plan.createdAt).toBe(NOW);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
    }

    const source: string = readFileSync(join(__dirname, 'planner.ts'), 'utf8');
    const importLines = source
      .split('\n')
      .filter((line: string) => line.trim().startsWith('import'))
      .join('\n');
    expect(importLines).not.toMatch(/sqlite|repositories|node:fs|node:http|fetch/i);
    expect(source).not.toMatch(/Date\.now\(|new Date\(/);
  });

  /* ---------------------------------------------------------------- *
   * Follow-up behaviour helpers (pure functions)
   * ---------------------------------------------------------------- */

  it('21b. classifies short answers qualitatively (qualitative heuristic, no score)', () => {
    expect(isShortAnswer('Yes.')).toBe(true);
    expect(isShortAnswer('I like it')).toBe(true);
    expect(isShortAnswer('')).toBe(false);
    expect(
      isShortAnswer(
        'Last weekend I went hiking with two friends and we talked about our plans for the summer holidays.',
      ),
    ).toBe(false);
  });

  it('23b/24b. only real incorrect/unnatural corrections can trigger reformulation', () => {
    const incorrect: ConversationFeedback = {
      correction: { original: 'I go', improved: 'I went', explanation: 'past tense', severity: 'incorrect' },
    };
    const unnatural: ConversationFeedback = {
      correction: { original: 'very good', improved: 'excellent', explanation: 'natural phrasing', severity: 'unnatural' },
    };
    const minor: ConversationFeedback = {
      correction: { original: 'a apple', improved: 'an apple', explanation: 'article', severity: 'minor' },
    };
    expect(shouldReformulate(incorrect, true, 0)).toBe(true);
    expect(shouldReformulate(unnatural, true, 0)).toBe(true);
    expect(shouldReformulate(minor, true, 0)).toBe(false);
    expect(shouldReformulate(null, true, 0)).toBe(false);
    // Demo/offline "feedback" is not real correction evidence.
    expect(shouldReformulate(incorrect, false, 0)).toBe(false);
    // Bounded: never more than the allowed attempts.
    expect(shouldReformulate(incorrect, true, 2)).toBe(false);
  });
});

/* ================================================================== *
 * Service: turn flow, feedback ownership, limits, finalization
 * ================================================================== */

describe('Deep Speaking service', () => {
  it('21. a short answer triggers ONE focused expansion follow-up', async () => {
    const provider = createFakeProvider(() => okResponse('Interesting — tell me more.'));
    const harness = createHarness({ aiProvider: provider.provider });
    const { conversationSession } = await startHarnessSession(harness);
    await harness.service.openConversation();
    // requests[0] = the tutor opening; requests[1] = the tutor reply to 'Yes.'
    await harness.service.sendLearnerTurn('Yes.');

    const followUpPrompt = provider.requests[1]?.systemPrompt ?? '';
    expect(followUpPrompt).toContain('previous answer was short');
    expect(followUpPrompt).toContain(TURN_GOAL_INSTRUCTIONS.expand);
    // ONE follow-up: the next tutor reply is back on the planned path.
    await harness.service.sendLearnerTurn(
      'I went to the park with my brother and we stayed there until the evening.',
    );
    expect(provider.requests[2]?.systemPrompt ?? '').not.toContain(
      'previous answer was short',
    );
    // The request still comes from the EXISTING session/engine.
    expect(conversationSession.getHistory().length).toBeGreaterThan(0);
  });

  it('21c. the opening goal is consumed: the learner reply uses the plan goal for turn 1', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn(
      'I would like to talk about my daily routine and how I organise my working week.',
    );

    // The opening request carries the opening goal…
    expect(provider.requests[0]?.systemPrompt ?? '').toContain(
      TURN_GOAL_INSTRUCTIONS.open,
    );
    // …and it is REPLACED for the reply to the first learner answer: a goal that
    // is never updated would silently repeat the opening instruction forever.
    const replyPrompt = provider.requests[1]?.systemPrompt ?? '';
    expect(replyPrompt).not.toContain(TURN_GOAL_INSTRUCTIONS.open);
    expect(replyPrompt).toContain(TURN_GOAL_INSTRUCTIONS.follow_up);
  });

  it('22. a substantive answer follows the planned goal (no forced expansion)', async () => {
    const provider = createFakeProvider(() => okResponse('Great, and what happened next?'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn(
      'Yesterday I practised speaking with a colleague for twenty minutes about our project deadlines.',
    );

    // requests[1] is the tutor reply to the substantive answer: no expansion
    // trigger, so it uses the planned goal (never a short-answer follow-up).
    const replyPrompt = provider.requests[1]?.systemPrompt ?? '';
    expect(replyPrompt).not.toContain('previous answer was short');
    expect(replyPrompt).toContain('=== DEEP SPEAKING COACH ===');
    expect(replyPrompt.length).toBeGreaterThan(0);
  });

  it('23. an incorrect real correction may trigger reformulation', async () => {
    const provider = createFakeProvider(() =>
      okResponse('Let us try that again.', {
        correction: {
          original: 'I go there yesterday',
          improved: 'I went there yesterday',
          explanation: 'Use the past tense.',
          severity: 'incorrect',
        },
      }),
    );
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn(
      'I go to the market yesterday with my brother.',
    );

    // The correction is only known after that turn, so the reformulation
    // request rides on the FOLLOWING tutor reply (same session, same pipeline).
    await harness.service.sendLearnerTurn('Then we bought some fruit for the family.');
    const nextPrompt = provider.requests[2]?.systemPrompt ?? '';
    expect(nextPrompt).toContain('reformulate their previous answer more naturally');
    expect(nextPrompt).toContain('Do not provide the answer before they try');
    // The learner's whole previous answer is NOT copied into the system prompt.
    expect(nextPrompt).not.toContain('with my brother');
  });

  it('24. an unnatural real correction may trigger reformulation', async () => {
    const provider = createFakeProvider(() =>
      okResponse('Good idea.', {
        correction: {
          original: 'It was very good',
          improved: "It was excellent",
          explanation: 'A native speaker would use a stronger word here.',
          severity: 'unnatural',
        },
      }),
    );
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('The film was very good and I enjoyed the ending.');
    await harness.service.sendLearnerTurn('I would happily watch it again next weekend.');

    expect(provider.requests[2]?.systemPrompt ?? '').toContain(
      'reformulate their previous answer more naturally',
    );
  });

  it('25. a minor correction does not force reformulation', async () => {
    const provider = createFakeProvider(() =>
      okResponse('Thanks, noted.', {
        correction: {
          original: 'a apple',
          improved: 'an apple',
          explanation: 'Article.',
          severity: 'minor',
        },
      }),
    );
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('I ate a apple on the way to the office this morning.');
    await harness.service.sendLearnerTurn('It tasted much better than the office coffee.');

    expect(provider.requests[2]?.systemPrompt ?? '').not.toContain(
      'reformulate their previous answer more naturally',
    );
  });

  it('26. no correction does not trigger reformulation', async () => {
    const provider = createFakeProvider(() => okResponse('Nice.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn(
      'Last night I cooked dinner for my family and we watched a film together afterwards.',
    );
    await harness.service.sendLearnerTurn('It was a quiet evening and everyone enjoyed it a lot.');

    expect(provider.requests[2]?.systemPrompt ?? '').not.toContain(
      'reformulate their previous answer more naturally',
    );
  });

  it('27. refuses turn 16 (hard max 15) and reports the real count', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    for (let turn = 1; turn <= 15; turn += 1) {
      const result = await harness.service.sendLearnerTurn(
        `This is learner turn number ${turn} and it is long enough to be substantive.`,
      );
      expect(result.ok, `turn ${turn}`).toBe(true);
    }
    expect(harness.service.getProgress().learnerTurns).toBe(15);
    await expect(
      harness.service.sendLearnerTurn('This turn must be refused because the session is full.'),
    ).rejects.toThrow(/maximum number of turns/i);
    expect(harness.service.getProgress().learnerTurns).toBe(15);
  });

  it('27b. refuses a duplicate (in-flight) learner turn instead of counting it twice', async () => {
    const gateControl: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
      gateControl.release = resolve;
    });
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const originalGenerate = provider.provider.generate;
    // Only the learner turn is held open (the tutor opening must complete first).
    let calls = 0;
    const slowProvider: AIProvider = {
      id: 'slow-ai',
      async generate(request) {
        calls += 1;
        if (calls > 1) await gate;
        return originalGenerate(request);
      },
    };
    const harness = createHarness({ aiProvider: slowProvider });
    await startHarnessSession(harness);
    await harness.service.openConversation();

    const first = harness.service.sendLearnerTurn('The first learner turn is being processed now.');
    await expect(harness.service.sendLearnerTurn('The duplicate turn.')).rejects.toThrow(
      /already being processed/i,
    );
    gateControl.release?.();
    await first;
    expect(harness.service.getProgress().learnerTurns).toBe(1);
  });

  it('28. a failed AI turn does not increment the learner turn count', async () => {
    const provider = createFakeProvider((_request, index) =>
      index === 1 ? failedResponse() : okResponse('Okay.'),
    );
    const harness = createHarness({ aiProvider: provider.provider });
    const { conversationSession } = await startHarnessSession(harness);
    await harness.service.openConversation();
    const historyBefore = conversationSession.getHistory().length;

    const failed = await harness.service.sendLearnerTurn('This turn will fail on the provider.');
    expect(failed.ok).toBe(false);
    expect(harness.service.getProgress().learnerTurns).toBe(0);
    expect(conversationSession.getHistory().length).toBe(historyBefore);
  });

  it('29. a failed AI turn creates no persistence at all', async () => {
    const provider = createFakeProvider(() => failedResponse());
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('This turn will fail on the provider.');
    expect(harness.recordFeedbackEvidence).not.toHaveBeenCalled();
    expect(harness.finalizeSpy).not.toHaveBeenCalled();
  });

  it('30. demo/offline feedback is never persisted as real learner evidence', async () => {
    // No real provider configured: the service runs the honest offline demo.
    const harness = createHarness({ disableAI: true });
    const started = await startHarnessSession(harness);
    expect(started.isRealAI).toBe(false);
    expect(started.providerKind).toBe('demo');
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('Tell me about the weather today.');

    expect(harness.recordFeedbackEvidence).not.toHaveBeenCalled();
    const summary = await harness.service.completePractice();
    expect(summary.isDemo).toBe(true);
    expect(summary.notice).toMatch(/nothing from this practice was saved/i);
    expect(harness.finalizeSpy).toHaveBeenCalledTimes(1);
  });

  it('31. real committed feedback is persisted exactly once', async () => {
    const feedback: ConversationFeedback = {
      correction: {
        original: 'I have 25 years',
        improved: 'I am 25 years old',
        explanation: 'English uses "to be" for age.',
        severity: 'incorrect',
      },
    };
    const provider = createFakeProvider((_request, index) =>
      index === 0 ? okResponse('Hello! Where do you live?') : okResponse('Thanks!', feedback),
    );
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('I have 25 years and I live in Cairo with my family.');
    expect(harness.recordFeedbackEvidence).toHaveBeenCalledTimes(1);
    expect(harness.recordFeedbackEvidence).toHaveBeenCalledWith(feedback);
  });

  it('32. repeated handling of the same feedback object cannot persist twice', async () => {
    const shared: ConversationFeedback = {
      correction: {
        original: 'He go',
        improved: 'He goes',
        explanation: 'Third person -s.',
        severity: 'incorrect',
      },
    };
    const provider = createFakeProvider(() => okResponse('Okay.', shared));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('The first learner turn with a real correction here.');
    await harness.service.sendLearnerTurn('The second learner turn with the same correction here.');
    expect(harness.recordFeedbackEvidence).toHaveBeenCalledTimes(1);
  });

  it('33. conversation memory is finalized exactly once', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('A real learner turn that will be finalized once.');
    await harness.service.completePractice();
    await harness.service.completePractice();
    await harness.service.dispose();
    expect(harness.finalizeSpy).toHaveBeenCalledTimes(1);
  });

  it('34. completePractice() is idempotent (same summary, even after dispose)', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('A real learner turn that is substantive enough here.');
    const first = await harness.service.completePractice();
    const second = await harness.service.completePractice();
    expect(second).toBe(first);
    await harness.service.dispose();
    const third = await harness.service.completePractice();
    expect(third).toBe(first);
    expect(harness.finalizeSpy).toHaveBeenCalledTimes(1);
  });

  it('35. dispose() is idempotent and never finalizes an empty session', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.dispose();
    await harness.service.dispose();
    expect(harness.finalizeSpy).not.toHaveBeenCalled();
  });

  it('36. completePractice()/dispose() racing finalizes once', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('A real learner turn recorded before the race starts.');

    const completion = harness.service.completePractice();
    const disposal = harness.service.dispose();
    const [summary] = await Promise.all([completion, disposal]);
    expect(summary.learnerTurns).toBe(1);
    expect(harness.finalizeSpy).toHaveBeenCalledTimes(1);
    expect(await harness.service.completePractice()).toBe(summary);
  });

  it('36b. no turn is accepted once completion started', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('A real learner turn before completion begins.');
    await harness.service.completePractice();
    await expect(harness.service.sendLearnerTurn('Too late.')).rejects.toThrow(/already complete/i);
  });

  it('36c. no turn is accepted after dispose/abandon', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.dispose();
    await expect(harness.service.sendLearnerTurn('Too late.')).rejects.toThrow(
      /no active speaking practice session/i,
    );
  });

  it('36d. Complete during an active turn awaits it and counts it exactly once', async () => {
    const gateControl: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
      gateControl.release = resolve;
    });
    const provider = createFakeProvider(() => okResponse('Okay, tell me more.'));
    const originalGenerate = provider.provider.generate;
    let calls = 0;
    const slowProvider: AIProvider = {
      id: 'slow-ai',
      async generate(request) {
        calls += 1;
        // The tutor opening completes first; the learner turn stays in flight.
        if (calls > 1) await gate;
        return originalGenerate(request);
      },
    };
    const harness = createHarness({ aiProvider: slowProvider });
    await startHarnessSession(harness);
    await harness.service.openConversation();

    const turn = harness.service.sendLearnerTurn('A learner turn that is still in flight.');
    const completion = harness.service.completePractice();
    gateControl.release?.();
    await turn;
    const summary = await completion;

    // The committed turn is counted once — never dropped, never doubled.
    expect(summary.learnerTurns).toBe(1);
    expect(harness.finalizeSpy).toHaveBeenCalledTimes(1);
    expect(harness.progressRecord).toHaveBeenCalledTimes(1);
    expect(await harness.service.completePractice()).toBe(summary);
  });

  it('36e. a second tutor opening is discarded, not duplicated', async () => {
    const provider = createFakeProvider(() => okResponse('Hello there!'));
    const harness = createHarness({ aiProvider: provider.provider });
    const started = await startHarnessSession(harness);
    const first = await harness.service.openConversation();
    expect(first.ok).toBe(true);
    expect(started.conversationSession.getHistory()).toHaveLength(1);

    // The EXISTING session refuses a second opening: nothing is written twice.
    const second = await harness.service.openConversation();
    expect(second.ok).toBe(false);
    expect(started.conversationSession.getHistory()).toHaveLength(1);
    expect(harness.finalizeSpy).not.toHaveBeenCalled();
  });

  it('37. the summary claims nothing from silence (no turns, no praise)', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({
      aiProvider: provider.provider,
      coaching: makeCoaching({
        activeWeaknesses: [makeWeakness({ id: 'w1', status: 'confirmed' })],
      }),
    });
    await startHarnessSession(harness);
    const summary = await harness.service.completePractice();
    expect(summary.learnerTurns).toBe(0);
    const text = summary.sections.flatMap((section) => section.items).join('\n');
    expect(summary.sections.some((section) => section.id === 'went_well')).toBe(false);
    expect(summary.sections.some((section) => section.id === 'corrections')).toBe(false);
    expect(text).not.toMatch(/perfect|flawless|no mistakes|without a correction/i);
  });

  it('38. the summary claims no pronunciation evidence it does not have', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('A real learner turn with no pronunciation evidence at all.');
    const summary = await harness.service.completePractice();
    const text = [
      summary.notice,
      ...summary.sections.flatMap((section) => [section.title, ...section.items]),
    ].join('\n');
    expect(text).not.toMatch(/pronunciation/i);
  });

  it('39/40/41. no scores, no percentages and no fake CEFR claims anywhere', () => {
    const stripComments = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(
          (line: string) => !line.trim().startsWith('//') && !line.trim().startsWith('*'),
        )
        .join('\n');
    const moduleSources = ['types.ts', 'planner.ts', 'prompts.ts', 'service.ts', 'index.ts']
      .map((file) => stripComments(readFileSync(join(__dirname, file), 'utf8')))
      .join('\n');
    // No score field, no gamification and no percentage can be produced.
    expect(moduleSources).not.toMatch(/speakingScore|fluencyScore|confidenceScore|grammarScore/);
    expect(moduleSources).not.toMatch(/\bXP\b|streaks?\b|badges?\b|stars?\b/i);
    expect(moduleSources).not.toMatch(/\d+\s?%/);

    const plan = planSpeakingPractice({
      coaching: makeCoaching({ activeWeaknesses: [makeWeakness({ id: 'w1', status: 'confirmed' })] }),
      hasProfile: true,
      recentConversations: [makeRecentConversation(0)],
      now: NOW,
    });
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    const text = summarizeText(plan.plan);
    expect(text).not.toMatch(/\d+(\.\d+)?\s?%/);
    expect(text).not.toMatch(/\b(score|rating|grade|band)\b/i);
    expect(text).not.toMatch(/\b(A1|A2|B1|B2|C1|C2)\b/);

    const prompt = buildSpeakingCoachingPrompt(plan.plan, plan.plan.turnGoals[0]);
    expect(prompt).not.toMatch(/\d+(\.\d+)?\s?%/);
    expect(prompt).not.toMatch(/\b(score|rating|grade|band)\b/i);
    expect(prompt).not.toMatch(/\b(A1|A2|B1|B2|C1|C2)\b/);
  });

  it('42. the EXISTING ConversationSession remains the owner of the conversation', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    const started = await startHarnessSession(harness);
    const session: ConversationSession = started.conversationSession;

    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('Hello there, this is my first real learner turn today.');

    const history = session.getHistory();
    expect(history[0]?.role).toBe('assistant'); // tutor opening
    expect(history.filter((turn) => turn.role === 'user')).toHaveLength(1);
    expect(history.filter((turn) => turn.role === 'assistant')).toHaveLength(2);
    // The service exposes the SAME session — it never mirrors history itself.
    expect(harness.service.getProgress().learnerTurns).toBe(1);
  });

  it('43. the EXISTING ConversationEngine remains the request builder (decorator augments only the system prompt)', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const coaching = makeCoaching({
      activeWeaknesses: [makeWeakness({ id: 'w1', status: 'confirmed' })],
    });
    const harness = createHarness({ aiProvider: provider.provider, coaching });
    const started = await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('This is the first learner turn of the conversation.');

    // Rebuild the request the EXISTING engine would have produced for turn 2.
    const session = started.conversationSession;
    const historyBefore = session.getHistory();
    const expected = createConversationEngine(harness.model).buildRequest({
      mode: started.session.plan.coachingMode,
      topic: started.session.plan.topic,
      history: historyBefore,
      userMessage: 'This is the second learner turn of the conversation.',
    });

    await harness.service.sendLearnerTurn('This is the second learner turn of the conversation.');
    const captured = provider.requests[2];
    expect(captured).toBeDefined();
    if (!captured) return;
    expect(captured.messages).toEqual(expected.messages);
    expect(captured.mode).toBe(expected.mode);
    expect(captured.topic).toBe(expected.topic);
    expect(captured.coachingContext).toEqual(expected.coachingContext);
    // Only the system prompt changed: the decorator augments, never replaces.
    expect(captured.systemPrompt.startsWith(expected.systemPrompt)).toBe(true);
    expect(captured.systemPrompt).toContain('=== DEEP SPEAKING COACH ===');
    expect(captured.systemPrompt.length).toBeGreaterThan(expected.systemPrompt.length);
  });

  it('44. records ONE honest progress record (real counts, no speaking score)', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('A real learner turn that should be counted once here.');
    await harness.service.sendLearnerTurn('A second real learner turn that should be counted too.');
    await harness.service.completePractice();
    await harness.service.dispose();

    expect(harness.progressRecord).toHaveBeenCalledTimes(1);
    const record = harness.progressRecord.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.sessionsCompleted).toBe(1);
    expect(record.turnsCompleted).toBe(2);
    expect(record.learnerId).toBe(LEARNER_ID);
    expect(typeof record.notes).toBe('string');
    expect(record.notes).toMatch(/speaking practice/i);
    for (const scoreField of [
      'speakingScore',
      'fluencyScore',
      'confidenceScore',
      'pronunciationScore',
      'grammarScore',
      'vocabularyScore',
      'listeningScore',
    ]) {
      expect(record[scoreField]).toBeUndefined();
    }
  });

  it('45. demo sessions never write progress', async () => {
    const harness = createHarness({ disableAI: true, withProgress: true });
    await startHarnessSession(harness);
    await harness.service.openConversation();
    await harness.service.sendLearnerTurn('Tell me about your day.');
    await harness.service.completePractice();
    expect(harness.progressRecord).not.toHaveBeenCalled();
  });

  it('46. startPractice never silently replaces a running session', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    const started = await startHarnessSession(harness);
    await harness.service.openConversation();
    await expect(harness.service.startPractice(started.session.plan)).rejects.toThrow(
      /already in progress/i,
    );
  });

  it('47. planning refreshes the persisted learner snapshot first', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    await harness.service.planPractice();
    expect(harness.refreshSpy).toHaveBeenCalledTimes(1);
  });

  it('48. refuses to plan without a profile', async () => {
    const coaching = makeCoaching({
      profile: {
        learnerId: '',
        displayName: '',
        currentLevel: 'B1',
        targetLevel: 'B2',
        learningGoals: [],
        preferredModes: [],
      },
    });
    const { model } = createLearnerModelStub(coaching);
    const service = new SpeakingPracticeService({ learnerModel: model, now: () => NOW });
    const result = await service.planPractice();
    expect(result.status).toBe('no-profile');
    expect(result.plan).toBeNull();
  });

  it('49. seeds an adaptive-lesson speaking step without changing the inline path', async () => {
    const provider = createFakeProvider(() => okResponse('Okay.'));
    const harness = createHarness({ aiProvider: provider.provider });
    const planned = await harness.service.planPractice({
      seed: {
        stepId: 'step-1',
        targetText: 'Could you walk me through your experience?',
        prompt: 'Practise the interview question.',
      },
    });
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') return;
    expect(planned.plan.practiceType).toBe('target_expression_practice');
    expect(planned.plan.topic).toBe('Could you walk me through your experience?');
    expect(planned.plan.scenarioPrompt).toBe('Practise the interview question.');
    expect(planned.plan.seedFromAdaptiveLesson).toEqual({
      stepId: 'step-1',
      targetText: 'Could you walk me through your experience?',
    });
  });

  it('50. exposes the same composition factory used by the routed screen', () => {
    const { model } = createLearnerModelStub(makeCoaching());
    const service = createSpeakingService(model, undefined, { disableAI: true });
    expect(typeof service.planPractice).toBe('function');
    expect(typeof service.completePractice).toBe('function');
    expect(typeof service.dispose).toBe('function');
  });
});

/* ================================================================== *
 * Structural integration: screen, navigation, adaptive entry
 * ================================================================== */

describe('Deep Speaking integration', () => {
  const read = (relative: string) =>
    readFileSync(join(__dirname, '..', relative), 'utf8');

  it('51. the screen and the service never touch SQLite directly', () => {
    const screen = read('screens/DeepSpeakingScreen.tsx');
    expect(screen).not.toMatch(/sqlite|SQLite|DatabaseAdapter|repositories/i);
    const service: string = readFileSync(join(__dirname, 'service.ts'), 'utf8');
    // Only TYPE-only adapter imports are allowed in the service; it must never
    // import a SQLite repository implementation or construct one.
    const valueImportSpecifiers = [...service.matchAll(/import\s+(?!type\b)([^;]*?)from\s+'([^']+)'/g)]
      .map((match) => match[2] ?? '');
    expect(valueImportSpecifiers.filter((specifier) => /sqlite/i.test(specifier))).toEqual([]);
    expect(service).not.toMatch(/new SQLite|ExpoSqliteAdapter|SqlJsAdapter/);
  });

  it('52. the screen reuses the EXISTING voice stack and never builds its own', () => {
    const screen = read('screens/DeepSpeakingScreen.tsx');
    expect(screen).toContain('createTalkVoiceCoordinator');
    expect(screen).toContain('stopRecordingAndTranscribe');
    expect(screen).not.toMatch(/new AudioRecorder|createDemoSTTProvider|MediaRecorder/);
  });

  it('53. the screen never re-implements the conversation engine/session/memory', () => {
    const screen = read('screens/DeepSpeakingScreen.tsx');
    expect(screen).not.toMatch(/createConversationEngine|createConversationSession|createConversationOrchestrator/);
    expect(screen).not.toMatch(/finalizeConversation|createConversationMemoryService/);
    // Feedback persistence is owned by the service, once, for committed turns.
    expect(screen).not.toMatch(/recordFeedbackEvidence/);
    expect(screen).not.toMatch(/createLearningPersistenceService/);
  });

  it('54. the navigator exposes a DeepSpeaking route', () => {
    const navigator = read('navigation/RootNavigator.tsx');
    expect(navigator).toContain('DeepSpeaking');
    expect(navigator).toContain('DeepSpeakingScreen');
  });

  it('55. Home offers the speaking practice entry without being redesigned', () => {
    const home = read('screens/HomeScreen.tsx');
    expect(home).toMatch(/Speaking practice/i);
    expect(home).toContain('DeepSpeaking');
  });

  it('56. the adaptive lesson keeps its inline speaking path and adds the optional entry', () => {
    const adaptive = read('screens/AdaptiveLessonScreen.tsx');
    // The existing inline speaking path is untouched…
    expect(adaptive).toContain('renderSpeakingMaterial');
    expect(adaptive).toContain('handleSubmitSpeaking');
    expect(adaptive).toContain('submitSpeakingAnswer');
    // …and the optional richer path is offered when the material is speaking.
    expect(adaptive).toMatch(/Start full speaking practice/i);
    expect(adaptive).toContain('DeepSpeaking');
  });
});
