/**
 * src/daily-tutor/launch.ts
 *
 * ONE-SHOT launch context for tab-resident child screens (Review,
 * Listening) that the Daily Tutor opens through the nested
 * Root Stack → MainTabs → tab route.
 *
 * React Navigation keeps route params attached to a TAB route, so a
 * `dailyTutor` param that is merely READ would leak into later standalone
 * use of that tab. The contract here is stricter:
 *
 *   1. When the launch param arrives, the screen CAPTURES it into local
 *      state and immediately CONSUMES it — clears it from the route via
 *      `navigation.setParams({ dailyTutor: undefined })`.
 *   2. The captured context lives only for THAT child workflow: it drives
 *      the daily auto-start and the real completion report, and it is
 *      dropped as soon as the workflow really completes (reported), is
 *      superseded by a user-started session, or the visit ends.
 *   3. A later standalone open of the tab (no param — it was consumed)
 *      sees NO Daily Tutor context: no auto-start, no completion report,
 *      no "Back to today's practice" affordance.
 *
 * This module is the pure state machine (framework-free, unit-testable);
 * the screens only wire it to `useRoute`/`useNavigation` and call the
 * transitions below. It is deliberately NOT a navigation system — the
 * nested navigation itself is unchanged (see ../navigation/routes.ts).
 */

/**
 * The launch state held by ONE tab screen instance.
 * - `active`: the captured Daily Tutor launch of the CURRENT child
 *   workflow, or null. Non-null means: this workflow was launched by the
 *   Daily Tutor, may auto-start and may report its real completion.
 * - `showReturn`: whether the "Back to today's practice" affordance may be
 *   rendered (a Daily Tutor visit happened and has not visibly ended yet).
 */
export interface DailyTutorLaunchState<T> {
  readonly active: T | null;
  readonly showReturn: boolean;
}

/** No Daily Tutor context at all (initial state; also the standalone state). */
export const DAILY_TUTOR_LAUNCH_IDLE: DailyTutorLaunchState<never> = {
  active: null,
  showReturn: false,
};

/**
 * A Daily Tutor launch param arrived on the tab route. Returns the NEW
 * state (context captured, return affordance visible) and the captured
 * launch (null when there was nothing to capture).
 *
 * The caller MUST treat the param as consumed — clear it from the route —
 * so it can never be re-read by later standalone use.
 */
export function captureDailyTutorLaunch<T>(
  state: DailyTutorLaunchState<T>,
  params: { readonly dailyTutor?: T } | undefined,
): { readonly state: DailyTutorLaunchState<T>; readonly captured: T | null } {
  const launch = params?.dailyTutor;
  if (!launch) {
    return { state, captured: null };
  }
  return { state: { active: launch, showReturn: true }, captured: launch };
}

/**
 * The learner started their OWN session in the tab (not the Daily Tutor
 * auto-start): any lingering Daily Tutor context is superseded. From here
 * on this workflow is standalone — no auto-start, no completion report, no
 * return affordance.
 */
export function beginStandaloneSession<T>(
  _state: DailyTutorLaunchState<T>,
): DailyTutorLaunchState<T> {
  return { active: null, showReturn: false };
}

/**
 * The active Daily Tutor workflow really completed and its completion was
 * reported. The captured launch is one-shot: it is dropped so a later
 * session in this tab can never re-report it. The return affordance stays
 * available for the completed screen until the visit visibly ends.
 */
export function finishDailyTutorWorkflow<T>(
  state: DailyTutorLaunchState<T>,
): DailyTutorLaunchState<T> {
  return { active: null, showReturn: state.showReturn };
}

/**
 * The tab lost focus (learner switched away). The RETURN AFFORDANCE ends
 * with the visit — but an ACTIVE workflow deliberately KEEPS its captured
 * launch: the completion ref must survive until the workflow's real
 * completion, even if the learner tabs away mid-session and comes back.
 */
export function clearDailyTutorReturn<T>(
  state: DailyTutorLaunchState<T>,
): DailyTutorLaunchState<T> {
  return { active: state.active, showReturn: false };
}

/**
 * The Daily Tutor visit ended explicitly (exit to dashboard, or the
 * "Back to today's practice" action was used): everything clears. If a
 * workflow was still active it is abandoned (an unfinished activity never
 * reports completion), and the Daily Tutor keeps it open for a relaunch.
 */
export function endDailyTutorVisit<T>(
  _state: DailyTutorLaunchState<T>,
): DailyTutorLaunchState<T> {
  return { active: null, showReturn: false };
}
