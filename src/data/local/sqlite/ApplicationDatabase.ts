/**
 * src/data/local/sqlite/ApplicationDatabase.ts
 *
 * CANONICAL APPLICATION DATABASE OWNER.
 *
 * Before this module every feature factory (Talk, Listening, Pronunciation,
 * Review, Vocabulary, Adaptive Lessons, Fluency, Daily Tutor, Onboarding,
 * Progress) opened its OWN `ExpoSqliteAdapter` against the same file and ran
 * migrations itself. That produced N parallel SQLite connections to one file,
 * N independent migration runs, several factories that cached a REJECTED
 * initialization promise forever, and no single owner able to close the
 * database cleanly.
 *
 * This module is the ONE owner of the application database lifecycle:
 *
 * - ONE adapter for the whole app run (shared, reference-composed).
 * - ONE in-flight initialization shared by every concurrent caller.
 * - FAILED initialization clears the cached state, so the next explicit
 *   attempt retries cleanly instead of being disabled for the app run.
 * - The owner alone controls TERMINAL close; feature factories never close it.
 * - `close()` is idempotent; `reopen()` yields a clean, fresh ownership cycle.
 * - `reset()` deletes the local learner database ONLY when explicitly called —
 *   never silently, and never on corruption.
 * - `validate()` reports a typed, recoverable error on an incompatible DB
 *   instead of continuing.
 *
 * The module is intentionally framework-light: no DI container, no service
 * locator registry beyond this single accessor.
 */

import type { DatabaseAdapter } from './DatabaseAdapter';

/** The one canonical database file name used by the whole app. */
export const APPLICATION_DATABASE_NAME = 'ai_english_tutor.db';

/** Typed, recoverable error kinds surfaced by the application database. */
export type DatabaseErrorKind =
  | 'open_failed'
  | 'migration_failed'
  | 'integrity_failed'
  | 'reset_failed';

/**
 * A recoverable database error. Callers can branch on `kind` and present an
 * actionable message. The existing DB file is ALWAYS preserved: this error
 * never triggers deletion of user data.
 */
export class DatabaseError extends Error {
  readonly kind: DatabaseErrorKind;
  readonly cause: unknown;

  constructor(kind: DatabaseErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'DatabaseError';
    this.kind = kind;
    this.cause = cause;
  }
}

/** Result of a lightweight integrity validation. */
export interface IntegrityReport {
  readonly ok: boolean;
  /** Highest applied schema version found in schema_migrations (0 when new). */
  readonly schemaVersion: number;
  /** Human-readable, actionable detail when `ok` is false. */
  readonly detail?: string;
}

/** Minimal factory contract the owner needs to build + adapt an adapter. */
export interface ApplicationDatabaseOptions {
  readonly databaseName?: string;
  /**
   * Builds an uninitialized adapter. Defaults to the real Expo SQLite adapter
   * (dynamically imported so tests never load the native module). Tests inject
   * a sql.js-backed adapter here.
   */
  readonly createAdapter?: (databaseName: string) => Promise<DatabaseAdapter>;
  /**
   * Runs migrations for an adapter. Defaults to `runMigrations` from schema.
   * Injected in tests to count initialization runs deterministically.
   */
  readonly migrate?: (adapter: DatabaseAdapter) => Promise<void>;
  /**
   * Opens a raw connection string for deletion (reset). Defaults to deleting
   * the expo-sqlite file. Injected in tests.
   */
  readonly deleteDatabaseFile?: (databaseName: string) => Promise<void>;
  /**
   * Read-only integrity/schema validation against an initialized adapter.
   * Defaults to reading `schema_migrations`. Injected in tests.
   */
  readonly validate?: (adapter: DatabaseAdapter) => Promise<IntegrityReport>;
}

/** What a shared-initialization caller receives. */
export interface ApplicationDatabaseHandle {
  readonly adapter: DatabaseAdapter;
  /** True for every owner instance in the same successful ownership cycle. */
  readonly databaseName: string;
}

/**
 * Reads the highest applied schema version and confirms the core tables exist.
 * Lightweight and non-destructive: it never repairs or mutates.
 */
async function defaultValidate(adapter: DatabaseAdapter): Promise<IntegrityReport> {
  try {
    const versionRows = await adapter.query(
      `SELECT MAX(version) AS version FROM schema_migrations`,
    );
    const schemaVersion = Number(versionRows[0]?.version ?? 0);

    // A database that recorded migrations must actually carry the core tables.
    const probe = await adapter.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learner_profile'`,
    );
    if (schemaVersion > 0 && probe.length === 0) {
      return {
        ok: false,
        schemaVersion,
        detail:
          'The learning database is missing its core tables. Your data was not changed; reopening or a supported reset can recover.',
      };
    }
    return { ok: true, schemaVersion };
  } catch (error) {
    return {
      ok: false,
      schemaVersion: 0,
      detail: `The learning database could not be validated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * ApplicationDatabase
 *
 * OWNERSHIP MODEL
 * - One instance owns ONE adapter lifecycle for the whole app.
 * - `open()` is the shared initialization entry: concurrent callers await the
 *   same in-flight promise; success is reused; failure clears the promise so
 *   the next `open()` retries.
 * - `close()` is terminal for the OWNER only and is idempotent. Feature
 *   factories must never call it.
 * - `reopen()` closes (if needed) then opens a fresh cycle.
 * - `reset()` deletes the local database file ONLY when explicitly invoked.
 */
export class ApplicationDatabase {
  private readonly databaseName: string;
  private readonly createAdapterFn: (databaseName: string) => Promise<DatabaseAdapter>;
  private readonly migrateFn: (adapter: DatabaseAdapter) => Promise<void>;
  private readonly deleteFn: (databaseName: string) => Promise<void>;
  private readonly validateFn: (adapter: DatabaseAdapter) => Promise<IntegrityReport>;

  /** The current successful handle, or null when not open. */
  private handle: ApplicationDatabaseHandle | null = null;
  /** The single in-flight initialization shared by concurrent callers. */
  private initPromise: Promise<ApplicationDatabaseHandle> | null = null;
  /** Counts successful ownership cycles (observability + tests). */
  private generation = 0;

  constructor(options: ApplicationDatabaseOptions = {}) {
    this.databaseName = options.databaseName ?? APPLICATION_DATABASE_NAME;
    this.createAdapterFn = options.createAdapter ?? defaultCreateAdapter;
    this.migrateFn = options.migrate ?? defaultMigrate;
    this.deleteFn = options.deleteDatabaseFile ?? defaultDeleteDatabaseFile;
    this.validateFn = options.validate ?? defaultValidate;
  }

  get name(): string {
    return this.databaseName;
  }

  get connected(): boolean {
    return this.handle !== null;
  }

  /** The current ownership-cycle number (0 before the first successful open). */
  get ownershipGeneration(): number {
    return this.generation;
  }

  /**
   * Shared initialization. Concurrent callers await ONE initialization; a
   * failure clears the cache so the NEXT call retries cleanly.
   */
  open(): Promise<ApplicationDatabaseHandle> {
    if (this.handle) {
      return Promise.resolve(this.handle);
    }
    if (!this.initPromise) {
      this.initPromise = this.performOpen().catch((error: unknown) => {
        // Release the cached promise so a transient failure does not disable
        // the database for the whole app run.
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async performOpen(): Promise<ApplicationDatabaseHandle> {
    let adapter: DatabaseAdapter;
    try {
      adapter = await this.createAdapterFn(this.databaseName);
    } catch (error) {
      throw new DatabaseError(
        'open_failed',
        'The learning database could not be opened. Your data was not changed.',
        error,
      );
    }

    try {
      await adapter.init();
    } catch (error) {
      throw new DatabaseError(
        'migration_failed',
        'The learning database could not be prepared. Your data was not changed.',
        error,
      );
    }

    this.generation += 1;
    const handle: ApplicationDatabaseHandle = {
      adapter,
      databaseName: this.databaseName,
    };
    this.handle = handle;
    return handle;
  }

  /**
   * Convenience accessor for composition factories: ensures the database is
   * open and returns the shared adapter. Feature factories use THIS instead of
   * constructing their own adapter.
   */
  async getAdapter(): Promise<DatabaseAdapter> {
    return (await this.open()).adapter;
  }

  /**
   * Lightweight, non-destructive integrity validation of the OPEN database.
   * Returns a typed report; never repairs and never deletes.
   */
  async validate(): Promise<IntegrityReport> {
    const report = await this.validateFn(await this.getAdapter());
    return report;
  }

  /**
   * Terminal close of the owner's connection. Idempotent: repeated calls are
   * harmless. Feature factories must NOT call this — only the owner/app-level
   * reset path may.
   */
  async close(): Promise<void> {
    const handle = this.handle;
    // Drop references first so a concurrent open() starts a fresh cycle and a
    // duplicate close cannot double-close the adapter.
    this.handle = null;
    this.initPromise = null;
    if (!handle) {
      return;
    }
    try {
      await handle.adapter.close();
    } catch {
      // Closing a already-closed adapter is not an error for the owner.
    }
  }

  /** Close (if open) then open a clean, fresh ownership cycle. */
  async reopen(): Promise<ApplicationDatabaseHandle> {
    await this.close();
    return this.open();
  }

  /**
   * App-level reset of the LOCAL learner database.
   *
   * ONLY runs when explicitly invoked. It preserves nothing by design BUT it
   * is never called automatically: corruption never triggers this path. After
   * deletion the database is reopened so the caller receives a working handle.
   */
  async reset(): Promise<ApplicationDatabaseHandle> {
    await this.close();
    try {
      await this.deleteFn(this.databaseName);
    } catch (error) {
      throw new DatabaseError(
        'reset_failed',
        'The learning database could not be reset. Your data may still be present.',
        error,
      );
    }
    return this.open();
  }
}

/* ------------------------------------------------------------------ *
 * Default production wiring (dynamic imports keep native modules out
 * of tests and out of modules that never touch the database).
 * ------------------------------------------------------------------ */

async function defaultCreateAdapter(databaseName: string): Promise<DatabaseAdapter> {
  const { ExpoSqliteAdapter } = await import('./ExpoSqliteAdapter');
  return new ExpoSqliteAdapter({ databaseName });
}

async function defaultMigrate(adapter: DatabaseAdapter): Promise<void> {
  // The adapter's init() already runs migrations; this hook exists so tests can
  // observe/count initialization without double-running it.
  const { runMigrations } = await import('./schema');
  await runMigrations(adapter);
}

async function defaultDeleteDatabaseFile(databaseName: string): Promise<void> {
  const { deleteDatabaseAsync } = await import('expo-sqlite');
  await deleteDatabaseAsync(databaseName);
}

/* ------------------------------------------------------------------ *
 * Module-level canonical owner.
 * ------------------------------------------------------------------ */

let applicationDatabase: ApplicationDatabase | null = null;

/**
 * The canonical application database owner. Reused app-wide; created once.
 * Callers may inject options (tests) — the FIRST call constructs the owner.
 */
export function getApplicationDatabase(
  options?: ApplicationDatabaseOptions,
): ApplicationDatabase {
  if (!applicationDatabase) {
    applicationDatabase = new ApplicationDatabase(options);
  }
  return applicationDatabase;
}

/**
 * Reset the module-level owner reference (tests only). Does NOT close or delete
 * anything — it only forgets the singleton so a fresh one can be constructed.
 */
export function __setApplicationDatabaseForTest(
  database: ApplicationDatabase | null,
): void {
  applicationDatabase = database;
}

/** Convenience: the shared adapter from the canonical owner. */
export async function getApplicationAdapter(): Promise<DatabaseAdapter> {
  return getApplicationDatabase().getAdapter();
}
