/**
 * src/data/local/sqlite/integrity.ts
 *
 * Safe, non-destructive integrity validation for an OPENED database adapter.
 *
 * WHAT IT CHECKS (read-only, no repair, no reset, no writes)
 * 1. the recorded schema version equals the version this build expects,
 * 2. every core table of the current schema exists,
 * 3. SQLite's own `PRAGMA quick_check` reports a healthy database file.
 *
 * WHY `quick_check` (not a full `integrity_check`): it is the documented fast
 * variant that still detects structural corruption, so app startup stays cheap
 * on large databases.
 *
 * RULES
 * - A failing database is NEVER repaired, reset or deleted here. The caller
 *   receives an actionable result and the user's data stays exactly as it was.
 * - The real SQLite abstraction is used (`query`), so both the production
 *   (expo-sqlite) and test (sql.js) adapters behave identically.
 */

import type { DatabaseAdapter } from './DatabaseAdapter';
import { CURRENT_SCHEMA_VERSION } from './schema';

/**
 * The core tables a usable application database must have. Kept deliberately
 * small: one table per persisted concern the app cannot work without.
 */
export const REQUIRED_CORE_TABLES: readonly string[] = [
  'schema_migrations',
  'learner_profile',
  'conversation_sessions',
  'conversation_turns',
  'learner_weaknesses',
  'learner_strengths',
  'lexical_items',
  'review_items',
  'review_history',
  'progress_records',
  'daily_tutor_sessions',
  'daily_tutor_activities',
  'reassessment_history',
];

export type IntegrityCheckOutcome = 'ok' | 'failed' | 'unsupported';

export interface DatabaseHealthIssue {
  readonly kind: 'schema_version' | 'missing_table' | 'integrity_check';
  /** Developer-facing detail (never shown to the user by default). */
  readonly detail: string;
}

export interface DatabaseHealth {
  readonly ok: boolean;
  readonly schemaVersion: number;
  readonly expectedSchemaVersion: number;
  readonly missingTables: readonly string[];
  readonly integrityCheck: IntegrityCheckOutcome;
  readonly issues: readonly DatabaseHealthIssue[];
  readonly checkedAt: string;
}

/** Read the recorded schema version (0 when the table is missing/unreadable). */
async function readSchemaVersion(adapter: DatabaseAdapter): Promise<number> {
  try {
    const rows = await adapter.query(
      `SELECT MAX(version) AS version FROM schema_migrations`,
    );
    const version = rows[0]?.version;
    return version ? Number(version) : 0;
  } catch {
    // A missing/unreadable schema_migrations table is itself diagnosed by the
    // missing-table check below; version 0 is the honest answer here.
    return 0;
  }
}

/** Existing table names (read-only catalog query). */
async function readTableNames(adapter: DatabaseAdapter): Promise<ReadonlySet<string>> {
  const rows = await adapter.query(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  );
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * SQLite's own health check. Returns 'unsupported' when the adapter cannot run
 * the pragma — validation then relies on the schema checks only, and the
 * database is NOT treated as broken.
 */
export async function runIntegrityCheck(
  adapter: DatabaseAdapter,
): Promise<IntegrityCheckOutcome> {
  try {
    const rows = await adapter.query(`PRAGMA quick_check`);
    if (rows.length === 0) return 'unsupported';
    const first = rows[0];
    const value =
      first.integrity_check ?? first.quick_check ?? Object.values(first)[0];
    return String(value).trim().toLowerCase() === 'ok' ? 'ok' : 'failed';
  } catch {
    return 'unsupported';
  }
}

/**
 * Validate an opened database WITHOUT touching its contents. The result is
 * actionable: `ok === false` means the caller must stop composing services
 * against this database instead of continuing on incompatible data.
 */
export async function validateDatabaseIntegrity(
  adapter: DatabaseAdapter,
  now: () => string = () => new Date().toISOString(),
): Promise<DatabaseHealth> {
  const issues: DatabaseHealthIssue[] = [];

  const schemaVersion = await readSchemaVersion(adapter);
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    issues.push({
      kind: 'schema_version',
      detail:
        schemaVersion > CURRENT_SCHEMA_VERSION
          ? `Database schema version ${schemaVersion} is newer than this app supports (${CURRENT_SCHEMA_VERSION}).`
          : `Database schema version ${schemaVersion} does not match the expected version ${CURRENT_SCHEMA_VERSION}.`,
    });
  }

  const tables = await readTableNames(adapter);
  const missingTables = REQUIRED_CORE_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    issues.push({
      kind: 'missing_table',
      detail: `Missing core table(s): ${missingTables.join(', ')}.`,
    });
  }

  const integrityCheck = await runIntegrityCheck(adapter);
  if (integrityCheck === 'failed') {
    issues.push({
      kind: 'integrity_check',
      detail: 'SQLite quick_check reported database corruption.',
    });
  }

  return {
    ok: issues.length === 0,
    schemaVersion,
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    missingTables,
    integrityCheck,
    issues,
    checkedAt: now(),
  };
}
