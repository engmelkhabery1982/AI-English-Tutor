/**
 * src/data/local/sqlite/app-database.ts
 *
 * THE canonical application-database owner.
 *
 * WHY THIS EXISTS
 * Feature compositions (Talk, Review, Listening, Pronunciation, Fluency, the
 * Daily Tutor, Reassessment, Progress, Onboarding, Adaptive Lessons, the
 * Vocabulary workspace, conversation memory, learning persistence and the
 * vocabulary bridge) used to open `ai_english_tutor.db` each on its own
 * adapter. That meant one SQLite connection and one migration run per feature.
 * This module is the single place that owns that file's lifecycle.
 *
 * OWNERSHIP MODEL
 * - ONE owner object owns the database file for the whole application.
 * - The owner opens AT MOST ONE adapter per lifecycle and hands the SAME
 *   adapter to every caller; repositories stay per-feature objects but share
 *   that adapter.
 * - Migrations run inside the adapter's single initialization (the adapter
 *   contract), and that initialization runs exactly once per lifecycle.
 * - Features never close the app database. Only `close()` on the app-level
 *   owner performs a terminal close, and it is idempotent.
 * - After an explicit close, `open()`/`reopen()` starts a NEW lifecycle with a
 *   NEW adapter; the previous connection object is marked closed so it can
 *   never be reused illegally.
 *
 * CONCURRENT INITIALIZATION
 * - N concurrent `open()` calls share ONE in-flight initialization promise and
 *   all receive the same connection.
 *
 * FAILED INITIALIZATION
 * - A rejected initialization is NOT cached: the in-flight slot is cleared and
 *   the failure is surfaced (typed, with the original cause). A later explicit
 *   `open()` retries. Nothing is auto-reset and no user data is touched.
 *
 * TESTS / EMBEDDING
 * - `createAppDatabaseOwner({ createAdapter })` is the injection seam: tests
 *   pass an isolated in-memory adapter factory (SqlJsAdapter) and never touch
 *   the production adapter, while production code keeps using the canonical
 *   owner through `getAppDatabase()`.
 */

import type { DatabaseAdapter } from './DatabaseAdapter';
import {
  DatabaseBootstrapError,
  toDatabaseBootstrapError,
  type DatabaseBootstrapErrorContext,
} from './DatabaseBootstrapError';
import { validateDatabaseIntegrity, type DatabaseHealth } from './integrity';

/** The application database file (one file, one owner). */
export const APP_DATABASE_NAME = 'ai_english_tutor.db';

/**
 * A handle to ONE ownership lifecycle of the application database.
 * The adapter is shared; the connection only becomes invalid when the
 * app-level owner closes that lifecycle.
 */
export interface AppDatabaseConnection {
  readonly adapter: DatabaseAdapter;
  /** Monotonic lifecycle id (1, 2, …) — a new one after every close. */
  readonly lifecycleId: number;
  readonly databaseName: string;
  /** True once the owning lifecycle was closed. */
  isClosed(): boolean;
  /** Throws a typed `closed` error when this connection was closed. */
  assertOpen(): void;
}

/** Adapter factory seam (production default: the Expo SQLite adapter). */
export type AppDatabaseAdapterFactory = (options: {
  readonly databaseName: string;
}) => DatabaseAdapter | Promise<DatabaseAdapter>;

export interface AppDatabaseOwnerOptions {
  /** Defaults to the canonical application database file. */
  readonly databaseName?: string;
  /** Injection seam for tests/embedding. Defaults to the Expo SQLite adapter. */
  readonly createAdapter?: AppDatabaseAdapterFactory;
  /** Injectable clock (tests). */
  readonly now?: () => string;
}

/** Explicit confirmation required by the destructive reset primitive. */
export interface DatabaseResetRequest {
  readonly confirm: 'delete-all-local-data';
}

/**
 * Every table holding learner data, ordered children-first so foreign keys stay
 * satisfied while deleting. `schema_migrations` is deliberately NOT reset: it
 * records the schema, not the learner's data.
 */
const LOCAL_DATA_TABLES_CHILD_FIRST: readonly string[] = [
  'weakness_evidence',
  'review_history',
  'lexical_examples',
  'lexical_meanings',
  'conversation_turns',
  'daily_tutor_activities',
  'reassessment_history',
  'learner_strengths',
  'grammar_mistakes',
  'pronunciation_weaknesses',
  'learner_weaknesses',
  'review_items',
  'lexical_items',
  'progress_records',
  'daily_tutor_sessions',
  'conversation_sessions',
  'learner_profile',
];

/** Close an adapter without letting a close failure mask the original error. */
async function closeQuietly(adapter: DatabaseAdapter): Promise<void> {
  try {
    await adapter.close();
  } catch {
    // A failing close must never replace the failure that caused it.
  }
}

function createConnection(
  adapter: DatabaseAdapter,
  lifecycleId: number,
  databaseName: string,
): { connection: AppDatabaseConnection; markClosed: () => void } {
  let closed = false;
  const connection: AppDatabaseConnection = {
    adapter,
    lifecycleId,
    databaseName,
    isClosed: () => closed,
    assertOpen(): void {
      if (closed) {
        throw new DatabaseBootstrapError({
          code: 'closed',
          message: `Application database lifecycle ${lifecycleId} is closed.`,
          context: { databaseName, lifecycleId },
        });
      }
    },
  };
  return {
    connection,
    markClosed: () => {
      closed = true;
    },
  };
}

/**
 * The canonical owner. One instance owns one database file; it is safe for
 * concurrent callers and never caches a failed initialization.
 */
export class AppDatabaseOwner {
  private readonly databaseName: string;
  private readonly createAdapter: AppDatabaseAdapterFactory;
  private readonly now: () => string;

  private current: {
    readonly connection: AppDatabaseConnection;
    readonly markClosed: () => void;
  } | null = null;
  private pendingOpen: Promise<AppDatabaseConnection> | null = null;
  private nextLifecycleId = 1;
  /** Incremented by every terminal close: invalidates in-flight opens. */
  private closeCount = 0;

  constructor(options: AppDatabaseOwnerOptions = {}) {
    this.databaseName = options.databaseName ?? APP_DATABASE_NAME;
    this.createAdapter = options.createAdapter ?? createDefaultExpoAdapter;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** The open connection, or null when no lifecycle is currently open. */
  get connection(): AppDatabaseConnection | null {
    return this.current?.connection ?? null;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** Lifecycle id of the open connection, or null when closed. */
  get lifecycleId(): number | null {
    return this.current?.connection.lifecycleId ?? null;
  }

  /**
   * Obtain the shared connection. Concurrent callers await the SAME in-flight
   * initialization; a failed initialization is surfaced and NOT cached, so a
   * later call retries (and can succeed).
   */
  open(): Promise<AppDatabaseConnection> {
    if (this.current) {
      return Promise.resolve(this.current.connection);
    }
    if (this.pendingOpen) {
      return this.pendingOpen;
    }

    const attempt = this.openOnce();
    this.pendingOpen = attempt;
    // Free the in-flight slot in BOTH outcomes: success is served by
    // `this.current`, failure must stay retryable.
    void attempt.then(
      () => {
        if (this.pendingOpen === attempt) this.pendingOpen = null;
      },
      () => {
        if (this.pendingOpen === attempt) this.pendingOpen = null;
      },
    );
    return attempt;
  }

  private async openOnce(): Promise<AppDatabaseConnection> {
    const lifecycleId = this.nextLifecycleId;
    this.nextLifecycleId += 1;
    const closeCount = this.closeCount;

    const context: DatabaseBootstrapErrorContext = {
      databaseName: this.databaseName,
      lifecycleId,
    };

    // 1. Create the adapter (platform adapter or an injected test factory).
    let adapter: DatabaseAdapter;
    try {
      adapter = await this.createAdapter({ databaseName: this.databaseName });
    } catch (cause) {
      throw toDatabaseBootstrapError(
        cause,
        'open_failed',
        `The application database "${this.databaseName}" could not be opened.`,
        context,
      );
    }

    // 2. Initialize it: open the file and run migrations exactly ONCE for this
    //    lifecycle (migration execution belongs to adapter initialization).
    try {
      await adapter.init();
    } catch (cause) {
      await closeQuietly(adapter);
      throw toDatabaseBootstrapError(
        cause,
        'migration_failed',
        `The application database "${this.databaseName}" could not be prepared.`,
        context,
      );
    }

    // 3. Validate the prepared database (non-destructive; never repairs).
    let health: DatabaseHealth;
    try {
      health = await validateDatabaseIntegrity(adapter, this.now);
    } catch (cause) {
      await closeQuietly(adapter);
      throw toDatabaseBootstrapError(
        cause,
        'integrity_failed',
        `The application database "${this.databaseName}" could not be validated.`,
        context,
      );
    }
    if (!health.ok) {
      await closeQuietly(adapter);
      throw new DatabaseBootstrapError({
        code: 'integrity_failed',
        message: `The application database "${this.databaseName}" failed validation: ${health.issues
          .map((issue) => issue.detail)
          .join(' ')}`,
        context: { ...context, schemaVersion: health.schemaVersion },
      });
    }

    // A terminal close that happened while this attempt was in flight wins:
    // never hand out (or install) a connection from a closed lifecycle.
    if (this.closeCount !== closeCount) {
      await closeQuietly(adapter);
      throw new DatabaseBootstrapError({
        code: 'closed',
        message: `The application database was closed while lifecycle ${lifecycleId} was opening.`,
        context,
      });
    }

    const { connection, markClosed } = createConnection(
      adapter,
      lifecycleId,
      this.databaseName,
    );
    this.current = { connection, markClosed };
    return connection;
  }

  /**
   * Terminal close of the current lifecycle. Idempotent: closing twice (or
   * closing a never-opened owner) is a safe no-op. Every previously handed-out
   * connection becomes invalid; the next `open()` starts a NEW lifecycle.
   */
  async close(): Promise<void> {
    const current = this.current;
    const pending = this.pendingOpen;
    this.current = null;
    this.pendingOpen = null;
    this.closeCount += 1;

    if (current) {
      current.markClosed();
      await closeQuietly(current.connection.adapter);
    }
    if (pending) {
      // Wait for the in-flight attempt: it either fails (nothing left open) or
      // throws `closed` because this close invalidated it.
      await pending.catch(() => undefined);
    }
  }

  /** Close the current lifecycle (if any) and open a fresh one. */
  async reopen(): Promise<AppDatabaseConnection> {
    await this.close();
    return this.open();
  }

  /** Inspect the OPEN database's health without changing anything. */
  async validate(): Promise<DatabaseHealth> {
    const current = this.current;
    if (!current) {
      throw new DatabaseBootstrapError({
        code: 'closed',
        message: `The application database "${this.databaseName}" is not open.`,
        context: { databaseName: this.databaseName },
      });
    }
    try {
      return await validateDatabaseIntegrity(current.connection.adapter, this.now);
    } catch (cause) {
      throw toDatabaseBootstrapError(
        cause,
        'unavailable',
        `The application database "${this.databaseName}" could not be inspected.`,
        { databaseName: this.databaseName, lifecycleId: current.connection.lifecycleId },
      );
    }
  }

  /**
   * DESTRUCTIVE local-data reset — the explicit recovery primitive.
   *
   * Deletes every learner-data row on the OPEN canonical database in ONE
   * transaction (schema and migrations are preserved). It is NEVER called
   * automatically: not by initialization, not on failure, not by recovery.
   * Only a future higher-level service/UI flow may call it, after telling the
   * learner what will be lost.
   *
   * Refuses when the database is not open: a failed or closed lifecycle can
   * therefore never delete anything as a side effect.
   */
  async resetLocalData(request: DatabaseResetRequest): Promise<void> {
    if (request?.confirm !== 'delete-all-local-data') {
      throw new DatabaseBootstrapError({
        code: 'unavailable',
        message:
          'Local data reset refused: explicit confirmation ("delete-all-local-data") is required.',
        userMessage: 'Nothing was deleted.',
        context: { databaseName: this.databaseName },
      });
    }

    const current = this.current;
    if (!current) {
      throw new DatabaseBootstrapError({
        code: 'closed',
        message: `Local data reset refused: the application database "${this.databaseName}" is not open.`,
        userMessage: 'Nothing was deleted.',
        context: { databaseName: this.databaseName },
      });
    }
    current.connection.assertOpen();

    try {
      await current.connection.adapter.transaction(
        LOCAL_DATA_TABLES_CHILD_FIRST.map((table) => ({
          sql: `DELETE FROM ${table}`,
        })),
      );
    } catch (cause) {
      throw toDatabaseBootstrapError(
        cause,
        'unavailable',
        `The local data of "${this.databaseName}" could not be reset.`,
        {
          databaseName: this.databaseName,
          lifecycleId: current.connection.lifecycleId,
        },
      );
    }
  }
}

/**
 * PRODUCTION adapter factory. The platform adapter is imported lazily so every
 * module that composes against the canonical owner stays loadable in tests and
 * embedding environments.
 */
async function createDefaultExpoAdapter(options: {
  readonly databaseName: string;
}): Promise<DatabaseAdapter> {
  const { ExpoSqliteAdapter } = await import('./ExpoSqliteAdapter');
  return new ExpoSqliteAdapter({ databaseName: options.databaseName });
}

/* ------------------------------------------------------------------ *
 * Canonical application owner (one per process)
 * ------------------------------------------------------------------ */

let canonicalOwner: AppDatabaseOwner | null = null;

/**
 * The canonical owner for the application database. Created lazily with the
 * production adapter factory; replaceable only through `setAppDatabaseOwner`.
 */
export function getAppDatabaseOwner(): AppDatabaseOwner {
  if (!canonicalOwner) {
    canonicalOwner = new AppDatabaseOwner({
      databaseName: APP_DATABASE_NAME,
      createAdapter: createDefaultExpoAdapter,
    });
  }
  return canonicalOwner;
}

/**
 * The shared application database for every production feature composition.
 * Precedence for features is: explicitly injected adapter/repositories FIRST,
 * then this canonical owner. Concurrent callers share one initialization.
 */
export function getAppDatabase(): Promise<AppDatabaseConnection> {
  return getAppDatabaseOwner().open();
}

/** Inspect the canonical database's health (read-only). */
export function validateAppDatabase(): Promise<DatabaseHealth> {
  return getAppDatabaseOwner().validate();
}

/** Terminal close of the canonical database lifecycle (idempotent). */
export function closeAppDatabase(): Promise<void> {
  return getAppDatabaseOwner().close();
}

/** Explicitly start a NEW canonical lifecycle (close + open). */
export function reopenAppDatabase(): Promise<AppDatabaseConnection> {
  return getAppDatabaseOwner().reopen();
}

/**
 * DESTRUCTIVE: delete all local learner data on the canonical database.
 * Never called automatically — see `AppDatabaseOwner.resetLocalData`.
 */
export function resetAppDatabaseLocalData(
  request: DatabaseResetRequest,
): Promise<void> {
  return getAppDatabaseOwner().resetLocalData(request);
}

/**
 * TESTS / EMBEDDING ONLY: replace the canonical owner (e.g. with an owner whose
 * adapter factory returns an isolated in-memory adapter). Passing null restores
 * the lazily created production owner.
 */
export function setAppDatabaseOwner(owner: AppDatabaseOwner | null): void {
  canonicalOwner = owner;
}

/** TESTS ONLY: restore the lazily created production owner. */
export function resetAppDatabaseOwnerForTests(): void {
  canonicalOwner = null;
}

/**
 * Build an owner on any adapter factory — the injection seam used by tests and
 * by embedding scenarios that must not depend on the Expo SQLite adapter.
 */
export function createAppDatabaseOwner(
  options: AppDatabaseOwnerOptions,
): AppDatabaseOwner {
  return new AppDatabaseOwner(options);
}
