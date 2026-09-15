/**
 * src/data/local/sqlite/SqlJsAdapter.ts
 *
 * Concrete DatabaseAdapter backed by sql.js (pure WebAssembly SQLite).
 *
 * Used ONLY in tests. It lets the same repository code exercise the
 * real schema against a real SQL engine, without touching the
 * native expo-sqlite module that cannot run under Node.
 *
 * The adapter is intentionally a thin wrapper — it implements the
 * same DatabaseAdapter contract as the production adapter.
 */

import type {
  DatabaseAdapter,
  SqlExecuteResult,
  SqlParam,
  SqlRow,
  SqlStep,
} from './DatabaseAdapter';

type SqlJsDatabase = {
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): SqlJsStatement;
  getRowsModified(): number;
  lastInsertRowid: number;
  close(): void;
};

type SqlJsStatement = {
  bind(params?: unknown[]): void;
  step(): boolean;
  get(): unknown[];
  getAsObject(): Record<string, unknown>;
  free(): void;
  reset(): void;
};

type SqlJsModule = { Database: { new (): SqlJsDatabase } };

let cachedModule: SqlJsModule | null = null;

async function loadSqlJs(): Promise<SqlJsModule> {
  if (cachedModule) return cachedModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = await import('sql.js');
  const create = (mod as unknown as { default: () => Promise<SqlJsModule> }).default;
  cachedModule = await create();
  return cachedModule;
}

export class SqlJsAdapter implements DatabaseAdapter {
  readonly backend = 'sql.js' as const;
  readonly path: string;
  readonly connected: boolean = false;

  private db: SqlJsDatabase | null = null;
  private readonly databaseName: string;

  constructor(databaseName: string = ':memory:') {
    this.databaseName = databaseName;
    this.path = databaseName;
  }

  async init(): Promise<void> {
    if (this.db) return;
    const mod = await loadSqlJs();
    this.db = new mod.Database();
    this.connected = true;
  }

  async execute(sql: string, params?: readonly SqlParam[]): Promise<SqlExecuteResult> {
    this.ensureOpen();
    const before = this.db!.getRowsModified();
    this.db!.run(sql, params ?? []);
    const after = this.db!.getRowsModified();
    return {
      rowsAffected: Math.max(0, after - before),
      insertId: this.db!.lastInsertRowid,
    };
  }

  async query(sql: string, params?: readonly SqlParam[]): Promise<readonly SqlRow[]> {
    this.ensureOpen();
    const rows = this.db!.exec(sql, params ?? []);
    if (!rows || rows.length === 0) return [];
    const { columns, values } = rows[0];
    return values.map((row) => {
      const obj: SqlRow = {};
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i];
      }
      return obj;
    });
  }

  async transaction(steps: readonly SqlStep[]): Promise<readonly SqlExecuteResult[]> {
    this.ensureOpen();
    const results: SqlExecuteResult[] = [];
    // sql.js has no native transaction API exposed here, so we use
    // BEGIN/COMMIT/ROLLBACK via exec to get atomicity semantics.
    this.db!.exec('BEGIN');
    try {
      for (const step of steps) {
        const before = this.db!.getRowsModified();
        this.db!.run(step.sql, step.params ?? []);
        const after = this.db!.getRowsModified();
        results.push({
          rowsAffected: Math.max(0, after - before),
          insertId: this.db!.lastInsertRowid,
        });
      }
      this.db!.exec('COMMIT');
    } catch (err) {
      try {
        this.db!.exec('ROLLBACK');
      } catch {
        // swallow rollback errors
      }
      throw err;
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.connected = false;
  }

  private ensureOpen(): SqlJsDatabase {
    if (!this.db) {
      throw new Error('SqlJsAdapter not initialized. Call init() first.');
    }
    return this.db;
  }
}

/** Factory signature. */
export type SqlJsAdapterFactory = (databaseName?: string) => SqlJsAdapter;