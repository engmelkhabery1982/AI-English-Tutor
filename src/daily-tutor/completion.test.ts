/**
 * Completion inbox for the Daily Tutor handshake.
 *
 * The inbox is the ONLY channel a child activity uses to report a real
 * completion. These tests pin the invariants: idempotence per activity,
 * drain-once semantics, and test isolation.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  drainDailyTutorCompletions,
  pendingDailyTutorCompletionCount,
  reportDailyTutorCompletion,
  resetDailyTutorCompletionInboxForTests,
} from './completion';
import type { DailyTutorActivityRef, DailyTutorChildCompletion } from './types';

const REF_A: DailyTutorActivityRef = { sessionId: 'dt:l1:2026-09-18', activityId: 'dt:2026-09-18:review', kind: 'review' };
const REF_B: DailyTutorActivityRef = { sessionId: 'dt:l1:2026-09-18', activityId: 'dt:2026-09-18:listening', kind: 'listening' };

function completion(ref: DailyTutorActivityRef, items = 3): DailyTutorChildCompletion {
  return { ref, completedAt: '2026-09-18T10:00:00.000Z', itemsPracticed: items };
}

describe('daily tutor completion inbox', () => {
  beforeEach(() => {
    resetDailyTutorCompletionInboxForTests();
  });

  it('starts empty', () => {
    expect(pendingDailyTutorCompletionCount()).toBe(0);
    expect(drainDailyTutorCompletions()).toEqual([]);
  });

  it('a reported completion becomes pending exactly once', () => {
    reportDailyTutorCompletion(completion(REF_A, 5));
    expect(pendingDailyTutorCompletionCount()).toBe(1);

    const drained = drainDailyTutorCompletions();
    expect(drained).toHaveLength(1);
    expect(drained[0].ref.activityId).toBe(REF_A.activityId);
    expect(drained[0].itemsPracticed).toBe(5);
  });

  it('drain clears the inbox (drain-once semantics)', () => {
    reportDailyTutorCompletion(completion(REF_A));
    expect(drainDailyTutorCompletions()).toHaveLength(1);
    expect(drainDailyTutorCompletions()).toEqual([]);
    expect(pendingDailyTutorCompletionCount()).toBe(0);
  });

  it('is idempotent per activityId: a double report never duplicates', () => {
    // Double taps / re-entrant child completions must collapse to one.
    reportDailyTutorCompletion(completion(REF_A, 4));
    reportDailyTutorCompletion(completion(REF_A, 4));
    reportDailyTutorCompletion(completion(REF_A, 2));

    const drained = drainDailyTutorCompletions();
    expect(drained).toHaveLength(1);
    // The first report wins — later duplicates are ignored, not merged.
    expect(drained[0].itemsPracticed).toBe(4);
  });

  it('keeps separate activities separate', () => {
    reportDailyTutorCompletion(completion(REF_A, 3));
    reportDailyTutorCompletion(completion(REF_B, 6));
    expect(pendingDailyTutorCompletionCount()).toBe(2);

    const drained = drainDailyTutorCompletions();
    expect(drained.map((c) => c.ref.activityId).sort()).toEqual([
      REF_A.activityId,
      REF_B.activityId,
    ].sort());
  });

  it('preserves arrival order', () => {
    reportDailyTutorCompletion(completion(REF_B, 1));
    reportDailyTutorCompletion(completion(REF_A, 2));
    const drained = drainDailyTutorCompletions();
    expect(drained.map((c) => c.ref.activityId)).toEqual([REF_B.activityId, REF_A.activityId]);
  });

  it('carries the real practiced count, including an honest 0', () => {
    reportDailyTutorCompletion(completion(REF_A, 0));
    const drained = drainDailyTutorCompletions();
    expect(drained).toHaveLength(1);
    expect(drained[0].itemsPracticed).toBe(0); // honest: nothing practiced
  });

  it('reset clears everything (test isolation)', () => {
    reportDailyTutorCompletion(completion(REF_A));
    reportDailyTutorCompletion(completion(REF_B));
    resetDailyTutorCompletionInboxForTests();
    expect(pendingDailyTutorCompletionCount()).toBe(0);
    expect(drainDailyTutorCompletions()).toEqual([]);
  });
});
