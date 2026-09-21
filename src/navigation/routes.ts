/**
 * src/navigation/routes.ts
 *
 * SINGLE SOURCE OF TRUTH for the app's navigator structure:
 *
 *   Root Stack
 *   ├── MainTabs          (bottom tabs: Home | Talk | Listening | Vocabulary
 *   │                      | Review | Progress | Settings)
 *   ├── DailyTutor
 *   ├── AdaptiveLesson
 *   ├── DeepSpeaking
 *   ├── ProfessionalEnglish
 *   └── Onboarding
 *
 * RootNavigator renders the REAL navigators from these tables, and the Daily
 * Tutor builds its child routes against them — so "which route lives where"
 * is decided exactly once, here, and every consumer (screens, planners,
 * tests) agrees. A route that is not a root-stack route can never be
 * navigated to directly from a root-stack screen: it must be reached through
 * the nested MainTabs envelope (see toMainTabRoute).
 *
 * This module is deliberately runtime-pure (type-only imports) so logic
 * tests can validate the REAL hierarchy without React Native.
 */

import type { NavigatorScreenParams } from '@react-navigation/native';

import type { SpeakingPracticeSeed, SpeakingPracticeType, SpeakingProfessionalScenario } from '../deep-speaking';
import type { DailyTutorActivityRef, DailyTutorReviewLaunch } from '../daily-tutor/types';
import type { InspectionPrefillParam } from '../screens/components/inspectable-text';

/** Root stack route names, in navigator order (RootNavigator renders these). */
export const ROOT_STACK_ROUTES = [
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
] as const;

export type RootStackRouteName = (typeof ROOT_STACK_ROUTES)[number];

/** Bottom-tab route names inside MainTabs, in tab-bar order. */
export const MAIN_TAB_ROUTES = [
  'Home',
  'Talk',
  'Listening',
  'Vocabulary',
  'Review',
  'Progress',
  'Settings',
] as const;

export type MainTabRouteName = (typeof MAIN_TAB_ROUTES)[number];

/** True when the name is a REAL root-stack route. */
export function isRootStackRoute(name: string): name is RootStackRouteName {
  return (ROOT_STACK_ROUTES as readonly string[]).includes(name);
}

/** True when the name is a REAL bottom-tab route inside MainTabs. */
export function isMainTabRoute(name: string): name is MainTabRouteName {
  return (MAIN_TAB_ROUTES as readonly string[]).includes(name);
}

/**
 * Typed params for the bottom tabs. The optional `dailyTutor` entries are
 * the Daily Tutor completion handshake: they are present ONLY when the Daily
 * Tutor launched that tab; normal standalone tab usage passes nothing.
 */
export type MainTabParamList = {
  Home: undefined;
  Talk: undefined;
  Listening: { readonly dailyTutor?: DailyTutorActivityRef } | undefined;
  Vocabulary: undefined;
  Review: { readonly dailyTutor?: DailyTutorReviewLaunch } | undefined;
  Progress: undefined;
  Settings: undefined;
};

/** Typed params for the root stack (nested MainTabs params included). */
export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList> | undefined;
  DailyTutor: undefined;
  AdaptiveLesson: { readonly dailyTutor?: DailyTutorActivityRef } | undefined;
  DeepSpeaking:
    | {
        readonly seed?: SpeakingPracticeSeed;
        readonly practiceType?: SpeakingPracticeType;
        readonly professionalScenario?: SpeakingProfessionalScenario;
        readonly dailyTutor?: DailyTutorActivityRef;
      }
    | undefined;
  FluencyPractice: { readonly taskId?: string } | undefined;
  ProfessionalEnglish: undefined;
  Onboarding: undefined;
  Reassessment: undefined;
  Pronunciation: undefined;
  Shadowing: undefined;
  /**
   * `inspect` carries a contextual Dictionary & Translate prefill when the
   * learner inspected language from another surface (story, listening
   * transcript, Talk message). Plain serializable data only.
   */
  LearningTools: { readonly inspect?: InspectionPrefillParam } | undefined;
};

/** The nested-navigation envelope returned by toMainTabRoute. */
export interface MainTabRouteEnvelope {
  readonly routeName: 'MainTabs';
  readonly params: {
    readonly screen: MainTabRouteName;
    readonly params?: Record<string, unknown>;
  };
}

/**
 * Build a Root Stack → MainTabs → <tab> navigation envelope.
 *
 * This is the ONLY correct way for a root-stack screen (like the Daily
 * Tutor hub) to launch a tab-resident screen (Review, Listening): the root
 * stack navigates to MainTabs, and the tab navigator switches to the target
 * tab carrying the child params — including the Daily Tutor completion
 * context for the real tab screen.
 */
export function toMainTabRoute(
  tab: MainTabRouteName,
  params?: Record<string, unknown>,
): MainTabRouteEnvelope {
  return {
    routeName: 'MainTabs',
    params: { screen: tab, ...(params ? { params } : {}) },
  };
}
