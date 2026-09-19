/**
 * Professional English — Phase 1 integration tests.
 *
 * Covers adapter mapping, Deep Speaking planner input, honesty, race-guard
 * structure, navigation/Home entry, and that Deep Speaking still owns the
 * conversation. Fake/injected dependencies only — no network, no SQLite.
 */

import { describe, it, expect, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime.
import { readFileSync } from 'node:fs';
// @ts-ignore
import { dirname, join } from 'node:path';
// @ts-ignore
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import type {
  AIProvider,
  AIProviderResult,
} from '../providers/ai';
import type { ConversationRequest } from '../conversation-engine';
import type {
  CoachingActiveWeakness,
  CoachingContext,
  CoachingExpressionFocus,
  LearnerModel,
} from '../learner-model';
import type {
  ConversationMemoryService,
  FinalizeConversationResult,
} from '../talk-demo/conversation-memory';
import type { LearningPersistenceService } from '../talk-demo/learning-persistence';
import {
  MAX_TARGET_EXPRESSIONS,
  planSpeakingPractice,
} from '../deep-speaking/planner';
import { buildSpeakingCoachingPrompt } from '../deep-speaking/prompts';
import { SpeakingPracticeService } from '../deep-speaking/service';
import type { SpeakingPracticeType } from '../deep-speaking/types';
import {
  SCENARIO_CATEGORIES,
  SCENARIOS,
  mapPracticeType,
  planProfessionalScenario,
  toProfessionalLearnerContext,
  toSpeakingPlannerOptions,
  isExistingSpeakingPracticeType,
  type ScenarioCategory,
} from './index';


const NOW = '2026-02-01T10:00:00.000Z';
const LEARNER_ID = '11111111-1111-4111-8111-111111111111';

const EXPECTED_CATEGORIES: readonly ScenarioCategory[] = [
  'meeting',
  'project_update',
  'presentation',
  'interview',
  'negotiation',
  'client_discussion',
  'stakeholder_discussion',
  'problem_solving',
  'reporting',
  'email_discussion',
  'site_discussion',
  'claim_discussion',
  'contract_discussion',
  'technical_explanation',
  'leadership_conversation',
];

const EXPECTED_MAPPING: Readonly<Record<ScenarioCategory, SpeakingPracticeType>> = {
  meeting: 'role_play',
  project_update: 'guided_topic',
  presentation: 'explain_and_expand',
  interview: 'guided_topic',
  negotiation: 'role_play',
  client_discussion: 'role_play',
  stakeholder_discussion: 'role_play',
  problem_solving: 'problem_solution',
  reporting: 'guided_topic',
  email_discussion: 'role_play',
  site_discussion: 'role_play',
  claim_discussion: 'role_play',
  contract_discussion: 'role_play',
  technical_explanation: 'explain_and_expand',
  leadership_conversation: 'opinion_and_reasoning',
};

const EXISTING_TYPES: ReadonlySet<SpeakingPracticeType> = new Set([
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
]);

function readSrc(relative: string): string {
  return readFileSync(join(__dirname, relative), 'utf8');
}

function makeCoaching(overrides: Partial<CoachingContext> = {}): CoachingContext {
  return {
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
    ...overrides,
  };
}

function makeWeakness(
  partial: Partial<CoachingActiveWeakness> & {
    id: string;
    status: CoachingActiveWeakness['status'];
  },
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

function planningInput(coaching: CoachingContext) {
  return {
    coaching,
    hasProfile: true,
    recentConversations: coaching.recentConversations ?? [],
    now: NOW,
    evidenceIsReal: true as const,
  };
}

function planDeepSpeaking(category: ScenarioCategory, coaching?: CoachingContext) {
  const scenarioPlan = planProfessionalScenario(category);
  const options = toSpeakingPlannerOptions(scenarioPlan);
  return planSpeakingPractice(planningInput(coaching ?? makeCoaching()), options);
}

describe('Professional English integration', () => {
  it('1. preserves all 15 professional categories in declaration order', () => {
    expect([...SCENARIO_CATEGORIES]).toEqual([...EXPECTED_CATEGORIES]);
    expect(SCENARIOS).toHaveLength(15);
  });

  it('2. keeps category and scenario ids unique and matching', () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(15);
    for (const scenario of SCENARIOS) {
      expect(scenario.id).toBe(scenario.category);
    }
  });

  it('3. plans every category deterministically', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const first = planProfessionalScenario(category);
      const second = planProfessionalScenario(category);
      expect(first).toEqual(second);
      expect(first.category).toBe(category);
    }
  });

  it('4. remains general-purpose (not construction-only)', () => {
    const titles = SCENARIOS.map((scenario) => `${scenario.title} ${scenario.situation}`).join(' ');
    expect(titles.toLowerCase()).not.toMatch(/construction only|builder-only|site-only/);
    expect(SCENARIO_CATEGORIES).toEqual(expect.arrayContaining(['interview', 'negotiation', 'meeting']));
  });

  it('5. does not fabricate a profession when the learner model has none', () => {
    const context = toProfessionalLearnerContext(makeCoaching());
    expect(context.profession).toBeUndefined();
    const plan = planProfessionalScenario('meeting', context);
    expect(plan.professionalContext).toBeUndefined();
  });

  it('6. maps meeting structured_exchange to role_play', () => {
    const plan = planProfessionalScenario('meeting');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('7. maps project_update guided_dialogue to guided_topic', () => {
    const plan = planProfessionalScenario('project_update');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('guided_topic');
  });

  it('8. maps presentation prepared_monologue to explain_and_expand', () => {
    const plan = planProfessionalScenario('presentation');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('explain_and_expand');
  });

  it('9. maps interview question_and_answer to guided_topic', () => {
    const plan = planProfessionalScenario('interview');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('guided_topic');
  });

  it('10. maps negotiation role_play to role_play', () => {
    const plan = planProfessionalScenario('negotiation');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('11. maps client_discussion simulated_call to role_play', () => {
    const plan = planProfessionalScenario('client_discussion');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('12. maps stakeholder_discussion structured_exchange to role_play', () => {
    const plan = planProfessionalScenario('stakeholder_discussion');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('13. maps problem_solving open_discussion to problem_solution', () => {
    const plan = planProfessionalScenario('problem_solving');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('problem_solution');
  });

  it('14. maps reporting guided_dialogue to guided_topic', () => {
    const plan = planProfessionalScenario('reporting');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('guided_topic');
  });

  it('15. maps email_discussion structured_exchange to role_play', () => {
    const plan = planProfessionalScenario('email_discussion');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('16. maps site_discussion role_play to role_play', () => {
    const plan = planProfessionalScenario('site_discussion');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('17. maps claim_discussion simulated_call to role_play', () => {
    const plan = planProfessionalScenario('claim_discussion');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('18. maps contract_discussion structured_exchange to role_play', () => {
    const plan = planProfessionalScenario('contract_discussion');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('role_play');
  });

  it('19. maps technical_explanation open_discussion to explain_and_expand', () => {
    const plan = planProfessionalScenario('technical_explanation');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('explain_and_expand');
  });

  it('20. maps leadership_conversation open_discussion to opinion_and_reasoning', () => {
    const plan = planProfessionalScenario('leadership_conversation');
    expect(mapPracticeType(plan.practiceType, plan.category)).toBe('opinion_and_reasoning');
  });

  it('21. adapter output is valid Deep Speaking planner input for every category', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const scenarioPlan = planProfessionalScenario(category);
      const options = toSpeakingPlannerOptions(scenarioPlan);
      expect(isExistingSpeakingPracticeType(options.practiceType!)).toBe(true);
      expect(EXISTING_TYPES.has(options.practiceType!)).toBe(true);
      expect(options.professionalScenario?.scenarioId).toBe(category);
      expect(options.professionalScenario?.title).toBe(scenarioPlan.title);
      expect(options.seed).toBeUndefined();
      const result = planSpeakingPractice(planningInput(makeCoaching()), options);
      expect(result.status).toBe('planned');
      expect(result.plan?.practiceType).toBe(EXPECTED_MAPPING[category]);
      expect(result.plan?.topic).toBe(scenarioPlan.title);
      expect(result.plan?.professionalScenario?.scenarioId).toBe(category);
    }
  });

  it('22. never introduces a new Deep Speaking practice type', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const mapped = EXPECTED_MAPPING[category];
      expect(EXISTING_TYPES.has(mapped)).toBe(true);
    }
  });

  it('23. caps target expressions at 3 (Deep Speaking bound)', () => {
    expect(MAX_TARGET_EXPRESSIONS).toBe(3);
    for (const category of SCENARIO_CATEGORIES) {
      const scenarioPlan = planProfessionalScenario(category);
      expect(scenarioPlan.targetExpressions.length).toBeLessThanOrEqual(3);
      const result = planDeepSpeaking(category);
      expect(result.plan?.targetExpressions.length).toBeLessThanOrEqual(3);
    }
  });

  it('24. fills remaining expression slots with professional language after real vocab', () => {
    const coaching = makeCoaching({
      expressionFocus: [
        {
          itemId: 'expr-1',
          expression: 'on the same page',
          type: 'common_expression',
          meaningDefinition: 'in agreement',
          reviewState: 'learning',
          nextReviewAt: NOW,
        } satisfies CoachingExpressionFocus,
      ],
    });
    const result = planDeepSpeaking('negotiation', coaching);
    const heads = result.plan!.targetExpressions.map((item) => item.headword);
    expect(heads[0]).toBe('on the same page');
    expect(heads.length).toBeGreaterThan(1);
    expect(heads.length).toBeLessThanOrEqual(3);
    const professional = result.plan!.targetExpressions.slice(1);
    for (const item of professional) {
      expect(item.reason).toMatch(/not saved vocabulary/i);
      expect(item.itemId).toMatch(/^professional-/);
    }
  });

  it('25. keeps challenge events as bounded guidance, not scores', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const scenarioPlan = planProfessionalScenario(category);
      expect(scenarioPlan.challengeEvents.length).toBeLessThanOrEqual(2);
      for (const event of scenarioPlan.challengeEvents) {
        expect(event.minComplexityRank).toBeGreaterThanOrEqual(0);
        expect(event.minComplexityRank).toBeLessThanOrEqual(2);
      }
      const options = toSpeakingPlannerOptions(scenarioPlan);
      expect(options.professionalScenario?.challengeEvents.length).toBe(
        scenarioPlan.challengeEvents.length,
      );
    }
  });

  it('26. carries a supplied profession as context only (no fabricated one)', () => {
    const without = planProfessionalScenario('meeting', {
      learningGoals: [],
      weaknesses: [],
    });
    const withProfession = planProfessionalScenario('meeting', {
      learningGoals: [],
      weaknesses: [],
      profession: 'law',
    });
    expect(without.professionalContext).toBeUndefined();
    expect(withProfession.professionalContext).toBe('law');
    expect(withProfession.title).toBe(without.title);
    expect(withProfession.speakingGoals).toEqual(without.speakingGoals);
    expect(withProfession.languageGoals).toEqual(without.languageGoals);
  });

  it('27. applies a matching learning goal as a material plan change', () => {
    const general = planProfessionalScenario('interview');
    const withGoal = planProfessionalScenario('interview', {
      learningGoals: ['job interview practice'],
      weaknesses: [],
    });
    expect(withGoal.personalizationNotes.join(' ')).not.toMatch(/no field produced/i);
    expect(withGoal.speakingGoals.map((g) => g.id)).not.toEqual(
      general.speakingGoals.map((g) => g.id),
    );
  });

  it('28. applies a matching weakness as a material language-goal reorder', () => {
    const general = planProfessionalScenario('meeting');
    const withWeakness = planProfessionalScenario('meeting', {
      learningGoals: [],
      weaknesses: ['uses too many fillers'],
    });
    const ids = withWeakness.languageGoals.map((g) => g.id);
    if (ids.includes('fillers')) {
      expect(ids[0]).toBe('fillers');
    }
    expect(withWeakness.personalizationNotes.join(' ')).toMatch(/emphas/i);
    expect(general.languageGoals.map((g) => g.id)).not.toEqual(ids);
  });

  it('29. unmatched weaknesses stay honest and do not claim personalization', () => {
    const context = toProfessionalLearnerContext(
      makeCoaching({
        activeWeaknesses: [
          makeWeakness({ id: 'w1', status: 'confirmed', type: 'confidence' }),
        ],
      }),
    );
    expect(context.weaknesses).toEqual(['confidence in speaking']);
    const plan = planProfessionalScenario('meeting', context);
    expect(plan.personalizationNotes.join(' ')).not.toMatch(/emphas/i);
  });

  it('30. excludes mastered and stable weaknesses from planner context', () => {
    const context = toProfessionalLearnerContext(
      makeCoaching({
        activeWeaknesses: [
          makeWeakness({ id: 'w1', status: 'mastered', type: 'grammar' }),
          makeWeakness({ id: 'w2', status: 'stable', type: 'fluency' }),
          makeWeakness({ id: 'w3', status: 'confirmed', type: 'grammar' }),
        ],
      }),
    );
    expect(context.weaknesses).toEqual(['grammar accuracy']);
  });

  it('31. professional scenario content never upgrades Deep Speaking source to personalized', () => {
    const result = planDeepSpeaking('negotiation', makeCoaching());
    expect(result.plan?.source).toBe('general');
    expect(result.plan?.sourceNote).toMatch(/general/i);
  });

  it('32. contains no scores, percentages, CEFR tokens, XP or pass/fail in PE + adapter', () => {
    const files = [
      readSrc('./planner.ts'),
      readSrc('./scenarios.ts'),
      readSrc('./types.ts'),
      readSrc('./deep-speaking-adapter.ts'),
      readSrc('../screens/ProfessionalEnglishScreen.tsx'),
    ].join('\n');
    expect(files).not.toMatch(/\bXP\b/);
    expect(files).not.toMatch(/pass\/fail/i);
    expect(files).not.toMatch(/\b\d+%/);
    const adapter = readSrc('./deep-speaking-adapter.ts');
    expect(adapter).not.toMatch(/\bCEFR\b/);
    expect(adapter).not.toMatch(/\bA1\b|\bA2\b|\bB1\b|\bB2\b|\bC1\b|\bC2\b/);
  });

  it('33. adapter and PE core perform no AI, network, persistence or SQLite', () => {
    const adapter = readSrc('./deep-speaking-adapter.ts');
    const planner = readSrc('./planner.ts');
    const screen = readSrc('../screens/ProfessionalEnglishScreen.tsx');
    for (const source of [adapter, planner]) {
      expect(source).not.toMatch(/fetch\(/);
      expect(source).not.toMatch(/sqlite/i);
      expect(source).not.toMatch(/Gemini/);
      expect(source).not.toMatch(/createTalkVoiceCoordinator/);
    }
    expect(screen).not.toMatch(/sqlite/i);
    expect(screen).not.toMatch(/createTalkVoiceCoordinator/);
    expect(screen).not.toMatch(/openConversation/);
  });

  it('34. Deep Speaking owns conversation, feedback evidence and finalization', async () => {
    const coaching = makeCoaching();
    const refreshSpy = vi.fn(async () => undefined);
    const model = {
      refresh: refreshSpy,
      getCoachingContext: () => coaching,
      getActiveWeaknesses: () => [],
    } as unknown as LearnerModel;
    const requests: ConversationRequest[] = [];
    const provider: AIProvider = {
      id: 'fake-ai',
      generate: async (request: ConversationRequest): Promise<AIProviderResult> => {
        requests.push(request);
        return {
          ok: true,
          response: {
            content: 'Shall we begin?',
            feedback: {
              coachingNote: 'Keep going.',
            },
          },
        };
      },
    };
    const finalizeSpy = vi.fn(
      async (): Promise<FinalizeConversationResult> => ({
        ok: true,
        reason: 'persisted',
        domainSessionId: 'domain-session-1',
        turnCount: 2,
      }),
    );
    const memoryService: ConversationMemoryService = {
      finalizeConversation: finalizeSpy as unknown as ConversationMemoryService['finalizeConversation'],
      listRecentConversations: vi.fn(async () => []),
      loadReviewEvidence: vi.fn(async () => ({ weaknesses: [], dueReviews: [] })),
    };
    const recordFeedbackEvidence = vi.fn(async () => undefined);
    const learningPersistence: LearningPersistenceService = {
      recordFeedbackEvidence:
        recordFeedbackEvidence as unknown as LearningPersistenceService['recordFeedbackEvidence'],
    };
    const service = new SpeakingPracticeService({
      learnerModel: model,
      aiProvider: provider,
      memoryService,
      learningPersistence,
      now: () => NOW,
    });
    const scenarioPlan = planProfessionalScenario('meeting');
    const planned = await service.planPractice(toSpeakingPlannerOptions(scenarioPlan));
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') throw new Error('expected plan');
    const started = await service.startPractice(planned.plan);
    const opened = await service.openConversation();
    expect(opened.ok).toBe(true);
    const turned = await service.sendLearnerTurn('Hello, shall we start the agenda?');
    expect(turned.ok).toBe(true);
    expect(recordFeedbackEvidence).toHaveBeenCalledTimes(1);
    const history = started.conversationSession.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
    await service.completePractice();
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    await service.completePractice();
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(requests.length).toBeGreaterThan(0);
  });

  it('35. coaching prompt carries bounded scenario guidance without forcing challenges', () => {
    const result = planDeepSpeaking('negotiation');
    expect(result.status).toBe('planned');
    const prompt = buildSpeakingCoachingPrompt(result.plan!, result.plan!.turnGoals[0]);
    expect(prompt).toMatch(/PROFESSIONAL SCENARIO/);
    expect(prompt).toMatch(/never announce/i);
    expect(prompt).not.toMatch(/\bband\b/i);
    expect(prompt).not.toMatch(/\bCEFR\b/);
    expect(prompt).not.toMatch(/\bA1\b|\bB2\b|\bC2\b/);
    expect(prompt).not.toMatch(/%/);
  });

  it('36. Professional English screen starts existing Deep Speaking and blocks double start', () => {
    const screen = readSrc('../screens/ProfessionalEnglishScreen.tsx');
    expect(screen).toMatch(/startingRef/);
    expect(screen).toMatch(/if \(startingRef\.current\) return/);
    expect(screen).toMatch(/selectedCategoryRef/);
    expect(screen).toMatch(/unmountedRef/);
    expect(screen).toMatch(/navigation\.navigate\('DeepSpeaking'/);
    expect(screen).toMatch(/professionalScenario/);
    expect(screen).toMatch(/Start professional practice/);
    expect(screen).not.toMatch(/createTalkVoiceCoordinator/);
    expect(screen).not.toMatch(/TextInput/);
  });

  it('37. stale start is blocked when the selected category changes', () => {
    const screen = readSrc('../screens/ProfessionalEnglishScreen.tsx');
    expect(screen).toMatch(/categoryAtPress !== selectedCategory/);
    expect(screen).toMatch(/selectedCategoryRef\.current = category/);
  });

  it('38. Home keeps existing entries and adds Professional English after Speaking practice', () => {
    const home = readSrc('../screens/HomeScreen.tsx');
    expect(home).toContain('PRACTICE_LINKS.map');
    expect(home).toContain('navigation.navigate(link.route)');
    const links = readSrc('../navigation/learner-journey.ts');
    expect(links).toContain("route: 'DeepSpeaking'");
    expect(links).toContain("route: 'ProfessionalEnglish'");
    const speakingIndex = links.indexOf("route: 'DeepSpeaking'");
    const professionalIndex = links.indexOf("route: 'ProfessionalEnglish'");
    expect(speakingIndex).toBeGreaterThan(0);
    expect(professionalIndex).toBeGreaterThan(speakingIndex);
    expect(home).toMatch(/AdaptiveLesson/);
    expect(home).toMatch(/Talk/);
  });

  it('39. ProfessionalEnglish route exists and Deep Speaking accepts professionalScenario', () => {
    const nav = readSrc('../navigation/RootNavigator.tsx');
    // Since the Daily Tutor navigation repair the typed route params live in
    // the single-source route tables (src/navigation/routes.ts); the screens
    // are still rendered from them in RootNavigator.
    const routes = readSrc('../navigation/routes.ts');
    expect(nav).toMatch(/ProfessionalEnglish/);
    expect(nav).toMatch(/ProfessionalEnglishScreen/);
    expect(routes).toMatch(/ProfessionalEnglish/);
    expect(routes).toMatch(/professionalScenario\?/);
    const ds = readSrc('../screens/DeepSpeakingScreen.tsx');
    expect(ds).toMatch(/professionalScenario/);
    expect(ds).toMatch(/Target expressions/);
    expect(ds).toMatch(/Expressions from your own vocabulary/);
    expect(ds).toMatch(/Professional scenario:/);
  });

  it('40. Deep Speaking planner/prompt additions stay additive and backward compatible', () => {
    const without = planSpeakingPractice(planningInput(makeCoaching()), {
      practiceType: 'guided_topic',
    });
    expect(without.plan?.professionalScenario).toBeUndefined();
    expect(without.plan?.topic).not.toBe(planProfessionalScenario('meeting').title);
    const prompt = buildSpeakingCoachingPrompt(without.plan!, without.plan!.turnGoals[0]);
    expect(prompt).not.toMatch(/PROFESSIONAL SCENARIO/);
  });
});
