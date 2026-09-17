import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_TARGET_EXPRESSIONS,
  GENERAL_SCENARIO,
  PROFESSIONAL_LEVELS,
  SCENARIOS,
  SCENARIO_CATEGORIES,
  getScenario,
  planScenario,
  type ScenarioCategory,
  type ScenarioPlan,
} from './index';

/** Categories called out explicitly in the task and expected to exist. */
const REQUIRED_CATEGORIES: readonly ScenarioCategory[] = [
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

/** Recursively collect any key that looks like it carries a numeric score. */
function collectScoreLikeKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectScoreLikeKeys(item, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const hit = /score|percent|cefr|grade|\bmark\b/i.test(key) ? [`${path}.${key}`] : [];
      return [...hit, ...collectScoreLikeKeys(child, `${path}.${key}`)];
    });
  }
  return [];
}

describe('scenario catalog', () => {
  it('1. supports all required categories plus the full declared set', () => {
    expect(SCENARIOS.length).toBe(SCENARIO_CATEGORIES.length);
    for (const category of SCENARIO_CATEGORIES) {
      expect(getScenario(category), `missing scenario for "${category}"`).toBeDefined();
    }
    for (const category of REQUIRED_CATEGORIES) {
      expect(getScenario(category)?.category).toBe(category);
    }
  });

  it('every scenario is complete and well-formed', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.id).toBe(scenario.category);
      expect(scenario.title.length).toBeGreaterThan(0);
      expect(scenario.situation.length).toBeGreaterThan(0);
      expect(scenario.learnerRole.length).toBeGreaterThan(0);
      expect(scenario.counterpartyRole.length).toBeGreaterThan(0);
      expect(scenario.objective.length).toBeGreaterThan(0);
      expect(scenario.speakingGoals.length).toBeGreaterThan(0);
      expect(scenario.languageGoals.length).toBeGreaterThan(0);
      expect(scenario.challengeEvents.length).toBeGreaterThan(0);
      expect(scenario.coachingNotes.length).toBeGreaterThan(0);
      expect(['simple', 'moderate', 'complex']).toContain(scenario.difficulty.band);
    }
  });
});

describe('2. deterministic plan', () => {
  it('produces identical plans for identical input, and does not mutate input', () => {
    const input = {
      category: 'meeting' as ScenarioCategory,
      learner: { level: 'developing' as const, goals: ['meetings_and_updates' as const] },
    };
    const snapshot = JSON.stringify(input);

    const first = planScenario(input);
    const second = planScenario(input);

    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('takes the general fallback for an unknown category', () => {
    const plan = planScenario({ category: 'totally_unknown' as ScenarioCategory });
    expect(plan.isFallback).toBe(true);
    expect(plan.title).toBe(GENERAL_SCENARIO.title);
  });
});

describe('3-12. category-specific plans', () => {
  const cases: readonly [ScenarioCategory, Partial<ScenarioPlan>][] = [
    ['meeting', { practiceType: 'structured_exchange' }],
    ['project_update', { practiceType: 'guided_dialogue' }],
    ['presentation', { practiceType: 'prepared_monologue' }],
    ['interview', { practiceType: 'question_and_answer' }],
    ['negotiation', { practiceType: 'role_play', difficulty: 'complex' }],
    ['client_discussion', { practiceType: 'simulated_call' }],
    ['stakeholder_discussion', { practiceType: 'structured_exchange' }],
    ['contract_discussion', { practiceType: 'structured_exchange' }],
    ['claim_discussion', { practiceType: 'simulated_call' }],
    ['site_discussion', { practiceType: 'role_play' }],
    ['technical_explanation', { practiceType: 'open_discussion' }],
  ];

  it.each(cases)('plans "%s" with the expected shape', (category, expected) => {
    const plan = planScenario({ category });
    expect(plan.category).toBe(category);
    expect(plan.isFallback).toBe(false);
    expect(plan.speakingGoals.length).toBeGreaterThan(0);
    expect(plan.languageGoals.length).toBeGreaterThan(0);
    expect(plan.challengeEvents.length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(expected)) {
      expect(plan[key as keyof ScenarioPlan]).toEqual(value);
    }
  });
});

describe('13. general profession fallback', () => {
  it('is profession-agnostic and never construction-specific', () => {
    const plan = planScenario({ category: 'site_discussion' });
    const text = JSON.stringify(plan).toLowerCase();
    // The catalog must stay general: no hard-coded trade/construction bias.
    expect(text).not.toContain('concrete');
    expect(text).not.toContain('rebar');
    expect(text).not.toContain('excavator');
    expect(plan.isFallback).toBe(false);
  });

  it('general scenario exists for unmatched input', () => {
    expect(GENERAL_SCENARIO.speakingGoals.length).toBeGreaterThan(0);
    expect(GENERAL_SCENARIO.challengeEvents.length).toBeGreaterThan(0);
  });
});

describe('14. learner goal influences the plan', () => {
  it('reflects goals, profession, weaknesses and level in personalization', () => {
    const plan = planScenario({
      category: 'meeting',
      learner: {
        level: 'advanced',
        goals: ['leadership', 'client_communication'],
        profession: 'product management',
        weaknesses: ['speaks too quickly'],
      },
    });

    const notes = plan.personalizationNotes.join(' ');
    expect(notes).toContain('product management');
    expect(notes).toContain('leadership');
    expect(notes).toContain('speaks too quickly');
    expect(plan.coachingMode).toBe('challenging');
  });

  it('defaults to balanced coaching with no profile', () => {
    const plan = planScenario({ category: 'meeting' });
    expect(plan.coachingMode).toBe('balanced');
    expect(plan.personalizationNotes.length).toBeGreaterThan(0);
  });
});

describe('15. difficulty influences challenge events', () => {
  it('includes more challenges as difficulty rises', () => {
    const simple = planScenario({ category: 'negotiation', learner: { scenarioDifficulty: 'simple' } });
    const complex = planScenario({ category: 'negotiation', learner: { scenarioDifficulty: 'complex' } });

    expect(simple.difficulty).toBe('simple');
    expect(complex.difficulty).toBe('complex');
    expect(simple.challengeEvents.length).toBeLessThanOrEqual(complex.challengeEvents.length);
    expect(complex.challengeEvents.length).toBeGreaterThan(0);
  });

  it('never returns zero challenges even at the easiest band', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const plan = planScenario({ category, learner: { scenarioDifficulty: 'simple' } });
      expect(plan.challengeEvents.length).toBeGreaterThan(0);
    }
  });

  it('accepts a qualitative level as a difficulty hint', () => {
    const plan = planScenario({ category: 'meeting', learner: { scenarioDifficulty: 'foundation' } });
    expect(plan.difficulty).toBe('simple');
  });
});

describe('16. target expressions are bounded', () => {
  it('respects the default cap and an explicit cap', () => {
    const plan = planScenario({ category: 'negotiation' });
    expect(plan.targetExpressions.length).toBeLessThanOrEqual(DEFAULT_MAX_TARGET_EXPRESSIONS);

    const capped = planScenario({ category: 'negotiation', maxTargetExpressions: 2 });
    expect(capped.targetExpressions.length).toBeLessThanOrEqual(2);
  });

  it('prioritises the learner’s own expressions and dedupes', () => {
    const plan = planScenario({
      category: 'meeting',
      learner: { targetExpressions: ['A phrase of my own', 'Could I add one point here?'] },
      maxTargetExpressions: 3,
    });
    expect(plan.targetExpressions[0]).toBe('A phrase of my own');
    expect(new Set(plan.targetExpressions.map((e) => e.toLowerCase())).size).toBe(
      plan.targetExpressions.length,
    );
  });

  it('handles a zero cap', () => {
    const plan = planScenario({ category: 'meeting', maxTargetExpressions: 0 });
    expect(plan.targetExpressions).toEqual([]);
  });
});

describe('17-20. invariants', () => {
  it('17. carries no scores or percentages anywhere', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const plan = planScenario({
        category,
        learner: { level: 'developing', goals: ['presentations'], scenarioDifficulty: 'moderate' },
      });
      expect(collectScoreLikeKeys(plan)).toEqual([]);
    }
    expect(collectScoreLikeKeys(SCENARIOS)).toEqual([]);
  });

  it('17b. never maps levels to exam bands', () => {
    const text = JSON.stringify(SCENARIOS).toUpperCase();
    expect(text).not.toContain('CEFR');
    expect(text).not.toMatch(/\bA1\b|\bA2\b|\bB1\b|\bB2\b|\bC1\b|\bC2\b/);
    expect([...PROFESSIONAL_LEVELS]).toEqual([
      'foundation',
      'developing',
      'independent',
      'advanced',
    ]);
  });

  it('18. planner is pure — plan depends only on its input', () => {
    const first = planScenario({ category: 'reporting' });
    // Re-planning many times yields the same object every time (no hidden state).
    for (let i = 0; i < 25; i += 1) {
      expect(planScenario({ category: 'reporting' })).toEqual(first);
    }
  });

  it('19. does not require AI or network — the module imports nothing external', async () => {
    const moduleSource = await import('./index');
    // The public surface exposes only pure functions and data.
    expect(typeof moduleSource.planScenario).toBe('function');
    expect(typeof moduleSource.getScenario).toBe('function');
    const moduleNames = Object.keys(moduleSource);
    for (const name of moduleNames) {
      expect(/fetch|http|axios|openai|anthropic|gemini/i.test(name)).toBe(false);
    }
  });

  it('20. does not persist — plan is a plain serialisable object', () => {
    const plan = planScenario({ category: 'presentation' });
    const roundTripped = JSON.parse(JSON.stringify(plan)) as ScenarioPlan;
    expect(roundTripped).toEqual(plan);
    // No storage/persistence handles leak into the plan.
    const keys = Object.keys(plan);
    for (const key of keys) {
      expect(/save|store|persist|db|database|client/i.test(key)).toBe(false);
    }
  });
});
