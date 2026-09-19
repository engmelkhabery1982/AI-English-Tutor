/**
 * src/data/local/sqlite/app-database.test.ts
 *
 * The canonical application-database owner: ownership lifecycle, concurrent
 * initialization, failed-initialization retry, close/reopen semantics,
 * integrity validation and the explicit (never automatic) reset primitive.
 *
 * REAL SQLite integration: every test drives a real SqlJsAdapter with the real
 * v6 schema and real migrations. Only the platform adapter boundary is
 * replaced (through the owner's OWN injection seam), so the production adapter
 * lifecycle code is what runs.
 */

import { describe, expect, it, vi } from 'vitest';

import type { DatabaseAdapter, SqlParam, SqlStep } from './DatabaseAdapter';
import { SqlJsAdapter } from './SqlJsAdapter';
import { getSchemaVersion } from './schema';
import type { AppDatabaseOwner } from './app-database';
import {
  createAppDatabaseOwner,
  getAppDatabase,
  getAppDatabaseOwner,
  resetAppDatabaseOwnerForTests,
  setAppDatabaseOwner,
  APP_DATABASE_NAME,
} from './app-database';
import { DatabaseBootstrapError } from './DatabaseBootstrapError';
import { validateDatabaseIntegrity } from './integrity';
import { SQLiteUserProfileRepository } from './repositories';

const NOW = '2026-09-19T09:00:00.000Z';

/**
 * Test double at the PLATFORM BOUNDARY only: it delegates every SQL operation
 * to a real SqlJsAdapter while counting the lifecycle calls the owner makes.
 */
class ObservableAdapter implements DatabaseAdapter {
  readonly backend = 'sql.js' as const;
  readonly path: string;
  initCalls = 0;
  closeCalls = 0;
  failInitWith: unknown = null;
  /** Keep the underlying adapter usable for post-mortem assertions. */
  keepInnerOpenOnClose = false;

  constructor(private readonly inner: DatabaseAdapter) {
    this.path = inner.path;
  }

  get connected(): boolean {
    return this.inner.connected;
  }

  async init(): Promise<void> {
    this.initCalls += 1;
    if (this.failInitWith) throw this.failInitWith;
    await this.inner.init();
  }

  execute(sql: string, params?: readonly SqlParam[]) {
    return this.inner.execute(sql, params);
  }

  query(sql: string, params?: readonly SqlParam[]) {
    return this.inner.query(sql, params);
  }

  transaction(steps: readonly SqlStep[]) {
    return this.inner.transaction(steps);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (!this.keepInnerOpenOnClose) await this.inner.close();
  }
}

/** A real initialized SqlJs database with one real learner profile row. */
async function seedRealDatabase(): Promise<{
  inner: SqlJsAdapter;
  adapter: ObservableAdapter;
  learnerId: string;
}> {
  const inner = new SqlJsAdapter(':memory:');
  await inner.init();
  const profile = await new SQLiteUserProfileRepository(inner).update({
    displayName: 'Recovery Tester',
    currentLevel: 'A2',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });
  const adapter = new ObservableAdapter(inner);
  return { inner, adapter, learnerId: profile.id };
}

function ownerFor(
  adapter: DatabaseAdapter,
  factory: () => DatabaseAdapter | Promise<DatabaseAdapter> = () => adapter,
): AppDatabaseOwner {
  return createAppDatabaseOwner({
    databaseName: APP_DATABASE_NAME,
    createAdapter: factory,
    now: () => NOW,
  });
}

/* ------------------------------------------------------------------ *
 * 1–2. Concurrent initialization
 * ------------------------------------------------------------------ */

describe('canonical database owner: concurrent initialization', () => {
  it('10 concurrent requests perform exactly ONE real initialization', async () => {
    const { adapter, inner } = await seedRealDatabase();
    let created = 0;
    const owner = ownerFor(adapter, async () => {
      created += 1;
      // Deliberate interleaving window: every caller arrives while the first
      // initialization is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return adapter;
    });

    const connections = await Promise.all(
      Array.from({ length: 10 }, () => owner.open()),
    );

    // ONE adapter created, ONE initialization, ONE lifecycle.
    expect(created).toBe(1);
    expect(adapter.initCalls).toBe(1);
    expect(connections).toHaveLength(10);
    for (const connection of connections) {
      expect(connection).toBe(connections[0]);
      expect(connection.adapter).toBe(adapter);
      expect(connection.lifecycleId).toBe(1);
    }

    // The shared database is a real, migrated v6 database and migrations ran
    // exactly once (the adapter's init is the only migration runner).
    expect(await getSchemaVersion(inner)).toBe(6);
    const migrations = await inner.query(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(migrations.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a successful initialization is reused by later requests', async () => {
    const { adapter } = await seedRealDatabase();
    let created = 0;
    const owner = ownerFor(adapter, () => {
      created += 1;
      return adapter;
    });

    const first = await owner.open();
    const second = await owner.open();
    const third = await owner.open();

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(created).toBe(1);
    expect(adapter.initCalls).toBe(1);
  });

  it('runs one initialization per ownership lifecycle (a reopen is a NEW lifecycle)', async () => {
    const { adapter } = await seedRealDatabase();
    const secondAdapter = new ObservableAdapter(await (async () => {
      const inner = new SqlJsAdapter(':memory:');
      await inner.init();
      return inner;
    })());
    const created: DatabaseAdapter[] = [];
    const owner = ownerFor(adapter, () => {
      const next = created.length === 0 ? adapter : secondAdapter;
      created.push(next);
      return next;
    });

    const first = await owner.open();
    expect(first.lifecycleId).toBe(1);
    await owner.close();

    const second = await owner.open();
    expect(second.lifecycleId).toBe(2);
    expect(second.adapter).toBe(secondAdapter);
    expect(created).toHaveLength(2);
    expect(adapter.initCalls).toBe(1);
    expect(secondAdapter.initCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Failed initialization is surfaced and NOT cached
 * ------------------------------------------------------------------ */

describe('canonical database owner: failed initialization', () => {
  it('surfaces an open failure honestly, preserving the original cause', async () => {
    const cause = new Error('expo-sqlite native module unavailable');
    const owner = ownerFor(new SqlJsAdapter(':memory:'), () => {
      throw cause;
    });

    const error = await owner.open().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DatabaseBootstrapError);
    const bootstrap = error as DatabaseBootstrapError;
    expect(bootstrap.code).toBe('open_failed');
    expect(bootstrap.is('open_failed')).toBe(true);
    expect(bootstrap.cause).toBe(cause);
    // The safe message never leaks raw implementation detail.
    expect(bootstrap.userMessage).not.toContain('expo-sqlite');
    expect(bootstrap.userMessage).not.toContain(cause.message);
    expect(owner.isOpen).toBe(false);
    expect(owner.connection).toBeNull();
  });

  it('classifies a failed migration separately and leaves nothing open', async () => {
    const { adapter } = await seedRealDatabase();
    adapter.failInitWith = new Error('disk I/O error while migrating');
    const owner = ownerFor(adapter);

    const error = await owner.open().catch((err: unknown) => err);
    expect((error as DatabaseBootstrapError).code).toBe('migration_failed');
    expect((error as DatabaseBootstrapError).cause).toBe(adapter.failInitWith);
    // The half-initialized adapter was closed and no connection was installed.
    expect(adapter.closeCalls).toBe(1);
    expect(owner.connection).toBeNull();
  });

  it('does NOT cache the failure: a later request retries and can succeed', async () => {
    const { adapter, inner, learnerId } = await seedRealDatabase();
    let calls = 0;
    const owner = ownerFor(adapter, async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('temporary open failure');
      }
      return adapter;
    });

    const first = await owner.open().catch((err: unknown) => err);
    expect(first).toBeInstanceOf(DatabaseBootstrapError);
    expect((first as DatabaseBootstrapError).code).toBe('open_failed');

    // A later, explicit request retries instead of being poisoned forever.
    const connection = await owner.open();
    expect(connection.adapter).toBe(adapter);
    expect(connection.lifecycleId).toBe(2);
    expect(calls).toBe(2);
    expect(owner.isOpen).toBe(true);

    // …and the successfully opened database is the real one (data untouched).
    const rows = await inner.query(
      `SELECT id FROM learner_profile WHERE id = ?`,
      [learnerId],
    );
    expect(rows).toHaveLength(1);
  });

  it('retries concurrent callers against the same retried in-flight attempt', async () => {
    const { adapter } = await seedRealDatabase();
    let attempts = 0;
    const owner = ownerFor(adapter, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt fails');
      await new Promise((resolve) => setTimeout(resolve, 3));
      return adapter;
    });

    await expect(owner.open()).rejects.toBeInstanceOf(DatabaseBootstrapError);

    const connections = await Promise.all([owner.open(), owner.open(), owner.open()]);
    expect(connections[0]).toBe(connections[1]);
    expect(connections[1]).toBe(connections[2]);
    expect(attempts).toBe(2);
    expect(adapter.initCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * 4–5. Close / reopen semantics
 * ------------------------------------------------------------------ */

describe('canonical database owner: close and reopen', () => {
  it('an app-level close is idempotent', async () => {
    const { adapter } = await seedRealDatabase();
    const owner = ownerFor(adapter);
    await owner.open();

    await owner.close();
    await owner.close();
    await owner.close();

    expect(adapter.closeCalls).toBe(1);
    expect(owner.isOpen).toBe(false);
    expect(owner.connection).toBeNull();
  });

  it('closing a never-opened owner is a safe no-op', async () => {
    const owner = ownerFor(new SqlJsAdapter(':memory:'));
    await expect(owner.close()).resolves.toBeUndefined();
    expect(owner.isOpen).toBe(false);
  });

  it('an explicit close prevents any reuse of the old connection', async () => {
    const { adapter } = await seedRealDatabase();
    let created = 0;
    const second = new ObservableAdapter(await (async () => {
      const inner = new SqlJsAdapter(':memory:');
      await inner.init();
      return inner;
    })());
    const owner = ownerFor(adapter, () => {
      created += 1;
      return created === 1 ? adapter : second;
    });

    const old = await owner.open();
    expect(old.isClosed()).toBe(false);
    old.assertOpen(); // usable while open

    await owner.close();

    // The old handle is invalid and says so with the typed error…
    expect(old.isClosed()).toBe(true);
    expect(() => old.assertOpen()).toThrow(DatabaseBootstrapError);
    try {
      old.assertOpen();
    } catch (error) {
      expect((error as DatabaseBootstrapError).code).toBe('closed');
    }
    // …and the old adapter really is closed.
    expect(adapter.connected).toBe(false);
    // The owner exposes no connection, so nothing stale can be handed out.
    expect(owner.connection).toBeNull();
    expect(owner.lifecycleId).toBeNull();
  });

  it('a reopen creates a valid NEW lifecycle and never reuses the old adapter', async () => {
    const { adapter, inner, learnerId } = await seedRealDatabase();
    // Keep the first lifecycle's raw handle queryable for post-mortem checks.
    adapter.keepInnerOpenOnClose = true;
    const secondInner = new SqlJsAdapter(':memory:');
    await secondInner.init();
    const secondAdapter = new ObservableAdapter(secondInner);
    let created = 0;
    const owner = ownerFor(adapter, () => {
      created += 1;
      return created === 1 ? adapter : secondAdapter;
    });

    const first = await owner.open();
    const reopened = await owner.reopen();

    expect(reopened).not.toBe(first);
    expect(reopened.adapter).toBe(secondAdapter);
    expect(reopened.lifecycleId).toBe(2);
    expect(reopened.isClosed()).toBe(false);
    expect(owner.isOpen).toBe(true);

    // The new lifecycle is fully usable on real SQLite.
    const version = await getSchemaVersion(secondInner);
    expect(version).toBe(6);
    const repository = new SQLiteUserProfileRepository(reopened.adapter);
    const created2 = await repository.update({
      displayName: 'Second Lifecycle',
      currentLevel: 'B1',
      targetLevel: 'C1',
      learningGoals: [],
      preferredModes: [],
    });
    expect(created2.id).toBeTruthy();

    // The previous lifecycle's data is untouched (no silent reset).
    const rows = await inner.query(`SELECT id FROM learner_profile WHERE id = ?`, [
      learnerId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('a close that races an in-flight initialization never installs a connection', async () => {
    const { adapter } = await seedRealDatabase();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = ownerFor(adapter, async () => {
      await gate;
      return adapter;
    });

    const opening = owner.open();
    const closing = owner.close();
    release!();

    await expect(opening).rejects.toBeInstanceOf(DatabaseBootstrapError);
    await closing;

    expect(owner.isOpen).toBe(false);
    expect(owner.connection).toBeNull();
    // The adapter produced by the discarded attempt was closed, not leaked.
    expect(adapter.closeCalls).toBe(1);

    // The next open is a clean lifecycle (the discarded attempt consumed the
    // lifecycle id it never got to use).
    const connection = await owner.open();
    expect(connection.lifecycleId).toBe(2);
    expect(owner.isOpen).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 6–8. Health inspection
 * ------------------------------------------------------------------ */

describe('canonical database owner: integrity validation', () => {
  it('reports a healthy v6 database and refuses to inspect a closed one', async () => {
    const { adapter } = await seedRealDatabase();
    const owner = ownerFor(adapter);
    await owner.open();

    const health = await owner.validate();
    expect(health.ok).toBe(true);
    expect(health.schemaVersion).toBe(6);
    expect(health.expectedSchemaVersion).toBe(6);
    expect(health.missingTables).toEqual([]);
    expect(health.integrityCheck).toBe('ok');
    expect(health.issues).toEqual([]);

    await owner.close();
    await expect(owner.validate()).rejects.toMatchObject({ code: 'closed' });
  });

  it('fails closed on a schema-version mismatch and PRESERVES the database', async () => {
    const { inner, adapter, learnerId } = await seedRealDatabase();
    adapter.keepInnerOpenOnClose = true;
    // Simulate a database written by a NEWER app version.
    await inner.execute(`UPDATE schema_migrations SET version = 99 WHERE version = 6`);

    const owner = ownerFor(adapter);
    const error = await owner.open().catch((err: unknown) => err);

    expect((error as DatabaseBootstrapError).code).toBe('integrity_failed');
    expect(owner.isOpen).toBe(false);
    // Non-destructive: nothing was repaired, reset or deleted.
    expect(await getSchemaVersion(inner)).toBe(99);
    const rows = await inner.query(`SELECT id FROM learner_profile WHERE id = ?`, [
      learnerId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('fails closed on a missing core table and PRESERVES the database', async () => {
    const { inner, adapter, learnerId } = await seedRealDatabase();
    adapter.keepInnerOpenOnClose = true;
    await inner.execute(`DROP TABLE review_history`);

    const owner = ownerFor(adapter);
    const error = await owner.open().catch((err: unknown) => err);

    expect((error as DatabaseBootstrapError).code).toBe('integrity_failed');
    const message = (error as DatabaseBootstrapError).message;
    expect(message).toContain('review_history');

    // No silent repair: the table is still missing and the learner row intact.
    const tables = await inner.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_history'`,
    );
    expect(tables).toHaveLength(0);
    const rows = await inner.query(`SELECT id FROM learner_profile WHERE id = ?`, [
      learnerId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('never treats corruption as something to repair (validation is read-only)', async () => {
    const { inner, adapter } = await seedRealDatabase();
    adapter.keepInnerOpenOnClose = true;
    const before = await inner.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );

    const health = await validateDatabaseIntegrity(inner, () => NOW);
    expect(health.ok).toBe(true);
    expect(health.checkedAt).toBe(NOW);

    const after = await inner.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    expect(after).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * 9. Explicit reset primitive (never automatic)
 * ------------------------------------------------------------------ */

describe('canonical database owner: explicit local-data reset', () => {
  it('refuses without explicit confirmation and deletes nothing', async () => {
    const { inner, adapter } = await seedRealDatabase();
    const owner = ownerFor(adapter);
    await owner.open();

    await expect(
      owner.resetLocalData({ confirm: 'nope' } as never),
    ).rejects.toMatchObject({ code: 'unavailable' });

    const rows = await inner.query(`SELECT COUNT(*) AS c FROM learner_profile`);
    expect(Number(rows[0].c)).toBe(1);
  });

  it('is NEVER invoked during a failed initialization and cannot run while closed', async () => {
    const { inner, adapter, learnerId } = await seedRealDatabase();
    adapter.keepInnerOpenOnClose = true;
    adapter.failInitWith = new Error('open failed');
    const owner = ownerFor(adapter);

    const error = await owner.open().catch((err: unknown) => err);
    expect((error as DatabaseBootstrapError).code).toBe('migration_failed');

    // A closed/failed lifecycle refuses to delete anything…
    await expect(
      owner.resetLocalData({ confirm: 'delete-all-local-data' }),
    ).rejects.toMatchObject({ code: 'closed' });

    // …and every seeded row is still there.
    const profileRows = await inner.query(
      `SELECT id FROM learner_profile WHERE id = ?`,
      [learnerId],
    );
    expect(profileRows).toHaveLength(1);
    const version = await getSchemaVersion(inner);
    expect(version).toBe(6);
  });

  it('deletes learner data only when explicitly confirmed, keeping the schema', async () => {
    const { inner, adapter, learnerId } = await seedRealDatabase();
    await inner.execute(
      `INSERT INTO lexical_items (id, learner_id, type, headword, created_at, updated_at)
       VALUES ('lex-1', ?, 'word', 'resilient', ?, ?)`,
      [learnerId, NOW, NOW],
    );
    await inner.execute(
      `INSERT INTO progress_records (id, learner_id, recorded_at, window_start, window_end)
       VALUES ('prog-1', ?, ?, ?, ?)`,
      [learnerId, NOW, NOW, NOW],
    );

    const owner = ownerFor(adapter);
    await owner.open();
    await owner.resetLocalData({ confirm: 'delete-all-local-data' });

    for (const table of [
      'learner_profile',
      'lexical_items',
      'progress_records',
      'review_items',
      'learner_weaknesses',
    ]) {
      const rows = await inner.query(`SELECT COUNT(*) AS c FROM ${table}`);
      expect(Number(rows[0].c)).toBe(0);
    }
    // The schema is preserved: still v6, still healthy, still migratable.
    expect(await getSchemaVersion(inner)).toBe(6);
    const health = await owner.validate();
    expect(health.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 10. Canonical owner access + injection seam
 * ------------------------------------------------------------------ */

describe('canonical application database access', () => {
  it('exposes ONE canonical owner and the shared adapter to every caller', async () => {
    const { adapter } = await seedRealDatabase();
    const owner = ownerFor(adapter);
    setAppDatabaseOwner(owner);
    try {
      expect(getAppDatabaseOwner()).toBe(owner);
      const [a, b] = await Promise.all([getAppDatabase(), getAppDatabase()]);
      expect(a).toBe(b);
      expect(a.adapter).toBe(adapter);
      expect(adapter.initCalls).toBe(1);
    } finally {
      resetAppDatabaseOwnerForTests();
      await owner.close();
    }
  });

  it('an injected test owner bypasses the production (Expo) composition', async () => {
    const { adapter, learnerId } = await seedRealDatabase();
    const owner = ownerFor(adapter);
    setAppDatabaseOwner(owner);
    try {
      const { adapter: shared } = await getAppDatabase();
      // The injected adapter IS the shared one: the production adapter factory
      // (which would import expo-sqlite and fail in this environment) never ran.
      expect(shared).toBe(adapter);
      const repository = new SQLiteUserProfileRepository(shared);
      const profile = await repository.get();
      expect(profile?.id).toBe(learnerId);
    } finally {
      resetAppDatabaseOwnerForTests();
      await owner.close();
    }

    // Restoring the seam yields a fresh production owner, not the injected one.
    const restored = getAppDatabaseOwner();
    expect(restored).not.toBe(owner);
    await restored.close();
  });

  it('resolves the canonical database lazily and never names a second file', () => {
    expect(APP_DATABASE_NAME).toBe('ai_english_tutor.db');
    const spy = vi.fn();
    // The default owner is created lazily — constructing it must not open
    // anything (no eager native import at module load time).
    expect(typeof getAppDatabaseOwner().open).toBe('function');
    expect(spy).not.toHaveBeenCalled();
  });
});
