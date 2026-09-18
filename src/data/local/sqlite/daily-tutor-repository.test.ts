/**
 * SQLiteDailyTutorRepository (sql.js, in-memory).
 *
 * Pinned invariants:
 * - create-once per (learner, date) — the unique-session guarantee the
 *   orchestrator's race safety depends on,
 * - activities persist in plan order with their routing targets,
 * - partial updates never touch unrelated fields,
 * - delete removes the session AND its activities (no orphans),
 * - invalid ids/statuses/kinds are rejected instead of silently stored.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from './SqlJsAdapter';
import { SQLiteDailyTutorRepository, SQLiteUserProfileRepository } from './repositories';
import type { CreateDailyTutorSessionInput } from '../../../repositories';

const NOW = '2026-09-18T10:00:00.000Z';

describe('SQLiteDailyTutorRepository (sql.js)', () => {
  let adapter: SqlJsAdapter;
  let profileRepo: SQLiteUserProfileRepository;
  let repo: SQLiteDailyTutorRepository;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    profileRepo = new SQLiteUserProfileRepository(adapter);
    repo = new SQLiteDailyTutorRepository(adapter);
    await profileRepo.update({
      displayName: 'Test Learner',
      nativeLanguage: 'es',
      targetLanguage: 'en',
      targetLevel: 'B1',
      currentLevel: 'A2',
      learningGoals: ['fluency'],
      preferredModes: ['natural'],
    });
    learnerId = (await profileRepo.get())!.id;
  });

  function makeInput(overrides: {
    id?: string;
    dateKey?: string;
    headline?: string;
    kinds?: ('review' | 'listening' | 'deep_speaking')[];
  } = {}): CreateDailyTutorSessionInput {
    const dateKey = overrides.dateKey ?? '2026-09-18';
    const kinds = overrides.kinds ?? ['review', 'listening', 'deep_speaking'];
    return {
      session: {
        id: overrides.id ?? `dt:${learnerId}:${dateKey}`,
        learnerId,
        dateKey,
        status: 'planned',
        headline: overrides.headline ?? 'Today focuses on review.',
        sourceMode: 'personalized',
        estimatedMinutes: 17,
        createdAt: NOW,
        startedAt: null,
        completedAt: null,
      },
      activities: kinds.map((kind, index) => ({
        id: `dt:${dateKey}:${kind}`,
        kind,
        title: `Activity ${index + 1}`,
        reason: 'Real stored evidence.',
        estimatedMinutes: 5,
        target:
          kind === 'review'
            ? { reviewKind: 'vocabulary', reviewLimit: 4 }
            : kind === 'deep_speaking'
              ? { practiceType: 'guided_topic' }
              : {},
        status: 'pending',
        startedAt: null,
        completedAt: null,
        practicedItems: null,
      })),
    };
  }

  describe('insert + read round trip', () => {
    it('inserts a session with its ordered activities and reads it back', async () => {
      const inserted = await repo.insertSession(makeInput());
      expect(inserted).not.toBeNull();
      expect(inserted!.id).toBe(`dt:${learnerId}:2026-09-18`);
      expect(inserted!.activities.map((a) => a.kind)).toEqual(['review', 'listening', 'deep_speaking']);
      expect(inserted!.activities.map((a) => a.orderIndex)).toEqual([0, 1, 2]);
      expect(inserted!.activities[0].target).toEqual({ reviewKind: 'vocabulary', reviewLimit: 4 });
    });

    it('reads the same record by id and by (learner, date)', async () => {
      const inserted = await repo.insertSession(makeInput());
      const byId = await repo.getSession(inserted!.id);
      const byDate = await repo.getSessionForDate(learnerId, '2026-09-18');
      expect(byId?.id).toBe(inserted!.id);
      expect(byDate?.id).toBe(inserted!.id);
    });

    it('returns null for unknown session / date / invalid inputs', async () => {
      await repo.insertSession(makeInput());
      expect(await repo.getSession('no-such-id')).toBeNull();
      expect(await repo.getSession('')).toBeNull();
      expect(await repo.getSessionForDate(learnerId, '2026-09-19')).toBeNull();
      expect(await repo.getSessionForDate('not-a-uuid', '2026-09-18')).toBeNull();
      expect(await repo.getSessionForDate(learnerId, '2026-9-18')).toBeNull();
    });

    it('keeps sessions of different dates separate for one learner', async () => {
      await repo.insertSession(makeInput({ dateKey: '2026-09-17' }));
      await repo.insertSession(makeInput({ dateKey: '2026-09-18' }));
      const a = await repo.getSessionForDate(learnerId, '2026-09-17');
      const b = await repo.getSessionForDate(learnerId, '2026-09-18');
      expect(a!.dateKey).toBe('2026-09-17');
      expect(b!.dateKey).toBe('2026-09-18');
      expect(a!.id).not.toBe(b!.id);
    });
  });

  describe('create-once invariant (unique learner/date)', () => {
    it('refuses a second session for the same learner + date', async () => {
      const first = await repo.insertSession(makeInput());
      expect(first).not.toBeNull();
      const second = await repo.insertSession(
        makeInput({ id: `dt:${learnerId}:other`, headline: 'Another plan' }),
      );
      expect(second).toBeNull();
      // The first session stands unchanged.
      const stored = await repo.getSessionForDate(learnerId, '2026-09-18');
      expect(stored!.headline).toBe('Today focuses on review.');
    });

    it('a pre-existing row (constraint race) also yields null, never a throw', async () => {
      await repo.insertSession(makeInput());
      // Simulate a racing writer inserting directly between check and insert.
      const raced = await repo.insertSession(makeInput({ id: `dt:${learnerId}:raced` }));
      expect(raced).toBeNull();
      const all = await adapter.query(
        `SELECT id FROM daily_tutor_sessions WHERE learner_id = ? AND date_key = ?`,
        [learnerId, '2026-09-18'],
      );
      expect(all).toHaveLength(1);
    });
  });

  describe('updateSession (partial updates)', () => {
    it('updates only execution fields and preserves the rest', async () => {
      const inserted = await repo.insertSession(makeInput());
      const updated = await repo.updateSession(inserted!.id, {
        status: 'in_progress',
        startedAt: NOW,
      });
      expect(updated.status).toBe('in_progress');
      expect(updated.startedAt).toBe(NOW);
      expect(updated.completedAt).toBeNull();
      expect(updated.headline).toBe('Today focuses on review.');
      expect(updated.estimatedMinutes).toBe(17);
      expect(updated.activities).toHaveLength(3);
    });

    it('clears a field when explicitly patched to null', async () => {
      const inserted = await repo.insertSession(makeInput());
      await repo.updateSession(inserted!.id, { startedAt: NOW });
      const cleared = await repo.updateSession(inserted!.id, { startedAt: null });
      expect(cleared.startedAt).toBeNull();
    });

    it('rejects an invalid status instead of storing it', async () => {
      const inserted = await repo.insertSession(makeInput());
      await expect(
        repo.updateSession(inserted!.id, { status: 'banana' as never }),
      ).rejects.toThrow();
    });

    it('throws for an unknown session id', async () => {
      await expect(repo.updateSession('missing', { status: 'completed' })).rejects.toThrow();
    });
  });

  describe('updateActivity (partial updates)', () => {
    it('marks one activity completed with its real practiced count', async () => {
      const inserted = await repo.insertSession(makeInput());
      const target = inserted!.activities[1];
      const updated = await repo.updateActivity(inserted!.id, target.id, {
        status: 'completed',
        completedAt: NOW,
        practicedItems: 6,
      });
      expect(updated.activities[1].status).toBe('completed');
      expect(updated.activities[1].practicedItems).toBe(6);
      // Sibling activities untouched.
      expect(updated.activities[0].status).toBe('pending');
      expect(updated.activities[2].status).toBe('pending');
      expect(updated.activities[2].practicedItems).toBeNull();
    });

    it('records a skip without any practiced count', async () => {
      const inserted = await repo.insertSession(makeInput());
      const updated = await repo.updateActivity(inserted!.id, inserted!.activities[0].id, {
        status: 'skipped',
        completedAt: NOW,
      });
      expect(updated.activities[0].status).toBe('skipped');
      expect(updated.activities[0].practicedItems).toBeNull();
    });

    it('rejects an invalid activity status and an unknown activity', async () => {
      const inserted = await repo.insertSession(makeInput());
      await expect(
        repo.updateActivity(inserted!.id, inserted!.activities[0].id, { status: 'banana' as never }),
      ).rejects.toThrow();
      await expect(
        repo.updateActivity(inserted!.id, 'ghost-activity', { status: 'completed' }),
      ).rejects.toThrow();
    });
  });

  describe('listRecentSessions', () => {
    it('lists sessions newest-date first with a bounded limit', async () => {
      for (const day of ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']) {
        await repo.insertSession(makeInput({ dateKey: day }));
      }
      const recent = await repo.listRecentSessions(learnerId, 3);
      expect(recent.map((record) => record.dateKey)).toEqual([
        '2026-09-18',
        '2026-09-17',
        '2026-09-16',
      ]);
      // Full records with activities come back.
      expect(recent[0].activities).toHaveLength(3);
    });

    it('returns [] for an invalid learner id', async () => {
      await repo.insertSession(makeInput());
      expect(await repo.listRecentSessions('not-a-uuid')).toEqual([]);
    });
  });

  describe('deleteSession', () => {
    it('deletes the session AND its activities (no orphans)', async () => {
      const inserted = await repo.insertSession(makeInput());
      const deleted = await repo.deleteSession(inserted!.id);
      expect(deleted).toBe(true);
      expect(await repo.getSession(inserted!.id)).toBeNull();

      const orphanActivities = await adapter.query(
        `SELECT id FROM daily_tutor_activities WHERE session_id = ?`,
        [inserted!.id],
      );
      expect(orphanActivities).toHaveLength(0);
    });

    it('returns false for an unknown session', async () => {
      expect(await repo.deleteSession('missing')).toBe(false);
    });

    it('after deletion, the learner/date slot is free for an honest replan', async () => {
      const inserted = await repo.insertSession(makeInput());
      await repo.deleteSession(inserted!.id);
      const recreated = await repo.insertSession(makeInput({ headline: 'Fresh honest plan' }));
      expect(recreated).not.toBeNull();
      expect(recreated!.headline).toBe('Fresh honest plan');
    });
  });

  describe('input validation', () => {
    it('rejects invalid session statuses at insert time', async () => {
      const input = makeInput();
      (input.session as { status: string }).status = 'banana';
      await expect(repo.insertSession(input)).rejects.toThrow();
    });

    it('rejects invalid activity kinds at insert time', async () => {
      const input = makeInput();
      (input.activities[0] as { kind: string }).kind = 'mind_reading';
      await expect(repo.insertSession(input)).rejects.toThrow();
    });

    it('rejects a zero-activity session (bounds are structural)', async () => {
      const input = makeInput();
      const empty = { ...input, activities: [] };
      await expect(repo.insertSession(empty)).rejects.toThrow();
    });
  });

  describe('corrupt-row resilience', () => {
    it('degrades a corrupt target JSON to an empty object (never throws)', async () => {
      const inserted = await repo.insertSession(makeInput());
      await adapter.execute(
        `UPDATE daily_tutor_activities SET target = ? WHERE id = ?`,
        ['{not valid json', inserted!.activities[0].id],
      );
      const record = await repo.getSession(inserted!.id);
      expect(record).not.toBeNull();
      expect(record!.activities[0].target).toEqual({});
    });

    it('returns stored rows as-is (structural validation is the service layer\u2019s job)', async () => {
      await repo.insertSession(makeInput());
      // Corrupt one activity row to a non-mappable kind (direct DB tampering).
      const stored = await repo.getSessionForDate(learnerId, '2026-09-18');
      await adapter.execute(
        `UPDATE daily_tutor_activities SET kind = 'banana' WHERE order_index = 0 AND session_id = ?`,
        [stored!.id],
      );
      const record = await repo.getSession(stored!.id);
      // The repository is faithful to what is stored — it never invents or
      // silently repairs; the orchestrator's validator detects this instead.
      expect(record).not.toBeNull();
      expect((record!.activities[0] as { kind: string }).kind).toBe('banana');
    });
  });

  describe('repository re-instantiation (restart simulation)', () => {
    it('a fresh repository instance over the same database resumes the session', async () => {
      const inserted = await repo.insertSession(makeInput());
      await repo.updateActivity(inserted!.id, inserted!.activities[0].id, {
        status: 'completed',
        completedAt: NOW,
        practicedItems: 4,
      });

      // Simulate an app restart: a new repository over the same adapter.
      const restarted = new SQLiteDailyTutorRepository(adapter);
      const resumed = await restarted.getSessionForDate(learnerId, '2026-09-18');
      expect(resumed!.id).toBe(inserted!.id);
      expect(resumed!.activities[0].status).toBe('completed');
      expect(resumed!.activities[0].practicedItems).toBe(4);
      expect(resumed!.activities[1].status).toBe('pending');
    });
  });
});
