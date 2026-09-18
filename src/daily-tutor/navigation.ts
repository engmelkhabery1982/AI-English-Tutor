/**
 * src/daily-tutor/navigation.ts
 *
 * Pure, framework-free mapping from a daily activity to the child route
 * that executes it. Daily Tutor decides WHAT happens next; the existing
 * feature screens decide HOW the activity works.
 *
 * Mapping (every activity reuses an EXISTING screen/flow):
 *   review | vocabulary | expressions → Review tab (existing Review flow;
 *        the dailyTutor ref carries an optional bounded review subset hint)
 *   listening                → Listening tab (existing Listening Engine)
 *   adaptive_lesson           → AdaptiveLesson (existing Adaptive Lessons)
 *   pronunciation             → AdaptiveLesson (the existing evidence-based
 *                              pronunciation repeat steps live there)
 *   deep_speaking             → DeepSpeaking (existing speaking coach)
 *   weakness_retraining       → DeepSpeaking with practiceType
 *                              'weakness_retraining' (existing entry point)
 *   professional_english      → DeepSpeaking with the Professional English
 *                              scenario payload (existing PE → DS integration)
 *
 * The output is plain data ({ routeName, params }) so it is unit-testable
 * without React Native and so the screen layer stays thin. Params are all
 * serializable; standalone use of every child screen is unchanged because
 * nothing is passed unless the daily tutor is the launcher.
 */

import type {
  DailyActivityKind,
  DailyTutorActivity,
  DailyTutorActivityRef,
  DailyTutorSession,
} from './types';

/** A child route target as plain, serializable data. */
export interface DailyTutorChildRoute {
  readonly routeName: string;
  readonly params: Record<string, unknown>;
}

/** Review-family kinds (they all execute in the existing Review flow). */
export function isReviewFamilyKind(kind: DailyActivityKind): boolean {
  return kind === 'review' || kind === 'vocabulary' || kind === 'expressions';
}

/** Kinds that execute inside the existing Deep Speaking coach. */
export function isDeepSpeakingFamilyKind(kind: DailyActivityKind): boolean {
  return (
    kind === 'deep_speaking' || kind === 'professional_english' || kind === 'weakness_retraining'
  );
}

/** The serializable ref Daily Tutor hands to the child activity. */
export function buildActivityRef(
  session: DailyTutorSession,
  activity: DailyTutorActivity,
): DailyTutorActivityRef {
  return {
    sessionId: session.id,
    activityId: activity.id,
    kind: activity.kind,
  };
}

export interface BuildChildRouteExtras {
  /**
   * Professional English launch options computed through the EXISTING PE →
   * Deep Speaking adapter at launch time (deterministic scenario plan from
   * real learner context). Required for professional_english activities.
   */
  readonly professional?: {
    readonly practiceType?: string;
    readonly professionalScenario: Record<string, unknown>;
  };
}

/**
 * Build the child route for one activity of a session. Returns null when
 * the activity cannot be routed (unknown state) — the caller then shows an
 * honest message instead of navigating blindly.
 */
export function buildChildRoute(
  session: DailyTutorSession,
  activityId: string,
  extras?: BuildChildRouteExtras,
): DailyTutorChildRoute | null {
  const activity = session.activities.find((entry) => entry.id === activityId);
  if (!activity) return null;
  if (activity.status === 'completed' || activity.status === 'skipped') return null;

  const ref = buildActivityRef(session, activity);

  switch (activity.kind) {
    case 'review':
    case 'vocabulary':
    case 'expressions': {
      const dailyTutor: Record<string, unknown> = {
        sessionId: ref.sessionId,
        activityId: ref.activityId,
        kind: ref.kind,
      };
      if (activity.target.reviewKind) {
        dailyTutor.reviewKind = activity.target.reviewKind;
      }
      if (activity.target.reviewLimit !== undefined) {
        dailyTutor.reviewLimit = activity.target.reviewLimit;
      }
      return { routeName: 'Review', params: { dailyTutor } };
    }
    case 'listening':
      return {
        routeName: 'Listening',
        params: { dailyTutor: { ...ref } },
      };
    case 'adaptive_lesson':
    case 'pronunciation':
      return {
        routeName: 'AdaptiveLesson',
        params: { dailyTutor: { ...ref } },
      };
    case 'deep_speaking':
      return {
        routeName: 'DeepSpeaking',
        params: {
          ...(activity.target.practiceType
            ? { practiceType: activity.target.practiceType }
            : {}),
          dailyTutor: { ...ref },
        },
      };
    case 'weakness_retraining':
      return {
        routeName: 'DeepSpeaking',
        params: {
          practiceType: 'weakness_retraining',
          dailyTutor: { ...ref },
        },
      };
    case 'professional_english': {
      const options = extras?.professional;
      if (!options) return null; // Scenario must come from the existing PE planner.
      return {
        routeName: 'DeepSpeaking',
        params: {
          ...(options.practiceType ? { practiceType: options.practiceType } : {}),
          professionalScenario: options.professionalScenario,
          dailyTutor: { ...ref },
        },
      };
    }
    default:
      return null;
  }
}
