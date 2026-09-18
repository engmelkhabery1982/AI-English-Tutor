/**
 * The pure Daily Tutor planner.
 *
 * Pinned invariants:
 * - determinism (same input → identical plan, byte for byte),
 * - bounds (3–5 activities, honest estimates, bounded review subsets),
 * - the REAL-evidence selection policy (due review first, urgent weakness
 *   retraining, curriculum progression, balanced general fill),
 * - modality variety (family caps, no all-speaking plans),
 * - honesty (no fabricated evidence-driven claims; general fill says so).
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ACTIVITIES,
  MAX_REVIEW_LIMIT,
  MIN_ACTIVITIES,
  TARGET_MINUTES_MAX,
  chooseProfessionalCategory,
  hasProfessionalGoal,
  interleaveForVariety,
  mapLearningGoalsToCurriculumHints,
  planDailyTutorSession,
  pickTopWeakness,
  weaknessStatusPriority,
} from './planner';
import type { ActivityCandidate } from './planner';
import type {
  DailyActivityKind,
  DailyTutorPlanningInput,
  DailyTutorWeaknessEvidence,
} from './types';

const BASE_DATE = '2026-09-18';

function emptyInput(overrides: Partial<DailyTutorPlanningInput> = {}): DailyTutorPlanningInput {
  return {
    learnerId: 'learner-1',
    dateKey: BASE_DATE,
    learningGoals: [],
    dueVocabularyCount: 0,
    dueExpressionCount: 0,
    dueOtherReviewCount: 0,
    dueReview: { vocabulary: 0, expression: 0, grammar: 0, pronunciation: 0, listening: 0 },
    activeWeaknesses: [],
    unresolvedPronunciationCount: 0,
    pronunciationTargets: [],
    curriculum: [],
    recentSessions: [],
    recentConversations: [],
    ...overrides,
  };
}

function weakness(
  overrides: Partial<DailyTutorWeaknessEvidence> = {},
): DailyTutorWeaknessEvidence {
  return {
    id: 'w-1',
    type: 'grammar',
    status: 'observed',
    severity: 3,
    occurrenceCount: 2,
    ...overrides,
  };
}

function kindsOf(input: DailyTutorPlanningInput): DailyActivityKind[] {
  return planDailyTutorSession(input).activities.map((a) => a.kind);
}

describe('planner bounds', () => {
  it('an empty learner gets an honest balanced session of 3–5 activities', () => {
    const plan = planDailyTutorSession(emptyInput());
    expect(plan.activities.length).toBeGreaterThanOrEqual(MIN_ACTIVITIES);
    expect(plan.activities.length).toBeLessThanOrEqual(MAX_ACTIVITIES);
    expect(plan.sourceMode).toBe('general');
    expect(plan.headline).toContain('balanced');
  });

  it('never plans fewer than 3 or more than 5 activities', () => {
    const loaded = emptyInput({
      dueVocabularyCount: 30,
      dueExpressionCount: 30,
      dueOtherReviewCount: 30,
      activeWeaknesses: [
        weakness({ id: 'w1', type: 'grammar', status: 'relapsed' }),
        weakness({ id: 'w2', type: 'vocabulary', status: 'confirmed' }),
        weakness({ id: 'w3', type: 'listening', status: 'active_training' }),
      ],
      unresolvedPronunciationCount: 5,
      pronunciationTargets: ['th'],
      curriculum: [
        { skillId: 'past_simple_questions', domain: 'grammar', title: 'Past simple questions', lifecycleState: 'active_training' },
        { skillId: 'word_stress', domain: 'pronunciation', title: 'Word stress', lifecycleState: 'observed' },
        { skillId: 'requests_and_clarification', domain: 'speaking', title: 'Requests', lifecycleState: null },
      ],
      learningGoals: ['professional_emails'],
    });
    const plan = planDailyTutorSession(loaded);
    expect(plan.activities.length).toBeGreaterThanOrEqual(MIN_ACTIVITIES);
    expect(plan.activities.length).toBeLessThanOrEqual(MAX_ACTIVITIES);
  });

  it('keeps the total estimate within the guidance window', () => {
    const loaded = emptyInput({
      dueVocabularyCount: 50,
      dueExpressionCount: 50,
      dueOtherReviewCount: 50,
      activeWeaknesses: [weakness({ status: 'relapsed' })],
      unresolvedPronunciationCount: 9,
      pronunciationTargets: ['th'],
      curriculum: [
        { skillId: 'past_simple_questions', domain: 'grammar', title: 'Past simple', lifecycleState: 'repeated' },
        { skillId: 'elaboration', domain: 'speaking', title: 'Elaborate', lifecycleState: 'observed' },
      ],
    });
    const plan = planDailyTutorSession(loaded);
    expect(plan.estimatedMinutes).toBeLessThanOrEqual(TARGET_MINUTES_MAX);
    expect(plan.estimatedMinutes).toBeGreaterThan(0);
  });

  it('clamps the review subset to a bounded limit', () => {
    const plan = planDailyTutorSession(emptyInput({ dueVocabularyCount: 200 }));
    const vocabulary = plan.activities.find((a) => a.kind === 'vocabulary');
    expect(vocabulary).toBeDefined();
    expect(vocabulary!.target.reviewLimit).toBeLessThanOrEqual(MAX_REVIEW_LIMIT);
    expect(vocabulary!.target.reviewLimit).toBeGreaterThan(0);
  });

  it('activity ids are deterministic and kind-scoped per date', () => {
    const plan = planDailyTutorSession(emptyInput());
    for (const activity of plan.activities) {
      expect(activity.id).toBe(`dt:${BASE_DATE}:${activity.kind}`);
    }
    const ids = new Set(plan.activities.map((a) => a.id));
    expect(ids.size).toBe(plan.activities.length); // unique per session
  });
});

describe('planner determinism', () => {
  it('the same input produces the identical plan (deep equality)', () => {
    const input = emptyInput({
      dueVocabularyCount: 4,
      activeWeaknesses: [weakness({ status: 'relapsed' })],
      curriculum: [
        { skillId: 'elaboration', domain: 'speaking', title: 'Elaborate', lifecycleState: 'observed' },
      ],
    });
    expect(planDailyTutorSession(input)).toEqual(planDailyTutorSession(input));
  });

  it('planning twice for the same learner+date never differs', () => {
    const input = emptyInput({
      learningGoals: ['job_interviews'],
      recentSessions: [{ dateKey: '2026-09-17', kinds: ['listening'] }],
    });
    const first = JSON.stringify(planDailyTutorSession(input));
    const second = JSON.stringify(planDailyTutorSession(input));
    expect(first).toBe(second);
  });

  it('a different date changes the plan identity', () => {
    const a = planDailyTutorSession(emptyInput({ dateKey: '2026-09-18' }));
    const b = planDailyTutorSession(emptyInput({ dateKey: '2026-09-19' }));
    expect(a.activities[0].id).not.toBe(b.activities[0].id);
  });
});

describe('selection policy: due review first', () => {
  it('due vocabulary review is planned as a vocabulary activity', () => {
    const kinds = kindsOf(emptyInput({ dueVocabularyCount: 5 }));
    expect(kinds).toContain('vocabulary');
  });

  it('due expressions review is planned as an expressions activity', () => {
    const kinds = kindsOf(emptyInput({ dueExpressionCount: 3 }));
    expect(kinds).toContain('expressions');
  });

  it('other due review (grammar/pronunciation/listening) is planned as review', () => {
    const kinds = kindsOf(emptyInput({ dueOtherReviewCount: 2 }));
    expect(kinds).toContain('review');
  });

  it('due review outranks general balanced fill', () => {
    const plan = planDailyTutorSession(emptyInput({ dueVocabularyCount: 5 }));
    expect(plan.activities[0].kind).toBe('vocabulary');
    expect(plan.sourceMode).not.toBe('general');
  });

  it('review-family activities are capped at two per session', () => {
    const kinds = kindsOf(
      emptyInput({ dueVocabularyCount: 9, dueExpressionCount: 9, dueOtherReviewCount: 9 }),
    );
    const reviewFamily = kinds.filter((k) => k === 'review' || k === 'vocabulary' || k === 'expressions');
    expect(reviewFamily.length).toBeLessThanOrEqual(2);
  });
});

describe('selection policy: weakness lifecycle', () => {
  it('weaknessStatusPriority follows the curriculum lifecycle order', () => {
    expect(weaknessStatusPriority('relapsed')).toBeGreaterThan(weaknessStatusPriority('confirmed'));
    expect(weaknessStatusPriority('confirmed')).toBeGreaterThan(weaknessStatusPriority('active_training'));
    expect(weaknessStatusPriority('active_training')).toBeGreaterThan(weaknessStatusPriority('repeated'));
    expect(weaknessStatusPriority('repeated')).toBeGreaterThan(weaknessStatusPriority('observed'));
    expect(weaknessStatusPriority('observed')).toBeGreaterThan(weaknessStatusPriority('improving'));
    expect(weaknessStatusPriority('improving')).toBeGreaterThan(weaknessStatusPriority('stable'));
    expect(weaknessStatusPriority('mastered')).toBe(0);
  });

  it('pickTopWeakness ranks relapsed above confirmed above active_training', () => {
    const relapsed = weakness({ id: 'w-relapsed', status: 'relapsed', severity: 1, occurrenceCount: 1 });
    const confirmed = weakness({ id: 'w-confirmed', status: 'confirmed', severity: 5, occurrenceCount: 9 });
    const training = weakness({ id: 'w-training', status: 'active_training', severity: 5, occurrenceCount: 9 });
    const top = pickTopWeakness([training, confirmed, relapsed]);
    expect(top?.id).toBe('w-relapsed');
  });

  it('pickTopWeakness breaks ties by severity, then occurrence count, then id', () => {
    const low = weakness({ id: 'w-a', status: 'confirmed', severity: 2, occurrenceCount: 9 });
    const high = weakness({ id: 'w-b', status: 'confirmed', severity: 4, occurrenceCount: 1 });
    expect(pickTopWeakness([low, high])?.id).toBe('w-b');

    const byCount = weakness({ id: 'w-c', status: 'confirmed', severity: 4, occurrenceCount: 2 });
    expect(pickTopWeakness([high, byCount])?.id).toBe('w-c');
  });

  it('pickTopWeakness excludes non-retraining statuses (observed/improving/stable/mastered)', () => {
    expect(
      pickTopWeakness([
        weakness({ status: 'observed' }),
        weakness({ status: 'improving' }),
        weakness({ status: 'stable' }),
        weakness({ status: 'mastered' }),
      ]),
    ).toBeNull();
  });

  it('an urgent weakness drives a weakness_retraining activity near the top', () => {
    const plan = planDailyTutorSession(
      emptyInput({
        dueVocabularyCount: 2,
        activeWeaknesses: [weakness({ type: 'grammar', status: 'relapsed', label: 'past simple questions' })],
      }),
    );
    const retraining = plan.activities.find((a) => a.kind === 'weakness_retraining');
    expect(retraining).toBeDefined();
    expect(plan.activities.indexOf(retraining!)).toBeLessThanOrEqual(1); // with the due review at top
    // The practice type IS passed to the child (the coach is conditioned on
    // it); the specific weakness identity is deliberately NOT claimed.
    expect(retraining!.target.practiceType).toBe('weakness_retraining');
    expect(retraining!.reason).toContain('relapsed');
  });

  it('a mastered weakness never drives retraining', () => {
    const kinds = kindsOf(emptyInput({ activeWeaknesses: [weakness({ status: 'mastered' })] }));
    expect(kinds).not.toContain('weakness_retraining');
  });

  it('a real listening weakness retraining goes to the Listening Engine', () => {
    const kinds = kindsOf(
      emptyInput({ activeWeaknesses: [weakness({ type: 'listening', status: 'confirmed' })] }),
    );
    expect(kinds).toContain('listening');
    const listening = planDailyTutorSession(
      emptyInput({ activeWeaknesses: [weakness({ type: 'listening', status: 'confirmed' })] }),
    ).activities.find((a) => a.kind === 'listening');
    expect(listening!.reason).toContain('listening weakness');
  });
});

describe('selection policy: curriculum progression', () => {
  it('curriculum recommendations map to the matching activity kinds by domain', () => {
    const kinds = kindsOf(
      emptyInput({
        curriculum: [
          { skillId: 'past_simple_questions', domain: 'grammar', title: 'Past simple questions', lifecycleState: 'active_training' },
          { skillId: 'elaboration', domain: 'speaking', title: 'Elaboration', lifecycleState: 'observed' },
          { skillId: 'requests_and_clarification', domain: 'listening', title: 'Requests', lifecycleState: null },
        ],
      }),
    );
    expect(kinds).toContain('adaptive_lesson');
    expect(kinds).toContain('deep_speaking');
    expect(kinds).toContain('listening');
  });

  it('curriculum evidence is consumed honestly: the reason quotes the lifecycle, never a skill the child cannot train', () => {
    const plan = planDailyTutorSession(
      emptyInput({
        curriculum: [
          { skillId: 'past_simple_questions', domain: 'grammar', title: 'Past simple questions', lifecycleState: 'repeated' },
        ],
      }),
    );
    const lesson = plan.activities.find((a) => a.kind === 'adaptive_lesson');
    expect(lesson).toBeDefined();
    // The Adaptive Lesson engine picks its own steps — the target must NOT
    // claim a skill id the child is not conditioned on.
    expect(lesson!.target.skillId).toBeUndefined();
    expect(lesson!.target.domain).toBeUndefined();
    expect(lesson!.reason).toContain('Curriculum progression');
    expect(lesson!.reason).toContain('repeated');
    expect(lesson!.reason).toContain('adaptive lesson picks the exact steps');
  });

  it('a curriculum speaking skill maps to a Deep Speaking practice type (conditioned child)', () => {
    const plan = planDailyTutorSession(
      emptyInput({
        curriculum: [
          { skillId: 'elaboration', domain: 'speaking', title: 'Elaboration', lifecycleState: 'observed' },
        ],
      }),
    );
    const speaking = plan.activities.find((a) => a.kind === 'deep_speaking');
    expect(speaking).toBeDefined();
    // The speaking coach IS conditioned on the mapped practice type, so the
    // skill may be claimed and its provenance kept.
    expect(speaking!.target.practiceType).toBe('explain_and_expand');
    expect(speaking!.target.skillId).toBe('elaboration');
    expect(speaking!.target.domain).toBe('speaking');
    expect(speaking!.title).toBe('Speaking \u2014 Elaboration');
    expect(speaking!.reason).toContain('practiced as explain and expand speaking');
  });

  it('an UNKNOWN curriculum speaking skill claims only the modality (no skill, no practice type)', () => {
    const plan = planDailyTutorSession(
      emptyInput({
        curriculum: [
          { skillId: 'brand_new_skill', domain: 'speaking', title: 'Brand New Skill', lifecycleState: 'observed' },
        ],
      }),
    );
    const speaking = plan.activities.find((a) => a.kind === 'deep_speaking');
    expect(speaking).toBeDefined();
    expect(speaking!.title).toBe('Speaking practice'); // no skill claim
    expect(speaking!.target.skillId).toBeUndefined();
    expect(speaking!.target.practiceType).toBeUndefined();
  });

  it('an unobserved curriculum pronunciation skill is skipped (honesty)', () => {
    // No stored pronunciation evidence → nothing honest to practise.
    const kinds = kindsOf(
      emptyInput({
        curriculum: [
          { skillId: 'word_stress', domain: 'pronunciation', title: 'Word stress', lifecycleState: null },
        ],
      }),
    );
    expect(kinds).not.toContain('pronunciation');
  });

  it('pronunciation practice requires REAL unresolved pronunciation evidence', () => {
    const withoutEvidence = kindsOf(emptyInput({ unresolvedPronunciationCount: 0 }));
    expect(withoutEvidence).not.toContain('pronunciation');

    const withEvidence = kindsOf(
      emptyInput({ unresolvedPronunciationCount: 3, pronunciationTargets: ['th sound'] }),
    );
    expect(withEvidence).toContain('pronunciation');
  });
});

describe('selection policy: professional english from goals only', () => {
  it('is planned only when a real professional goal exists', () => {
    expect(hasProfessionalGoal([])).toBe(false);
    expect(hasProfessionalGoal(['everyday_fluency'])).toBe(false);
    expect(hasProfessionalGoal(['job_interviews'])).toBe(true);
    expect(hasProfessionalGoal(['professional_emails', 'everyday_fluency'])).toBe(true);
  });

  it('is planned on alternating days only, never daily', () => {
    const dates = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'];
    const planned = dates.filter((dateKey) =>
      kindsOf(emptyInput({ dateKey, learningGoals: ['job_interviews'] })).includes('professional_english'),
    );
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.length).toBeLessThan(dates.length); // never every day
    // No two consecutive days.
    for (let i = 1; i < planned.length; i += 1) {
      expect(planned[i]).not.toBe(nextDay(planned[i - 1]));
    }
  });

  it('is not planned the day after professional practice (recency)', () => {
    const yesterday = '2026-09-17';
    const kinds = kindsOf(
      emptyInput({
        dateKey: '2026-09-18',
        learningGoals: ['job_interviews'],
        recentSessions: [{ dateKey: yesterday, kinds: ['professional_english', 'review'] }],
      }),
    );
    expect(kinds).not.toContain('professional_english');
  });

  it('chooseProfessionalCategory is deterministic and goal-driven', () => {
    const goals = ['professional_emails', 'job_interviews'];
    expect(chooseProfessionalCategory(goals, '2026-09-18')).toBe(
      chooseProfessionalCategory(goals, '2026-09-18'),
    );
    expect(typeof chooseProfessionalCategory(goals, '2026-09-18')).toBe('string');
  });
});

describe('selection policy: recency and variety', () => {
  it('a kind practised yesterday is deprioritized (not urgent)', () => {
    const yesterday = '2026-09-17';
    const withoutRecent = kindsOf(
      emptyInput({
        curriculum: [
          { skillId: 'elaboration', domain: 'speaking', title: 'Elaboration', lifecycleState: 'observed' },
          { skillId: 'past_simple_questions', domain: 'grammar', title: 'Past simple', lifecycleState: 'repeated' },
        ],
      }),
    );
    const withRecent = kindsOf(
      emptyInput({
        curriculum: [
          { skillId: 'elaboration', domain: 'speaking', title: 'Elaboration', lifecycleState: 'observed' },
          { skillId: 'past_simple_questions', domain: 'grammar', title: 'Past simple', lifecycleState: 'repeated' },
        ],
        recentSessions: [{ dateKey: yesterday, kinds: ['deep_speaking'] }],
      }),
    );
    // Without recency pressure, speaking (higher curriculum rank) leads.
    expect(withoutRecent[0]).toBe('deep_speaking');
    // With yesterday's speaking practice, the grammar lesson takes over.
    expect(withRecent[0]).not.toBe('deep_speaking');
    expect(withRecent).toContain('adaptive_lesson');
  });

  it('urgent due review is exempt from recency penalties', () => {
    const kinds = kindsOf(
      emptyInput({
        dueVocabularyCount: 5,
        recentSessions: [{ dateKey: '2026-09-17', kinds: ['vocabulary', 'review'] }],
      }),
    );
    expect(kinds[0]).toBe('vocabulary'); // due review still leads
  });

  it('family caps prevent an all-speaking plan', () => {
    const kinds = kindsOf(
      emptyInput({
        curriculum: [
          { skillId: 'elaboration', domain: 'speaking', title: 'Elaboration', lifecycleState: 'observed' },
          { skillId: 'opinion_and_reasoning', domain: 'speaking', title: 'Opinions', lifecycleState: 'observed' },
          { skillId: 'reformulation', domain: 'speaking', title: 'Reformulation', lifecycleState: 'observed' },
        ],
        activeWeaknesses: [weakness({ type: 'grammar', status: 'relapsed' })],
        learningGoals: ['job_interviews'],
      }),
    );
    const speakingFamily = kinds.filter(
      (k) => k === 'deep_speaking' || k === 'professional_english' || k === 'weakness_retraining',
    );
    expect(speakingFamily.length).toBeLessThanOrEqual(2);
    // And the plan still has non-speaking modalities.
    expect(kinds.length - speakingFamily.length).toBeGreaterThan(0);
  });

  it('interleaveForVariety never places two same-family activities adjacent when avoidable', () => {
    const mk = (
      kind: DailyActivityKind,
      family: ActivityCandidate['family'],
      priority: number,
      index: number,
    ): ActivityCandidate => ({
      kind,
      title: kind,
      reason: '',
      target: {},
      priority,
      family,
      urgent: false,
      evidenceDriven: true,
      index,
    });
    const ordered = interleaveForVariety([
      mk('vocabulary', 'review', 100, 0),
      mk('expressions', 'review', 90, 1),
      mk('review', 'review', 80, 2),
    ]);
    // With only review-family entries nothing can interleave — order stands.
    expect(ordered.map((c) => c.kind)).toEqual(['vocabulary', 'expressions', 'review']);

    const mixed = interleaveForVariety([
      mk('vocabulary', 'review', 100, 0),
      mk('expressions', 'review', 90, 1),
      mk('listening', 'listening', 80, 2),
    ]);
    expect(mixed.map((c) => c.kind)).toEqual(['vocabulary', 'listening', 'expressions']);
  });

  it('recent conversations slightly deprioritize more speaking (variety)', () => {
    // A learner who already spoke twice outside the Daily Tutor gets the
    // speaking fill ranked below the other balanced fills.
    const quiet = kindsOf(emptyInput());
    const talkative = kindsOf(
      emptyInput({ recentConversations: [{ mode: 'natural' }, { mode: 'natural' }] }),
    );
    // Both plans contain all three balanced fills…
    expect(quiet).toContain('deep_speaking');
    expect(talkative).toContain('deep_speaking');
    // …but after two real conversations the speaking fill drops to the end.
    expect(talkative[talkative.length - 1]).toBe('deep_speaking');
  });
});

describe('planner honesty', () => {
  it('sourceMode is honest about evidence (general → mixed → personalized)', () => {
    expect(planDailyTutorSession(emptyInput()).sourceMode).toBe('general');

    const oneEvidence = planDailyTutorSession(emptyInput({ dueVocabularyCount: 3 }));
    expect(oneEvidence.sourceMode).toBe('mixed');

    const twoEvidence = planDailyTutorSession(
      emptyInput({ dueVocabularyCount: 3, activeWeaknesses: [weakness({ status: 'relapsed' })] }),
    );
    expect(twoEvidence.sourceMode).toBe('personalized');
  });

  it('the headline never claims fabricated drivers', () => {
    const general = planDailyTutorSession(emptyInput());
    expect(general.headline).toContain('personalize');

    const due = planDailyTutorSession(emptyInput({ dueVocabularyCount: 4, dueExpressionCount: 3 }));
    expect(due.headline).toContain('7 items are due for review');
  });

  it('estimated minutes are guidance estimates, never measurements', () => {
    const plan = planDailyTutorSession(emptyInput());
    for (const activity of plan.activities) {
      expect(activity.estimatedMinutes).toBeGreaterThan(0);
      expect(activity.estimatedMinutes).toBeLessThanOrEqual(7);
    }
    expect(plan.estimatedMinutes).toBe(
      plan.activities.reduce((sum, a) => sum + a.estimatedMinutes, 0),
    );
  });
});

describe('goal → curriculum hint mapping', () => {
  it('maps known goals and drops unmatched ones honestly', () => {
    const hints = mapLearningGoalsToCurriculumHints(['job_interviews', 'made_up_goal']);
    expect(hints).toContain('workplace_communication');
    expect(hints).not.toContain('made_up_goal');
    expect(mapLearningGoalsToCurriculumHints([])).toEqual([]);

    const listening = mapLearningGoalsToCurriculumHints(['listen better']);
    expect(listening).toContain('listening_comprehension');
  });

  it('each goal maps to at most one hint (deterministic order)', () => {
    const hints = mapLearningGoalsToCurriculumHints(['work', 'business', 'office']);
    expect(hints).toEqual(['workplace_communication']);
  });
});


/**
 * TARGET FIDELITY (BLOCKER-2 repair): for every activity kind, the planned
 * target may only carry what the launched child workflow actually consumes.
 * Plan -> persisted target -> child route is asserted per kind here and in
 * navigation/service tests.
 */
describe('target fidelity: the plan never claims a target the child cannot train', () => {
  it('review family: the bounded subset IS the target (the Review flow is conditioned on it)', () => {
    const plan = planDailyTutorSession(emptyInput({ dueVocabularyCount: 5, dueExpressionCount: 3 }));
    const vocabulary = plan.activities.find((a) => a.kind === 'vocabulary');
    const expressions = plan.activities.find((a) => a.kind === 'expressions');
    expect(vocabulary!.target).toEqual({ reviewKind: 'vocabulary', reviewLimit: 5 });
    expect(expressions!.target).toEqual({ reviewKind: 'expression', reviewLimit: 3 });
    // The titles claim exactly the bounded subset the child will run.
    expect(vocabulary!.title).toBe('Review 5 due words');
    expect(expressions!.title).toBe('Review 3 due expressions');
  });

  it('generic review: due evidence only — never claims which categories the session trains', () => {
    const plan = planDailyTutorSession(emptyInput({ dueOtherReviewCount: 3 }));
    const review = plan.activities.find((a) => a.kind === 'review');
    expect(review).toBeDefined();
    // The bounded subset is requested WITHOUT a kind filter — the existing
    // Review flow chooses the due items itself.
    expect(review!.target).toEqual({ reviewLimit: 3 });
    expect(review!.reason).toContain('3 review items are due');
    expect(review!.reason).toContain(
      'the existing Review flow will choose the bounded due subset',
    );
    // No unclaimable category promises.
    expect(review!.reason).not.toContain('grammar');
    expect(review!.reason).not.toContain('pronunciation');
    expect(review!.reason).not.toContain('listening');
  });

  it('vocabulary/expression reviews keep their real kind-specific bounded path (accuracy preserved)', () => {
    const plan = planDailyTutorSession(
      emptyInput({ dueVocabularyCount: 4, dueExpressionCount: 2 }),
    );
    const vocabulary = plan.activities.find((a) => a.kind === 'vocabulary')!;
    const expressions = plan.activities.find((a) => a.kind === 'expressions')!;
    // These ARE conditioned on the kind (the Review flow filters by it), so
    // the specific claims stay.
    expect(vocabulary.target).toEqual({ reviewKind: 'vocabulary', reviewLimit: 4 });
    expect(expressions.target).toEqual({ reviewKind: 'expression', reviewLimit: 2 });
    expect(vocabulary.reason).toContain('4 saved words are due for review');
    expect(expressions.reason).toContain('2 saved expressions are due for review');
  });

  it('pronunciation: no specific target or curriculum skill is claimed (engine self-plans)', () => {
    const evidence = { unresolvedPronunciationCount: 3, pronunciationTargets: ['th sound', 'r/l'] };
    const plan = planDailyTutorSession(emptyInput(evidence));
    const pronunciation = plan.activities.find((a) => a.kind === 'pronunciation');
    expect(pronunciation).toBeDefined();
    expect(pronunciation!.target).toEqual({});
    expect(pronunciation!.title).not.toContain('th');
    expect(pronunciation!.title).not.toContain('Word stress');
    expect(pronunciation!.reason).toContain('3 pronunciation targets');
    expect(pronunciation!.reason).toContain('adaptive lesson builds its steps');

    // Curriculum pronunciation recommendation: same honesty.
    const withCurriculum = planDailyTutorSession(
      emptyInput({
        ...evidence,
        curriculum: [
          { skillId: 'word_stress', domain: 'pronunciation', title: 'Word stress', lifecycleState: 'observed' },
        ],
      }),
    );
    const curriculumPron = withCurriculum.activities.find(
      (a) => a.kind === 'pronunciation' && a.target.skillId === undefined,
    );
    const anyPron = withCurriculum.activities.find((a) => a.kind === 'pronunciation');
    expect(anyPron).toBeDefined();
    expect(anyPron!.target).toEqual({});
    expect(anyPron!.title).not.toContain('Word stress');
    expect(curriculumPron).toBeDefined();
  });

  it('weakness retraining: no specific weakness identity is claimed (the coach selects)', () => {
    const plan = planDailyTutorSession(
      emptyInput({
        activeWeaknesses: [weakness({ type: 'grammar', status: 'relapsed', label: 'past simple questions' })],
      }),
    );
    const retraining = plan.activities.find((a) => a.kind === 'weakness_retraining');
    expect(retraining).toBeDefined();
    expect(retraining!.target).toEqual({ practiceType: 'weakness_retraining' });
    expect(retraining!.title).toBe('Weakness retraining'); // no specific weakness label
    expect(retraining!.reason).toContain('relapsed');
    expect(retraining!.reason).toContain('speaking coach retrains your most urgent weaknesses');
  });

  it('curriculum listening: modality only — the engine picks the material', () => {
    const plan = planDailyTutorSession(
      emptyInput({
        curriculum: [
          { skillId: 'gist_listening', domain: 'listening', title: 'Listening for gist', lifecycleState: 'observed' },
        ],
      }),
    );
    const listening = plan.activities.find((a) => a.kind === 'listening');
    expect(listening).toBeDefined();
    expect(listening!.target).toEqual({});
    expect(listening!.title).toBe('Listening practice');
    expect(listening!.title).not.toContain('gist');
    expect(listening!.reason).toContain('listening engine picks the material');
  });

  it('curriculum lessons: modality only — the engine picks the steps', () => {
    const plan = planDailyTutorSession(
      emptyInput({
        curriculum: [
          { skillId: 'past_simple_questions', domain: 'grammar', title: 'Past simple questions', lifecycleState: 'repeated' },
          { skillId: 'word_formation', domain: 'vocabulary', title: 'Word formation', lifecycleState: null },
        ],
      }),
    );
    const lesson = plan.activities.find((a) => a.kind === 'adaptive_lesson');
    expect(lesson).toBeDefined();
    expect(lesson!.target).toEqual({});
    expect(lesson!.title).toBe('Adaptive lesson');
    expect(lesson!.title).not.toContain('Past simple');
  });

  it('professional english: the category IS the target and is planned from real goals', () => {
    const plan = planDailyTutorSession(
      emptyInput({ dateKey: '2026-09-16', learningGoals: ['job_interviews'] }),
    );
    const professional = plan.activities.find((a) => a.kind === 'professional_english');
    if (professional) {
      expect(professional.target.professionalCategory).toBeDefined();
      expect(professional.target.practiceType).toBeUndefined();
    }
  });

  it('the honest listening-weakness activity stays class-level (engine retrains first)', () => {
    const plan = planDailyTutorSession(
      emptyInput({ activeWeaknesses: [weakness({ type: 'listening', status: 'confirmed' })] }),
    );
    const listening = plan.activities.find((a) => a.kind === 'listening');
    expect(listening).toBeDefined();
    expect(listening!.target).toEqual({});
    expect(listening!.reason).toContain('listening weakness');
  });
});

function nextDay(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
