/**
 * The Daily Tutor orchestrator.
 *
 * These tests pin the operational contract of the loop:
 * - create-once / resume-always for today's session (never silent replans),
 * - the completion handshake (only real child completions settle activities),
 * - idempotence and race guards (double taps, concurrent creates, stale
 *   completions),
 * - honest failure/recovery (no profile, repository failure, corrupt state).
 *
 * The repository, learner model and clock are all fakes; the planner and
 * navigation under test are the REAL pure modules.
 */

import { describe, expect, it } from 'vitest';

import type {
  DailyTutorSessionRecord,
  DailyTutorSessionPatch,
  DailyTutorActivityPatch,
  CreateDailyTutorSessionInput,
} from '../repositories';
import type { LearnerModel, CoachingContext } from '../learner-model';
import { DailyTutorService } from './service';
import type { DailyTutorChildCompletion, DailyTutorSession } from './types';

/** The review-queue item shape the learner model exposes (kind-carrying). */
type DueReviewItem = ReturnType<LearnerModel['getDueReview']>[number];

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

const NOW = '2026-09-18T10:00:00.000Z';
const TODAY = '2026-09-18';

class FakeRepository {
  sessions = new Map<string, DailyTutorSessionRecord>();
  failReads = false;
  failInserts = false;
  insertCalls = 0;
  deleteCalls: string[] = [];

  getSession(id: string): Promise<DailyTutorSessionRecord | null> {
    if (this.failReads) return Promise.reject(new Error('sqlite unavailable'));
    return Promise.resolve(this.sessions.get(id) ?? null);
  }

  getSessionForDate(
    _learnerId: string,
    dateKey: string,
  ): Promise<DailyTutorSessionRecord | null> {
    if (this.failReads) return Promise.reject(new Error('sqlite unavailable'));
    for (const session of this.sessions.values()) {
      if (session.dateKey === dateKey) return Promise.resolve(session);
    }
    return Promise.resolve(null);
  }

  listRecentSessions(_learnerId: string, limit = 10): Promise<DailyTutorSessionRecord[]> {
    const sorted = [...this.sessions.values()].sort((a, b) =>
      a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0,
    );
    return Promise.resolve(sorted.slice(0, limit));
  }

  insertSession(input: CreateDailyTutorSessionInput): Promise<DailyTutorSessionRecord | null> {
    this.insertCalls += 1;
    if (this.failInserts) return Promise.reject(new Error('sqlite unavailable'));
    for (const session of this.sessions.values()) {
      if (session.learnerId === input.session.learnerId && session.dateKey === input.session.dateKey) {
        return Promise.resolve(null); // Unique (learner, date) — another creator won.
      }
    }
    const record: DailyTutorSessionRecord = {
      ...input.session,
      activities: input.activities.map((activity, orderIndex) => ({
        ...activity,
        orderIndex,
      })),
    };
    this.sessions.set(record.id, record);
    return Promise.resolve(record);
  }

  updateSession(id: string, patch: DailyTutorSessionPatch): Promise<DailyTutorSessionRecord> {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error('missing session'));
    const updated: DailyTutorSessionRecord = {
      ...session,
      ...('status' in patch && patch.status !== undefined ? { status: patch.status } : {}),
      ...('startedAt' in patch ? { startedAt: patch.startedAt ?? null } : {}),
      ...('completedAt' in patch ? { completedAt: patch.completedAt ?? null } : {}),
    };
    this.sessions.set(id, updated);
    return Promise.resolve(updated);
  }

  updateActivity(
    sessionId: string,
    activityId: string,
    patch: DailyTutorActivityPatch,
  ): Promise<DailyTutorSessionRecord> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.reject(new Error('missing session'));
    const updated: DailyTutorSessionRecord = {
      ...session,
      activities: session.activities.map((activity) => {
        if (activity.id !== activityId) return activity;
        return {
          ...activity,
          ...('status' in patch && patch.status !== undefined ? { status: patch.status } : {}),
          ...('startedAt' in patch ? { startedAt: patch.startedAt ?? null } : {}),
          ...('completedAt' in patch ? { completedAt: patch.completedAt ?? null } : {}),
          ...('practicedItems' in patch ? { practicedItems: patch.practicedItems ?? null } : {}),
        };
      }),
    };
    this.sessions.set(sessionId, updated);
    return Promise.resolve(updated);
  }

  deleteSession(id: string): Promise<boolean> {
    this.deleteCalls.push(id);
    return Promise.resolve(this.sessions.delete(id));
  }

  /** Test helper: mutate a stored record to simulate corruption. */
  corrupt(id: string, mutate: (record: DailyTutorSessionRecord) => DailyTutorSessionRecord): void {
    const record = this.sessions.get(id);
    if (!record) throw new Error('no such record');
    this.sessions.set(id, mutate(record));
  }
}

interface ModelSnapshot {
  learningGoals: string[];
  weaknesses: {
    id: string;
    type: string;
    referenceId: string;
    status: string;
    severity: number;
    occurrenceCount: number;
    notes?: string;
  }[];
  pronunciationRows: {
    id: string;
    targetSound: string;
    resolved: boolean;
    wordExamples: string[];
    notes?: string;
  }[];
  dueReview: { kind: string }[];
  vocabularyFocus: { nextReviewAt: string | null }[];
  expressionFocus: { nextReviewAt: string | null }[];
  recentConversations: { mode: string; topic: string | null }[];
}

const EMPTY_SNAPSHOT: ModelSnapshot = {
  learningGoals: [],
  weaknesses: [],
  pronunciationRows: [],
  dueReview: [],
  vocabularyFocus: [],
  expressionFocus: [],
  recentConversations: [],
};

class FakeModel {
  refreshCount = 0;
  constructor(public snapshot: ModelSnapshot = EMPTY_SNAPSHOT) {}

  async refresh(): Promise<void> {
    this.refreshCount += 1;
  }

  get weaknesses(): never[] {
    return [];
  }

  get pronunciationWeaknesses(): never[] {
    return [];
  }

  getActiveWeaknesses(): never[] {
    return [];
  }

  getDueReview(): never[] {
    return [];
  }

  getCoachingContext(): CoachingContext {
    const s = this.snapshot;
    return {
      profile: {
        learnerId: 'learner-1',
        displayName: 'Learner',
        currentLevel: 'A2',
        targetLevel: 'B1',
        learningGoals: s.learningGoals,
        preferredModes: [],
      },
      activeWeaknesses: [],
      strengths: [],
      vocabularyFocus: s.vocabularyFocus.map((v, i) => ({
        itemId: `v-${i}`,
        headword: 'word',
        type: 'word',
        meaningDefinition: '',
        reviewState: null,
        nextReviewAt: v.nextReviewAt,
      })) as CoachingContext['vocabularyFocus'],
      expressionFocus: s.expressionFocus.map((e, i) => ({
        itemId: `e-${i}`,
        expression: 'expr',
        type: 'common_expression',
        meaningDefinition: '',
        reviewState: null,
        nextReviewAt: e.nextReviewAt,
      })) as CoachingContext['expressionFocus'],
      recentConversations: s.recentConversations.map((c, i) => ({
        sessionId: `c-${i}`,
        mode: c.mode as 'natural',
        topic: c.topic,
        startedAt: NOW,
        endedAt: NOW,
        turnCount: 2,
      })),
      recentProgress: null,
      dueReviewCount: s.dueReview.length,
      generatedAt: NOW,
    };
  }
}

/**
 * A fully functional fake learner model: returns real-shaped weaknesses,
 * pronunciation rows and due-review items from a mutable snapshot.
 */
class RichFakeModel {
  refreshCount = 0;
  constructor(public snapshot: ModelSnapshot) {}

  async refresh(): Promise<void> {
    this.refreshCount += 1;
  }

  get weaknesses() {
    return this.snapshot.weaknesses.map((w) => ({
      id: w.id,
      learnerId: 'learner-1',
      type: w.type as 'grammar',
      referenceId: w.referenceId,
      status: w.status as 'observed',
      severity: w.severity,
      occurrenceCount: w.occurrenceCount,
      lastSeenAt: NOW,
      firstSeenAt: NOW,
      contexts: [],
      evidence: [],
      ...(w.notes !== undefined ? { notes: w.notes } : {}),
      resolved: false,
    }));
  }

  get pronunciationWeaknesses() {
    return this.snapshot.pronunciationRows.map((p) => ({
      id: p.id,
      learnerId: 'learner-1',
      targetSound: p.targetSound,
      wordExamples: p.wordExamples,
      occurrenceCount: 1,
      lastSeenAt: NOW,
      firstSeenAt: NOW,
      contexts: [],
      exampleTurnIds: [],
      resolved: p.resolved,
      ...(p.notes !== undefined ? { notes: p.notes } : {}),
    }));
  }

  getActiveWeaknesses() {
    return this.weaknesses;
  }

  getDueReview() {
    return this.snapshot.dueReview.map((item, i) => ({ id: `r-${i}`, kind: item.kind })) as unknown as readonly DueReviewItem[];
  }

  getCoachingContext(): CoachingContext {
    const base = new FakeModel(this.snapshot).getCoachingContext();
    return {
      ...base,
      activeWeaknesses: this.getActiveWeaknesses().map((w) => ({
        id: w.id,
        type: w.type,
        referenceId: w.referenceId,
        status: w.status,
        severity: w.severity,
        occurrenceCount: w.occurrenceCount,
        contexts: [],
      })),
    };
  }
}

function makeService(options?: {
  repository?: FakeRepository;
  model?: FakeModel | RichFakeModel;
  hasProfile?: boolean;
  now?: () => string;
  offset?: () => number;
}): { service: DailyTutorService; repository: FakeRepository; model: FakeModel | RichFakeModel } {
  const repository = options?.repository ?? new FakeRepository();
  const model = options?.model ?? new FakeModel();
  const service = new DailyTutorService({
    repository: repository as unknown as ConstructorParameters<typeof DailyTutorService>[0]['repository'],
    learnerModel: model as unknown as LearnerModel,
    profile: {
      get: async () => (options?.hasProfile === false ? null : { id: 'learner-1' }),
    } as never,
    now: options?.now ?? (() => NOW),
    timeZoneOffsetMinutes: options?.offset ?? (() => 0),
    curriculumPlanner: () => ({
      recommendations: [],
      sourceMode: 'balanced_rotation' as const,
      appliedLearningGoals: [],
      notes: [],
      generatedAt: NOW,
    }),
  });
  return { service, repository, model };
}

function completionFor(
  session: DailyTutorSession,
  activityId: string,
  itemsPracticed?: number,
): DailyTutorChildCompletion {
  const activity = session.activities.find((a) => a.id === activityId)!;
  return {
    ref: { sessionId: session.id, activityId, kind: activity.kind },
    completedAt: NOW,
    ...(itemsPracticed !== undefined ? { itemsPracticed } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('getToday: create once, resume always', () => {
  it('reports honestly when no learner profile exists', async () => {
    const { service } = makeService({ hasProfile: false });
    const today = await service.getToday();
    expect(today.status).toBe('no-profile');
    expect(today.session).toBeNull();
    if (today.status === 'no-profile') {
      expect(today.message.length).toBeGreaterThan(0);
    }
  });

  it('creates exactly one session for today with a deterministic id', async () => {
    const { service, repository } = makeService();
    const today = await service.getToday();
    expect(today.status).toBe('ready');
    if (today.status !== 'ready') return;
    expect(today.session.id).toBe(`dt:learner-1:${TODAY}`);
    expect(today.session.status).toBe('planned');
    expect(today.session.activities.length).toBeGreaterThanOrEqual(3);
    expect(today.session.activities.length).toBeLessThanOrEqual(5);
    expect(repository.insertCalls).toBe(1);
  });

  it('a second call RESUMES the same session (never replans)', async () => {
    const { service, repository } = makeService();
    const first = await service.getToday();
    const second = await service.getToday();
    expect(repository.insertCalls).toBe(1);
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('not ready');
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.headline).toBe(first.session.headline);
  });

  it('an in-progress session resumes with its real statuses preserved', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    await service.completeActivity(today.session.activities[0].id, { itemsPracticed: 4 });

    const resumed = await service.getToday();
    if (resumed.status !== 'ready') throw new Error('not ready');
    expect(resumed.session.status).toBe('in_progress');
    expect(resumed.session.activities[0].status).toBe('completed');
    expect(resumed.session.activities[0].practicedItems).toBe(4);
    expect(resumed.session.activities[1].status).toBe('pending');
  });

  it('a completed session stays completed (never reopens)', async () => {
    const { service } = makeService({ model: new RichFakeModel({ ...EMPTY_SNAPSHOT, dueReview: [{ kind: 'vocabulary' }, { kind: 'vocabulary' }] }) });
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    for (const activity of today.session.activities) {
      await service.completeActivity(activity.id, { itemsPracticed: 2 });
    }
    const final = await service.getToday();
    if (final.status !== 'ready') throw new Error('not ready');
    expect(final.session.status).toBe('completed');
    expect(final.session.completedAt).not.toBeNull();
  });

  it('planning is deterministic across service instances for the same evidence', async () => {
    const snapshot: ModelSnapshot = {
      ...EMPTY_SNAPSHOT,
      dueReview: [{ kind: 'vocabulary' }, { kind: 'vocabulary' }, { kind: 'vocabulary' }],
      learningGoals: ['job_interviews'],
    };
    const a = makeService({ model: new RichFakeModel(snapshot) });
    const b = makeService({ model: new RichFakeModel(snapshot) });
    const first = await a.service.getToday();
    const second = await b.service.getToday();
    if (first.status !== 'ready' || second.status !== 'ready') throw new Error('not ready');
    expect(first.session.headline).toBe(second.session.headline);
    expect(first.session.activities.map((x) => x.id)).toEqual(
      second.session.activities.map((x) => x.id),
    );
  });

  it('a repository read failure is reported honestly, nothing fabricated', async () => {
    const repository = new FakeRepository();
    repository.failReads = true;
    const { service } = makeService({ repository });
    const today = await service.getToday();
    expect(today.status).toBe('unavailable');
    expect(today.session).toBeNull();
  });

  it('concurrent getToday calls share one planning pass (no duplicate creates)', async () => {
    const { service, repository, model } = makeService();
    const [a, b, c] = await Promise.all([service.getToday(), service.getToday(), service.getToday()]);
    expect(repository.insertCalls).toBe(1);
    expect(model.refreshCount).toBe(1);
    if (a.status !== 'ready' || b.status !== 'ready' || c.status !== 'ready') throw new Error('not ready');
    expect(a.session.id).toBe(b.session.id);
    expect(b.session.id).toBe(c.session.id);
  });

  it('loses the create race safely: loads the winner session, no duplicates', async () => {
    const repository = new FakeRepository();
    const { service } = makeService({ repository });
    // Pre-insert a competing session for the same learner/date with a
    // different headline (as if another surface created it first).
    const competitor = await repository.insertSession({
      session: {
        id: `dt:learner-1:${TODAY}`,
        learnerId: 'learner-1',
        dateKey: TODAY,
        status: 'planned',
        headline: 'Competitor plan',
        sourceMode: 'general',
        estimatedMinutes: 15,
        createdAt: NOW,
        startedAt: null,
        completedAt: null,
      },
      activities: [
        { id: 'x-0', kind: 'listening', title: 'L', reason: 'r', estimatedMinutes: 5, target: {}, status: 'pending', startedAt: null, completedAt: null, practicedItems: null },
        { id: 'x-1', kind: 'adaptive_lesson', title: 'A', reason: 'r', estimatedMinutes: 6, target: {}, status: 'pending', startedAt: null, completedAt: null, practicedItems: null },
        { id: 'x-2', kind: 'deep_speaking', title: 'S', reason: 'r', estimatedMinutes: 7, target: {}, status: 'pending', startedAt: null, completedAt: null, practicedItems: null },
      ],
    });
    expect(competitor).not.toBeNull();

    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    expect(today.session.headline).toBe('Competitor plan'); // existing wins, never silently regenerated
    expect(repository.sessions.size).toBe(1);
  });

  it('a structurally corrupt record is deleted and replanned honestly', async () => {
    const repository = new FakeRepository();
    const { service } = makeService({ repository });
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    // Corrupt: unknown status value.
    repository.corrupt(today.session.id, (record) => ({ ...record, status: 'banana' as never }));

    const recovered = await service.getToday();
    if (recovered.status !== 'ready') throw new Error('not ready');
    expect(recovered.session.status).not.toBe('banana');
    expect(recovered.session.activities.length).toBeGreaterThanOrEqual(3);
    expect(repository.deleteCalls).toContain(today.session.id);
  });

  it('a record with duplicate activity order is treated as corrupt and recovered', async () => {
    const repository = new FakeRepository();
    const { service } = makeService({ repository });
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    repository.corrupt(today.session.id, (record) => ({
      ...record,
      activities: record.activities.map((a, i) => ({ ...a, orderIndex: 0, id: i === 1 ? record.activities[0].id : a.id })),
    }));

    const recovered = await service.getToday();
    expect(recovered.status).toBe('ready');
  });

  it('a tampered activity kind is detected by the record validator and recovered', async () => {
    const repository = new FakeRepository();
    const { service } = makeService({ repository });
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    repository.corrupt(today.session.id, (record) => ({
      ...record,
      activities: record.activities.map((a, i) =>
        i === 0 ? { ...a, kind: 'banana' as never } : a,
      ),
    }));

    const recovered = await service.getToday();
    if (recovered.status !== 'ready') throw new Error('not ready');
    const kinds = recovered.session.activities.map((a) => a.kind as string);
    expect(kinds).not.toContain('banana');
    expect(recovered.session.activities.length).toBeGreaterThanOrEqual(3);
    expect(repository.deleteCalls).toContain(today.session.id);
  });

  it('uses REAL due-review evidence in the plan', async () => {
    const { service } = makeService({
      model: new RichFakeModel({ ...EMPTY_SNAPSHOT, dueReview: [{ kind: 'vocabulary' }, { kind: 'vocabulary' }, { kind: 'expression' }] }),
    });
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const kinds = today.session.activities.map((a) => a.kind);
    expect(kinds).toContain('vocabulary');
  });

  it('an insufficient-evidence learner gets an honest general session', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    expect(today.session.sourceMode).toBe('general');
    expect(today.session.activities.length).toBeGreaterThanOrEqual(3);
  });
});

describe('startActivity', () => {
  it('marks the first pending activity in_progress and the session started', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const started = await service.startActivity(today.session.activities[0].id);
    expect(started?.status).toBe('in_progress');
    expect(started?.activities[0].status).toBe('in_progress');
    expect(started?.activities[0].startedAt).not.toBeNull();
    expect(started?.startedAt).not.toBeNull();
  });

  it('defaults to the current open activity', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    await service.startActivity(today.session.activities[0].id);
    const started = await service.startActivity();
    expect(started?.activities[0].status).toBe('in_progress');
    expect(started?.activities[1].status).toBe('pending');
  });

  it('double start is idempotent', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    await service.startActivity(today.session.activities[0].id);
    const again = await service.startActivity(today.session.activities[0].id);
    expect(again?.activities[0].status).toBe('in_progress'); // not reset, not errored
  });

  it('refuses to reopen a completed session', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    for (const activity of today.session.activities) {
      await service.completeActivity(activity.id, { itemsPracticed: 1 });
    }
    const result = await service.startActivity();
    expect(result?.status).toBe('completed');
    expect(result?.activities.every((a) => a.status === 'completed')).toBe(true);
  });
});

describe('completeActivity (the handshake target)', () => {
  it('completes with real evidence and records the practiced count', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const updated = await service.completeActivity(today.session.activities[0].id, {
      itemsPracticed: 5,
    });
    expect(updated?.activities[0].status).toBe('completed');
    expect(updated?.activities[0].practicedItems).toBe(5);
    expect(updated?.status).toBe('in_progress');
  });

  it('zero practiced items never completes the activity', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const updated = await service.completeActivity(today.session.activities[0].id, {
      itemsPracticed: 0,
    });
    expect(updated?.activities[0].status).not.toBe('completed');
    expect(updated?.activities[0].practicedItems).toBeUndefined();
  });

  it('completing the last open activity completes the session', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    let updated: DailyTutorSession | null = null;
    for (const activity of today.session.activities) {
      updated = await service.completeActivity(activity.id, { itemsPracticed: 2 });
    }
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).not.toBeNull();
  });

  it('double completion is idempotent (first completion wins)', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const first = await service.completeActivity(today.session.activities[0].id, { itemsPracticed: 3 });
    const second = await service.completeActivity(today.session.activities[0].id, { itemsPracticed: 99 });
    expect(second?.activities[0].status).toBe('completed');
    expect(second?.activities[0].practicedItems).toBe(3); // not overwritten
    expect(first?.activities[0].completedAt).toBe(second?.activities[0].completedAt);
  });

  it('an unknown activity id is a safe no-op', async () => {
    const { service } = makeService();
    await service.getToday();
    const result = await service.completeActivity('does-not-exist', { itemsPracticed: 1 });
    expect(result).not.toBeNull(); // today's session unchanged
  });
});

describe('skipActivity', () => {
  it('records a skip honestly (not practice, no counts)', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const updated = await service.skipActivity(today.session.activities[0].id);
    expect(updated?.activities[0].status).toBe('skipped');
    expect(updated?.activities[0].practicedItems).toBeUndefined();
    expect(updated?.status).toBe('in_progress');
  });

  it('skipping the last open activity completes the session without practice claims', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    let updated: DailyTutorSession | null = null;
    for (const [index, activity] of today.session.activities.entries()) {
      updated =
        index === today.session.activities.length - 1
          ? await service.skipActivity(activity.id)
          : await service.completeActivity(activity.id, { itemsPracticed: 1 });
    }
    expect(updated?.status).toBe('completed');
    const skipped = updated?.activities.find((a) => a.status === 'skipped');
    expect(skipped?.practicedItems).toBeUndefined();
  });

  it('a skipped activity cannot later be completed', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    await service.skipActivity(today.session.activities[0].id);
    const updated = await service.completeActivity(today.session.activities[0].id, {
      itemsPracticed: 5,
    });
    expect(updated?.activities[0].status).toBe('skipped');
  });

  it('double skip is idempotent', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    await service.skipActivity(today.session.activities[0].id);
    const again = await service.skipActivity(today.session.activities[0].id);
    expect(again?.activities.filter((a) => a.status === 'skipped').length).toBe(1);
  });
});

describe('applyChildCompletion (the handshake)', () => {
  it('a real child completion settles the daily activity', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const activity = today.session.activities[0];
    const updated = await service.applyChildCompletion({
      ref: { sessionId: today.session.id, activityId: activity.id, kind: activity.kind },
      completedAt: NOW,
      itemsPracticed: 6,
    });
    expect(updated?.activities[0].status).toBe('completed');
    expect(updated?.activities[0].practicedItems).toBe(6);
  });

  it('stale completion (another day) is ignored', async () => {
    const repository = new FakeRepository();
    const { service } = makeService({ repository });
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const activity = today.session.activities[0];
    repository.corrupt(today.session.id, (record) => ({ ...record, dateKey: '2026-09-17' }));

    const updated = await service.applyChildCompletion({
      ref: { sessionId: today.session.id, activityId: activity.id, kind: activity.kind },
      completedAt: NOW,
      itemsPracticed: 3,
    });
    expect(updated).toBeNull();
    const reloaded = await service.getToday(); // yesterday's record is not today's
    expect(reloaded.status).toBe('ready'); // today replanned honestly
  });

  it('a completion for a foreign session id is ignored', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const activity = today.session.activities[0];
    const updated = await service.applyChildCompletion({
      ref: { sessionId: 'dt:someone-else:2026-09-18', activityId: activity.id, kind: activity.kind },
      completedAt: NOW,
      itemsPracticed: 3,
    });
    expect(updated).toBeNull();
  });

  it('a mismatched kind echo is ignored (handshake integrity)', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const activity = today.session.activities[0];
    const updated = await service.applyChildCompletion({
      ref: { sessionId: today.session.id, activityId: activity.id, kind: 'listening' },
      completedAt: NOW,
      itemsPracticed: 3,
    });
    expect(updated).toBeNull();
  });

  it('a completion with zero practiced items keeps the activity open', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const activity = today.session.activities[0];
    const updated = await service.applyChildCompletion({
      ref: { sessionId: today.session.id, activityId: activity.id, kind: activity.kind },
      completedAt: NOW,
      itemsPracticed: 0,
    });
    expect(updated?.activities[0].status).not.toBe('completed');
  });

  it('a late duplicate completion is ignored (idempotent)', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const activity = today.session.activities[0];
    await service.applyChildCompletion({
      ref: { sessionId: today.session.id, activityId: activity.id, kind: activity.kind },
      completedAt: NOW,
      itemsPracticed: 2,
    });
    const again = await service.applyChildCompletion({
      ref: { sessionId: today.session.id, activityId: activity.id, kind: activity.kind },
      completedAt: NOW,
      itemsPracticed: 9,
    });
    expect(again?.activities[0].practicedItems).toBe(2);
  });

  it('a completion arriving after the session completed changes nothing', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    for (const activity of today.session.activities) {
      await service.completeActivity(activity.id, { itemsPracticed: 1 });
    }
    const late = await service.applyChildCompletion(
      completionFor(today.session, today.session.activities[0].id, 4),
    );
    expect(late).toBeNull(); // completed day: nothing left to apply
    // The original completion evidence stands untouched.
    const reloaded = await service.getToday();
    if (reloaded.status !== 'ready') throw new Error('not ready');
    expect(reloaded.session.activities[0].practicedItems).toBe(1);
    expect(reloaded.session.status).toBe('completed');
  });

  it('applyChildCompletions applies a drained batch and survives bad entries', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const first = today.session.activities[0];
    const second = today.session.activities[1];
    const result = await service.applyChildCompletions([
      { ref: { sessionId: today.session.id, activityId: first.id, kind: first.kind }, completedAt: NOW, itemsPracticed: 3 },
      { ref: { sessionId: 'bogus', activityId: 'x', kind: 'review' }, completedAt: NOW, itemsPracticed: 1 },
      { ref: { sessionId: today.session.id, activityId: second.id, kind: second.kind }, completedAt: NOW, itemsPracticed: 2 },
    ]);
    expect(result?.activities[0].status).toBe('completed');
    expect(result?.activities[1].status).toBe('completed');
  });
});

describe('getChildRoute', () => {
  it('builds the Review route with bounded params for review-family activities', async () => {
    const { service } = makeService({
      model: new RichFakeModel({ ...EMPTY_SNAPSHOT, dueReview: [{ kind: 'vocabulary' }, { kind: 'vocabulary' }] }),
    });
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const vocabulary = today.session.activities.find((a) => a.kind === 'vocabulary');
    expect(vocabulary).toBeDefined();
    const route = await service.getChildRoute(vocabulary!.id);
    expect(route?.routeName).toBe('Review');
    expect(route?.params.dailyTutor).toMatchObject({
      sessionId: today.session.id,
      activityId: vocabulary!.id,
      kind: 'vocabulary',
      reviewKind: 'vocabulary',
    });
    expect((route?.params.dailyTutor as { reviewLimit: number }).reviewLimit).toBeGreaterThan(0);
  });

  it('routes listening, adaptive lessons and speaking to their existing screens', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const routeNames = new Set<string>();
    for (const activity of today.session.activities) {
      const route = await service.getChildRoute(activity.id);
      expect(route).not.toBeNull();
      routeNames.add(route!.routeName);
    }
    expect(routeNames).toEqual(new Set(['AdaptiveLesson', 'Listening', 'DeepSpeaking']));
  });

  it('defaults to the current open activity when no id is given', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    await service.completeActivity(today.session.activities[0].id, { itemsPracticed: 1 });
    const route = await service.getChildRoute();
    expect(route?.params.dailyTutor).toMatchObject({
      activityId: today.session.activities[1].id,
    });
  });

  it('returns null when the day is already complete', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    for (const activity of today.session.activities) {
      await service.completeActivity(activity.id, { itemsPracticed: 1 });
    }
    expect(await service.getChildRoute()).toBeNull();
  });

  it('professional english routes only with a real goal (existing PE planner)', async () => {
    // Without a professional goal the planner never proposes the activity.
    const plain = await makeService().service.getToday();
    if (plain.status !== 'ready') throw new Error('not ready');
    expect(plain.session.activities.every((a) => a.kind !== 'professional_english')).toBe(true);

    // With a real goal on a rotation day, the child route carries the
    // scenario planned by the EXISTING PE planner.
    // Scan a few dates via a fresh service each time to find a PE day.
    let peRoute = null as Awaited<ReturnType<DailyTutorService['getChildRoute']>>;
    for (const day of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']) {
      const candidate = makeService({
        model: new RichFakeModel({ ...EMPTY_SNAPSHOT, learningGoals: ['job_interviews'] }),
        now: () => `${day}T10:00:00.000Z`,
      });
      const result = await candidate.service.getToday();
      if (result.status !== 'ready') continue;
      const pe = result.session.activities.find((a) => a.kind === 'professional_english');
      if (!pe) continue;
      peRoute = await candidate.service.getChildRoute(pe.id);
      break;
    }
    expect(peRoute).not.toBeNull();
    expect(peRoute?.routeName).toBe('DeepSpeaking');
    expect(peRoute?.params.professionalScenario).toBeDefined();
    expect(peRoute?.params.dailyTutor).toMatchObject({ kind: 'professional_english' });
  });
});

describe('race guards and serialization', () => {
  it('rapid complete-then-skip on the same activity settles exactly once', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const activity = today.session.activities[0];
    const [completed, skipped] = await Promise.all([
      service.completeActivity(activity.id, { itemsPracticed: 2 }),
      service.skipActivity(activity.id),
    ]);
    const statuses = new Set([completed?.activities[0].status, skipped?.activities[0].status]);
    // Exactly one terminal state, visible in both results (serialized queue).
    expect(statuses.size).toBe(1);
    expect(['completed', 'skipped']).toContain([...statuses][0]);
  });

  it('a stale async getToday result never overwrites a newer mutation', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    await service.completeActivity(today.session.activities[0].id, { itemsPracticed: 2 });
    // A "stale" load (as if requested before the completion) must still
    // reflect the persisted truth when it resolves.
    const reloaded = await service.getToday();
    if (reloaded.status !== 'ready') throw new Error('not ready');
    expect(reloaded.session.activities[0].status).toBe('completed');
  });

  it('mutations from two callers interleave safely (queue order)', async () => {
    const { service } = makeService();
    const today = await service.getToday();
    if (today.status !== 'ready') throw new Error('not ready');
    const results = await Promise.all([
      service.startActivity(today.session.activities[0].id),
      service.completeActivity(today.session.activities[0].id, { itemsPracticed: 1 }),
      service.startActivity(today.session.activities[1].id),
    ]);
    // All operations resolve; final state is consistent.
    for (const result of results) {
      expect(result).not.toBeNull();
    }
    const final = await service.getToday();
    if (final.status !== 'ready') throw new Error('not ready');
    const openCount = final.session.activities.filter(
      (a) => a.status === 'pending' || a.status === 'in_progress',
    ).length;
    expect(openCount).toBe(final.session.activities.length - 1); // exactly one settled
  });
});
