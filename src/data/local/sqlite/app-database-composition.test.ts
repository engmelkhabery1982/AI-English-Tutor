/**
 * src/data/local/sqlite/app-database-composition.test.ts
 *
 * PRODUCTION COMPOSITION through the canonical application database owner.
 *
 * Every production default factory (Talk, Review, Listening, Pronunciation,
 * Deep Speaking/Fluency, the Daily Tutor, Onboarding, Reassessment, Progress,
 * the Vocabulary workspace and Adaptive Lessons) must obtain the ONE shared
 * adapter from the canonical owner instead of opening its own connection to
 * `ai_english_tutor.db`.
 *
 * Only the PLATFORM boundary is replaced — through the canonical owner's own
 * injection seam — with a real SqlJsAdapter. Everything above it (the real
 * repositories, the real schema, real migrations and the real feature
 * compositions) is what runs, and evidence written through a feature is read
 * back from the SAME database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

import type { DatabaseAdapter, SqlParam, SqlStep } from './DatabaseAdapter';
import type { AppDatabaseOwner } from './app-database';
import type * as RepositoriesModule from './repositories';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = '2026-09-19T09:00:00.000Z';

/**
 * Counts the lifecycle calls the canonical owner makes on the platform
 * boundary while delegating every SQL operation to a real SqlJsAdapter.
 */
class CountingAdapter implements DatabaseAdapter {
  readonly backend = 'sql.js' as const;
  readonly path: string;
  initCalls = 0;
  closeCalls = 0;

  constructor(private readonly inner: DatabaseAdapter) {
    this.path = inner.path;
  }

  get connected(): boolean {
    return this.inner.connected;
  }

  async init(): Promise<void> {
    this.initCalls += 1;
    await this.inner.init();
  }

  execute(sql: string, params?: readonly SqlParam[]) {
    return this.inner.execute(sql, params);
  }

  query(sql: string, params?: readonly SqlParam[]) {
    return this.inner.query(sql, params);
  }

  transaction(steps: readonly SqlStep[]) {
    return this.inner.transaction(steps);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return this.inner.close();
  }
}

interface CompositionCtx {
  /** The ONE adapter every production composition must share. */
  readonly adapter: CountingAdapter;
  /** The real in-memory database behind it (for direct SQL read-back). */
  readonly inner: DatabaseAdapter;
  readonly learnerId: string;
  readonly owner: AppDatabaseOwner;
  /** How many adapters the canonical owner's factory had to create. */
  readonly creates: () => number;
  /** Fresh (post-reset) repository classes bound to the fresh module graph. */
  readonly repos: () => Promise<typeof RepositoriesModule>;
}

/**
 * Install a canonical owner backed by a real, migrated in-memory database with
 * one real learner profile, then return the shared context.
 */
async function installCanonicalOwner(): Promise<CompositionCtx> {
  // A fresh module graph per test: every feature factory then composes against
  // THIS canonical owner (and its own service cache starts empty).
  vi.resetModules();

  const { SqlJsAdapter } = await import('./SqlJsAdapter');
  const repositories = await import('./repositories');
  const inner = new SqlJsAdapter(':memory:');
  await inner.init();
  const profile = await new repositories.SQLiteUserProfileRepository(inner).update({
    displayName: 'Composition Learner',
    currentLevel: 'A2',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: ['natural'],
  });

  const appDb = await import('./app-database');
  let creates = 0;
  const adapter = new CountingAdapter(inner);
  const owner = appDb.createAppDatabaseOwner({
    databaseName: 'ai_english_tutor.db',
    createAdapter: () => {
      creates += 1;
      return adapter;
    },
    now: () => NOW,
  });
  appDb.setAppDatabaseOwner(owner);

  return {
    adapter,
    inner,
    learnerId: profile.id,
    owner,
    creates: () => creates,
    repos: () => import('./repositories'),
  };
}

/**
 * A canonical owner whose factory creates a REAL, separate in-memory database
 * per lifecycle — the shape of "close the app database, reopen it later" — so a
 * test can prove which lifecycle a feature composition was built on.
 */
interface MultiLifecycleCtx {
  readonly owner: AppDatabaseOwner;
  /** Adapters the owner created, in lifecycle order. */
  readonly created: readonly CountingAdapter[];
  /** Seed one real learner profile into a freshly opened lifecycle. */
  readonly seedProfile: (adapter: DatabaseAdapter, displayName: string) => Promise<string>;
}

async function installMultiLifecycleOwner(): Promise<MultiLifecycleCtx> {
  vi.resetModules();

  const { SqlJsAdapter } = await import('./SqlJsAdapter');
  const repositories = await import('./repositories');
  const appDb = await import('./app-database');

  const created: CountingAdapter[] = [];
  const owner = appDb.createAppDatabaseOwner({
    databaseName: 'ai_english_tutor.db',
    createAdapter: () => {
      // A NEW connection per lifecycle: exactly what the real app does after a
      // close/reopen (a new adapter object, never the invalidated one).
      const adapter = new CountingAdapter(new SqlJsAdapter(':memory:'));
      created.push(adapter);
      return adapter;
    },
    now: () => NOW,
  });
  appDb.setAppDatabaseOwner(owner);

  async function seedProfile(
    adapter: DatabaseAdapter,
    displayName: string,
  ): Promise<string> {
    const profile = await new repositories.SQLiteUserProfileRepository(adapter).update({
      displayName,
      currentLevel: 'A2',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: ['natural'],
    });
    return profile.id;
  }

  return { owner, created, seedProfile };
}

beforeEach(() => {
  vi.resetModules();
});

/* ------------------------------------------------------------------ *
 * Talk
 * ------------------------------------------------------------------ */

describe('production composition: Talk', () => {
  it('composes on the canonical owner adapter and reuses it', async () => {
    const ctx = await installCanonicalOwner();
    const talk = await import('../../../talk-demo');

    const composition = await talk.createDefaultTalkComposition();
    expect(composition.databaseAdapter).toBe(ctx.adapter);
    expect(composition.learnerModel).toBeDefined();

    // Reused: one adapter, one initialization, one composition.
    expect(await talk.createDefaultTalkComposition()).toBe(composition);
    expect(ctx.creates()).toBe(1);
    expect(ctx.adapter.initCalls).toBe(1);

    // The routed Talk path resolves persisted state from the SAME database.
    const resolution = await talk.resolveTalkCoaching();
    expect(resolution.source).toBe('persisted');
    expect(resolution.databaseAdapter).toBe(ctx.adapter);
    // The composed learner model reads the SAME database.
    const { SQLiteUserProfileRepository } = await ctx.repos();
    const profile = await new SQLiteUserProfileRepository(ctx.adapter).get();
    expect(profile?.id).toBe(ctx.learnerId);
  });
});

/* ------------------------------------------------------------------ *
 * Listening
 * ------------------------------------------------------------------ */

describe('production composition: Listening', () => {
  it('reads and writes REAL evidence on the canonical database', async () => {
    const ctx = await installCanonicalOwner();
    const listening = await import('../../../listening');

    const service = await listening.createDefaultListeningService();
    expect(await listening.createDefaultListeningService()).toBe(service);
    expect(ctx.creates()).toBe(1);
    expect(await service.resolveLearnerId()).toBe(ctx.learnerId);

    const { evaluation } = await service.evaluateAnswer(
      ctx.learnerId,
      {
        id: '1ef907b7-6c12-4ead-8f9a-c97bd31e00001',
        learnerId: ctx.learnerId,
        type: 'listen_and_type',
        difficulty: 'easy',
        speakText: 'We need to meet the deadline by Friday.',
        expectedAnswer: 'We need to meet the deadline by Friday',
        keyItems: ['deadline'],
        source: 'general',
        weaknessReferenceId: 'listening:canonical-owner',
      } as Parameters<typeof service.evaluateAnswer>[1],
      'We need to meet the deadline by Friday',
      { now: NOW },
    );
    expect(evaluation.result).toBe('understood');

    // The strength row really landed in the SHARED database.
    const { SQLiteWeaknessRepository } = await ctx.repos();
    const strengths = await new SQLiteWeaknessRepository(ctx.adapter).listStrengths(
      ctx.learnerId,
    );
    expect(strengths).toHaveLength(1);
    expect(strengths[0].referenceId).toBe('listening:canonical-owner');
  });
});

/* ------------------------------------------------------------------ *
 * Pronunciation
 * ------------------------------------------------------------------ */

describe('production composition: Pronunciation', () => {
  it('persists observations on the canonical database', async () => {
    const ctx = await installCanonicalOwner();
    const pronunciation = await import('../../../pronunciation');

    const engine = await pronunciation.createDefaultPronunciationEngine();
    expect(await pronunciation.createDefaultPronunciationEngine()).toBe(engine);
    expect(ctx.creates()).toBe(1);

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'I walk to school yesterday',
      expectedText: 'I walked to school yesterday',
      now: NOW,
    });
    expect(outcome).not.toBeNull();

    const { SQLiteWeaknessRepository } = await ctx.repos();
    const weaknesses = await new SQLiteWeaknessRepository(ctx.adapter).listWeaknesses(
      ctx.learnerId,
      20,
    );
    expect(weaknesses.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Deep Speaking + Fluency (disposal must not close the app database)
 * ------------------------------------------------------------------ */

describe('production composition: Deep Speaking and Fluency', () => {
  it('composes over the canonical adapter and feature disposal keeps it open', async () => {
    const ctx = await installCanonicalOwner();
    const deepSpeaking = await import('../../../deep-speaking');
    const fluency = await import('../../../fluency');

    const composition = await deepSpeaking.resolveDefaultSpeakingComposition();
    expect(composition).not.toBeNull();
    expect(composition!.adapter).toBe(ctx.adapter);

    const practice = await fluency.createDefaultFluencyService();
    expect(ctx.creates()).toBe(1);

    // Disposing a FEATURE service must never close the shared application
    // database (only the app-level owner may do that).
    await practice.dispose();
    expect(ctx.adapter.connected).toBe(true);
    expect(ctx.owner.isOpen).toBe(true);
    expect(ctx.owner.connection?.adapter).toBe(ctx.adapter);
    expect(ctx.adapter.closeCalls).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Daily Tutor
 * ------------------------------------------------------------------ */

describe('production composition: Daily Tutor', () => {
  it('persists the durable daily session on the canonical database', async () => {
    const ctx = await installCanonicalOwner();
    const dailyTutor = await import('../../../daily-tutor');

    const service = await dailyTutor.createDefaultDailyTutorService();
    expect(await dailyTutor.createDefaultDailyTutorService()).toBe(service);
    expect(ctx.creates()).toBe(1);
    expect(await service.resolveLearnerId()).toBe(ctx.learnerId);

    const today = await service.getToday();
    expect(today.status).toBe('ready');

    const rows = await ctx.inner.query(
      `SELECT learner_id, status FROM daily_tutor_sessions`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].learner_id).toBe(ctx.learnerId);
  });
});

/* ------------------------------------------------------------------ *
 * Onboarding / Reassessment
 * ------------------------------------------------------------------ */

describe('production composition: Onboarding and Reassessment', () => {
  it('Onboarding reads the real profile through the canonical adapter', async () => {
    const ctx = await installCanonicalOwner();
    const onboarding = await import('../../../onboarding');

    const service = await onboarding.createDefaultOnboardingService();
    expect(await onboarding.createDefaultOnboardingService()).toBe(service);
    expect(ctx.creates()).toBe(1);

    const prefill = await service.loadPrefill();
    expect(prefill).toBeDefined();
    expect(ctx.adapter.initCalls).toBe(1);
  });

  it('Reassessment records success evidence on the canonical adapter', async () => {
    const ctx = await installCanonicalOwner();
    const reassessment = await import('../../../reassessment');

    const service = reassessment.createReassessmentService();
    const result = await service.successRecorder.recordSuccessObservation({
      learnerId: ctx.learnerId,
      type: 'fluency',
      referenceId: 'fluency:canonical-owner',
      source: 'fluency_service',
      context: 'support:guided',
      evidence: {
        kind: 'observation',
        id: 'canonical-owner-1',
        at: NOW,
        summary: 'Strong attempt through the canonical composition',
      },
    });

    expect(result.recorded).toBe(true);
    const { SQLiteWeaknessRepository } = await ctx.repos();
    const strengths = await new SQLiteWeaknessRepository(ctx.adapter).listStrengths(
      ctx.learnerId,
    );
    expect(strengths.map((strength) => strength.referenceId)).toContain(
      'fluency:canonical-owner',
    );
    expect(ctx.creates()).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Progress / Vocabulary workspace / Adaptive lessons
 * ------------------------------------------------------------------ */

describe('production composition: Progress, Vocabulary and Adaptive Lessons', () => {
  it('Progress reads the canonical learner, not a second database', async () => {
    const ctx = await installCanonicalOwner();
    const progress = await import('../../../progress-dashboard');

    const service = await progress.createDefaultProgressDashboardService();
    expect(await progress.createDefaultProgressDashboardService()).toBe(service);
    expect(await service.getActiveLearnerId()).toBe(ctx.learnerId);
    expect(ctx.creates()).toBe(1);
  });

  it('Vocabulary workspace reads the canonical learner', async () => {
    const ctx = await installCanonicalOwner();
    const workspace = await import('../../../vocabulary-workspace');

    const service = await workspace.createDefaultVocabularyWorkspaceService();
    expect(await workspace.createDefaultVocabularyWorkspaceService()).toBe(service);
    expect(await service.getActiveLearnerId()).toBe(ctx.learnerId);
    expect(ctx.creates()).toBe(1);
  });

  it('Adaptive Lessons reads the canonical learner', async () => {
    const ctx = await installCanonicalOwner();
    const adaptive = await import('../../../adaptive-lessons');

    const service = await adaptive.createDefaultAdaptiveLessonService();
    expect(await adaptive.createDefaultAdaptiveLessonService()).toBe(service);
    expect(await service.resolveLearnerId()).toBe(ctx.learnerId);
    expect(ctx.creates()).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Review
 * ------------------------------------------------------------------ */

describe('production composition: Review', () => {
  it('the Review composition path obtains the adapter from the canonical owner', async () => {
    const ctx = await installCanonicalOwner();
    const appDb = await import('./app-database');
    const { createReviewService } = await import('../../../review/factory');

    // Exactly what the Review screen does: canonical adapter, then compose.
    const { adapter } = await appDb.getAppDatabase();
    expect(adapter).toBe(ctx.adapter);

    const service = createReviewService(adapter, false);
    const summary = await service.getDashboardSummary(ctx.learnerId);
    expect(summary).toBeDefined();
    expect(ctx.creates()).toBe(1);
    expect(ctx.adapter.initCalls).toBe(1);
  });

  it('the Review screen obtains the adapter from the canonical owner only', () => {
    const screen = readFileSync(
      join(__dirname, '..', '..', '..', 'screens', 'ReviewScreen.tsx'),
      'utf8',
    );
    expect(screen).toContain('getAppDatabase');
    expect(screen).toContain("from '../data/local/sqlite/app-database'");
    // No feature-local bootstrap, no second connection to the same file.
    expect(screen).not.toContain('ExpoSqliteAdapter');
    expect(screen).not.toContain('SqlJsAdapter');
    expect(screen).not.toContain('ai_english_tutor.db');
  });
});

/* ------------------------------------------------------------------ *
 * Failed bootstrap: surfaced, not cached, retried
 * ------------------------------------------------------------------ */

describe('production composition after a failed database bootstrap', () => {
  it('surfaces the failure and retries successfully on the next explicit request', async () => {
    vi.resetModules();
    const { SqlJsAdapter } = await import('./SqlJsAdapter');
    const repositories = await import('./repositories');
    const inner = new SqlJsAdapter(':memory:');
    await inner.init();
    const profile = await new repositories.SQLiteUserProfileRepository(inner).update({
      displayName: 'Recovery Learner',
      currentLevel: 'A2',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    });

    const appDb = await import('./app-database');
    let attempts = 0;
    const adapter = new CountingAdapter(inner);
    const owner = appDb.createAppDatabaseOwner({
      createAdapter: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('native database unavailable');
        return adapter;
      },
      now: () => NOW,
    });
    appDb.setAppDatabaseOwner(owner);

    const listening = await import('../../../listening');

    // 1. The first initialization fails and the failure is surfaced honestly.
    const failure = await listening.createDefaultListeningService().catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe('open_failed');

    // 2. The rejected composition was NOT cached: the next explicit request
    //    retries, succeeds, and the database is usable.
    const service = await listening.createDefaultListeningService();
    expect(await service.resolveLearnerId()).toBe(profile.id);

    // 3. The successful instance is shared afterwards.
    expect(await listening.createDefaultListeningService()).toBe(service);
    expect(attempts).toBe(2);
    expect(adapter.initCalls).toBe(1);
    expect(owner.isOpen).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Lifecycle changes invalidate cached feature compositions
 * ------------------------------------------------------------------ */

describe('feature composition follows the canonical database lifecycle', () => {
  it('recomposes every cached default factory on the NEW adapter after close/reopen', async () => {
    const ctx = await installMultiLifecycleOwner();
    const appDb = await import('./app-database');
    const talk = await import('../../../talk-demo');
    const listening = await import('../../../listening');

    /* ---- lifecycle 1 ---------------------------------------------------- */
    const first = await appDb.getAppDatabase();
    expect(first.lifecycleId).toBe(1);
    const learner1 = await ctx.seedProfile(first.adapter, 'Lifecycle One');

    const talk1 = await talk.createDefaultTalkComposition();
    const listening1 = await listening.createDefaultListeningService();
    expect(talk1.databaseAdapter).toBe(first.adapter);
    expect(await listening1.resolveLearnerId()).toBe(learner1);

    // Within ONE lifecycle a successful composition is still shared…
    expect(await talk.createDefaultTalkComposition()).toBe(talk1);
    expect(await listening.createDefaultListeningService()).toBe(listening1);
    // …and it took exactly one adapter + one initialization (one migration run).
    expect(ctx.created).toHaveLength(1);
    expect(ctx.created[0].initCalls).toBe(1);
    expect(ctx.created[0].closeCalls).toBe(0);

    /* ---- app-level close invalidates the lifecycle ---------------------- */
    await appDb.closeAppDatabase();
    expect(first.isClosed()).toBe(true);
    expect(ctx.created[0].closeCalls).toBe(1);
    expect(first.adapter.connected).toBe(false);

    /* ---- reopen => lifecycle 2 ----------------------------------------- */
    const second = await appDb.reopenAppDatabase();
    expect(second.lifecycleId).toBe(2);
    expect(second.adapter).not.toBe(first.adapter);
    expect(ctx.created).toHaveLength(2);
    const learner2 = await ctx.seedProfile(second.adapter, 'Lifecycle Two');
    expect(learner2).not.toBe(learner1); // a genuinely different database

    // Concurrent callers inside the NEW lifecycle still share ONE composition,
    // and the feature is composed on the NEW adapter — never the closed one.
    const [concurrentA, concurrentB] = await Promise.all([
      listening.createDefaultListeningService(),
      listening.createDefaultListeningService(),
    ]);
    const talk2 = await talk.createDefaultTalkComposition();

    expect(concurrentA).toBe(concurrentB);
    expect(concurrentA).not.toBe(listening1);
    expect(talk2).not.toBe(talk1);
    expect(talk2.databaseAdapter).toBe(second.adapter);
    expect(talk2.databaseAdapter).not.toBe(first.adapter);
    expect(await concurrentA.resolveLearnerId()).toBe(learner2);
    expect(ctx.created).toHaveLength(2);
    expect(ctx.created[1].initCalls).toBe(1);

    /* ---- one more close/reopen => lifecycle 3 --------------------------- */
    await appDb.closeAppDatabase();
    expect(second.isClosed()).toBe(true);
    const third = await appDb.reopenAppDatabase();
    expect(third.lifecycleId).toBe(3);
    const learner3 = await ctx.seedProfile(third.adapter, 'Lifecycle Three');

    const talk3 = await talk.createDefaultTalkComposition();
    const listening3 = await listening.createDefaultListeningService();
    expect(talk3).not.toBe(talk2);
    expect(listening3).not.toBe(concurrentA);
    expect(talk3.databaseAdapter).toBe(third.adapter);
    expect(await listening3.resolveLearnerId()).toBe(learner3);
    expect(ctx.created).toHaveLength(3);
    expect(ctx.created[2].initCalls).toBe(1);
    expect(await talk.createDefaultTalkComposition()).toBe(talk3);
  });

  it('a bare app-level close is enough to invalidate the cached compositions', async () => {
    const ctx = await installMultiLifecycleOwner();
    const appDb = await import('./app-database');
    const talk = await import('../../../talk-demo');

    const first = await appDb.getAppDatabase();
    await ctx.seedProfile(first.adapter, 'Before Close');
    const talk1 = await talk.createDefaultTalkComposition();
    expect(talk1.databaseAdapter).toBe(first.adapter);

    await appDb.closeAppDatabase();

    // No explicit reopen needed: obtaining the database again starts a NEW
    // lifecycle, and the feature must be composed on it.
    const talk2 = await talk.createDefaultTalkComposition();
    expect(talk2).not.toBe(talk1);
    expect(talk2.databaseAdapter).not.toBe(first.adapter);
    expect(ctx.created).toHaveLength(2);
    expect(talk2.databaseAdapter).toBe(ctx.owner.connection?.adapter);
    expect(ctx.owner.connection?.isClosed()).toBe(false);
  });

  it('every cached default composition in the wider feature set follows the NEW lifecycle', async () => {
    const ctx = await installMultiLifecycleOwner();
    const appDb = await import('./app-database');

    const talk = await import('../../../talk-demo');
    const listening = await import('../../../listening');
    const pronunciation = await import('../../../pronunciation');
    const dailyTutor = await import('../../../daily-tutor');
    const onboarding = await import('../../../onboarding');
    const progress = await import('../../../progress-dashboard');
    const workspace = await import('../../../vocabulary-workspace');
    const adaptive = await import('../../../adaptive-lessons');
    const deepSpeaking = await import('../../../deep-speaking');
    const fluency = await import('../../../fluency');
    const reassessment = await import('../../../reassessment');
    const { createReviewService } = await import('../../../review/factory');
    const { createConversationMemoryService } = await import(
      '../../../talk-demo/conversation-memory'
    );
    const { createVocabularyPersistenceService } = await import(
      '../../../talk-demo/vocabulary-persistence'
    );
    const { createLearningPersistenceService } = await import(
      '../../../talk-demo/learning-persistence'
    );

    // Lifecycle 1: compose the whole feature set (and write real evidence).
    const first = await appDb.getAppDatabase();
    await ctx.seedProfile(first.adapter, 'Lifecycle One');
    const preCloseTalk = await talk.createDefaultTalkComposition();
    const preCloseListening = await listening.createDefaultListeningService();

    await appDb.closeAppDatabase();

    const second = await appDb.reopenAppDatabase();
    expect(second.lifecycleId).toBe(2);
    const learnerId = await ctx.seedProfile(second.adapter, 'Lifecycle Two');

    async function probeEveryFeature(): Promise<void> {
      // Talk / Listening / Pronunciation / Daily Tutor / Onboarding / Progress
      // / Vocabulary workspace / Adaptive Lessons: cached default factories.
      const talkComposition = await talk.createDefaultTalkComposition();
      expect(talkComposition.databaseAdapter).toBe(second.adapter);
      expect(await listening.createDefaultListeningService()).not.toBe(preCloseListening);
      expect(await (await listening.createDefaultListeningService()).resolveLearnerId()).toBe(
        learnerId,
      );
      expect(await pronunciation.createDefaultPronunciationEngine()).toBeDefined();
      const dailyTutorService = await dailyTutor.createDefaultDailyTutorService();
      expect(await dailyTutorService.getToday()).toBeDefined();
      expect(await (await onboarding.createDefaultOnboardingService()).loadPrefill()).toBeDefined();
      expect(await (await progress.createDefaultProgressDashboardService()).getActiveLearnerId()).toBe(
        learnerId,
      );
      expect(
        await (await workspace.createDefaultVocabularyWorkspaceService()).getActiveLearnerId(),
      ).toBe(learnerId);
      expect(await (await adaptive.createDefaultAdaptiveLessonService()).resolveLearnerId()).toBe(
        learnerId,
      );

      // Deep Speaking / Fluency: default composition resolved through Talk.
      const speaking = await deepSpeaking.resolveDefaultSpeakingComposition();
      expect(speaking?.adapter).toBe(second.adapter);
      expect(await fluency.createDefaultFluencyService()).toBeDefined();

      // Review: the screen path composes on the canonical adapter.
      const reviewService = createReviewService(
        (await appDb.getAppDatabase()).adapter,
        false,
      );
      expect(await reviewService.getDashboardSummary(learnerId)).toBeDefined();

      // Reassessment: default composition on the canonical adapter.
      const reassessmentService = reassessment.createReassessmentService();
      expect(await reassessmentService.getHistory(learnerId)).toEqual([]);

      // Conversation memory, vocabulary persistence and learning persistence:
      // default (non-injected) compositions must also resolve the NEW adapter.
      const memory = createConversationMemoryService();
      expect(await memory.listRecentConversations(5)).toEqual([]);
      const vocabulary = await createVocabularyPersistenceService().saveVocabulary({
        headword: 'deadline',
        type: 'word',
        meaning: 'the latest time by which something must be done',
        example: 'We need to meet the deadline by Friday.',
      });
      expect(vocabulary).not.toBeNull();
      await createLearningPersistenceService().recordFeedbackEvidence({
        correction: {
          original: 'Yesterday I go to school',
          improved: 'Yesterday I went to school',
          explanation: 'Use the past tense after yesterday.',
          severity: 'incorrect',
        },
      });
    }

    await probeEveryFeature();

    // ONE adapter for lifecycle 2 — nothing in the feature set opened a second
    // connection, and the pre-close Talk composition was never reused.
    expect(ctx.created).toHaveLength(2);
    expect(ctx.created[1].initCalls).toBe(1);
    expect(ctx.created[1].closeCalls).toBe(0);
    expect((await talk.createDefaultTalkComposition()).databaseAdapter).toBe(second.adapter);
    expect(preCloseTalk.databaseAdapter).toBe(first.adapter);
    expect(preCloseTalk.databaseAdapter).not.toBe(second.adapter);

    // The evidence written through those default compositions really landed in
    // the lifecycle-2 database.
    const { SQLiteVocabularyRepository, SQLiteMistakeRepository } = await import(
      './repositories'
    );
    const vocabularyItems = await new SQLiteVocabularyRepository(second.adapter).list(learnerId);
    expect(vocabularyItems.map((item) => item.headword)).toContain('deadline');
    const mistakes = await new SQLiteMistakeRepository(second.adapter).listMistakes(learnerId);
    expect(mistakes.length).toBeGreaterThan(0);

    // Still exactly ONE connection after all of that reuse.
    expect(ctx.created).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * One owner, one adapter, one initialization for EVERY feature
 * ------------------------------------------------------------------ */

describe('canonical composition across every feature', () => {
  it('ten production compositions share ONE adapter and ONE initialization', async () => {
    const ctx = await installCanonicalOwner();

    const talk = await import('../../../talk-demo');
    const listening = await import('../../../listening');
    const pronunciation = await import('../../../pronunciation');
    const dailyTutor = await import('../../../daily-tutor');
    const onboarding = await import('../../../onboarding');
    const progress = await import('../../../progress-dashboard');
    const workspace = await import('../../../vocabulary-workspace');
    const adaptive = await import('../../../adaptive-lessons');
    const deepSpeaking = await import('../../../deep-speaking');
    const reassessment = await import('../../../reassessment');

    const [
      talkComposition,
      listeningService,
      pronunciationEngine,
      dailyTutorService,
      onboardingService,
      progressService,
      workspaceService,
      adaptiveService,
      speakingComposition,
    ] = await Promise.all([
      talk.createDefaultTalkComposition(),
      listening.createDefaultListeningService(),
      pronunciation.createDefaultPronunciationEngine(),
      dailyTutor.createDefaultDailyTutorService(),
      onboarding.createDefaultOnboardingService(),
      progress.createDefaultProgressDashboardService(),
      workspace.createDefaultVocabularyWorkspaceService(),
      adaptive.createDefaultAdaptiveLessonService(),
      deepSpeaking.resolveDefaultSpeakingComposition(),
    ]);

    // …plus the lazily-composed reassessment service (no eager bootstrap).
    const reassessmentService = reassessment.createReassessmentService();
    await reassessmentService.getHistory(ctx.learnerId);

    expect(talkComposition.databaseAdapter).toBe(ctx.adapter);
    expect(speakingComposition?.adapter).toBe(ctx.adapter);
    for (const service of [
      listeningService,
      dailyTutorService,
      onboardingService,
      progressService,
      workspaceService,
      adaptiveService,
    ]) {
      expect(service).toBeDefined();
    }
    expect(pronunciationEngine).toBeDefined();

    // TEN compositions, ONE adapter created, ONE initialization (and therefore
    // ONE migration run), and the database is still open.
    expect(ctx.creates()).toBe(1);
    expect(ctx.adapter.initCalls).toBe(1);
    expect(ctx.adapter.closeCalls).toBe(0);
    expect(ctx.owner.connection?.adapter).toBe(ctx.adapter);
  });
});
