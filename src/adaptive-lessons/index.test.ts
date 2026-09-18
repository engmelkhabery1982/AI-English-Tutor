/**
 * src/adaptive-lessons/index.test.ts
 *
 * Adaptive Lessons Engine (Phase 1) tests.
 *
 * Strategy:
 * - The planner is tested as the PURE function it is (synthetic coaching
 *   snapshots) so priority, bounds, diversity, determinism and honest
 *   labeling are pinned exactly.
 * - The service is tested against the REAL SQLite repositories (SqlJsAdapter),
 *   the REAL ReviewService, the REAL ListeningService and the REAL
 *   PronunciationEngine, with injected fake AI providers — so delegation,
 *   evidence persistence, skip semantics and progress integrity are verified
 *   end to end. No network, no audio device, no real TTS.
 * - Structural checks pin the screens, the composition and the navigator to
 *   the existing systems (no demo fallback, no SQLite in screens, no new
 *   dependency, no gamification vocabulary, no new tables).
 *
 * All previously existing suites keep passing in the same run.
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
  SQLiteConversationRepository,
  SQLiteExpressionRepository,
  SQLiteMistakeRepository,
  SQLiteProgressRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { AppRepositories } from '../repositories';
import { createLearnerModel } from '../learner-model';
import type { CoachingActiveWeakness, CoachingContext } from '../learner-model';
import { ReviewService } from '../review';
import { createListeningService, stableReferenceId } from '../listening';
import type { ListeningService } from '../listening';
import { createPronunciationEngine } from '../pronunciation';
import type { PronunciationTurnOutcome } from '../pronunciation';
import type { AIProvider, AIProviderResult, ConversationFeedback } from '../providers/ai';
import type { LearnerWeakness } from '../domain/models/learner';
import type { ReviewItem } from '../domain/models/learning';
import type { WeaknessStatus } from '../domain/shared/types';

import {
  AdaptiveLessonService,
  candidateMatchesWeakness,
  describePronunciationTarget,
  describeWeaknessTarget,
  reviewPoolSizeFor,
} from './service';
import type { AdaptiveLessonModelPort } from './service';
import {
  HARD_MAX_LESSON_STEPS,
  MAX_LESSON_STEPS,
  MAX_REVIEW_FAMILY_STEPS,
  MAX_STEPS_PER_TYPE,
  MIN_LESSON_STEPS,
  planAdaptiveLesson,
} from './planner';
import { buildSpeakingPrompt, GENERAL_SPEAKING_PROMPTS } from './prompts';
import { createConversationSpeakingPort } from './speaking';
import type {
  AdaptiveLessonPlan,
  AdaptiveLessonPlanningInput,
  ReviewItemCandidate,
  AdaptiveLessonPronunciationPort,
  AdaptiveLessonSpeakingPort,
  AdaptiveLessonStep,
  AdaptiveLessonStepType,
} from './types';

const NOW = '2026-09-18T12:00:00.000Z';
const DUE_AT = '2026-09-18T09:00:00.000Z';
const FUTURE_AT = '2026-09-28T09:00:00.000Z';
const PLAN_LEARNER = '00000000-0000-4000-8000-0000000000a1';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

/* ------------------------------------------------------------------ *
 * Planner fixtures (pure)
 * ------------------------------------------------------------------ */

let idSeq = 100;
function uid(n?: number): string {
  const value = n ?? idSeq++;
  return `${String(value).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function coachingWeakness(
  partial: Partial<CoachingActiveWeakness> & {
    type: CoachingActiveWeakness['type'];
    status: WeaknessStatus;
  },
): CoachingActiveWeakness {
  return {
    id: uid(),
    referenceId: uid(),
    severity: 0.5,
    occurrenceCount: 1,
    contexts: [],
    ...partial,
  };
}

function coachingContext(partial?: Partial<CoachingContext>): CoachingContext {
  return {
    profile: {
      learnerId: PLAN_LEARNER,
      displayName: 'Adaptive Tester',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: NOW,
    ...partial,
  };
}

function planningInput(
  partial?: Partial<AdaptiveLessonPlanningInput>,
): AdaptiveLessonPlanningInput {
  return {
    coaching: coachingContext(),
    hasProfile: true,
    weaknessTargets: [],
    pronunciationTargets: [],
    dueReview: { total: 0, byKind: {} },
    now: NOW,
    ...partial,
  };
}

function practiceSteps(plan: AdaptiveLessonPlan): readonly AdaptiveLessonStep[] {
  return plan.steps.filter((step) => step.type !== 'wrap_up');
}

function stepsOfType(
  plan: AdaptiveLessonPlan,
  type: AdaptiveLessonStepType,
): readonly AdaptiveLessonStep[] {
  return plan.steps.filter((step) => step.type === type);
}

/* ------------------------------------------------------------------ *
 * Real-database fixtures
 * ------------------------------------------------------------------ */

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  repos: AppRepositories;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  expressions: SQLiteExpressionRepository;
  review: SQLiteReviewRepository;
  progress: SQLiteProgressRepository;
  pronunciation: SQLitePronunciationRepository;
  profileRepo: SQLiteUserProfileRepository;
}

async function createContext(options?: { withProfile?: boolean }): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const weaknesses = new SQLiteWeaknessRepository(adapter);
  const vocabulary = new SQLiteVocabularyRepository(adapter);
  const expressions = new SQLiteExpressionRepository(adapter);
  const review = new SQLiteReviewRepository(adapter);
  const progress = new SQLiteProgressRepository(adapter);
  const pronunciation = new SQLitePronunciationRepository(adapter);

  const repos: AppRepositories = {
    profile: profileRepo,
    conversations: new SQLiteConversationRepository(adapter),
    mistakes: new SQLiteMistakeRepository(adapter),
    pronunciation,
    weaknesses,
    vocabulary,
    expressions,
    review,
    lessons: { get: async () => null, list: async () => [] },
    exercises: { get: async () => null, list: async () => [] },
    progress,
  };

  let learnerId = '';
  if (options?.withProfile !== false) {
    const profile = await profileRepo.update({
      displayName: 'Adaptive Tester',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: ['Work meetings'],
      preferredModes: [],
    });
    learnerId = profile.id;
  }

  return { adapter, learnerId, repos, weaknesses, vocabulary, expressions, review, progress, pronunciation, profileRepo };
}

async function seedWeakness(
  ctx: TestContext,
  partial: Partial<LearnerWeakness> & {
    type: LearnerWeakness['type'];
    status: WeaknessStatus;
    referenceId: string;
  },
): Promise<LearnerWeakness> {
  return ctx.weaknesses.upsertWeakness({
    learnerId: ctx.learnerId,
    severity: 0.6,
    occurrenceCount: 2,
    lastSeenAt: NOW,
    firstSeenAt: NOW,
    contexts: [],
    evidence: [],
    resolved: false,
    ...partial,
  });
}

async function seedVocabulary(
  ctx: TestContext,
  headword: string,
  definition: string,
  nextReviewAt: string | null = DUE_AT,
) {
  return ctx.vocabulary.upsert({
    learnerId: ctx.learnerId,
    headword,
    type: 'word',
    meanings: [
      {
        definition,
        examples: [],
        ...(nextReviewAt
          ? {
              review: {
                state: 'learning' as const,
                nextReviewAt,
                reviewCount: 0,
                consecutiveCorrect: 0,
              },
            }
          : {}),
      },
    ],
    source: { addedBy: 'learner-created', addedAt: NOW },
  });
}

async function seedExpression(
  ctx: TestContext,
  expression: string,
  definition: string,
  nextReviewAt: string | null = DUE_AT,
) {
  const review = nextReviewAt
    ? {
        state: 'learning' as const,
        nextReviewAt,
        reviewCount: 0,
        consecutiveCorrect: 0,
      }
    : undefined;
  return ctx.expressions.upsert({
    learnerId: ctx.learnerId,
    expression,
    type: 'collocation',
    meanings: [{ definition, examples: [], ...(review ? { review } : {}) }],
    ...(review ? { review } : {}),
    source: { addedBy: 'learner-created', addedAt: NOW },
  });
}

async function seedReviewItem(
  ctx: TestContext,
  partial: Partial<ReviewItem> & { kind: ReviewItem['kind'] },
): Promise<ReviewItem> {
  const upsert = ctx.review.upsert;
  if (!upsert) throw new Error('review.upsert is required by this test');
  return upsert.call(ctx.review, {
    learnerId: ctx.learnerId,
    referenceId: uid(),
    prompt: 'Practice prompt',
    expectedResponse: 'deadline',
    state: 'learning',
    dueAt: DUE_AT,
    reviewCount: 0,
    consecutiveCorrect: 0,
    outcomeHistory: [],
    ...partial,
  });
}

async function seedPronunciation(
  ctx: TestContext,
  target: string,
  issue = 'word_stress',
  occurrenceCount = 2,
) {
  return ctx.pronunciation.recordWeakness({
    learnerId: ctx.learnerId,
    targetSound: `${issue}:${target}`,
    wordExamples: [target],
    occurrenceCount,
    lastSeenAt: NOW,
    firstSeenAt: NOW,
    contexts: [],
    exampleTurnIds: [],
    resolved: false,
    notes: `${issue}:${target}`,
  });
}

interface ServiceOptions {
  aiProvider?: AIProvider;
  disableAI?: boolean;
  speaking?: AdaptiveLessonSpeakingPort;
  pronunciation?: AdaptiveLessonPronunciationPort;
  speakingEvidence?: { recordFeedbackEvidence(feedback: ConversationFeedback): Promise<void> };
  review?: Pick<ReviewService, 'planSession' | 'evaluateAnswer' | 'recordPracticeResult'>;
  listening?: Pick<ListeningService, 'startSession' | 'evaluateAnswer'>;
  learnerModel?: AdaptiveLessonModelPort;
  withoutProgress?: boolean;
}

function createLessonService(ctx: TestContext, options?: ServiceOptions) {
  const learnerModel = options?.learnerModel ?? createLearnerModel(ctx.repos);
  const aiProvider = options?.disableAI ? undefined : options?.aiProvider;
  const review =
    options?.review ?? new ReviewService(ctx.repos, aiProvider);
  const listening =
    options?.listening ??
    createListeningService(ctx.adapter, aiProvider ? { aiProvider } : undefined);
  const speaking =
    options?.speaking ??
    createConversationSpeakingPort({
      learnerModel: learnerModel as ReturnType<typeof createLearnerModel>,
      ...(aiProvider ? { aiProvider } : {}),
    });
  const pronunciation = options?.pronunciation ?? createPronunciationEngine(ctx.adapter);

  return new AdaptiveLessonService({
    learnerModel,
    profile: ctx.profileRepo,
    review,
    listening,
    speaking,
    pronunciation,
    ...(options?.speakingEvidence ? { speakingEvidence: options.speakingEvidence } : {}),
    ...(options?.withoutProgress ? {} : { progress: ctx.progress }),
    now: () => NOW,
  });
}

function fakeAI(options?: {
  calls?: { count: number };
  feedback?: ConversationFeedback | null;
  fail?: boolean;
  requests?: { systemPrompt: string; userMessage: string }[];
}): AIProvider {
  return {
    id: 'fake-lesson-ai',
    generate: async (request): Promise<AIProviderResult> => {
      if (options?.calls) options.calls.count += 1;
      if (options?.requests) {
        options.requests.push({
          systemPrompt: request.systemPrompt,
          userMessage: request.messages[request.messages.length - 1]?.content ?? '',
        });
      }
      if (options?.fail) {
        return {
          ok: false,
          error: { code: 'unavailable', message: 'Provider down', retryable: true },
        };
      }
      return {
        ok: true,
        response: {
          content: 'Good answer — try adding one more detail next time.',
          ...(options?.feedback !== undefined ? { feedback: options.feedback } : {}),
        },
      };
    },
  };
}

type ReviewPort = Pick<ReviewService, 'planSession' | 'evaluateAnswer' | 'recordPracticeResult'>;

function countingReview(
  inner: ReviewPort,
  calls: { plan: number; evaluate: number; record: number },
): ReviewPort {
  return {
    planSession: (learnerId, opts) => {
      calls.plan += 1;
      return inner.planSession(learnerId, opts);
    },
    evaluateAnswer: (candidate, userAnswer, coachingContext) => {
      calls.evaluate += 1;
      return inner.evaluateAnswer(candidate, userAnswer, coachingContext);
    },
    recordPracticeResult: (learnerId, candidate, userAnswer, evaluation) => {
      calls.record += 1;
      return inner.recordPracticeResult(learnerId, candidate, userAnswer, evaluation);
    },
  };
}

type ListeningPort = Pick<ListeningService, 'startSession' | 'evaluateAnswer'>;

function countingListening(
  inner: ListeningPort,
  calls: { start: number; evaluate: number },
): ListeningPort {
  return {
    startSession: (learnerId, opts) => {
      calls.start += 1;
      return inner.startSession(learnerId, opts);
    },
    evaluateAnswer: (learnerId, exercise, answer, opts) => {
      calls.evaluate += 1;
      return inner.evaluateAnswer(learnerId, exercise, answer, opts);
    },
  };
}

function countingModel(
  inner: AdaptiveLessonModelPort,
  calls: { refresh: number },
): AdaptiveLessonModelPort {
  return {
    refresh: async () => {
      calls.refresh += 1;
      return inner.refresh();
    },
    getCoachingContext: (opts) => inner.getCoachingContext(opts),
    getActiveWeaknesses: () => inner.getActiveWeaknesses(),
    getDueReview: () => inner.getDueReview(),
    get weaknesses() {
      return inner.weaknesses;
    },
    get pronunciationWeaknesses() {
      return inner.pronunciationWeaknesses;
    },
  };
}

function failingPronunciation(): AdaptiveLessonPronunciationPort {
  return {
    analyzeSpokenTurn: async (): Promise<PronunciationTurnOutcome | null> => {
      throw new Error('engine down');
    },
  };
}

/**
 * Strip comments so structural vocabulary checks test real code, not the
 * sentences that document what the feature deliberately does NOT do.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

async function snapshotStores(ctx: TestContext) {
  const [weaknesses, reviewItems, vocabulary, expressions, pronunciationRows, progressRows] =
    await Promise.all([
      ctx.weaknesses.listWeaknesses(ctx.learnerId, 200),
      ctx.review.list(ctx.learnerId, 200),
      ctx.vocabulary.list(ctx.learnerId, { limit: 200 }),
      ctx.expressions.list(ctx.learnerId, { limit: 200 }),
      ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 200 }),
      ctx.progress.list(ctx.learnerId, 200),
    ]);
  return { weaknesses, reviewItems, vocabulary, expressions, pronunciationRows, progressRows };
}

/* ========================================================================= *
 * 1. Planner — priority rules (evidence-based, explainable)
 * ========================================================================= */

describe('Planner — priority rules', () => {
  it('1. a relapsed weakness is prioritized above every other signal', () => {
    const relapsed = coachingWeakness({ type: 'vocabulary', status: 'relapsed', occurrenceCount: 3 });
    const confirmed = coachingWeakness({ type: 'grammar', status: 'confirmed', occurrenceCount: 9 });
    const training = coachingWeakness({ type: 'listening', status: 'active_training', occurrenceCount: 9 });

    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: [training, confirmed, relapsed],
          dueReviewCount: 4,
        }),
        dueReview: { total: 4, byKind: { vocabulary: 4 } },
      }),
    );

    expect(plan.steps[0].reason.code).toBe('relapsed_weakness');
    expect(plan.steps[0].target.id).toBe(relapsed.id);
    expect(plan.steps[0].personalized).toBe(true);
  });

  it('2. a confirmed weakness is included with a human-readable reason', () => {
    const confirmed = coachingWeakness({
      type: 'listening',
      status: 'confirmed',
      occurrenceCount: 4,
      referenceId: stableReferenceId('word_recognition:deadline'),
    });
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: [confirmed] }),
        weaknessTargets: [
          {
            weaknessId: confirmed.id,
            identityKind: 'word_recognition',
            label: 'deadline',
            lastSeenAt: NOW,
          },
        ],
      }),
    );

    const step = stepsOfType(plan, 'listening')[0];
    expect(step).toBeTruthy();
    expect(step.reason.code).toBe('listening_retraining');
    expect(step.reason.message).toContain('deadline');
    expect(step.reason.message.length).toBeGreaterThan(20);
    expect(step.reason.evidence?.occurrenceCount).toBe(4);
    expect(step.reason.evidence?.weaknessStatus).toBe('confirmed');
  });

  it('3. an active_training weakness continues to be practiced', () => {
    const training = coachingWeakness({ type: 'vocabulary', status: 'active_training' });
    const plan = planAdaptiveLesson(
      planningInput({ coaching: coachingContext({ activeWeaknesses: [training] }) }),
    );
    const step = stepsOfType(plan, 'vocabulary')[0];
    expect(step).toBeTruthy();
    expect(step.reason.message).toContain('already in training');
    expect(step.target.id).toBe(training.id);
  });

  it('4. repeated weaknesses are included conservatively (at most one step)', () => {
    const repeated = [
      coachingWeakness({ type: 'vocabulary', status: 'repeated' }),
      coachingWeakness({ type: 'grammar', status: 'repeated' }),
      coachingWeakness({ type: 'vocabulary', status: 'repeated' }),
    ];
    const plan = planAdaptiveLesson(
      planningInput({ coaching: coachingContext({ activeWeaknesses: repeated }) }),
    );
    const repeatedSteps = practiceSteps(plan).filter(
      (step) => step.reason.evidence?.weaknessStatus === 'repeated',
    );
    expect(repeatedSteps.length).toBeLessThanOrEqual(1);
    expect(plan.steps.length).toBeGreaterThanOrEqual(MIN_LESSON_STEPS);
  });

  it('5. a single observed slip never outranks confirmed evidence', () => {
    const observed = coachingWeakness({ type: 'vocabulary', status: 'observed', occurrenceCount: 1 });
    const confirmed = coachingWeakness({ type: 'vocabulary', status: 'confirmed', occurrenceCount: 2 });
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: [observed, confirmed] }),
      }),
    );
    const vocabularySteps = stepsOfType(plan, 'vocabulary');
    expect(vocabularySteps[0].target.id).toBe(confirmed.id);
  });

  it('6. a mastered weakness is never retrained by the planner', () => {
    const mastered = coachingWeakness({ type: 'vocabulary', status: 'mastered', occurrenceCount: 9 });
    const plan = planAdaptiveLesson(
      planningInput({ coaching: coachingContext({ activeWeaknesses: [mastered] }) }),
    );
    expect(plan.steps.some((step) => step.target.id === mastered.id)).toBe(false);
    expect(plan.sourceMode).toBe('general');
  });

  it('7. due review items produce exactly one bounded review step', () => {
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ dueReviewCount: 5 }),
        dueReview: { total: 5, byKind: { expression: 2, vocabulary: 3 } },
      }),
    );
    const dueSteps = plan.steps.filter((step) => step.source === 'due_review');
    expect(dueSteps).toHaveLength(1);
    expect(dueSteps[0].type).toBe('review');
    expect(dueSteps[0].capability).toBe('review-service');
    expect(dueSteps[0].bounds.maxItems).toBeLessThanOrEqual(3);
    expect(dueSteps[0].reason.message).toContain('5 saved items');
    expect(dueSteps[0].reason.message).toContain('2 expressions');
    expect(dueSteps[0].reason.evidence?.dueCount).toBe(5);
  });

  it('8. no due review items means no review step is invented', () => {
    const plan = planAdaptiveLesson(planningInput());
    expect(plan.steps.some((step) => step.source === 'due_review')).toBe(false);
  });

  it('9. a listening weakness needing retraining becomes a listening step', () => {
    const weakness = coachingWeakness({ type: 'listening', status: 'observed' });
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: [weakness] }),
        weaknessTargets: [
          { weaknessId: weakness.id, identityKind: 'word_recognition', label: 'deadline' },
        ],
      }),
    );
    const step = stepsOfType(plan, 'listening').find((s) => s.personalized);
    expect(step).toBeTruthy();
    expect(step?.capability).toBe('listening-service');
    expect(step?.targetText).toBe('deadline');
    expect(step?.reason.code).toBe('listening_retraining');
  });

  it('10. pronunciation evidence becomes a pronunciation step on the owning engine', () => {
    const plan = planAdaptiveLesson(
      planningInput({
        pronunciationTargets: [
          {
            pronunciationWeaknessId: uid(1),
            occurrenceCount: 3,
            identity: 'word_stress:development',
            target: 'development',
            issueLabel: 'development — word stress',
            wordExamples: ['development'],
          },
        ],
      }),
    );
    const step = stepsOfType(plan, 'pronunciation')[0];
    expect(step).toBeTruthy();
    expect(step.capability).toBe('pronunciation-engine');
    expect(step.targetText).toBe('development');
    expect(step.reason.message).toContain('development — word stress');
    expect(step.reason.message).toContain('3 times');
    expect(step.personalized).toBe(true);
  });

  it('11. due vocabulary produces a vocabulary step served by the existing review pipeline', () => {
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          vocabularyFocus: [
            {
              itemId: uid(1),
              headword: 'deadline',
              type: 'word',
              meaningDefinition: 'the latest time',
              reviewState: 'learning',
              nextReviewAt: DUE_AT,
            },
            {
              itemId: uid(2),
              headword: 'agenda',
              type: 'word',
              meaningDefinition: 'a list of items',
              reviewState: 'learning',
              nextReviewAt: DUE_AT,
            },
          ],
        }),
      }),
    );
    const step = stepsOfType(plan, 'vocabulary').find((s) => s.source === 'due_vocabulary');
    expect(step).toBeTruthy();
    expect(step?.capability).toBe('review-service');
    expect(step?.reviewKindFilter).toBe('vocabulary');
    expect(step?.reason.message).toContain('2 saved words');
    expect(step?.bounds.maxItems).toBeLessThanOrEqual(2);
  });

  it('12. due expressions produce an expression step', () => {
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          expressionFocus: [
            {
              itemId: uid(1),
              expression: 'follow up',
              type: 'phrasal_verb',
              meaningDefinition: 'to check again later',
              reviewState: 'learning',
              nextReviewAt: DUE_AT,
            },
          ],
        }),
      }),
    );
    const step = stepsOfType(plan, 'expression').find((s) => s.source === 'due_expression');
    expect(step).toBeTruthy();
    expect(step?.reviewKindFilter).toBe('expression');
    expect(step?.reason.message).toContain('1 saved expression');
  });

  it('13. a natural-phrasing correction becomes a speaking step using the real phrase', () => {
    const weakness = coachingWeakness({ type: 'natural_expression', status: 'confirmed' });
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: [weakness] }),
        weaknessTargets: [{ weaknessId: weakness.id, label: 'I am interesting in this' }],
      }),
    );
    const step = stepsOfType(plan, 'speaking').find((s) => s.personalized);
    expect(step).toBeTruthy();
    expect(step?.capability).toBe('conversation-stack');
    expect(step?.reason.code).toBe('natural_phrasing');
    expect(step?.targetText).toBe('I am interesting in this');
    expect(buildSpeakingPrompt(step!)).toContain('more naturally');
    expect(buildSpeakingPrompt(step!)).toContain('I am interesting in this');
  });

  it('14. a speaking step can reuse a real due expression from the same lesson', () => {
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          expressionFocus: [
            {
              itemId: uid(7),
              expression: 'follow up',
              type: 'phrasal_verb',
              meaningDefinition: 'to check again later',
              reviewState: 'learning',
              nextReviewAt: DUE_AT,
            },
          ],
        }),
      }),
    );
    const speaking = stepsOfType(plan, 'speaking').find((s) => s.source === 'lesson_context');
    expect(speaking).toBeTruthy();
    expect(speaking?.targetText).toBe('follow up');
    expect(buildSpeakingPrompt(speaking!)).toContain('follow up');
    // The same expression is also scheduled for review — two different skills.
    expect(stepsOfType(plan, 'expression').length).toBe(1);
  });

  it('15. a stored learning goal can drive a speaking step', () => {
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          profile: {
            learnerId: PLAN_LEARNER,
            displayName: 'Adaptive Tester',
            currentLevel: 'B1',
            targetLevel: 'B2',
            learningGoals: ['Work meetings'],
            preferredModes: [],
          },
        }),
      }),
    );
    const goalStep = plan.steps.find((step) => step.source === 'learning_goal');
    expect(goalStep).toBeTruthy();
    expect(goalStep?.personalized).toBe(true);
    expect(goalStep?.reason.message).toContain('Work meetings');
    expect(buildSpeakingPrompt(goalStep!)).toContain('Work meetings');
  });

  it('16. general fallback content is only used when evidence cannot fill the lesson', () => {
    const weakness = coachingWeakness({ type: 'listening', status: 'confirmed' });
    const personalized = planAdaptiveLesson(
      planningInput({ coaching: coachingContext({ activeWeaknesses: [weakness] }) }),
    );
    const general = planAdaptiveLesson(planningInput());

    expect(practiceSteps(personalized).filter((s) => s.personalized).length).toBeGreaterThan(0);
    expect(practiceSteps(general).every((step) => step.personalized === false)).toBe(true);
    expect(practiceSteps(general).every((step) => step.source === 'general')).toBe(true);
    // Personalized evidence is always selected before general filler.
    const firstGeneralIndex = personalized.steps.findIndex((step) => step.source === 'general');
    const lastPersonalIndex = personalized.steps.map((s) => s.personalized).lastIndexOf(true);
    expect(firstGeneralIndex).toBeGreaterThan(lastPersonalIndex);
  });

  it('17. general speaking prompts come from the deterministic general bank', () => {
    const plan = planAdaptiveLesson(planningInput());
    const speaking = stepsOfType(plan, 'speaking')[0];
    expect(GENERAL_SPEAKING_PROMPTS).toContain(buildSpeakingPrompt(speaking));
    expect(buildSpeakingPrompt(speaking)).toBe(buildSpeakingPrompt(speaking));
  });
});

/* ========================================================================= *
 * 2. Planner — bounds, diversity, determinism, honesty
 * ========================================================================= */

describe('Planner — bounds, diversity and honesty', () => {
  it('18. lesson size stays inside the Phase-1 bounds', () => {
    const manyWeaknesses = [
      coachingWeakness({ type: 'listening', status: 'confirmed', occurrenceCount: 5 }),
      coachingWeakness({ type: 'vocabulary', status: 'relapsed', occurrenceCount: 4 }),
      coachingWeakness({ type: 'grammar', status: 'active_training', occurrenceCount: 3 }),
      coachingWeakness({ type: 'natural_expression', status: 'repeated', occurrenceCount: 2 }),
      coachingWeakness({ type: 'fluency', status: 'observed', occurrenceCount: 1 }),
    ];
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: manyWeaknesses, dueReviewCount: 6 }),
        dueReview: { total: 6, byKind: { vocabulary: 3, expression: 3 } },
        pronunciationTargets: [
          {
            pronunciationWeaknessId: uid(3),
            occurrenceCount: 2,
            identity: 'word_stress:development',
            target: 'development',
            issueLabel: 'development — word stress',
            wordExamples: ['development'],
          },
        ],
      }),
    );
    expect(plan.steps.length).toBeGreaterThanOrEqual(MIN_LESSON_STEPS);
    expect(plan.steps.length).toBeLessThanOrEqual(MAX_LESSON_STEPS);
    expect(plan.steps.length).toBeLessThanOrEqual(HARD_MAX_LESSON_STEPS);
  });

  it('19. the hard maximum of 8 steps is never exceeded, even when requested', () => {
    const manyWeaknesses = Array.from({ length: 20 }, (_, index) =>
      coachingWeakness({
        type: (['listening', 'vocabulary', 'grammar', 'natural_expression', 'fluency'] as const)[
          index % 5
        ],
        status: 'confirmed',
        occurrenceCount: 20 - index,
      }),
    );
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: manyWeaknesses, dueReviewCount: 40 }),
        dueReview: { total: 40, byKind: { vocabulary: 20, expression: 20 } },
      }),
      { maxSteps: 50, targetPracticeSteps: 40 },
    );
    expect(plan.steps.length).toBeLessThanOrEqual(HARD_MAX_LESSON_STEPS);
    expect(plan.steps.length).toBeLessThanOrEqual(8);
  });

  it('20. no single category can dominate: at most two steps of one type', () => {
    const vocabularyOnly = Array.from({ length: 8 }, (_, index) =>
      coachingWeakness({ type: 'vocabulary', status: 'confirmed', occurrenceCount: 8 - index }),
    );
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: vocabularyOnly, dueReviewCount: 8 }),
        dueReview: { total: 8, byKind: { vocabulary: 8 } },
      }),
      { maxSteps: 50, targetPracticeSteps: 40 },
    );

    const counts = new Map<AdaptiveLessonStepType, number>();
    for (const step of plan.steps) {
      counts.set(step.type, (counts.get(step.type) ?? 0) + 1);
    }
    for (const [type, count] of counts) {
      expect(count, `too many ${type} steps`).toBeLessThanOrEqual(MAX_STEPS_PER_TYPE);
    }
    expect(plan.steps.length).toBeLessThanOrEqual(HARD_MAX_LESSON_STEPS);
    expect(counts.size).toBeGreaterThanOrEqual(2);
  });

  it('21. the review pipeline is never asked for more than three lesson steps', () => {
    const weaknesses = [
      coachingWeakness({ type: 'grammar', status: 'relapsed' }),
      coachingWeakness({ type: 'vocabulary', status: 'confirmed' }),
      coachingWeakness({ type: 'vocabulary', status: 'repeated' }),
    ];
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: weaknesses,
          dueReviewCount: 9,
          vocabularyFocus: [
            {
              itemId: uid(11),
              headword: 'deadline',
              type: 'word',
              meaningDefinition: 'latest time',
              reviewState: 'learning',
              nextReviewAt: DUE_AT,
            },
          ],
          expressionFocus: [
            {
              itemId: uid(12),
              expression: 'follow up',
              type: 'phrasal_verb',
              meaningDefinition: 'check again',
              reviewState: 'learning',
              nextReviewAt: DUE_AT,
            },
          ],
        }),
        dueReview: { total: 9, byKind: { grammar: 3, vocabulary: 3, expression: 3 } },
      }),
      { maxSteps: 50, targetPracticeSteps: 40 },
    );
    const reviewFamily = plan.steps.filter(
      (step) =>
        step.type === 'review' || step.type === 'vocabulary' || step.type === 'expression',
    );
    expect(reviewFamily.length).toBeLessThanOrEqual(MAX_REVIEW_FAMILY_STEPS);
  });

  it('22. the same underlying problem is never scheduled twice', () => {
    const weakness = coachingWeakness({ type: 'listening', status: 'confirmed' });
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({ activeWeaknesses: [weakness, weakness], dueReviewCount: 3 }),
        weaknessTargets: [{ weaknessId: weakness.id, label: 'deadline' }],
        dueReview: { total: 3, byKind: { listening: 3 } },
      }),
      { maxSteps: 50, targetPracticeSteps: 40 },
    );
    const ids = plan.steps.map((step) => step.target.id).filter((id): id is string => Boolean(id));
    expect(new Set(ids).size).toBe(ids.length);
    const stepIds = plan.steps.map((step) => step.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });

  it('23. the wrap-up step is always present, last, and never claims personalization', () => {
    for (const input of [
      planningInput(),
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: [coachingWeakness({ type: 'listening', status: 'relapsed' })],
        }),
      }),
    ]) {
      const plan = planAdaptiveLesson(input);
      const last = plan.steps[plan.steps.length - 1];
      expect(last.type).toBe('wrap_up');
      expect(last.capability).toBe('lesson-summary');
      expect(last.personalized).toBe(false);
      expect(plan.steps.filter((step) => step.type === 'wrap_up')).toHaveLength(1);
    }
  });

  it('24. the planner is deterministic for identical input (ids included)', () => {
    const input = () =>
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: [
            coachingWeakness({ id: uid(31), type: 'listening', status: 'confirmed' }),
            coachingWeakness({ id: uid(32), type: 'vocabulary', status: 'relapsed' }),
          ],
          dueReviewCount: 3,
        }),
        dueReview: { total: 3, byKind: { vocabulary: 3 } },
        weaknessTargets: [{ weaknessId: uid(31), label: 'deadline' }],
      });
    const first = planAdaptiveLesson(input());
    const second = planAdaptiveLesson(input());
    expect(second).toEqual(first);
    expect(second.id).toBe(first.id);
    expect(second.steps.map((step) => step.id)).toEqual(first.steps.map((step) => step.id));
  });

  it('25. planning requires no AI call and the planner imports no AI provider', () => {
    const plannerSrc = readFileSync(join(__dirname, './planner.ts'), 'utf8');
    const typesSrc = readFileSync(join(__dirname, './types.ts'), 'utf8');
    expect(plannerSrc).not.toContain("from '../providers/ai");
    expect(plannerSrc).not.toMatch(/generate\(|AIProvider/);
    expect(typesSrc).not.toMatch(/createDemoAIProvider|createGeminiAIProvider/);
  });

  it('26. every personalized step carries a reason with no internal ids', () => {
    const weakness = coachingWeakness({ type: 'vocabulary', status: 'confirmed', referenceId: uid(41) });
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: [weakness],
          dueReviewCount: 2,
          vocabularyFocus: [
            {
              itemId: uid(42),
              headword: 'deadline',
              type: 'word',
              meaningDefinition: 'latest time',
              reviewState: 'learning',
              nextReviewAt: DUE_AT,
            },
          ],
        }),
        dueReview: { total: 2, byKind: { vocabulary: 2 } },
        weaknessTargets: [{ weaknessId: weakness.id, label: 'deadline' }],
      }),
    );
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const step of practiceSteps(plan)) {
      expect(step.reason.message.trim().length).toBeGreaterThan(15);
      expect(step.reason.message).not.toMatch(uuidPattern);
      if (step.target.id) expect(step.reason.message).not.toContain(step.target.id);
      if (!step.personalized) {
        expect(step.reason.message.toLowerCase()).toContain('general');
      }
    }
  });

  it('27. source mode labels are honest about where content came from', () => {
    const general = planAdaptiveLesson(planningInput());
    expect(general.sourceMode).toBe('general');
    expect(general.title).toContain('General');
    expect(general.sourceNote.toLowerCase()).toContain('general');
    expect(general.sourceNote.toLowerCase()).not.toContain('personalized from your');

    const personalized = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: [
            coachingWeakness({ type: 'listening', status: 'confirmed' }),
            coachingWeakness({ type: 'vocabulary', status: 'relapsed' }),
            coachingWeakness({ type: 'grammar', status: 'active_training' }),
          ],
        }),
      }),
    );
    expect(personalized.sourceMode).toBe('personalized');
    expect(personalized.sourceNote.toLowerCase()).toContain('your own practice history');

    const mixed = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: [coachingWeakness({ type: 'listening', status: 'confirmed' })],
        }),
      }),
    );
    expect(mixed.sourceMode).toBe('mixed');
    expect(mixed.sourceNote.toLowerCase()).toContain('general practice');
  });

  it('28. the plan model carries no scores, percentages, XP, streaks or durations', () => {
    const plan = planAdaptiveLesson(
      planningInput({
        coaching: coachingContext({
          activeWeaknesses: [coachingWeakness({ type: 'listening', status: 'confirmed' })],
          dueReviewCount: 3,
        }),
        dueReview: { total: 3, byKind: { vocabulary: 3 } },
      }),
    );
    const serialized = JSON.stringify(plan).toLowerCase();
    expect(serialized).not.toMatch(
      /\b(score|scores|scored|percent|percentage|xp|streak|streaks|badge|badges|leaderboard|minutes|rating)\b/,
    );
    expect(plan.sizeLabel === 'short' || plan.sizeLabel === 'standard').toBe(true);
    expect(serialized).not.toContain('estimatedminutes');
  });
});

/* ========================================================================= *
 * 3. Service — planning from real learner state
 * ========================================================================= */

describe('Service — planning from real learner state', () => {
  it('29. no learner profile produces an honest no-profile state, never a fabricated lesson', async () => {
    const ctx = await createContext({ withProfile: false });
    const service = createLessonService(ctx);

    expect(await service.resolveLearnerId()).toBeNull();
    const planned = await service.planLesson();
    expect(planned.status).toBe('no-profile');
    expect(planned.plan).toBeNull();
    if (planned.status === 'no-profile') expect(planned.message.length).toBeGreaterThan(10);

    const today = await service.getTodayPractice();
    expect(today.status).toBe('no-profile');
    expect(today.canStart).toBe(false);

    const started = await service.startLesson();
    expect(started.status).toBe('no-profile');
    expect(started.session).toBeNull();

    const stores = await snapshotStores(ctx);
    expect(stores.progressRows).toHaveLength(0);
    expect(stores.weaknesses).toHaveLength(0);
  });

  it('30. planning reads real seeded weaknesses and due items', async () => {
    const ctx = await createContext();
    const listeningWeakness = await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
      occurrenceCount: 3,
    });
    await seedVocabulary(ctx, 'deadline', 'the latest time something can happen');
    const service = createLessonService(ctx);

    const planned = await service.planLesson();
    expect(planned.status).toBe('planned');
    const plan = planned.plan!;
    expect(plan.learnerId).toBe(ctx.learnerId);

    const listeningStep = plan.steps.find(
      (step) => step.type === 'listening' && step.target.id === listeningWeakness.id,
    );
    expect(listeningStep).toBeTruthy();
    expect(listeningStep?.reason.message).toContain('deadline');
    expect(listeningStep?.targetText).toBe('deadline');

    expect(plan.signals.activeWeaknesses).toBe(1);
    expect(plan.signals.dueVocabulary).toBe(1);
    expect(plan.signals.savedVocabulary).toBe(1);
    expect(plan.sourceMode).toBe('personalized');
    // Every personalized target must point at a real stored row.
    for (const step of practiceSteps(plan)) {
      if (step.target.id && step.target.kind === 'learner_weakness') {
        expect(step.target.id).toBe(listeningWeakness.id);
      }
    }
  });

  it('31. resolved and mastered weaknesses never produce lesson steps', async () => {
    const ctx = await createContext();
    const resolved = await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:agenda'),
      notes: 'word_recognition:agenda',
      resolved: true,
    });
    const mastered = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'mastered',
      referenceId: uid(51),
      notes: 'vocabulary:invoice',
    });
    // One genuinely due review item, plus vocabulary that is NOT due yet.
    await seedReviewItem(ctx, {
      kind: 'grammar',
      prompt: 'Correct this sentence about your weekend',
      dueAt: DUE_AT,
    });
    await seedVocabulary(ctx, 'itinerary', 'a planned route', FUTURE_AT);

    const service = createLessonService(ctx);
    const started = await service.startLesson();
    expect(started.status).toBe('started');
    const plan = started.session!.plan;

    const ids = plan.steps.map((step) => step.target.id);
    expect(ids).not.toContain(resolved.id);
    expect(ids).not.toContain(mastered.id);
    expect(JSON.stringify(plan)).not.toContain('agenda');
    expect(JSON.stringify(plan)).not.toContain('invoice');
    // Not-due material is never pulled forward just to fill a lesson.
    expect(JSON.stringify(plan)).not.toContain('itinerary');

    const reviewStep = plan.steps.find((step) => step.type === 'review');
    expect(reviewStep).toBeTruthy();
    const material = await service.prepareStep(reviewStep!.id);
    expect(material?.kind).toBe('review');
    if (material?.kind === 'review') {
      expect(material.candidates).toHaveLength(1);
      expect(JSON.stringify(material.candidates)).not.toContain('itinerary');
    }
  });

  it('32. the plan cache stops Home → Lesson from planning twice', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
    });
    const calls = { refresh: 0 };
    const service = createLessonService(ctx, {
      learnerModel: countingModel(createLearnerModel(ctx.repos), calls),
    });

    const first = await service.planLesson();
    const second = await service.planLesson();
    expect(second.plan).toBe(first.plan);
    expect(calls.refresh).toBe(1);

    const forced = await service.planLesson(undefined, { force: true });
    expect(forced.plan).not.toBe(first.plan);
    expect(calls.refresh).toBe(2);
  });

  it('33. a planning failure is reported honestly and changes nothing', async () => {
    const ctx = await createContext();
    const broken: AdaptiveLessonModelPort = {
      refresh: async () => {
        throw new Error('database offline');
      },
      getCoachingContext: () => {
        throw new Error('database offline');
      },
      getActiveWeaknesses: () => [],
      getDueReview: () => [],
      weaknesses: [],
      pronunciationWeaknesses: [],
    };
    const service = createLessonService(ctx, { learnerModel: broken });

    const planned = await service.planLesson();
    expect(planned.status).toBe('unavailable');
    expect(planned.plan).toBeNull();
    if (planned.status === 'unavailable') {
      expect(planned.message.toLowerCase()).toContain('nothing was changed');
    }
    const today = await service.getTodayPractice();
    expect(today.status).toBe('unavailable');
    expect(today.canStart).toBe(false);
    expect(await snapshotStores(ctx)).toMatchObject({ progressRows: [] });
  });

  it('34. getTodayPractice reflects the real plan and its availability', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'listening',
      status: 'relapsed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
      occurrenceCount: 4,
    });
    await seedExpression(ctx, 'follow up', 'to check again later');
    const service = createLessonService(ctx);

    const today = await service.getTodayPractice();
    expect(today.status).toBe('ready');
    if (today.status !== 'ready') return;
    expect(today.canStart).toBe(true);
    expect(today.stepCount).toBe(today.plan.steps.length);
    expect(today.structureLines).toHaveLength(today.stepCount);
    expect(today.focusLines.length).toBeGreaterThan(0);
    expect(today.focusLines.join(' ')).toContain('Listening');
    expect(today.claimsPersonalization).toBe(today.plan.sourceMode === 'personalized');
    expect(today.headline).toContain(String(today.plan.steps.filter((s) => s.type !== 'wrap_up').length));
    expect(today.resume).toBeUndefined();
  });

  it('35. weakness/pronunciation target helpers expose human labels, not raw identities', async () => {
    const ctx = await createContext();
    const listening = await seedWeakness(ctx, {
      type: 'listening',
      status: 'repeated',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
    });
    const correction = await seedWeakness(ctx, {
      type: 'natural_expression',
      status: 'confirmed',
      referenceId: uid(61),
      notes: 'I am interesting in this',
    });
    const pronunciationRow = await seedPronunciation(ctx, 'development');

    expect(describeWeaknessTarget(listening)).toMatchObject({
      weaknessId: listening.id,
      identityKind: 'word_recognition',
      label: 'deadline',
    });
    expect(describeWeaknessTarget(correction)).toMatchObject({
      weaknessId: correction.id,
      label: 'I am interesting in this',
    });

    const target = describePronunciationTarget(pronunciationRow, [listening, correction]);
    expect(target.target).toBe('development');
    expect(target.issueLabel).toContain('word stress');
    expect(target.occurrenceCount).toBe(2);
    expect(target.wordExamples).toEqual(['development']);
  });
});

/* ========================================================================= *
 * 4. Service — execution delegates to the EXISTING systems
 * ========================================================================= */

describe('Service — execution delegates to existing systems', () => {
  it('36. review steps use ONE bounded call to the existing ReviewService', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', prompt: 'What word matches this definition?' });
    await seedReviewItem(ctx, { kind: 'expression', prompt: 'Use this expression naturally' });
    await seedReviewItem(ctx, { kind: 'grammar', prompt: 'Correct this sentence' });
    await seedVocabulary(ctx, 'agenda', 'a list of items to discuss');

    const calls = { plan: 0, evaluate: 0, record: 0 };
    const service = createLessonService(ctx, {
      review: countingReview(new ReviewService(ctx.repos), calls),
    });

    const started = await service.startLesson();
    expect(started.status).toBe('started');
    const session = started.session!;
    const reviewSteps = session.plan.steps.filter(
      (step) => step.type === 'review' || step.type === 'vocabulary' || step.type === 'expression',
    );
    expect(reviewSteps.length).toBeGreaterThanOrEqual(2);

    let served = 0;
    for (const step of reviewSteps) {
      const material = await service.prepareStep(step.id);
      // A step is either served by the existing planner or honestly unavailable.
      expect(['review', 'unavailable']).toContain(material?.kind);
      if (material?.kind === 'review') {
        served += 1;
        expect(material.candidates.length).toBeGreaterThan(0);
        expect(material.candidates.length).toBeLessThanOrEqual(step.bounds.maxItems);
        if (step.reviewKindFilter) {
          for (const candidate of material.candidates) {
            expect(candidate.kind).toBe(step.reviewKindFilter);
          }
        }
      } else if (material?.kind === 'unavailable') {
        expect(material.message.length).toBeGreaterThan(10);
      }
    }
    expect(served).toBeGreaterThan(0);
    // The pool is fetched ONCE per lesson, never per step (no N+1, no duplicate work).
    expect(calls.plan).toBe(1);
  });

  it('37. review-family steps never serve the same item twice', async () => {
    const ctx = await createContext();
    for (let index = 0; index < 4; index += 1) {
      await seedReviewItem(ctx, {
        kind: 'vocabulary',
        prompt: `What word matches this definition? (${index})`,
        expectedResponse: `word-${index}`,
      });
    }
    await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      referenceId: uid(71),
      notes: 'vocabulary:invoice',
    });
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;

    const seen: string[] = [];
    for (const step of session.plan.steps) {
      const material = await service.prepareStep(step.id);
      if (material?.kind === 'review') {
        for (const candidate of material.candidates) {
          expect(seen).not.toContain(candidate.id);
          seen.push(candidate.id);
        }
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it('38. review answers go through the existing evaluator and update the existing schedule', async () => {
    const ctx = await createContext();
    const item = await seedReviewItem(ctx, {
      kind: 'vocabulary',
      prompt: 'What word matches this definition?',
      expectedResponse: 'deadline',
    });
    const calls = { plan: 0, evaluate: 0, record: 0 };
    const service = createLessonService(ctx, {
      review: countingReview(new ReviewService(ctx.repos), calls),
    });

    await service.startLesson();
    const material = await service.prepareStep();
    expect(material?.kind).toBe('review');
    if (material?.kind !== 'review') return;
    const candidate = material.candidates[0];
    expect(candidate.id).toBe(item.id);

    const outcome = await service.submitReviewAnswer(candidate.id, 'deadline');
    expect(outcome?.result.kind).toBe('review');
    if (outcome?.result.kind !== 'review') return;
    expect(outcome.result.evaluation.result).toBe('correct');
    expect(outcome.result.persisted).toBe(true);
    expect(outcome.result.persistenceError).toBe(false);
    expect(calls.evaluate).toBe(1);
    expect(calls.record).toBe(1);

    // The OWNING engine updated the real review row (history preserved, not reset).
    const stored = await ctx.review.get(item.id);
    expect(stored?.reviewCount).toBe(1);
    expect(stored?.consecutiveCorrect).toBe(1);
    expect(stored?.outcomeHistory).toHaveLength(1);

    const stepState = outcome.session.steps.find((entry) => entry.stepId === material.step.id);
    expect(stepState?.practicedItems).toBe(1);
    expect(stepState?.status).not.toBe('completed');
  });

  it('39. listening steps delegate to the existing ListeningService and persist real evidence', async () => {
    const ctx = await createContext();
    const weakness = await seedWeakness(ctx, {
      type: 'listening',
      status: 'repeated',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
      occurrenceCount: 2,
    });
    const calls = { start: 0, evaluate: 0 };
    const service = createLessonService(ctx, {
      listening: countingListening(createListeningService(ctx.adapter), calls),
    });

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'listening' && entry.personalized);
    expect(step).toBeTruthy();
    expect(step?.target.id).toBe(weakness.id);

    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('listening');
    if (material?.kind !== 'listening') return;
    expect(material.exercises.length).toBeGreaterThan(0);
    expect(material.exercises.length).toBeLessThanOrEqual(step!.bounds.maxItems);
    expect(material.exercises[0].weaknessReferenceId).toBe(weakness.referenceId);
    expect(calls.start).toBe(1);

    const outcome = await service.submitListeningAnswer(
      material.exercises[0].id,
      'something completely different',
      step!.id,
    );
    expect(outcome?.result.kind).toBe('listening');
    expect(calls.evaluate).toBe(1);

    // Existing pathway: the real weakness row accumulated evidence.
    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 50);
    const updated = rows.find((row) => row.id === weakness.id);
    expect(updated?.occurrenceCount).toBeGreaterThan(2);
    const reviewRows = await ctx.review.list(ctx.learnerId, 50);
    expect(reviewRows.some((row) => row.kind === 'listening')).toBe(true);
  });

  it('40. pronunciation steps are served by the existing engine with qualitative results only', async () => {
    const ctx = await createContext();
    const row = await seedPronunciation(ctx, 'development', 'word_stress', 2);
    const seen: { expectedText?: string; context?: string }[] = [];
    const engine = createPronunciationEngine(ctx.adapter);
    const spyPort: AdaptiveLessonPronunciationPort = {
      analyzeSpokenTurn: async (input) => {
        seen.push({ expectedText: input.expectedText, context: input.context });
        return engine.analyzeSpokenTurn(input);
      },
    };
    const service = createLessonService(ctx, { pronunciation: spyPort });

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'pronunciation');
    expect(step).toBeTruthy();
    expect(step?.capability).toBe('pronunciation-engine');
    expect(step?.target.id).toBe(row.id);

    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('pronunciation');
    if (material?.kind !== 'pronunciation') return;
    expect(material.target).toBe('development');
    expect(material.issueLabel).toContain('word stress');
    expect(material.wordExamples).toEqual(['development']);

    // A correct repeat must NOT fabricate an observation.
    const rowsBefore = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 20 });
    expect(rowsBefore).toHaveLength(1);
    const correct = await service.submitPronunciationAttempt('development', step!.id);
    expect(correct?.result.kind).toBe('pronunciation');
    if (correct?.result.kind !== 'pronunciation') return;
    expect(correct.result.unavailable).toBe(false);
    expect(correct.result.lines.length).toBeGreaterThan(0);
    expect(seen[0].expectedText).toBe('development');
    expect(seen[0].context).toBe('adaptive-lesson');
    expect(JSON.stringify(correct.result)).not.toMatch(/\b(score|percent|rating)\b/i);

    const afterCorrect = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 20 });
    expect(afterCorrect).toHaveLength(1);
    expect(afterCorrect[0].id).toBe(row.id);
    expect(afterCorrect[0].occurrenceCount).toBe(2);

    // A mismatched repeat is real evidence; the OWNING engine decides what to
    // persist (its own dedup identities) — the lesson adds no second path.
    const mismatch = await service.submitPronunciationAttempt('devlopment', step!.id);
    if (mismatch?.result.kind !== 'pronunciation') throw new Error('expected pronunciation result');
    expect(mismatch.result.unavailable).toBe(false);
    expect(mismatch.result.observationsDetected).toBeGreaterThan(0);

    const afterMismatch = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 20 });
    const original = afterMismatch.find((entry) => entry.id === row.id);
    expect(original).toBeTruthy();
    // The stored history never regresses or resets.
    expect(original!.occurrenceCount).toBeGreaterThanOrEqual(2);
    expect(original!.firstSeenAt).toBe(NOW);
    // The step counted the real attempt exactly once per submission.
    const state = service
      .getCurrentSession()
      ?.steps.find((entry) => entry.stepId === step!.id);
    expect(state?.practicedItems).toBe(2);
  });

  it('41. speaking steps use the existing conversation stack when a real provider exists', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'natural_expression',
      status: 'confirmed',
      referenceId: uid(81),
      notes: 'I am interesting in this',
    });
    const requests: { systemPrompt: string; userMessage: string }[] = [];
    const calls = { count: 0 };
    const feedback: ConversationFeedback = {
      correction: {
        original: 'I am interesting in this',
        improved: 'I am interested in this',
        explanation: '"interested" describes your feeling; "interesting" describes the thing.',
        severity: 'incorrect',
      },
      coachingNote: 'Keep going — that was a clear answer.',
    };
    const service = createLessonService(ctx, {
      aiProvider: fakeAI({ calls, feedback, requests }),
    });

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'speaking');
    expect(step).toBeTruthy();

    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('speaking');
    if (material?.kind !== 'speaking') return;
    expect(material.aiAvailable).toBe(true);
    expect(material.prompt).toContain('I am interesting in this');
    // No AI call happened while planning or preparing.
    expect(calls.count).toBe(0);

    const outcome = await service.submitSpeakingAnswer('I am interesting in this topic', step!.id);
    expect(outcome?.result.kind).toBe('speaking');
    if (outcome?.result.kind !== 'speaking') return;
    expect(calls.count).toBe(1);
    expect(outcome.result.feedback.evaluatedBy).toBe('ai');
    expect(outcome.result.feedback.correction?.improved).toBe('I am interested in this');
    expect(outcome.result.feedback.lines.join(' ')).toContain('I am interested in this');
    expect(outcome.result.feedback.lines.join(' ')).not.toMatch(/\b\d+(\.\d+)?%\b/);

    // It really went through the existing engine/orchestrator/session stack.
    expect(requests[0].systemPrompt.length).toBeGreaterThan(50);
    expect(requests[0].userMessage).toContain('Speaking task:');
    expect(requests[0].userMessage).toContain('I am interesting in this topic');
  });

  it('42. without a real provider, speaking feedback is honestly unavailable (never demo)', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'fluency',
      status: 'confirmed',
      referenceId: uid(91),
      notes: 'fluency:speaking pace',
    });
    const service = createLessonService(ctx, { disableAI: true });

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'speaking');
    expect(step).toBeTruthy();

    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('speaking');
    if (material?.kind !== 'speaking') return;
    expect(material.aiAvailable).toBe(false);
    expect(material.note?.toLowerCase()).toContain('not available');
    expect(material.prompt.length).toBeGreaterThan(20);

    const outcome = await service.submitSpeakingAnswer('I speak about my week.', step!.id);
    if (outcome?.result.kind !== 'speaking') throw new Error('expected speaking result');
    expect(outcome.result.feedback.evaluatedBy).toBe('unavailable');
    expect(outcome.result.feedback.correction).toBeNull();
    expect(outcome.result.feedback.lines.join(' ').toLowerCase()).toContain('not available');

    // The step is still completable and counts as real practice.
    const completed = await service.completeStep(step!.id);
    const state = completed?.steps.find((entry) => entry.stepId === step!.id);
    expect(state?.status).toBe('completed');
    expect(state?.practicedItems).toBe(1);

    // No weakness was invented from an unevaluated answer.
    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceCount).toBe(2);
  });

  it('43. real speaking corrections flow through the existing Talk evidence pathway only', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'natural_expression',
      status: 'confirmed',
      referenceId: uid(95),
      notes: 'I am interesting in this',
    });
    const recorded: ConversationFeedback[] = [];
    const feedback: ConversationFeedback = {
      correction: {
        original: 'I am interesting in this',
        improved: 'I am interested in this',
        explanation: 'Word form.',
        severity: 'unnatural',
      },
    };
    const service = createLessonService(ctx, {
      aiProvider: fakeAI({ feedback }),
      speakingEvidence: {
        recordFeedbackEvidence: async (entry) => {
          recorded.push(entry);
        },
      },
    });

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'speaking')!;
    await service.prepareStep(step.id);
    await service.submitSpeakingAnswer('I am interesting in this', step.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].correction?.improved).toBe('I am interested in this');

    // No correction → nothing is pushed into the evidence pathway.
    const noCorrection = createLessonService(ctx, {
      aiProvider: fakeAI({ feedback: { correction: null } }),
      speakingEvidence: {
        recordFeedbackEvidence: async (entry) => {
          recorded.push(entry);
        },
      },
    });
    await noCorrection.planLesson(undefined, { force: true });
    const second = (await noCorrection.startLesson({ forceNew: true })).session!;
    const secondStep = second.plan.steps.find((entry) => entry.type === 'speaking')!;
    await noCorrection.prepareStep(secondStep.id);
    await noCorrection.submitSpeakingAnswer('Everything is fine today', secondStep.id);
    expect(recorded).toHaveLength(1);
  });

  it('44. planning and preparation never call the AI provider', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
    });
    await seedWeakness(ctx, {
      type: 'natural_expression',
      status: 'confirmed',
      referenceId: uid(97),
      notes: 'I am interesting in this',
    });
    await seedPronunciation(ctx, 'development');
    await seedVocabulary(ctx, 'deadline', 'the latest time');
    await seedReviewItem(ctx, { kind: 'vocabulary' });

    const calls = { count: 0 };
    const service = createLessonService(ctx, { aiProvider: fakeAI({ calls }) });

    await service.planLesson();
    const session = (await service.startLesson()).session!;
    for (const step of session.plan.steps) {
      await service.prepareStep(step.id);
    }
    expect(calls.count).toBe(0);
  });
});

/* ========================================================================= *
 * 5. Skip, completion and progress integrity
 * ========================================================================= */

describe('Service — skip, completion and progress integrity', () => {
  it('45. skipping records a skip and changes no stored evidence', async () => {
    const ctx = await createContext();
    const item = await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    const weakness = await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
      occurrenceCount: 3,
    });
    const before = await snapshotStores(ctx);
    const service = createLessonService(ctx);

    const session = (await service.startLesson()).session!;
    const reviewStep = session.plan.steps.find(
      (entry) => entry.type === 'review' || entry.type === 'vocabulary',
    )!;
    await service.prepareStep(reviewStep.id);
    const skipped = await service.skipStep(reviewStep.id);

    const state = skipped?.steps.find((entry) => entry.stepId === reviewStep.id);
    expect(state?.status).toBe('skipped');
    expect(state?.practicedItems).toBe(0);
    expect(state?.note?.toLowerCase()).toContain('skipped');

    const after = await snapshotStores(ctx);
    expect(after.weaknesses).toEqual(before.weaknesses);
    expect(after.reviewItems).toEqual(before.reviewItems);
    expect(after.progressRows).toEqual(before.progressRows);
    const storedItem = await ctx.review.get(item.id);
    expect(storedItem?.reviewCount).toBe(0);
    expect(storedItem?.consecutiveCorrect).toBe(0);
    expect(storedItem?.state).toBe('learning');
    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 50);
    expect(rows.find((row) => row.id === weakness.id)?.occurrenceCount).toBe(3);
  });

  it('46. a skip is never reported as success, practice or improvement', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary' });
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;

    for (const step of session.plan.steps) {
      if (step.type === 'wrap_up') continue;
      await service.skipStep(step.id);
    }
    const progress = service.getProgress();
    expect(progress?.completedSteps).toBe(0);
    expect(progress?.skippedSteps).toBe(session.plan.steps.length - 1);
    expect(progress?.practicedItems).toBe(0);

    const finished = await service.completeLesson();
    expect(finished?.summary.stepsCompleted).toBe(0);
    expect(finished?.summary.stepsSkipped).toBe(session.plan.steps.length - 1);
    expect(finished?.summary.itemsPracticed).toBe(0);
    expect(finished?.summary.persistedProgress).toBe(false);
    expect(finished?.summary.lines.join(' ').toLowerCase()).toContain('skipped');
    expect(finished?.summary.lines.join(' ').toLowerCase()).not.toContain('improved');

    const stores = await snapshotStores(ctx);
    expect(stores.progressRows).toHaveLength(0);
  });

  it('47. completing steps without practicing changes nothing in the domain stores', async () => {
    const ctx = await createContext();
    const weakness = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      referenceId: uid(101),
      notes: 'vocabulary:invoice',
      occurrenceCount: 2,
    });
    const item = await seedReviewItem(ctx, { kind: 'vocabulary' });
    const before = await snapshotStores(ctx);
    const service = createLessonService(ctx);

    const session = (await service.startLesson()).session!;
    for (const step of session.plan.steps) {
      await service.prepareStep(step.id);
      await service.completeStep(step.id);
    }

    const after = await snapshotStores(ctx);
    expect(after.weaknesses).toEqual(before.weaknesses);
    expect(after.reviewItems).toEqual(before.reviewItems);
    expect(after.vocabulary).toEqual(before.vocabulary);
    expect(after.expressions).toEqual(before.expressions);
    expect(after.pronunciationRows).toEqual(before.pronunciationRows);

    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 50);
    expect(rows.find((row) => row.id === weakness.id)?.status).toBe('confirmed');
    const storedItem = await ctx.review.get(item.id);
    expect(storedItem?.state).toBe('learning');
  });

  it('48. lesson completion never fabricates mastery', async () => {
    const ctx = await createContext();
    const vocabularyItem = await seedVocabulary(ctx, 'deadline', 'the latest time');
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    const service = createLessonService(ctx);

    const session = (await service.startLesson()).session!;
    for (const step of session.plan.steps) {
      const material = await service.prepareStep(step.id);
      if (material?.kind === 'review') {
        for (const candidate of material.candidates) {
          await service.submitReviewAnswer(candidate.id, candidate.expectedAnswer, step.id);
        }
      }
      await service.completeStep(step.id);
    }
    const finished = await service.completeLesson();
    // Every step is accounted for exactly once, and a step the owning engine
    // could not serve is never rewritten as completed (see hardening test 69).
    const summary = finished!.summary;
    expect(
      summary.stepsCompleted + summary.stepsSkipped + summary.stepsUnavailable,
    ).toBe(session.plan.steps.length);
    expect(summary.stepsCompleted).toBeGreaterThan(0);
    expect(summary.itemsPracticed).toBeGreaterThan(0);

    const stored = await ctx.vocabulary.get(vocabularyItem.id);
    const review = stored?.meanings[0]?.review;
    expect(review?.state).not.toBe('mastered');
    expect(review?.reviewCount ?? 0).toBeLessThanOrEqual(1);
    const summaryText = finished!.summary.lines.join(' ').toLowerCase();
    expect(summaryText).not.toContain('mastered');
    expect(summaryText).not.toMatch(/\b\d+(\.\d+)?%\b/);
  });

  it('49. a completed lesson writes exactly ONE honest progress record', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
    });
    const service = createLessonService(ctx);

    const session = (await service.startLesson()).session!;
    const reviewStep = session.plan.steps.find((step) => step.capability === 'review-service')!;
    const material = await service.prepareStep(reviewStep.id);
    if (material?.kind === 'review') {
      await service.submitReviewAnswer(material.candidates[0].id, 'deadline', reviewStep.id);
    }
    await service.completeStep(reviewStep.id);
    for (const step of session.plan.steps) {
      if (step.id === reviewStep.id) continue;
      await service.completeStep(step.id);
    }

    const finished = await service.completeLesson();
    expect(finished?.summary.persistedProgress).toBe(true);

    const records = await ctx.progress.list(ctx.learnerId, 50);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.sessionsCompleted).toBe(1);
    expect(record.turnsCompleted).toBe(finished!.summary.itemsPracticed);
    expect(record.turnsCompleted).toBeGreaterThan(0);
    // The lesson claims only what it really did — never mastery it does not own.
    expect(record.newWordsLearned).toBe(0);
    expect(record.weaknessesImproved).toBe(0);
    expect(record.weaknessesWorsened).toBe(0);
    expect(record.listeningScore).toBeUndefined();
    expect(record.speakingScore).toBeUndefined();
    expect(record.fluencyScore).toBeUndefined();
    expect(record.confidenceScore).toBeUndefined();
    expect(record.pronunciationScore).toBeUndefined();
    expect(record.grammarScore).toBeUndefined();
    expect(record.vocabularyScore).toBeUndefined();
    expect(record.notes).toContain('Adaptive lesson');
    expect(record.windowStart).toBe(session.startedAt);

    // Idempotent: completing twice never writes a second record.
    await service.completeLesson();
    expect(await ctx.progress.list(ctx.learnerId, 50)).toHaveLength(1);
  });

  it('50. the lesson never writes a second session record through sub-engines', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
    });
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const listeningStep = session.plan.steps.find((step) => step.type === 'listening')!;
    const material = await service.prepareStep(listeningStep.id);
    if (material?.kind === 'listening') {
      await service.submitListeningAnswer(
        material.exercises[0].id,
        material.exercises[0].expectedAnswer,
        listeningStep.id,
      );
    }
    for (const step of session.plan.steps) await service.completeStep(step.id);
    await service.completeLesson();

    const records = await ctx.progress.list(ctx.learnerId, 50);
    expect(records).toHaveLength(1);
    expect(records[0].notes).toContain('Adaptive lesson');
  });

  it('51. an unfinished lesson is recoverable, and only in memory', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary' });
    const service = createLessonService(ctx);

    expect(service.getCurrentSession()).toBeNull();
    const session = (await service.startLesson()).session!;
    await service.prepareStep();
    await service.completeStep();

    const resumable = service.getCurrentSession();
    expect(resumable?.id).toBe(session.id);
    expect(resumable?.plan.id).toBe(session.plan.id);
    expect(resumable?.steps.filter((entry) => entry.status === 'completed')).toHaveLength(1);

    // Starting again resumes instead of silently discarding the learner's work.
    const resumed = await service.startLesson();
    expect(resumed.status).toBe('started');
    if (resumed.status === 'started') expect(resumed.resumed).toBe(true);

    // A new service instance (app restart) has no in-memory lesson — and says so.
    const fresh = createLessonService(ctx);
    expect(fresh.getCurrentSession()).toBeNull();
    const today = await fresh.getTodayPractice();
    expect(today.status === 'ready' ? today.resume : undefined).toBeUndefined();
  });

  it('52. finishing a lesson clears the plan cache so the next lesson reacts to new evidence', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    const service = createLessonService(ctx);

    const first = await service.planLesson();
    const session = (await service.startLesson()).session!;
    for (const step of session.plan.steps) await service.completeStep(step.id);
    await service.completeLesson();

    const second = await service.planLesson();
    expect(second.plan).not.toBe(first.plan);
    expect(service.getCurrentSession()).toBeNull();
    expect(service.getLastSummary()?.stepsCompleted).toBe(session.plan.steps.length);
  });
});

/* ========================================================================= *
 * 6. Failure isolation
 * ========================================================================= */

describe('Service — failure isolation', () => {
  it('53. a failing review service degrades one step to unavailable, not the lesson', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary' });
    const brokenReview: ReviewPort = {
      planSession: async () => {
        throw new Error('review offline');
      },
      evaluateAnswer: async () => {
        throw new Error('review offline');
      },
      recordPracticeResult: async () => {
        throw new Error('review offline');
      },
    };
    const service = createLessonService(ctx, { review: brokenReview });
    const session = (await service.startLesson()).session!;
    expect(session.plan.steps.length).toBeGreaterThanOrEqual(MIN_LESSON_STEPS);

    const reviewStep = session.plan.steps.find((step) => step.capability === 'review-service')!;
    const material = await service.prepareStep(reviewStep.id);
    expect(material?.kind).toBe('unavailable');
    if (material?.kind !== 'unavailable') return;
    expect(material.message.toLowerCase()).toContain('unavailable');

    // Other steps still work and the plan is unchanged.
    const otherStep = session.plan.steps.find((step) => step.id !== reviewStep.id)!;
    const otherMaterial = await service.prepareStep(otherStep.id);
    expect(otherMaterial?.kind).not.toBe('unavailable');
    expect(service.getCurrentSession()?.plan.id).toBe(session.plan.id);
    expect(service.getCurrentSession()?.plan.steps).toHaveLength(session.plan.steps.length);

    const finished = await service.completeLesson();
    expect(finished?.summary.stepsUnavailable).toBeGreaterThanOrEqual(1);
  });

  it('54. a failing listening service degrades only the listening step', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
    });
    const brokenListening: ListeningPort = {
      startSession: async () => {
        throw new Error('listening offline');
      },
      evaluateAnswer: async () => {
        throw new Error('listening offline');
      },
    };
    const service = createLessonService(ctx, { listening: brokenListening });
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'listening')!;
    const material = await service.prepareStep(step.id);
    expect(material?.kind).toBe('unavailable');
    if (material?.kind === 'unavailable') {
      expect(material.message.toLowerCase()).toContain('nothing was changed');
    }
    const state = service.getCurrentSession()?.steps.find((entry) => entry.stepId === step.id);
    expect(state?.status).toBe('unavailable');
    expect(state?.practicedItems).toBe(0);
    // The plan itself is untouched.
    expect(session.plan.steps.length).toBeGreaterThanOrEqual(MIN_LESSON_STEPS);
  });

  it('55. an empty review queue reports honestly instead of inventing items', async () => {
    const ctx = await createContext();
    // A due review count that the queue cannot actually serve any more.
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const reviewStep = session.plan.steps.find((step) => step.capability === 'review-service');
    if (!reviewStep) return; // no review-family step planned: nothing to assert
    const material = await service.prepareStep(reviewStep.id);
    expect(material?.kind).toBe('unavailable');
    if (material?.kind === 'unavailable') {
      expect(material.message.toLowerCase()).toMatch(/nothing is due|no .* items/);
    }
  });

  it('56. an AI failure never breaks the lesson', async () => {
    const ctx = await createContext();
    await seedWeakness(ctx, {
      type: 'natural_expression',
      status: 'confirmed',
      referenceId: uid(111),
      notes: 'I am interesting in this',
    });
    const service = createLessonService(ctx, { aiProvider: fakeAI({ fail: true }) });
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'speaking')!;
    const material = await service.prepareStep(step.id);
    expect(material?.kind).toBe('speaking');

    const outcome = await service.submitSpeakingAnswer('I am interesting in this', step.id);
    if (outcome?.result.kind !== 'speaking') throw new Error('expected speaking result');
    expect(outcome.result.feedback.evaluatedBy).toBe('unavailable');
    expect(outcome.result.feedback.correction).toBeNull();

    const completed = await service.completeStep(step.id);
    expect(completed?.steps.find((entry) => entry.stepId === step.id)?.status).toBe('completed');
    expect(service.getCurrentSession()?.plan.steps).toHaveLength(session.plan.steps.length);
  });

  it('57. a failing pronunciation engine degrades to an honest attempt record', async () => {
    const ctx = await createContext();
    await seedPronunciation(ctx, 'development');
    const service = createLessonService(ctx, { pronunciation: failingPronunciation() });
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'pronunciation')!;
    await service.prepareStep(step.id);

    const outcome = await service.submitPronunciationAttempt('development', step.id);
    if (outcome?.result.kind !== 'pronunciation') throw new Error('expected pronunciation result');
    expect(outcome.result.unavailable).toBe(true);
    expect(outcome.result.observationsDetected).toBe(0);
    expect(outcome.result.lines.join(' ').toLowerCase()).toContain('failed');

    const rows = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 10 });
    expect(rows[0].occurrenceCount).toBe(2);
  });

  it('58. submitting an unknown item or an empty answer is rejected honestly', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary' });
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const reviewStep = session.plan.steps.find((step) => step.capability === 'review-service');
    if (reviewStep) await service.prepareStep(reviewStep.id);

    const unknown = await service.submitReviewAnswer('not-a-real-candidate', 'deadline');
    expect(unknown?.result.kind).toBe('none');
    if (unknown?.result.kind === 'none') expect(unknown.result.message.length).toBeGreaterThan(5);

    const emptySpeaking = await service.submitSpeakingAnswer('   ');
    expect(emptySpeaking?.result.kind).toBe('none');

    const stores = await snapshotStores(ctx);
    expect(stores.progressRows).toHaveLength(0);
  });
});

/* ========================================================================= *
 * 7. No duplication, no fabrication, composition + navigation (structural)
 * ========================================================================= */

describe('Adaptive lessons — architecture, composition and UI wiring', () => {
  const serviceSrc = readFileSync(join(__dirname, './service.ts'), 'utf8');
  const plannerSrc = readFileSync(join(__dirname, './planner.ts'), 'utf8');
  const indexSrc = readFileSync(join(__dirname, './index.ts'), 'utf8');
  const speakingSrc = readFileSync(join(__dirname, './speaking.ts'), 'utf8');
  const promptsSrc = readFileSync(join(__dirname, './prompts.ts'), 'utf8');
  const typesSrc = readFileSync(join(__dirname, './types.ts'), 'utf8');
  const lessonScreenSrc = readFileSync(
    join(__dirname, '../screens/AdaptiveLessonScreen.tsx'),
    'utf8',
  );
  const homeScreenSrc = readFileSync(join(__dirname, '../screens/HomeScreen.tsx'), 'utf8');
  const navigatorSrc = readFileSync(join(__dirname, '../navigation/RootNavigator.tsx'), 'utf8');
  const moduleSources = [serviceSrc, plannerSrc, indexSrc, speakingSrc, promptsSrc, typesSrc];

  it('59. the engine orchestrates existing systems instead of rebuilding them', () => {
    expect(serviceSrc).toContain('planAdaptiveLesson');
    expect(serviceSrc).toContain('this.deps.review');
    expect(serviceSrc).toMatch(/review\.(planSession|evaluateAnswer|recordPracticeResult)/);
    expect(serviceSrc).toContain('deps.progress');
    expect(serviceSrc).toMatch(/listening\.startSession/);
    expect(serviceSrc).toMatch(/listening\.evaluateAnswer/);
    expect(serviceSrc).toMatch(/speaking\.evaluate/);
    expect(serviceSrc).toMatch(/engine\.analyzeSpokenTurn/);
    expect(speakingSrc).toContain('createConversationEngine');
    expect(speakingSrc).toContain('createConversationOrchestrator');
    expect(speakingSrc).toContain('createConversationSession');
    // Identity parsing / stable ids reuse the existing listening helpers.
    expect(serviceSrc).toContain('parseWeaknessIdentity');
    expect(plannerSrc).toContain('stableReferenceId');
    expect(serviceSrc).toContain('prettifyPronunciationIdentity');
  });

  it('60. no second weakness model, scheduler, evaluator or persistence layer', () => {
    for (const raw of moduleSources) {
      const src = stripComments(raw);
      expect(src).not.toMatch(/CREATE TABLE|ALTER TABLE|PRAGMA user_version/i);
      expect(raw).not.toContain('data/local/sqlite/schema');
      expect(src).not.toContain('transitionWeaknessLifecycle');
      expect(src).not.toContain('calculateNextIntervalDays');
      expect(src).not.toMatch(/new ReviewPlanner|new ReviewEvaluator/);
      expect(src).not.toMatch(/planListeningSession|buildWeaknessExercise/);
      expect(src).not.toContain('recordSessionCompleted');
      expect(src).not.toContain('completeSession(');
    }
    // The service never touches SQLite or schema code directly.
    expect(serviceSrc).not.toContain('data/local/sqlite');
    expect(plannerSrc).not.toContain('data/local/sqlite');
  });

  it('61. composition never injects a demo provider and adds no new table', () => {
    expect(indexSrc).not.toContain('createDemoAIProvider');
    expect(indexSrc).not.toMatch(/isDemo/);
    expect(indexSrc).toContain('createGeminiAIProvider');
    expect(indexSrc).toContain('getGeminiApiKey');
    expect(indexSrc).toContain('new ReviewService(repos, aiProvider)');
    expect(indexSrc).toContain('createListeningService');
    expect(indexSrc).toContain('createPronunciationEngine');
    expect(indexSrc).toContain('createLearningPersistenceService');
    expect(indexSrc).toContain('createDefaultAdaptiveLessonService');
    expect(speakingSrc).not.toContain('createDemoAIProvider');
  });

  it('62. screens use the service (or composition factory) and never touch SQLite', () => {
    for (const src of [lessonScreenSrc, homeScreenSrc]) {
      expect(src).not.toContain('ExpoSqliteAdapter');
      expect(src).not.toContain('SqlJsAdapter');
      expect(src).not.toContain('data/local/sqlite');
      expect(src).toContain('AdaptiveLessonService');
      expect(src).toContain('createDefaultAdaptiveLessonService');
    }
    expect(homeScreenSrc).toContain('getTodayPractice');
    expect(lessonScreenSrc).toContain('prepareStep');
    expect(lessonScreenSrc).toContain('skipStep');
    expect(lessonScreenSrc).toContain('completeLesson');
    expect(lessonScreenSrc).toContain('submitPronunciationAttempt');
  });

  it('63. Home exposes the Today\'s Practice entry point and opens the lesson route', () => {
    expect(homeScreenSrc).toContain("Today&apos;s Practice");
    expect(homeScreenSrc).toContain("navigation.navigate('AdaptiveLesson')");
    expect(homeScreenSrc).toContain('useFocusEffect');
    expect(homeScreenSrc).toMatch(/no-profile|No profile yet/);
    // Honest labels for fallback content.
    expect(homeScreenSrc).toContain('General practice');
    expect(homeScreenSrc).toContain('Partly personalized');
    expect(stripComments(homeScreenSrc)).not.toMatch(/\b(XP|streak|badge|leaderboard)\b/i);
  });

  it('64. the navigator pushes the lesson screen from the existing tab structure', () => {
    expect(navigatorSrc).toContain('createStackNavigator');
    expect(navigatorSrc).toContain('createBottomTabNavigator');
    expect(navigatorSrc).toContain('AdaptiveLessonScreen');
    expect(navigatorSrc).toContain("name: 'AdaptiveLesson'");
    expect(navigatorSrc).toContain("name: 'MainTabs'");
    // All seven existing tabs are preserved unchanged. Since the Daily
    // Tutor navigation repair, the tab names/order come from the
    // single-source route tables (./routes) and each tab still mounts its
    // existing screen component with no props.
    const routesSrc = readFileSync(join(__dirname, '../navigation/routes.ts'), 'utf8');
    for (const tab of ['Home', 'Talk', 'Listening', 'Vocabulary', 'Review', 'Progress', 'Settings']) {
      expect(routesSrc).toContain(`'${tab}'`);
      expect(navigatorSrc).toContain(`${tab}: ${tab}Screen`);
    }
    expect(navigatorSrc).toContain('MAIN_TAB_ROUTES');
    expect(navigatorSrc).toContain('NavigationContainer');
  });

  it('65. no new dependency is introduced by the feature', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const files = [
      './types.ts',
      './planner.ts',
      './prompts.ts',
      './speaking.ts',
      './service.ts',
      './index.ts',
      '../screens/AdaptiveLessonScreen.tsx',
      '../screens/HomeScreen.tsx',
      '../navigation/RootNavigator.tsx',
    ];
    const importPattern = /(?:from|import)\s+\(?\s*'([^'.][^']*)'/g;
    for (const file of files) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      let match = importPattern.exec(src);
      while (match !== null) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) {
          const packageName = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0];
          expect(declared.has(packageName), `${file} imports undeclared ${packageName}`).toBe(true);
        }
        match = importPattern.exec(src);
      }
      importPattern.lastIndex = 0;
    }
  });

  it('66. no gamification or fabricated metrics anywhere in the feature', () => {
    const sources = [...moduleSources, lessonScreenSrc, homeScreenSrc];
    for (const raw of sources) {
      const src = stripComments(raw);
      expect(src).not.toMatch(/\b(XP|streak|streaks|badge|badges|leaderboard|levelUp)\b/i);
      expect(src).not.toMatch(
        /(listeningScore|speakingScore|fluencyScore|confidenceScore|pronunciationScore|grammarScore|vocabularyScore)\s*:/,
      );
      expect(src).not.toMatch(/estimatedMinutes|durationMinutes|minutesLeft/);
    }
  });

  it('67. the speaking port refuses to invent feedback without a provider', () => {
    expect(speakingSrc).toContain('available = Boolean(deps.aiProvider)');
    expect(speakingSrc).toContain('evaluatedBy: \'unavailable\'');
    expect(promptsSrc).toContain('SPEAKING_FEEDBACK_UNAVAILABLE_NOTE');
    expect(promptsSrc).not.toMatch(/aiProvider|generate\(/);
  });

  it('68. the speaking port works with the real stack and reports failures honestly', async () => {
    const ctx = await createContext();
    const learnerModel = createLearnerModel(ctx.repos);
    await learnerModel.refresh();

    const unavailable = createConversationSpeakingPort({ learnerModel });
    expect(unavailable.available).toBe(false);
    const noProvider = await unavailable.evaluate({
      prompt: 'Talk about your week.',
      answer: 'It was busy.',
      mode: 'intensive',
    });
    expect(noProvider.evaluatedBy).toBe('unavailable');
    expect(noProvider.correction).toBeNull();

    const withProvider = createConversationSpeakingPort({
      learnerModel,
      aiProvider: fakeAI({
        feedback: {
          correction: {
            original: 'It was busy',
            improved: 'It was a busy week',
            explanation: 'Add the noun so the sentence is complete.',
            severity: 'minor',
          },
        },
      }),
    });
    expect(withProvider.available).toBe(true);
    const evaluated = await withProvider.evaluate({
      prompt: 'Talk about your week.',
      answer: 'It was busy.',
      mode: 'intensive',
    });
    expect(evaluated.evaluatedBy).toBe('ai');
    expect(evaluated.lines.join(' ')).toContain('It was a busy week');
    expect(evaluated.lines.join(' ')).not.toMatch(/\b\d+(\.\d+)?%\b/);

    const empty = await withProvider.evaluate({ prompt: 'Talk.', answer: '   ', mode: 'intensive' });
    expect(empty.evaluatedBy).toBe('unavailable');
  });
});

/* ========================================================================= *
 * 8. Hardening regressions — review findings 1 to 5
 * ========================================================================= */

function brokenReviewPort(): ReviewPort {
  return {
    planSession: async () => {
      throw new Error('review offline');
    },
    evaluateAnswer: async () => {
      throw new Error('review offline');
    },
    recordPracticeResult: async () => {
      throw new Error('review offline');
    },
  };
}

function brokenListeningPort(): ListeningPort {
  return {
    startSession: async () => {
      throw new Error('listening offline');
    },
    evaluateAnswer: async () => {
      throw new Error('listening offline');
    },
  };
}

/** A real persisted grammar mistake (the source row a weakness points at). */
async function seedGrammarMistake(ctx: TestContext, pattern: string, correction: string) {
  return ctx.repos.mistakes.recordMistake({
    learnerId: ctx.learnerId,
    category: 'for-vs-since',
    pattern,
    correction,
    explanation: 'Use the present perfect with "since".',
    severity: 'major',
    occurrenceCount: 2,
    lastSeenAt: NOW,
    firstSeenAt: NOW,
    contexts: ['conversation-turn'],
    exampleTurnIds: [],
    resolved: false,
  });
}

/** Put a practiced review item back into the due queue (next-lesson checks). */
async function makeReviewDueAgain(ctx: TestContext, item: ReviewItem): Promise<void> {
  const upsert = ctx.review.upsert;
  if (!upsert) throw new Error('review.upsert is required by this test');
  const stored = (await ctx.review.get(item.id)) ?? item;
  await upsert.call(ctx.review, {
    ...stored,
    id: item.id,
    state: 'learning',
    dueAt: DUE_AT,
    consecutiveCorrect: 0,
  });
}

/** Seed a lesson whose review-family demand spans three specialized steps. */
async function seedMixedReviewQueue(ctx: TestContext): Promise<void> {
  await seedReviewItem(ctx, { kind: 'grammar', prompt: 'Correct this sentence' });
  await seedReviewItem(ctx, { kind: 'vocabulary', prompt: 'Recall this saved word' });
  await seedReviewItem(ctx, { kind: 'expression', prompt: 'Use this saved expression' });
  await seedVocabulary(ctx, 'agenda', 'a list of items to discuss');
  await seedExpression(ctx, 'follow up', 'to check something again later');
}

describe('Hardening — an unavailable step never becomes completed', () => {
  it('69. continuing past an unavailable step keeps it unavailable and counts nothing', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    const service = createLessonService(ctx, { review: brokenReviewPort() });
    const session = (await service.startLesson()).session!;
    const reviewSteps = session.plan.steps.filter(
      (step) => step.capability === 'review-service',
    );
    expect(reviewSteps.length).toBeGreaterThan(0);

    for (const step of reviewSteps) {
      const material = await service.prepareStep(step.id);
      expect(material?.kind).toBe('unavailable');
    }

    const beforeProgress = service.getProgress()!;
    expect(beforeProgress.completedSteps).toBe(0);
    expect(beforeProgress.unavailableSteps).toBe(reviewSteps.length);

    // The UI shows "Continue" here: it may only advance the lesson.
    const target = reviewSteps[0];
    const targetIndex = session.plan.steps.indexOf(target);
    const after = await service.completeStep(target.id);
    const state = after?.steps.find((entry) => entry.stepId === target.id);
    expect(state?.status).toBe('unavailable');
    expect(state?.practicedItems).toBe(0);
    expect(state?.completedAt).toBeUndefined();
    expect(after?.currentIndex).toBe(
      Math.min(targetIndex + 1, session.plan.steps.length - 1),
    );

    const progress = service.getProgress()!;
    expect(progress.completedSteps).toBe(0);
    expect(progress.unavailableSteps).toBe(reviewSteps.length);
    expect(progress.practicedItems).toBe(0);
    expect(progress.label).toContain('without material');

    // Finishing the rest of the lesson never launders the unavailable steps.
    for (const step of session.plan.steps) await service.completeStep(step.id);
    const finished = await service.completeLesson();
    const summary = finished!.summary;
    expect(summary.stepsUnavailable).toBe(reviewSteps.length);
    expect(summary.stepsCompleted).toBe(session.plan.steps.length - reviewSteps.length);
    expect(summary.itemsPracticed).toBe(0);
    expect(summary.persistedProgress).toBe(false);
    expect(
      finished!.session.steps.filter((entry) => entry.status === 'unavailable'),
    ).toHaveLength(reviewSteps.length);
    expect(await ctx.progress.list(ctx.learnerId, 50)).toHaveLength(0);
  });

  it('70. skipping an unavailable step keeps its honest status and zero counts', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    const service = createLessonService(ctx, { review: brokenReviewPort() });
    const session = (await service.startLesson()).session!;
    const target = session.plan.steps.find(
      (step) => step.capability === 'review-service',
    )!;
    const material = await service.prepareStep(target.id);
    expect(material?.kind).toBe('unavailable');

    const after = await service.skipStep(target.id);
    const state = after?.steps.find((entry) => entry.stepId === target.id);
    // There was nothing to practice, so this is not a learner skip either.
    expect(state?.status).toBe('unavailable');
    expect(state?.practicedItems).toBe(0);
    expect(state?.note?.toLowerCase()).not.toContain('skipped');

    const progress = service.getProgress()!;
    expect(progress.skippedSteps).toBe(0);
    expect(progress.unavailableSteps).toBeGreaterThanOrEqual(1);
    expect(progress.practicedItems).toBe(0);
  });

  it('71. a lesson with no servable practice persists nothing, even with wrap-up done', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary' });
    const service = createLessonService(ctx, {
      review: brokenReviewPort(),
      listening: brokenListeningPort(),
    });
    const session = (await service.startLesson()).session!;
    for (const step of session.plan.steps) {
      await service.prepareStep(step.id);
      await service.completeStep(step.id);
    }

    const finished = await service.completeLesson();
    const summary = finished!.summary;
    expect(summary.itemsPracticed).toBe(0);
    expect(summary.practiceStepsCompleted).toBe(0);
    expect(summary.persistedProgress).toBe(false);
    expect(summary.stepsUnavailable).toBeGreaterThan(0);
    // Every real-activity counter stays at zero — nothing is claimed for a
    // step the owning engine could not serve.
    expect(summary.reviewItemsPracticed).toBe(0);
    expect(summary.listeningExercisesPracticed).toBe(0);
    expect(summary.speakingPromptsAnswered).toBe(0);
    expect(summary.pronunciationTargetsPracticed).toBe(0);
    expect(summary.lexicalItemsPracticed).toBe(0);
    expect(await ctx.progress.list(ctx.learnerId, 50)).toHaveLength(0);

    // Only a step where a real item was practiced may be counted as completed
    // practice — a prompt that was merely continued past counts for nothing.
    const completedWithPractice = finished!.session.steps.filter(
      (entry, index) =>
        entry.status === 'completed' &&
        entry.practicedItems > 0 &&
        finished!.session.plan.steps[index].type !== 'wrap_up',
    );
    expect(completedWithPractice).toHaveLength(summary.practiceStepsCompleted);
    expect(summary.practiceStepsCompleted).toBe(0);
    expect(
      finished!.session.steps
        .filter((entry) => entry.status === 'unavailable')
        .every((entry) => entry.practicedItems === 0),
    ).toBe(true);

    const text = summary.lines.join(' ').toLowerCase();
    expect(text).toContain('nothing was saved');
    expect(text).not.toContain('saved to your progress history');
  });
});

describe('Hardening — a weakness-targeted step serves its real target', () => {
  it('72. a vocabulary weakness step serves the candidate linked to that weakness', async () => {
    const ctx = await createContext();
    const targetItem = await seedVocabulary(ctx, 'invoice', 'a bill listing charges');
    const weakness = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      referenceId: targetItem.id,
      notes: 'invoice',
      occurrenceCount: 3,
    });
    // Unrelated due vocabulary that must never be presented as the target.
    await seedVocabulary(ctx, 'agenda', 'a list of items to discuss');

    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.capability === 'review-service' && entry.target.id === weakness.id,
    );
    expect(step).toBeTruthy();

    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('review');
    if (material?.kind !== 'review') throw new Error('expected review material');
    expect(material.targetMatched).toBe(true);
    // The genuinely linked candidate is served FIRST, matched by persisted id.
    expect(material.candidates[0].referenceId).toBe(targetItem.id);
    expect(material.candidates[0].kind).toBe('vocabulary');
    expect(candidateMatchesWeakness(material.candidates[0], weakness)).toBe(true);
  });

  it('73. a grammar weakness step serves the candidate linked to that weakness', async () => {
    const ctx = await createContext();
    const mistake = await seedGrammarMistake(
      ctx,
      'I live here since 2020',
      'I have lived here since 2020',
    );
    const weakness = await seedWeakness(ctx, {
      type: 'grammar',
      status: 'relapsed',
      referenceId: mistake.id,
      notes: 'I live here since 2020',
      occurrenceCount: 4,
    });
    // An unrelated due grammar item of the SAME kind.
    await seedReviewItem(ctx, { kind: 'grammar', prompt: 'Correct this unrelated sentence' });

    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.capability === 'review-service' && entry.target.id === weakness.id,
    );
    expect(step).toBeTruthy();

    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('review');
    if (material?.kind !== 'review') throw new Error('expected review material');
    expect(material.targetMatched).toBe(true);
    expect(material.candidates[0].contextSentence).toBe('I live here since 2020');
    expect(material.candidates[0].expectedAnswer).toBe('I have lived here since 2020');
    // The link is the persisted weakness / mistake identity, not loose text.
    expect([weakness.id, mistake.id]).toContain(material.candidates[0].referenceId);
    expect(candidateMatchesWeakness(material.candidates[0], weakness)).toBe(true);
  });

  it('74. an unrelated same-kind item can never masquerade as the targeted weakness', async () => {
    const ctx = await createContext();
    const weakness = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      // The underlying item left the due queue after planning.
      referenceId: uid(777),
      notes: 'itinerary',
      occurrenceCount: 3,
    });
    await seedVocabulary(ctx, 'agenda', 'a list of items to discuss');

    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.capability === 'review-service' && entry.target.id === weakness.id,
    );
    expect(step).toBeTruthy();

    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('review');
    if (material?.kind !== 'review') throw new Error('expected review material');
    // Honest degradation: real practice, explicitly NOT the targeted item.
    expect(material.targetMatched).toBe(false);
    expect(material.note?.toLowerCase()).toContain('not that targeted item');
    expect(
      material.candidates.every((candidate) => !candidateMatchesWeakness(candidate, weakness)),
    ).toBe(true);

    // The session state carries the same honest note.
    const state = service.getCurrentSession()?.steps.find((entry) => entry.stepId === step!.id);
    expect(state?.note?.toLowerCase()).toContain('no longer in your due queue');

    // The UI stops claiming the learner's history for a degraded step.
    const screen = readFileSync(
      join(__dirname, '../screens/AdaptiveLessonScreen.tsx'),
      'utf8',
    );
    expect(screen).toContain('targetMatched === false');
    expect(screen).toContain('Other real practice');
  });
});

describe('Hardening — one bounded pool cannot starve planned steps', () => {
  it('75. Quick Review, Vocabulary and Expression are all served from ONE pool', async () => {
    const ctx = await createContext();
    await seedMixedReviewQueue(ctx);

    const calls = { plan: 0, evaluate: 0, record: 0 };
    const service = createLessonService(ctx, {
      review: countingReview(new ReviewService(ctx.repos), calls),
    });
    const session = (await service.startLesson()).session!;
    const reviewSteps = session.plan.steps.filter(
      (step) => step.capability === 'review-service',
    );
    expect(reviewSteps.find((step) => step.type === 'vocabulary')).toBeTruthy();
    expect(reviewSteps.find((step) => step.type === 'expression')).toBeTruthy();
    expect(reviewSteps.find((step) => !step.reviewKindFilter)).toBeTruthy();

    const servedIds: string[] = [];
    // Prepared in PLAN ORDER: the generic Review step comes first and must not
    // consume candidates the specialized steps were planned around.
    for (const step of reviewSteps) {
      const material = await service.prepareStep(step.id);
      expect(material?.kind).toBe('review');
      if (material?.kind !== 'review') continue;
      expect(material.candidates.length).toBeGreaterThan(0);
      expect(material.candidates.length).toBeLessThanOrEqual(step.bounds.maxItems);
      if (step.reviewKindFilter) {
        for (const candidate of material.candidates) {
          expect(candidate.kind).toBe(step.reviewKindFilter);
        }
      }
      for (const candidate of material.candidates) servedIds.push(candidate.id);
    }

    // Disjoint allocation: no candidate is served (or practiced) twice.
    expect(new Set(servedIds).size).toBe(servedIds.length);
    expect(servedIds.length).toBeGreaterThan(2);
    // Still exactly ONE bounded pool read for the whole lesson.
    expect(calls.plan).toBe(1);
  });

  it('76. the bounded pool is sized from the planned review-family demand', async () => {
    const ctx = await createContext();
    await seedMixedReviewQueue(ctx);

    const seen: { minItems?: number; maxItems?: number; targetItems?: number }[] = [];
    const inner: ReviewPort = new ReviewService(ctx.repos);
    const service = createLessonService(ctx, {
      review: {
        planSession: (learnerId, opts) => {
          seen.push({
            minItems: opts?.minItems,
            maxItems: opts?.maxItems,
            targetItems: opts?.targetItems,
          });
          return inner.planSession(learnerId, opts);
        },
        evaluateAnswer: (candidate, userAnswer, coachingContext) =>
          inner.evaluateAnswer(candidate, userAnswer, coachingContext),
        recordPracticeResult: (learnerId, candidate, userAnswer, evaluation) =>
          inner.recordPracticeResult(learnerId, candidate, userAnswer, evaluation),
      },
    });

    const session = (await service.startLesson()).session!;
    const reviewSteps = session.plan.steps.filter(
      (step) => step.capability === 'review-service',
    );
    for (const step of reviewSteps) await service.prepareStep(step.id);

    const demand = reviewSteps.reduce(
      (sum, step) => sum + Math.max(1, step.bounds.maxItems),
      0,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].maxItems).toBe(reviewPoolSizeFor(session.plan));
    // Large enough for every legitimately planned review step …
    expect(seen[0].maxItems).toBeGreaterThanOrEqual(demand);
    // … and still a small bounded read (never an arbitrary oversized scan).
    expect(seen[0].maxItems).toBeLessThanOrEqual(12);
    expect(seen[0].minItems).toBe(1);
  });

  it('77. candidate allocation is deterministic across identical lessons', async () => {
    const signatures: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const ctx = await createContext();
      await seedMixedReviewQueue(ctx);
      const service = createLessonService(ctx);
      const session = (await service.startLesson()).session!;
      const reviewSteps = session.plan.steps.filter(
        (step) => step.capability === 'review-service',
      );
      const signature: string[] = [];
      for (const step of reviewSteps) {
        const material = await service.prepareStep(step.id);
        signature.push(
          `${step.type}/${step.reviewKindFilter ?? 'any'}:` +
            (material?.kind === 'review'
              ? material.candidates
                  .map((candidate) => `${candidate.kind}|${candidate.prompt}`)
                  .join(',')
              : 'unavailable'),
        );
      }
      signatures.push(signature.join(' ;; '));
    }
    expect(signatures[0]).toBe(signatures[1]);
    expect(signatures[0]).not.toContain('unavailable');
  });
});

describe('Hardening — wrap-up is structure, never practice', () => {
  it('78. skipping every practice step and completing wrap-up saves no progress', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;

    for (const step of session.plan.steps) {
      await service.prepareStep(step.id);
      if (step.type === 'wrap_up') await service.completeStep(step.id);
      else await service.skipStep(step.id);
    }

    const finished = await service.completeLesson();
    const summary = finished!.summary;
    expect(summary.stepsCompleted).toBe(1); // the structural wrap-up only
    expect(summary.practiceStepsCompleted).toBe(0);
    expect(summary.totalPracticeSteps).toBe(session.plan.steps.length - 1);
    expect(summary.itemsPracticed).toBe(0);
    expect(summary.persistedProgress).toBe(false);
    expect(await ctx.progress.list(ctx.learnerId, 50)).toHaveLength(0);

    const text = summary.lines.join(' ').toLowerCase();
    expect(text).toContain('skipped');
    expect(text).toContain('nothing was saved');
    expect(text).not.toContain('saved to your progress history');
  });

  it('79. one genuine practice item writes exactly one record with real counts', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;

    const reviewStep = session.plan.steps.find(
      (step) => step.capability === 'review-service',
    )!;
    const material = await service.prepareStep(reviewStep.id);
    if (material?.kind !== 'review') throw new Error('expected review material');
    const outcome = await service.submitReviewAnswer(
      material.candidates[0].id,
      'deadline',
      reviewStep.id,
    );
    expect(outcome?.result.kind).toBe('review');

    // Every step is finished, including the structural wrap-up.
    for (const step of session.plan.steps) await service.completeStep(step.id);
    const finished = await service.completeLesson();
    const summary = finished!.summary;
    expect(summary.itemsPracticed).toBe(1);
    expect(summary.practiceStepsCompleted).toBe(1);
    expect(summary.totalPracticeSteps).toBe(session.plan.steps.length - 1);
    expect(summary.stepsCompleted).toBe(session.plan.steps.length);
    expect(summary.persistedProgress).toBe(true);

    const records = await ctx.progress.list(ctx.learnerId, 50);
    expect(records).toHaveLength(1);
    expect(records[0].sessionsCompleted).toBe(1);
    // Wrap-up completion contributes nothing: turns are real practiced items.
    expect(records[0].turnsCompleted).toBe(1);
    expect(records[0].turnsCompleted).toBe(summary.itemsPracticed);
    expect(records[0].notes).toContain('1 practice item');
    expect(records[0].notes).toContain('Adaptive lesson');
    expect((records[0].notes ?? '').toLowerCase()).not.toContain('wrap');
  });
});

describe('Hardening — duplicate submissions cannot inflate evidence', () => {
  it('80. the same review candidate and listening exercise count once', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, { kind: 'vocabulary', expectedResponse: 'deadline' });
    await seedWeakness(ctx, {
      type: 'listening',
      status: 'confirmed',
      referenceId: stableReferenceId('word_recognition:deadline'),
      notes: 'word_recognition:deadline',
      occurrenceCount: 3,
    });

    const reviewCalls = { plan: 0, evaluate: 0, record: 0 };
    const listeningCalls = { start: 0, evaluate: 0 };
    const service = createLessonService(ctx, {
      review: countingReview(new ReviewService(ctx.repos), reviewCalls),
      listening: countingListening(createListeningService(ctx.adapter), listeningCalls),
    });
    const session = (await service.startLesson()).session!;

    // --- review: the same candidate submitted twice (double tap / retry) ---
    const reviewStep = session.plan.steps.find(
      (step) => step.capability === 'review-service',
    )!;
    const reviewMaterial = await service.prepareStep(reviewStep.id);
    if (reviewMaterial?.kind !== 'review') throw new Error('expected review material');
    const candidate = reviewMaterial.candidates[0];

    const first = await service.submitReviewAnswer(candidate.id, 'deadline', reviewStep.id);
    expect(first?.result.kind).toBe('review');
    if (first?.result.kind === 'review') expect(first.result.duplicate).toBeUndefined();

    const second = await service.submitReviewAnswer(candidate.id, 'deadline', reviewStep.id);
    expect(second?.result.kind).toBe('review');
    if (second?.result.kind === 'review') expect(second.result.duplicate).toBe(true);

    expect(reviewCalls.evaluate).toBe(1);
    expect(reviewCalls.record).toBe(1);
    const reviewState = service
      .getCurrentSession()
      ?.steps.find((entry) => entry.stepId === reviewStep.id);
    expect(reviewState?.practicedItems).toBe(1);

    // --- listening: the same exercise submitted twice ---
    const listeningStep = session.plan.steps.find((step) => step.type === 'listening')!;
    const listeningMaterial = await service.prepareStep(listeningStep.id);
    if (listeningMaterial?.kind !== 'listening') throw new Error('expected listening material');
    const exercise = listeningMaterial.exercises[0];

    const firstListening = await service.submitListeningAnswer(
      exercise.id,
      exercise.expectedAnswer,
      listeningStep.id,
    );
    expect(firstListening?.result.kind).toBe('listening');
    const secondListening = await service.submitListeningAnswer(
      exercise.id,
      exercise.expectedAnswer,
      listeningStep.id,
    );
    expect(secondListening?.result.kind).toBe('listening');
    if (secondListening?.result.kind === 'listening') {
      expect(secondListening.result.duplicate).toBe(true);
    }
    expect(listeningCalls.evaluate).toBe(1);
    const listeningState = service
      .getCurrentSession()
      ?.steps.find((entry) => entry.stepId === listeningStep.id);
    expect(listeningState?.practicedItems).toBe(1);

    // The existing review history was written exactly once for that item.
    const storedItems = await ctx.review.list(ctx.learnerId, 50);
    expect(storedItems.filter((entry) => entry.reviewCount === 1)).toHaveLength(1);
    expect(storedItems.every((entry) => entry.reviewCount <= 1)).toBe(true);
  });

  it('81. a repeated identical pronunciation transcript is not counted twice', async () => {
    const ctx = await createContext();
    const row = await ctx.pronunciation.recordWeakness({
      learnerId: ctx.learnerId,
      targetSound: 'word_stress:development',
      wordExamples: ['development'],
      occurrenceCount: 2,
      lastSeenAt: NOW,
      firstSeenAt: NOW,
      contexts: [],
      exampleTurnIds: [],
      resolved: false,
      notes: 'word_stress:development',
    });

    let engineCalls = 0;
    const engine = createPronunciationEngine(ctx.adapter);
    const service = createLessonService(ctx, {
      pronunciation: {
        analyzeSpokenTurn: async (input) => {
          engineCalls += 1;
          return engine.analyzeSpokenTurn(input);
        },
      },
    });
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'pronunciation')!;
    await service.prepareStep(step.id);

    const first = await service.submitPronunciationAttempt('devlopment', step.id);
    expect(first?.result.kind).toBe('pronunciation');
    if (first?.result.kind === 'pronunciation') expect(first.result.duplicate).toBeUndefined();

    // Double tap / re-render: the engine is not asked again and nothing inflates.
    const repeat = await service.submitPronunciationAttempt('devlopment', step.id);
    if (repeat?.result.kind !== 'pronunciation') throw new Error('expected pronunciation');
    expect(repeat.result.duplicate).toBe(true);
    expect(engineCalls).toBe(1);
    const stateAfterRepeat = service
      .getCurrentSession()
      ?.steps.find((entry) => entry.stepId === step.id);
    expect(stateAfterRepeat?.practicedItems).toBe(1);

    // A genuinely different attempt is still accepted and judged.
    const different = await service.submitPronunciationAttempt('development', step.id);
    if (different?.result.kind !== 'pronunciation') throw new Error('expected pronunciation');
    expect(different.result.duplicate).toBeUndefined();
    expect(engineCalls).toBe(2);
    const stateAfterSecond = service
      .getCurrentSession()
      ?.steps.find((entry) => entry.stepId === step.id);
    expect(stateAfterSecond?.practicedItems).toBe(2);

    // Occurrence counts stay owned by the engine and never regress.
    const rows = await ctx.pronunciation.listWeaknesses(ctx.learnerId, { limit: 50 });
    const original = rows.find((entry) => entry.id === row.id);
    expect(original).toBeTruthy();
    expect(original!.occurrenceCount).toBeGreaterThanOrEqual(2);
  });

  it('82. the guard is lesson-scoped and never blocks distinct items', async () => {
    const ctx = await createContext();
    const vocabularyItem = await seedReviewItem(ctx, {
      kind: 'vocabulary',
      prompt: 'Recall this saved word',
      expectedResponse: 'deadline',
    });
    await seedReviewItem(ctx, {
      kind: 'grammar',
      prompt: 'Correct this sentence',
      expectedResponse: 'I have lived here since 2020',
    });

    const calls = { plan: 0, evaluate: 0, record: 0 };
    const service = createLessonService(ctx, {
      review: countingReview(new ReviewService(ctx.repos), calls),
    });
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.capability === 'review-service',
    )!;
    const material = await service.prepareStep(step.id);
    if (material?.kind !== 'review') throw new Error('expected review material');
    expect(material.candidates.length).toBeGreaterThanOrEqual(2);

    // Distinct candidates in the same step all keep working.
    for (const candidate of material.candidates) {
      const outcome = await service.submitReviewAnswer(
        candidate.id,
        candidate.expectedAnswer,
        step.id,
      );
      expect(outcome?.result.kind).toBe('review');
      if (outcome?.result.kind === 'review') expect(outcome.result.duplicate).toBeUndefined();
    }
    expect(calls.record).toBe(material.candidates.length);
    const state = service.getCurrentSession()?.steps.find((entry) => entry.stepId === step.id);
    expect(state?.practicedItems).toBe(material.candidates.length);

    // The next lesson may legitimately serve and persist the same item again:
    // the guard is scoped to one lesson, never to the learner's lifetime.
    await makeReviewDueAgain(ctx, vocabularyItem);
    for (const planStep of session.plan.steps) await service.completeStep(planStep.id);
    await service.completeLesson();

    const second = (await service.startLesson()).session!;
    const secondStep = second.plan.steps.find(
      (entry) => entry.capability === 'review-service',
    );
    expect(secondStep).toBeTruthy();
    const secondMaterial = await service.prepareStep(secondStep!.id);
    expect(secondMaterial?.kind).toBe('review');
    if (secondMaterial?.kind !== 'review') throw new Error('expected review material');

    const before = calls.record;
    const outcome = await service.submitReviewAnswer(
      secondMaterial.candidates[0].id,
      secondMaterial.candidates[0].expectedAnswer,
      secondStep!.id,
    );
    expect(outcome?.result.kind).toBe('review');
    if (outcome?.result.kind === 'review') expect(outcome.result.duplicate).toBeUndefined();
    expect(calls.record).toBe(before + 1);
  });
});

describe('Hardening — provenance is claimed from persisted identities only', () => {
  const candidateBase = {
    id: uid(900),
    learnerId: PLAN_LEARNER,
    kind: 'grammar' as const,
    exerciseType: 'sentence_correction' as const,
    prompt: 'Correct the grammatical error in this sentence:',
    expectedAnswer: 'I have lived here since 2020',
    dueAt: DUE_AT,
    consecutiveCorrect: 0,
    reviewCount: 1,
  };

  it('83. review target matching uses persisted ids, never loose text', () => {
    const weakness = {
      id: uid(901),
      learnerId: PLAN_LEARNER,
      type: 'grammar' as const,
      // The persisted source row (a grammar mistake) this weakness points at.
      referenceId: uid(902),
      severity: 0.8,
      status: 'confirmed' as WeaknessStatus,
      lastSeenAt: NOW,
      firstSeenAt: NOW,
      occurrenceCount: 3,
      contexts: [],
      // The learner's own phrase: identical text must NOT create a match.
      notes: 'I live here since 2020',
      evidence: [{ id: uid(902), kind: 'turn' as const, at: NOW, summary: 'observed' }],
      exampleTurnIds: [],
      resolved: false,
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as LearnerWeakness;

    // Linked by the weakness id (how the existing review planner tags mistakes).
    expect(
      candidateMatchesWeakness({ ...candidateBase, referenceId: weakness.id }, weakness),
    ).toBe(true);
    // Linked by the same persisted source row.
    expect(
      candidateMatchesWeakness({ ...candidateBase, referenceId: weakness.referenceId }, weakness),
    ).toBe(true);
    // An unrelated item that merely repeats the same words is NOT the target.
    expect(
      candidateMatchesWeakness(
        {
          ...candidateBase,
          referenceId: uid(903),
          prompt: 'I live here since 2020 — express this more naturally',
          contextSentence: 'I live here since 2020',
        },
        weakness,
      ),
    ).toBe(false);
    // No persisted weakness → no targeted claim at all.
    expect(candidateMatchesWeakness({ ...candidateBase, referenceId: weakness.id }, null)).toBe(
      false,
    );
    expect(
      candidateMatchesWeakness({ ...candidateBase, referenceId: weakness.id }, undefined),
    ).toBe(false);
  });

  it('84. listening provenance is claimed only for a persisted-identity match', () => {
    const serviceSrc = readFileSync(join(__dirname, 'service.ts'), 'utf8');
    // Identity is resolved first …
    expect(serviceSrc).toContain('const identityMatch = exercises.findIndex');
    expect(serviceSrc).toContain('exercise.weaknessReferenceId === row.referenceId');
    // … and a text-only match still carries the honest "not the target" note.
    expect(serviceSrc).toContain('NOT_TARGETED_NOTE');
    const honestBranches = serviceSrc.split('identityMatch < 0').length - 1;
    expect(honestBranches).toBeGreaterThanOrEqual(2);
    // Review-family provenance has no text-matching branch at all.
    const start = serviceSrc.indexOf('export function candidateMatchesWeakness');
    const body = serviceSrc.slice(start, serviceSrc.indexOf('\n}', start));
    expect(body).toContain('candidate.referenceId === weakness.id');
    expect(body).toContain('candidate.referenceId === weakness.referenceId');
    expect(body).not.toMatch(/toLowerCase\(|\.includes\(|\.indexOf\(/);
  });
});

/* ========================================================================= *
 * 9. Allocation fairness regressions (blocking finding: specialized starvation)
 * ========================================================================= */

describe('Hardening — fair review candidate allocation (no specialized starvation)', () => {
  /** Prepare every review-family step and collect what each one was served. */
  async function collectAllocation(
    service: AdaptiveLessonService,
    session: { plan: AdaptiveLessonPlan },
    order: 'plan' | 'reverse' = 'plan',
  ): Promise<Map<string, { material: Awaited<ReturnType<typeof service.prepareStep>>; ids: string[] }>> {
    const reviewSteps = session.plan.steps.filter(
      (step) => step.capability === 'review-service',
    );
    const ordered = order === 'plan' ? reviewSteps : [...reviewSteps].reverse();
    const served = new Map<
      string,
      { material: Awaited<ReturnType<typeof service.prepareStep>>; ids: string[] }
    >();
    for (const step of ordered) {
      const material = await service.prepareStep(step.id);
      served.set(step.id, {
        material,
        ids: material?.kind === 'review' ? material.candidates.map((c) => c.id) : [],
      });
    }
    return served;
  }

  it('85. a targeted vocabulary step cannot starve a separate vocabulary step', async () => {
    const ctx = await createContext();
    const invoice = await seedVocabulary(ctx, 'invoice', 'a bill listing charges');
    const weakness = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      referenceId: invoice.id,
      notes: 'invoice',
      occurrenceCount: 3,
    });
    const agenda = await seedVocabulary(ctx, 'agenda', 'a list of items to discuss');

    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const targeted = session.plan.steps.find(
      (step) => step.capability === 'review-service' && step.target.id === weakness.id,
    );
    const sibling = session.plan.steps.find(
      (step) =>
        step.capability === 'review-service' &&
        step.reviewKindFilter === 'vocabulary' &&
        step.id !== targeted?.id,
    );
    expect(targeted).toBeTruthy();
    expect(sibling).toBeTruthy();

    const served = await collectAllocation(service, session);
    const targetedMaterial = served.get(targeted!.id)!.material;
    const siblingMaterial = served.get(sibling!.id)!.material;
    expect(targetedMaterial?.kind).toBe('review');
    expect(siblingMaterial?.kind).toBe('review');
    if (targetedMaterial?.kind !== 'review' || siblingMaterial?.kind !== 'review') {
      throw new Error('expected review material for both vocabulary steps');
    }

    // Phase 1: the targeted step reserves exactly its linked item …
    expect(targetedMaterial.candidates.map((c) => c.referenceId)).toEqual([invoice.id]);
    expect(targetedMaterial.targetMatched).toBe(true);
    // … and must NOT fill its remaining capacity with the sibling's item.
    expect(targetedMaterial.candidates.map((c) => c.referenceId)).not.toContain(agenda.id);
    // Phase 2: the sibling specialized step gets its own matching-kind item.
    expect(siblingMaterial.candidates.map((c) => c.referenceId)).toEqual([agenda.id]);

    const allIds = [...served.get(targeted!.id)!.ids, ...served.get(sibling!.id)!.ids];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('86. a targeted grammar step cannot starve a sibling grammar step', async () => {
    const ctx = await createContext();
    const mistake = await seedGrammarMistake(
      ctx,
      'I live here since 2020',
      'I have lived here since 2020',
    );
    const linked = await seedWeakness(ctx, {
      type: 'grammar',
      status: 'relapsed',
      referenceId: mistake.id,
      notes: 'I live here since 2020',
      occurrenceCount: 4,
    });
    // A second grammar weakness whose source row is no longer in the due queue.
    const orphan = await seedWeakness(ctx, {
      type: 'grammar',
      status: 'confirmed',
      referenceId: uid(888),
      notes: 'She go to work every day',
      occurrenceCount: 3,
    });
    await seedReviewItem(ctx, {
      kind: 'grammar',
      prompt: 'Correct this unrelated sentence',
      referenceId: 'ref-grammar-sibling',
    });

    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const linkedStep = session.plan.steps.find(
      (step) => step.capability === 'review-service' && step.target.id === linked.id,
    );
    const orphanStep = session.plan.steps.find(
      (step) => step.capability === 'review-service' && step.target.id === orphan.id,
    );
    expect(linkedStep).toBeTruthy();
    expect(orphanStep).toBeTruthy();

    const served = await collectAllocation(service, session);
    const linkedMaterial = served.get(linkedStep!.id)!.material;
    const orphanMaterial = served.get(orphanStep!.id)!.material;
    if (linkedMaterial?.kind !== 'review') throw new Error('expected review material');
    if (orphanMaterial?.kind !== 'review') throw new Error('expected review material');

    // The linked step gets its own mistake — and only that in phase 1.
    expect(linkedMaterial.candidates[0].contextSentence).toBe('I live here since 2020');
    expect(linkedMaterial.targetMatched).toBe(true);
    // The sibling grammar step is not starved: it holds the other grammar item.
    expect(orphanMaterial.candidates.length).toBeGreaterThan(0);
    expect(
      orphanMaterial.candidates.every((c) => c.contextSentence !== 'I live here since 2020'),
    ).toBe(true);
    expect(orphanMaterial.candidates.map((c) => c.referenceId)).toContain('ref-grammar-sibling');
    // Its provenance stays honest: this is not the item it was planned from.
    expect(orphanMaterial.targetMatched).toBe(false);
    expect(orphanMaterial.note?.toLowerCase()).toContain('not that targeted item');

    const allIds = [...served.get(linkedStep!.id)!.ids, ...served.get(orphanStep!.id)!.ids];
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toHaveLength(2);
  });

  it('87. generic Quick Review receives only genuine leftovers', async () => {
    const ctx = await createContext();
    const invoice = await seedVocabulary(ctx, 'invoice', 'a bill listing charges');
    const weakness = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      referenceId: invoice.id,
      notes: 'invoice',
      occurrenceCount: 3,
    });
    const agenda = await seedVocabulary(ctx, 'agenda', 'a list of items to discuss');
    await seedReviewItem(ctx, {
      kind: 'grammar',
      prompt: 'Correct this unrelated sentence',
      referenceId: 'ref-grammar-leftover',
    });

    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const targeted = session.plan.steps.find(
      (step) => step.capability === 'review-service' && step.target.id === weakness.id,
    );
    const generic = session.plan.steps.find(
      (step) => step.capability === 'review-service' && !step.reviewKindFilter,
    );
    const specialized = session.plan.steps.find(
      (step) =>
        step.capability === 'review-service' &&
        step.reviewKindFilter === 'vocabulary' &&
        step.id !== targeted?.id,
    );
    expect(targeted).toBeTruthy();
    expect(generic).toBeTruthy();
    expect(specialized).toBeTruthy();
    // The generic step is prepared BEFORE the specialized one in plan order —
    // exactly the ordering that used to let it swallow reserved candidates.
    expect(session.plan.steps.indexOf(generic!)).toBeLessThan(
      session.plan.steps.indexOf(specialized!),
    );

    const served = await collectAllocation(service, session);
    const targetedMaterial = served.get(targeted!.id)!.material;
    const genericMaterial = served.get(generic!.id)!.material;
    const specializedMaterial = served.get(specialized!.id)!.material;
    if (targetedMaterial?.kind !== 'review') throw new Error('expected review material');
    if (genericMaterial?.kind !== 'review') throw new Error('expected review material');
    if (specializedMaterial?.kind !== 'review') throw new Error('expected review material');

    // Phase 1 → targeted requirement satisfied first.
    expect(targetedMaterial.candidates.map((c) => c.referenceId)).toEqual([invoice.id]);
    // Phase 2 → specialized minimum satisfied second.
    expect(specializedMaterial.candidates.map((c) => c.referenceId)).toEqual([agenda.id]);
    // Phase 4 → generic only ever receives what was genuinely unallocated.
    expect(genericMaterial.candidates.map((c) => c.referenceId)).toEqual(['ref-grammar-leftover']);
    expect(genericMaterial.candidates.map((c) => c.referenceId)).not.toContain(invoice.id);
    expect(genericMaterial.candidates.map((c) => c.referenceId)).not.toContain(agenda.id);

    const allIds = [
      ...served.get(targeted!.id)!.ids,
      ...served.get(specialized!.id)!.ids,
      ...served.get(generic!.id)!.ids,
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('88. allocation is deterministic for an identical plan, candidate order and state', async () => {
    const ctx = await createContext();
    // Real evidence shapes the PLAN (targeted + specialized + generic steps).
    const invoice = await seedVocabulary(ctx, 'invoice', 'a bill listing charges');
    const weakness = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      referenceId: invoice.id,
      notes: 'invoice',
      occurrenceCount: 3,
    });
    await seedVocabulary(ctx, 'agenda', 'a list of items to discuss');
    await seedReviewItem(ctx, {
      kind: 'grammar',
      prompt: 'Correct this unrelated sentence',
      referenceId: 'ref-grammar-leftover',
    });

    /*
     * The EXISTING ReviewService sorts candidates by priority and breaks exact
     * ties with `a.id.localeCompare(b.id)`, where the candidate id is freshly
     * generated on every call — so two equally due items can legitimately swap
     * places between fetches. Determinism of the ALLOCATION is therefore tested
     * against a fixed candidate order (the finding's premise), with a stable
     * pool served by a stub port.
     */
    const fixedPool: readonly ReviewItemCandidate[] = [
      {
        id: 'cand-target',
        learnerId: ctx.learnerId,
        kind: 'vocabulary',
        exerciseType: 'vocabulary_recall',
        // Identity link to the persisted weakness that created the step.
        referenceId: weakness.id,
        prompt: 'What word matches this definition? (word)',
        expectedAnswer: 'invoice',
        dueAt: DUE_AT,
        consecutiveCorrect: 0,
        reviewCount: 0,
      },
      {
        id: 'cand-agenda',
        learnerId: ctx.learnerId,
        kind: 'vocabulary',
        exerciseType: 'vocabulary_recall',
        referenceId: 'ref-agenda',
        prompt: 'What word matches this definition? (word)',
        expectedAnswer: 'agenda',
        dueAt: DUE_AT,
        consecutiveCorrect: 0,
        reviewCount: 0,
      },
      {
        id: 'cand-grammar',
        learnerId: ctx.learnerId,
        kind: 'grammar',
        exerciseType: 'sentence_correction',
        referenceId: 'ref-grammar-leftover',
        prompt: 'Correct this sentence',
        expectedAnswer: 'I have lived here since 2020',
        dueAt: DUE_AT,
        consecutiveCorrect: 0,
        reviewCount: 0,
      },
    ];
    const stubReview: ReviewPort = {
      planSession: async () => fixedPool,
      evaluateAnswer: async () => {
        throw new Error('not used by this test');
      },
      recordPracticeResult: async () => {
        throw new Error('not used by this test');
      },
    };

    const service = createLessonService(ctx, { review: stubReview });
    type Allocation = readonly {
      readonly key: string;
      readonly targeted: boolean;
      readonly ids: readonly string[];
    }[];
    const collect = async (plan: AdaptiveLessonPlan): Promise<Allocation> => {
      const entries: { key: string; targeted: boolean; ids: string[] }[] = [];
      for (const step of plan.steps.filter((entry) => entry.capability === 'review-service')) {
        const material = await service.prepareStep(step.id);
        entries.push({
          key: `${step.id}/${step.reviewKindFilter ?? 'any'}`,
          targeted: step.target.id === weakness.id,
          ids:
            material?.kind === 'review'
              ? material.candidates.map((candidate) => candidate.id)
              : ['unavailable'],
        });
      }
      return entries;
    };

    const first = (await service.startLesson()).session!;
    const runA = await collect(first.plan);

    service.cancelLesson();
    const second = (await service.startLesson()).session!;
    expect(second.plan.id).toBe(first.plan.id);
    const runB = await collect(second.plan);

    // Identical plan + identical candidate order + identical learner state
    // ⇒ identical candidate ids per step, in identical order.
    expect(runB).toEqual(runA);
    expect(runA.length).toBeGreaterThanOrEqual(3);
    expect(runA.flatMap((entry) => entry.ids)).not.toContain('unavailable');

    // Fairness invariants hold in both runs, independent of pool ordering.
    for (const run of [runA, runB]) {
      // The targeted step holds its exact linked candidate.
      expect(run.find((entry) => entry.targeted)?.ids).toContain('cand-target');
      // The generic (unfiltered) step only ever receives the true leftover.
      const genericEntries = run.filter((entry) => entry.key.endsWith('/any'));
      expect(genericEntries).toHaveLength(1);
      expect(genericEntries[0].ids).toEqual(['cand-grammar']);
      // The specialized sibling is not starved by the targeted step.
      const vocabularyEntries = run.filter((entry) => entry.key.endsWith('/vocabulary'));
      expect(vocabularyEntries).toHaveLength(2);
      expect(vocabularyEntries.every((entry) => entry.ids.length > 0)).toBe(true);
      // Disjoint: every candidate id is allocated at most once.
      const ids = run.flatMap((entry) => entry.ids);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('89. candidates stay disjoint and targeted even when steps are prepared last-first', async () => {
    const ctx = await createContext();
    const invoice = await seedVocabulary(ctx, 'invoice', 'a bill listing charges');
    const weakness = await seedWeakness(ctx, {
      type: 'vocabulary',
      status: 'confirmed',
      referenceId: invoice.id,
      notes: 'invoice',
      occurrenceCount: 3,
    });
    await seedMixedReviewQueue(ctx);

    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    // Reverse preparation order: allocation is reserved up front, so the order
    // in which the UI opens steps cannot change who gets what.
    const served = await collectAllocation(service, session, 'reverse');

    const ids: string[] = [];
    for (const step of session.plan.steps.filter((s) => s.capability === 'review-service')) {
      const entry = served.get(step.id)!;
      if (entry.material?.kind !== 'review') continue;
      expect(entry.material.candidates.length).toBeLessThanOrEqual(step.bounds.maxItems);
      if (step.reviewKindFilter) {
        for (const candidate of entry.material.candidates) {
          expect(candidate.kind).toBe(step.reviewKindFilter);
        }
      }
      for (const candidate of entry.material.candidates) ids.push(candidate.id);
    }

    // Every candidate id appears at most once across the whole lesson.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(2);

    // The targeted step still holds exactly its own item.
    const targeted = session.plan.steps.find(
      (step) => step.capability === 'review-service' && step.target.id === weakness.id,
    )!;
    const targetedMaterial = served.get(targeted.id)!.material;
    if (targetedMaterial?.kind !== 'review') throw new Error('expected review material');
    expect(targetedMaterial.candidates.map((c) => c.referenceId)).toContain(invoice.id);
    expect(targetedMaterial.targetMatched).toBe(true);
  });
});
