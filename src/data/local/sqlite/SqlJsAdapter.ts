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
import { runMigrations } from './schema';

// sql.js types (minimal subset we need)
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
  const mod = await import('sql.js');
  const create = (mod as unknown as { default: () => Promise<SqlJsModule> }).default;
  cachedModule = await create();
  return cachedModule;
}

function toUnknownArray(params?: readonly SqlParam[]): unknown[] {
  return (params ?? []) as unknown[];
}

export class SqlJsAdapter implements DatabaseAdapter {
  readonly backend = 'sql.js' as const;
  readonly path: string;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  private db: SqlJsDatabase | null = null;
  /** In-flight initialization: concurrent init() callers await this one run. */
  private initPromise: Promise<void> | null = null;
  private readonly databaseName: string;

  constructor(databaseName: string = ':memory:') {
    this.databaseName = databaseName;
    this.path = databaseName;
  }

  /**
   * Initialize (open + migrate). Idempotent: while an initialization is still
   * running, every caller awaits THAT run; a failed run is not cached, so a
   * later call may try again.
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    const attempt = this.initialize();
    this.initPromise = attempt;
    void attempt.then(
      () => {
        if (this.initPromise === attempt) this.initPromise = null;
      },
      () => {
        if (this.initPromise === attempt) this.initPromise = null;
      },
    );
    return attempt;
  }

  private async initialize(): Promise<void> {
    const mod = await loadSqlJs();
    this.db = new mod.Database();
    this._connected = true;
    try {
      await runMigrations(this);
    } catch (error) {
      // A failed initialization must not leave a half-open connection behind.
      await this.close();
      throw error;
    }
  }

  async execute(sql: string, params?: readonly SqlParam[]): Promise<SqlExecuteResult> {
    this.ensureOpen();
    this.db!.run(sql, toUnknownArray(params));
    return {
      rowsAffected: this.db!.getRowsModified(),
      insertId: this.db!.lastInsertRowid,
    };
  }

  async query(sql: string, params?: readonly SqlParam[]): Promise<readonly SqlRow[]> {
    this.ensureOpen();
    const rows = this.db!.exec(sql, toUnknownArray(params));
    if (!rows || rows.length === 0) return [];
    const { columns, values } = rows[0];
    return values.map((row) => {
      const obj: SqlRow = {};
      for (let i = 0; i < columns.length; i++) {
        const val = row[i];
        obj[columns[i]] = val as SqlParam | undefined;
      }
      return obj;
    });
  }

  async transaction(steps: readonly SqlStep[]): Promise<readonly SqlExecuteResult[]> {
    this.ensureOpen();
    const results: SqlExecuteResult[] = [];
    // Use IMMEDIATE to acquire write lock early, preventing lost updates
    // when two repository instances race on the same logical row.
    this.db!.exec('BEGIN IMMEDIATE');
    try {
      for (const step of steps) {
        this.db!.run(step.sql, toUnknownArray(step.params));
        results.push({
          rowsAffected: this.db!.getRowsModified(),
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
    this._connected = false;
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