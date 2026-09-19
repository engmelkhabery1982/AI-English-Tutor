/**
 * src/daily-tutor/restart-consistency.test.ts
 *
 * DURABLE STATE IS AUTHORITATIVE ACROSS SERVICE RECREATION.
 *
 * Regression guard for the restart issue: a completed daily session must not
 * become unfinished merely because the in-memory service (or the in-memory
 * completion inbox) disappeared. Recreating the service over the SAME real
 * database must recover the persisted state, and neither a stale in-memory
 * completion nor a relaunch may reopen a completed day.
 *
 * Real SQLite: the repository is the REAL SQLiteDailyTutorRepository on a real
 * SqlJsAdapter with the real v6 schema; only the learner-model port and the
 * profile lookup are test doubles (they carry no durable state).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteDailyTutorRepository,
  SQLiteUserProfileRepository,
} from '../data/local/sqlite/repositories';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { CoachingContext } from '../learner-model';
import {
  applyDrainedDailyTutorCompletions,
  pendingDailyTutorCompletionCount,
  reportDailyTutorCompletion,
  resetDailyTutorCompletionInboxForTests,
} from './completion';
import { DailyTutorService, type DailyTutorModelPort } from './service';
import type { DailyTutorChildCompletion, DailyTutorSession } from './types';

const NOW = '2026-09-19T09:00:00.000Z';

/** In-memory learner-model port (carries NO durable state). */
function createModelPort(learnerId: string): DailyTutorModelPort {
  const coaching: CoachingContext = {
    profile: {
      learnerId,
      displayName: 'Restart Learner',
      currentLevel: 'A2',
      targetLevel: 'B1',
      learningGoals: [],
      preferredModes: ['natural'],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentConversations: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: NOW,
  };
  return {
    refresh: async () => undefined,
    weaknesses: [],
    pronunciationWeaknesses: [],
    vocabulary: [],
    expressions: [],
    getActiveWeaknesses: () => [],
    getDueReview: () => [],
    getCoachingContext: () => coaching,
  } as unknown as DailyTutorModelPort;
}

/**
 * A fresh DailyTutorService over the given database — exactly what a service
 * recreation (app relaunch / new screen composition) produces: no in-memory
 * session, no queue, no in-flight load.
 */
function createService(adapter: DatabaseAdapter, learnerId: string): DailyTutorService {
  return new DailyTutorService({
    repository: new SQLiteDailyTutorRepository(adapter),
    learnerModel: createModelPort(learnerId),
    profile: {
      get: async () => ({ id: learnerId, displayName: 'Restart Learner' }) as never,
    },
    now: () => NOW,
    timeZoneOffsetMinutes: () => 0,
  });
}

async function createDatabase(): Promise<{
  adapter: DatabaseAdapter;
  learnerId: string;
}> {
  const adapter = new SqlJsAdapter(':memory:');
  await adapter.init();
  const profile = await new SQLiteUserProfileRepository(adapter).update({
    displayName: 'Restart Learner',
    currentLevel: 'A2',
    targetLevel: 'B1',
    learningGoals: [],
    preferredModes: ['natural'],
  });
  return { adapter, learnerId: profile.id };
}

/** Complete EVERY activity through the real service transitions. */
async function completeTheDay(
  service: DailyTutorService,
  session: DailyTutorSession,
): Promise<DailyTutorSession> {
  let latest = session;
  for (const activity of session.activities) {
    latest = (await service.startActivity(activity.id)) ?? latest;
    latest = (await service.completeActivity(activity.id, { itemsPracticed: 3 })) ?? latest;
  }
  return latest;
}

beforeEach(() => {
  resetDailyTutorCompletionInboxForTests();
});

describe('Daily Tutor: durable completion survives service recreation', () => {
  it('a recreated service loads the COMPLETED day instead of replanning it', async () => {
    const { adapter, learnerId } = await createDatabase();
    const first = createService(adapter, learnerId);

    const today = await first.getToday();
    expect(today.status).toBe('ready');
    const sessionId = today.session!.id;

    const completed = await completeTheDay(first, today.session!);
    expect(completed.status).toBe('completed');
    expect(completed.activities.every((activity) => activity.status === 'completed')).toBe(true);
    const completedAt = completed.completedAt;

    // SERVICE RECREATION: brand-new instance, all in-memory state gone.
    const recreated = createService(adapter, learnerId);
    const resumed = await recreated.getToday();

    expect(resumed.status).toBe('ready');
    expect(resumed.session!.id).toBe(sessionId); // the SAME persisted day, not a new plan
    expect(resumed.session!.status).toBe('completed');
    expect(resumed.session!.completedAt).toBe(completedAt);
    expect(
      resumed.session!.activities.every((activity) => activity.status === 'completed'),
    ).toBe(true);

    // …and it really is the durable row that says so.
    const rows = await adapter.query(
      `SELECT status, completed_at FROM daily_tutor_sessions WHERE learner_id = ?`,
      [learnerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).toBe(completedAt);
  });

  it('a recreated service cannot reopen a completed day through any transition', async () => {
    const { adapter, learnerId } = await createDatabase();
    const first = createService(adapter, learnerId);
    const today = await first.getToday();
    const completed = await completeTheDay(first, today.session!);
    const completedActivityId = completed.activities[0].id;

    const recreated = createService(adapter, learnerId);

    // Start / complete / skip all settle on the persisted completed session.
    expect((await recreated.startActivity(completedActivityId))?.status).toBe('completed');
    expect(
      (await recreated.completeActivity(completedActivityId, { itemsPracticed: 5 }))?.status,
    ).toBe('completed');
    expect((await recreated.skipActivity(completedActivityId))?.status).toBe('completed');
    // …and a completed day is never relaunched into a child workflow.
    expect(await recreated.getChildRoute()).toBeNull();

    // The persisted day is untouched: no activity reopened, no count changed.
    const rows = await adapter.query(
      `SELECT status FROM daily_tutor_activities WHERE session_id = ?`,
      [completed.id],
    );
    expect(rows.every((row) => row.status === 'completed')).toBe(true);
  });

  it('the in-memory completion inbox cannot override durable completion', async () => {
    const { adapter, learnerId } = await createDatabase();
    const first = createService(adapter, learnerId);
    const today = await first.getToday();
    const completed = await completeTheDay(first, today.session!);
    const activityId = completed.activities[0].id;

    // A stale completion (reported before the restart, drained after it) for
    // an activity that is ALREADY completed durably.
    const stale: DailyTutorChildCompletion = {
      ref: {
        sessionId: completed.id,
        activityId,
        kind: completed.activities[0].kind,
      },
      completedAt: NOW,
      itemsPracticed: 4,
    };
    reportDailyTutorCompletion(stale);
    expect(pendingDailyTutorCompletionCount()).toBe(1);

    const recreated = createService(adapter, learnerId);
    // The real drain-and-apply cycle the Daily Tutor screen runs on focus.
    const result = await applyDrainedDailyTutorCompletions(recreated);
    expect(result).not.toBeNull();

    // A settled (completed) day has nothing left to apply: the stale report is
    // permanently rejected — never retried, never able to reopen the activity.
    expect(result?.session).toBeNull();
    expect(result?.appliedActivityIds).toEqual([]);
    expect(result?.rejectedActivityIds).toEqual([activityId]);
    expect(result?.retryable).toHaveLength(0);
    expect(pendingDailyTutorCompletionCount()).toBe(0);

    const stored = await recreated.getToday();
    expect(stored.status).toBe('ready');
    expect(stored.session!.status).toBe('completed');
    expect(
      stored.session!.activities.every((activity) => activity.status === 'completed'),
    ).toBe(true);
  });

  it('an EMPTY in-memory inbox (fresh process) still reports the completed day', async () => {
    const { adapter, learnerId } = await createDatabase();
    const first = createService(adapter, learnerId);
    const today = await first.getToday();
    await completeTheDay(first, today.session!);

    // Nothing is pending anywhere in memory: only the database knows.
    expect(pendingDailyTutorCompletionCount()).toBe(0);

    const recreated = createService(adapter, learnerId);
    const today2 = await recreated.getToday();
    expect(today2.status).toBe('ready');
    expect(today2.session!.status).toBe('completed');
    // A completed day exposes no current activity to continue.
    expect(await recreated.getChildRoute()).toBeNull();
  });

  it('an unfinished day still resumes as unfinished after recreation (no false completion)', async () => {
    const { adapter, learnerId } = await createDatabase();
    const first = createService(adapter, learnerId);
    const today = await first.getToday();
    const firstActivity = today.session!.activities[0];
    await first.startActivity(firstActivity.id);

    const recreated = createService(adapter, learnerId);
    const resumed = await recreated.getToday();
    expect(resumed.session!.status).toBe('in_progress');
    expect(
      resumed.session!.activities.find((activity) => activity.id === firstActivity.id)!.status,
    ).toBe('in_progress');
  });
});
