import { describe, expect, it, vi } from 'vitest';

import type { DatabaseAdapter, SqlExecuteResult, SqlParam, SqlRow, SqlStep } from './DatabaseAdapter';
import {
  ApplicationDatabase,
  DatabaseError,
  type ApplicationDatabaseOptions,
} from './ApplicationDatabase';

/** A minimal in-memory adapter that records init/close calls. */
class StubAdapter implements DatabaseAdapter {
  readonly backend = 'memory' as const;
  readonly path = 'stub';
  private _connected = false;
  initCount = 0;
  closeCount = 0;
  openShouldFail = false;

  get connected(): boolean {
    return this._connected;
  }

  async init(): Promise<void> {
    this.initCount += 1;
    if (this.openShouldFail) {
      throw new Error('open failed');
    }
    this._connected = true;
  }

  async execute(_sql: string, _params?: readonly SqlParam[]): Promise<SqlExecuteResult> {
    return { rowsAffected: 0 };
  }

  async query(_sql: string, _params?: readonly SqlParam[]): Promise<readonly SqlRow[]> {
    return [];
  }

  async transaction(steps: readonly SqlStep[]): Promise<readonly SqlExecuteResult[]> {
    return steps.map(() => ({ rowsAffected: 0 }));
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this._connected = false;
  }
}

function makeOwner(overrides: Partial<ApplicationDatabaseOptions> = {}) {
  const adapters: StubAdapter[] = [];
  let migrateCalls = 0;
  let deleteCalls = 0;

  const owner = new ApplicationDatabase({
    databaseName: 'test.db',
    createAdapter: async () => {
      const a = new StubAdapter();
      adapters.push(a);
      return a;
    },
    migrate: async () => {
      migrateCalls += 1;
    },
    deleteDatabaseFile: async () => {
      deleteCalls += 1;
    },
    validate: async () => ({ ok: true, schemaVersion: 6 }),
    ...overrides,
  });

  return {
    owner,
    adapters,
    get migrateCalls() {
      return migrateCalls;
    },
    get deleteCalls() {
      return deleteCalls;
    },
  };
}

describe('ApplicationDatabase — canonical ownership', () => {
  it('1. shares ONE initialization across concurrent callers', async () => {
    const h = makeOwner();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => h.owner.open()),
    );
    // All callers get the SAME handle and the SAME adapter.
    expect(results.every((r) => r.adapter === results[0].adapter)).toBe(true);
    expect(h.adapters.length).toBe(1);
    expect(h.adapters[0].initCount).toBe(1);
    expect(h.migrateCalls).toBe(1);
  });

  it('2. a failed initialization clears state so the next attempt retries', async () => {
    const failing = new StubAdapter();
    failing.openShouldFail = true;
    let first = true;

    const owner = new ApplicationDatabase({
      databaseName: 'test.db',
      createAdapter: async () => {
        if (first) {
          first = false;
          return failing;
        }
        return new StubAdapter();
      },
      migrate: async () => {},
      deleteDatabaseFile: async () => {},
      validate: async () => ({ ok: true, schemaVersion: 6 }),
    });

    await expect(owner.open()).rejects.toBeInstanceOf(DatabaseError);
    // Retry succeeds cleanly — the failure did not disable the database.
    const handle = await owner.open();
    expect(handle.adapter).toBeDefined();
    expect(owner.connected).toBe(true);
  });

  it('3. repeated open after success reuses the same handle (one migration)', async () => {
    const h = makeOwner();
    const a = await h.owner.open();
    const b = await h.owner.open();
    const c = await h.owner.getAdapter();
    expect(a.adapter).toBe(b.adapter);
    expect(a.adapter).toBe(c);
    expect(h.adapters.length).toBe(1);
    expect(h.migrateCalls).toBe(1);
  });

  it('4. feature factory disposal does NOT close the global database', async () => {
    const h = makeOwner();
    await h.owner.open();
    // A feature disposing its own (separate) adapter must not affect the owner.
    const featureAdapter = new StubAdapter();
    await featureAdapter.init();
    await featureAdapter.close();
    expect(h.owner.connected).toBe(true);
    expect(h.adapters[0].closeCount).toBe(0);
  });

  it('5. explicit app-level close is idempotent', async () => {
    const h = makeOwner();
    await h.owner.open();
    await h.owner.close();
    await h.owner.close();
    await h.owner.close();
    expect(h.adapters[0].closeCount).toBe(1);
    expect(h.owner.connected).toBe(false);
  });

  it('6. reopen after close works and starts a fresh cycle', async () => {
    const h = makeOwner();
    await h.owner.open();
    const gen1 = h.owner.ownershipGeneration;
    await h.owner.close();
    const reopened = await h.owner.reopen();
    expect(reopened.adapter).toBeDefined();
    expect(h.owner.connected).toBe(true);
    expect(h.owner.ownershipGeneration).toBe(gen1 + 1);
  });

  it('7. reset deletes ONLY when explicitly called', async () => {
    const h = makeOwner();
    await h.owner.open();
    expect(h.deleteCalls).toBe(0);
    await h.owner.reset();
    expect(h.deleteCalls).toBe(1);
    // After reset the owner is open again on a fresh adapter.
    expect(h.owner.connected).toBe(true);
    expect(h.adapters.length).toBe(2);
  });

  it('8. a corruption/integrity failure never triggers a silent reset', async () => {
    const h = makeOwner({
      validate: async () => ({
        ok: false,
        schemaVersion: 6,
        detail: 'core tables missing',
      }),
    });
    await h.owner.open();
    const report = await h.owner.validate();
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('core tables missing');
    // reset was NEVER auto-invoked by validation.
    expect(h.deleteCalls).toBe(0);
  });

  it('9. a migration/open failure surfaces a typed recoverable error', async () => {
    const owner = new ApplicationDatabase({
      databaseName: 'test.db',
      createAdapter: async () => new StubAdapter(),
      migrate: async () => {
        throw new Error('boom');
      },
      deleteDatabaseFile: async () => {},
      validate: async () => ({ ok: true, schemaVersion: 6 }),
    });
    // The owner wraps adapter.init failures as migration_failed.
    await expect(owner.open()).rejects.toMatchObject({ kind: 'migration_failed' });
  });
});
