/**
 * src/daily-tutor/view.ts
 *
 * Pure, honest view-models for the Home card and the Daily Tutor session
 * hub. No scores, no percentages, no CEFR claims, no fake improvement —
 * progress is count-based and qualitative only ("2 of 4 activities").
 */

import type {
  DailyActivityKind,
  DailyTutorActivity,
  DailyTutorSession,
} from './types';

/** Home card state derived from a real persisted session. */
export type DailyTutorHomeCardState = 'new' | 'in_progress' | 'completed';

/** UI-ready Home card content. */
export interface DailyTutorHomeCard {
  readonly state: DailyTutorHomeCardState;
  readonly title: string;
  readonly headline: string;
  readonly progressLabel: string;
  readonly activityCount: number;
  readonly completedCount: number;
  readonly estimatedMinutes: number;
  readonly buttonLabel: string;
}

/** Count of activities in a terminal state (completed or skipped). */
function settledCount(session: DailyTutorSession): number {
  return session.activities.filter(
    (activity) => activity.status === 'completed' || activity.status === 'skipped',
  ).length;
}

/** Count of completed activities. */
export function completedActivityCount(session: DailyTutorSession): number {
  return session.activities.filter((activity) => activity.status === 'completed').length;
}

/** The current activity: the first pending/in_progress one, in order. */
export function currentActivityOf(session: DailyTutorSession): DailyTutorActivity | null {
  return (
    session.activities.find(
      (activity) => activity.status === 'pending' || activity.status === 'in_progress',
    ) ?? null
  );
}

/** Honest qualitative label for one activity kind. */
export function activityKindLabel(kind: DailyActivityKind): string {
  switch (kind) {
    case 'review':
      return 'Review';
    case 'vocabulary':
      return 'Vocabulary review';
    case 'expressions':
      return 'Expression review';
    case 'adaptive_lesson':
      return 'Adaptive lesson';
    case 'listening':
      return 'Listening';
    case 'pronunciation':
      return 'Pronunciation';
    case 'deep_speaking':
      return 'Speaking';
    case 'professional_english':
      return 'Professional English';
    case 'weakness_retraining':
      return 'Weakness retraining';
    default:
      return 'Practice';
  }
}

/**
 * Home card content for a real session. All states are derived from the
 * persisted session — nothing is invented.
 */
export function buildDailyTutorHomeCard(session: DailyTutorSession): DailyTutorHomeCard {
  const total = session.activities.length;
  const completed = completedActivityCount(session);
  const isComplete = session.status === 'completed';

  if (isComplete) {
    return {
      state: 'completed',
      title: 'Today\u2019s Practice',
      headline: 'Today\u2019s practice complete',
      progressLabel: `${completed} of ${total} activities complete`,
      activityCount: total,
      completedCount: completed,
      estimatedMinutes: session.estimatedMinutes,
      buttonLabel: 'View summary',
    };
  }

  const started = session.status === 'in_progress' || settledCount(session) > 0;
  if (started) {
    return {
      state: 'in_progress',
      title: 'Today\u2019s Practice',
      headline: `Continue today\u2019s practice — ${completed} of ${total} activities complete`,
      progressLabel: `${total - completed} remaining`,
      activityCount: total,
      completedCount: completed,
      estimatedMinutes: session.estimatedMinutes,
      buttonLabel: 'Continue',
    };
  }

  return {
    state: 'new',
    title: 'Today\u2019s Practice',
    headline: 'Your personalized practice is ready',
    progressLabel: `${total} activities · about ${session.estimatedMinutes} minutes (estimate)`,
    activityCount: total,
    completedCount: 0,
    estimatedMinutes: session.estimatedMinutes,
    buttonLabel: 'Start',
  };
}

/** UI-ready session hub content for the Daily Tutor screen. */
export interface DailyTutorSessionView {
  readonly title: string;
  readonly headline: string;
  readonly progressLabel: string;
  readonly activities: readonly DailyTutorActivity[];
  readonly current: DailyTutorActivity | null;
  readonly isComplete: boolean;
  readonly completedCount: number;
  readonly total: number;
  readonly skippedCount: number;
  /** Honest, count-based completion summary lines (complete sessions only). */
  readonly summaryLines: readonly string[];
  /** Skills practised labels from COMPLETED activities (real practice only). */
  readonly skillsPractised: readonly string[];
}

function summaryLineForActivity(activity: DailyTutorActivity): string {
  const label = activityKindLabel(activity.kind);
  if (activity.practicedItems !== undefined && activity.practicedItems > 0) {
    const items = activity.practicedItems === 1 ? 'item' : 'items';
    return `You practised ${label.toLowerCase()} — ${activity.practicedItems} ${items}.`;
  }
  return `You completed a ${label.toLowerCase()} activity.`;
}

/**
 * Session hub content. The completion summary reports only what really
 * happened: completed/skipped counts, the real skills practised, real item
 * counts when the child workflow reported them, and an honest note about
 * next time. Never improvement claims.
 */
export function buildDailyTutorSessionView(session: DailyTutorSession): DailyTutorSessionView {
  const total = session.activities.length;
  const completed = completedActivityCount(session);
  const skipped = session.activities.filter((activity) => activity.status === 'skipped').length;
  const isComplete = session.status === 'completed';
  const current = currentActivityOf(session);

  const summaryLines: string[] = [];
  if (isComplete) {
    summaryLines.push(`You completed ${completed} of ${total} activities.`);
    if (skipped > 0) {
      summaryLines.push(`${skipped} ${skipped === 1 ? 'activity was' : 'activities were'} skipped — skipped practice is not counted as done.`);
    }
    for (const activity of session.activities) {
      if (activity.status !== 'completed') continue;
      summaryLines.push(summaryLineForActivity(activity));
    }
    summaryLines.push('Your review schedule, weaknesses and saved words were updated only by the practice you actually did.');
    summaryLines.push('Tomorrow\u2019s plan will use what you practised today.');
  }

  return {
    title: 'Today\u2019s Practice',
    headline: session.headline,
    progressLabel: `${completed} of ${total} activities complete`,
    activities: session.activities,
    current,
    isComplete,
    completedCount: completed,
    total,
    skippedCount: skipped,
    summaryLines,
    skillsPractised: session.activities
      .filter((activity) => activity.status === 'completed')
      .map((activity) => activityKindLabel(activity.kind)),
  };
}
