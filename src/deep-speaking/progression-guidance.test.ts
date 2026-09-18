/**
 * src/deep-speaking/progression-guidance.test.ts
 *
 * WP-1 — Phase 6 tests: Deep Speaking integration.
 *
 * Deep Speaking gets NO new AI content-generation path. WP-1 only adds bounded
 * working-level guidance to the prompt the EXISTING conversation engine already
 * builds, from ALREADY-RESOLVED inputs the owning service assembles out of the
 * learner snapshot it already loaded.
 *
 * These tests therefore assert three things above all:
 *   1. `planSpeakingPractice` stays PURE (no I/O, no AI, no clock, no reads);
 *   2. the guidance reaches the coaching prompt honestly and bounded;
 *   3. nothing about the existing deterministic scenario bank, dossier or
 *      personalization contract changes.
 */

import { describe, it, expect, vi } from 'vitest';

import type { CoachingContext } from '../learner-model';
import type { LearnerModel } from '../learner-model';
import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import type { ConversationRequest } from '../conversation-engine';
import type { SpeakingPracticePlan } from './types';
import {
  MAX_KNOWN_VOCABULARY,
  MAX_TARGET_EXPRESSIONS,
  boundedKnownVocabulary,
  planSpeakingPractice,
} from './planner';
import {
  buildProgressionGuidance,
  buildSpeakingCoachingPrompt,
  selectScenario,
} from './prompts';
import { SpeakingPracticeService } from './service';
import type { SpeakingProgressionGuidance } from './types';
import { resolveDifficultyProfile } from '../learning-progression';
import { getSkill } from '../curriculum/catalog';

const NOW = '2026-09-18T09:00:00.000Z';
const LEARNER_ID = '11111111-1111-4111-8111-111111111111';

type Level = CoachingContext['profile']['currentLevel'];

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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

interface ModelSpies {
  readonly model: LearnerModel;
  readonly refresh: ReturnType<typeof vi.fn>;
  readonly getCoachingContext: ReturnType<typeof vi.fn>;
  readonly getSavedVocabulary: ReturnType<typeof vi.fn>;
  readonly getDueReview: ReturnType<typeof vi.fn>;
  readonly getActiveWeaknesses: ReturnType<typeof vi.fn>;
}

function createModelStub(coaching: CoachingContext): ModelSpies {
  const refresh = vi.fn(async () => undefined);
  const getCoachingContext = vi.fn(() => coaching);
  const getSavedVocabulary = vi.fn(() => []);
  const getDueReview = vi.fn(() => []);
  const getActiveWeaknesses = vi.fn(() => []);
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
    refresh,
    subscribe: vi.fn(),
    getActiveWeaknesses,
    getStrengths: vi.fn(() => []),
    getSavedVocabulary,
    getDueReview,
    getRecentProgress: vi.fn(() => []),
    getLatestProgress: vi.fn(() => null),
    getWeaknessSummary: vi.fn(),
    getVocabularySummary: vi.fn(),
    getExpressionSummary: vi.fn(),
    getProgressSummary: vi.fn(),
    getDashboardSnapshot: vi.fn(),
    getCoachingContext,
  } as unknown as LearnerModel;
  return { model, refresh, getCoachingContext, getSavedVocabulary, getDueReview, getActiveWeaknesses };
}

function createFakeProvider(): {
  readonly provider: AIProvider;
  readonly requests: ConversationRequest[];
} {
  const requests: ConversationRequest[] = [];
  const generate = vi.fn(async (request: ConversationRequest): Promise<AIProviderResult> => {
    requests.push(request);
    return { ok: true, response: { content: 'Hello! Tell me about your day.', feedback: null } };
  });
  return { provider: { id: 'fake-speaking-ai', generate } as unknown as AIProvider, requests };
}

function createService(options: {
  readonly coaching?: CoachingContext;
  readonly aiProvider?: AIProvider;
  readonly evidenceIsReal?: boolean;
  readonly curriculumTarget?: { readonly domain: 'speaking'; readonly skillId?: string };
} = {}): {
  readonly service: SpeakingPracticeService;
  readonly spies: ModelSpies;
  readonly coaching: CoachingContext;
} {
  const coaching = options.coaching ?? makeCoaching();
  const spies = createModelStub(coaching);
  const service = new SpeakingPracticeService({
    learnerModel: spies.model,
    ...(options.aiProvider ? { aiProvider: options.aiProvider } : {}),
    ...(options.evidenceIsReal === false ? { evidenceIsReal: false } : {}),
    ...(options.curriculumTarget ? { curriculumTarget: options.curriculumTarget } : {}),
    memoryService: {
      finalizeConversation: vi.fn(async () => ({
        ok: true,
        reason: 'persisted',
        domainSessionId: 's-1',
        turnCount: 1,
      })),
      listRecentConversations: vi.fn(async () => []),
      loadReviewEvidence: vi.fn(async () => ({ weaknesses: [], dueReviews: [] })),
    } as never,
    learningPersistence: { recordFeedbackEvidence: vi.fn(async () => undefined) } as never,
    now: () => NOW,
  });
  return { service, spies, coaching };
}

function planningInput(
  coaching: CoachingContext,
  progression?: SpeakingProgressionGuidance,
): Parameters<typeof planSpeakingPractice>[0] {
  return {
    coaching,
    hasProfile: true,
    recentConversations: coaching.recentConversations ?? [],
    now: NOW,
    ...(progression ? { progression } : {}),
  };
}

function guidanceFor(
  level: Level,
  overrides: Partial<SpeakingProgressionGuidance> = {},
): SpeakingProgressionGuidance {
  return {
    workingLevel: level,
    difficultyProfile: resolveDifficultyProfile(level, null, 'speaking'),
    knownVocabulary: [],
    ...overrides,
  };
}

function planned(input: Parameters<typeof planSpeakingPractice>[0], options?: Parameters<typeof planSpeakingPractice>[1]): SpeakingPracticePlan {
  const result = planSpeakingPractice(input, options);
  if (result.status !== 'planned') throw new Error('a plan was expected');
  return result.plan;
}

/* ================================================================== *
 * Planner purity
 * ================================================================== */

describe('planner purity with already-resolved progression input', () => {
  it('1. identical input produces an identical plan (including the plan id)', () => {
    const coaching = deepFreeze(makeCoaching());
    const progression = guidanceFor('B1', { knownVocabulary: ['coffee', 'morning'] });
    const first = planned(planningInput(coaching, progression), { practiceType: 'guided_topic' });
    const second = planned(planningInput(coaching, progression), { practiceType: 'guided_topic' });
    expect(second).toEqual(first);
    expect(second.id).toBe(first.id);
  });

  it('2. a DEEP-FROZEN input is never mutated (the planner only reads)', () => {
    const coaching = deepFreeze(makeCoaching());
    const progression = deepFreeze(guidanceFor('A2'));
    expect(() =>
      planned(planningInput(coaching, progression), { practiceType: 'role_play' }),
    ).not.toThrow();
  });

  it('3. the plan id does not depend on the guidance (stability for existing callers)', () => {
    const coaching = makeCoaching();
    const withGuidance = planned(planningInput(coaching, guidanceFor('C1')), {
      practiceType: 'guided_topic',
    });
    const without = planned(planningInput(coaching), { practiceType: 'guided_topic' });
    expect(withGuidance.id).toBe(without.id);
  });

  it('4. the plan carries no guidance when none was supplied (byte-identical default)', () => {
    const plan = planned(planningInput(makeCoaching()), { practiceType: 'guided_topic' });
    expect(plan.progression).toBeUndefined();
    expect('progression' in plan).toBe(false);
    const prompt = buildSpeakingCoachingPrompt(plan, plan.turnGoals[0]);
    expect(prompt).not.toContain('=== WORKING LEVEL GUIDANCE ===');
  });

  it('5. nothing about the deterministic scenario bank changes', () => {
    const plan = planned(planningInput(makeCoaching(), guidanceFor('B2')), {
      practiceType: 'opinion_and_reasoning',
    });
    const expected = selectScenario('opinion_and_reasoning', LEARNER_ID, NOW);
    expect(plan.topic).toBe(expected.topic);
    expect(plan.scenarioPrompt).toBe(expected.scenarioPrompt);
  });

  it('6. bounded expressions are unchanged by guidance', () => {
    const coaching = makeCoaching({
      expressionFocus: Array.from({ length: 6 }, (_v, index) => ({
        itemId: `expr-${index}`,
        expression: `expression ${index}`,
        type: 'common_expression' as never,
        meaningDefinition: 'meaning',
        reviewState: 'learning' as never,
        nextReviewAt: NOW,
      })),
    });
    const plan = planned(planningInput(coaching, guidanceFor('B1')), {
      practiceType: 'target_expression_practice',
    });
    expect(plan.targetExpressions.length).toBeLessThanOrEqual(MAX_TARGET_EXPRESSIONS);
  });

  it('7. the planner module contains no I/O, no clock read and no randomness', async () => {
    // @ts-ignore -- node built-ins are available in the vitest runtime.
    const { readFileSync } = await import('node:fs');
    // @ts-ignore -- see above.
    const { join, dirname } = await import('node:path');
    // @ts-ignore -- see above.
    const { fileURLToPath } = await import('node:url');
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'planner.ts'), 'utf8');
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('//'))
      .join('\n');
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).not.toMatch(/Date\.now\(|Math\.random\(|new Date\(/);
    expect(source).not.toMatch(/repository|Repository|fetch\(|AIProvider|generate\(/);
    expect(source).not.toMatch(/from '\.\.\/data\//);
  });

  it('8. WP-1 adds NO AI content generation to Deep Speaking', async () => {
    // @ts-ignore -- node built-ins are available in the vitest runtime.
    const { readFileSync } = await import('node:fs');
    // @ts-ignore -- see above.
    const { join, dirname } = await import('node:path');
    // @ts-ignore -- see above.
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['planner.ts', 'prompts.ts', 'service.ts']) {
      const source = readFileSync(join(here, file), 'utf8');
      expect(source).not.toContain('content-generation');
      expect(source).not.toContain('generateControlledMaterial');
      expect(source).not.toContain('buildContentRequest');
    }
  });
});

/* ================================================================== *
 * Bounded saved lexicon
 * ================================================================== */

describe('boundedKnownVocabulary', () => {
  it('9. trims, lowercases, deduplicates, sorts and caps', () => {
    const bounded = boundedKnownVocabulary([' Coffee ', 'coffee', 'MORNING', 'agenda']);
    expect(bounded).toEqual(['agenda', 'coffee', 'morning']);
  });

  it('10. the bound is respected for a large saved list', () => {
    const many = Array.from({ length: 40 }, (_v, index) => `word-${String(index).padStart(2, '0')}`);
    const bounded = boundedKnownVocabulary(many);
    expect(bounded).toHaveLength(MAX_KNOWN_VOCABULARY);
    expect(bounded[0] < bounded[1]).toBe(true);
  });

  it('11. blank and non-string entries are dropped, never invented', () => {
    expect(boundedKnownVocabulary(['', '   ', 3 as never, null as never])).toEqual([]);
    expect(boundedKnownVocabulary(undefined)).toEqual([]);
    expect(boundedKnownVocabulary([], 0)).toEqual([]);
  });
});

/* ================================================================== *
 * Prompt guidance
 * ================================================================== */

describe('working-level guidance in the coaching prompt', () => {
  const plan = planned(
    planningInput(
      makeCoaching(),
      guidanceFor('B1', {
        knownVocabulary: ['agenda', 'coffee'],
        targetSkill: { domain: 'expressions', skillId: 'common_expressions' },
      }),
    ),
    { practiceType: 'guided_topic' },
  );
  const prompt = buildSpeakingCoachingPrompt(plan, plan.turnGoals[0]);

  it('12. the guided block is added to the EXISTING prompt (never replaces it)', () => {
    expect(prompt).toContain('=== DEEP SPEAKING COACH ===');
    expect(prompt).toContain('=== WORKING LEVEL GUIDANCE ===');
    expect(prompt).toContain('=== DEEP SPEAKING COACH ===');
    expect(prompt.startsWith('=== DEEP SPEAKING COACH ===')).toBe(true);
  });

  it('13. the stored working level is stated as a working level, never as proof', () => {
    const block = buildProgressionGuidance(guidanceFor('B1'));
    expect(block).toContain('stored working level is B1');
    expect(block).toContain('not proof of proficiency');
    expect(block).toContain('do not upgrade it');
  });

  it('14. every difficulty axis reaches the prompt', () => {
    const profile = resolveDifficultyProfile('B2', null, 'speaking');
    const block = buildProgressionGuidance(guidanceFor('B2'));
    expect(block).toContain(profile.discourseLength.replace(/_/g, ' '));
    expect(block).toContain(`Grammar complexity: ${profile.grammarComplexity}`);
    expect(block).toContain(`Support: ${profile.supportLevel}`);
    expect(block).toContain(profile.speechStyle.register);
    expect(block).toContain(profile.speechStyle.contractionDensity);
    expect(block).toContain(profile.speechStyle.lexicalStyle.replace(/_/g, ' '));
  });

  it('15. the new-language budget is presented as a budget, not as a knowledge claim', () => {
    const block = buildProgressionGuidance(guidanceFor('B1'));
    const profile = resolveDifficultyProfile('B1', null, 'speaking');
    expect(block).toContain(`at most ${profile.newLanguageBudget} deliberate new target`);
    expect(block).toContain('NOT a claim that every other word is already known');
  });

  it('16. saved items are labelled as a bounded list, never as a complete lexicon', () => {
    expect(prompt).toContain('BOUNDED list of saved entries only');
    expect(prompt).toContain('NOT their complete vocabulary');
    expect(prompt).toContain('"agenda"');
    expect(prompt).toContain('"coffee"');
  });

  it('17. a genuinely mapped curriculum target is stated; an absent one is not invented', () => {
    expect(prompt).toContain('genuinely mapped existing skill');
    expect(prompt).toContain('expressions / common_expressions');
    const bare = buildProgressionGuidance(guidanceFor('B1'));
    expect(bare).not.toContain('Curriculum target');
  });

  it('18. evidence-adjusted guidance is explained as MORE support, never more difficulty', () => {
    const adjusted = resolveDifficultyProfile(
      'B1',
      { weaknesses: [{ domain: 'speaking', status: 'confirmed', resolved: false }] },
      'speaking',
    );
    expect(adjusted.evidenceAdjusted).toBe(true);
    const block = buildProgressionGuidance(
      guidanceFor('B1', { difficultyProfile: adjusted }),
    );
    expect(block).toContain('more supported');
    expect(block).toContain('Never make it harder for that reason');
  });

  it('19. no score, percentage, band or fluency number is ever produced', () => {
    expect(prompt).not.toMatch(/\d+\s?%/);
    expect(prompt.toLowerCase()).not.toMatch(/fluency score|confidence score|pronunciation score/);
    expect(prompt).toContain('Do not output levels, bands, scores, percentages or ratings');
  });

  it('20. nothing about the learner profession is claimed', () => {
    expect(prompt.toLowerCase()).not.toContain('profession');
  });

  it('21. an isolated empty guidance block is still valid prompt text', () => {
    const block = buildProgressionGuidance(guidanceFor('unknown'));
    expect(block).toContain('stored working level is unknown');
    expect(block.endsWith('\n')).toBe(true);
  });
});

/* ================================================================== *
 * Service assembly
 * ================================================================== */

describe('service progression assembly', () => {
  it('22. planning derives guidance from the ALREADY-LOADED snapshot only', async () => {
    const { service, spies } = createService({
      coaching: makeCoaching({
        vocabularyFocus: [
          {
            itemId: 'v1',
            headword: 'Agenda',
            type: 'word' as never,
            meaningDefinition: 'a list of items',
            reviewState: 'learning' as never,
            nextReviewAt: NOW,
          },
        ],
      }),
    });
    const result = await service.planPractice({ practiceType: 'guided_topic' });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.progression?.workingLevel).toBe('B1');
    expect(result.plan.progression?.difficultyProfile.domain).toBe('speaking');
    expect(result.plan.progression?.knownVocabulary).toEqual(['agenda']);
    // No extra vocabulary/review reads: guidance comes from the loaded context.
    expect(spies.getSavedVocabulary).not.toHaveBeenCalled();
    expect(spies.getDueReview).not.toHaveBeenCalled();
    expect(spies.getActiveWeaknesses).not.toHaveBeenCalled();
    expect(spies.getCoachingContext).toHaveBeenCalledTimes(1);
  });

  it('23. planning stays deterministic for the same learner, state and date', async () => {
    const { service } = createService();
    const first = await service.planPractice({ practiceType: 'guided_topic' });
    const second = await service.planPractice({ practiceType: 'guided_topic' });
    expect(first.status).toBe('planned');
    if (first.status !== 'planned' || second.status !== 'planned') return;
    expect(second.plan).toEqual(first.plan);
    expect(second.plan.progression).toEqual(first.plan.progression);
  });

  it('24. no AI call happens while planning (guidance is not generated content)', async () => {
    const fake = createFakeProvider();
    const { service } = createService({ aiProvider: fake.provider });
    await service.planPractice({ practiceType: 'guided_topic' });
    expect(fake.requests).toHaveLength(0);
  });

  it('25. a demo/unknown snapshot is never presented to the coach as the learner level', async () => {
    const { service } = createService({ evidenceIsReal: false });
    const result = await service.planPractice({ practiceType: 'guided_topic' });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    expect(result.plan.progression).toBeUndefined();
    expect(result.plan.source).toBe('general');
  });

  it('26. the stored level is used as-is: negative evidence never promotes it', async () => {
    const { service } = createService({
      coaching: makeCoaching({
        profile: {
          learnerId: LEARNER_ID,
          displayName: 'Test Learner',
          currentLevel: 'A2',
          targetLevel: 'B1',
          learningGoals: [],
          preferredModes: ['coach'],
        },
        activeWeaknesses: Array.from({ length: 5 }, (_v, index) => ({
          id: `w-${index}`,
          referenceId: `ref-${index}`,
          type: 'fluency' as never,
          status: 'relapsed' as never,
          severity: 0.9,
          occurrenceCount: 6,
          contexts: [],
        })),
      }),
    });
    const result = await service.planPractice({ practiceType: 'guided_topic' });
    if (result.status !== 'planned') throw new Error('plan expected');
    expect(result.plan.progression?.workingLevel).toBe('A2');
    expect(result.plan.progression?.difficultyProfile.level).toBe('A2');
    expect(result.plan.progression?.difficultyProfile.grammarComplexity).toBe('basic');
    expect(result.plan.progression?.difficultyProfile.supportLevel).toBe('high');
    expect(result.plan.progression?.difficultyProfile.evidenceAdjusted).toBe(true);
  });

  it('27. guidance is bounded even for a very large loaded lexicon', async () => {
    const { service } = createService({
      coaching: makeCoaching({
        vocabularyFocus: Array.from({ length: 30 }, (_v, index) => ({
          itemId: `v-${index}`,
          headword: `word-${String(index).padStart(2, '0')}`,
          type: 'word' as never,
          meaningDefinition: 'meaning',
          reviewState: 'learning' as never,
          nextReviewAt: NOW,
        })),
      }),
    });
    const result = await service.planPractice({ practiceType: 'guided_topic' });
    if (result.status !== 'planned') throw new Error('plan expected');
    expect(result.plan.progression?.knownVocabulary).toHaveLength(MAX_KNOWN_VOCABULARY);
  });

  it('28. a mapped catalog skill is carried through, an unknown one is dropped', async () => {
    const existingSkill = getSkill('common_expressions');
    expect(existingSkill).toBeTruthy();
    const withReal = createService({
      curriculumTarget: { domain: 'speaking' as never, skillId: 'common_expressions' },
    });
    const real = await withReal.service.planPractice({ practiceType: 'guided_topic' });
    if (real.status !== 'planned') throw new Error('plan expected');
    expect(real.plan.progression?.targetSkill?.skillId).toBe('common_expressions');

    const withFake = createService({
      curriculumTarget: { domain: 'speaking' as never, skillId: 'made_up_skill' },
    });
    const fake = await withFake.service.planPractice({ practiceType: 'guided_topic' });
    if (fake.status !== 'planned') throw new Error('plan expected');
    expect(fake.plan.progression?.targetSkill?.skillId).toBeUndefined();
    expect(fake.plan.progression?.targetSkill?.domain).toBe('speaking');
  });

  it('29. guidance reaches the system prompt of the EXISTING engine', async () => {
    const fake = createFakeProvider();
    const { service } = createService({
      aiProvider: fake.provider,
      coaching: makeCoaching({
        vocabularyFocus: [
          {
            itemId: 'v1',
            headword: 'Agenda',
            type: 'word' as never,
            meaningDefinition: 'a list of items',
            reviewState: 'learning' as never,
            nextReviewAt: NOW,
          },
        ],
      }),
    });
    const result = await service.planPractice({ practiceType: 'guided_topic' });
    if (result.status !== 'planned') throw new Error('plan expected');
    await service.startPractice(result.plan);
    await service.openConversation();
    const prompt = fake.requests[0]?.systemPrompt ?? '';
    expect(prompt).toContain('=== WORKING LEVEL GUIDANCE ===');
    expect(prompt).toContain('stored working level is B1');
    expect(prompt).toContain('"agenda"');
    expect(prompt).not.toMatch(/\d+\s?%/);
  });

  it('30. the professional scenario path and its honest context are preserved', async () => {
    const { service } = createService();
    const result = await service.planPractice({
      practiceType: 'role_play',
      professionalScenario: {
        scenarioId: 'negotiation',
        title: 'Negotiating a contract',
        situation: 'You are negotiating a contract renewal.',
        learnerRole: 'Account manager',
        counterpartyRole: 'Client',
        objective: 'Agree on terms',
        difficulty: 'moderate',
        coachingPosture: 'Supportive',
        coachingNotes: 'Keep it practical.',
        speakingGoals: [{ id: 'g1', description: 'State your position clearly' }],
        languageGoals: [{ id: 'l1', description: 'Use polite conditionals' }],
        targetExpressions: ['we could consider'],
        challengeEvents: [{ id: 'c1', description: 'The client pushes on price' }],
        professionalContext: 'Logistics account management',
      },
    });
    if (result.status !== 'planned') throw new Error('plan expected');
    expect(result.plan.professionalScenario?.scenarioId).toBe('negotiation');
    const prompt = buildSpeakingCoachingPrompt(result.plan, result.plan.turnGoals[0]);
    expect(prompt).toContain('=== PROFESSIONAL SCENARIO ===');
    expect(prompt).toContain('=== WORKING LEVEL GUIDANCE ===');
    // The stored scenario context is real context, quoted, and never invented.
    expect(prompt).toContain('Logistics account management');
  });

  it('31. no profession is inferred when no real context exists', async () => {
    const fake = createFakeProvider();
    const { service } = createService({ aiProvider: fake.provider });
    const result = await service.planPractice({ practiceType: 'guided_topic' });
    if (result.status !== 'planned') throw new Error('plan expected');
    expect(result.plan.professionalScenario).toBeUndefined();
    await service.startPractice(result.plan);
    await service.openConversation();
    const prompt = fake.requests[0]?.systemPrompt ?? '';
    // The WP-1 guidance block never claims a profession, and no scenario block
    // is invented for a learner who has no real professional context.
    expect(prompt).not.toContain('=== PROFESSIONAL SCENARIO ===');
    expect(buildProgressionGuidance(result.plan.progression!).toLowerCase()).not.toContain(
      'profession',
    );
  });
});
