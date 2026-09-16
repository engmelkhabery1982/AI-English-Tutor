/**
 * src/progress-dashboard/index.test.ts
 *
 * Tests for the Real Progress Dashboard.
 *
 * Strategy: exercise the dashboard service against the REAL SQLite
 * repositories (SqlJsAdapter) with injected dependencies, so counts,
 * windows, ordering, and score-field exclusion are verified end to end —
 * no network, microphone, or TTS. Structural checks pin the screen to the
 * service-only composition contract (no SQLite imports, existing Review
 * navigation). Talk/Review/Vocabulary/Voice suites keep covering their own
 * behavior and must continue passing in the same run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { join } from 'node:path';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteConversationRepository,
  SQLiteWeaknessRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteProgressRepository,
} from '../data/local/sqlite/repositories';
import { ProgressDashboardService } from './service';
import type { UserProfile } from '../domain/models/learner';

const NOW = '2026-09-17T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgoIso(days: number, from: string = NOW): string {
  return new Date(new Date(from).getTime() - days * DAY_MS).toISOString();
}

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  service: ProgressDashboardService;
  conversations: SQLiteConversationRepository;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  expressions: SQLiteExpressionRepository;
  review: SQLiteReviewRepository;
  progress: SQLiteProgressRepository;
}

async function createContext(): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();

  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Progress Tester',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });

  const conversations = new SQLiteConversationRepository(adapter);
  const weaknesses = new SQLiteWeaknessRepository(adapter);
  const vocabulary = new SQLiteVocabularyRepository(adapter);
  const expressions = new SQLiteExpressionRepository(adapter);
  const review = new SQLiteReviewRepository(adapter);
  const progress = new SQLiteProgressRepository(adapter);

  const service = new ProgressDashboardService({
    profile: profileRepo,
    conversations,
    weaknesses,
    vocabulary,
    expressions,
    review,
    progress,
  });

  return {
    adapter,
    learnerId: profile.id,
    service,
    conversations,
    weaknesses,
    vocabulary,
    expressions,
    review,
    progress,
  };
}

async function saveVocab(
  ctx: TestContext,
  headword: string,
  options?: {
    type?: 'word' | 'phrase' | 'phrasal_verb' | 'idiom';
    review?: {
      state: 'new' | 'learning' | 'familiar' | 'mastered';
      reviewCount: number;
      consecutiveCorrect: number;
      nextReviewAt?: string;
    };
  },
) {
  return ctx.vocabulary.upsert({
    learnerId: ctx.learnerId,
    headword,
    type: options?.type ?? 'word',
    meanings: [
      {
        definition: `definition of ${headword}`,
        examples: [],
        usageNotes: [],
        review: options?.review,
      },
    ],
    pronunciation: {},
    synonyms: [],
    antonyms: [],
    relatedExpressions: [],
    source: { addedBy: 'learner-created', addedAt: new Date().toISOString() },
    tags: [],
  });
}

async function saveExpression(
  ctx: TestContext,
  expression: string,
  options?: { type?: 'idiom' | 'collocation'; review?: { state: 'learning' | 'familiar' | 'mastered'; reviewCount: number; consecutiveCorrect: number; nextReviewAt?: string } },
) {
  return ctx.expressions.upsert({
    learnerId: ctx.learnerId,
    expression,
    type: options?.type ?? 'idiom',
    meanings: [
      {
        definition: `meaning of ${expression}`,
        examples: [],
        usageNotes: [],
        review: options?.review,
      },
    ],
    naturalAlternatives: [],
    source: { addedBy: 'learner-created', addedAt: new Date().toISOString() },
    tags: [],
  });
}

async function saveSession(
  ctx: TestContext,
  options?: { startedAt?: string; status?: 'active' | 'completed' | 'abandoned' | 'summarized'; turnCount?: number },
) {
  return ctx.conversations.createSession({
    learnerId: ctx.learnerId,
    mode: 'coach',
    status: options?.status ?? 'completed',
    startedAt: options?.startedAt ?? NOW,
    turnCount: options?.turnCount ?? 4,
  });
}

let weaknessCounter = 0;

async function saveWeakness(
  ctx: TestContext,
  options?: {
    type?: 'grammar' | 'vocabulary' | 'natural_expression';
    status?: 'observed' | 'repeated' | 'confirmed' | 'active_training' | 'improving' | 'stable' | 'mastered' | 'relapsed';
    occurrenceCount?: number;
    notes?: string;
    resolved?: boolean;
    evidence?: { at: string; summary: string }[];
    firstSeenAt?: string;
    lastSeenAt?: string;
  },
) {
  return ctx.weaknesses.upsertWeakness({
    learnerId: ctx.learnerId,
    type: options?.type ?? 'grammar',
    referenceId: `2f6c9a52-8e1b-4c47-9a55-0f3b2d1e7a${(weaknessCounter++).toString(16).padStart(2, '0')}`,
    severity: 0.5,
    status: options?.status ?? 'observed',
    occurrenceCount: options?.occurrenceCount ?? 1,
    firstSeenAt: options?.firstSeenAt ?? daysAgoIso(2),
    lastSeenAt: options?.lastSeenAt ?? daysAgoIso(1),
    contexts: ['conversation-turn'],
    notes: options?.notes ?? 'Yesterday I go',
    evidence: (options?.evidence ?? []).map((entry, index) => ({
      id: `evidence-${weaknessCounter}-${index}-2f6c9a52-8e1b-4c47-9a55-0f3b2d1e7a9${index}`,
      kind: 'turn' as const,
      at: entry.at,
      summary: entry.summary,
    })),
    resolved: options?.resolved ?? false,
  });
}

let reviewCounter = 0;

async function saveReviewItem(
  ctx: TestContext,
  options: { dueAt: string; kind?: 'vocabulary' | 'grammar' | 'expression'; prompt?: string },
) {
  return ctx.review.upsert({
    learnerId: ctx.learnerId,
    kind: options.kind ?? 'vocabulary',
    referenceId: `6b1d0f7e-42a5-4c8e-9b30-7c2d5a8f1e${(reviewCounter++).toString(16).padStart(2, '0')}`,
    prompt: options.prompt ?? 'What word matches this definition?',
    expectedResponse: 'run',
    state: 'learning',
    dueAt: options.dueAt,
    reviewCount: 0,
    consecutiveCorrect: 0,
    outcomeHistory: [],
  });
}

describe('Progress Dashboard (real SQLite, injected repositories)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    ctx = await createContext();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- 1. NO LEARNER PROFILE ---
  it('1. reports no learner when no profile exists and never fabricates an id', async () => {
    const adapter = new SqlJsAdapter();
    await adapter.init();
    const service = new ProgressDashboardService({
      profile: new SQLiteUserProfileRepository(adapter),
      conversations: new SQLiteConversationRepository(adapter),
      weaknesses: new SQLiteWeaknessRepository(adapter),
      vocabulary: new SQLiteVocabularyRepository(adapter),
      expressions: new SQLiteExpressionRepository(adapter),
      review: new SQLiteReviewRepository(adapter),
      progress: new SQLiteProgressRepository(adapter),
    });

    await expect(service.getActiveLearnerId()).resolves.toBeNull();
  });

  // --- 2. EMPTY DASHBOARD --- 23. NO DEMO FALLBACK ---
  it('2. an empty learner gets an honest all-zero dashboard, never demo data', async () => {
    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    expect(snapshot.overview).toEqual({
      sessionsCompleted: 0,
      conversationTurns: 0,
      vocabularySaved: 0,
      expressionsSaved: 0,
      reviewsDue: 0,
      activeWeaknesses: 0,
    });
    expect(snapshot.vocabularyStatus).toEqual({
      total: 0, due: 0, learning: 0, familiar: 0, mastered: 0,
    });
    expect(snapshot.expressionStatus).toEqual({
      total: 0, due: 0, learning: 0, familiar: 0, mastered: 0,
    });
    expect(snapshot.weaknessGroups.every((group) => group.count === 0)).toBe(true);
    expect(snapshot.weaknessCards).toHaveLength(0);
    expect(snapshot.reviewStatus.dueCount).toBe(0);
    expect(snapshot.recentActivity).toHaveLength(0);
    expect(snapshot.recentProgress).toHaveLength(0);
    expect(snapshot.trends.every((bucket) => bucket.total === 0)).toBe(true);
  });

  // --- 3. OVERVIEW REAL COUNTS ---
  it('3. overview counts come from persisted records only', async () => {
    await saveSession(ctx, { status: 'completed', turnCount: 6, startedAt: daysAgoIso(1) });
    await saveSession(ctx, { status: 'summarized', turnCount: 3, startedAt: daysAgoIso(2) });
    await saveSession(ctx, { status: 'active', turnCount: 2, startedAt: daysAgoIso(1) });
    await saveVocab(ctx, 'run');
    await saveVocab(ctx, 'sprint');
    await saveExpression(ctx, 'break the ice');
    await saveWeakness(ctx, { occurrenceCount: 3 });
    await saveReviewItem(ctx, { dueAt: daysAgoIso(0.5) });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    // finished = completed + summarized; active is not completed
    expect(snapshot.overview.sessionsCompleted).toBe(2);
    expect(snapshot.overview.conversationTurns).toBe(11);
    expect(snapshot.overview.vocabularySaved).toBe(2);
    expect(snapshot.overview.expressionsSaved).toBe(1);
    expect(snapshot.overview.reviewsDue).toBe(1);
    expect(snapshot.overview.activeWeaknesses).toBe(1);
  });

  // --- 4. VOCABULARY STATUS COUNTS --- 5. EXPRESSION STATUS COUNTS ---
  it('4 and 5. vocabulary/expression status counts use the shared meaning.review bucket logic', async () => {
    await saveVocab(ctx, 'due-word', {
      review: { state: 'learning', reviewCount: 1, consecutiveCorrect: 0, nextReviewAt: daysAgoIso(1) },
    });
    await saveVocab(ctx, 'learning-word', {
      review: { state: 'learning', reviewCount: 1, consecutiveCorrect: 0 },
    });
    await saveVocab(ctx, 'familiar-word', {
      review: { state: 'familiar', reviewCount: 4, consecutiveCorrect: 2, nextReviewAt: daysAgoIso(-5) },
    });
    await saveVocab(ctx, 'mastered-word', {
      review: { state: 'mastered', reviewCount: 9, consecutiveCorrect: 8, nextReviewAt: daysAgoIso(-10) },
    });
    await saveExpression(ctx, 'due idiom', {
      review: { state: 'learning', reviewCount: 1, consecutiveCorrect: 0, nextReviewAt: daysAgoIso(2) },
    });
    await saveExpression(ctx, 'mastered idiom', {
      review: { state: 'mastered', reviewCount: 7, consecutiveCorrect: 6, nextReviewAt: daysAgoIso(-8) },
    });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    expect(snapshot.vocabularyStatus).toEqual({
      total: 4, due: 1, learning: 1, familiar: 1, mastered: 1,
    });
    expect(snapshot.expressionStatus).toEqual({
      total: 2, due: 1, learning: 0, familiar: 0, mastered: 1,
    });
  });

  // --- 6. DUE REVIEW COUNT --- 7. FUTURE REVIEWS NOT DUE ---
  it('6 and 7. only reviews due at or before now count as due; future ones do not', async () => {
    await saveReviewItem(ctx, { dueAt: daysAgoIso(3) });
    await saveReviewItem(ctx, { dueAt: NOW });
    await saveReviewItem(ctx, { dueAt: daysAgoIso(-5), prompt: 'future review' });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    expect(snapshot.reviewStatus.dueCount).toBe(2);
    expect(snapshot.reviewStatus.upcoming.every((item) => item.dueAt <= NOW)).toBe(true);
    expect(snapshot.overview.reviewsDue).toBe(2);
  });

  // --- 8. ACTIVE WEAKNESS COUNTS ---
  it('8. active weakness counts unresolved weaknesses and keeps groups honest', async () => {
    await saveWeakness(ctx, { status: 'confirmed', occurrenceCount: 2 });
    await saveWeakness(ctx, { status: 'active_training', occurrenceCount: 4 });
    await saveWeakness(ctx, { status: 'mastered', occurrenceCount: 5 });
    await saveWeakness(ctx, { status: 'observed', resolved: true });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    expect(snapshot.overview.activeWeaknesses).toBe(3);
    const byGroup = new Map(snapshot.weaknessGroups.map((g) => [g.group, g.count]));
    expect(byGroup.get('needs_attention')).toBe(2);
    expect(byGroup.get('stable_mastered')).toBe(1);
    expect(byGroup.get('improving')).toBe(0);
    expect(byGroup.get('relapsed')).toBe(0);
    // resolved weaknesses are not listed
    expect(snapshot.weaknessCards).toHaveLength(3);
  });

  // --- 9/10/11. IMPROVING / STABLE-MASTERED / RELAPSED GROUPS ---
  it('9 to 11. lifecycle states map to presentation groups without rewriting persisted state', async () => {
    await saveWeakness(ctx, { status: 'improving', notes: 'improving one' });
    await saveWeakness(ctx, { status: 'stable', notes: 'stable one' });
    await saveWeakness(ctx, { status: 'mastered', notes: 'mastered one' });
    await saveWeakness(ctx, { status: 'relapsed', notes: 'relapsed one' });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    const byGroup = new Map(snapshot.weaknessGroups.map((g) => [g.group, g.count]));
    expect(byGroup.get('improving')).toBe(1);
    expect(byGroup.get('stable_mastered')).toBe(2);
    expect(byGroup.get('relapsed')).toBe(1);

    // Persisted states preserved verbatim on the cards:
    const statuses = snapshot.weaknessCards.map((card) => card.status).sort();
    expect(statuses).toEqual(['improving', 'mastered', 'relapsed', 'stable']);
  });

  // --- 12. OCCURRENCE COUNT PRESERVED ---
  it('12. weakness cards preserve occurrenceCount, notes, and latest evidence', async () => {
    const evidenceAt = daysAgoIso(0.5);
    await saveWeakness(ctx, {
      occurrenceCount: 7,
      notes: 'Yesterday I go',
      evidence: [{ at: evidenceAt, summary: 'Observed issue: "Yesterday I go" -> "Yesterday I went"' }],
    });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    expect(snapshot.weaknessCards).toHaveLength(1);
    const card = snapshot.weaknessCards[0];
    expect(card.occurrenceCount).toBe(7);
    expect(card.notes).toBe('Yesterday I go');
    expect(card.latestEvidence?.at).toBe(evidenceAt);
    expect(card.latestEvidence?.summary).toContain('Yesterday I went');
  });

  // --- 13. RECENT ACTIVITY ORDERING ---
  it('13. recent activity is ordered newest first', async () => {
    await saveVocab(ctx, 'old-word'); // created at fake-timer "now" below we control times via session/vocab creation order
    await saveSession(ctx, { startedAt: daysAgoIso(5) });
    await saveSession(ctx, { startedAt: daysAgoIso(1) });
    await saveReviewItem(ctx, { dueAt: daysAgoIso(0.2) });
    const reviewItem = (await ctx.review.list(ctx.learnerId)).find((r) => r.dueAt === daysAgoIso(0.2));
    await ctx.review.markReviewed(reviewItem!.id, 'correct', 'nice');

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    const times = snapshot.recentActivity.map((event) => event.at);
    const sorted = [...times].sort((a, b) => (a < b ? 1 : -1));
    expect(times).toEqual(sorted);
    expect(snapshot.recentActivity.length).toBeGreaterThanOrEqual(4);
  });

  // --- 14/15/16. WINDOWS --- 17. OLD ACTIVITY EXCLUDED ---
  it('14, 15, 16 and 17. window filters bound the activity timeline (7d / 30d / all)', async () => {
    // Vocabulary "saved" timestamps come from upsert time = fake now.
    // To control them, save at different fake times.
    vi.setSystemTime(new Date(daysAgoIso(40)));
    await saveVocab(ctx, 'ancient-word');
    vi.setSystemTime(new Date(daysAgoIso(20)));
    await saveVocab(ctx, 'month-old-word');
    vi.setSystemTime(new Date(daysAgoIso(3)));
    await saveVocab(ctx, 'recent-word');
    vi.setSystemTime(new Date(NOW));

    const in7 = await ctx.service.loadDashboard(ctx.learnerId, { window: '7d', now: NOW });
    expect(in7.recentActivity.map((e) => e.title)).toEqual(['Saved word: recent-word']);
    expect(in7.windowStart).toBe(daysAgoIso(7));

    const in30 = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });
    expect(in30.recentActivity.map((e) => e.title).sort()).toEqual(
      ['Saved word: month-old-word', 'Saved word: recent-word'].sort(),
    );

    const all = await ctx.service.loadDashboard(ctx.learnerId, { window: 'all', now: NOW });
    expect(all.recentActivity.map((e) => e.title).sort()).toEqual(
      ['Saved word: ancient-word', 'Saved word: month-old-word', 'Saved word: recent-word'].sort(),
    );
    expect(all.windowStart).toBeNull();
  });

  // --- 18. VOCABULARY ADDED APPEARS IN ACTIVITY ---
  it('18. a saved vocabulary item appears in the activity timeline', async () => {
    await saveVocab(ctx, 'serendipity', { type: 'word' });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });
    const event = snapshot.recentActivity.find((e) => e.kind === 'vocabulary');
    expect(event).toBeDefined();
    expect(event!.title).toBe('Saved word: serendipity');
  });

  // --- 19. EXPRESSION ADDED APPEARS IN ACTIVITY ---
  it('19. a saved expression appears in the activity timeline', async () => {
    await saveExpression(ctx, 'under the weather');

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });
    const event = snapshot.recentActivity.find((e) => e.kind === 'expression');
    expect(event).toBeDefined();
    expect(event!.title).toBe('Saved expression: under the weather');
  });

  // --- 20. REVIEW RESULT APPEARS WHEN EVIDENCE EXISTS ---
  it('20. a completed review appears in activity and recently-reviewed with its persisted result', async () => {
    await saveVocab(ctx, 'run');
    const item = await saveReviewItem(ctx, { dueAt: daysAgoIso(1) });
    await ctx.review.markReviewed(item.id, 'partial', 'close');

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    const recently = snapshot.reviewStatus.recentlyReviewed;
    expect(recently).toHaveLength(1);
    expect(recently[0].id).toBe(item.id);
    expect(recently[0].lastResult).toBe('partial');

    const event = snapshot.recentActivity.find((e) => e.kind === 'review');
    expect(event).toBeDefined();
    expect(event!.detail).toBe('Result: partial');
  });

  // --- 21. PROGRESS RECORD COUNT FIELDS ---
  it('21. persisted progress record count fields are surfaced correctly', async () => {
    await ctx.progress.record({
      learnerId: ctx.learnerId,
      recordedAt: daysAgoIso(1),
      windowStart: daysAgoIso(2),
      windowEnd: daysAgoIso(1),
      sessionsCompleted: 3,
      turnsCompleted: 18,
      newWordsLearned: 5,
      weaknessesImproved: 2,
      weaknessesWorsened: 1,
      notes: 'Adaptive review session: 4 correct.',
    });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    expect(snapshot.recentProgress).toHaveLength(1);
    const record = snapshot.recentProgress[0];
    expect(record.sessionsCompleted).toBe(3);
    expect(record.turnsCompleted).toBe(18);
    expect(record.newWordsLearned).toBe(5);
    expect(record.weaknessesImproved).toBe(2);
    expect(record.weaknessesWorsened).toBe(1);
    expect(record.notes).toContain('Adaptive review session');

    // Progress records also feed the activity timeline with real counts.
    const event = snapshot.recentActivity.find((e) => e.kind === 'progress');
    expect(event).toBeDefined();
    expect(event!.detail).toContain('3 sessions');
  });

  // --- 22. SCORE FIELDS NOT PROMOTED ---
  it('22. legacy numeric score fields are never promoted into the dashboard', async () => {
    await ctx.progress.record({
      learnerId: ctx.learnerId,
      recordedAt: daysAgoIso(1),
      windowStart: daysAgoIso(2),
      windowEnd: daysAgoIso(1),
      sessionsCompleted: 1,
      turnsCompleted: 6,
      newWordsLearned: 2,
      weaknessesImproved: 0,
      weaknessesWorsened: 0,
      // legacy score fields persisted in the row:
      listeningScore: 0.99,
      speakingScore: 0.97,
      fluencyScore: 0.95,
      confidenceScore: 0.93,
      pronunciationScore: 0.91,
      grammarScore: 0.89,
      vocabularyScore: 0.87,
    });
    await saveWeakness(ctx, { status: 'active_training' });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '30d', now: NOW });

    const serialized = JSON.stringify(snapshot);
    for (const scoreField of [
      'listeningScore', 'speakingScore', 'fluencyScore', 'confidenceScore',
      'pronunciationScore', 'grammarScore', 'vocabularyScore',
    ]) {
      expect(serialized.includes(scoreField)).toBe(false);
    }
    // and no 0..1 fake score values leak through recentProgress:
    expect(snapshot.recentProgress[0]).not.toHaveProperty('listeningScore');
  });

  // --- 24. INJECTED REPOSITORIES (non-SQLite deps) ---
  it('24. the service works with any injected repositories, no SQLite required', async () => {
    const reviewItem = {
      id: '8c2a4d1e-6b3f-4a90-8e17-5d0c9b2f7a31',
      learnerId: 'learner-1',
      kind: 'vocabulary' as const,
      referenceId: '8c2a4d1e-6b3f-4a90-8e17-5d0c9b2f7a32',
      prompt: 'Due prompt',
      state: 'learning' as const,
      dueAt: daysAgoIso(1),
      createdAt: daysAgoIso(2),
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    };
    const injected = new ProgressDashboardService({
      profile: { get: async () => ({ id: 'learner-1' }) as UserProfile },
      conversations: { listSessions: async () => [] },
      weaknesses: { listWeaknesses: async () => [] },
      vocabulary: { list: async () => [] },
      expressions: { list: async () => [] },
      review: { listDue: async () => [reviewItem] },
      progress: { list: async () => [] },
    });

    const snapshot = await injected.loadDashboard('learner-1', { window: '7d', now: NOW });
    expect(snapshot.learnerId).toBe('learner-1');
    expect(snapshot.overview.reviewsDue).toBe(1);
    expect(snapshot.reviewStatus.upcoming[0].prompt).toBe('Due prompt');
  });

  // --- 26. LOAD FAILURE SURFACES (retry path) ---
  it('26. a repository failure propagates instead of returning fabricated data', async () => {
    const failing = new ProgressDashboardService({
      profile: { get: async () => ({ id: 'learner-1' }) as UserProfile },
      conversations: { listSessions: async () => { throw new Error('SQLite read failed'); } },
      weaknesses: { listWeaknesses: async () => [] },
      vocabulary: { list: async () => [] },
      expressions: { list: async () => [] },
      review: { listDue: async () => [] },
      progress: { list: async () => [] },
    });

    await expect(failing.loadDashboard('learner-1', { window: '30d', now: NOW })).rejects.toThrow(
      'SQLite read failed',
    );
  });

  // --- TREND BUCKETS ---
  it('trends count real activity per bucket and separate activity from learning state', async () => {
    vi.setSystemTime(new Date(daysAgoIso(2)));
    await saveVocab(ctx, 'trend-word');
    vi.setSystemTime(new Date(NOW));
    await saveSession(ctx, { startedAt: daysAgoIso(0.5), turnCount: 5 });

    const snapshot = await ctx.service.loadDashboard(ctx.learnerId, { window: '7d', now: NOW });

    expect(snapshot.trends).toHaveLength(7);
    const total = snapshot.trends.reduce((sum, bucket) => sum + bucket.total, 0);
    expect(total).toBe(2); // one vocabulary save + one session
    const sessionsBucket = snapshot.trends.find((b) => b.sessions > 0);
    expect(sessionsBucket).toBeDefined();
    const vocabBucket = snapshot.trends.find((b) => b.vocabulary > 0);
    expect(vocabBucket).toBeDefined();
  });
});

// --- 25/27. SCREEN COMPOSITION CONTRACT (structural checks) ---

describe('ProgressScreen composition contract', () => {
  const screenSource = readFileSync(
    join(process.cwd(), 'src', 'screens', 'ProgressScreen.tsx'),
    'utf8',
  );

  it('25. the screen does not import or compose SQLite directly', () => {
    expect(screenSource.includes('ExpoSqliteAdapter')).toBe(false);
    expect(screenSource.includes('DatabaseAdapter')).toBe(false);
    expect(screenSource.includes('SQLite')).toBe(false);
    expect(screenSource.includes('createDefaultProgressDashboardService')).toBe(true);
    // An injected service must work without any adapter in the screen:
    expect(screenSource.includes('service?: ProgressDashboardService')).toBe(true);
  });

  it('27. Review Now navigates to the existing Review flow', () => {
    expect(screenSource.includes("navigation.navigate('Review')")).toBe(true);
  });

  it('the screen never renders legacy score fields or fabricated percentages', () => {
    for (const banned of [
      'listeningScore', 'speakingScore', 'fluencyScore', 'confidenceScore',
      'pronunciationScore', 'grammarScore', 'vocabularyScore', 'CEFR',
    ]) {
      expect(screenSource.includes(banned)).toBe(false);
    }
  });
});
