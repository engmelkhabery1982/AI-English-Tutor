/**
 * src/data/local/sqlite/schema.ts
 *
 * SQLite schema definition and migration runner.
 *
 * The schema is versioned. Each migration is a list of SQL steps
 * that run inside a single transaction. The runner is idempotent:
 * it only applies migrations whose version is greater than the
 * current database version, and it records applied versions in
 * the schema_migrations table.
 *
 * All DDL lives here. No screen, service, or engine may execute
 * raw SQL directly — they go through repositories, which go
 * through the DatabaseAdapter.
 */

/** Current schema version. Bump this when adding a migration. */
export const CURRENT_SCHEMA_VERSION = 1;

/** A single SQL step inside a migration. */
export interface SchemaStep {
  readonly sql: string;
}

/** A versioned migration. */
export interface SchemaMigration {
  readonly version: number;
  readonly description: string;
  readonly steps: readonly SchemaStep[];
}

const SCHEMA_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`.trim();

/** All migrations, in order. */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: 'Initial schema: profile, conversation, vocabulary, learning, review, progress',
    steps: [
      { sql: SCHEMA_MIGRATIONS_TABLE_SQL },
    ],
  },
];
