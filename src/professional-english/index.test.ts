import { describe, expect, it } from 'vitest';

import {
  BASELINE_CHALLENGE,
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
  it('8. supports all required categories plus the full declared set', () => {
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

describe('challenge ranks are valid', () => {
  it('5. every exported ChallengeEvent has a finite numeric rank in range', () => {
    const allEvents = [...SCENARIOS.flatMap((s) => s.challengeEvents), ...GENERAL_SCENARIO.challengeEvents];
    for (const event of allEvents) {
      expect(typeof event.minComplexityRank).toBe('number');
      expect(Number.isFinite(event.minComplexityRank)).toBe(true);
      expect(Number.isInteger(event.minComplexityRank)).toBe(true);
      // Expected internal range: index into DIFFICULTY_ORDER (0..2).
      expect(event.minComplexityRank).toBeGreaterThanOrEqual(0);
      expect(event.minComplexityRank).toBeLessThanOrEqual(2);
    }
  });

  it('6. BASELINE_CHALLENGE has a valid numeric rank (simple => 0)', () => {
    expect(typeof BASELINE_CHALLENGE.minComplexityRank).toBe('number');
    expect(BASELINE_CHALLENGE.minComplexityRank).toBe(0);
    expect(Number.isFinite(BASELINE_CHALLENGE.minComplexityRank)).toBe(true);
  });
});

describe('deterministic plan', () => {
  it('7. produces identical plans for identical input, and does not mutate input', () => {
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

  it('never silently replaces the requested category', () => {
    for (const category of REQUIRED_CATEGORIES) {
      const plan = planScenario({
        category,
        learner: { goals: ['interview'], profession: 'law', weaknesses: ['speaks too quickly'] },
      });
      expect(plan.category).toBe(category);
      const expected = getScenario(category);
      expect(plan.scenarioId).toBe(expected ? expected.id : GENERAL_SCENARIO.id);
    }
  });
});

describe('category-specific plans', () => {
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

describe('general profession fallback', () => {
  it('is profession-agnostic and never industry-specific', () => {
    const plan = planScenario({ category: 'site_discussion' });
    const text = JSON.stringify(plan).toLowerCase();
    expect(text).not.toContain('rebar');
    expect(text).not.toContain('excavator');
    expect(plan.isFallback).toBe(false);
  });

  it('general scenario exists for unmatched input', () => {
    expect(GENERAL_SCENARIO.speakingGoals.length).toBeGreaterThan(0);
    expect(GENERAL_SCENARIO.challengeEvents.length).toBeGreaterThan(0);
  });
});

describe('1. learner goals materially affect the generated plan', () => {
  it('reorders speakingGoals when the goal maps to the category', () => {
    const baseline = planScenario({ category: 'meeting' });
    // "interview" does not map to meeting; "meetings_and_updates" does.
    const off = planScenario({ category: 'meeting', learner: { goals: ['interviews'] } });
    const on = planScenario({ category: 'meeting', learner: { goals: ['meetings_and_updates'] } });

    const baselineIds = baseline.speakingGoals.map((g) => g.id);
    const onIds = on.speakingGoals.map((g) => g.id);
    // Same set of goals...
    expect([...onIds].sort()).toEqual([...baselineIds].sort());
    // ...but a material ORDER change: the matching goal is promoted to the front.
    expect(on.speakingGoals[0].id).toBe('meetings_and_updates');
    expect(onIds).not.toEqual(baselineIds);
    // An irrelevant goal leaves the structure untouched.
    expect(off.speakingGoals.map((g) => g.id)).toEqual(baselineIds);
  });

  it('a relevant goal changes plan structure, not just the notes string', () => {
    const without = planScenario({ category: 'presentation' });
    const withGoal = planScenario({ category: 'presentation', learner: { goals: ['presentations'] } });

    // The speakingGoals array itself must differ.
    expect(withGoal.speakingGoals).not.toEqual(without.speakingGoals);
    expect(withGoal.speakingGoals[0].id).toBe('presentations');
  });
});

describe('2. personalization notes never claim an adaptation that did not happen', () => {
  it('no note claims goals were applied when no goal mapped to the category', () => {
    const plan = planScenario({ category: 'meeting', learner: { goals: ['interviews'] } });
    const notes = plan.personalizationNotes.join(' ').toLowerCase();
    expect(notes).not.toContain('speaking goals reordered');
    expect(plan.speakingGoals).toEqual(getScenario('meeting')?.speakingGoals);
  });

  it('claims a goal adaptation only when the plan actually changed', () => {
    const plan = planScenario({ category: 'meeting', learner: { goals: ['meetings_and_updates'] } });
    const notes = plan.personalizationNotes.join(' ').toLowerCase();
    expect(notes).toContain('speaking goals reordered');
    expect(plan.speakingGoals[0].id).toBe('meetings_and_updates');
  });

  it('makes no adaptation claims when the plan is identical to the defaults', () => {
    const bare = planScenario({ category: 'reporting' });
    const withNeutralProfile = planScenario({
      category: 'reporting',
      // A goal irrelevant to "reporting" and an unmappable weakness.
      learner: { goals: ['interviews'], weaknesses: ['needs more confidence in general'] },
    });
    expect(withNeutralProfile.speakingGoals).toEqual(bare.speakingGoals);
    expect(withNeutralProfile.languageGoals).toEqual(bare.languageGoals);
    const notes = withNeutralProfile.personalizationNotes.join(' ').toLowerCase();
    expect(notes).toContain('no deterministic mapping');
    expect(notes).not.toContain('reordered');
  });
});

describe('3. profession is context, not a false adaptation claim', () => {
  it('does not claim examples/register were adapted', () => {
    const plan = planScenario({ category: 'meeting', learner: { profession: 'software engineering' } });
    const notes = plan.personalizationNotes.join(' ').toLowerCase();
    expect(notes).not.toContain('adapted');
    expect(notes).not.toContain('examples and register');
    expect(notes).toContain('does not change');
    expect(notes).toContain('software engineering');
  });

  it('carries profession as professionalContext without altering the scenario', () => {
    const bare = planScenario({ category: 'meeting' });
    const withProfession = planScenario({
      category: 'meeting',
      learner: { profession: '  software engineering  ' },
    });
    expect(withProfession.professionalContext).toBe('software engineering');
    expect(withProfession.situation).toBe(bare.situation);
    expect(withProfession.speakingGoals).toEqual(bare.speakingGoals);
    expect(withProfession.languageGoals).toEqual(bare.languageGoals);
  });
});

describe('4. weakness context is either materially used or honestly represented', () => {
  it('materially emphasises a language goal for a mappable weakness', () => {
    const bare = planScenario({ category: 'meeting' });
    const plan = planScenario({ category: 'meeting', learner: { weaknesses: ['grammar accuracy'] } });
    // The emphasised language goal is promoted to the front — a real change.
    expect(plan.languageGoals[0].id).toBe('accuracy');
    expect(plan.languageGoals).not.toEqual(bare.languageGoals);
    expect(plan.personalizationNotes.join(' ')).toContain('Language goals reordered');
  });

  it('honestly reports an unmappable weakness as not applied', () => {
    const plan = planScenario({ category: 'meeting', learner: { weaknesses: ['just wants to feel better'] } });
    const notes = plan.personalizationNotes.join(' ');
    expect(notes).toContain('no deterministic mapping');
    expect(notes).not.toContain('Language goals reordered');
  });
});

describe('difficulty influences challenge events', () => {
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

describe('target expressions are bounded', () => {
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

describe('invariants', () => {
  it('10. carries no scores or percentages anywhere', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const plan = planScenario({
        category,
        learner: { level: 'developing', goals: ['presentations'], scenarioDifficulty: 'moderate' },
      });
      expect(collectScoreLikeKeys(plan)).toEqual([]);
    }
    expect(collectScoreLikeKeys(SCENARIOS)).toEqual([]);
  });

  it('never maps levels to exam bands', () => {
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

  it('planner is pure — plan depends only on its input', () => {
    const first = planScenario({ category: 'reporting' });
    for (let i = 0; i < 25; i += 1) {
      expect(planScenario({ category: 'reporting' })).toEqual(first);
    }
  });

  it('9. does not require AI or network — the module imports nothing external', async () => {
    const moduleSource = await import('./index');
    expect(typeof moduleSource.planScenario).toBe('function');
    expect(typeof moduleSource.getScenario).toBe('function');
    const moduleNames = Object.keys(moduleSource);
    for (const name of moduleNames) {
      expect(/fetch|http|axios|openai|anthropic|gemini/i.test(name)).toBe(false);
    }
  });

  it('9b. does not persist — plan is a plain serialisable object', () => {
    const plan = planScenario({ category: 'presentation' });
    const roundTripped = JSON.parse(JSON.stringify(plan)) as ScenarioPlan;
    expect(roundTripped).toEqual(plan);
    const keys = Object.keys(plan);
    for (const key of keys) {
      expect(/save|store|persist|db|database|client/i.test(key)).toBe(false);
    }
  });
});
