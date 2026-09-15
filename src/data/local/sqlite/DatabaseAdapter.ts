/**
 * src/data/local/sqlite/DatabaseAdapter.ts
 *
 * Low-level SQL database adapter contract.
 *
 * This is the ONLY place that knows about a specific SQL engine.
 * Everything above it (repositories, learner model, engines, UI)
 * talks to this interface and nothing else.
 *
 * The interface is deliberately tiny:
 *   - transaction support
 *   - parameterized execute (safe from SQL injection)
 *   - query returning rows
 *   - batch execution for migrations
 *
 * Both backends (expo-sqlite in production, sql.js in tests) must
 * implement this contract identically so repositories are
 * backend-agnostic and testable.
 */

/** A value that can be bound as a SQL parameter. */
export type SqlParam =
  | string
  | number
  | boolean
  | null
  | Uint8Array;

/** Row is a plain object keyed by column name. */
export type SqlRow = Record<string, SqlParam | undefined>;

/** Result of an execute that returns row metadata. */
export interface SqlExecuteResult {
  readonly rowsAffected: number;
  readonly insertId?: number;
}

/** A single step inside a transaction. */
export type SqlStep = {
  readonly sql: string;
  readonly params?: readonly SqlParam[];
};

/**
 * DatabaseAdapter
 *
 * Minimal SQL surface area. No ORM, no query builder — raw SQL is
 * fine because it lives behind repository abstractions and never
 * reaches the UI.
 */
export interface DatabaseAdapter {
  readonly backend: 'expo-sqlite' | 'sql.js' | 'memory';
  readonly path: string;
  readonly connected: boolean;

  /**
   * Initialize the database (create file, open connection, run
   * migrations). Idempotent — safe to call multiple times.
   */
  init(): Promise<void>;

  /**
   * Execute a single statement. Returns row metadata.
   * For SELECTs, use query() instead.
   */
  execute(sql: string, params?: readonly SqlParam[]): Promise<SqlExecuteResult>;

  /**
   * Execute a SELECT and return all matching rows.
   */
  query(sql: string, params?: readonly SqlParam[]): Promise<readonly SqlRow[]>;

  /**
   * Execute one or more statements atomically. If any step fails,
   * the whole transaction rolls back.
   */
  transaction(steps: readonly SqlStep[]): Promise<readonly SqlExecuteResult[]>;

  /**
   * Close the database. Subsequent calls must re-init.
   */
  close(): Promise<void>;
}