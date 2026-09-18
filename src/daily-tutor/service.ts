/**
 * src/daily-tutor/service.ts
 *
 * DailyTutorService — the ONE orchestration layer of the Daily Tutor Loop.
 *
 * WHAT IT OWNS
 * - Collecting REAL planning context (one refresh of the EXISTING LearnerModel
 *   plus bounded repository reads) and building today's plan through the
 *   deterministic planner.
 * - Durable load-or-create of today's session through the DailyTutor
 *   repository: the persisted plan for a learner/date is resumed, never
 *   silently regenerated.
 * - Daily Tutor session/activity state transitions only: start, complete,
 *   skip, advance, complete-the-day.
 * - Mapping real child-workflow completions onto daily activities (the
 *   completion handshake in ./completion.ts).
 *
 * WHAT IT NEVER OWNS
 * - STT/TTS, the Conversation Engine, review algorithms, curriculum priority
 *   internals, pronunciation evaluation, listening evaluation or Deep
 *   Speaking logic — those stay in their existing modules, and each child
 *   system persists ITS OWN evidence exactly once. This service never writes
 *   learner evidence a second time.
 *
 * HONESTY RULES
 * - Planning is deterministic and local (no AI, no network): same learner +
 *   date + evidence → the same plan, so Home never re-rolls the day.
 * - A child completion with zero practiced items never completes an activity.
 * - Opening a child screen is never completion.
 * - No scores/percentages/CEFR anywhere; the view layer is count-based.
 *
 * RACE / RECOVERY RULES
 * - Concurrent getToday() calls share one in-flight promise.
 * - All mutations are serialized through an internal queue; each mutation
 *   re-reads the persisted session before deciding.
 * - The repository's UNIQUE(learner_id, date_key) makes concurrent creates
 *   safe (the loser loads the winner's session).
 * - Structurally corrupt persisted sessions are deleted and replaced by a
 *   fresh plan (safe recovery); anything unrecoverable is reported honestly
 *   without touching data.
 * - All transitions are idempotent: repeated Start/Complete/Skip taps settle
 *   into the same persisted state.
 */

import { planCurriculum } from '../curriculum';
import { getSkill } from '../curriculum/catalog';
import type {
  CurriculumPlan,
  CurriculumPlannerInput,
  SkillEvidenceSnapshot,
  SkillLifecycleState,
} from '../curriculum/types';
import type { LearnerModel } from '../learner-model';
import { parseWeaknessIdentity } from '../listening/generator';
import {
  SCENARIO_CATEGORIES,
  planProfessionalScenario,
  toProfessionalLearnerContext,
  toSpeakingPlannerOptions,
} from '../professional-english';
import type { ScenarioCategory } from '../professional-english';
import type {
  DailyTutorRepository,
  DailyTutorSessionRecord,
  DailyTutorActivityRecord,
  CreateDailyTutorSessionInput,
} from '../repositories';
import type { UserProfileRepository } from '../repositories';
import type { IsoDate } from '../domain/shared/types';
import { toDateKey } from './date';
import {
  planDailyTutorSession,
  mapLearningGoalsToCurriculumHints,
  weaknessStatusPriority,
} from './planner';
import { buildChildRoute } from './navigation';
import type { DailyTutorChildRoute, BuildChildRouteExtras } from './navigation';
import { currentActivityOf } from './view';
import type {
  DailyTutorChildCompletion,
  DailyTutorPlan,
  DailyTutorSession,
  DailyTutorPlanningInput,
  DailyTutorWeaknessEvidence,
} from './types';
import { DAILY_ACTIVITY_KINDS } from './types';

/* ------------------------------------------------------------------ *
 * Bounds (all reads bounded)
 * ------------------------------------------------------------------ */

const WEAKNESS_LIMIT = 60;
const PRONUNCIATION_ROW_LIMIT = 8;
const DUE_QUEUE_BREAKDOWN_LIMIT = 20;
const RECENT_SESSION_LIMIT = 4;
/** Curriculum recommendations consumed per plan. */
const CURRICULUM_MAX_ITEMS = 5;

const NO_PROFILE_MESSAGE =
  'No learner profile yet. Set up your learning plan first — then today\u2019s practice will be built around you.';

const UNAVAILABLE_MESSAGE =
  'Your daily practice could not be prepared right now. Nothing was changed.';

/** The slice of the EXISTING learner model the Daily Tutor reads. */
export type DailyTutorModelPort = Pick<
  LearnerModel,
  | 'refresh'
  | 'getCoachingContext'
  | 'getActiveWeaknesses'
  | 'getDueReview'
  | 'weaknesses'
  | 'pronunciationWeaknesses'
>;

export interface DailyTutorServiceDeps {
  readonly repository: DailyTutorRepository;
  readonly learnerModel: DailyTutorModelPort;
  /** Used only to resolve the real learner id (never to invent one). */
  readonly profile?: Pick<UserProfileRepository, 'get'>;
  /** Injectable curriculum planner (defaults to the EXISTING one). */
  readonly curriculumPlanner?: (input: CurriculumPlannerInput) => CurriculumPlan;
  /** Injectable clock (tests); defaults to the real time. */
  readonly now?: () => IsoDate;
  /**
   * Injectable UTC offset in minutes (east positive) for local date keys.
   * Defaults to the device offset at the composition edge.
   */
  readonly timeZoneOffsetMinutes?: () => number;
}

export type DailyTutorTodayResult =
  | { readonly status: 'ready'; readonly session: DailyTutorSession }
  | { readonly status: 'no-profile'; readonly message: string; readonly session: null }
  | { readonly status: 'unavailable'; readonly message: string; readonly session: null };

/**
 * Result of applying a drained batch of child completions. The
 * applied/rejected/retryable split is what makes the completion inbox
 * retry-safe: applied and rejected ids are acknowledged (final), while
 * retryable completions MUST be re-queued and retried later.
 */
export interface DailyTutorCompletionBatchResult {
  /** Today's session after the batch, when known. */
  readonly session: DailyTutorSession | null;
  /** Activity ids settled (now, or idempotently already complete). */
  readonly appliedActivityIds: readonly string[];
  /**
   * Activity ids permanently ignored: stale/foreign/mismatched/skipped, or
   * reported without real practice evidence. Retrying can never succeed.
   */
  readonly rejectedActivityIds: readonly string[];
  /** Completions that MUST be retried later (transient storage failures). */
  readonly retryable: readonly DailyTutorChildCompletion[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const SESSION_STATUSES: ReadonlySet<string> = new Set([
  'planned',
  'in_progress',
  'completed',
  'abandoned',
]);
const ACTIVITY_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
  'skipped',
]);

/**
 * Structural validation of a persisted record. Only structural corruption
 * (unknown statuses, missing/duplicate activities, broken ordering) counts —
 * the caller may then recover safely. A structurally valid record is ALWAYS
 * resumed as-is (plan stability).
 */
export function isValidDailyTutorSessionRecord(record: DailyTutorSessionRecord): boolean {
  if (!record || !record.id || !record.learnerId) return false;
  if (!SESSION_STATUSES.has(record.status)) return false;
  if (!Array.isArray(record.activities) || record.activities.length === 0) return false;
  const ids = new Set<string>();
  for (let index = 0; index < record.activities.length; index += 1) {
    const activity = record.activities[index];
    if (!activity || !activity.id || ids.has(activity.id)) return false;
    ids.add(activity.id);
    if (!DAILY_ACTIVITY_KINDS.includes(activity.kind)) return false;
    if (!ACTIVITY_STATUSES.has(activity.status)) return false;
    if (activity.orderIndex !== index) return false;
  }
  return true;
}

/**
 * Real completion evidence: a positive, finite count of practiced items
 * from the child workflow's own summary. Missing, zero, negative or
 * non-finite counts are NOT completion evidence — the activity stays open.
 */
function isValidCompletionEvidence(
  evidence: { readonly itemsPracticed?: number } | undefined,
): evidence is { readonly itemsPracticed: number } {
  return (
    evidence !== undefined &&
    typeof evidence.itemsPracticed === 'number' &&
    Number.isFinite(evidence.itemsPracticed) &&
    evidence.itemsPracticed > 0
  );
}

/** Honest display label for a persisted weakness row (no fabrication). */
function weaknessLabel(notes: string | undefined): string | undefined {  const identity = parseWeaknessIdentity(notes);
  if (identity?.target) {
    return identity.target;
  }
  const phrase = notes?.trim();
  if (phrase && phrase.length <= 80) {
    return phrase;
  }
  return undefined;
}

/**
 * Map a DailyTutorService to a plain session domain object.
 */
function recordToSession(record: DailyTutorSessionRecord): DailyTutorSession {
  return {
    id: record.id,
    learnerId: record.learnerId,
    dateKey: record.dateKey,
    status: record.status,
    headline: record.headline,
    sourceMode: record.sourceMode,
    estimatedMinutes: record.estimatedMinutes,
    createdAt: record.createdAt,
    ...(record.startedAt !== null ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt !== null ? { completedAt: record.completedAt } : {}),
    activities: record.activities.map((activity: DailyTutorActivityRecord) => ({
      id: activity.id,
      kind: activity.kind,
      title: activity.title,
      reason: activity.reason,
      estimatedMinutes: activity.estimatedMinutes,
      target: activity.target,
      status: activity.status,
      ...(activity.startedAt !== null ? { startedAt: activity.startedAt } : {}),
      ...(activity.completedAt !== null ? { completedAt: activity.completedAt } : {}),
      ...(activity.practicedItems !== null && activity.practicedItems !== undefined
        ? { practicedItems: activity.practicedItems }
        : {}),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export class DailyTutorService {
  private readonly deps: DailyTutorServiceDeps;
  /** Serializes mutations so interleaved state changes cannot race. */
  private mutationQueue: Promise<unknown> = Promise.resolve();
  /** Concurrent getToday() calls share ONE load-or-create. */
  private inFlightToday: Promise<DailyTutorTodayResult> | null = null;

  constructor(deps: DailyTutorServiceDeps) {
    this.deps = deps;
  }

  private now(): IsoDate {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private offsetMinutes(): number {
    return this.deps.timeZoneOffsetMinutes
      ? this.deps.timeZoneOffsetMinutes()
      : -new Date().getTimezoneOffset();
  }

  /** Real learner id or null. Never fabricates or defaults an id. */
  async resolveLearnerId(): Promise<string | null> {
    if (!this.deps.profile) return null;
    try {
      const profile = await this.deps.profile.get();
      return profile?.id ? profile.id : null;
    } catch {
      return null;
    }
  }

  /** Serialize a mutation behind the previous one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /* ---------------- today: load or create ---------------- */

  /**
   * Today's session: loads the persisted one (resume) or creates exactly one
   * new plan when none exists. Never regenerates an existing valid session.
   */
  async getToday(): Promise<DailyTutorTodayResult> {
    if (this.inFlightToday) {
      return this.inFlightToday;
    }
    this.inFlightToday = this.loadOrCreateToday();
    try {
      return await this.inFlightToday;
    } finally {
      this.inFlightToday = null;
    }
  }

  private async loadOrCreateToday(): Promise<DailyTutorTodayResult> {
    const learnerId = await this.resolveLearnerId();
    if (!learnerId) {
      return { status: 'no-profile', message: NO_PROFILE_MESSAGE, session: null };
    }
    const now = this.now();
    const dateKey = toDateKey(now, this.offsetMinutes());
    if (!dateKey) {
      return { status: 'unavailable', message: UNAVAILABLE_MESSAGE, session: null };
    }

    // 1. Resume: a valid persisted session for today always wins.
    let record: DailyTutorSessionRecord | null;
    try {
      record = await this.deps.repository.getSessionForDate(learnerId, dateKey);
    } catch {
      return { status: 'unavailable', message: UNAVAILABLE_MESSAGE, session: null };
    }

    if (record && !isValidDailyTutorSessionRecord(record)) {
      // Safe recovery from structural corruption only: delete the unusable
      // rows and plan again. Nothing else is touched.
      try {
        await this.deps.repository.deleteSession(record.id);
        record = null;
      } catch {
        return { status: 'unavailable', message: UNAVAILABLE_MESSAGE, session: null };
      }
    }

    if (record) {
      return { status: 'ready', session: recordToSession(record) };
    }

    // 2. Plan + insert exactly one session for this learner/date.
    try {
      const input = await this.collectPlanningInput(learnerId, dateKey, now);
      const plan = planDailyTutorSession(input);
      const inserted = await this.deps.repository.insertSession(
        this.planToInsertInput(plan, now),
      );
      if (inserted) {
        return { status: 'ready', session: recordToSession(inserted) };
      }
      // Lost the create race (or a retry hit the unique learner/date rule):
      // load the session that actually exists — never duplicate it.
      const existing = await this.deps.repository.getSessionForDate(learnerId, dateKey);
      if (existing && isValidDailyTutorSessionRecord(existing)) {
        return { status: 'ready', session: recordToSession(existing) };
      }
      return { status: 'unavailable', message: UNAVAILABLE_MESSAGE, session: null };
    } catch {
      return { status: 'unavailable', message: UNAVAILABLE_MESSAGE, session: null };
    }
  }

  /** The persisted record for today, or null (no session / not creatable). */
  private async loadTodayRecord(learnerId: string, dateKey: string): Promise<DailyTutorSessionRecord | null> {
    try {
      return await this.deps.repository.getSessionForDate(learnerId, dateKey);
    } catch {
      return null;
    }
  }

  /* ---------------- planning context (real evidence only) ---------------- */

  /**
   * Bounded planning snapshot. ONE learner-model refresh (best effort), the
   * coaching context, bounded due-review breakdown, real weakness rows and
   * the EXISTING curriculum planner's recommendations.
   */
  private async collectPlanningInput(
    learnerId: string,
    dateKey: string,
    now: IsoDate,
  ): Promise<DailyTutorPlanningInput> {
    try {
      await this.deps.learnerModel.refresh();
    } catch {
      // A refresh failure is not fatal: planning continues on the last
      // successfully loaded snapshot (the existing services behave the same).
    }

    const coaching = this.deps.learnerModel.getCoachingContext({
      weaknessLimit: WEAKNESS_LIMIT,
      vocabularyLimit: 12,
      expressionLimit: 12,
    });
    const nowMs = Date.parse(now);

    // Due-review breakdown (existing review semantics: review items due by
    // kind + lexical meanings due, additive exactly like the Review dashboard).
    const byKind: Record<string, number> = {};
    for (const item of this.deps.learnerModel.getDueReview().slice(0, DUE_QUEUE_BREAKDOWN_LIMIT)) {
      byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    }
    const dueLexicalVocabulary = coaching.vocabularyFocus.filter(
      (focus) => focus.nextReviewAt !== null && Date.parse(focus.nextReviewAt) <= nowMs,
    ).length;
    const dueLexicalExpression = coaching.expressionFocus.filter(
      (focus) => focus.nextReviewAt !== null && Date.parse(focus.nextReviewAt) <= nowMs,
    ).length;
    const dueVocabularyCount = dueLexicalVocabulary + (byKind.vocabulary ?? 0);
    const dueExpressionCount = dueLexicalExpression + (byKind.expression ?? 0);
    const dueOtherReviewCount =
      (byKind.grammar ?? 0) + (byKind.pronunciation ?? 0) + (byKind.listening ?? 0);

    const activeWeaknesses: DailyTutorWeaknessEvidence[] = this.deps.learnerModel
      .getActiveWeaknesses()
      .slice(0, WEAKNESS_LIMIT)
      .map((weakness) => ({
        id: weakness.id,
        type: weakness.type,
        status: weakness.status,
        severity: weakness.severity,
        occurrenceCount: weakness.occurrenceCount,
        ...(weaknessLabel(weakness.notes) ? { label: weaknessLabel(weakness.notes) } : {}),
      }));

    const pronunciationRows = this.deps.learnerModel.pronunciationWeaknesses
      .filter((row) => !row.resolved)
      .slice(0, PRONUNCIATION_ROW_LIMIT);
    const pronunciationTargets = pronunciationRows
      .map((row) => {
        const identity = (row.notes?.trim() || row.targetSound || '').trim();
        const parsed = parseWeaknessIdentity(identity);
        return parsed?.target?.trim() || row.wordExamples[0] || identity;
      })
      .filter((target): target is string => Boolean(target && target.length > 0));

    // EXISTING curriculum planner as an input (priority logic, lifecycle
    // ordering and prerequisites stay owned by Curriculum).
    const curriculumEvidence = this.buildCurriculumEvidence();
    const activeWeaknessSkillIds = this.activeWeaknessSkillIds();
    const recentRecords = await this.deps.repository
      .listRecentSessions(learnerId, RECENT_SESSION_LIMIT)
      .catch(() => [] as readonly DailyTutorSessionRecord[]);
    const recentSessions = recentRecords
      .filter((record) => record.dateKey !== dateKey)
      .map((record) => ({
        dateKey: record.dateKey,
        kinds: record.activities.map((activity) => activity.kind),
      }));
    const recentlyPractisedSkillIds = Array.from(
      new Set(
        recentRecords.flatMap((record) =>
          record.activities
            .map((activity) => activity.target?.skillId)
            .filter((skillId): skillId is string => typeof skillId === 'string' && skillId.length > 0),
        ),
      ),
    );

    const curriculumPlan = this.deps.curriculumPlanner
      ? this.deps.curriculumPlanner({
          evidence: curriculumEvidence,
          activeWeaknesses: activeWeaknessSkillIds,
          recentlyPractised: recentlyPractisedSkillIds,
          learningGoals: mapLearningGoalsToCurriculumHints(coaching.profile.learningGoals),
          maxItems: CURRICULUM_MAX_ITEMS,
          now,
        })
      : planCurriculum({
          evidence: curriculumEvidence,
          activeWeaknesses: activeWeaknessSkillIds,
          recentlyPractised: recentlyPractisedSkillIds,
          learningGoals: mapLearningGoalsToCurriculumHints(coaching.profile.learningGoals),
          maxItems: CURRICULUM_MAX_ITEMS,
          now,
        });

    return {
      learnerId,
      dateKey,
      learningGoals: coaching.profile.learningGoals,
      dueVocabularyCount,
      dueExpressionCount,
      dueOtherReviewCount,
      dueReview: {
        vocabulary: byKind.vocabulary ?? 0,
        expression: byKind.expression ?? 0,
        grammar: byKind.grammar ?? 0,
        pronunciation: byKind.pronunciation ?? 0,
        listening: byKind.listening ?? 0,
      },
      activeWeaknesses,
      unresolvedPronunciationCount: pronunciationRows.length,
      pronunciationTargets,
      curriculum: curriculumPlan.recommendations.map((rec) => ({
        skillId: rec.skillId,
        domain: rec.domain,
        title: rec.title,
        lifecycleState: rec.lifecycleState,
      })),
      recentSessions,
      recentConversations: (coaching.recentConversations ?? []).map((conversation) => ({
        mode: conversation.mode,
        ...(conversation.topic ? { topic: conversation.topic } : {}),
      })),
    };
  }

  /**
   * Honest curriculum evidence: pronunciation weaknesses whose identity maps
   * to a real catalog skill, with the lifecycle state of the linked learner
   * weakness. Nothing else can be mapped to a skill without fabricating.
   */
  private buildCurriculumEvidence(): readonly SkillEvidenceSnapshot[] {
    const pronunciationRows = new Map(
      this.deps.learnerModel.pronunciationWeaknesses.map((row) => [row.id, row]),
    );
    const best = new Map<
      string,
      { status: string; lastSeenAt: string; evidenceCount: number }
    >();
    for (const weakness of this.deps.learnerModel.weaknesses) {
      if (weakness.type !== 'pronunciation') continue;
      const row = pronunciationRows.get(weakness.referenceId);
      if (!row) continue;
      const identity = (row.notes?.trim() || row.targetSound || '').trim();
      const parsed = parseWeaknessIdentity(identity);
      const skillId = parsed?.kind ?? row.targetSound.trim();
      if (!skillId || !getSkill(skillId)) continue; // Not a catalog skill — never fabricate.
      const current = best.get(skillId);
      if (!current || weaknessStatusPriority(weakness.status) > weaknessStatusPriority(current.status)) {
        best.set(skillId, {
          status: weakness.status,
          lastSeenAt: weakness.lastSeenAt,
          evidenceCount: weakness.occurrenceCount,
        });
      }
    }
    return Array.from(best.entries()).map(([skillId, entry]) => ({
      skillId,
      lifecycleState: entry.status as SkillLifecycleState,
      lastObservedAt: entry.lastSeenAt,
      evidenceCount: entry.evidenceCount,
    }));
  }

  /** Skill ids with a REAL active (unresolved, non-stable) pronunciation weakness. */
  private activeWeaknessSkillIds(): string[] {
    const pronunciationRows = new Map(
      this.deps.learnerModel.pronunciationWeaknesses.map((row) => [row.id, row]),
    );
    const ids = new Set<string>();
    for (const weakness of this.deps.learnerModel.getActiveWeaknesses()) {
      if (weakness.type !== 'pronunciation') continue;
      if (weakness.status === 'stable' || weakness.status === 'mastered') continue;
      const row = pronunciationRows.get(weakness.referenceId);
      if (!row) continue;
      const identity = (row.notes?.trim() || row.targetSound || '').trim();
      const parsed = parseWeaknessIdentity(identity);
      const skillId = parsed?.kind ?? row.targetSound.trim();
      if (skillId && getSkill(skillId)) {
        ids.add(skillId);
      }
    }
    return Array.from(ids);
  }

  /** Persisted-shape insert input for a freshly planned day. */
  private planToInsertInput(plan: DailyTutorPlan, now: IsoDate): CreateDailyTutorSessionInput {
    return {
      session: {
        // Deterministic id: a retry can never create a second session.
        id: `dt:${plan.learnerId}:${plan.dateKey}`,
        learnerId: plan.learnerId,
        dateKey: plan.dateKey,
        status: 'planned',
        headline: plan.headline,
        sourceMode: plan.sourceMode,
        estimatedMinutes: plan.estimatedMinutes,
        createdAt: now,
        startedAt: null,
        completedAt: null,
      },
      activities: plan.activities.map((activity) => ({
        id: activity.id,
        kind: activity.kind,
        title: activity.title,
        reason: activity.reason,
        estimatedMinutes: activity.estimatedMinutes,
        target: activity.target,
        status: 'pending' as const,
        startedAt: null,
        completedAt: null,
        practicedItems: null,
      })),
    };
  }

  /* ---------------- session state transitions ---------------- */

  /**
   * Start the current (or given) activity. Idempotent: a repeated start of
   * an in_progress activity changes nothing; completed/skipped activities
   * and completed sessions are refused.
   */
  async startActivity(activityId?: string): Promise<DailyTutorSession | null> {
    return this.enqueue(async () => {
      const context = await this.todayContext();
      if (!context) return null;
      const { record } = context;
      if (record.status === 'completed' || record.status === 'abandoned') {
        return recordToSession(record);
      }
      const session = recordToSession(record);
      const activity =
        (activityId
          ? record.activities.find((entry) => entry.id === activityId) ?? null
          : currentActivityOf(session)) ?? null;
      if (!activity) return recordToSession(record);
      if (activity.status !== 'pending') {
        // in_progress → idempotent no-op; completed/skipped → refused.
        return recordToSession(record);
      }

      const now = this.now();
      let updated = await this.deps.repository.updateActivity(record.id, activity.id, {
        status: 'in_progress',
        startedAt: now,
      });
      if (updated.status === 'planned') {
        updated = await this.deps.repository.updateSession(updated.id, {
          status: 'in_progress',
          startedAt: updated.startedAt ?? now,
        });
      }
      return recordToSession(updated);
    });
  }

  /**
   * Mark an activity completed. REQUIRES real completion evidence from the
   * child workflow's own result: a positive, finite count of practiced
   * items. There is deliberately no evidence-free variant — opening or
   * navigating to an activity never completes it, missing evidence never
   * completes it, and zero/negative/invalid counts never complete it.
   * Idempotent: a duplicate valid completion leaves the first result as-is.
   */
  async completeActivity(
    activityId: string,
    evidence: { readonly itemsPracticed: number },
  ): Promise<DailyTutorSession | null> {
    return this.enqueue(async () => {
      const context = await this.todayContext();
      if (!context) return null;
      const { record } = context;
      const activity = record.activities.find((entry) => entry.id === activityId);
      if (!activity) return recordToSession(record);
      if (record.status === 'completed' || record.status === 'abandoned') {
        return recordToSession(record);
      }
      if (activity.status === 'completed') {
        return recordToSession(record); // Idempotent.
      }
      if (activity.status === 'skipped') {
        return recordToSession(record); // Already settled differently.
      }
      if (!isValidCompletionEvidence(evidence)) {
        return recordToSession(record); // Missing/zero/invalid evidence → stays open.
      }
      return this.settleActivity(record, activity, 'completed', {
        practicedItems: evidence.itemsPracticed,
      });
    });
  }

  /**
   * Skip the current (or given) activity. A skip is recorded as a skip: no
   * evaluation, no practice counts, no completion claim.
   */
  async skipActivity(activityId?: string): Promise<DailyTutorSession | null> {
    return this.enqueue(async () => {
      const context = await this.todayContext();
      if (!context) return null;
      const { record } = context;
      if (record.status === 'completed' || record.status === 'abandoned') {
        return recordToSession(record);
      }
      const session = recordToSession(record);
      const activity =
        (activityId
          ? record.activities.find((entry) => entry.id === activityId) ?? null
          : currentActivityOf(session)) ?? null;
      if (!activity) return recordToSession(record);
      if (activity.status === 'completed' || activity.status === 'skipped') {
        return recordToSession(record);
      }
      return this.settleActivity(record, activity, 'skipped');
    });
  }

  /** Settle one activity and derive the session-level status. */
  private async settleActivity(
    record: DailyTutorSessionRecord,
    activity: { readonly id: string },
    status: 'completed' | 'skipped',
    extras?: { readonly practicedItems?: number },
  ): Promise<DailyTutorSession> {
    const now = this.now();
    let updated = await this.deps.repository.updateActivity(record.id, activity.id, {
      status,
      completedAt: now,
      ...(extras?.practicedItems !== undefined ? { practicedItems: extras.practicedItems } : {}),
    });

    const hasOpen = updated.activities.some(
      (entry) => entry.status === 'pending' || entry.status === 'in_progress',
    );
    if (!hasOpen) {
      // All non-skipped required activities are settled → the day completes.
      updated = await this.deps.repository.updateSession(updated.id, {
        status: 'completed',
        completedAt: now,
      });
    } else if (updated.status === 'planned') {
      updated = await this.deps.repository.updateSession(updated.id, {
        status: 'in_progress',
        startedAt: updated.startedAt ?? now,
      });
    }
    return recordToSession(updated);
  }

  /* ---------------- child completion handshake ---------------- */

  /**
   * Apply ONE real child completion. Everything is validated: unknown
   * session/activity, wrong day, mismatched kind echo, already-settled
   * activities and zero-practice completions are all ignored safely.
   * Returns the updated today session (or null when nothing applied).
   */
  /**
   * Apply ONE child completion (single-completion convenience wrapper).
   * Returns today's session when it is known; null when the completion was
   * not applicable (stale/foreign/malformed) or could not be applied yet
   * (storage failure — retryable). Use applyChildCompletions for the full
   * applied/rejected/retryable classification.
   */
  async applyChildCompletion(completion: DailyTutorChildCompletion): Promise<DailyTutorSession | null> {
    const outcome = await this.applyClassifiedChildCompletion(completion);
    if (outcome.status === 'retryable') return null; // Retry later, complete nothing.
    return outcome.session;
  }

  /**
   * Apply a drained batch of child completions in order. Every completion is
   * classified so the caller (the completion inbox) can acknowledge what was
   * finally dispositioned and re-queue what must be retried — a real child
   * completion is never lost to a transient storage failure.
   */
  async applyChildCompletions(
    completions: readonly DailyTutorChildCompletion[],
  ): Promise<DailyTutorCompletionBatchResult> {
    const appliedActivityIds: string[] = [];
    const rejectedActivityIds: string[] = [];
    const retryable: DailyTutorChildCompletion[] = [];
    let session: DailyTutorSession | null = null;
    for (const completion of completions ?? []) {
      const outcome = await this.applyClassifiedChildCompletion(completion);
      const activityId = completion?.ref?.activityId;
      if (!activityId) continue; // Malformed entry: dropped, never retried.
      if (outcome.status === 'applied') {
        appliedActivityIds.push(activityId);
        session = outcome.session ?? session;
      } else if (outcome.status === 'rejected') {
        rejectedActivityIds.push(activityId);
        session = outcome.session ?? session;
      } else {
        retryable.push(completion);
      }
    }
    return {
      session,
      appliedActivityIds,
      rejectedActivityIds,
      retryable,
    };
  }

  /**
   * Classify and apply one child completion (serialized with all other
   * mutations). Outcomes:
   * - applied: settled now, or already completed (idempotent success).
   * - rejected: permanently inapplicable (stale/foreign/mismatched/skipped,
   *   or without real practice evidence) — the activity stays open where
   *   applicable; retrying can never succeed.
   * - retryable: a transient failure (repository/storage) — the completion
   *   must stay retryable until it is applied or permanently rejected.
   */
  private async applyClassifiedChildCompletion(
    completion: DailyTutorChildCompletion,
  ): Promise<
    | { readonly status: 'applied'; readonly session: DailyTutorSession | null }
    | { readonly status: 'rejected'; readonly session: DailyTutorSession | null }
    | { readonly status: 'retryable'; readonly completion: DailyTutorChildCompletion }
  > {
    if (!completion?.ref?.sessionId || !completion.ref.activityId) {
      return { status: 'rejected', session: null };
    }
    return this.enqueue(async () => {
      const learnerId = await this.resolveLearnerId();
      if (!learnerId) {
        // Profile not readable right now (a real child completion implies a
        // profile exists) — keep the completion retryable, complete nothing.
        return { status: 'retryable', completion } as const;
      }
      const dateKey = toDateKey(this.now(), this.offsetMinutes());
      if (!dateKey) {
        return { status: 'retryable', completion } as const;
      }

      // Repository failures are RETRYABLE: they propagate out of this read
      // (no swallowing) so the batch can re-queue the completion.
      const record = await this.deps.repository.getSession(completion.ref.sessionId);

      if (!record || record.learnerId !== learnerId || record.dateKey !== dateKey) {
        return { status: 'rejected', session: null } as const; // Unknown or stale (not today's session).
      }
      if (record.status !== 'planned' && record.status !== 'in_progress') {
        return { status: 'rejected', session: null } as const; // Completed/abandoned day: nothing left to apply.
      }
      const activity = record.activities.find((entry) => entry.id === completion.ref.activityId);
      if (!activity) {
        return { status: 'rejected', session: null } as const;
      }
      if (completion.ref.kind !== activity.kind) {
        return { status: 'rejected', session: null } as const; // Mismatched echo.
      }
      if (activity.status === 'completed') {
        return { status: 'applied', session: recordToSession(record) } as const; // Idempotent.
      }
      if (activity.status === 'skipped') {
        return { status: 'rejected', session: null } as const; // Already settled differently.
      }
      if (!isValidCompletionEvidence(completion)) {
        // Child finished without real practice evidence → stays open. This
        // is final for THIS report (a later relaunch may report real counts).
        return { status: 'rejected', session: recordToSession(record) } as const;
      }
      const settled = await this.settleActivity(record, activity, 'completed', {
        practicedItems: completion.itemsPracticed,
      });
      return { status: 'applied', session: settled } as const;
    }).catch(() => ({ status: 'retryable', completion }) as const);
  }

  /* ---------------- child route launching ---------------- */

  /**
   * Build the child route for the current (or given) activity, including the
   * Professional English scenario planned through the EXISTING PE planner
   * from the real learner context when needed.
   */
  async getChildRoute(activityId?: string): Promise<DailyTutorChildRoute | null> {
    const learnerId = await this.resolveLearnerId();
    if (!learnerId) return null;
    const dateKey = toDateKey(this.now(), this.offsetMinutes());
    if (!dateKey) return null;
    const record = await this.loadTodayRecord(learnerId, dateKey);
    if (!record || !isValidDailyTutorSessionRecord(record)) return null;
    if (record.status === 'completed' || record.status === 'abandoned') return null;

    const session = recordToSession(record);
    const target = activityId
      ? session.activities.find((entry) => entry.id === activityId) ?? null
      : currentActivityOf(session);
    if (!target) return null;

    let extras: BuildChildRouteExtras | undefined;
    if (target.kind === 'professional_english') {
      const professional = this.buildProfessionalOptions(target.target.professionalCategory);
      if (!professional) return null; // No honest scenario → do not navigate.
      extras = { professional };
    }
    return buildChildRoute(session, target.id, extras);
  }

  /**
   * Plan the professional scenario through the EXISTING Professional English
   * → Deep Speaking integration. Deterministic given the real learner
   * context; returns null when the category or context is unavailable.
   */
  private buildProfessionalOptions(category: string | undefined): {
    readonly practiceType?: string;
    readonly professionalScenario: Record<string, unknown>;
  } | null {
    if (!category || !SCENARIO_CATEGORIES.includes(category as ScenarioCategory)) {
      return null;
    }
    let coaching;
    try {
      coaching = this.deps.learnerModel.getCoachingContext();
    } catch {
      return null;
    }
    const context = toProfessionalLearnerContext(coaching);
    const scenarioPlan = planProfessionalScenario(category as ScenarioCategory, context);
    const options = toSpeakingPlannerOptions(scenarioPlan);
    return {
      practiceType: options.practiceType,
      professionalScenario: options.professionalScenario as unknown as Record<string, unknown>,
    };
  }

  /** Resolved learner + today's record for mutations. */
  private async todayContext(): Promise<{
    readonly record: DailyTutorSessionRecord;
  } | null> {
    const learnerId = await this.resolveLearnerId();
    if (!learnerId) return null;
    const dateKey = toDateKey(this.now(), this.offsetMinutes());
    if (!dateKey) return null;
    const record = await this.loadTodayRecord(learnerId, dateKey);
    if (!record || !isValidDailyTutorSessionRecord(record)) return null;
    return { record };
  }
}
