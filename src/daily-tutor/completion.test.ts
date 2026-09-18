/**
 * Completion inbox for the Daily Tutor handshake.
 *
 * The inbox is the ONLY channel a child activity uses to report a real
 * completion. The core RETRY-SAFETY invariant: a real child completion
 * stays retryable until the DailyTutorService successfully persists/applies
 * it (or permanently rejects it). Drain alone never discards a completion;
 * only an explicit acknowledgement does.
 *
 * These tests pin: duplicate reports before acknowledgement, failed
 * application then retry, successful acknowledgement, re-report after
 * acknowledgement, same-day recovery, and test isolation.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  acknowledgeDailyTutorCompletions,
  applyDrainedDailyTutorCompletions,
  drainDailyTutorCompletions,
  pendingDailyTutorCompletionCount,
  requeueDailyTutorCompletions,
  reportDailyTutorCompletion,
  resetDailyTutorCompletionInboxForTests,
} from './completion';
import type { DailyTutorChildCompletion, DailyTutorSession } from './types';

const REF_A = {
  sessionId: 'dt:l1:2026-09-18',
  activityId: 'dt:2026-09-18:review',
  kind: 'review',
} as const;
const REF_B = {
  sessionId: 'dt:l1:2026-09-18',
  activityId: 'dt:2026-09-18:listening',
  kind: 'listening',
} as const;

function completion(
  ref: { sessionId: string; activityId: string; kind: 'review' | 'listening' },
  items = 3,
): DailyTutorChildCompletion {
  return { ref, completedAt: '2026-09-18T10:00:00.000Z', itemsPracticed: items };
}

describe('daily tutor completion inbox (report/drain/acknowledge)', () => {
  beforeEach(() => {
    resetDailyTutorCompletionInboxForTests();
  });

  it('starts empty', () => {
    expect(pendingDailyTutorCompletionCount()).toBe(0);
    expect(drainDailyTutorCompletions()).toEqual([]);
  });

  it('a reported completion is pending exactly once', () => {
    reportDailyTutorCompletion(completion(REF_A, 5));
    expect(pendingDailyTutorCompletionCount()).toBe(1);

    const drained = drainDailyTutorCompletions();
    expect(drained).toHaveLength(1);
    expect(drained[0].ref.activityId).toBe(REF_A.activityId);
    expect(drained[0].itemsPracticed).toBe(5);
  });

  it('drain does NOT discard: the completion stays retryable until acknowledged', () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    expect(drainDailyTutorCompletions()).toHaveLength(1);
    // Still unacknowledged — NOT gone (the original defect lost it here).
    expect(pendingDailyTutorCompletionCount()).toBe(1);
  });

  it('duplicate reports BEFORE acknowledgement are ignored (one copy)', () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    reportDailyTutorCompletion(completion(REF_A, 4));
    expect(pendingDailyTutorCompletionCount()).toBe(1);

    const drained = drainDailyTutorCompletions();
    expect(drained).toHaveLength(1);
    // A duplicate arriving while the first is unacknowledged is still one.
    reportDailyTutorCompletion(completion(REF_A, 9));
    expect(pendingDailyTutorCompletionCount()).toBe(1); // unacked copy only
  });

  it('successful acknowledgement frees the activity for a genuinely new report', () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    const drained = drainDailyTutorCompletions();
    acknowledgeDailyTutorCompletions([REF_A.activityId]);
    expect(pendingDailyTutorCompletionCount()).toBe(0);

    // A NEW real completion (child re-run) can be reported again.
    reportDailyTutorCompletion(completion(REF_A, 7));
    expect(pendingDailyTutorCompletionCount()).toBe(1);
    expect(drainDailyTutorCompletions()[0].itemsPracticed).toBe(7);
    expect(drained).toHaveLength(1);
  });

  it('keeps separate activities separate and preserves arrival order', () => {
    reportDailyTutorCompletion(completion(REF_B, 1));
    reportDailyTutorCompletion(completion(REF_A, 2));
    expect(pendingDailyTutorCompletionCount()).toBe(2);

    const drained = drainDailyTutorCompletions();
    expect(drained.map((c) => c.ref.activityId)).toEqual([REF_B.activityId, REF_A.activityId]);
  });

  it('carries the real practiced count, including an honest 0', () => {
    reportDailyTutorCompletion(completion(REF_A, 0));
    const drained = drainDailyTutorCompletions();
    expect(drained).toHaveLength(1);
    expect(drained[0].itemsPracticed).toBe(0); // honest: nothing practiced
  });

  it('malformed refs are ignored safely', () => {
    reportDailyTutorCompletion({
      ref: { sessionId: '', activityId: '', kind: 'review' },
      completedAt: '2026-09-18T10:00:00.000Z',
      itemsPracticed: 1,
    });
    expect(pendingDailyTutorCompletionCount()).toBe(0);
  });
});

describe('daily tutor completion inbox (retry semantics)', () => {
  beforeEach(() => {
    resetDailyTutorCompletionInboxForTests();
  });

  it('failed application → requeue makes the completion drainable again', () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    const drained = drainDailyTutorCompletions(); // now unacknowledged
    expect(drained).toHaveLength(1);

    // Application failed: re-queue instead of losing the completion.
    requeueDailyTutorCompletions(drained);
    expect(pendingDailyTutorCompletionCount()).toBe(1); // pending again

    const retried = drainDailyTutorCompletions();
    expect(retried).toHaveLength(1);
    expect(retried[0].ref.activityId).toBe(REF_A.activityId);
    expect(retried[0].itemsPracticed).toBe(4); // first report preserved
  });

  it('requeue ignores completions that were never drained', () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    requeueDailyTutorCompletions([completion(REF_A, 4)]);
    expect(pendingDailyTutorCompletionCount()).toBe(1); // no duplicate
  });

  it('requeue ignores acknowledged completions', () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    const drained = drainDailyTutorCompletions();
    acknowledgeDailyTutorCompletions([REF_A.activityId]);
    requeueDailyTutorCompletions(drained);
    expect(pendingDailyTutorCompletionCount()).toBe(0); // final stays final
  });

  it('reset clears everything (test isolation)', () => {
    reportDailyTutorCompletion(completion(REF_A));
    drainDailyTutorCompletions();
    reportDailyTutorCompletion(completion(REF_B));
    resetDailyTutorCompletionInboxForTests();
    expect(pendingDailyTutorCompletionCount()).toBe(0);
    expect(drainDailyTutorCompletions()).toEqual([]);
  });
});

describe('applyDrainedDailyTutorCompletions (the focus-time cycle)', () => {
  beforeEach(() => {
    resetDailyTutorCompletionInboxForTests();
  });

  function fakeSession(): DailyTutorSession {
    return {
      id: 'dt:l1:2026-09-18',
      learnerId: 'l1',
      dateKey: '2026-09-18',
      headline: 'h',
      sourceMode: 'personalized',
      estimatedMinutes: 15,
      status: 'in_progress',
      createdAt: '2026-09-18T08:00:00.000Z',
      activities: [],
    };
  }

  it('is a no-op on an empty inbox', async () => {
    const applier = { applyChildCompletions: vi.fn() };
    const result = await applyDrainedDailyTutorCompletions(applier as never);
    expect(result).toBeNull();
    expect(applier.applyChildCompletions).not.toHaveBeenCalled();
  });

  it('acknowledges applied and permanently rejected completions', async () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    reportDailyTutorCompletion(completion(REF_B, 0));
    const applier = {
      applyChildCompletions: vi.fn().mockResolvedValue({
        session: fakeSession(),
        appliedActivityIds: [REF_A.activityId],
        rejectedActivityIds: [REF_B.activityId],
        retryable: [],
      }),
    };
    const result = await applyDrainedDailyTutorCompletions(applier as never);
    expect(result?.appliedActivityIds).toEqual([REF_A.activityId]);
    expect(pendingDailyTutorCompletionCount()).toBe(0); // both final
  });

  it('re-queues retryable completions (storage failure) for the next focus', async () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    const applier = {
      applyChildCompletions: vi.fn().mockResolvedValue({
        session: null,
        appliedActivityIds: [],
        rejectedActivityIds: [],
        retryable: [completion(REF_A, 4)],
      }),
    };
    await applyDrainedDailyTutorCompletions(applier as never);
    // NOT lost: back in the pending queue for the next drain.
    expect(pendingDailyTutorCompletionCount()).toBe(1);
    const retried = drainDailyTutorCompletions();
    expect(retried).toHaveLength(1);
    expect(retried[0].ref.activityId).toBe(REF_A.activityId);
  });

  it('a whole-call failure re-queues EVERY drained completion', async () => {
    reportDailyTutorCompletion(completion(REF_A, 4));
    reportDailyTutorCompletion(completion(REF_B, 6));
    const applier = {
      applyChildCompletions: vi.fn().mockRejectedValue(new Error('sqlite unavailable')),
    };
    const result = await applyDrainedDailyTutorCompletions(applier as never);
    expect(result).toBeNull();
    expect(pendingDailyTutorCompletionCount()).toBe(2); // both retryable

    // And the next cycle succeeds on retry (same-day recovery).
    const healing = {
      applyChildCompletions: vi.fn().mockResolvedValue({
        session: fakeSession(),
        appliedActivityIds: [REF_A.activityId, REF_B.activityId],
        rejectedActivityIds: [],
        retryable: [],
      }),
    };
    const retryResult = await applyDrainedDailyTutorCompletions(healing as never);
    expect(retryResult?.appliedActivityIds).toEqual([REF_A.activityId, REF_B.activityId]);
    expect(pendingDailyTutorCompletionCount()).toBe(0);
  });

  it('an app-kill between report and drain loses no child evidence (in-memory only)', () => {
    // The inbox is in-memory by design: a kill clears it, but the child's
    // own learning evidence was already persisted exactly once by the child
    // system — the daily activity simply remains open/resumable.
    reportDailyTutorCompletion(completion(REF_A, 4));
    resetDailyTutorCompletionInboxForTests(); // simulates the app kill
    expect(pendingDailyTutorCompletionCount()).toBe(0);
    // A later re-completion can still be reported (nothing is duplicated).
    reportDailyTutorCompletion(completion(REF_A, 5));
    expect(pendingDailyTutorCompletionCount()).toBe(1);
  });
});
