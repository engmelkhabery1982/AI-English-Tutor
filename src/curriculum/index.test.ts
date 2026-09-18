import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CURRICULUM_DOMAINS,
  DEFAULT_MAX_ITEMS,
  GOAL_DOMAIN_WEIGHTS,
  SKILL_CATALOG,
  SKILL_LIFECYCLE_STATES,
  findPrerequisiteCycle,
  getSkill,
  planCurriculum,
  toFragment,
  validateSkillGraph,
  type CurriculumPlan,
  type CurriculumPlannerInput,
  type LearningGoalHint,
  type SkillDomain,
  type SkillEvidenceSnapshot,
  type SkillLifecycleState,
} from './index';

const SUPPORTED_DOMAINS: readonly SkillDomain[] = [
  'grammar',
  'vocabulary',
  'expressions',
  'speaking',
  'listening',
  'pronunciation',
];

/** Recursively collect keys that look like a score/percentage/level. */
function collectScoreLikeKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => collectScoreLikeKeys(item, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const hit = /score|percent|cefr|xp|rating|mastery_?level/i.test(key) ? [`${path}.${key}`] : [];
      return [...hit, ...collectScoreLikeKeys(child, `${path}.${key}`)];
    });
  }
  return [];
}

const snapshot = (skillId: string, lifecycleState: SkillLifecycleState): SkillEvidenceSnapshot => ({
  skillId,
  lifecycleState,
});

// =========================================================================
// 1-2. DOMAINS
// =========================================================================

describe('domains', () => {
  it('1. declares exactly six domains', () => {
    expect(CURRICULUM_DOMAINS.length).toBe(6);
    expect([...CURRICULUM_DOMAINS]).toEqual(SUPPORTED_DOMAINS);
  });

  it('2. every domain is represented in the catalog', () => {
    for (const domain of SUPPORTED_DOMAINS) {
      const inDomain = SKILL_CATALOG.filter((s) => s.domain === domain);
      expect(inDomain.length, `domain ${domain}`).toBeGreaterThan(0);
    }
  });

  it('catalog uses only supported domains', () => {
    for (const skill of SKILL_CATALOG) {
      expect(SUPPORTED_DOMAINS).toContain(skill.domain);
    }
  });
});

// =========================================================================
// 3-7. GRAPH INTEGRITY & VALIDATION
// =========================================================================

describe('graph integrity', () => {
  it('3. skill IDs are unique', () => {
    const ids = SKILL_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('4. no skill lists itself as a prerequisite', () => {
    for (const skill of SKILL_CATALOG) {
      expect(skill.prerequisites, skill.id).not.toContain(skill.id);
    }
  });

  it('5. no duplicate prerequisites within a skill', () => {
    for (const skill of SKILL_CATALOG) {
      const prereqs = skill.prerequisites;
      expect(new Set(prereqs).size, skill.id).toBe(prereqs.length);
    }
  });

  it('6. all prerequisite IDs resolve to real skills', () => {
    const ids = new Set(SKILL_CATALOG.map((s) => s.id));
    for (const skill of SKILL_CATALOG) {
      for (const prereq of skill.prerequisites) {
        expect(ids.has(prereq), `${skill.id} -> ${prereq}`).toBe(true);
      }
    }
  });

  it('the shipped catalog validates cleanly', () => {
    const result = validateSkillGraph(SKILL_CATALOG.map(toFragment));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('7. cycle detection works on a synthetic cycle', () => {
    const cyclic = [
      { id: 'a', domain: 'grammar' as SkillDomain, prerequisites: ['c'] },
      { id: 'b', domain: 'grammar' as SkillDomain, prerequisites: ['a'] },
      { id: 'c', domain: 'grammar' as SkillDomain, prerequisites: ['b'] },
    ];
    const cycle = findPrerequisiteCycle(cyclic);
    expect(cycle).not.toBeNull();
    expect(cycle?.length).toBeGreaterThan(0);
    const result = validateSkillGraph(cyclic);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.kind === 'cycle')).toBe(true);
  });

  it('detects self-prerequisite, duplicate-prerequisite and missing-prerequisite', () => {
    const broken = [
      { id: 'x', domain: 'grammar' as SkillDomain, prerequisites: ['x', 'y', 'y', 'ghost'] },
      { id: 'y', domain: 'grammar' as SkillDomain, prerequisites: [] },
    ];
    const result = validateSkillGraph(broken);
    const kinds = result.issues.map((i) => i.kind);
    expect(kinds).toContain('self_prerequisite');
    expect(kinds).toContain('duplicate_prerequisite');
    expect(kinds).toContain('missing_prerequisite');
    expect(result.valid).toBe(false);
  });

  it('detects duplicate ids and unknown domains', () => {
    const dupes = [
      { id: 'dup', domain: 'grammar' as SkillDomain, prerequisites: [] },
      { id: 'dup', domain: 'grammar' as SkillDomain, prerequisites: [] },
      { id: 'bad_domain', domain: 'not_a_domain' as unknown as SkillDomain, prerequisites: [] },
    ];
    const result = validateSkillGraph(dupes);
    const kinds = result.issues.map((i) => i.kind);
    expect(kinds).toContain('duplicate_id');
    expect(kinds).toContain('unknown_domain');
  });
});

// =========================================================================
// 8, 32. DETERMINISM
// =========================================================================

describe('determinism', () => {
  const richInput: CurriculumPlannerInput = {
    evidence: [
      snapshot('present_tense', 'relapsed'),
      snapshot('articles', 'confirmed'),
      snapshot('fluency', 'active_training'),
      snapshot('core_vocabulary', 'repeated'),
      snapshot('detail_listening', 'observed'),
      snapshot('word_stress', 'improving'),
      snapshot('phrasal_verbs', 'stable'),
      snapshot('sentence_structure', 'mastered'),
    ],
    activeWeaknesses: ['present_tense'],
    recentlyPractised: ['articles'],
    learningGoals: ['grammar_accuracy'],
    now: '2026-09-18T00:00:00.000Z',
  };

  it('8. same input yields the same plan', () => {
    const a = planCurriculum(richInput);
    const b = planCurriculum(richInput);
    expect(b).toEqual(a);
  });

  it('32. repeated identical input returns a deep-equal plan', () => {
    const first = planCurriculum(richInput);
    for (let i = 0; i < 25; i += 1) {
      expect(planCurriculum(richInput)).toEqual(first);
    }
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(richInput);
    planCurriculum(richInput);
    expect(JSON.stringify(richInput)).toBe(before);
  });
});

// =========================================================================
// 9-15. LIFECYCLE PRIORITIZATION
// =========================================================================

describe('lifecycle prioritization', () => {
  it('9. relapsed is prioritized', () => {
    const plan = planCurriculum({ evidence: [snapshot('past_tense', 'relapsed')] });
    const top = plan.recommendations[0];
    expect(top.skillId).toBe('past_tense');
    expect(top.reasons.some((r) => r.code === 'relapsed')).toBe(true);
  });

  it('10. confirmed is prioritized', () => {
    const plan = planCurriculum({ evidence: [snapshot('articles', 'confirmed')] });
    expect(plan.recommendations[0].skillId).toBe('articles');
    expect(plan.recommendations[0].reasons.some((r) => r.code === 'confirmed')).toBe(true);
  });

  it('11. active_training is prioritized', () => {
    const plan = planCurriculum({ evidence: [snapshot('fluency', 'active_training')] });
    expect(plan.recommendations[0].skillId).toBe('fluency');
    expect(plan.recommendations[0].reasons.some((r) => r.code === 'active_training')).toBe(true);
  });

  it('12. repeated ranks above observed', () => {
    const plan = planCurriculum({
      evidence: [snapshot('detail_listening', 'observed'), snapshot('core_vocabulary', 'repeated')],
      maxItems: 10,
    });
    const repeatedIdx = plan.recommendations.findIndex((r) => r.skillId === 'core_vocabulary');
    const observedIdx = plan.recommendations.findIndex((r) => r.skillId === 'detail_listening');
    expect(repeatedIdx).toBeGreaterThanOrEqual(0);
    expect(observedIdx).toBeGreaterThanOrEqual(0);
    expect(repeatedIdx).toBeLessThan(observedIdx);
  });

  it('full ordering relapsed > confirmed > active_training > repeated > observed', () => {
    const plan = planCurriculum({
      evidence: [
        snapshot('past_tense', 'relapsed'),
        snapshot('articles', 'confirmed'),
        snapshot('fluency', 'active_training'),
        snapshot('core_vocabulary', 'repeated'),
        snapshot('detail_listening', 'observed'),
      ],
      maxItems: 10,
    });
    const order = plan.recommendations.map((r) => r.skillId);
    expect(order.indexOf('past_tense')).toBeLessThan(order.indexOf('articles'));
    expect(order.indexOf('articles')).toBeLessThan(order.indexOf('fluency'));
    expect(order.indexOf('fluency')).toBeLessThan(order.indexOf('core_vocabulary'));
    expect(order.indexOf('core_vocabulary')).toBeLessThan(order.indexOf('detail_listening'));
  });

  it('13. improving remains eligible', () => {
    const plan = planCurriculum({ evidence: [snapshot('word_stress', 'improving')] });
    const item = plan.recommendations.find((r) => r.skillId === 'word_stress');
    expect(item).toBeDefined();
    expect(item?.reasons.some((r) => r.code === 'improving_in_rotation')).toBe(true);
  });

  it('14. stable is deprioritized below eligible states', () => {
    const plan = planCurriculum({
      evidence: [snapshot('phrasal_verbs', 'stable'), snapshot('articles', 'confirmed')],
      maxItems: 10,
    });
    const stableIdx = plan.recommendations.findIndex((r) => r.skillId === 'phrasal_verbs');
    const confirmedIdx = plan.recommendations.findIndex((r) => r.skillId === 'articles');
    expect(confirmedIdx).toBeLessThan(stableIdx);
  });

  it('14a. stable evidence never emits new_skill', () => {
    const plan = planCurriculum({ evidence: [snapshot('phrasal_verbs', 'stable')], maxItems: 50 });
    const item = plan.recommendations.find((r) => r.skillId === 'phrasal_verbs');
    expect(item).toBeDefined();
    expect(item?.reasons.some((r) => r.code === 'new_skill')).toBe(false);
    expect(item?.reasons.some((r) => r.code === 'stable_maintenance')).toBe(true);
  });

  it('14b. stable evidence keeps lifecycleState === stable and status === evidenced', () => {
    const plan = planCurriculum({ evidence: [snapshot('phrasal_verbs', 'stable')], maxItems: 50 });
    const item = plan.recommendations.find((r) => r.skillId === 'phrasal_verbs');
    expect(item?.lifecycleState).toBe('stable');
    expect(item?.status).toBe('evidenced');
  });

  it('14c. stable reason message is honest and never claims new', () => {
    const plan = planCurriculum({ evidence: [snapshot('phrasal_verbs', 'stable')], maxItems: 50 });
    const reason = plan.recommendations
      .find((r) => r.skillId === 'phrasal_verbs')
      ?.reasons.find((r) => r.code === 'stable_maintenance');
    expect(reason?.message.toLowerCase()).toContain('stable');
    expect(reason?.message.toLowerCase()).not.toContain('no learner evidence');
  });

  it('14d. stable remains below unresolved weakness states', () => {
    const plan = planCurriculum({
      evidence: [
        snapshot('phrasal_verbs', 'stable'),
        snapshot('articles', 'confirmed'),
        snapshot('fluency', 'active_training'),
        snapshot('core_vocabulary', 'repeated'),
        snapshot('detail_listening', 'observed'),
      ],
      maxItems: 50,
    });
    const order = plan.recommendations.map((r) => r.skillId);
    const stableIdx = order.indexOf('phrasal_verbs');
    for (const above of ['articles', 'fluency', 'core_vocabulary', 'detail_listening']) {
      expect(order.indexOf(above), `${above} should rank above stable`).toBeLessThan(stableIdx);
    }
  });

  it('14e. unobserved/new skill still correctly emits new_skill', () => {
    const plan = planCurriculum({ maxItems: 50 });
    const item = plan.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(item?.lifecycleState).toBeNull();
    expect(item?.status).toBe('unobserved');
    expect(item?.reasons.some((r) => r.code === 'new_skill')).toBe(true);
    expect(item?.reasons.some((r) => r.code === 'stable_maintenance')).toBe(false);
  });

  it('15. mastered is normally excluded', () => {
    const plan = planCurriculum({ evidence: [snapshot('sentence_structure', 'mastered')], maxItems: 50 });
    expect(plan.recommendations.find((r) => r.skillId === 'sentence_structure')).toBeUndefined();
  });

  it('mastered WITH an unresolved prerequisite is still excluded', () => {
    const plan = planCurriculum({
      evidence: [snapshot('articles', 'mastered'), snapshot('sentence_structure', 'mastered')],
      maxItems: 50,
    });
    expect(plan.recommendations.find((r) => r.skillId === 'articles')).toBeUndefined();
    expect(plan.recommendations.find((r) => r.skillId === 'sentence_structure')).toBeUndefined();
  });
});

// =========================================================================
// 16-17. PREREQUISITE POLICY
// =========================================================================

describe('prerequisite policy', () => {
  it('16. unresolved prerequisite blocks the dependent from ranking ahead', () => {
    const plan = planCurriculum({
      evidence: [snapshot('sentence_structure', 'confirmed'), snapshot('prepositions', 'relapsed')],
      maxItems: 10,
    });
    const sentenceIdx = plan.recommendations.findIndex((r) => r.skillId === 'sentence_structure');
    const prepositionsIdx = plan.recommendations.findIndex((r) => r.skillId === 'prepositions');
    expect(sentenceIdx).toBeGreaterThanOrEqual(0);
    expect(prepositionsIdx).toBeGreaterThan(sentenceIdx);
    const blocked = plan.recommendations.find((r) => r.skillId === 'prepositions');
    expect(blocked?.blockedByPrerequisites.length).toBeGreaterThan(0);
  });

  it('17. resolved prerequisites allow the dependent to rank ahead', () => {
    const plan = planCurriculum({
      evidence: [
        snapshot('sentence_structure', 'mastered'),
        snapshot('past_tense', 'improving'),
        snapshot('relative_clauses', 'relapsed'),
      ],
      maxItems: 10,
    });
    const item = plan.recommendations.find((r) => r.skillId === 'relative_clauses');
    expect(item).toBeDefined();
    expect(item?.blockedByPrerequisites).toEqual([]);
    expect(plan.recommendations[0].skillId).toBe('relative_clauses');
  });

  it('a third prerequisite level also honours the policy', () => {
    const unresolved = planCurriculum({
      evidence: [
        snapshot('gist_listening', 'confirmed'),
        snapshot('detail_listening', 'confirmed'),
        snapshot('inference_listening', 'relapsed'),
      ],
      maxItems: 10,
    });
    const detailIdx = unresolved.recommendations.findIndex((r) => r.skillId === 'detail_listening');
    const inferenceIdx = unresolved.recommendations.findIndex(
      (r) => r.skillId === 'inference_listening',
    );
    expect(inferenceIdx).toBeGreaterThan(detailIdx);
  });
});

// =========================================================================
// 18-19. FILTERING & LIMITS
// =========================================================================

describe('filtering and limits', () => {
  it('18. requested domain filtering returns only that domain', () => {
    for (const domain of SUPPORTED_DOMAINS) {
      const plan = planCurriculum({ requestedDomain: domain, maxItems: 50 });
      expect(plan.requestedDomain).toBe(domain);
      expect(plan.recommendations.length).toBeGreaterThan(0);
      for (const rec of plan.recommendations) {
        expect(rec.domain).toBe(domain);
      }
    }
  });

  it('19. maxItems is respected', () => {
    expect(planCurriculum({ maxItems: 1 }).recommendations.length).toBeLessThanOrEqual(1);
    expect(planCurriculum({ maxItems: 3 }).recommendations.length).toBeLessThanOrEqual(3);
    expect(planCurriculum({}).recommendations.length).toBeLessThanOrEqual(DEFAULT_MAX_ITEMS);
    expect(planCurriculum({ maxItems: 0 }).recommendations).toEqual([]);
  });

  it('an invalid maxItems falls back to the default', () => {
    expect(planCurriculum({ maxItems: -5 }).recommendations.length).toBeLessThanOrEqual(
      DEFAULT_MAX_ITEMS,
    );
    expect(planCurriculum({ maxItems: 2.5 }).recommendations.length).toBeLessThanOrEqual(
      DEFAULT_MAX_ITEMS,
    );
  });
});

// =========================================================================
// BLOCKER 1 — INVALID REQUESTED DOMAIN IS ACTUALLY IGNORED
// =========================================================================

describe('BLOCKER 1: invalid requested domain is safely ignored', () => {
  const invalid = 'not_a_domain' as unknown as SkillDomain;

  it('does not filter out every skill', () => {
    const plan = planCurriculum({ requestedDomain: invalid, maxItems: 50 });
    expect(plan.recommendations.length).toBeGreaterThan(0);
  });

  it('produces the SAME plan as no domain filter at all', () => {
    const filtered = planCurriculum({ requestedDomain: invalid, maxItems: 50 });
    const unfiltered = planCurriculum({ maxItems: 50 });
    expect(filtered.recommendations).toEqual(unfiltered.recommendations);
  });

  it('does not expose the invalid value as an applied requestedDomain', () => {
    const plan = planCurriculum({ requestedDomain: invalid, maxItems: 50 });
    expect(plan.requestedDomain).toBeUndefined();
  });

  it('adds an honest note about the ignored domain', () => {
    const plan = planCurriculum({ requestedDomain: invalid, maxItems: 50 });
    expect(plan.notes.join(' ').toLowerCase()).toContain('not supported');
  });

  it('still applies a supported domain filter normally', () => {
    const plan = planCurriculum({ requestedDomain: 'grammar', maxItems: 50 });
    expect(plan.requestedDomain).toBe('grammar');
    expect(plan.recommendations.every((r) => r.domain === 'grammar')).toBe(true);
  });
});

// =========================================================================
// BLOCKER 2 — NO-EVIDENCE SKILLS ARE NOT FABRICATED AS "observed"
// =========================================================================

describe('BLOCKER 2: no-evidence skills are not exposed as observed', () => {
  it('a skill with no evidence has lifecycleState null and status unobserved', () => {
    const plan = planCurriculum({ maxItems: 50 });
    const noEvidence = plan.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(noEvidence).toBeDefined();
    expect(noEvidence?.lifecycleState).toBeNull();
    expect(noEvidence?.status).toBe('unobserved');
  });

  it('no evidence is NOT equal to observed', () => {
    const plan = planCurriculum({ maxItems: 50 });
    const noEvidence = plan.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(noEvidence?.lifecycleState).not.toBe('observed');

    const observedPlan = planCurriculum({
      evidence: [snapshot('sentence_structure', 'observed')],
      maxItems: 50,
    });
    const observed = observedPlan.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(observed?.lifecycleState).toBe('observed');
    expect(observed?.status).toBe('evidenced');

    expect(noEvidence?.lifecycleState).not.toBe(observed?.lifecycleState);
    expect(noEvidence?.status).not.toBe(observed?.status);
  });

  it('actual observed evidence remains observed', () => {
    const plan = planCurriculum({ evidence: [snapshot('articles', 'observed')], maxItems: 50 });
    const item = plan.recommendations.find((r) => r.skillId === 'articles');
    expect(item?.lifecycleState).toBe('observed');
    expect(item?.reasons.some((r) => r.code === 'observed')).toBe(true);
  });

  it('a new skill carries an honest new_skill reason', () => {
    const plan = planCurriculum({ maxItems: 50 });
    const item = plan.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(item?.reasons.some((r) => r.code === 'new_skill')).toBe(true);
    expect(item?.reasons.some((r) => r.code === 'observed')).toBe(false);
  });

  it('evidenced skills always report a lifecycleState; unobserved always null', () => {
    const plan = planCurriculum({
      evidence: [snapshot('present_tense', 'repeated')],
      maxItems: 50,
    });
    for (const rec of plan.recommendations) {
      if (rec.status === 'unobserved') {
        expect(rec.lifecycleState).toBeNull();
      } else {
        expect(rec.lifecycleState).not.toBeNull();
      }
    }
  });
});

// =========================================================================
// BLOCKER 3 — ACTIVE WEAKNESS MUST NOT CLAIM "confirmed"
// =========================================================================

describe('BLOCKER 3: active weakness does not claim confirmed', () => {
  it('active weakness materially affects priority', () => {
    const baseline = planCurriculum({ maxItems: 50 });
    const withWeakness = planCurriculum({ activeWeaknesses: ['sentence_structure'], maxItems: 50 });
    expect(withWeakness.recommendations).not.toEqual(baseline.recommendations);
    const baselineIdx = baseline.recommendations.findIndex((r) => r.skillId === 'sentence_structure');
    const weakIdx = withWeakness.recommendations.findIndex((r) => r.skillId === 'sentence_structure');
    expect(weakIdx).toBeLessThan(baselineIdx);
  });

  it('emits an active_weakness reason, never confirmed', () => {
    const plan = planCurriculum({ activeWeaknesses: ['sentence_structure'], maxItems: 50 });
    const item = plan.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(item?.reasons.some((r) => r.code === 'active_weakness')).toBe(true);
    expect(item?.reasons.some((r) => r.code === 'confirmed')).toBe(false);
  });

  it('does NOT mutate lifecycle state because of activeWeaknesses', () => {
    const plan = planCurriculum({ activeWeaknesses: ['sentence_structure'], maxItems: 50 });
    const item = plan.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(item?.lifecycleState).toBeNull();
    expect(item?.status).toBe('unobserved');
  });

  it('confirmed is emitted ONLY for actual confirmed lifecycle evidence', () => {
    const withConfirmed = planCurriculum({ evidence: [snapshot('articles', 'confirmed')], maxItems: 50 });
    expect(
      withConfirmed.recommendations.find((r) => r.skillId === 'articles')?.reasons.some(
        (r) => r.code === 'confirmed',
      ),
    ).toBe(true);

    const onlyWeakness = planCurriculum({ activeWeaknesses: ['articles'], maxItems: 50 });
    expect(
      onlyWeakness.recommendations.find((r) => r.skillId === 'articles')?.reasons.some(
        (r) => r.code === 'confirmed',
      ),
    ).toBe(false);
  });
});

// =========================================================================
// BLOCKER 4 — LEARNING GOAL APPLIED ONLY IF IT MATERIALLY CHANGES THE PLAN
// =========================================================================

describe('BLOCKER 4: learning goals are applied only when material', () => {
  it('A. goal that materially reorders across domains IS applied', () => {
    const baseline = planCurriculum({ maxItems: 50 });
    const withGoal = planCurriculum({ learningGoals: ['listening_comprehension'], maxItems: 50 });

    expect(withGoal.recommendations).not.toEqual(baseline.recommendations);
    expect(withGoal.appliedLearningGoals).toContain('listening_comprehension');

    const baseListening = baseline.recommendations.findIndex((r) => r.domain === 'listening');
    const goalListening = withGoal.recommendations.findIndex((r) => r.domain === 'listening');
    expect(goalListening).toBeLessThan(baseListening);
  });

  it('B. a goal fully constrained by requestedDomain changes nothing -> NOT applied', () => {
    const baseline = planCurriculum({ requestedDomain: 'pronunciation', maxItems: 50 });
    const withGoal = planCurriculum({
      requestedDomain: 'pronunciation',
      learningGoals: ['pronunciation_clarity'],
      maxItems: 50,
    });

    expect(withGoal.recommendations).toEqual(baseline.recommendations);
    expect(withGoal.appliedLearningGoals).toEqual([]);
    const notes = withGoal.notes.join(' ').toLowerCase();
    expect(notes).toContain('did not change the plan');
    expect(notes).not.toContain('prioritise');
  });

  it('C. a goal that changes which skills enter the final plan IS applied', () => {
    const baseline = planCurriculum({ maxItems: 1 });
    const withGoal = planCurriculum({ learningGoals: ['listening_comprehension'], maxItems: 1 });

    expect(withGoal.recommendations).not.toEqual(baseline.recommendations);
    expect(withGoal.appliedLearningGoals).toContain('listening_comprehension');
    expect(withGoal.recommendations[0].domain).toBe('listening');
  });

  it('D. an unmapped goal is NOT applied and claims no adaptation', () => {
    const plan = planCurriculum({
      requestedDomain: 'grammar',
      learningGoals: ['listening_comprehension'],
      maxItems: 50,
    });
    expect(plan.appliedLearningGoals).toEqual([]);
    expect(plan.notes.join(' ').toLowerCase()).toContain('did not change the plan');
  });

  it('no goals supplied -> no applied goals claimed', () => {
    const plan = planCurriculum({ maxItems: 50 });
    expect(plan.appliedLearningGoals).toEqual([]);
  });

  it('applied goals are deterministic across repeated calls', () => {
    const input: CurriculumPlannerInput = { learningGoals: ['listening_comprehension'], maxItems: 50 };
    const a = planCurriculum(input).appliedLearningGoals;
    for (let i = 0; i < 10; i += 1) {
      expect(planCurriculum(input).appliedLearningGoals).toEqual(a);
    }
  });

  it('every goal hint maps to at least one domain', () => {
    for (const goal of Object.keys(GOAL_DOMAIN_WEIGHTS) as LearningGoalHint[]) {
      expect(GOAL_DOMAIN_WEIGHTS[goal].length, goal).toBeGreaterThan(0);
    }
  });
});

// =========================================================================
// HONESTY HARDENING — RECENT PRACTICE TRACEABILITY
// =========================================================================

describe('recent practice is traceable', () => {
  it('recently practised skills are deprioritized with a visible reason', () => {
    const baseline = planCurriculum({ maxItems: 50 });
    const withRecent = planCurriculum({ recentlyPractised: ['sentence_structure'], maxItems: 50 });

    expect(withRecent.recommendations).not.toEqual(baseline.recommendations);
    const item = withRecent.recommendations.find((r) => r.skillId === 'sentence_structure');
    expect(item?.reasons.some((r) => r.code === 'recently_practised')).toBe(true);

    const baseIdx = baseline.recommendations.findIndex((r) => r.skillId === 'sentence_structure');
    const recentIdx = withRecent.recommendations.findIndex((r) => r.skillId === 'sentence_structure');
    expect(recentIdx).toBeGreaterThan(baseIdx);
  });

  it('the reason message explains the deprioritization without numbers', () => {
    const plan = planCurriculum({ recentlyPractised: ['sentence_structure'], maxItems: 50 });
    const reason = plan.recommendations
      .find((r) => r.skillId === 'sentence_structure')
      ?.reasons.find((r) => r.code === 'recently_practised');
    expect(reason?.message).toContain('deprioritized');
    expect(reason?.message).not.toMatch(/\d/);
  });

  it('a skill is not marked recently_practised unless it was', () => {
    const plan = planCurriculum({ maxItems: 50 });
    expect(
      plan.recommendations.some((r) => r.reasons.some((x) => x.code === 'recently_practised')),
    ).toBe(false);
  });
});

// =========================================================================
// 22-24. NO SCORES / PERCENTAGES / CEFR
// =========================================================================

describe('no scoring model', () => {
  it('22. plans and recommendations carry no score field', () => {
    const plan = planCurriculum({
      evidence: [snapshot('present_tense', 'relapsed'), snapshot('fluency', 'improving')],
    });
    expect(collectScoreLikeKeys(plan)).toEqual([]);
    expect(collectScoreLikeKeys(SKILL_CATALOG)).toEqual([]);
  });

  it('23. no mastery percentage anywhere', () => {
    const text = JSON.stringify(SKILL_CATALOG).toLowerCase();
    expect(text).not.toContain('percentage');
    expect(text).not.toContain('mastery score');
  });

  it('24. no CEFR mapping', () => {
    const text = JSON.stringify(SKILL_CATALOG).toUpperCase();
    expect(text).not.toContain('CEFR');
    expect(text).not.toMatch(/\bA1\b|\bA2\b|\bB1\b|\bB2\b|\bC1\b|\bC2\b/);
    const plan = planCurriculum({});
    expect(JSON.stringify(plan).toUpperCase()).not.toContain('CEFR');
  });

  it('lifecycle states stay qualitative and unchanged', () => {
    expect([...SKILL_LIFECYCLE_STATES]).toEqual([
      'observed',
      'repeated',
      'confirmed',
      'active_training',
      'improving',
      'stable',
      'mastered',
      'relapsed',
    ]);
  });

  it('evidenceCount is metadata only and never surfaces in the plan', () => {
    const plan = planCurriculum({
      evidence: [{ skillId: 'present_tense', lifecycleState: 'repeated', evidenceCount: 42 }],
    });
    expect(JSON.stringify(plan)).not.toContain('42');
  });

  it('reasons are honest and only reference real applied factors', () => {
    const plan = planCurriculum({
      evidence: [snapshot('present_tense', 'relapsed')],
      activeWeaknesses: ['present_tense'],
      learningGoals: ['grammar_accuracy'],
      maxItems: 1,
    });
    const top = plan.recommendations[0];
    expect(top.skillId).toBe('present_tense');
    const codes = top.reasons.map((r) => r.code);
    expect(codes).toContain('relapsed');
    expect(codes).toContain('learning_goal_domain');
    const withoutGoal = planCurriculum({ evidence: [snapshot('present_tense', 'relapsed')], maxItems: 1 });
    expect(withoutGoal.recommendations[0].reasons.map((r) => r.code)).not.toContain(
      'learning_goal_domain',
    );
  });
});

// =========================================================================
// 25-29. NO AI / NETWORK / PERSISTENCE / SQLITE / REACT
// =========================================================================

describe('no prohibited dependencies', () => {
  const sources = (() => {
    const dir = __dirname;
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'index.test.ts')
      .map((f) => readFileSync(join(dir, f), 'utf8'));
  })();

  it('25. no AI import and no network call', () => {
    const joined = sources.join('\n');
    expect(/from\s+['"](openai|@openai|anthropic|@anthropic|google-genai|@google)/.test(joined)).toBe(false);
    expect(/\bfetch\s*\(|XMLHttpRequest|axios/.test(joined)).toBe(false);
  });

  it('26. no persistence', () => {
    const joined = sources.join('\n');
    expect(/from\s+['"].*(repository|storage|database)/.test(joined)).toBe(false);
    expect(/\bpersist|localStorage|AsyncStorage/.test(joined)).toBe(false);
  });

  it('27. no SQLite', () => {
    const joined = sources.join('\n');
    expect(/sqlite/i.test(joined)).toBe(false);
  });

  it('28. no React', () => {
    const joined = sources.join('\n');
    expect(/from\s+['"]react['"]|from\s+['"]react-native/.test(joined)).toBe(false);
  });

  it('29. no navigation', () => {
    const joined = sources.join('\n');
    expect(/@react-navigation|useNavigation|navigation\.navigate/.test(joined)).toBe(false);
  });

  it('no clock or randomness in the planner', () => {
    const joined = sources.join('\n');
    expect(/Date\.now|Math\.random|new Date\(/.test(joined)).toBe(false);
  });
});

// =========================================================================
// 30-31. SAFE HANDLING OF BAD INPUT
// =========================================================================

describe('safe handling of invalid input', () => {
  it('30. invalid / missing skill IDs fail safely', () => {
    expect(() =>
      planCurriculum({
        evidence: [
          { skillId: '', lifecycleState: 'relapsed' },
          { skillId: 'does_not_exist', lifecycleState: 'confirmed' },
          { skillId: 'present_tense', lifecycleState: 'repeated' },
        ],
        activeWeaknesses: ['ghost_skill'],
        recentlyPractised: ['also_ghost'],
      }),
    ).not.toThrow();

    const plan = planCurriculum({
      evidence: [{ skillId: 'does_not_exist', lifecycleState: 'relapsed' }],
      maxItems: 5,
    });
    expect(plan.recommendations.every((r) => getSkill(r.skillId) !== undefined)).toBe(true);
  });

  it('an empty input yields a usable default plan', () => {
    const plan = planCurriculum();
    expect(plan.recommendations.length).toBeGreaterThan(0);
    expect(plan.recommendations.length).toBeLessThanOrEqual(DEFAULT_MAX_ITEMS);
    expect(plan.appliedLearningGoals).toEqual([]);
  });

  it('31. duplicate evidence snapshots are handled deterministically (first wins)', () => {
    const dupes: SkillEvidenceSnapshot[] = [
      { skillId: 'present_tense', lifecycleState: 'relapsed' },
      { skillId: 'present_tense', lifecycleState: 'mastered' },
    ];
    const a = planCurriculum({ evidence: dupes });
    const b = planCurriculum({ evidence: dupes });
    expect(b).toEqual(a);
    expect(a.recommendations[0].skillId).toBe('present_tense');
    expect(a.recommendations[0].reasons.some((r) => r.code === 'relapsed')).toBe(true);
  });

  it('a plan is a plain serialisable object', () => {
    const plan = planCurriculum({ learningGoals: ['everyday_fluency'] });
    expect(JSON.parse(JSON.stringify(plan)) as CurriculumPlan).toEqual(plan);
  });
});
