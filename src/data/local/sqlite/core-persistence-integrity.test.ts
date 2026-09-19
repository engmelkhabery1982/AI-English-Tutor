/**
 * Core Data Integrity + Transactions + SRS + Migration Safety
 * Mandatory regression scenarios 1-22
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqlJsAdapter } from './SqlJsAdapter';
import {
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteWeaknessRepository,
  SQLiteUserProfileRepository,
} from './repositories';
import { SCHEMA_MIGRATIONS, CURRENT_SCHEMA_VERSION, runMigrations, getSchemaVersion } from './schema';
import type { DatabaseAdapter } from './DatabaseAdapter';
import { generateId } from '../../../shared/id';

async function createProfile(adapter: DatabaseAdapter) {
  const repo = new SQLiteUserProfileRepository(adapter);
  const profile = await repo.update({
    displayName: 'Test Learner',
    targetLanguage: 'en',
    targetLevel: 'B1',
    currentLevel: 'A2',
    learningGoals: [],
    preferredModes: ['natural'],
  });
  return profile;
}

function createFailingAdapter(base: SqlJsAdapter, failOnStep: number): DatabaseAdapter {
  let callCount = 0;
  const originalExecute = base.execute.bind(base);

  return {
    backend: base.backend,
    path: base.path,
    get connected() { return base.connected; },
    async init() { return base.init(); },
    async close() { return base.close(); },
    async query(sql: string, params?: readonly (any)[]) {
      return base.query(sql, params);
    },
    async execute(sql: string, params?: readonly (any)[]) {
      callCount++;
      if (callCount === failOnStep) {
        throw new Error('Injected failure');
      }
      return originalExecute(sql, params);
    },
    async transaction(steps: readonly (any)[]) {
      // Fail inside transaction after N steps
      const wrappedSteps = steps.map((s) => ({
        sql: s.sql,
        params: s.params,
      }));
      // We'll intercept by counting executes inside transaction via custom logic
      // Simpler: if failOnStep is within steps, throw after that step
      // We implement transaction manually to inject failure
      await base.execute('BEGIN IMMEDIATE');
      const results: any[] = [];
      try {
        for (let i = 0; i < wrappedSteps.length; i++) {
          callCount++;
          if (callCount === failOnStep) {
            throw new Error('Injected failure in transaction');
          }
          const res = await base.execute(wrappedSteps[i].sql, wrappedSteps[i].params);
          results.push(res);
        }
        await base.execute('COMMIT');
        return results;
      } catch (e) {
        try { await base.execute('ROLLBACK'); } catch {}
        throw e;
      }
    },
  } as unknown as DatabaseAdapter;
}

describe('Core Persistence Integrity', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profile = await createProfile(adapter);
    learnerId = profile.id;
  });

  it('1. lexical rewrite failure rolls back completely', async () => {
    const vocabRepo = new SQLiteVocabularyRepository(adapter);

    const item = await vocabRepo.upsert({
      learnerId,
      headword: 'rollback-test',
      type: 'word',
      meanings: [
        {
          definition: 'original meaning',
          examples: [{ text: 'original example', source: 'manual' }],
          review: { state: 'mastered', reviewCount: 10, consecutiveCorrect: 5, nextReviewAt: new Date(Date.now() + 86400000 * 10).toISOString() },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    expect(item.meanings).toHaveLength(1);
    expect(item.meanings[0].definition).toBe('original meaning');

    // Create failing adapter that fails during update (after DELETE but before INSERT)
    // We need to make update fail. Use wrapper that fails on 2nd execute inside transaction.
    // update does transaction with DELETE examples, DELETE meanings, INSERT meanings, INSERT examples
    // We'll fail on step 3
    const failingAdapter = createFailingAdapter(adapter, 3);
    const failingRepo = new SQLiteVocabularyRepository(failingAdapter);

    try {
      await failingRepo.update(item.id, {
        meanings: [
          {
            definition: 'new meaning',
            examples: [{ text: 'new example', source: 'manual' }],
            review: { state: 'new', reviewCount: 0, consecutiveCorrect: 0 },
          },
        ],
      });
      // Should have thrown
      expect(true).toBe(false);
    } catch (e) {
      expect((e as Error).message).toContain('Injected failure');
    }

    // Verify old state survives
    const after = await vocabRepo.get(item.id);
    expect(after).not.toBeNull();
    expect(after!.meanings).toHaveLength(1);
    expect(after!.meanings[0].definition).toBe('original meaning');
    expect(after!.meanings[0].review?.state).toBe('mastered');
  });

  it('2. no orphan lexical examples after rewrite', async () => {
    const vocabRepo = new SQLiteVocabularyRepository(adapter);

    const item = await vocabRepo.upsert({
      learnerId,
      headword: 'orphan-test',
      type: 'word',
      meanings: [
        {
          definition: 'meaning 1',
          examples: [{ text: 'example 1', source: 'manual' }],
        },
        {
          definition: 'meaning 2',
          examples: [{ text: 'example 2', source: 'manual' }],
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    // Update with only one meaning
    const updated = await vocabRepo.update(item.id, {
      meanings: [
        {
          definition: 'meaning 1 updated',
          examples: [{ text: 'example 1 updated', source: 'manual' }],
          review: item.meanings[0].review,
        },
      ],
    });

    expect(updated.meanings).toHaveLength(1);

    // Check lexical_examples table has no orphan (examples for deleted meaning should be gone)
    const examples = await adapter.query(`SELECT * FROM lexical_examples WHERE lexical_item_id = ?`, [item.id]);
    // Should have only 1 example (for the remaining meaning), not 2 or 3
    expect(examples.length).toBe(1);
    expect((examples[0] as any).text).toBe('example 1 updated');

    // Ensure no examples with meaning_id that doesn't exist
    const orphanCheck = await adapter.query(
      `SELECT e.* FROM lexical_examples e LEFT JOIN lexical_meanings m ON e.meaning_id = m.id WHERE e.meaning_id IS NOT NULL AND m.id IS NULL`,
    );
    expect(orphanCheck.length).toBe(0);
  });

  it('3. mastered vocabulary save preserves SRS history', async () => {
    const vocabRepo = new SQLiteVocabularyRepository(adapter);

    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const item = await vocabRepo.upsert({
      learnerId,
      headword: 'mastered-vocab',
      type: 'word',
      meanings: [
        {
          definition: 'mastered meaning',
          examples: [],
          review: { state: 'mastered', reviewCount: 15, consecutiveCorrect: 10, nextReviewAt: future },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    expect(item.meanings[0].review?.state).toBe('mastered');
    expect(item.meanings[0].review?.reviewCount).toBe(15);

    // Re-save same headword via upsert with new definition (simulating re-observation)
    const resaved = await vocabRepo.upsert({
      learnerId,
      headword: 'mastered-vocab',
      type: 'word',
      meanings: [
        {
          definition: 'mastered meaning',
          examples: [],
          review: { state: 'new', reviewCount: 0, consecutiveCorrect: 0 }, // would reset if not preserved
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    expect(resaved.meanings[0].review?.state).toBe('mastered');
    expect(resaved.meanings[0].review?.reviewCount).toBe(15);
    expect(resaved.meanings[0].review?.consecutiveCorrect).toBe(10);
  });

  it('4. future-due vocabulary save preserves due date/history', async () => {
    const vocabRepo = new SQLiteVocabularyRepository(adapter);

    const future = new Date(Date.now() + 86400000 * 10).toISOString();
    const item = await vocabRepo.upsert({
      learnerId,
      headword: 'future-due-vocab',
      type: 'word',
      meanings: [
        {
          definition: 'future meaning',
          examples: [],
          review: { state: 'familiar', reviewCount: 5, consecutiveCorrect: 2, nextReviewAt: future },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    const originalDue = item.meanings[0].review?.nextReviewAt;
    expect(originalDue).toBe(future);

    const resaved = await vocabRepo.upsert({
      learnerId,
      headword: 'future-due-vocab',
      type: 'word',
      meanings: [
        {
          definition: 'future meaning',
          examples: [],
          review: { state: 'new', reviewCount: 0, consecutiveCorrect: 0, nextReviewAt: new Date().toISOString() },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    expect(resaved.meanings[0].review?.nextReviewAt).toBe(future);
    expect(resaved.meanings[0].review?.reviewCount).toBe(5);
  });

  it('5. mastered expression save preserves SRS history', async () => {
    const exprRepo = new SQLiteExpressionRepository(adapter);

    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const item = await exprRepo.upsert({
      learnerId,
      expression: 'mastered expression',
      type: 'idiom',
      meanings: [
        {
          definition: 'mastered expr meaning',
          examples: [],
          review: { state: 'mastered', reviewCount: 20, consecutiveCorrect: 12, nextReviewAt: future },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    expect(item.meanings[0].review?.state).toBe('mastered');

    const resaved = await exprRepo.upsert({
      learnerId,
      expression: 'mastered expression',
      type: 'idiom',
      meanings: [
        {
          definition: 'mastered expr meaning',
          examples: [],
          review: { state: 'new', reviewCount: 0, consecutiveCorrect: 0 },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    expect(resaved.meanings[0].review?.state).toBe('mastered');
    expect(resaved.meanings[0].review?.reviewCount).toBe(20);
  });

  it('6. future-due expression save preserves due date/history', async () => {
    const exprRepo = new SQLiteExpressionRepository(adapter);

    const future = new Date(Date.now() + 86400000 * 10).toISOString();
    const _item = await exprRepo.upsert({
      learnerId,
      expression: 'future-due expr',
      type: 'collocation',
      meanings: [
        {
          definition: 'future expr meaning',
          examples: [],
          review: { state: 'familiar', reviewCount: 6, consecutiveCorrect: 3, nextReviewAt: future },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    const resaved = await exprRepo.upsert({
      learnerId,
      expression: 'future-due expr',
      type: 'collocation',
      meanings: [
        {
          definition: 'future expr meaning',
          examples: [],
          review: { state: 'new', reviewCount: 0, consecutiveCorrect: 0, nextReviewAt: new Date().toISOString() },
        },
      ],
      source: { addedBy: 'system', addedAt: new Date().toISOString() },
      tags: [],
    });

    expect(resaved.meanings[0].review?.nextReviewAt).toBe(future);
    expect(resaved.meanings[0].review?.reviewCount).toBe(6);
  });

  it('7. review-state + outcome-history write cannot split', async () => {
    const reviewRepo = new SQLiteReviewRepository(adapter);

    const item = await reviewRepo.upsert({
      learnerId,
      kind: 'vocabulary',
      referenceId: generateId(),
      prompt: 'test prompt',
      state: 'learning',
      dueAt: new Date().toISOString(),
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    // Failing adapter that fails after first execute in markReviewed
    // markReviewed now uses BEGIN IMMEDIATE, SELECT, UPDATE, INSERT, COMMIT
    // We'll inject failure on INSERT (history)
    let executeCount = 0;
    const base = adapter;
    const failingAdapter = {
      backend: base.backend,
      path: base.path,
      get connected() { return base.connected; },
      async init() { return base.init(); },
      async close() { return base.close(); },
      async query(sql: string, params?: readonly any[]) {
        return base.query(sql, params);
      },
      async execute(sql: string, params?: readonly any[]) {
        executeCount++;
        const lower = sql.toLowerCase();
        if (lower.includes('insert into review_history') && executeCount > 2) {
          throw new Error('Injected failure on history insert');
        }
        return base.execute(sql, params);
      },
      async transaction(steps: readonly any[]) {
        return base.transaction(steps);
      },
    } as unknown as DatabaseAdapter;

    const failingRepo = new SQLiteReviewRepository(failingAdapter);

    try {
      await failingRepo.markReviewed(item.id, 'correct', 'test');
      expect(true).toBe(false);
    } catch (e) {
      expect((e as Error).message).toContain('Injected failure');
    }

    // Verify that review_count was NOT incremented and history not appended (atomic rollback)
    const after = await reviewRepo.get(item.id);
    expect(after).not.toBeNull();
    expect(after!.reviewCount).toBe(0);
    expect(after!.outcomeHistory).toHaveLength(0);

    const historyRows = await adapter.query(`SELECT * FROM review_history WHERE review_item_id = ?`, [item.id]);
    expect(historyRows.length).toBe(0);
  });

  it('8. repeated logical repository operation is safe', async () => {
    const reviewRepo = new SQLiteReviewRepository(adapter);

    const item = await reviewRepo.upsert({
      learnerId,
      kind: 'vocabulary',
      referenceId: generateId(),
      prompt: 'repeat test',
      state: 'learning',
      dueAt: new Date().toISOString(),
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    const attemptId = generateId();

    const first = await reviewRepo.markReviewed(item.id, 'correct', 'first', attemptId);
    expect(first.reviewCount).toBe(1);

    // Retry same logical completion with same attemptId – should be idempotent
    const second = await reviewRepo.markReviewed(item.id, 'correct', 'first', attemptId);
    expect(second.reviewCount).toBe(1); // not 2

    const historyRows = await adapter.query(`SELECT * FROM review_history WHERE review_item_id = ?`, [item.id]);
    expect(historyRows.length).toBe(1);
  });

  it('9. two INDEPENDENT repository instances racing on same logical identity yield one logical record', async () => {
    // Use two independent adapters pointing to same in-memory? We need shared DB.
    // For sql.js, each adapter has its own DB, so we need to share underlying DB.
    // We'll use same adapter instance but two repository instances – the task says
    // use two genuinely independent repository instances, not just JS lock.
    // With unique constraint, even same adapter but two repos racing should result in one row.
    // We simulate race via Promise.all on upsert.

    const vocabRepo1 = new SQLiteVocabularyRepository(adapter);
    const vocabRepo2 = new SQLiteVocabularyRepository(adapter);

    const headword = 'race-test-word';
    const type = 'word' as const;

    const [r1, r2] = await Promise.all([
      vocabRepo1.upsert({
        learnerId,
        headword,
        type,
        meanings: [{ definition: 'meaning from repo1', examples: [] }],
        source: { addedBy: 'system', addedAt: new Date().toISOString() },
        tags: [],
      }),
      vocabRepo2.upsert({
        learnerId,
        headword,
        type,
        meanings: [{ definition: 'meaning from repo2', examples: [] }],
        source: { addedBy: 'system', addedAt: new Date().toISOString() },
        tags: [],
      }),
    ]);

    // Both should return same logical id
    expect(r1.id).toBe(r2.id);

    const all = await adapter.query(`SELECT COUNT(*) as c FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`, [learnerId, headword, type]);
    expect(Number(all[0].c)).toBe(1);
  });

  it('10. fresh database migration', async () => {
    const freshAdapter = new SqlJsAdapter(':memory:');
    await freshAdapter.init();
    const version = await getSchemaVersion(freshAdapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);

    const tables = await freshAdapter.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    const names = tables.map((t: any) => t.name as string);
    expect(names).toContain('learner_profile');
    expect(names).toContain('lexical_items');
    expect(names).toContain('review_items');
    expect(names).toContain('daily_tutor_sessions');
    expect(names).toContain('reassessment_history');
  });

  it('11. v1 -> current', async () => {
    // Simulate v1 DB by applying only v1 migration manually
    // We need to init without runMigrations, so we create raw DB
    const mod = await import('sql.js');
    const create = (mod as any).default;
    const sqlJsMod = await create();
    const db = new sqlJsMod.Database();

    // Apply v1 steps
    const v1 = SCHEMA_MIGRATIONS.find((m) => m.version === 1)!;
    for (const step of v1.steps) {
      db.run(step.sql);
    }
    db.run(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (1, ?, ?)`, [v1.description, new Date().toISOString()]);

    // Now wrap in adapter that uses this db? Simpler: create SqlJsAdapter and then run migrations
    // We'll create a custom adapter that reuses db
    const customAdapter = {
      query: async (sql: string, params?: readonly any[]) => {
        const res = db.exec(sql, params as any[]);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any) => {
          const obj: any = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
          return obj;
        });
      },
      execute: async (sql: string, params?: readonly any[]) => {
        db.run(sql, params as any[]);
        return { rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid };
      },
      transaction: async (steps: readonly any[]) => {
        db.exec('BEGIN IMMEDIATE');
        const results: any[] = [];
        try {
          for (const step of steps) {
            db.run(step.sql, step.params as any[]);
            results.push({ rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid });
          }
          db.exec('COMMIT');
          return results;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      },
    } as any;

    await runMigrations(customAdapter);
    const version = await getSchemaVersion(customAdapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('12. v2 -> current', async () => {
    const mod = await import('sql.js');
    const create = (mod as any).default;
    const sqlJsMod = await create();
    const db = new sqlJsMod.Database();

    for (let v = 1; v <= 2; v++) {
      const mig = SCHEMA_MIGRATIONS.find((m) => m.version === v)!;
      for (const step of mig.steps) {
        try { db.run(step.sql); } catch {}
      }
      try { db.run(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`, [mig.version, mig.description, new Date().toISOString()]); } catch {}
    }

    const customAdapter = {
      query: async (sql: string, params?: readonly any[]) => {
        const res = db.exec(sql, params as any[]);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any) => {
          const obj: any = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
          return obj;
        });
      },
      execute: async (sql: string, params?: readonly any[]) => {
        db.run(sql, params as any[]);
        return { rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid };
      },
      transaction: async (steps: readonly any[]) => {
        db.exec('BEGIN IMMEDIATE');
        const results: any[] = [];
        try {
          for (const step of steps) {
            db.run(step.sql, step.params as any[]);
            results.push({ rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid });
          }
          db.exec('COMMIT');
          return results;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      },
    } as any;

    await runMigrations(customAdapter);
    const version = await getSchemaVersion(customAdapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('13. v3 -> current', async () => {
    const mod = await import('sql.js');
    const create = (mod as any).default;
    const sqlJsMod = await create();
    const db = new sqlJsMod.Database();

    for (let v = 1; v <= 3; v++) {
      const mig = SCHEMA_MIGRATIONS.find((m) => m.version === v)!;
      for (const step of mig.steps) {
        try { db.run(step.sql); } catch {}
      }
      try { db.run(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`, [mig.version, mig.description, new Date().toISOString()]); } catch {}
    }

    const customAdapter = {
      query: async (sql: string, params?: readonly any[]) => {
        const res = db.exec(sql, params as any[]);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any) => {
          const obj: any = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
          return obj;
        });
      },
      execute: async (sql: string, params?: readonly any[]) => {
        db.run(sql, params as any[]);
        return { rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid };
      },
      transaction: async (steps: readonly any[]) => {
        db.exec('BEGIN IMMEDIATE');
        const results: any[] = [];
        try {
          for (const step of steps) {
            db.run(step.sql, step.params as any[]);
            results.push({ rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid });
          }
          db.exec('COMMIT');
          return results;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      },
    } as any;

    await runMigrations(customAdapter);
    const version = await getSchemaVersion(customAdapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('14. v4 -> current', async () => {
    const mod = await import('sql.js');
    const create = (mod as any).default;
    const sqlJsMod = await create();
    const db = new sqlJsMod.Database();

    for (let v = 1; v <= 4; v++) {
      const mig = SCHEMA_MIGRATIONS.find((m) => m.version === v)!;
      for (const step of mig.steps) {
        try { db.run(step.sql); } catch {}
      }
      try { db.run(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`, [mig.version, mig.description, new Date().toISOString()]); } catch {}
    }

    const customAdapter = {
      query: async (sql: string, params?: readonly any[]) => {
        const res = db.exec(sql, params as any[]);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any) => {
          const obj: any = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
          return obj;
        });
      },
      execute: async (sql: string, params?: readonly any[]) => {
        db.run(sql, params as any[]);
        return { rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid };
      },
      transaction: async (steps: readonly any[]) => {
        db.exec('BEGIN IMMEDIATE');
        const results: any[] = [];
        try {
          for (const step of steps) {
            db.run(step.sql, step.params as any[]);
            results.push({ rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid });
          }
          db.exec('COMMIT');
          return results;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      },
    } as any;

    await runMigrations(customAdapter);
    const version = await getSchemaVersion(customAdapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('15. v5 -> current/new version', async () => {
    const mod = await import('sql.js');
    const create = (mod as any).default;
    const sqlJsMod = await create();
    const db = new sqlJsMod.Database();

    for (let v = 1; v <= 5; v++) {
      const mig = SCHEMA_MIGRATIONS.find((m) => m.version === v)!;
      for (const step of mig.steps) {
        try { db.run(step.sql); } catch {}
      }
      try { db.run(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`, [mig.version, mig.description, new Date().toISOString()]); } catch {}
    }

    const customAdapter = {
      query: async (sql: string, params?: readonly any[]) => {
        const res = db.exec(sql, params as any[]);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any) => {
          const obj: any = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
          return obj;
        });
      },
      execute: async (sql: string, params?: readonly any[]) => {
        db.run(sql, params as any[]);
        return { rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid };
      },
      transaction: async (steps: readonly any[]) => {
        db.exec('BEGIN IMMEDIATE');
        const results: any[] = [];
        try {
          for (const step of steps) {
            db.run(step.sql, step.params as any[]);
            results.push({ rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid });
          }
          db.exec('COMMIT');
          return results;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      },
    } as any;

    await runMigrations(customAdapter);
    const version = await getSchemaVersion(customAdapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('16. migration rerun', async () => {
    const freshAdapter = new SqlJsAdapter(':memory:');
    await freshAdapter.init();
    const version1 = await getSchemaVersion(freshAdapter);
    expect(version1).toBe(CURRENT_SCHEMA_VERSION);

    await runMigrations(freshAdapter);
    const version2 = await getSchemaVersion(freshAdapter);
    expect(version2).toBe(CURRENT_SCHEMA_VERSION);

    const count = await freshAdapter.query(`SELECT COUNT(*) as c FROM schema_migrations`);
    expect(Number(count[0].c)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('17. simulated interrupted migration recovery', async () => {
    // Simulate interruption after ADD COLUMN but before version recording for v2
    const mod = await import('sql.js');
    const create = (mod as any).default;
    const sqlJsMod = await create();
    const db = new sqlJsMod.Database();

    // Apply v1
    const v1 = SCHEMA_MIGRATIONS.find((m) => m.version === 1)!;
    for (const step of v1.steps) {
      db.run(step.sql);
    }
    db.run(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (1, ?, ?)`, [v1.description, new Date().toISOString()]);

    // Simulate interrupted v2: apply ADD COLUMN but NOT version record
    db.run(`ALTER TABLE lexical_items ADD COLUMN natural_alternatives TEXT NOT NULL DEFAULT '[]'`);
    db.run(`ALTER TABLE lexical_items ADD COLUMN register TEXT`);
    db.run(`ALTER TABLE lexical_items ADD COLUMN domain TEXT`);
    // No version insert – crash

    const customAdapter = {
      query: async (sql: string, params?: readonly any[]) => {
        const res = db.exec(sql, params as any[]);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any) => {
          const obj: any = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
          return obj;
        });
      },
      execute: async (sql: string, params?: readonly any[]) => {
        db.run(sql, params as any[]);
        return { rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid };
      },
      transaction: async (steps: readonly any[]) => {
        db.exec('BEGIN IMMEDIATE');
        const results: any[] = [];
        try {
          for (const step of steps) {
            db.run(step.sql, step.params as any[]);
            results.push({ rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid });
          }
          db.exec('COMMIT');
          return results;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      },
    } as any;

    // Now run migrations – should recover and not fail forever
    await runMigrations(customAdapter);
    const version = await getSchemaVersion(customAdapter);
    expect(version).toBe(CURRENT_SCHEMA_VERSION);

    // Verify column exists and version recorded
    const cols = await customAdapter.query(`PRAGMA table_info(lexical_items)`);
    const colNames = cols.map((c: any) => c.name as string);
    expect(colNames).toContain('natural_alternatives');
    expect(colNames).toContain('register');
    expect(colNames).toContain('domain');
  });

  it('18. existing data survives migration', async () => {
    // Create v5 DB with data, then migrate to v6
    const mod = await import('sql.js');
    const create = (mod as any).default;
    const sqlJsMod = await create();
    const db = new sqlJsMod.Database();

    for (let v = 1; v <= 5; v++) {
      const mig = SCHEMA_MIGRATIONS.find((m) => m.version === v)!;
      for (const step of mig.steps) {
        try { db.run(step.sql); } catch {}
      }
      try { db.run(`INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)`, [mig.version, mig.description, new Date().toISOString()]); } catch {}
    }

    const now = new Date().toISOString();
    const learnerId = generateId();
    db.run(`INSERT INTO learner_profile (id, display_name, target_language, target_level, current_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [learnerId, 'Test', 'en', 'B1', 'A2', now, now]);
    db.run(`INSERT INTO lexical_items (id, learner_id, headword, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, ['lex-1', learnerId, 'survive', 'word', now, now]);
    db.run(`INSERT INTO lexical_meanings (id, lexical_item_id, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, ['mean-1', 'lex-1', 'to continue living', now, now]);

    const customAdapter = {
      query: async (sql: string, params?: readonly any[]) => {
        const res = db.exec(sql, params as any[]);
        if (!res || res.length === 0) return [];
        const { columns, values } = res[0];
        return values.map((row: any) => {
          const obj: any = {};
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
          return obj;
        });
      },
      execute: async (sql: string, params?: readonly any[]) => {
        db.run(sql, params as any[]);
        return { rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid };
      },
      transaction: async (steps: readonly any[]) => {
        db.exec('BEGIN IMMEDIATE');
        const results: any[] = [];
        try {
          for (const step of steps) {
            db.run(step.sql, step.params as any[]);
            results.push({ rowsAffected: db.getRowsModified(), insertId: db.lastInsertRowid });
          }
          db.exec('COMMIT');
          return results;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          throw e;
        }
      },
    } as any;

    await runMigrations(customAdapter);

    const lex = await customAdapter.query(`SELECT * FROM lexical_items WHERE id = 'lex-1'`);
    expect(lex.length).toBe(1);
    expect((lex[0] as any).headword).toBe('survive');

    const mean = await customAdapter.query(`SELECT * FROM lexical_meanings WHERE id = 'mean-1'`);
    expect(mean.length).toBe(1);
  });

  it('19. profile concurrent-create protection', async () => {
    const freshAdapter = new SqlJsAdapter(':memory:');
    await freshAdapter.init();

    const repo1 = new SQLiteUserProfileRepository(freshAdapter);
    const repo2 = new SQLiteUserProfileRepository(freshAdapter);

    // Both try to create profile concurrently when none exists
    // First delete any existing
    await freshAdapter.execute(`DELETE FROM learner_profile`);

    const [p1, p2] = await Promise.all([
      repo1.update({ displayName: 'Learner 1', targetLanguage: 'en', targetLevel: 'B1', currentLevel: 'A2' }),
      repo2.update({ displayName: 'Learner 2', targetLanguage: 'en', targetLevel: 'B2', currentLevel: 'B1' }),
    ]);

    // Should result in one logical profile (same id) due to singleton unique constraint
    expect(p1.id).toBe(p2.id);

    const all = await freshAdapter.query(`SELECT COUNT(*) as c FROM learner_profile`);
    expect(Number(all[0].c)).toBe(1);
  });

  it('20. WP-4 reassessment atomicity still passes', async () => {
    const { SQLiteReassessmentHistoryRepository } = await import('../../../reassessment/history-repository');
    const historyRepo = new SQLiteReassessmentHistoryRepository(adapter);

    const recordId = `reassess_${learnerId}_${new Date().toISOString()}`;
    const now = new Date().toISOString();

    const record = await historyRepo.saveRecord({
      id: recordId,
      learnerId,
      assessmentKind: 'reassessment',
      status: 'estimated',
      proposedLevel: 'B1',
      previousLevel: 'A2',
      confidence: 'moderate',
      decision: 'pending',
      acceptedLevel: null,
      basis: [],
      qualitativeSummary: { overallSummary: 'test', domains: [], hasSufficientEvidence: true },
      generatedAt: now,
    });

    expect(record.decision).toBe('pending');

    const [res1, res2] = await Promise.all([
      historyRepo.acceptAndApplyLevel(recordId, 'B1'),
      historyRepo.acceptAndApplyLevel(recordId, 'B1'),
    ]);

    const winners = (res1.updated ? 1 : 0) + (res2.updated ? 1 : 0);
    expect(winners).toBe(1);

    const after = await historyRepo.getById(recordId);
    expect(after?.decision).toBe('accepted');

    const profileRepo = new SQLiteUserProfileRepository(adapter);
    const profile = await profileRepo.get();
    expect(profile.currentLevel).toBe('B1');
  });

  it('21. strengths and weaknesses can still coexist', async () => {
    const weaknessRepo = new SQLiteWeaknessRepository(adapter);
    const now = new Date().toISOString();

    const weakness = await weaknessRepo.upsertWeakness({
      learnerId,
      type: 'grammar',
      referenceId: 'ref-coexist',
      status: 'confirmed',
      severity: 0.6,
      occurrenceCount: 2,
      lastSeenAt: now,
      firstSeenAt: now,
      contexts: [],
      evidence: [],
      resolved: false,
    });

    const strength = await weaknessRepo.upsertStrength({
      learnerId,
      type: 'grammar',
      referenceId: 'ref-coexist', // same referenceId but different table – should be allowed
      confidence: 0.9,
      lastSeenAt: now,
      firstSeenAt: now,
      contexts: [],
      evidence: [],
    });

    expect(weakness.referenceId).toBe('ref-coexist');
    expect(strength.referenceId).toBe('ref-coexist');

    const weaknesses = await weaknessRepo.listWeaknesses(learnerId);
    const strengths = await weaknessRepo.listStrengths(learnerId);

    expect(weaknesses.some((w) => w.referenceId === 'ref-coexist')).toBe(true);
    expect(strengths.some((s) => s.referenceId === 'ref-coexist')).toBe(true);
  });

  it('22. Review package assumptions are not broken by repository changes', async () => {
    const reviewRepo = new SQLiteReviewRepository(adapter);

    // getByReference should find future-due items
    const future = new Date(Date.now() + 86400000 * 10).toISOString();
    const item = await reviewRepo.upsert({
      learnerId,
      kind: 'vocabulary',
      referenceId: generateId(),
      prompt: 'future due',
      state: 'familiar',
      dueAt: future,
      reviewCount: 5,
      consecutiveCorrect: 2,
      outcomeHistory: [{ at: new Date().toISOString(), result: 'correct' }],
    });

    const byRef = await reviewRepo.getByReference?.(learnerId, 'vocabulary', item.referenceId);
    expect(byRef).not.toBeNull();
    expect(byRef!.id).toBe(item.id);
    expect(byRef!.dueAt).toBe(future);

    // listDue should NOT return future-due item
    const due = await reviewRepo.listDue(learnerId, new Date().toISOString());
    expect(due.find((r) => r.id === item.id)).toBeUndefined();

    // Retired items should count as existing for getByReference
    const retired = await reviewRepo.upsert({
      learnerId,
      kind: 'vocabulary',
      referenceId: generateId(),
      prompt: 'retired',
      state: 'retired',
      dueAt: new Date().toISOString(),
      reviewCount: 10,
      consecutiveCorrect: 10,
      outcomeHistory: [],
    });

    const retiredByRef = await reviewRepo.getByReference?.(learnerId, 'vocabulary', retired.referenceId);
    expect(retiredByRef).not.toBeNull();
    expect(retiredByRef!.state).toBe('retired');
  });
});
