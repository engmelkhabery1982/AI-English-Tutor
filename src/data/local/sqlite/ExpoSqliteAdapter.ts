/**
 * src/data/local/sqlite/ExpoSqliteAdapter.ts
 *
 * Concrete DatabaseAdapter backed by expo-sqlite.
 *
 * Used in production on device. Tests use SqlJsAdapter so the
 * same repository code exercises the real schema against a real
 * SQL engine.
 */

import * as SQLite from 'expo-sqlite';
import type {
  DatabaseAdapter,
  SqlExecuteResult,
  SqlParam,
  SqlRow,
  SqlStep,
} from './DatabaseAdapter';

const SCHEMA_TABLE = 'schema_migrations';

/** Options for creating an adapter. */
export interface ExpoSqliteAdapterOptions {
  readonly databaseName: string;
  readonly databaseDirectory?: string;
}

export class ExpoSqliteAdapter implements DatabaseAdapter {
  readonly backend = 'expo-sqlite' as const;
  readonly path: string;
  readonly connected: boolean = false;

  private db: SQLite.SQLiteDatabase | null = null;
  private readonly options: ExpoSqliteAdapterOptions;

  constructor(options: ExpoSqliteAdapterOptions) {
    this.options = options;
    this.path = `${options.databaseDirectory ?? ''}${options.databaseName}`;
  }

  async init(): Promise<void> {
    if (this.db) return;
    this.db = SQLite.openDatabase(this.options.databaseName);
    this.connected = true;
  }

  async execute(sql: string, params?: readonly SqlParam[]): Promise<SqlExecuteResult> {
    this.ensureOpen();
    const statement = await this.db!.prepareAsync(sql);
    try {
      const result = await statement.executeAsync<SqlRow>(params ?? []);
      return {
        rowsAffected: result.changes ?? 0,
        insertId: result.lastInsertRowId ?? undefined,
      };
    } finally {
      await statement.finalizeAsync();
    }
  }

  async query(sql: string, params?: readonly SqlParam[]): Promise<readonly SqlRow[]> {
    this.ensureOpen();
    const statement = await this.db!.prepareAsync(sql);
    try {
      const result = await statement.executeAsync<SqlRow>(params ?? []);
      return result.getAllAsync() ?? [];
    } finally {
      await statement.finalizeAsync();
    }
  }

  async transaction(steps: readonly SqlStep[]): Promise<readonly SqlExecuteResult[]> {
    this.ensureOpen();
    const results: SqlExecuteResult[] = [];
    await this.db!.withTransactionAsync(async (tx) => {
      for (const step of steps) {
        const statement = await tx.prepareAsync(step.sql);
        try {
          const result = await statement.executeAsync<SqlRow>(step.params ?? []);
          results.push({
            rowsAffected: result.changes ?? 0,
            insertId: result.lastInsertRowId ?? undefined,
          });
        } finally {
          await statement.finalizeAsync();
        }
      }
    });
    return results;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.closeAsync();
      this.db = null;
    }
    this.connected = false;
  }

  private ensureOpen(): SQLite.SQLiteDatabase {
    if (!this.db) {
      throw new Error('ExpoSqliteAdapter not initialized. Call init() first.');
    }
    return this.db;
  }
}

/** Factory signature. */
export type ExpoSqliteAdapterFactory = (
  options: ExpoSqliteAdapterOptions,
) => ExpoSqliteAdapter;