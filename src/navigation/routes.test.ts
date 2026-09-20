/**
 * The route-structure tables the REAL navigator renders from.
 *
 * RootNavigator composes its stack and tab navigators from these exact
 * tables (with a module-level sync check), so these invariants are the real
 * navigation hierarchy — not a copy of it.
 */

import { describe, expect, it } from 'vitest';

import {
  MAIN_TAB_ROUTES,
  ROOT_STACK_ROUTES,
  isMainTabRoute,
  isRootStackRoute,
  toMainTabRoute,
} from './routes';

describe('route tables (single source of truth)', () => {
  it('root stack routes are unique and complete', () => {
    expect(new Set(ROOT_STACK_ROUTES).size).toBe(ROOT_STACK_ROUTES.length);
    expect([...ROOT_STACK_ROUTES]).toEqual([
      'MainTabs',
      'DailyTutor',
      'AdaptiveLesson',
      'DeepSpeaking',
      'FluencyPractice',
      'ProfessionalEnglish',
      'Onboarding',
      'Reassessment',
      'Pronunciation',
      'Shadowing',
      'LearningTools',
    ]);
  });

  it('main tab routes are unique and complete (standalone tabs unchanged)', () => {
    expect(new Set(MAIN_TAB_ROUTES).size).toBe(MAIN_TAB_ROUTES.length);
    expect([...MAIN_TAB_ROUTES]).toEqual([
      'Home',
      'Talk',
      'Listening',
      'Vocabulary',
      'Review',
      'Progress',
      'Settings',
    ]);
  });

  it('MainTabs hosts the tab routes; tab names are never root-stack routes', () => {
    expect(isRootStackRoute('MainTabs')).toBe(true);
    for (const tab of MAIN_TAB_ROUTES) {
      expect(isRootStackRoute(tab)).toBe(false); // tabs are NOT root routes
      expect(isMainTabRoute(tab)).toBe(true);
    }
  });

  it('route guards reject unknown names', () => {
    expect(isRootStackRoute('Review')).toBe(false);
    expect(isRootStackRoute('nope')).toBe(false);
    expect(isMainTabRoute('DailyTutor')).toBe(false);
    expect(isMainTabRoute('nope')).toBe(false);
    expect(isRootStackRoute('')).toBe(false);
    expect(isMainTabRoute('')).toBe(false);
  });
});

describe('toMainTabRoute (nested navigation envelope)', () => {
  it('wraps a tab target with its params', () => {
    const envelope = toMainTabRoute('Review', { dailyTutor: { activityId: 'a-1' } });
    expect(envelope).toEqual({
      routeName: 'MainTabs',
      params: {
        screen: 'Review',
        params: { dailyTutor: { activityId: 'a-1' } },
      },
    });
  });

  it('omits params when none are given', () => {
    const envelope = toMainTabRoute('Listening');
    expect(envelope.params).toEqual({ screen: 'Listening' });
    expect(envelope.params.params).toBeUndefined();
  });

  it('always produces a REAL root-stack routeName and a REAL tab target', () => {
    for (const tab of MAIN_TAB_ROUTES) {
      const envelope = toMainTabRoute(tab);
      expect(isRootStackRoute(envelope.routeName)).toBe(true);
      expect(envelope.routeName).toBe('MainTabs');
      expect(isMainTabRoute(envelope.params.screen)).toBe(true);
    }
  });
});
