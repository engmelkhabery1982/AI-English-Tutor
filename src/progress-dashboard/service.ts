/**
 * src/progress-dashboard/service.ts
 *
 * ProgressDashboardService: a read-only dashboard over the EXISTING
 * repositories (conversations, weaknesses, vocabulary, expressions,
 * review, progress) and the learner profile.
 *
 * - No new persistence, no analytics database, no fabricated values.
 * - Lexical status counts reuse the shared vocabulary-workspace bucket
 *   helpers (same authoritative meaning.review logic).
 * - Weakness lifecycle states are grouped for presentation but never
 *   collapsed or rewritten in data.
 * - The recent-activity timeline is merged read-only from existing
 *   timestamps; no event is invented without persisted evidence.
 * - Legacy numeric skill-score fields are intentionally never promoted
 *   into the view model.
 */

import type { IsoDate, WeaknessStatus } from '../domain/shared/types';
import type { LearnerWeakness } from '../domain/models/learner';
import type { ReviewItem } from '../domain/models/learning';
import type { ExpressionItem, VocabularyItem } from '../domain/models/vocabulary';
import type {
  ConversationRepository,
  ExpressionRepository,
  ProgressRepository,
  ReviewRepository,
  UserProfileRepository,
  VocabularyRepository,
  WeaknessRepository,
} from '../repositories';
import { summarizeWorkspace, toWorkspaceEntry } from '../vocabulary-workspace';
import type {
  ActivityEventKind,
  ActivityEventView,
  DashboardWindow,
  LexicalStatusCounts,
  OverviewStats,
  ProgressDashboardSnapshot,
  ProgressRecordView,
  ReviewNowAction,
  ReviewStatusView,
  TrendBucket,
  WeaknessCardView,
  WeaknessGroupCount,
  WeaknessPresentationGroup,
} from './types';
import { DEFAULT_WINDOW } from './types';

/** Bound sizes — the dashboard never loads unbounded history. */
const LIMITS = {
  sessions: 50,
  weaknesses: 200,
  vocabulary: 500,
  expressions: 500,
  dueReviews: 200,
  recentReviews: 50,
  progressRecords: 30,
  activityEvents: 30,
  weaknessCards: 50,
  evidencePerWeakness: 3,
  upcomingReviews: 5,
  recentlyReviewed: 5,
  recentProgress: 10,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export interface ProgressDashboardServiceDeps {
  /** Existing profile repository — the only source of the learner id. */
  readonly profile?: Pick<UserProfileRepository, 'get'>;
  readonly conversations: Pick<ConversationRepository, 'listSessions'>;
  readonly weaknesses: Pick<WeaknessRepository, 'listWeaknesses'>;
  readonly vocabulary: Pick<VocabularyRepository, 'list'>;
  readonly expressions: Pick<ExpressionRepository, 'list'>;
  /** Existing review repository; optional list() powers "recently reviewed". */
  readonly review: Pick<ReviewRepository, 'listDue'> & {
    readonly list?: ReviewRepository['list'];
  };
  readonly progress: Pick<ProgressRepository, 'list'>;

  // ----- Optional EXACT aggregate reads (preferred over bounded lists) -----
  readonly conversationStats?: ConversationRepository['getActivityStats'];
  readonly vocabularyBuckets?: VocabularyRepository['getBucketCounts'];
  readonly vocabularyCreatedCount?: VocabularyRepository['countCreated'];
  readonly expressionBuckets?: ExpressionRepository['getBucketCounts'];
  readonly expressionCreatedCount?: ExpressionRepository['countCreated'];
  readonly weaknessStatusCounts?: WeaknessRepository['getUnresolvedStatusCounts'];
  readonly weaknessCreatedCount?: WeaknessRepository['countUnresolved'];
  readonly weaknessEvidenceCount?: WeaknessRepository['countEvidence'];
  readonly dueReviewCount?: ReviewRepository['countDue'];
  readonly reviewedCount?: ReviewRepository['countReviewed'];
  readonly progressRecordCount?: ProgressRepository['countRecords'];
}

/** Format an ISO date as a short stable label, e.g. "Sep 12". */
function shortDateLabel(iso: IsoDate): string {
  const date = new Date(iso);
  return `${MONTH_ABBREVIATIONS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** Format an ISO date as a month label, e.g. "Sep 2026". */
function monthLabel(iso: IsoDate): string {
  const date = new Date(iso);
  return `${MONTH_ABBREVIATIONS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Inclusive window start for a dashboard window, or null for all-time. */
export function resolveWindowStart(window: DashboardWindow, now: IsoDate): IsoDate | null {
  const nowMs = new Date(now).getTime();
  if (window === '7d') return new Date(nowMs - 7 * DAY_MS).toISOString();
  if (window === '30d') return new Date(nowMs - 30 * DAY_MS).toISOString();
  return null;
}

/** Map a persisted weakness lifecycle state to its presentation group. */
export function weaknessPresentationGroup(status: WeaknessStatus): WeaknessPresentationGroup {
  if (status === 'improving') return 'improving';
  if (status === 'stable' || status === 'mastered') return 'stable_mastered';
  if (status === 'relapsed') return 'relapsed';
  // observed / repeated / confirmed / active_training still need work.
  return 'needs_attention';
}

const GROUP_LABELS: Readonly<Record<WeaknessPresentationGroup, string>> = {
  needs_attention: 'Needs attention',
  improving: 'Improving',
  stable_mastered: 'Stable / Mastered',
  relapsed: 'Relapsed',
};

/** Whether the UI should offer "Review now" (and where it leads). */
export function resolveReviewNowAction(reviewStatus: ReviewStatusView): ReviewNowAction {
  return reviewStatus.dueCount > 0 ? 'navigate-review' : 'show-caught-up';
}

/** Latest persisted outcome of a review item, if any. */
function latestReviewOutcome(
  item: ReviewItem,
): { at: IsoDate; result: 'correct' | 'partial' | 'incorrect' } | null {
  let latest: { at: IsoDate; result: 'correct' | 'partial' | 'incorrect' } | null = null;
  for (const outcome of item.outcomeHistory ?? []) {
    if (!latest || outcome.at > latest.at) {
      latest = { at: outcome.at, result: outcome.result };
    }
  }
  return latest;
}

/** Lexical status counts from the shared, authoritative bucket logic. */
function lexicalStatusCountsOf(
  items: readonly (VocabularyItem | ExpressionItem)[],
  kind: 'vocabulary' | 'expression',
  now: IsoDate,
): LexicalStatusCounts {
  const entries = items.map((item) => toWorkspaceEntry(item, kind, now));
  const summary = summarizeWorkspace(entries);
  return {
    total: summary.totalSaved,
    due: summary.dueNow,
    learning: summary.learning,
    familiar: summary.familiar,
    mastered: summary.mastered,
  };
}

export class ProgressDashboardService {
  constructor(private readonly deps: ProgressDashboardServiceDeps) {}

  /**
   * Resolve the active learner through the existing profile repository.
   * Returns null when no profile exists yet; never fabricates an id.
   */
  async getActiveLearnerId(): Promise<string | null> {
    if (!this.deps.profile) return null;
    try {
      const profile = await this.deps.profile.get();
      if (profile && profile.id) return profile.id;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Load the full read-only dashboard snapshot. Repository failures
   * propagate to the caller (the screen shows retry); no fabricated data
   * is ever returned in their place.
   */
  async loadDashboard(
    learnerId: string,
    options?: { window?: DashboardWindow; now?: IsoDate },
  ): Promise<ProgressDashboardSnapshot> {
    const now = options?.now ?? new Date().toISOString();
    const window = options?.window ?? DEFAULT_WINDOW;
    const windowStart = resolveWindowStart(window, now);
    const inWindow = (at: IsoDate): boolean =>
      windowStart === null ? true : at >= windowStart && at <= now;

    // Exact aggregates (preferred) versus bounded detail lists: totals are
    // computed with aggregate COUNT/SUM queries so they stay correct beyond
    // any display limit; only detail/timeline lists are bounded.
    const d = this.deps;
    const hasAggregates = Boolean(
      d.conversationStats &&
        d.vocabularyBuckets &&
        d.vocabularyCreatedCount &&
        d.expressionBuckets &&
        d.expressionCreatedCount &&
        d.weaknessStatusCounts &&
        d.dueReviewCount,
    );

    // Bounded parallel detail reads — no unbounded history, no N+1 loops.
    const [sessions, weaknesses, vocabList, exprList, dueReviews, recentReviews, progressRecords] =
      await Promise.all([
        d.conversations.listSessions(learnerId, LIMITS.sessions),
        d.weaknesses.listWeaknesses(learnerId, LIMITS.weaknesses),
        // word/phrase rows only — expression rows share the table under other types.
        d.vocabulary.list(learnerId, { limit: LIMITS.vocabulary, types: ['word', 'phrase'] }),
        d.expressions.list(learnerId, { limit: LIMITS.expressions }),
        d.review.listDue(learnerId, now, LIMITS.dueReviews),
        d.review.list
          ? d.review.list(learnerId, LIMITS.recentReviews)
          : Promise.resolve([]),
        d.progress.list(learnerId, LIMITS.progressRecords),
      ]);

    // ---------- EXACT AGGREGATES (when the composition provides them) ----------
    const [conversationStats, vocabBuckets, exprBuckets, weaknessCounts, exactDueCount] =
      hasAggregates
        ? await Promise.all([
            d.conversationStats!(learnerId),
            d.vocabularyBuckets!(learnerId, { now, types: ['word', 'phrase'] }),
            d.expressionBuckets!(learnerId, { now }),
            d.weaknessStatusCounts!(learnerId),
            d.dueReviewCount!(learnerId, now),
          ])
        : [null, null, null, null, null];

    // ---------- OVERVIEW (exact totals, bounded fallback) ----------
    const overview: OverviewStats = conversationStats
      ? {
          sessionsCompleted: conversationStats.sessionsCompleted,
          conversationTurns: conversationStats.turnsTotal,
          vocabularySaved: vocabBuckets!.total,
          expressionsSaved: exprBuckets!.total,
          reviewsDue: exactDueCount!,
          activeWeaknesses: weaknessCounts!.unresolved,
        }
      : {
          sessionsCompleted: sessions.filter(
            (s) => s.status === 'completed' || s.status === 'summarized',
          ).length,
          conversationTurns: sessions.reduce((sum, s) => sum + (s.turnCount ?? 0), 0),
          vocabularySaved: vocabList.length,
          expressionsSaved: exprList.length,
          reviewsDue: dueReviews.length,
          activeWeaknesses: weaknesses.filter((w) => !w.resolved).length,
        };

    // ---------- LEARNING STATUS (exact, shared meaning.review semantics) ----------
    const vocabularyStatus: LexicalStatusCounts = vocabBuckets ?? {
      ...lexicalStatusCountsOf(vocabList, 'vocabulary', now),
    };
    const expressionStatus: LexicalStatusCounts = exprBuckets ?? {
      ...lexicalStatusCountsOf(exprList, 'expression', now),
    };

    // ---------- WEAKNESS STATUS (exact group counts, bounded cards) ----------
    let weaknessGroups: WeaknessGroupCount[];
    if (weaknessCounts) {
      const groupTotals = new Map<WeaknessPresentationGroup, number>();
      for (const [status, count] of Object.entries(weaknessCounts.byStatus)) {
        const group = weaknessPresentationGroup(status as WeaknessStatus);
        groupTotals.set(group, (groupTotals.get(group) ?? 0) + (count ?? 0));
      }
      weaknessGroups = (
        ['needs_attention', 'improving', 'stable_mastered', 'relapsed'] as const
      ).map((group) => ({
        group,
        label: GROUP_LABELS[group],
        count: groupTotals.get(group) ?? 0,
      }));
    } else {
      const unresolved = weaknesses.filter((w) => !w.resolved);
      const groupCounts = new Map<WeaknessPresentationGroup, number>();
      for (const weakness of unresolved) {
        const group = weaknessPresentationGroup(weakness.status);
        groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
      }
      weaknessGroups = (
        ['needs_attention', 'improving', 'stable_mastered', 'relapsed'] as const
      ).map((group) => ({
        group,
        label: GROUP_LABELS[group],
        count: groupCounts.get(group) ?? 0,
      }));
    }

    const weaknessCards: WeaknessCardView[] = weaknesses
      .filter((w) => !w.resolved)
      .slice(0, LIMITS.weaknessCards)
      .map((weakness) => weaknessToCard(weakness));

    // ---------- REVIEW STATUS (exact due count, bounded lists) ----------
    const recentlyReviewed = recentReviews
      .filter((item) => item.lastReviewAt != null)
      .sort((a, b) => (a.lastReviewAt! < b.lastReviewAt! ? 1 : -1))
      .slice(0, LIMITS.recentlyReviewed)
      .map((item) => {
        const outcome = latestReviewOutcome(item);
        return {
          id: item.id,
          kind: item.kind,
          lastReviewAt: item.lastReviewAt!,
          lastResult: outcome?.result,
        };
      });

    const reviewStatus: ReviewStatusView = {
      dueCount: exactDueCount ?? dueReviews.length,
      upcoming: dueReviews.slice(0, LIMITS.upcomingReviews).map((item) => ({
        id: item.id,
        kind: item.kind,
        prompt: item.prompt,
        dueAt: item.dueAt,
      })),
      recentlyReviewed,
    };

    // ---------- RECENT ACTIVITY (bounded merged read-only timeline) ----------
    const allEvents = buildActivityTimeline({
      learnerId,
      sessions,
      weaknesses: weaknesses.filter((w) => !w.resolved),
      vocabulary: vocabList,
      expressions: exprList,
      recentReviews,
      progressRecords,
    });
    const windowEvents = allEvents.filter((event) => inWindow(event.at));
    const recentActivity = windowEvents.slice(0, LIMITS.activityEvents);

    // ---------- TRENDS (exact aggregate counts, bounded fallback) ----------
    const trends = hasAggregates
      ? await this.buildExactTrends(learnerId, window, now, windowStart)
      : buildBoundedTrends(window, now, windowStart, windowEvents);

    // ---------- RECENT PROGRESS RECORDS (count fields only) ----------
    const recentProgress: ProgressRecordView[] = progressRecords
      .slice(0, LIMITS.recentProgress)
      .map((record) => ({
        recordedAt: record.recordedAt,
        windowStart: record.windowStart,
        windowEnd: record.windowEnd,
        sessionsCompleted: record.sessionsCompleted ?? 0,
        turnsCompleted: record.turnsCompleted ?? 0,
        newWordsLearned: record.newWordsLearned ?? 0,
        weaknessesImproved: record.weaknessesImproved ?? 0,
        weaknessesWorsened: record.weaknessesWorsened ?? 0,
        notes: record.notes,
      }));

    return {
      learnerId,
      window,
      windowStart,
      generatedAt: now,
      aggregatesExact: hasAggregates,
      overview,
      vocabularyStatus,
      expressionStatus,
      weaknessGroups,
      weaknessCards,
      reviewStatus,
      recentActivity,
      trends,
      recentProgress,
    };
  }

  /**
   * Exact per-bucket activity counts via aggregate queries — trend totals
   * are never truncated by the bounded detail-list limits.
   */
  private async buildExactTrends(
    learnerId: string,
    window: DashboardWindow,
    now: IsoDate,
    windowStart: IsoDate | null,
  ): Promise<TrendBucket[]> {
    const ranges = buildTrendRanges(window, now, windowStart);
    const d = this.deps;

    const buckets = await Promise.all(
      ranges.map(async (range) => {
        const [sessions, vocabulary, expressions, reviews, weaknessFirstSeen, weaknessEvidence, progressRows] =
          await Promise.all([
            d.conversationStats!(learnerId, {
              startedAfter: range.rangeStart,
              startedUntil: range.rangeEnd,
            }),
            d.vocabularyCreatedCount!(learnerId, {
              createdAfter: range.rangeStart,
              createdUntil: range.rangeEnd,
            }),
            d.expressionCreatedCount!(learnerId, {
              createdAfter: range.rangeStart,
              createdUntil: range.rangeEnd,
            }),
            d.reviewedCount
              ? d.reviewedCount(learnerId, {
                  lastReviewAfter: range.rangeStart,
                  lastReviewUntil: range.rangeEnd,
                })
              : Promise.resolve(0),
            d.weaknessCreatedCount
              ? d.weaknessCreatedCount(learnerId, {
                  firstSeenAfter: range.rangeStart,
                  firstSeenUntil: range.rangeEnd,
                })
              : Promise.resolve(0),
            d.weaknessEvidenceCount
              ? d.weaknessEvidenceCount(learnerId, {
                  atAfter: range.rangeStart,
                  atUntil: range.rangeEnd,
                })
              : Promise.resolve(0),
            d.progressRecordCount
              ? d.progressRecordCount(learnerId, {
                  recordedAfter: range.rangeStart,
                  recordedUntil: range.rangeEnd,
                })
              : Promise.resolve(0),
          ]);

        const weaknessEvents = weaknessFirstSeen + weaknessEvidence;
        return {
          label: range.label,
          rangeStart: range.rangeStart,
          rangeEnd: range.rangeEnd,
          total: sessions.sessionsTotal + vocabulary + expressions + reviews + weaknessEvents + progressRows,
          sessions: sessions.sessionsTotal,
          vocabulary,
          expressions,
          reviews,
        } satisfies TrendBucket;
      }),
    );

    return buckets;
  }
}

/** Reduce a persisted weakness to its card view, preserving stored state. */
function weaknessToCard(weakness: LearnerWeakness): WeaknessCardView {
  let latestEvidence: WeaknessCardView['latestEvidence'];
  for (const evidence of weakness.evidence ?? []) {
    if (!latestEvidence || evidence.at > latestEvidence.at) {
      latestEvidence = { at: evidence.at, summary: evidence.summary };
    }
  }

  return {
    id: weakness.id,
    type: weakness.type,
    status: weakness.status,
    occurrenceCount: weakness.occurrenceCount,
    firstSeenAt: weakness.firstSeenAt,
    lastSeenAt: weakness.lastSeenAt,
    updatedAt: weakness.updatedAt,
    notes: weakness.notes,
    contexts: weakness.contexts ?? [],
    latestEvidence,
  };
}

interface TimelineInput {
  readonly learnerId: string;
  readonly sessions: Awaited<ReturnType<ConversationRepository['listSessions']>>;
  readonly weaknesses: readonly LearnerWeakness[];
  readonly vocabulary: readonly { id: string; headword: string; createdAt: IsoDate }[];
  readonly expressions: readonly { id: string; expression: string; createdAt: IsoDate }[];
  readonly recentReviews: readonly ReviewItem[];
  readonly progressRecords: readonly {
    id: string;
    recordedAt: IsoDate;
    sessionsCompleted: number;
    turnsCompleted: number;
    newWordsLearned: number;
  }[];
}

/**
 * Merge persisted timestamps into one read-only activity timeline.
 * Every entry cites a real persisted row; nothing is invented.
 */
function buildActivityTimeline(input: TimelineInput): ActivityEventView[] {
  const events: ActivityEventView[] = [];

  for (const session of input.sessions) {
    events.push({
      id: `session:${session.id}`,
      at: session.startedAt,
      kind: 'session',
      title: `Conversation session (${session.mode})`,
      detail:
        session.turnCount > 0
          ? `${session.turnCount} ${session.turnCount === 1 ? 'turn' : 'turns'}`
          : undefined,
    });
  }

  for (const vocab of input.vocabulary) {
    events.push({
      id: `vocabulary:${vocab.id}`,
      at: vocab.createdAt,
      kind: 'vocabulary',
      title: `Saved word: ${vocab.headword}`,
    });
  }

  for (const expression of input.expressions) {
    events.push({
      id: `expression:${expression.id}`,
      at: expression.createdAt,
      kind: 'expression',
      title: `Saved expression: ${expression.expression}`,
    });
  }

  for (const weakness of input.weaknesses) {
    events.push({
      id: `weakness-start:${weakness.id}`,
      at: weakness.firstSeenAt,
      kind: 'weakness',
      title: `Weakness first observed (${weakness.type})`,
      detail: weakness.notes,
    });

    const evidence = [...(weakness.evidence ?? [])]
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, LIMITS.evidencePerWeakness);
    for (const entry of evidence) {
      events.push({
        id: `weakness-evidence:${entry.id}`,
        at: entry.at,
        kind: 'weakness',
        title: `Weakness evidence (${weakness.status.replace('_', ' ')})`,
        detail: entry.summary,
      });
    }
  }

  for (const item of input.recentReviews) {
    if (!item.lastReviewAt) continue;
    const outcome = latestReviewOutcome(item);
    events.push({
      id: `review:${item.id}:${item.lastReviewAt}`,
      at: item.lastReviewAt,
      kind: 'review',
      title: 'Review completed',
      detail: outcome ? `Result: ${outcome.result}` : undefined,
    });
  }

  for (const record of input.progressRecords) {
    const parts: string[] = [];
    if (record.sessionsCompleted > 0) parts.push(`${record.sessionsCompleted} sessions`);
    if (record.turnsCompleted > 0) parts.push(`${record.turnsCompleted} turns`);
    if (record.newWordsLearned > 0) parts.push(`${record.newWordsLearned} new words`);
    events.push({
      id: `progress:${record.id}`,
      at: record.recordedAt,
      kind: 'progress',
      title: 'Progress recorded',
      detail: parts.length > 0 ? parts.join(' · ') : undefined,
    });
  }

  return events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/**
 * Build honest count buckets for the selected window.
 * Buckets count ACTIVITY only — learning-state changes are shown from
 * current persisted states (weaknessGroups / lexical status), never inferred.
 */
/** One date range of the trend axis: [rangeStart, rangeEnd). */
interface TrendRange {
  readonly label: string;
  readonly rangeStart: IsoDate;
  readonly rangeEnd: IsoDate;
}

/** Build the trend axis ranges for a window (shared by both count paths). */
function buildTrendRanges(
  window: DashboardWindow,
  now: IsoDate,
  windowStart: IsoDate | null,
): TrendRange[] {
  const ranges: TrendRange[] = [];
  const nowMs = new Date(now).getTime();

  if (window === '7d') {
    for (let i = 7; i >= 1; i--) {
      const start = new Date(nowMs - i * DAY_MS).toISOString();
      const end = new Date(nowMs - (i - 1) * DAY_MS).toISOString();
      ranges.push({ label: shortDateLabel(start), rangeStart: start, rangeEnd: end });
    }
  } else if (window === '30d') {
    const startMs = new Date(windowStart ?? now).getTime();
    const span = (nowMs - startMs) / 5;
    for (let i = 0; i < 5; i++) {
      const start = new Date(startMs + i * span).toISOString();
      const end = new Date(startMs + (i + 1) * span).toISOString();
      ranges.push({ label: shortDateLabel(start), rangeStart: start, rangeEnd: end });
    }
  } else {
    // All time: the six most recent calendar months, plus an "Older" bucket
    // when persisted activity predates them.
    const anchor = new Date(now);
    const monthStart = (year: number, month: number) =>
      new Date(Date.UTC(year, month, 1)).toISOString();
    for (let back = 5; back >= 0; back--) {
      const start = monthStart(anchor.getUTCFullYear(), anchor.getUTCMonth() - back);
      const end = monthStart(anchor.getUTCFullYear(), anchor.getUTCMonth() - back + 1);
      ranges.push({ label: monthLabel(start), rangeStart: start, rangeEnd: end });
    }
    ranges.push({
      label: 'Older',
      rangeStart: '1970-01-01T00:00:00.000Z',
      rangeEnd: ranges[0].rangeStart,
    });
  }

  return ranges;
}

/**
 * Bounded fallback: count loaded timeline events into the trend ranges.
 * Used only when the composition provides no aggregate reads — totals in
 * this mode reflect the loaded detail lists, and the snapshot is marked
 * aggregatesExact: false so the UI labels them honestly.
 */
function buildBoundedTrends(
  window: DashboardWindow,
  now: IsoDate,
  windowStart: IsoDate | null,
  events: readonly ActivityEventView[],
): TrendBucket[] {
  const kindKey: Record<ActivityEventKind, keyof TrendBucket | undefined> = {
    session: 'sessions',
    vocabulary: 'vocabulary',
    expression: 'expressions',
    review: 'reviews',
    weakness: undefined,
    progress: undefined,
  };

  type MutableTrendBucket = { -readonly [K in keyof TrendBucket]: TrendBucket[K] };
  const ranges = buildTrendRanges(window, now, windowStart);
  const buckets: MutableTrendBucket[] = ranges.map((range) => ({
    label: range.label,
    rangeStart: range.rangeStart,
    rangeEnd: range.rangeEnd,
    total: 0,
    sessions: 0,
    vocabulary: 0,
    expressions: 0,
    reviews: 0,
  }));

  for (const event of events) {
    for (let i = 0; i < buckets.length; i++) {
      if (event.at >= ranges[i].rangeStart && event.at < ranges[i].rangeEnd) {
        buckets[i].total += 1;
        const key = kindKey[event.kind];
        if (key) {
          (buckets[i][key] as number) += 1;
        }
        break;
      }
    }
  }

  return buckets;
}
