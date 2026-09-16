/**
 * src/data/local/sqlite/schema.test.ts
 *
 * Focused sql.js migration/schema test.
 * - fresh DB creates required tables
 * - version 1 recorded
 * - second migration run changes nothing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqlJsAdapter } from './SqlJsAdapter';
import { runMigrations, getSchemaVersion, CURRENT_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from './schema';

describe('SQLite schema migrations (sql.js)', () => {
  let adapter: SqlJsAdapter;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
  });

  async function createLearner(id: string = 'learner-1'): Promise<void> {
    await adapter.execute(
      `INSERT INTO learner_profile (id, display_name, target_language, target_level, current_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, 'Test', 'en', 'B1', 'A2', new Date().toISOString(), new Date().toISOString()]
    );
  }

  it('creates all required tables on fresh DB', async () => {
    const tables = await adapter.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    const tableNames = tables.map((t) => t.name as string);

    // Core tables
    expect(tableNames).toContain('schema_migrations');
    expect(tableNames).toContain('learner_profile');
    expect(tableNames).toContain('conversation_sessions');
    expect(tableNames).toContain('conversation_turns');
    expect(tableNames).toContain('grammar_mistakes');
    expect(tableNames).toContain('pronunciation_weaknesses');
    expect(tableNames).toContain('learner_weaknesses');
    expect(tableNames).toContain('weakness_evidence');
    expect(tableNames).toContain('learner_strengths');
    expect(tableNames).toContain('lexical_items');
    expect(tableNames).toContain('lexical_meanings');
    expect(tableNames).toContain('lexical_examples');
    expect(tableNames).toContain('review_items');
    expect(tableNames).toContain('review_history');
    expect(tableNames).toContain('progress_records');
  });

  it('records schema version 1 in schema_migrations', async () => {
    const rows = await adapter.query(`SELECT version, description FROM schema_migrations ORDER BY version`);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(1);
    expect(rows[0].description).toBe(SCHEMA_MIGRATIONS[0].description);
  });

  it('reports current schema version correctly', async () => {
    const version = await getSchemaVersion(adapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('second migration run changes nothing (idempotent)', async () => {
    // Run migrations again
    await runMigrations(adapter);

    // Version should still be 1
    const version = await getSchemaVersion(adapter);
    expect(version).toBe(1);

    // schema_migrations should still have only one row
    const rows = await adapter.query(`SELECT COUNT(*) as count FROM schema_migrations`);
    expect(rows[0].count).toBe(1);
  });

  it('enforces foreign keys (PRAGMA foreign_keys = ON)', async () => {
    // Try to insert a conversation_session with non-existent learner_id
    // This should fail with foreign key constraint
    await expect(
      adapter.execute(
        `INSERT INTO conversation_sessions (id, learner_id, mode, status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['session-1', 'non-existent-learner', 'natural', 'active', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
      )
    ).rejects.toThrow();
  });

  it('enforces UNIQUE constraint on conversation_turns(session_id, sequence_number)', async () => {
    // First create a learner and session
    await adapter.execute(
      `INSERT INTO learner_profile (id, display_name, target_language, target_level, current_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['learner-1', 'Test', 'en', 'B1', 'A2', new Date().toISOString(), new Date().toISOString()]
    );

    await adapter.execute(
      `INSERT INTO conversation_sessions (id, learner_id, mode, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['session-1', 'learner-1', 'natural', 'active', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
    );

    // Insert first turn with sequence_number 1
    await adapter.execute(
      `INSERT INTO conversation_turns (id, session_id, speaker, text, sequence_number, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['turn-1', 'session-1', 'learner', 'Hello', 1, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
    );

    // Insert second turn with same sequence_number should fail
    await expect(
      adapter.execute(
        `INSERT INTO conversation_turns (id, session_id, speaker, text, sequence_number, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['turn-2', 'session-1', 'tutor', 'Hi there', 1, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
      )
    ).rejects.toThrow();
  });

  it('lexical_items supports all required vocabulary types', async () => {
    await createLearner();
    const types = [
      'word',
      'phrase',
      'phrasal_verb',
      'idiom',
      'common_expression',
      'collocation',
      'linking_expression',
      'professional_expression',
    ];

    for (const type of types) {
      await adapter.execute(
        `INSERT INTO lexical_items (id, learner_id, headword, type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`item-${type}`, 'learner-1', `test-${type}`, type, new Date().toISOString(), new Date().toISOString()]
      );
    }

    const rows = await adapter.query(`SELECT type FROM lexical_items WHERE learner_id = ? ORDER BY type`, ['learner-1']);
    const insertedTypes = rows.map((r) => r.type as string).sort();
    expect(insertedTypes).toEqual(types.sort());
  });

  it('lexical_meanings stores mastery independently per meaning', async () => {
    await createLearner();
    // Create a lexical item
    await adapter.execute(
      `INSERT INTO lexical_items (id, learner_id, headword, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['item-1', 'learner-1', 'run', 'word', new Date().toISOString(), new Date().toISOString()]
    );

    // Insert two meanings with different review states
    await adapter.execute(
      `INSERT INTO lexical_meanings (id, lexical_item_id, definition, review_state, review_review_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['meaning-1', 'item-1', 'to move quickly on foot', 'mastered', 10, new Date().toISOString(), new Date().toISOString()]
    );

    await adapter.execute(
      `INSERT INTO lexical_meanings (id, lexical_item_id, definition, review_state, review_review_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['meaning-2', 'item-1', 'to operate a machine', 'learning', 2, new Date().toISOString(), new Date().toISOString()]
    );

    const rows = await adapter.query(`SELECT id, review_state, review_review_count FROM lexical_meanings WHERE lexical_item_id = ?`, ['item-1']);
    expect(rows).toHaveLength(2);
    const states = rows.map((r) => ({ id: r.id, state: r.review_state, count: r.review_review_count }));
    expect(states).toContainEqual({ id: 'meaning-1', state: 'mastered', count: 10 });
    expect(states).toContainEqual({ id: 'meaning-2', state: 'learning', count: 2 });
  });

  it('lexical_examples may reference a specific meaning and supports all sources', async () => {
    await createLearner();
    // Create a lexical item and meaning
    await adapter.execute(
      `INSERT INTO lexical_items (id, learner_id, headword, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['item-1', 'learner-1', 'test', 'word', new Date().toISOString(), new Date().toISOString()]
    );

    await adapter.execute(
      `INSERT INTO lexical_meanings (id, lexical_item_id, definition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['meaning-1', 'item-1', 'a test definition', new Date().toISOString(), new Date().toISOString()]
    );

    const sources = [
      'original_conversation',
      'ai_generated',
      'learner_created',
      'lesson',
      'manual',
    ];

    for (const source of sources) {
      await adapter.execute(
        `INSERT INTO lexical_examples (id, lexical_item_id, meaning_id, text, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`example-${source}`, 'item-1', 'meaning-1', `Example for ${source}`, source, new Date().toISOString()]
      );
    }

    // Also test example without meaning_id (NULL)
    await adapter.execute(
      `INSERT INTO lexical_examples (id, lexical_item_id, meaning_id, text, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['example-no-meaning', 'item-1', null, 'Example without meaning', 'manual', new Date().toISOString()]
    );

    const rows = await adapter.query(`SELECT source, meaning_id FROM lexical_examples WHERE lexical_item_id = ?`, ['item-1']);
    expect(rows).toHaveLength(sources.length + 1);
    const sourcesFound = rows.map((r) => r.source as string).sort();
    expect(sourcesFound).toEqual([...sources, 'manual'].sort());
  });

  it('learner_weakness lifecycle supports all required statuses', async () => {
    await createLearner();
    const statuses = [
      'observed',
      'repeated',
      'confirmed',
      'active_training',
      'improving',
      'stable',
      'mastered',
      'relapsed',
    ];

    for (const status of statuses) {
      await adapter.execute(
        `INSERT INTO learner_weaknesses (id, learner_id, type, reference_id, status, severity, last_seen_at, first_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`weakness-${status}`, 'learner-1', 'grammar', `ref-${status}`, status, 0.5, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
      );
    }

    const rows = await adapter.query(`SELECT status FROM learner_weaknesses WHERE learner_id = ? ORDER BY status`, ['learner-1']);
    const insertedStatuses = rows.map((r) => r.status as string).sort();
    expect(insertedStatuses).toEqual(statuses.sort());
  });

  it('weakness_evidence remains a separate relational table', async () => {
    await createLearner();
    // Create a weakness
    await adapter.execute(
      `INSERT INTO learner_weaknesses (id, learner_id, type, reference_id, status, severity, last_seen_at, first_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['weakness-1', 'learner-1', 'grammar', 'ref-1', 'confirmed', 0.7, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
    );

    // Add multiple evidence entries
    await adapter.execute(
      `INSERT INTO weakness_evidence (id, weakness_id, kind, ref_id, at, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['evidence-1', 'weakness-1', 'turn', 'turn-1', new Date().toISOString(), 'First occurrence']
    );

    await adapter.execute(
      `INSERT INTO weakness_evidence (id, weakness_id, kind, ref_id, at, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['evidence-2', 'weakness-1', 'turn', 'turn-2', new Date().toISOString(), 'Second occurrence']
    );

    const rows = await adapter.query(`SELECT * FROM weakness_evidence WHERE weakness_id = ?`, ['weakness-1']);
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('turn');
    expect(rows[1].kind).toBe('turn');
  });

  it('pronunciation_weaknesses does not contain fabricated scoring fields', async () => {
    const columns = await adapter.query(`PRAGMA table_info(pronunciation_weaknesses)`);
    const columnNames = columns.map((c) => c.name as string);

    // Should NOT have any scoring fields
    expect(columnNames).not.toContain('score');
    expect(columnNames).not.toContain('accuracy');
    expect(columnNames).not.toContain('pronunciation_score');
    expect(columnNames).not.toContain('confidence_score');

    // Should have the required fields
    expect(columnNames).toContain('target_sound');
    expect(columnNames).toContain('word_examples');
    expect(columnNames).toContain('occurrence_count');
    expect(columnNames).toContain('contexts');
  });

  it('useful indexes exist', async () => {
    const indexes = await adapter.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    const indexNames = indexes.map((i) => i.name as string);

    expect(indexNames).toContain('idx_conversation_turns_session_seq');
    expect(indexNames).toContain('idx_learner_weaknesses_learner_status');
    expect(indexNames).toContain('idx_grammar_mistakes_learner_category_status');
    expect(indexNames).toContain('idx_lexical_items_learner_term_type');
    expect(indexNames).toContain('idx_review_items_learner_due');
    expect(indexNames).toContain('idx_progress_records_learner_date');
  });
});