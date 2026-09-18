import { describe, expect, it } from 'vitest';

import {
  BASELINE_CHALLENGE,
  DEFAULT_MAX_TARGET_EXPRESSIONS,
  DIFFICULTY_RANK,
  GENERAL_SCENARIO,
  PROFESSIONAL_LEVELS,
  SCENARIOS,
  SCENARIO_CATEGORIES,
  getScenario,
  planScenario,
  type DifficultyBand,
  type LearnerProfile,
  type ScenarioCategory,
  type ScenarioPlan,
} from './index';

/** The 15 supported categories, declared explicitly for the audit. */
const SUPPORTED_CATEGORIES: readonly ScenarioCategory[] = [
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

/** Every difficulty band the planner supports. */
const DIFFICULTY_BANDS: readonly DifficultyBand[] = ['simple', 'moderate', 'complex'];

/** Recursively collect any key that looks like a numeric score. */
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

const normalize = (value: string): string => value.trim().toLowerCase();

// =========================================================================
// 1. CATALOG INTEGRITY
// =========================================================================

describe('catalog integrity', () => {
  it('supports exactly 15 categories', () => {
    expect(SCENARIO_CATEGORIES.length).toBe(15);
    expect(SUPPORTED_CATEGORIES.length).toBe(15);
    expect([...SCENARIO_CATEGORIES].sort()).toEqual([...SUPPORTED_CATEGORIES].sort());
  });

  it('declares exactly one scenario definition per supported category', () => {
    expect(SCENARIOS.length).toBe(15);
    for (const category of SUPPORTED_CATEGORIES) {
      const matches = SCENARIOS.filter((s) => s.category === category);
      expect(matches.length, `category "${category}"`).toBe(1);
    }
  });

  it('has unique scenario IDs', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique category values', () => {
    const categories = SCENARIOS.map((s) => s.category);
    expect(new Set(categories).size).toBe(categories.length);
  });

  it('every declared category resolves to a definition via getScenario', () => {
    for (const category of SCENARIO_CATEGORIES) {
      const scenario = getScenario(category);
      expect(scenario, `getScenario('${category}')`).toBeDefined();
      expect(scenario?.id).toBe(category);
      expect(scenario?.category).toBe(category);
    }
  });

  it('no scenario has an empty required text field', () => {
    for (const scenario of SCENARIOS) {
      for (const field of [
        'title',
        'situation',
        'learnerRole',
        'counterpartyRole',
        'objective',
        'coachingNotes',
      ] as const) {
        const value = scenario[field];
        expect(typeof value).toBe('string');
        expect(value.trim().length, `${scenario.category}.${field}`).toBeGreaterThan(0);
      }
    }
  });

  it('every scenario has at least one of each content collection', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.speakingGoals.length, `${scenario.category} speakingGoals`).toBeGreaterThan(0);
      expect(scenario.languageGoals.length, `${scenario.category} languageGoals`).toBeGreaterThan(0);
      expect(scenario.targetExpressions.length, `${scenario.category} targetExpressions`).toBeGreaterThan(0);
      expect(scenario.challengeEvents.length, `${scenario.category} challengeEvents`).toBeGreaterThan(0);
    }
  });

  it('has unique speaking goal IDs within each scenario', () => {
    for (const scenario of SCENARIOS) {
      const ids = scenario.speakingGoals.map((g) => g.id);
      expect(new Set(ids).size, `${scenario.category}`).toBe(ids.length);
      for (const goal of scenario.speakingGoals) {
        expect(goal.id.trim().length).toBeGreaterThan(0);
        expect(goal.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has unique language goal IDs within each scenario', () => {
    for (const scenario of SCENARIOS) {
      const ids = scenario.languageGoals.map((g) => g.id);
      expect(new Set(ids).size, `${scenario.category}`).toBe(ids.length);
      for (const goal of scenario.languageGoals) {
        expect(goal.id.trim().length).toBeGreaterThan(0);
        expect(goal.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has unique challenge IDs within each scenario', () => {
    for (const scenario of SCENARIOS) {
      const ids = scenario.challengeEvents.map((c) => c.id);
      expect(new Set(ids).size, `${scenario.category}`).toBe(ids.length);
      for (const challenge of scenario.challengeEvents) {
        expect(challenge.id.trim().length).toBeGreaterThan(0);
        expect(challenge.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has no duplicate target expressions after trim/case normalization', () => {
    for (const scenario of SCENARIOS) {
      const normalized = scenario.targetExpressions.map(normalize);
      expect(new Set(normalized).size, `${scenario.category}`).toBe(normalized.length);
      for (const expression of scenario.targetExpressions) {
        expect(expression.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('general fallback scenario is itself well-formed', () => {
    expect(GENERAL_SCENARIO.speakingGoals.length).toBeGreaterThan(0);
    expect(GENERAL_SCENARIO.languageGoals.length).toBeGreaterThan(0);
    expect(GENERAL_SCENARIO.targetExpressions.length).toBeGreaterThan(0);
    expect(GENERAL_SCENARIO.challengeEvents.length).toBeGreaterThan(0);
  });
});

// =========================================================================
// 2. CHALLENGE RANK SAFETY
// =========================================================================

describe('challenge rank safety', () => {
  const maxRank = Math.max(...Object.values(DIFFICULTY_RANK));

  it('every challenge event carries a real finite integer rank in range', () => {
    const allEvents = [
      ...SCENARIOS.flatMap((s) => s.challengeEvents),
      ...GENERAL_SCENARIO.challengeEvents,
      BASELINE_CHALLENGE,
    ];
    for (const event of allEvents) {
      const rank = event.minComplexityRank;
      expect(typeof rank, `${event.id}`).toBe('number');
      expect(Number.isFinite(rank), `${event.id} finite`).toBe(true);
      expect(Number.isNaN(rank), `${event.id} not NaN`).toBe(false);
      expect(Number.isInteger(rank), `${event.id} integer`).toBe(true);
      expect(rank, `${event.id} >= 0`).toBeGreaterThanOrEqual(0);
      expect(rank, `${event.id} <= max`).toBeLessThanOrEqual(maxRank);
    }
  });

  it('BASELINE_CHALLENGE has the lowest valid rank (simple => 0)', () => {
    expect(BASELINE_CHALLENGE.minComplexityRank).toBe(DIFFICULTY_RANK.simple);
    expect(Number.isFinite(BASELINE_CHALLENGE.minComplexityRank)).toBe(true);
  });

  it('DIFFICULTY_RANK maps the supported bands to contiguous integers from 0', () => {
    expect(Object.keys(DIFFICULTY_RANK).sort()).toEqual([...DIFFICULTY_BANDS].sort());
    expect(Object.values(DIFFICULTY_RANK).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('every supported difficulty band selects challenges without error', () => {
    for (const category of SUPPORTED_CATEGORIES) {
      for (const band of DIFFICULTY_BANDS) {
        const plan = planScenario({
          category,
          learner: { scenarioDifficulty: band },
        });
        expect(plan.challengeEvents.length, `${category} @ ${band}`).toBeGreaterThan(0);
        expect(plan.difficulty).toBe(band);
      }
    }
  });
});

// =========================================================================
// 3. PERSONALIZATION HONESTY
// =========================================================================

describe('personalization honesty', () => {
  it('A. a mapped learner goal materially changes speaking-goal order', () => {
    const baseline = planScenario({ category: 'meeting' });
    const mapped = planScenario({ category: 'meeting', learner: { goals: ['meetings_and_updates'] } });

    expect([...mapped.speakingGoals.map((g) => g.id)].sort()).toEqual(
      [...baseline.speakingGoals.map((g) => g.id)].sort(),
    );
    expect(mapped.speakingGoals[0].id).toBe('meetings_and_updates');
    expect(mapped.speakingGoals.map((g) => g.id)).not.toEqual(
      baseline.speakingGoals.map((g) => g.id),
    );
  });

  it('B. an unmapped learner goal does NOT claim goal adaptation', () => {
    const baseline = planScenario({ category: 'meeting' });
    const unmapped = planScenario({ category: 'meeting', learner: { goals: ['interviews'] } });

    expect(unmapped.speakingGoals).toEqual(baseline.speakingGoals);
    expect(unmapped.personalizationNotes.join(' ').toLowerCase()).not.toContain(
      'speaking goals reordered',
    );
  });

  it('C. a mapped weakness materially changes language-goal order', () => {
    const baseline = planScenario({ category: 'meeting' });
    const mapped = planScenario({ category: 'meeting', learner: { weaknesses: ['grammar accuracy'] } });

    expect(mapped.languageGoals[0].id).toBe('accuracy');
    expect(mapped.languageGoals).not.toEqual(baseline.languageGoals);
    expect(mapped.personalizationNotes.join(' ')).toContain('Language goals reordered');
  });

  it('D. an unmatched weakness does NOT claim adaptation', () => {
    const baseline = planScenario({ category: 'meeting' });
    const unmatched = planScenario({
      category: 'meeting',
      learner: { weaknesses: ['just wants to feel better overall'] },
    });

    expect(unmatched.languageGoals).toEqual(baseline.languageGoals);
    const notes = unmatched.personalizationNotes.join(' ');
    expect(notes).not.toContain('Language goals reordered');
    expect(notes).toContain('no deterministic mapping');
  });

  it('E. profession is carried only as context, never as adapted content', () => {
    const bare = planScenario({ category: 'meeting' });
    const withProfession = planScenario({
      category: 'meeting',
      learner: { profession: '  healthcare administration  ' },
    });

    expect(withProfession.professionalContext).toBe('healthcare administration');
    // Scenario content is untouched by profession.
    expect(withProfession.situation).toBe(bare.situation);
    expect(withProfession.speakingGoals).toEqual(bare.speakingGoals);
    expect(withProfession.languageGoals).toEqual(bare.languageGoals);
    expect(withProfession.targetExpressions).toEqual(bare.targetExpressions);
    // The note is honest: context only, no adaptation claim.
    const notes = withProfession.personalizationNotes.join(' ').toLowerCase();
    expect(notes).toContain('does not change');
    expect(notes).not.toContain('adapted');
    expect(notes).not.toContain('register adapted');
  });

  it('F. learner target expressions materially affect the selected expressions', () => {
    const bare = planScenario({ category: 'meeting' });
    const withOwn = planScenario({
      category: 'meeting',
      learner: { targetExpressions: ['A phrase only this learner uses'] },
    });

    expect(withOwn.targetExpressions[0]).toBe('A phrase only this learner uses');
    expect(withOwn.targetExpressions).not.toEqual(bare.targetExpressions);
  });

  it('G. a difficulty preference materially changes difficulty and challenge selection', () => {
    const simple = planScenario({ category: 'negotiation', learner: { scenarioDifficulty: 'simple' } });
    const complex = planScenario({ category: 'negotiation', learner: { scenarioDifficulty: 'complex' } });

    expect(simple.difficulty).toBe('simple');
    expect(complex.difficulty).toBe('complex');
    expect(simple.difficulty).not.toBe(complex.difficulty);
    expect(simple.challengeEvents.length).toBeLessThanOrEqual(complex.challengeEvents.length);
  });

  it('notes never claim an adaptation when the plan equals the defaults', () => {
    const bare = planScenario({ category: 'reporting' });
    const neutral = planScenario({
      category: 'reporting',
      learner: { goals: ['interviews'], weaknesses: ['needs more confidence in general'] },
    });

    expect(neutral.speakingGoals).toEqual(bare.speakingGoals);
    expect(neutral.languageGoals).toEqual(bare.languageGoals);
    const notes = neutral.personalizationNotes.join(' ').toLowerCase();
    expect(notes).not.toContain('reordered');
    expect(notes).toContain('no deterministic mapping');
  });
});

// =========================================================================
// 4. DETERMINISM
// =========================================================================

describe('determinism', () => {
  it('every one of the 15 scenarios yields identical plans across repeated calls', () => {
    for (const category of SUPPORTED_CATEGORIES) {
      const input = {
        category,
        learner: {
          level: 'developing' as const,
          goals: ['presentations' as const],
          profession: 'consultant',
          weaknesses: ['grammar accuracy'],
          scenarioDifficulty: 'moderate' as const,
        },
      };
      const first = planScenario(input);
      for (let i = 0; i < 10; i += 1) {
        expect(planScenario(input), `${category} call ${i}`).toEqual(first);
      }
    }
  });

  it('a deep snapshot is stable (no hidden mutable state)', () => {
    const input = { category: 'negotiation' as ScenarioCategory, learner: { goals: ['negotiation'] as const } };
    const snapshot = JSON.stringify(input);
    const a = JSON.stringify(planScenario(input));
    const b = JSON.stringify(planScenario(input));
    expect(b).toBe(a);
    // Input object is not mutated by planning.
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

// =========================================================================
// 5. GENERAL-PURPOSE SAFETY
// =========================================================================

describe('general-purpose safety', () => {
  it('the catalog contains no construction-only jargon', () => {
    const forbidden = ['rebar', 'formwork', 'scaffold', 'masonry', 'excavator', 'trench', 'dumper'];
    const text = JSON.stringify(SCENARIOS).toLowerCase();
    for (const word of forbidden) {
      expect(text, `unexpected "${word}"`).not.toContain(word);
    }
  });

  it('site/claim/contract scenarios remain field-agnostic and professional', () => {
    for (const category of ['site_discussion', 'claim_discussion', 'contract_discussion'] as const) {
      const scenario = getScenario(category);
      expect(scenario).toBeDefined();
      const text = JSON.stringify(scenario).toLowerCase();
      for (const word of ['rebar', 'formwork', 'concrete mix', 'excavator']) {
        expect(text, `${category} contains "${word}"`).not.toContain(word);
      }
    }
  });

  it('site_discussion is explicitly declared field-agnostic', () => {
    const text = (getScenario('site_discussion')?.situation ?? '').toLowerCase();
    expect(text).toContain('field-agnostic');
  });
});

// =========================================================================
// 6. FALLBACK / INVALID INPUT SAFETY
// =========================================================================

describe('fallback and invalid-input safety', () => {
  // A controlled runtime cast, confined to the test, for an out-of-union value.
  const invalidCategory = 'totally_unsupported' as ScenarioCategory;

  it('falls back deterministically for an unsupported category', () => {
    const first = planScenario({ category: invalidCategory });
    const second = planScenario({ category: invalidCategory });
    expect(second).toEqual(first);
    expect(first.isFallback).toBe(true);
    expect(first.title).toBe(GENERAL_SCENARIO.title);
  });

  it('does not throw for an unsupported category, even with a learner profile', () => {
    expect(() =>
      planScenario({
        category: invalidCategory,
        learner: { goals: ['negotiation'], profession: 'sales', weaknesses: ['grammar accuracy'] },
      }),
    ).not.toThrow();
  });

  it('marks the fallback honestly and claims no adaptation of the real category', () => {
    const plan = planScenario({ category: invalidCategory });
    expect(plan.isFallback).toBe(true);
    expect(plan.category).toBe(GENERAL_SCENARIO.category);
    expect(plan.scenarioId).toBe(GENERAL_SCENARIO.id);
  });

  it('an unknown category with no learner claims no personalization was applied', () => {
    const plan = planScenario({ category: invalidCategory });
    const notes = plan.personalizationNotes.join(' ').toLowerCase();
    expect(notes).toContain('no learner profile supplied');
    expect(notes).not.toContain('reordered');
  });

  it('a supported category is never silently replaced by the fallback', () => {
    for (const category of SUPPORTED_CATEGORIES) {
      const plan = planScenario({ category });
      expect(plan.isFallback).toBe(false);
      expect(plan.category).toBe(category);
    }
  });
});

// =========================================================================
// 7. NO ARCHITECTURE EXPANSION
// =========================================================================

describe('no architecture expansion', () => {
  it('the public surface exposes no network/AI/persistence-shaped names', async () => {
    const moduleSource = await import('./index');
    for (const name of Object.keys(moduleSource)) {
      expect(/fetch|http|axios|openai|anthropic|gemini|sqlite|supabase|storage|repository/i.test(name), name).toBe(false);
    }
  });

  it('plans carry no scores, percentages, or CEFR mappings', () => {
    for (const category of SUPPORTED_CATEGORIES) {
      const plan = planScenario({
        category,
        learner: { level: 'independent', goals: ['leadership'], scenarioDifficulty: 'moderate' },
      });
      expect(collectScoreLikeKeys(plan)).toEqual([]);
    }
    expect(collectScoreLikeKeys(SCENARIOS)).toEqual([]);
    const text = JSON.stringify(SCENARIOS).toUpperCase();
    expect(text).not.toContain('CEFR');
    expect(text).not.toMatch(/\bA1\b|\bA2\b|\bB1\b|\bB2\b|\bC1\b|\bC2\b/);
  });

  it('professional levels stay qualitative', () => {
    expect([...PROFESSIONAL_LEVELS]).toEqual(['foundation', 'developing', 'independent', 'advanced']);
  });

  it('plans are plain serialisable objects with no persistence handles', () => {
    const plan = planScenario({ category: 'presentation' });
    expect(JSON.parse(JSON.stringify(plan)) as ScenarioPlan).toEqual(plan);
    for (const key of Object.keys(plan)) {
      expect(/save|store|persist|db|database|client/i.test(key), key).toBe(false);
    }
  });
});

// =========================================================================
// EXISTING BEHAVIOUR — remains unchanged
// =========================================================================

describe('existing behaviour preserved', () => {
  it('category-specific practice types are unchanged', () => {
    const cases: readonly [ScenarioCategory, ScenarioPlan['practiceType']][] = [
      ['meeting', 'structured_exchange'],
      ['project_update', 'guided_dialogue'],
      ['presentation', 'prepared_monologue'],
      ['interview', 'question_and_answer'],
      ['negotiation', 'role_play'],
      ['client_discussion', 'simulated_call'],
      ['stakeholder_discussion', 'structured_exchange'],
      ['contract_discussion', 'structured_exchange'],
      ['claim_discussion', 'simulated_call'],
      ['site_discussion', 'role_play'],
      ['technical_explanation', 'open_discussion'],
    ];
    for (const [category, practiceType] of cases) {
      expect(planScenario({ category }).practiceType, category).toBe(practiceType);
    }
  });

  it('target expressions remain bounded by the default and explicit caps', () => {
    expect(planScenario({ category: 'negotiation' }).targetExpressions.length).toBeLessThanOrEqual(
      DEFAULT_MAX_TARGET_EXPRESSIONS,
    );
    expect(
      planScenario({ category: 'negotiation', maxTargetExpressions: 2 }).targetExpressions.length,
    ).toBeLessThanOrEqual(2);
    expect(planScenario({ category: 'meeting', maxTargetExpressions: 0 }).targetExpressions).toEqual([]);
  });

  it('an empty learner profile uses plain defaults with no adaptation claims', () => {
    const plan = planScenario({ category: 'meeting', learner: {} satisfies LearnerProfile });
    expect(plan.coachingMode).toBe('balanced');
    expect(plan.personalizationNotes.join(' ').toLowerCase()).toContain('no learner profile');
  });
});
