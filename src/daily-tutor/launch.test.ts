/**
 * ONE-SHOT Daily Tutor launch context for tab-resident child screens.
 *
 * React Navigation keeps route params attached to a TAB route, so a
 * `dailyTutor` param that is merely READ would leak into later standalone
 * use of the Review/Listening tabs. These tests pin the one-shot contract:
 *
 *   1. a Daily Tutor nested launch arrives and is CAPTURED,
 *   2. the param is CONSUMED — cleared from the tab route — so it can never
 *      be re-read by later standalone use,
 *   3. the ACTIVE child workflow keeps its captured ref until its real
 *      completion and reports exactly once,
 *   4. a later standalone Review/Listening use has NO Daily Tutor context:
 *      no auto-start, no completion report, no return affordance.
 *
 * The state-machine semantics are tested purely; the screen wiring is
 * pinned structurally (the repository's established style for screens).
 */

import { describe, expect, it } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  DAILY_TUTOR_LAUNCH_IDLE,
  beginStandaloneSession,
  captureDailyTutorLaunch,
  clearDailyTutorReturn,
  endDailyTutorVisit,
  finishDailyTutorWorkflow,
} from './launch';
import type { DailyTutorLaunchState } from './launch';
import type { DailyTutorReviewLaunch } from './types';

const LAUNCH: DailyTutorReviewLaunch = {
  sessionId: 'dt:learner-1:2026-09-18',
  activityId: 'dt:2026-09-18:review',
  kind: 'review',
  reviewLimit: 4,
};

type State = DailyTutorLaunchState<DailyTutorReviewLaunch>;

function captured(): State {
  return captureDailyTutorLaunch(DAILY_TUTOR_LAUNCH_IDLE, { dailyTutor: LAUNCH }).state;
}

describe('one-shot launch state machine (capture)', () => {
  it('starts with no Daily Tutor context', () => {
    expect(DAILY_TUTOR_LAUNCH_IDLE).toEqual({ active: null, showReturn: false });
  });

  it('a Daily Tutor nested launch arrives and is captured with the return affordance', () => {
    const result = captureDailyTutorLaunch(DAILY_TUTOR_LAUNCH_IDLE, { dailyTutor: LAUNCH });
    expect(result.captured).toEqual(LAUNCH);
    expect(result.state.active).toEqual(LAUNCH); // the active workflow context
    expect(result.state.showReturn).toBe(true); // "Back to today's practice"
  });

  it('nothing to capture leaves the state untouched (standalone param shape)', () => {
    expect(captureDailyTutorLaunch(DAILY_TUTOR_LAUNCH_IDLE, undefined).captured).toBeNull();
    expect(captureDailyTutorLaunch(DAILY_TUTOR_LAUNCH_IDLE, {}).captured).toBeNull();
    expect(captureDailyTutorLaunch(DAILY_TUTOR_LAUNCH_IDLE, { dailyTutor: undefined }).state).toEqual(
      DAILY_TUTOR_LAUNCH_IDLE,
    );
  });

  it('after the param is consumed from the route, arriving with NO param changes nothing', () => {
    // The screen cleared the route param (one-shot). The next route state
    // has no dailyTutor — the captured context must neither duplicate nor
    // vanish, and nothing new may be captured.
    const afterCapture = captured();
    const reRead = captureDailyTutorLaunch(afterCapture, {});
    expect(reRead.captured).toBeNull();
    expect(reRead.state).toEqual(afterCapture); // still the active workflow
  });
});

describe('one-shot launch state machine (active workflow retains its ref)', () => {
  it('the active workflow KEEPS its captured ref when the tab loses focus mid-session', () => {
    const midWorkflow = clearDailyTutorReturn(captured()); // blur while running
    expect(midWorkflow.active).toEqual(LAUNCH); // completion ref survives
    expect(midWorkflow.showReturn).toBe(false); // the visit affordance ends
  });

  it('the active child can still report its real completion after a blur', () => {
    const afterBlur = clearDailyTutorReturn(captured());
    // The completion handler reports via `active` — still present — and then
    // consumes the one-shot launch:
    expect(afterBlur.active).not.toBeNull();
    const finished = finishDailyTutorWorkflow(afterBlur);
    expect(finished.active).toBeNull(); // reported → consumed, never re-reported
    expect(finished.showReturn).toBe(false); // affordance already ended by the blur
  });

  it('finishing the workflow drops the launch but keeps the return affordance for the completed screen', () => {
    const finished = finishDailyTutorWorkflow(captured());
    expect(finished.active).toBeNull();
    expect(finished.showReturn).toBe(true); // completed screen may offer the way back
  });
});

describe('one-shot launch state machine (later standalone use)', () => {
  it('a user-started session is standalone: NO auto-start, NO report, NO return affordance', () => {
    const standalone = beginStandaloneSession(captured());
    expect(standalone).toEqual({ active: null, showReturn: false });
  });

  it('ending the visit clears everything (unfinished activities never report)', () => {
    const ended = endDailyTutorVisit(captured());
    expect(ended).toEqual({ active: null, showReturn: false });
  });

  it('full lifecycle: launch → complete → report → next session is standalone', () => {
    const launched = captured(); // 1. launch arrives, param consumed
    const finished = finishDailyTutorWorkflow(launched); // 3. real completion reported
    const nextSession = beginStandaloneSession(finished); // 4. later standalone use
    expect(nextSession.active).toBeNull();
    expect(nextSession.showReturn).toBe(false);
  });

  it('full lifecycle: launch → user starts own session → no Daily Tutor behavior remains', () => {
    const superseded = beginStandaloneSession(captured());
    // Even finishing that session can never report the daily activity.
    const finished = finishDailyTutorWorkflow(superseded);
    expect(finished.active).toBeNull();
    expect(finished.showReturn).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Screen wiring: the one-shot contract is really installed
 * ------------------------------------------------------------------ */

const reviewSrc = readFileSync(join(__dirname, '../screens/ReviewScreen.tsx'), 'utf8');
const listeningSrc = readFileSync(join(__dirname, '../screens/ListeningScreen.tsx'), 'utf8');

describe('Review/Listening wiring: one-shot launch context', () => {
  it('both screens capture the launch param through the one-shot machine', () => {
    for (const src of [reviewSrc, listeningSrc]) {
      expect(src).toContain('captureDailyTutorLaunch');
      expect(src).toContain('DAILY_TUTOR_LAUNCH_IDLE');
      // The live param is read ONCE into a routeLaunch binding for capture…
      expect(src).toContain('const routeLaunch = route.params?.dailyTutor;');
      // …and the ACTIVE context comes from the captured state, never from
      // the route param directly (the original leak).
      expect(src).toContain('const dailyTutorRef = dailyLaunch.active;');
      expect(src).not.toContain('const dailyTutorRef = route.params?.dailyTutor;');
    }
  });

  it('both screens CONSUME the param: cleared from the tab route on capture', () => {
    for (const src of [reviewSrc, listeningSrc]) {
      expect(src).toContain('navigation.setParams({ dailyTutor: undefined })');
    }
  });

  it('both screens report through the captured context and consume it after the real completion', () => {
    for (const src of [reviewSrc, listeningSrc]) {
      expect(src).toContain('reportDailyTutorCompletion');
      expect(src).toContain('finishDailyTutorWorkflow');
    }
  });

  it('a user-started session clears the Daily Tutor context first (standalone)', () => {
    for (const src of [reviewSrc, listeningSrc]) {
      expect(src).toContain('beginStandaloneSession');
    }
  });

  it('the return affordance renders from the visit state and ends when used', () => {
    for (const src of [reviewSrc, listeningSrc]) {
      expect(src).toMatch(/dailyLaunch\.showReturn \?/);
      expect(src).toContain('endDailyTutorVisit');
    }
  });

  it('leaving the tab keeps an ACTIVE workflow ref but ends the visit affordance', () => {
    for (const src of [reviewSrc, listeningSrc]) {
      expect(src).toContain('useFocusEffect');
      expect(src).toContain('clearDailyTutorReturn');
    }
  });
});

/* ------------------------------------------------------------------ *
 * DailyTutorScreen wiring: unmount guard on every async path
 * ------------------------------------------------------------------ */

const dailyTutorScreenSrc = readFileSync(
  join(__dirname, '../screens/DailyTutorScreen.tsx'),
  'utf8',
);

describe('DailyTutorScreen unmount guard (no state write after real unmount)', () => {
  it('real unmount sets the guard', () => {
    expect(dailyTutorScreenSrc).toContain('unmountedRef.current = true');
  });

  it('start completion cannot write state after unmount', () => {
    // setSession after the startActivity await is guarded…
    expect(dailyTutorScreenSrc).toContain('if (started && !unmountedRef.current) {');
    // …and the busy reset in the finally block is guarded too.
    expect(dailyTutorScreenSrc).toMatch(
      /startingRef\.current = false;\s*\n\s*if \(!unmountedRef\.current\) \{\s*\n\s*setIsBusy\(false\);/,
    );
  });

  it('skip completion cannot write state after unmount', () => {
    expect(dailyTutorScreenSrc).toContain('if (updated && !unmountedRef.current) {');
    expect(dailyTutorScreenSrc).toMatch(
      /skippingRef\.current = false;\s*\n\s*if \(!unmountedRef\.current\) \{\s*\n\s*setIsBusy\(false\);/,
    );
  });

  it('load completion cannot write state after unmount (token + guard)', () => {
    expect(dailyTutorScreenSrc).toContain(
      'if (unmountedRef.current || loadTokenRef.current !== token) return;',
    );
  });

  it('no unguarded setState remains in the async handlers', () => {
    // Every busy-reset is inside a guarded block (the only setIsBusy(true)
    // calls happen synchronously before any await).
    const busyOff = dailyTutorScreenSrc.match(/setIsBusy\(false\);/g) ?? [];
    const guardedBusyOff =
      dailyTutorScreenSrc.match(/if \(!unmountedRef\.current\) \{\s*\n\s*setIsBusy\(false\);/g) ??
      [];
    expect(busyOff.length).toBe(2); // one per handler (start + skip)
    expect(guardedBusyOff.length).toBe(2); // …and both are unmount-guarded
    // No unguarded post-await session write remains.
    expect(dailyTutorScreenSrc).not.toContain('if (started) {');
    expect(dailyTutorScreenSrc).not.toContain('if (updated) {');
  });

  it('pushing a child route is NOT an unmount: navigation still proceeds', () => {
    // The navigate call happens after the guard, so a screen that is still
    // mounted (a child pushed on top) continues to work.
    expect(dailyTutorScreenSrc).toContain(
      'if (unmountedRef.current || !route) return;',
    );
    expect(dailyTutorScreenSrc).toContain('navigation.navigate(route.routeName, route.params)');
  });
});

/* ------------------------------------------------------------------ *
 * Generic review wording (target honesty)
 * ------------------------------------------------------------------ */

describe('generic review wording (no unclaimable category promise)', () => {
  it('the planner reason no longer claims exact categories for the generic review', () => {
    const plannerSrc = readFileSync(join(__dirname, './planner.ts'), 'utf8');
    expect(plannerSrc).not.toContain('(grammar, pronunciation, listening)');
    expect(plannerSrc).toContain(
      'the existing Review flow will choose the bounded due subset',
    );
  });
});
