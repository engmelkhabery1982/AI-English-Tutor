/**
 * src/data/local/sqlite/DatabaseBootstrapError.ts
 *
 * Typed, recoverable database bootstrap error model.
 *
 * WHY THIS EXISTS
 * Opening the application database has distinct failure modes that callers
 * must be able to tell apart WITHOUT reading raw SQLite/engine messages:
 *
 * - `open_failed`      the database file/handle could not be opened,
 * - `migration_failed` the schema could not be brought to the current version,
 * - `integrity_failed` the database opened but failed validation (schema
 *                      version / core tables / SQLite integrity check),
 * - `closed`           the lifecycle is closed (or was closed) — reopen first,
 * - `unavailable`      the database could not be inspected/reset right now.
 *
 * RULES
 * - The original error is ALWAYS preserved as `cause` (never swallowed).
 * - `message` is developer-facing detail. `userMessage` is the safe,
 *   implementation-free text a UI may show by default — it never contains
 *   SQL, adapter names, file paths or platform messages.
 * - No silent data repair: these errors are reported, never acted on.
 */

/** Machine-readable bootstrap failure categories. */
export type DatabaseBootstrapErrorCode =
  | 'open_failed'
  | 'migration_failed'
  | 'integrity_failed'
  | 'closed'
  | 'unavailable';

/**
 * Safe user-facing text per category. Deliberately free of SQL, adapter and
 * platform details; it states what happened and that nothing was changed.
 */
const SAFE_USER_MESSAGES: Readonly<Record<DatabaseBootstrapErrorCode, string>> =
  {
    open_failed: 'Local storage could not be opened. Your saved progress is unchanged.',
    migration_failed:
      'Local storage could not be prepared. Your saved progress is unchanged.',
    integrity_failed:
      'Local storage does not match this app version. Your saved progress was not changed.',
    closed: 'Local storage is closed. It must be reopened before it can be used.',
    unavailable: 'Local storage is not available right now. Nothing was changed.',
  };

/** Extra developer context attached to a bootstrap error (never user-facing). */
export type DatabaseBootstrapErrorContext = Readonly<
  Record<string, string | number | boolean>
>;

export interface DatabaseBootstrapErrorOptions {
  readonly code: DatabaseBootstrapErrorCode;
  /** Developer-facing detail (defaults to the safe user message). */
  readonly message?: string;
  /** Override for the safe user-facing text (still implementation-free). */
  readonly userMessage?: string;
  /** The original error/value this failure came from — never discarded. */
  readonly cause?: unknown;
  /** Small non-sensitive diagnostic context (database name, lifecycle id, …). */
  readonly context?: DatabaseBootstrapErrorContext;
}

export class DatabaseBootstrapError extends Error {
  readonly code: DatabaseBootstrapErrorCode;
  /** Safe, implementation-free text a UI may show by default. */
  readonly userMessage: string;
  /** Diagnostic context for logs (never contains credentials or user content). */
  readonly context: DatabaseBootstrapErrorContext | undefined;
  /** The original failure, preserved for diagnostics. */
  readonly cause: unknown;

  constructor(options: DatabaseBootstrapErrorOptions) {
    const userMessage = options.userMessage ?? SAFE_USER_MESSAGES[options.code];
    super(options.message ?? userMessage);
    this.name = 'DatabaseBootstrapError';
    this.code = options.code;
    this.userMessage = userMessage;
    this.context = options.context;
    this.cause = options.cause;
  }

  /** True when this error belongs to the given category (or any, if omitted). */
  is(code?: DatabaseBootstrapErrorCode): boolean {
    return code === undefined || this.code === code;
  }
}

/** Narrow an unknown value to the typed bootstrap error. */
export function isDatabaseBootstrapError(
  value: unknown,
): value is DatabaseBootstrapError {
  return value instanceof DatabaseBootstrapError;
}

/**
 * Wrap an unknown failure as a DatabaseBootstrapError.
 *
 * An existing DatabaseBootstrapError is returned unchanged so a specific
 * category (e.g. `migration_failed`) is never re-labelled by an outer layer.
 * Everything else keeps its original value as `cause`.
 */
export function toDatabaseBootstrapError(
  error: unknown,
  code: DatabaseBootstrapErrorCode,
  message: string,
  context?: DatabaseBootstrapErrorContext,
): DatabaseBootstrapError {
  if (error instanceof DatabaseBootstrapError) {
    return error;
  }
  return new DatabaseBootstrapError({ code, message, cause: error, context });
}

/** The cause, as an Error when possible (for internal diagnostics/logging). */
export function bootstrapErrorCause(error: unknown): Error | undefined {
  if (error instanceof DatabaseBootstrapError) {
    return error.cause instanceof Error ? error.cause : undefined;
  }
  return error instanceof Error ? error : undefined;
}
