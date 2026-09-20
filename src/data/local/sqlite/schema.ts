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
export const CURRENT_SCHEMA_VERSION = 7;

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
      { sql: `PRAGMA foreign_keys = ON` },
      // learner_profile
      { sql: `CREATE TABLE IF NOT EXISTS learner_profile (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        native_language TEXT,
        target_language TEXT NOT NULL,
        target_level TEXT NOT NULL,
        current_level TEXT NOT NULL,
        learning_goals TEXT NOT NULL DEFAULT '[]',
        preferred_modes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )` },
      // conversation_sessions
      { sql: `CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        title TEXT,
        topic TEXT,
        topic_source TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_seconds INTEGER,
        difficulty TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // conversation_turns
      { sql: `CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        audio_ref TEXT,
        detected_language TEXT,
        sequence_number INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        confidence REAL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES conversation_sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, sequence_number)
      )` },
      // grammar_mistakes
      { sql: `CREATE TABLE IF NOT EXISTS grammar_mistakes (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        category TEXT NOT NULL,
        pattern TEXT NOT NULL,
        correction TEXT NOT NULL,
        explanation TEXT,
        severity TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        contexts TEXT NOT NULL DEFAULT '[]',
        example_turn_ids TEXT NOT NULL DEFAULT '[]',
        origin_session_id TEXT,
        origin_turn_id TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // pronunciation_weaknesses
      { sql: `CREATE TABLE IF NOT EXISTS pronunciation_weaknesses (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        target_sound TEXT NOT NULL,
        word_examples TEXT NOT NULL DEFAULT '[]',
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        contexts TEXT NOT NULL DEFAULT '[]',
        example_turn_ids TEXT NOT NULL DEFAULT '[]',
        origin_session_id TEXT,
        origin_turn_id TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // learner_weaknesses
      { sql: `CREATE TABLE IF NOT EXISTS learner_weaknesses (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        status TEXT NOT NULL,
        severity REAL NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        contexts TEXT NOT NULL DEFAULT '[]',
        evidence TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // weakness_evidence
      { sql: `CREATE TABLE IF NOT EXISTS weakness_evidence (
        id TEXT PRIMARY KEY,
        weakness_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        at TEXT NOT NULL,
        summary TEXT,
        FOREIGN KEY (weakness_id) REFERENCES learner_weaknesses(id) ON DELETE CASCADE
      )` },
      // learner_strengths
      { sql: `CREATE TABLE IF NOT EXISTS learner_strengths (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        last_seen_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        contexts TEXT NOT NULL DEFAULT '[]',
        evidence TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // lexical_items
      { sql: `CREATE TABLE IF NOT EXISTS lexical_items (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        headword TEXT NOT NULL,
        type TEXT NOT NULL,
        pronunciation TEXT NOT NULL DEFAULT '{}',
        synonyms TEXT NOT NULL DEFAULT '[]',
        antonyms TEXT NOT NULL DEFAULT '[]',
        related_expressions TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // lexical_meanings
      { sql: `CREATE TABLE IF NOT EXISTS lexical_meanings (
        id TEXT PRIMARY KEY,
        lexical_item_id TEXT NOT NULL,
        definition TEXT NOT NULL,
        part_of_speech TEXT,
        examples TEXT NOT NULL DEFAULT '[]',
        usage_notes TEXT NOT NULL DEFAULT '[]',
        register TEXT,
        domain TEXT,
        review_state TEXT NOT NULL DEFAULT 'new',
        review_last_review_at TEXT,
        review_next_review_at TEXT,
        review_review_count INTEGER NOT NULL DEFAULT 0,
        review_consecutive_correct INTEGER NOT NULL DEFAULT 0,
        review_ease_factor REAL,
        review_mastered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (lexical_item_id) REFERENCES lexical_items(id) ON DELETE CASCADE
      )` },
      // lexical_examples
      { sql: `CREATE TABLE IF NOT EXISTS lexical_examples (
        id TEXT PRIMARY KEY,
        lexical_item_id TEXT NOT NULL,
        meaning_id TEXT,
        text TEXT NOT NULL,
        translation TEXT,
        context TEXT,
        source TEXT NOT NULL,
        origin_conversation_id TEXT,
        origin_turn_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (lexical_item_id) REFERENCES lexical_items(id) ON DELETE CASCADE,
        FOREIGN KEY (meaning_id) REFERENCES lexical_meanings(id) ON DELETE SET NULL
      )` },
      // review_items
      { sql: `CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        expected_response TEXT,
        context_topic TEXT,
        state TEXT NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_review_at TEXT,
        review_count INTEGER NOT NULL DEFAULT 0,
        consecutive_correct INTEGER NOT NULL DEFAULT 0,
        ease_factor REAL,
        outcome_history TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // review_history
      { sql: `CREATE TABLE IF NOT EXISTS review_history (
        id TEXT PRIMARY KEY,
        review_item_id TEXT NOT NULL,
        at TEXT NOT NULL,
        result TEXT NOT NULL,
        latency_ms INTEGER,
        note TEXT,
        FOREIGN KEY (review_item_id) REFERENCES review_items(id) ON DELETE CASCADE
      )` },
      // progress_records
      { sql: `CREATE TABLE IF NOT EXISTS progress_records (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        sessions_completed INTEGER NOT NULL DEFAULT 0,
        turns_completed INTEGER NOT NULL DEFAULT 0,
        listening_score REAL,
        speaking_score REAL,
        fluency_score REAL,
        confidence_score REAL,
        pronunciation_score REAL,
        grammar_score REAL,
        vocabulary_score REAL,
        new_words_learned INTEGER NOT NULL DEFAULT 0,
        weaknesses_improved INTEGER NOT NULL DEFAULT 0,
        weaknesses_worsened INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      // Indexes
      { sql: `CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_seq ON conversation_turns(session_id, sequence_number)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_learner_weaknesses_learner_status ON learner_weaknesses(learner_id, status)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_grammar_mistakes_learner_category_status ON grammar_mistakes(learner_id, category, resolved)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_lexical_items_learner_term_type ON lexical_items(learner_id, headword, type)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_review_items_learner_due ON review_items(learner_id, due_at)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_progress_records_learner_date ON progress_records(learner_id, recorded_at)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_lexical_meanings_item ON lexical_meanings(lexical_item_id)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_lexical_examples_item ON lexical_examples(lexical_item_id)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_lexical_examples_meaning ON lexical_examples(meaning_id)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_review_history_item ON review_history(review_item_id)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_weakness_evidence_weakness ON weakness_evidence(weakness_id)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_conversation_sessions_learner_started ON conversation_sessions(learner_id, started_at)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_grammar_mistakes_learner_last_seen ON grammar_mistakes(learner_id, last_seen_at)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_pronunciation_weaknesses_learner_last_seen ON pronunciation_weaknesses(learner_id, last_seen_at)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_learner_strengths_learner_type ON learner_strengths(learner_id, type)` },
    ],
  },
  {
    version: 2,
    description: 'Add expression metadata to lexical_items',
    steps: [
      { sql: `ALTER TABLE lexical_items ADD COLUMN natural_alternatives TEXT NOT NULL DEFAULT '[]'` },
      { sql: `ALTER TABLE lexical_items ADD COLUMN register TEXT` },
      { sql: `ALTER TABLE lexical_items ADD COLUMN domain TEXT` },
    ],
  },
  {
    version: 3,
    description: 'Add evidence_log to pronunciation_weaknesses (evidence source + confidence)',
    steps: [
      { sql: `ALTER TABLE pronunciation_weaknesses ADD COLUMN evidence_log TEXT NOT NULL DEFAULT '[]'` },
    ],
  },
  {
    version: 4,
    description: 'Additive Daily Tutor storage: daily_tutor_sessions + daily_tutor_activities',
    steps: [
      // daily_tutor_sessions — ONE row per (learner, local date). The UNIQUE
      // constraint is the durable "never duplicate a daily session" invariant.
      { sql: `CREATE TABLE IF NOT EXISTS daily_tutor_sessions (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        date_key TEXT NOT NULL,
        status TEXT NOT NULL,
        headline TEXT NOT NULL,
        source_mode TEXT NOT NULL,
        estimated_minutes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE,
        UNIQUE(learner_id, date_key)
      )` },
      // daily_tutor_activities — ordered activities of one daily session.
      { sql: `CREATE TABLE IF NOT EXISTS daily_tutor_activities (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        estimated_minutes INTEGER NOT NULL DEFAULT 0,
        target TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        practiced_items INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES daily_tutor_sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, order_index)
      )` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_daily_tutor_sessions_learner_date ON daily_tutor_sessions(learner_id, date_key)` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_daily_tutor_activities_session ON daily_tutor_activities(session_id, order_index)` },
    ],
  },
  {
    version: 5,
    description: 'Additive WP-4 storage: reassessment_history',
    steps: [
      { sql: `CREATE TABLE IF NOT EXISTS reassessment_history (
        id TEXT PRIMARY KEY,
        learner_id TEXT NOT NULL,
        assessment_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        proposed_level TEXT NOT NULL,
        previous_level TEXT NOT NULL,
        confidence TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending',
        accepted_level TEXT,
        basis TEXT NOT NULL DEFAULT '[]',
        qualitative_summary TEXT NOT NULL DEFAULT '{}',
        generated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (learner_id) REFERENCES learner_profile(id) ON DELETE CASCADE
      )` },
      { sql: `CREATE INDEX IF NOT EXISTS idx_reassessment_history_learner ON reassessment_history(learner_id, created_at)` },
    ],
  },
  {
    version: 6,
    description: 'Harden logical uniqueness + profile singleton + dedup existing data',
    steps: [
      // ---- learner_profile singleton deduplication ----
      // If multiple profiles exist, keep the most recently updated one and
      // repoint all FK tables to it before deleting the others. This preserves
      // user data and keeps foreign keys valid.
      { sql: `UPDATE conversation_sessions SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE grammar_mistakes SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE pronunciation_weaknesses SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE learner_weaknesses SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE learner_strengths SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE lexical_items SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE review_items SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE progress_records SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE daily_tutor_sessions SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `UPDATE reassessment_history SET learner_id = (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) WHERE (SELECT COUNT(*) FROM learner_profile) > 1 AND learner_id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1)` },
      { sql: `DELETE FROM learner_profile WHERE id != (SELECT id FROM learner_profile ORDER BY updated_at DESC LIMIT 1) AND (SELECT COUNT(*) FROM learner_profile) > 1` },

      // Add singleton column to enforce single-profile invariant going forward.
      // The column is always 1, so UNIQUE(singleton) allows only one row.
      // This step is idempotent-safe via the runner's duplicate-column handling.
      { sql: `ALTER TABLE learner_profile ADD COLUMN singleton INTEGER NOT NULL DEFAULT 1 CHECK(singleton = 1)` },
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_learner_profile_singleton ON learner_profile(singleton)` },

      // ---- lexical_items deduplication ----
      // Build a map of old_id -> kept_id (most recent updated_at per logical identity)
      { sql: `DROP TABLE IF EXISTS _lexical_dedup_map` },
      { sql: `CREATE TABLE _lexical_dedup_map AS
        SELECT id AS old_id,
               FIRST_VALUE(id) OVER (PARTITION BY learner_id, headword, type ORDER BY updated_at DESC) AS kept_id
        FROM lexical_items` },
      // Move child rows to kept parent
      { sql: `UPDATE lexical_meanings SET lexical_item_id = (SELECT kept_id FROM _lexical_dedup_map WHERE old_id = lexical_meanings.lexical_item_id) WHERE lexical_item_id IN (SELECT old_id FROM _lexical_dedup_map WHERE old_id != kept_id)` },
      { sql: `UPDATE lexical_examples SET lexical_item_id = (SELECT kept_id FROM _lexical_dedup_map WHERE old_id = lexical_examples.lexical_item_id) WHERE lexical_item_id IN (SELECT old_id FROM _lexical_dedup_map WHERE old_id != kept_id)` },
      // Delete duplicate lexical_items
      { sql: `DELETE FROM lexical_items WHERE id IN (SELECT old_id FROM _lexical_dedup_map WHERE old_id != kept_id)` },
      { sql: `DROP TABLE IF EXISTS _lexical_dedup_map` },
      // Unique index for logical identity
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_lexical_items_unique_learner_headword_type ON lexical_items(learner_id, headword, type)` },

      // ---- review_items deduplication ----
      { sql: `DROP TABLE IF EXISTS _review_dedup_map` },
      { sql: `CREATE TABLE _review_dedup_map AS
        SELECT id AS old_id,
               FIRST_VALUE(id) OVER (PARTITION BY learner_id, kind, reference_id ORDER BY COALESCE(last_review_at, created_at) DESC) AS kept_id
        FROM review_items` },
      { sql: `UPDATE review_history SET review_item_id = (SELECT kept_id FROM _review_dedup_map WHERE old_id = review_history.review_item_id) WHERE review_item_id IN (SELECT old_id FROM _review_dedup_map WHERE old_id != kept_id)` },
      { sql: `DELETE FROM review_items WHERE id IN (SELECT old_id FROM _review_dedup_map WHERE old_id != kept_id)` },
      { sql: `DROP TABLE IF EXISTS _review_dedup_map` },
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_unique_learner_kind_ref ON review_items(learner_id, kind, reference_id)` },

      // ---- learner_weaknesses deduplication ----
      { sql: `DROP TABLE IF EXISTS _weakness_dedup_map` },
      { sql: `CREATE TABLE _weakness_dedup_map AS
        SELECT id AS old_id,
               FIRST_VALUE(id) OVER (PARTITION BY learner_id, type, reference_id ORDER BY last_seen_at DESC) AS kept_id
        FROM learner_weaknesses` },
      { sql: `UPDATE weakness_evidence SET weakness_id = (SELECT kept_id FROM _weakness_dedup_map WHERE old_id = weakness_evidence.weakness_id) WHERE weakness_id IN (SELECT old_id FROM _weakness_dedup_map WHERE old_id != kept_id)` },
      { sql: `DELETE FROM learner_weaknesses WHERE id IN (SELECT old_id FROM _weakness_dedup_map WHERE old_id != kept_id)` },
      { sql: `DROP TABLE IF EXISTS _weakness_dedup_map` },
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_learner_weaknesses_unique_learner_type_ref ON learner_weaknesses(learner_id, type, reference_id)` },

      // ---- learner_strengths deduplication ----
      { sql: `DROP TABLE IF EXISTS _strength_dedup_map` },
      { sql: `CREATE TABLE _strength_dedup_map AS
        SELECT id AS old_id,
               FIRST_VALUE(id) OVER (PARTITION BY learner_id, type, reference_id ORDER BY last_seen_at DESC) AS kept_id
        FROM learner_strengths` },
      { sql: `DELETE FROM learner_strengths WHERE id IN (SELECT old_id FROM _strength_dedup_map WHERE old_id != kept_id)` },
      { sql: `DROP TABLE IF EXISTS _strength_dedup_map` },
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_learner_strengths_unique_learner_type_ref ON learner_strengths(learner_id, type, reference_id)` },

      // ---- pronunciation_weaknesses deduplication ----
      { sql: `DROP TABLE IF EXISTS _pronunciation_dedup_map` },
      { sql: `CREATE TABLE _pronunciation_dedup_map AS
        SELECT id AS old_id,
               FIRST_VALUE(id) OVER (PARTITION BY learner_id, target_sound ORDER BY last_seen_at DESC) AS kept_id
        FROM pronunciation_weaknesses` },
      { sql: `DELETE FROM pronunciation_weaknesses WHERE id IN (SELECT old_id FROM _pronunciation_dedup_map WHERE old_id != kept_id)` },
      { sql: `DROP TABLE IF EXISTS _pronunciation_dedup_map` },
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_pronunciation_weaknesses_unique_learner_target ON pronunciation_weaknesses(learner_id, target_sound)` },
    ],
  },
  {
    version: 7,
    description: 'Additive WP-2 learner-agency storage: persisted learner preferences on the profile',
    steps: [
      // Generic, additive preferences JSON for the ONE existing profile row.
      // Work Order 2 stores the correction-intensity preference here; the
      // manual-save marker for Save to Review rides inside the existing
      // lexical_items.source JSON (no second vocabulary/review store).
      { sql: `ALTER TABLE learner_profile ADD COLUMN preferences TEXT NOT NULL DEFAULT '{}'` },
    ],
  },
];

/**
 * Run all pending migrations against the given adapter.
 * Crash-safe: each migration's schema changes and its version record are
 * committed atomically in ONE transaction. If the process crashes after
 * the schema change but before version recording in an old runner, the new
 * runner detects duplicate-column / already-exists errors and still records
 * the version, allowing recovery without forever-failing reruns.
 */
export async function runMigrations(adapter: {
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  transaction(steps: readonly { sql: string; params?: readonly unknown[] }[]): Promise<readonly { rowsAffected: number; insertId?: number }[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<{ rowsAffected: number; insertId?: number }>;
}): Promise<void> {
  // Ensure schema_migrations table exists
  await adapter.execute(SCHEMA_MIGRATIONS_TABLE_SQL);
  await adapter.execute(`PRAGMA foreign_keys = ON`);

  // Get applied versions
  const rows = await adapter.query(`SELECT version FROM schema_migrations ORDER BY version`);
  const appliedVersions = new Set(rows.map((r) => Number(r.version)));

  // Apply pending migrations in order
  for (const migration of SCHEMA_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const now = new Date().toISOString();
    const versionInsert = {
      sql: `INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`,
      params: [migration.version, migration.description, now] as const,
    };

    const allSteps = [...migration.steps.map((s) => ({ sql: s.sql })), versionInsert];

    try {
      await adapter.transaction(allSteps);
    } catch (err) {
      const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

      // Check if this migration's version was already recorded by a concurrent writer
      // or by a previous partially-failed run that managed to record version.
      try {
        const check = await adapter.query(`SELECT version FROM schema_migrations WHERE version = ?`, [migration.version]);
        if (check.length > 0) {
          appliedVersions.add(migration.version);
          continue;
        }
      } catch {
        // ignore check errors
      }

      // For ADD COLUMN migrations that may have partially succeeded in a previous
      // crash (column exists but version not recorded), treat duplicate-column /
      // already-exists errors as recoverable: try to record version anyway.
      const isDuplicateColumn =
        message.includes('duplicate column') ||
        message.includes('already exists') ||
        message.includes('duplicate');

      if (isDuplicateColumn) {
        try {
          await adapter.execute(versionInsert.sql, versionInsert.params as unknown as readonly unknown[]);
          appliedVersions.add(migration.version);
          continue;
        } catch {
          // If version insert also fails due to duplicate version, it's already applied
          try {
            const check2 = await adapter.query(`SELECT version FROM schema_migrations WHERE version = ?`, [migration.version]);
            if (check2.length > 0) {
              appliedVersions.add(migration.version);
              continue;
            }
          } catch {
            // ignore
          }
        }
      }

      // Otherwise, rethrow original error – real migration failure
      throw err;
    }

    appliedVersions.add(migration.version);
  }
}

/**
 * Get the current schema version from the database.
 */
export async function getSchemaVersion(adapter: {
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}): Promise<number> {
  try {
    const rows = await adapter.query(`SELECT MAX(version) as version FROM schema_migrations`);
    const version = rows[0]?.version;
    return version ? Number(version) : 0;
  } catch {
    return 0;
  }
}
