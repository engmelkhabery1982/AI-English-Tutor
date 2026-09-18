/**
 * Pure child-activity routing for the Daily Tutor.
 *
 * The Daily Tutor never renders learning content itself: it routes to the
 * EXISTING screens. These tests pin the kind → route contract and the
 * backward-compatible handshake params (present ONLY for daily launches).
 */

import { describe, expect, it } from 'vitest';

import {
  buildActivityRef,
  buildChildRoute,
  isDeepSpeakingFamilyKind,
  isReviewFamilyKind,
} from './navigation';
import type { DailyTutorSession } from './types';

function sessionWith(
  activities: Partial<DailyTutorSession['activities'][number]>[],
): DailyTutorSession {
  return {
    id: 'dt:learner-1:2026-09-18',
    learnerId: 'learner-1',
    dateKey: '2026-09-18',
    headline: 'Today focuses on review.',
    sourceMode: 'personalized',
    estimatedMinutes: 18,
    status: 'in_progress',
    createdAt: '2026-09-18T08:00:00.000Z',
    activities: activities.map((activity, index) => ({
      id: activity.id ?? `dt:2026-09-18:kind-${index}`,
      kind: activity.kind ?? 'review',
      title: activity.title ?? 'Activity',
      reason: activity.reason ?? 'Reason',
      estimatedMinutes: activity.estimatedMinutes ?? 5,
      target: activity.target ?? {},
      status: activity.status ?? 'pending',
    })) as DailyTutorSession['activities'],
  };
}

describe('kind family classification', () => {
  it('review family: review, vocabulary, expressions', () => {
    expect(isReviewFamilyKind('review')).toBe(true);
    expect(isReviewFamilyKind('vocabulary')).toBe(true);
    expect(isReviewFamilyKind('expressions')).toBe(true);
    expect(isReviewFamilyKind('listening')).toBe(false);
    expect(isReviewFamilyKind('deep_speaking')).toBe(false);
  });

  it('deep speaking family: deep_speaking, professional_english, weakness_retraining', () => {
    expect(isDeepSpeakingFamilyKind('deep_speaking')).toBe(true);
    expect(isDeepSpeakingFamilyKind('professional_english')).toBe(true);
    expect(isDeepSpeakingFamilyKind('weakness_retraining')).toBe(true);
    expect(isDeepSpeakingFamilyKind('review')).toBe(false);
    expect(isDeepSpeakingFamilyKind('adaptive_lesson')).toBe(false);
  });
});

describe('buildActivityRef', () => {
  it('carries exactly the handshake identity', () => {
    const session = sessionWith([{ id: 'a-1', kind: 'listening' }]);
    const activity = session.activities[0];
    expect(buildActivityRef(session, activity)).toEqual({
      sessionId: 'dt:learner-1:2026-09-18',
      activityId: 'a-1',
      kind: 'listening',
    });
  });
});

describe('buildChildRoute', () => {
  const session = sessionWith([
    { id: 'a-review', kind: 'review', target: { reviewLimit: 4 } },
    { id: 'a-vocab', kind: 'vocabulary', target: { reviewKind: 'vocabulary', reviewLimit: 3 } },
    { id: 'a-expr', kind: 'expressions', target: { reviewKind: 'expression', reviewLimit: 2 } },
    { id: 'a-listen', kind: 'listening', target: {} },
    { id: 'a-lesson', kind: 'adaptive_lesson', target: { skillId: 'past_simple_questions' } },
    { id: 'a-pron', kind: 'pronunciation', target: { pronunciationTarget: 'th' } },
    { id: 'a-speak', kind: 'deep_speaking', target: { practiceType: 'explain_and_expand' } },
    { id: 'a-retrain', kind: 'weakness_retraining', target: { practiceType: 'weakness_retraining' } },
    { id: 'a-prof', kind: 'professional_english', target: { professionalCategory: 'meeting' } },
  ]);

  it('routes generic review to the Review screen with the bounded limit', () => {
    const route = buildChildRoute(session, 'a-review');
    expect(route?.routeName).toBe('Review');
    expect(route?.params.dailyTutor).toMatchObject({
      sessionId: session.id,
      activityId: 'a-review',
      kind: 'review',
      reviewLimit: 4,
    });
    const dailyTutor = route?.params.dailyTutor as Record<string, unknown>;
    expect(dailyTutor.reviewKind).toBeUndefined();
  });

  it('routes vocabulary review with the vocabulary emphasis', () => {
    const route = buildChildRoute(session, 'a-vocab');
    expect(route?.routeName).toBe('Review');
    expect(route?.params.dailyTutor).toMatchObject({
      kind: 'vocabulary',
      reviewKind: 'vocabulary',
      reviewLimit: 3,
    });
  });

  it('routes expressions review with the expression emphasis', () => {
    const route = buildChildRoute(session, 'a-expr');
    expect(route?.routeName).toBe('Review');
    expect(route?.params.dailyTutor).toMatchObject({
      kind: 'expressions',
      reviewKind: 'expression',
      reviewLimit: 2,
    });
  });

  it('routes listening to the Listening screen', () => {
    const route = buildChildRoute(session, 'a-listen');
    expect(route?.routeName).toBe('Listening');
    expect(route?.params.dailyTutor).toMatchObject({
      sessionId: session.id,
      activityId: 'a-listen',
      kind: 'listening',
    });
  });

  it('routes adaptive_lesson to the AdaptiveLesson screen', () => {
    const route = buildChildRoute(session, 'a-lesson');
    expect(route?.routeName).toBe('AdaptiveLesson');
    expect(route?.params.dailyTutor).toMatchObject({
      activityId: 'a-lesson',
      kind: 'adaptive_lesson',
    });
  });

  it('routes pronunciation to the AdaptiveLesson screen (existing engine)', () => {
    const route = buildChildRoute(session, 'a-pron');
    expect(route?.routeName).toBe('AdaptiveLesson');
    expect(route?.params.dailyTutor).toMatchObject({ kind: 'pronunciation' });
  });

  it('routes deep_speaking with its practice type', () => {
    const route = buildChildRoute(session, 'a-speak');
    expect(route?.routeName).toBe('DeepSpeaking');
    expect(route?.params).toMatchObject({
      practiceType: 'explain_and_expand',
      dailyTutor: { activityId: 'a-speak', kind: 'deep_speaking' },
    });
  });

  it('routes weakness_retraining to DeepSpeaking with the retraining practice type', () => {
    const route = buildChildRoute(session, 'a-retrain');
    expect(route?.routeName).toBe('DeepSpeaking');
    expect(route?.params).toMatchObject({
      practiceType: 'weakness_retraining',
      dailyTutor: { kind: 'weakness_retraining' },
    });
  });

  it('refuses professional_english without launch-time scenario options', () => {
    // The PE scenario must come from the EXISTING PE planner at launch time —
    // never a fabricated default here.
    expect(buildChildRoute(session, 'a-prof')).toBeNull();
  });

  it('routes professional_english with planner-provided options', () => {
    const route = buildChildRoute(session, 'a-prof', {
      professional: {
        practiceType: 'role_play',
        professionalScenario: { title: 'Team meeting', category: 'meeting' },
      },
    });
    expect(route?.routeName).toBe('DeepSpeaking');
    expect(route?.params).toMatchObject({
      practiceType: 'role_play',
      professionalScenario: { title: 'Team meeting' },
      dailyTutor: { kind: 'professional_english' },
    });
  });

  it('returns null for an unknown activity', () => {
    expect(buildChildRoute(session, 'missing')).toBeNull();
  });

  it('never builds a route for a settled (completed or skipped) activity', () => {
    const settled = sessionWith([{ id: 'a-1', kind: 'review', status: 'completed' }]);
    expect(buildChildRoute(settled, 'a-1')).toBeNull();
  });

  it('routes the second activity by its id while the first is still open', () => {
    const withProgress = sessionWith([
      { id: 'a-1', kind: 'review', status: 'completed' },
      { id: 'a-2', kind: 'listening' },
    ]);
    const route = buildChildRoute(withProgress, 'a-2');
    expect(route?.routeName).toBe('Listening');
    expect(route?.params.dailyTutor).toMatchObject({ activityId: 'a-2', kind: 'listening' });
  });

  it('never builds a route for a session without an open activity', () => {
    const done = sessionWith([
      { id: 'a-1', kind: 'review', status: 'completed' },
      { id: 'a-2', kind: 'listening', status: 'skipped' },
    ]);
    // No activity can be routed: the completed and the skipped one both refuse.
    expect(buildChildRoute(done, 'a-1')).toBeNull();
    expect(buildChildRoute(done, 'a-2')).toBeNull();
  });

  it('child params never leak beyond the handshake contract', () => {
    const route = buildChildRoute(session, 'a-listen');
    const params = route?.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['dailyTutor']);
    const ref = params.dailyTutor as Record<string, unknown>;
    expect(Object.keys(ref).sort()).toEqual(['activityId', 'kind', 'sessionId']);
  });
});
