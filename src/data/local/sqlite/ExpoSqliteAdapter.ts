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
import { runMigrations } from './schema';

/** Options for creating an adapter. */
export interface ExpoSqliteAdapterOptions {
  readonly databaseName: string;
  readonly databaseDirectory?: string;
}

function toMutableParams(params?: readonly SqlParam[]): SqlParam[] {
  return (params ?? []) as SqlParam[];
}

export class ExpoSqliteAdapter implements DatabaseAdapter {
  readonly backend = 'expo-sqlite' as const;
  readonly path: string;
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  private db: SQLite.SQLiteDatabase | null = null;
  private readonly options: ExpoSqliteAdapterOptions;

  constructor(options: ExpoSqliteAdapterOptions) {
    this.options = options;
    this.path = `${options.databaseDirectory ?? ''}${options.databaseName}`;
  }

  async init(): Promise<void> {
    if (this.db) return;
    this.db = SQLite.openDatabaseSync(this.options.databaseName);
    this._connected = true;
    await runMigrations(this);
  }

  async execute(sql: string, params?: readonly SqlParam[]): Promise<SqlExecuteResult> {
    this.ensureOpen();
    const statement = await this.db!.prepareAsync(sql);
    try {
      const result = await statement.executeAsync(toMutableParams(params));
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
      const result = await statement.executeAsync(toMutableParams(params));
      const rows = await result.getAllAsync();
      return (rows ?? []) as readonly SqlRow[];
    } finally {
      await statement.finalizeAsync();
    }
  }

  async transaction(steps: readonly SqlStep[]): Promise<readonly SqlExecuteResult[]> {
    this.ensureOpen();
    const results: SqlExecuteResult[] = [];
    await this.db!.withTransactionAsync(async () => {
      for (const step of steps) {
        const statement = await this.db!.prepareAsync(step.sql);
        try {
          const result = await statement.executeAsync(toMutableParams(step.params));
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
    this._connected = false;
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