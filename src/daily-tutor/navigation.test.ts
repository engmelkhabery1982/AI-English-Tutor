/**
 * Pure child-activity routing for the Daily Tutor.
 *
 * The Daily Tutor never renders learning content itself: it routes to the
 * EXISTING screens. These tests pin the kind → route contract against the
 * REAL navigator hierarchy (src/navigation/routes.ts — the same tables
 * RootNavigator renders from):
 *
 *   review | vocabulary | expressions → Root Stack → MainTabs → Review
 *   listening                          → Root Stack → MainTabs → Listening
 *   adaptive_lesson | pronunciation    → AdaptiveLesson (root stack screen)
 *   deep_speaking | weakness_retraining| professional_english
 *                                      → DeepSpeaking (root stack screen)
 *
 * and the backward-compatible handshake params (present ONLY for daily
 * launches).
 */

import { describe, expect, it } from 'vitest';

import {
  MAIN_TAB_ROUTES,
  ROOT_STACK_ROUTES,
  isMainTabRoute,
  isRootStackRoute,
} from '../navigation/routes';
import {
  buildActivityRef,
  buildChildRoute,
  isDeepSpeakingFamilyKind,
  isReviewFamilyKind,
} from './navigation';
import type { DailyTutorSession } from './types';


/**
 * Typed view of the nested MainTabs envelope params returned by
 * buildChildRoute (its public type is a plain record by design).
 */
function nestedTabParams(
  route: { readonly params: Record<string, unknown> } | null | undefined,
): { readonly screen: unknown; readonly params?: { readonly dailyTutor?: unknown } } {
  return (route?.params ?? {}) as {
    screen: unknown;
    params?: { dailyTutor?: unknown };
  };
}

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
    { id: 'a-lesson', kind: 'adaptive_lesson', target: {} },
    { id: 'a-pron', kind: 'pronunciation', target: {} },
    { id: 'a-speak', kind: 'deep_speaking', target: { practiceType: 'explain_and_expand' } },
    { id: 'a-retrain', kind: 'weakness_retraining', target: { practiceType: 'weakness_retraining' } },
    { id: 'a-prof', kind: 'professional_english', target: { professionalCategory: 'meeting' } },
  ]);

  it('routes generic review through MainTabs to the Review tab with the bounded limit', () => {
    const route = buildChildRoute(session, 'a-review');
    expect(route?.routeName).toBe('MainTabs'); // Root Stack → MainTabs → Review
    const nested = nestedTabParams(route);
    expect(nested.screen).toBe('Review');
    const dailyTutor = nested.params?.dailyTutor as Record<string, unknown>;
    expect(dailyTutor).toMatchObject({
      sessionId: session.id,
      activityId: 'a-review',
      kind: 'review',
      reviewLimit: 4,
    });
    expect(dailyTutor.reviewKind).toBeUndefined();
  });

  it('routes vocabulary review through MainTabs with the vocabulary emphasis', () => {
    const route = buildChildRoute(session, 'a-vocab');
    expect(route?.routeName).toBe('MainTabs');
    const nested = nestedTabParams(route);
    expect(nested.screen).toBe('Review');
    expect(nested.params?.dailyTutor).toMatchObject({
      kind: 'vocabulary',
      reviewKind: 'vocabulary',
      reviewLimit: 3,
    });
  });

  it('routes expressions review through MainTabs with the expression emphasis', () => {
    const route = buildChildRoute(session, 'a-expr');
    expect(route?.routeName).toBe('MainTabs');
    const nested = nestedTabParams(route);
    expect(nested.screen).toBe('Review');
    expect(nested.params?.dailyTutor).toMatchObject({
      kind: 'expressions',
      reviewKind: 'expression',
      reviewLimit: 2,
    });
  });

  it('routes listening through MainTabs to the Listening tab', () => {
    const route = buildChildRoute(session, 'a-listen');
    expect(route?.routeName).toBe('MainTabs'); // Root Stack → MainTabs → Listening
    const nested = nestedTabParams(route);
    expect(nested.screen).toBe('Listening');
    expect(nested.params?.dailyTutor).toMatchObject({
      sessionId: session.id,
      activityId: 'a-listen',
      kind: 'listening',
    });
  });

  it('routes adaptive_lesson to the AdaptiveLesson root screen', () => {
    const route = buildChildRoute(session, 'a-lesson');
    expect(route?.routeName).toBe('AdaptiveLesson');
    expect(route?.params.dailyTutor).toMatchObject({
      activityId: 'a-lesson',
      kind: 'adaptive_lesson',
    });
  });

  it('routes pronunciation to the AdaptiveLesson root screen (existing engine)', () => {
    const route = buildChildRoute(session, 'a-pron');
    expect(route?.routeName).toBe('AdaptiveLesson');
    expect(route?.params.dailyTutor).toMatchObject({ kind: 'pronunciation' });
  });

  it('routes deep_speaking with its practice type (the conditioned focus)', () => {
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
    expect(route?.routeName).toBe('MainTabs');
    const nested = nestedTabParams(route);
    expect(nested.screen).toBe('Listening');
    expect(nested.params?.dailyTutor).toMatchObject({ activityId: 'a-2', kind: 'listening' });
  });

  it('child params never leak beyond the handshake contract', () => {
    const route = buildChildRoute(session, 'a-listen');
    const params = nestedTabParams(route).params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(['dailyTutor']);
    const ref = params.dailyTutor as Record<string, unknown>;
    expect(Object.keys(ref).sort()).toEqual(['activityId', 'kind', 'sessionId']);
  });
});

/**
 * REGRESSION: the Daily Tutor route targets must be compatible with the REAL
 * RootNavigator/MainTabs hierarchy (src/navigation/routes.ts — the exact
 * tables RootNavigator renders its navigators from). The original defect
 * navigated to 'Review'/'Listening' as if they were root-stack routes,
 * which cannot work: they are bottom tabs inside MainTabs.
 */
describe('child routes match the REAL navigator hierarchy', () => {
  const allKindsSession = sessionWith([
    { id: 'k-review', kind: 'review' },
    { id: 'k-vocabulary', kind: 'vocabulary' },
    { id: 'k-expressions', kind: 'expressions' },
    { id: 'k-listening', kind: 'listening' },
    { id: 'k-adaptive_lesson', kind: 'adaptive_lesson' },
    { id: 'k-pronunciation', kind: 'pronunciation' },
    { id: 'k-deep_speaking', kind: 'deep_speaking', target: { practiceType: 'guided_topic' } },
    { id: 'k-weakness_retraining', kind: 'weakness_retraining' },
    { id: 'k-professional_english', kind: 'professional_english' },
  ]);

  it('Review and Listening are MAIN TAB routes, not root-stack routes', () => {
    // The precondition of the original defect: these names live in MainTabs.
    expect(isMainTabRoute('Review')).toBe(true);
    expect(isMainTabRoute('Listening')).toBe(true);
    expect(isRootStackRoute('Review')).toBe(false);
    expect(isRootStackRoute('Listening')).toBe(false);
    expect(MAIN_TAB_ROUTES).toContain('Review');
    expect(MAIN_TAB_ROUTES).toContain('Listening');
  });

  it('every tab-resident child route uses the nested MainTabs envelope', () => {
    for (const activityId of ['k-review', 'k-vocabulary', 'k-expressions', 'k-listening']) {
      const route = buildChildRoute(allKindsSession, activityId);
      expect(route).not.toBeNull();
      expect(route!.routeName).toBe('MainTabs');
      expect(isRootStackRoute(route!.routeName)).toBe(true);
      const nested = nestedTabParams(route);
      const tab = nested.screen as string;
      expect(isMainTabRoute(tab)).toBe(true); // a REAL tab of MainTabs
      expect(nested.params?.dailyTutor).toBeDefined(); // handshake travels
    }
  });

  it('every root-resident child route targets a REAL root-stack route', () => {
    for (const activityId of [
      'k-adaptive_lesson',
      'k-pronunciation',
      'k-deep_speaking',
      'k-weakness_retraining',
      'k-professional_english',
    ]) {
      const route = buildChildRoute(
        allKindsSession,
        activityId,
        activityId === 'k-professional_english'
          ? {
              professional: {
                practiceType: 'role_play',
                professionalScenario: { title: 'Meeting' },
              },
            }
          : undefined,
      );
      expect(route).not.toBeNull();
      expect(isRootStackRoute(route!.routeName)).toBe(true);
      expect([...ROOT_STACK_ROUTES]).toContain(route!.routeName);
    }
  });

  it('no child route EVER navigates to a tab name directly from the root stack', () => {
    for (const activity of allKindsSession.activities) {
      const route = buildChildRoute(
        allKindsSession,
        activity.id,
        activity.kind === 'professional_english'
          ? { professional: { practiceType: 'role_play', professionalScenario: {} } }
          : undefined,
      );
      if (!route) continue;
      // Direct tab targets from a root-stack screen are invalid navigation —
      // the regression the nested envelope exists to prevent.
      expect(isMainTabRoute(route.routeName)).toBe(false);
      expect(isRootStackRoute(route.routeName)).toBe(true);
    }
  });

  it('the standalone tab layout is unchanged (same seven tabs, same order)', () => {
    expect([...MAIN_TAB_ROUTES]).toEqual([
      'Home',
      'Talk',
      'Listening',
      'Vocabulary',
      'Review',
      'Progress',
      'Settings',
    ]);
    expect([...ROOT_STACK_ROUTES]).toEqual([
      'MainTabs',
      'DailyTutor',
      'AdaptiveLesson',
      'DeepSpeaking',
      'FluencyPractice',
      'ProfessionalEnglish',
      'Onboarding',
    ]);
  });
});
