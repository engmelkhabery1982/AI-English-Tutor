/**
 * src/adaptive-lessons/service.ts
 *
 * AdaptiveLessonService (Phase 1) — the ORCHESTRATION layer.
 *
 * WHAT IT DOES
 * - Resolves the real learner, refreshes the EXISTING LearnerModel once, and
 *   hands a bounded evidence snapshot to the deterministic planner.
 * - Runs a lesson step by step by delegating every piece of practice to the
 *   system that already owns it: ReviewService (review / vocabulary /
 *   expression / pronunciation repeats), ListeningService (listening), the
 *   existing conversation stack (speaking), and the lesson's own summary.
 * - Records ONE honest progress record per completed lesson through the
 *   existing ProgressRepository.
 *
 * WHAT IT NEVER DOES
 * - No duplicate exercise engine, weakness model, review scheduler, lexical
 *   system, listening engine, pronunciation engine or conversation engine.
 * - No new tables, no schema migration: an in-flight lesson lives in memory
 *   and a finished lesson is represented by the EXISTING progress record.
 * - No fabricated data: no scores, percentages, ratings, XP, streaks,
 *   invented durations or invented weaknesses. Skips are recorded as skips.
 *   Lesson completion never marks anything mastered — the owning engines
 *   decide every outcome transition.
 * - No silent demo fallback: when no real AI provider is configured, speaking
 *   feedback is reported as unavailable.
 * - Failures are isolated: a broken sub-service degrades one step to
 *   "unavailable" and can never corrupt the plan or the session.
 */

import { parseWeaknessIdentity, stableReferenceId } from '../listening/generator';
import { prettifyPronunciationIdentity } from '../vocabulary-workspace/service';
import type { ConversationMode, IsoDate } from '../domain/shared/types';
import type { LearnerWeakness, PronunciationWeakness } from '../domain/models/learner';
import type { ReviewItem } from '../domain/models/learning';
import type { LearnerModel } from '../learner-model';
import type { ListeningService } from '../listening';
import type { ConversationFeedback } from '../providers/ai';
import type { ProgressRepository, UserProfileRepository } from '../repositories';
import type { EvaluationResult, ReviewItemCandidate, ReviewService } from '../review';
import { planAdaptiveLesson } from './planner';
import { buildSpeakingPrompt, SPEAKING_FEEDBACK_UNAVAILABLE_NOTE } from './prompts';
import type {
  AdaptiveLessonAnswerResult,
  AdaptiveLessonPlan,
  AdaptiveLessonPlanningInput,
  AdaptiveLessonPlannerOptions,
  AdaptiveLessonPlanResult,
  AdaptiveLessonProgress,
  AdaptiveLessonPronunciationPort,
  AdaptiveLessonPronunciationTarget,
  AdaptiveLessonSession,
  AdaptiveLessonStep,
  AdaptiveLessonStepMaterial,
  AdaptiveLessonStepStatus,
  AdaptiveLessonSubmitOutcome,
  AdaptiveLessonSummary,
  AdaptiveLessonWeaknessTarget,
  AdaptiveLessonSpeakingPort,
  AdaptiveTodayPractice,
} from './types';

/* ------------------------------------------------------------------ *
 * Bounds (all reads are bounded — no unbounded scans, no N+1)
 * ------------------------------------------------------------------ */

/** Weakness rows considered while planning. */
const WEAKNESS_LIMIT = 60;
/** Lexical entries read from the coaching context. */
const LEXICAL_LIMIT = 12;
/** Pronunciation evidence rows considered while planning. */
const PRONUNCIATION_TARGET_LIMIT = 8;
/** Due review rows inspected for the "including …" breakdown. */
const DUE_REVIEW_BREAKDOWN_LIMIT = 20;
/**
 * Clamp bounds for the ONE review pool fetched per lesson. The real size is
 * DERIVED from the planned review-family demand (`reviewPoolSizeFor`), so the
 * pool is always large enough for every legitimately planned review step while
 * every read stays bounded — never an arbitrary oversized scan.
 */
const MIN_REVIEW_POOL_ITEMS = 3;
const MAX_REVIEW_POOL_ITEMS = 12;
/** Plans are reused briefly so Home → Lesson does not plan twice. */
const PLAN_CACHE_MS = 5 * 60 * 1000;

/** Identity prefixes really written by the listening/pronunciation engines. */
const KNOWN_IDENTITY_KINDS: ReadonlySet<string> = new Set([
  'word_recognition',
  'expression_recognition',
  'word_pronunciation',
  'word_stress',
  'sentence_stress',
  'vowel',
  'consonant',
  'ending',
  'linking',
  'rhythm',
  'intonation',
  'intelligibility',
  'other',
]);

/** Note used for a step the owning system could not serve. */
const UNAVAILABLE_STEP_NOTE = 'Nothing was available to practice for this step.';

const NO_PROFILE_MESSAGE =
  'No learner profile yet. Start a Talk session or open Settings to create one, and your lessons will adapt to you.';

/* ------------------------------------------------------------------ *
 * Ports
 * ------------------------------------------------------------------ */

/** The slice of the EXISTING learner model the lesson service needs. */
export type AdaptiveLessonModelPort = Pick<
  LearnerModel,
  | 'refresh'
  | 'getCoachingContext'
  | 'getActiveWeaknesses'
  | 'getDueReview'
  | 'weaknesses'
  | 'pronunciationWeaknesses'
>;

/** Existing Talk persistence pathway for REAL speaking corrections. */
export interface AdaptiveLessonSpeakingEvidencePort {
  recordFeedbackEvidence(feedback: ConversationFeedback): Promise<void>;
}

export interface AdaptiveLessonServiceDeps {
  readonly learnerModel: AdaptiveLessonModelPort;
  /** Used only to resolve the real learner id (never to invent one). */
  readonly profile?: Pick<UserProfileRepository, 'get'>;
  /** EXISTING Adaptive Review service (planning, evaluation, scheduling). */
  readonly review?: Pick<ReviewService, 'planSession' | 'evaluateAnswer' | 'recordPracticeResult'>;
  /** EXISTING Listening service (bounded exercises + qualitative evaluation). */
  readonly listening?: Pick<ListeningService, 'startSession' | 'evaluateAnswer'>;
  /**
   * EXISTING Pronunciation Engine. It owns observation dedup, the weakness
   * lifecycle and review scheduling; the lesson only asks it to analyze one
   * repeat attempt and shows the qualitative result (never a score).
   */
  readonly pronunciation?: AdaptiveLessonPronunciationPort;
  /** EXISTING conversation stack port for targeted speaking practice. */
  readonly speaking?: AdaptiveLessonSpeakingPort;
  /**
   * Optional hook into the EXISTING Talk evidence pathway. Called only when a
   * real provider returned a real correction; failure-safe.
   */
  readonly speakingEvidence?: AdaptiveLessonSpeakingEvidencePort;
  /** EXISTING progress store — one honest record per completed lesson. */
  readonly progress?: Pick<ProgressRepository, 'record'>;
  /** Injectable clock (tests); defaults to the real time. */
  readonly now?: () => IsoDate;
  /** Injectable planner tuning; always clamped by the planner itself. */
  readonly plannerOptions?: AdaptiveLessonPlannerOptions;
  readonly conversationMode?: ConversationMode;
}

/* ------------------------------------------------------------------ *
 * Internal mutable session state (in-memory only)
 * ------------------------------------------------------------------ */

interface MutableStepState {
  readonly stepId: string;
  status: AdaptiveLessonStepStatus;
  startedAt?: IsoDate;
  completedAt?: IsoDate;
  practicedItems: number;
  note?: string;
  /** Real per-activity counters used by the completion summary. */
  reviewItems: number;
  listeningExercises: number;
  speakingAnswers: number;
  pronunciationTargets: number;
  lexicalItems: number;
}

interface MutableSession {
  readonly id: string;
  readonly learnerId: string;
  readonly plan: AdaptiveLessonPlan;
  readonly startedAt: IsoDate;
  completedAt?: IsoDate;
  currentIndex: number;
  readonly steps: MutableStepState[];
  /** Weakness rows captured while planning (label/reference lookups only). */
  weaknessRows: readonly LearnerWeakness[];
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

function toIsoTime(value: IsoDate | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Human-safe target description for one persisted weakness row. */
export function describeWeaknessTarget(
  row: LearnerWeakness,
): AdaptiveLessonWeaknessTarget {
  const identity = parseWeaknessIdentity(row.notes);
  if (identity && KNOWN_IDENTITY_KINDS.has(identity.kind) && identity.target) {
    return {
      weaknessId: row.id,
      identityKind: identity.kind,
      label: identity.target,
      lastSeenAt: row.lastSeenAt,
    };
  }
  // Correction evidence stores the learner's own original phrase in `notes`.
  const phrase = row.notes?.trim();
  if (phrase && phrase.length <= 80) {
    return { weaknessId: row.id, label: phrase, lastSeenAt: row.lastSeenAt };
  }
  return { weaknessId: row.id, lastSeenAt: row.lastSeenAt };
}

/** Pronunciation practice target read from the EXISTING engine's evidence. */
export function describePronunciationTarget(
  row: PronunciationWeakness,
  activeWeaknesses: readonly LearnerWeakness[],
): AdaptiveLessonPronunciationTarget {
  const identity = (row.notes?.trim() || row.targetSound || '').trim();
  const parsed = parseWeaknessIdentity(identity);
  const target = parsed?.target?.trim() || row.wordExamples[0] || identity || 'this sound';
  const linked = activeWeaknesses.find(
    (weakness) =>
      weakness.type === 'pronunciation' &&
      (weakness.referenceId === row.id || weakness.id === row.id),
  );
  return {
    pronunciationWeaknessId: row.id,
    ...(linked ? { weaknessId: linked.id, weaknessStatus: linked.status } : {}),
    occurrenceCount: row.occurrenceCount,
    identity,
    target,
    issueLabel: prettifyPronunciationIdentity(identity) ?? 'pronunciation',
    wordExamples: row.wordExamples.slice(0, 3),
  };
}

function countReviewKinds(
  items: readonly ReviewItem[],
): Readonly<Partial<Record<ReviewItem['kind'], number>>> {
  const counts: Partial<Record<ReviewItem['kind'], number>> = {};
  for (const item of items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  }
  return counts;
}

function reviewKindLabel(kind: ReviewItem['kind'] | undefined): string {
  switch (kind) {
    case 'vocabulary':
      return 'vocabulary';
    case 'expression':
      return 'expression';
    case 'pronunciation':
      return 'pronunciation';
    case 'listening':
      return 'listening';
    case 'grammar':
    default:
      return 'grammar';
  }
}

/** True for steps executed by the EXISTING review pipeline. */
function isReviewFamilyStep(step: AdaptiveLessonStep): boolean {
  return step.capability === 'review-service';
}

/**
 * Bounded pool size for ONE lesson, derived from the lesson that was actually
 * planned: the sum of the review-family steps' item bounds, clamped. This
 * guarantees the pool can satisfy the maximum legitimate review-family demand
 * of this lesson (no step is starved by design) without ever reading more than
 * a small bounded number of rows.
 */
export function reviewPoolSizeFor(plan: AdaptiveLessonPlan): number {
  const demand = plan.steps
    .filter(isReviewFamilyStep)
    .reduce((sum, step) => sum + Math.max(1, step.bounds.maxItems), 0);
  return Math.min(MAX_REVIEW_POOL_ITEMS, Math.max(MIN_REVIEW_POOL_ITEMS, demand));
}

/**
 * Identity link between a served review candidate and the persisted weakness a
 * step was planned from. Mirrors the EXISTING ReviewService rule
 * (`w.id === candidate.referenceId || w.referenceId === candidate.referenceId`)
 * and also accepts the weakness evidence rows, which store the id of the source
 * mistake/pronunciation weakness. Deliberately id/reference based: loose text
 * matching is never used when a persisted reference exists.
 */
export function candidateMatchesWeakness(
  candidate: ReviewItemCandidate,
  weakness: LearnerWeakness | null | undefined,
): boolean {
  if (!weakness) return false;
  if (candidate.referenceId === weakness.id) return true;
  if (weakness.referenceId && candidate.referenceId === weakness.referenceId) return true;
  return (weakness.evidence ?? []).some((entry) => entry.id === candidate.referenceId);
}

/**
 * Flag a cached answer result as a repeated submission. Only variants that can
 * carry the flag are touched; a rejection is returned unchanged.
 */
function markDuplicate(result: AdaptiveLessonAnswerResult): AdaptiveLessonAnswerResult {
  switch (result.kind) {
    case 'review':
    case 'listening':
    case 'speaking':
    case 'pronunciation':
      return { ...result, duplicate: true };
    default:
      return result;
  }
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export type AdaptiveLessonStartResult =
  | { readonly status: 'no-profile'; readonly message: string; readonly session: null }
  | { readonly status: 'unavailable'; readonly message: string; readonly session: null }
  | {
      readonly status: 'started';
      readonly session: AdaptiveLessonSession;
      /** True when an unfinished lesson was resumed instead of restarted. */
      readonly resumed: boolean;
    };

export class AdaptiveLessonService {
  private readonly deps: AdaptiveLessonServiceDeps;
  private session: MutableSession | null = null;
  private lastSummary: AdaptiveLessonSummary | null = null;
  private planCache: { learnerId: string; plan: AdaptiveLessonPlan; at: number } | null = null;
  /** ONE bounded review pool per lesson, shared by all review-family steps. */
  private reviewPool: readonly ReviewItemCandidate[] | null = null;
  private reviewPoolNote: string | null = null;
  /**
   * Deterministic reservation of the single bounded pool: which candidates
   * belong to which planned review-family step. Computed once per lesson.
   */
  private reviewAllocation: Map<string, readonly ReviewItemCandidate[]> | null = null;
  /**
   * Session-scoped idempotency for submissions that were accepted as practice.
   * Protects review history, listening evidence, pronunciation occurrences and
   * the step counters from UI retries / re-renders / double taps. Cleared with
   * the lesson, so it never blocks legitimate future retraining.
   */
  private readonly answeredSubmissions = new Map<string, AdaptiveLessonAnswerResult>();
  private readonly materialCache = new Map<string, AdaptiveLessonStepMaterial>();

  constructor(deps: AdaptiveLessonServiceDeps) {
    this.deps = deps;
  }

  private now(): IsoDate {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /* ---------------- learner resolution ---------------- */

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

  /* ---------------- planning ---------------- */

  /**
   * Plan today's lesson from real learner state.
   * One refresh, one bounded snapshot, ZERO AI calls.
   */
  async planLesson(
    learnerId?: string,
    options?: { force?: boolean },
  ): Promise<AdaptiveLessonPlanResult> {
    const resolvedId = learnerId ?? (await this.resolveLearnerId());
    if (!resolvedId) {
      return { status: 'no-profile', message: NO_PROFILE_MESSAGE, plan: null };
    }

    const now = this.now();
    const nowMs = toIsoTime(now) ?? Date.now();
    if (
      !options?.force &&
      this.planCache &&
      this.planCache.learnerId === resolvedId &&
      nowMs - this.planCache.at < PLAN_CACHE_MS
    ) {
      return { status: 'planned', plan: this.planCache.plan };
    }

    try {
      await this.deps.learnerModel.refresh();
      const input = this.buildPlanningInput(resolvedId, now);
      const plan = planAdaptiveLesson(input, this.deps.plannerOptions);
      this.planCache = { learnerId: resolvedId, plan, at: nowMs };
      return { status: 'planned', plan };
    } catch {
      // Planning must never crash the app: report honestly, change nothing.
      return {
        status: 'unavailable',
        message: 'Your adaptive lesson could not be prepared right now. Nothing was changed.',
        plan: null,
      };
    }
  }

  /** Bounded planning snapshot assembled from ONE refreshed learner model. */
  private buildPlanningInput(
    learnerId: string,
    now: IsoDate,
  ): AdaptiveLessonPlanningInput {
    const model = this.deps.learnerModel;
    const coaching = model.getCoachingContext({
      weaknessLimit: WEAKNESS_LIMIT,
      vocabularyLimit: LEXICAL_LIMIT,
      expressionLimit: LEXICAL_LIMIT,
    });
    const activeWeaknesses = model.getActiveWeaknesses().slice(0, WEAKNESS_LIMIT);
    const weaknessTargets = activeWeaknesses.map(describeWeaknessTarget);

    const pronunciationRows = model.pronunciationWeaknesses
      .filter((row) => !row.resolved)
      .slice(0, PRONUNCIATION_TARGET_LIMIT);
    const pronunciationTargets = pronunciationRows.map((row) =>
      describePronunciationTarget(row, activeWeaknesses),
    );

    const dueQueue = model.getDueReview().slice(0, DUE_REVIEW_BREAKDOWN_LIMIT);

    return {
      coaching,
      hasProfile: Boolean(learnerId),
      weaknessTargets,
      pronunciationTargets,
      dueReview: {
        // The coaching context owns the authoritative due count.
        total: coaching.dueReviewCount,
        byKind: countReviewKinds(dueQueue),
      },
      now,
    };
  }

  /* ---------------- Home entry point ---------------- */

  /** "Today's Practice" view-model — reflects REAL plan availability. */
  async getTodayPractice(): Promise<AdaptiveTodayPractice> {
    const result = await this.planLesson();
    if (result.status !== 'planned' || !result.plan) {
      return {
        status: result.status === 'no-profile' ? 'no-profile' : 'unavailable',
        message: result.message,
        plan: null,
        canStart: false,
      };
    }

    const plan = result.plan;
    const practiceSteps = plan.steps.filter((step) => step.type !== 'wrap_up');
    const personalizedCount = practiceSteps.filter((step) => step.personalized).length;
    const headline =
      plan.sourceMode === 'personalized'
        ? `${practiceSteps.length} practice steps built from your own history`
        : plan.sourceMode === 'mixed'
          ? `${personalizedCount} of ${practiceSteps.length} practice steps come from your history`
          : `${practiceSteps.length} general practice steps`;

    const resumable = this.session && !this.session.completedAt
      ? {
          stepNumber: Math.min(this.session.currentIndex + 1, this.session.plan.steps.length),
          totalSteps: this.session.plan.steps.length,
        }
      : undefined;

    return {
      status: 'ready',
      plan,
      canStart: true,
      headline,
      focusLines: plan.focus.map((entry) => `${entry.area}: ${entry.detail}`),
      structureLines: plan.steps.map((step, index) => `${index + 1}. ${step.title}`),
      stepCount: plan.steps.length,
      sizeLabel: plan.sizeLabel,
      sourceMode: plan.sourceMode,
      claimsPersonalization: plan.sourceMode === 'personalized',
      ...(resumable ? { resume: resumable } : {}),
    };
  }

  /* ---------------- session lifecycle ---------------- */

  /** Start (or resume) a lesson. Reuses the cached plan when it is fresh. */
  async startLesson(options?: { forceNew?: boolean }): Promise<AdaptiveLessonStartResult> {
    if (!options?.forceNew && this.session && !this.session.completedAt) {
      return { status: 'started', session: this.snapshot(this.session), resumed: true };
    }

    const planned = await this.planLesson();
    if (planned.status !== 'planned' || !planned.plan) {
      return {
        status: planned.status === 'no-profile' ? 'no-profile' : 'unavailable',
        message: planned.message,
        session: null,
      };
    }

    const plan = planned.plan;
    const startedAt = this.now();
    this.session = {
      id: stableReferenceId(`adaptive-session:${plan.id}:${startedAt}`),
      learnerId: plan.learnerId,
      plan,
      startedAt,
      currentIndex: 0,
      steps: plan.steps.map((step) => ({
        stepId: step.id,
        status: 'pending' as AdaptiveLessonStepStatus,
        practicedItems: 0,
        reviewItems: 0,
        listeningExercises: 0,
        speakingAnswers: 0,
        pronunciationTargets: 0,
        lexicalItems: 0,
      })),
      weaknessRows: this.deps.learnerModel.getActiveWeaknesses().slice(0, WEAKNESS_LIMIT),
    };
    this.lastSummary = null;
    this.reviewPool = null;
    this.reviewPoolNote = null;
    this.reviewAllocation = null;
    this.answeredSubmissions.clear();
    this.materialCache.clear();

    return { status: 'started', session: this.snapshot(this.session), resumed: false };
  }

  /** The unfinished in-memory lesson, if any (recoverable after navigation). */
  getCurrentSession(): AdaptiveLessonSession | null {
    if (!this.session || this.session.completedAt) return null;
    return this.snapshot(this.session);
  }

  /** Count-only progress view of the current lesson. */
  getProgress(): AdaptiveLessonProgress | null {
    return this.session ? this.buildProgress(this.session) : null;
  }

  /** Discard the in-memory lesson WITHOUT recording anything. */
  cancelLesson(): void {
    this.session = null;
    this.materialCache.clear();
    this.reviewPool = null;
    this.reviewPoolNote = null;
    this.reviewAllocation = null;
    this.answeredSubmissions.clear();
  }

  private buildProgress(session: MutableSession): AdaptiveLessonProgress {
    const totalSteps = session.plan.steps.length;
    const completedSteps = session.steps.filter((s) => s.status === 'completed').length;
    const skippedSteps = session.steps.filter((s) => s.status === 'skipped').length;
    // An unavailable step is never rewritten as completed (see completeStep),
    // so it can only ever be counted here.
    const unavailableSteps = session.steps.filter((s) => s.status === 'unavailable').length;
    const finished = completedSteps + skippedSteps + unavailableSteps;
    const practicedItems = session.steps.reduce((sum, s) => sum + s.practicedItems, 0);

    // The structural wrap-up step is part of the lesson but is NOT practice:
    // completing it must never look like practiced content.
    const practiceIndexes = session.plan.steps
      .map((step, index) => ({ step, index }))
      .filter((entry) => entry.step.type !== 'wrap_up');
    const totalPracticeSteps = practiceIndexes.length;
    // A practice step counts as completed only when the learner really
    // practiced something in it: tapping "Continue" on a step that served no
    // item (or on a prompt answered with nothing) is not practice.
    const practiceStepsCompleted = practiceIndexes.filter((entry) => {
      const state = session.steps[entry.index];
      return state?.status === 'completed' && state.practicedItems > 0;
    }).length;

    const parts = [`${finished} of ${totalSteps} lesson steps`];
    if (skippedSteps > 0) parts.push(`${skippedSteps} skipped`);
    if (unavailableSteps > 0) parts.push(`${unavailableSteps} without material`);
    if (practicedItems > 0) parts.push(`${practicedItems} practice items`);
    return {
      totalSteps,
      completedSteps,
      skippedSteps,
      unavailableSteps,
      remainingSteps: Math.max(0, totalSteps - finished),
      practicedItems,
      totalPracticeSteps,
      practiceStepsCompleted,
      label: parts.join(' · '),
      isComplete: finished >= totalSteps,
    };
  }

  private snapshot(session: MutableSession): AdaptiveLessonSession {
    return {
      id: session.id,
      learnerId: session.learnerId,
      plan: session.plan,
      startedAt: session.startedAt,
      ...(session.completedAt ? { completedAt: session.completedAt } : {}),
      currentIndex: session.currentIndex,
      steps: session.steps.map((step) => ({
        stepId: step.stepId,
        status: step.status,
        ...(step.startedAt ? { startedAt: step.startedAt } : {}),
        ...(step.completedAt ? { completedAt: step.completedAt } : {}),
        practicedItems: step.practicedItems,
        ...(step.note ? { note: step.note } : {}),
      })),
    };
  }

  private indexOfStep(session: MutableSession, stepId?: string): number {
    if (!stepId) return session.currentIndex;
    const index = session.plan.steps.findIndex((step) => step.id === stepId);
    return index >= 0 ? index : session.currentIndex;
  }

  private stepState(session: MutableSession, index: number): MutableStepState | null {
    return session.steps[index] ?? null;
  }

  /* ---------------- step material (delegates to existing systems) ------- */

  /**
   * Prepare the current (or given) step. Material always comes from an
   * EXISTING system; results are cached per step so re-renders and back
   * navigation never trigger duplicate reads or duplicate AI calls.
   */
  async prepareStep(stepId?: string): Promise<AdaptiveLessonStepMaterial | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    const index = this.indexOfStep(session, stepId);
    const step = session.plan.steps[index];
    const state = this.stepState(session, index);
    if (!step || !state) return null;

    const cached = this.materialCache.get(step.id);
    if (cached) return cached;

    this.markStarted(state);

    let material: AdaptiveLessonStepMaterial;
    switch (step.capability) {
      case 'review-service':
        material = await this.prepareReviewMaterial(session, step);
        break;
      case 'listening-service':
        material = await this.prepareListeningMaterial(session, step);
        break;
      case 'pronunciation-engine':
        material = this.preparePronunciationMaterial(step);
        break;
      case 'conversation-stack':
        material = this.prepareSpeakingMaterial(step);
        break;
      case 'lesson-summary':
      default:
        material = { kind: 'wrap_up', step, lines: this.buildWrapUpLines(session) };
        break;
    }

    if (material.kind === 'unavailable' && state.status !== 'skipped') {
      // Honest degradation: the owning system had nothing real to serve.
      state.status = 'unavailable';
      state.note = material.message;
    }
    this.materialCache.set(step.id, material);
    return material;
  }

  private markStarted(state: MutableStepState): void {
    if (state.status === 'pending') {
      state.status = 'in_progress';
      state.startedAt = this.now();
    }
  }

  /**
   * ONE bounded review pool per lesson (fetched once), sized from the real
   * planned demand, then deterministically reserved per planned step.
   */
  private async ensureReviewPool(session: MutableSession): Promise<void> {
    if (this.reviewPool) return;
    const review = this.deps.review;
    if (!review) {
      this.reviewPool = [];
      this.reviewPoolNote = 'Review practice is not available in this build.';
      this.reviewAllocation = new Map();
      return;
    }
    const poolSize = reviewPoolSizeFor(session.plan);
    try {
      const candidates = await review.planSession(session.learnerId, {
        minItems: 1,
        maxItems: poolSize,
        targetItems: poolSize,
        now: this.now(),
      });
      this.reviewPool = candidates;
      this.reviewPoolNote = null;
      this.reviewAllocation = this.allocateReviewPool(session, candidates);
    } catch {
      this.reviewPool = [];
      this.reviewPoolNote = 'Review practice is unavailable right now. Nothing was changed.';
      this.reviewAllocation = new Map();
    }
  }

  /** The persisted weakness row a step was planned from, when there is one. */
  private weaknessRowForStep(
    session: MutableSession,
    step: AdaptiveLessonStep,
  ): LearnerWeakness | null {
    if (step.target.kind !== 'learner_weakness' || !step.target.id) return null;
    return session.weaknessRows.find((row) => row.id === step.target.id) ?? null;
  }

  /**
   * Reserve candidates from the single bounded pool for each planned
   * review-family step, deterministically, disjointly and FAIRLY.
   *
   * Allocation runs in four phases, and no step may fill extra capacity before
   * every sibling's minimum has been offered — that ordering is what stops one
   * step from starving another of the same kind:
   *
   *  Phase 1 — exact targeted reservation: a step planned from ONE persisted
   *            weakness reserves its genuinely linked candidate (id /
   *            referenceId / evidence identity only, never loose text), and at
   *            most that one candidate.
   *  Phase 2 — minimum specialized reservation: every kind-specialized step
   *            that still has nothing receives ONE matching-kind candidate when
   *            one exists. A targeted step that already holds its exact target
   *            has met its minimum and is passed over.
   *  Phase 3 — fill remaining specialized capacity up to `bounds.maxItems`.
   *  Phase 4 — generic (unfiltered) Review steps take only what is genuinely
   *            unallocated, so they can never starve a targeted or specialized
   *            step — and, symmetrically, phase 2/3 guarantee a targeted step
   *            cannot starve a sibling specialized step either.
   *
   * Plan order is preserved inside every phase, so the result is a pure
   * function of the (deterministic) pool order and the plan. Every candidate is
   * allocated at most once, so no item can be practiced twice in one lesson.
   * This is distribution fairness only: the pool stays ONE bounded read.
   */
  private allocateReviewPool(
    session: MutableSession,
    pool: readonly ReviewItemCandidate[],
  ): Map<string, readonly ReviewItemCandidate[]> {
    const allocation = new Map<string, ReviewItemCandidate[]>();
    const taken = new Set<string>();
    const reviewSteps = session.plan.steps.filter(isReviewFamilyStep);
    for (const step of reviewSteps) allocation.set(step.id, []);

    const available = (step: AdaptiveLessonStep): readonly ReviewItemCandidate[] =>
      pool.filter(
        (candidate) =>
          !taken.has(candidate.id) &&
          (!step.reviewKindFilter || candidate.kind === step.reviewKindFilter),
      );

    const take = (
      step: AdaptiveLessonStep,
      candidates: readonly ReviewItemCandidate[],
    ): void => {
      const bucket = allocation.get(step.id);
      if (!bucket) return;
      const limit = Math.max(1, step.bounds.maxItems);
      for (const candidate of candidates) {
        if (bucket.length >= limit) return;
        if (taken.has(candidate.id)) continue;
        taken.add(candidate.id);
        bucket.push(candidate);
      }
    };

    const targeted = reviewSteps.filter((step) => this.weaknessRowForStep(session, step) !== null);
    // A targeted step is always specialized too (defensive: even if a future
    // blueprint had no kind filter, it must keep its phase 2/3 priority).
    const specialized = reviewSteps.filter(
      (step) => Boolean(step.reviewKindFilter) || targeted.includes(step),
    );
    const generic = reviewSteps.filter((step) => !specialized.includes(step));
    const held = (step: AdaptiveLessonStep): number => allocation.get(step.id)?.length ?? 0;

    /* Phase 1 — exact targeted reservation (identity match only). */
    for (const step of targeted) {
      const weakness = this.weaknessRowForStep(session, step);
      const exact = available(step).filter((candidate) =>
        candidateMatchesWeakness(candidate, weakness),
      );
      if (exact.length > 0) take(step, exact.slice(0, 1));
    }

    /* Phase 2 — minimum specialized reservation: one matching-kind candidate
     * for every specialized step that received nothing, BEFORE any step is
     * allowed to fill extra capacity. */
    for (const step of specialized) {
      if (held(step) > 0) continue;
      take(step, available(step).slice(0, 1));
    }

    /* Phase 3 — fill the remaining specialized capacity (bounded, plan order). */
    for (const step of specialized) take(step, available(step));

    /* Phase 4 — generic Review takes only the genuine leftovers. */
    for (const step of generic) take(step, available(step));

    return allocation;
  }

  private async prepareReviewMaterial(
    session: MutableSession,
    step: AdaptiveLessonStep,
  ): Promise<AdaptiveLessonStepMaterial> {
    await this.ensureReviewPool(session);
    if (this.reviewPoolNote) {
      return { kind: 'unavailable', step, message: this.reviewPoolNote };
    }
    const pool = this.reviewPool ?? [];
    const candidates = this.reviewAllocation?.get(step.id) ?? [];
    const label = step.reviewKindFilter ? reviewKindLabel(step.reviewKindFilter) : 'review';
    if (candidates.length === 0) {
      return {
        kind: 'unavailable',
        step,
        message:
          pool.length === 0
            ? `Nothing is due for ${label} practice right now.`
            : `No ${label} items were left for this lesson.`,
      };
    }

    // Provenance: a step planned from ONE persisted weakness may only claim
    // that weakness when a genuinely linked candidate is being served.
    const weakness = this.weaknessRowForStep(session, step);
    if (!weakness) {
      return { kind: 'review', step, candidates };
    }

    const targetMatched = candidates.some((candidate) =>
      candidateMatchesWeakness(candidate, weakness),
    );
    const state = session.steps[session.plan.steps.indexOf(step)];
    if (targetMatched) {
      const note =
        candidates.length > 1
          ? 'Starts with the item from your history; the others are also due for review.'
          : undefined;
      return {
        kind: 'review',
        step,
        candidates,
        targetMatched: true,
        ...(note ? { note } : {}),
      };
    }

    // The exact target is no longer servable (its state changed after
    // planning). Degrade honestly instead of letting an unrelated same-kind
    // item masquerade as the targeted weakness.
    const note = `The specific ${label} item from your history is no longer in your due queue, so this is other real ${label} practice — not that targeted item.`;
    if (state && state.status !== 'skipped' && state.status !== 'unavailable') {
      state.note = note;
    }
    return { kind: 'review', step, candidates, targetMatched: false, note };
  }

  private async prepareListeningMaterial(
    session: MutableSession,
    step: AdaptiveLessonStep,
  ): Promise<AdaptiveLessonStepMaterial> {
    const listening = this.deps.listening;
    if (!listening) {
      return {
        kind: 'unavailable',
        step,
        message: 'Listening practice is not available in this build.',
      };
    }
    try {
      // EXISTING bounded planner: listening-weakness retraining comes first,
      // then due lexical items, then clearly general templates.
      const planned = await listening.startSession(session.learnerId, {
        targetCount: Math.max(1, Math.min(step.bounds.maxItems, 2)),
        now: this.now(),
      });
      if (planned.exercises.length === 0) {
        return {
          kind: 'unavailable',
          step,
          message: planned.sourceNote || 'Listening practice is unavailable right now.',
        };
      }

      const exercises = planned.exercises.slice(0, Math.max(1, step.bounds.maxItems));
      const targeted = step.source === 'listening_weakness';
      if (!targeted) {
        return { kind: 'listening', step, exercises, sourceNote: planned.sourceNote };
      }

      // Prefer the exercise that really retrains this step's target, matched by
      // the PERSISTED reference first — never by loose text when an id exists.
      const row = session.weaknessRows.find((weakness) => weakness.id === step.target.id);
      const identityMatch = exercises.findIndex((exercise) => {
        if (row && exercise.weaknessReferenceId === row.referenceId) return true;
        return Boolean(
          exercise.weaknessReferenceId && exercise.weaknessReferenceId === step.target.id,
        );
      });
      const label = (step.targetText ?? row?.notes ?? '').toLowerCase();
      const textMatch =
        identityMatch >= 0
          ? -1
          : exercises.findIndex((exercise) =>
              exercise.keyItems.some((item) => item.toLowerCase() === label),
            );
      const matchIndex = identityMatch >= 0 ? identityMatch : textMatch;
      const NOT_TARGETED_NOTE =
        'The exact item from your history was not available, so this is other real listening practice.';

      if (matchIndex > 0) {
        return {
          kind: 'listening',
          step,
          exercises: [exercises[matchIndex], ...exercises.filter((_, i) => i !== matchIndex)],
          // A text-only match may reorder the queue but must not claim the
          // persisted target: provenance stays truthful.
          sourceNote:
            identityMatch < 0
              ? `${planned.sourceNote} ${NOT_TARGETED_NOTE}`
              : planned.sourceNote,
        };
      }
      if (matchIndex === 0) {
        return {
          kind: 'listening',
          step,
          exercises,
          sourceNote:
            identityMatch < 0
              ? `${planned.sourceNote} ${NOT_TARGETED_NOTE}`
              : planned.sourceNote,
        };
      }

      // The exact target was not served (state changed since planning):
      // stay honest instead of pretending the step is targeted.
      return {
        kind: 'listening',
        step,
        exercises,
        sourceNote: `${planned.sourceNote} ${NOT_TARGETED_NOTE}`,
      };
    } catch {
      return {
        kind: 'unavailable',
        step,
        message: 'Listening practice is unavailable right now. Nothing was changed.',
      };
    }
  }

  /**
   * Repeat-the-target practice built from REAL persisted pronunciation
   * evidence. The target text and examples come from the existing engine's
   * rows (already loaded by the learner model — no extra query).
   */
  private preparePronunciationMaterial(
    step: AdaptiveLessonStep,
  ): AdaptiveLessonStepMaterial {
    const target = step.targetText?.trim();
    if (!target) {
      return {
        kind: 'unavailable',
        step,
        message: 'The pronunciation target for this step is no longer available.',
      };
    }
    const row = this.deps.learnerModel.pronunciationWeaknesses.find(
      (entry) => entry.id === step.target.id,
    );
    const issueLabel = step.target.label ?? row?.notes ?? undefined;
    return {
      kind: 'pronunciation',
      step,
      target,
      ...(issueLabel ? { issueLabel } : {}),
      wordExamples: row ? row.wordExamples.slice(0, 3) : [target],
      ...(this.deps.pronunciation
        ? {}
        : {
            note: 'Pronunciation analysis is not available in this build — you can still repeat the target and continue.',
          }),
    };
  }

  /**
   * Submit one repeat attempt to the EXISTING Pronunciation Engine.
   * The engine decides what is evidence, how occurrences accumulate and when
   * retraining is scheduled — the lesson adds no second persistence path and
   * never fabricates an improvement for a correct repeat.
   */
  async submitPronunciationAttempt(
    transcript: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    const index = this.indexOfStep(session, stepId);
    const step = session.plan.steps[index];
    const state = this.stepState(session, index);
    if (!step || !state) return null;

    const material = this.materialCache.get(step.id);
    const target = material?.kind === 'pronunciation' ? material.target : (step.targetText ?? '');
    const trimmed = transcript.trim();
    if (!trimmed) {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'Say the target and type or record what you said.' },
      };
    }

    const submissionKey = `${step.id}::pronunciation::${trimmed.toLowerCase()}`;
    const repeated = this.answeredSubmissions.get(submissionKey);
    if (repeated) {
      // Identical repeat resubmitted for the same step: the engine is not asked
      // again, so occurrence counts cannot inflate from a double tap.
      return { session: this.snapshot(session), result: markDuplicate(repeated) };
    }

    this.markStarted(state);
    const engine = this.deps.pronunciation;
    if (!engine || !target) {
      // Honest degradation: the attempt is real practice, but nothing was judged.
      state.practicedItems += 1;
      state.pronunciationTargets += 1;
      const result: AdaptiveLessonAnswerResult = {
        kind: 'pronunciation',
        lines: ['Pronunciation analysis was not available for this attempt.'],
        unavailable: true,
        observationsDetected: 0,
      };
      this.answeredSubmissions.set(submissionKey, result);
      return { session: this.snapshot(session), result };
    }

    try {
      const outcome = await engine.analyzeSpokenTurn({
        transcript: trimmed,
        expectedText: target,
        context: 'adaptive-lesson',
        mode: 'coach',
        now: this.now(),
      });
      state.practicedItems += 1;
      state.pronunciationTargets += 1;
      const lines = !outcome
        ? ['Pronunciation analysis was skipped for this attempt.']
        : outcome.feedbackLines.length > 0
          ? outcome.feedbackLines
          : outcome.unavailable
            ? ['Pronunciation analysis was unavailable for this attempt.']
            : ['Your repeat was recorded; no specific issue was detected.'];
      const result: AdaptiveLessonAnswerResult = {
        kind: 'pronunciation',
        lines,
        unavailable: outcome ? outcome.unavailable : true,
        observationsDetected: outcome ? outcome.analysis.observations.length : 0,
      };
      this.answeredSubmissions.set(submissionKey, result);
      return { session: this.snapshot(session), result };
    } catch {
      return {
        session: this.snapshot(session),
        result: {
          kind: 'pronunciation',
          lines: ['Pronunciation analysis failed for this attempt. Nothing was saved.'],
          unavailable: true,
          observationsDetected: 0,
        },
      };
    }
  }

  private prepareSpeakingMaterial(step: AdaptiveLessonStep): AdaptiveLessonStepMaterial {
    const aiAvailable = this.deps.speaking?.available ?? false;
    return {
      kind: 'speaking',
      step,
      prompt: buildSpeakingPrompt(step),
      aiAvailable,
      ...(aiAvailable ? {} : { note: SPEAKING_FEEDBACK_UNAVAILABLE_NOTE }),
    };
  }

  /** Wrap-up copy: real counts of what actually happened. Never scores. */
  private buildWrapUpLines(session: MutableSession): readonly string[] {
    const progress = this.buildProgress(session);
    const lines: string[] = [];
    // Wrap-up is a structural closing step, never practice: every number the
    // learner reads here describes real practice only.
    lines.push(
      progress.practiceStepsCompleted === 0
        ? 'No practice step was completed in this lesson.'
        : `${progress.practiceStepsCompleted} of ${progress.totalPracticeSteps} practice steps completed.`,
    );
    if (progress.practicedItems === 0) {
      lines.push(
        'No practice items were completed, so nothing will be saved to your progress history.',
      );
    }
    if (progress.skippedSteps > 0) {
      lines.push(
        `${progress.skippedSteps} ${progress.skippedSteps === 1 ? 'step was' : 'steps were'} skipped — skipped practice is not counted as done.`,
      );
    }
    if (progress.unavailableSteps > 0) {
      lines.push(
        `${progress.unavailableSteps} ${progress.unavailableSteps === 1 ? 'step had' : 'steps had'} nothing to practice right now.`,
      );
    }
    const counters = this.aggregateCounters(session);
    if (counters.reviewItems > 0) lines.push(`${counters.reviewItems} review items practiced.`);
    if (counters.lexicalItems > 0) {
      lines.push(`${counters.lexicalItems} of them were saved words or expressions.`);
    }
    if (counters.listeningExercises > 0) {
      lines.push(`${counters.listeningExercises} listening exercises completed.`);
    }
    if (counters.pronunciationTargets > 0) {
      lines.push(`${counters.pronunciationTargets} pronunciation repeats practiced.`);
    }
    if (counters.speakingAnswers > 0) {
      lines.push(`${counters.speakingAnswers} speaking answers given.`);
    }
    lines.push(
      'Your review schedule, weaknesses and saved words were updated only by the practice you actually did.',
    );
    return lines;
  }

  private aggregateCounters(session: MutableSession) {
    return session.steps.reduce(
      (acc, step) => ({
        reviewItems: acc.reviewItems + step.reviewItems,
        listeningExercises: acc.listeningExercises + step.listeningExercises,
        speakingAnswers: acc.speakingAnswers + step.speakingAnswers,
        pronunciationTargets: acc.pronunciationTargets + step.pronunciationTargets,
        lexicalItems: acc.lexicalItems + step.lexicalItems,
      }),
      {
        reviewItems: 0,
        listeningExercises: 0,
        speakingAnswers: 0,
        pronunciationTargets: 0,
        lexicalItems: 0,
      },
    );
  }

  /* ---------------- answers (delegated to the owning systems) ----------- */

  /**
   * Submit a review-family answer. Evaluation, weakness lifecycle and
   * spaced-repetition scheduling are ALL done by the existing ReviewService.
   */
  async submitReviewAnswer(
    candidateId: string,
    answer: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    const index = this.indexOfStep(session, stepId);
    const step = session.plan.steps[index];
    const state = this.stepState(session, index);
    if (!step || !state) return null;

    const material = this.materialCache.get(step.id);
    if (material?.kind !== 'review') {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'This step is not ready for answers yet.' },
      };
    }
    const candidate = material.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'That item is no longer part of this step.' },
      };
    }
    const review = this.deps.review;
    if (!review) {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'Review practice is not available in this build.' },
      };
    }

    const submissionKey = `${step.id}::review::${candidate.id}`;
    const repeated = this.answeredSubmissions.get(submissionKey);
    if (repeated) {
      // Retry / re-render / double tap: this item was already evaluated and
      // persisted once in this lesson. Nothing is written or counted again.
      return { session: this.snapshot(session), result: markDuplicate(repeated) };
    }

    this.markStarted(state);
    let evaluation: EvaluationResult;
    try {
      evaluation = await review.evaluateAnswer(candidate, answer, this.safeCoachingContext());
    } catch {
      return {
        session: this.snapshot(session),
        result: {
          kind: 'none',
          message: 'That answer could not be checked right now. Nothing was saved.',
        },
      };
    }

    let persisted = false;
    let persistenceError = false;
    try {
      // The EXISTING pathway: advances the weakness lifecycle and reschedules
      // the review item. The lesson never decides these transitions itself.
      await review.recordPracticeResult(session.learnerId, candidate, answer, evaluation);
      persisted = true;
    } catch {
      persistenceError = true;
    }

    state.practicedItems += 1;
    state.reviewItems += 1;
    if (candidate.kind === 'vocabulary' || candidate.kind === 'expression') {
      state.lexicalItems += 1;
    }
    if (candidate.kind === 'pronunciation') state.pronunciationTargets += 1;

    const result: AdaptiveLessonAnswerResult = {
      kind: 'review',
      evaluation,
      persisted,
      persistenceError,
    };
    // Guarded exactly because it counted as practice (see answeredSubmissions).
    this.answeredSubmissions.set(submissionKey, result);
    return { session: this.snapshot(session), result };
  }

  /**
   * Submit a listening answer. Evaluation and evidence persistence are done
   * by the existing ListeningService (qualitative categories only).
   */
  async submitListeningAnswer(
    exerciseId: string,
    answer: string,
    stepId?: string,
    replayCount?: number,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    const index = this.indexOfStep(session, stepId);
    const step = session.plan.steps[index];
    const state = this.stepState(session, index);
    if (!step || !state) return null;

    const material = this.materialCache.get(step.id);
    if (material?.kind !== 'listening') {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'This step is not ready for answers yet.' },
      };
    }
    const exercise = material.exercises.find((entry) => entry.id === exerciseId);
    if (!exercise) {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'That exercise is no longer part of this step.' },
      };
    }
    const listening = this.deps.listening;
    if (!listening) {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'Listening practice is not available in this build.' },
      };
    }

    const submissionKey = `${step.id}::listening::${exercise.id}`;
    const repeated = this.answeredSubmissions.get(submissionKey);
    if (repeated) {
      // The same exercise was already judged and its evidence persisted once.
      return { session: this.snapshot(session), result: markDuplicate(repeated) };
    }

    this.markStarted(state);
    try {
      const { evaluation, persistenceError } = await listening.evaluateAnswer(
        session.learnerId,
        exercise,
        answer,
        { ...(replayCount !== undefined ? { replayCount } : {}), now: this.now() },
      );
      state.practicedItems += 1;
      state.listeningExercises += 1;
      const result: AdaptiveLessonAnswerResult = {
        kind: 'listening',
        evaluation,
        persistenceError,
      };
      this.answeredSubmissions.set(submissionKey, result);
      return { session: this.snapshot(session), result };
    } catch {
      return {
        session: this.snapshot(session),
        result: {
          kind: 'none',
          message: 'That answer could not be checked right now. Nothing was saved.',
        },
      };
    }
  }

  /**
   * Submit a speaking answer through the EXISTING conversation stack.
   * When no real provider is configured the answer is still accepted as
   * practice, and the lesson says plainly that it was not evaluated.
   */
  async submitSpeakingAnswer(
    answer: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    const index = this.indexOfStep(session, stepId);
    const step = session.plan.steps[index];
    const state = this.stepState(session, index);
    if (!step || !state) return null;

    const material = this.materialCache.get(step.id);
    const prompt = material?.kind === 'speaking' ? material.prompt : buildSpeakingPrompt(step);
    const trimmed = answer.trim();
    if (!trimmed) {
      return {
        session: this.snapshot(session),
        result: { kind: 'none', message: 'Type or record an answer first.' },
      };
    }

    const submissionKey = `${step.id}::speaking::${trimmed.toLowerCase()}`;
    const repeated = this.answeredSubmissions.get(submissionKey);
    if (repeated) {
      // Same answer resubmitted in the same step (double tap / retry): the
      // provider is not called again and the counters do not inflate.
      return { session: this.snapshot(session), result: markDuplicate(repeated) };
    }

    this.markStarted(state);
    const speaking = this.deps.speaking;
    const feedback = speaking
      ? await speaking.evaluate({
          prompt,
          answer: trimmed,
          mode: this.deps.conversationMode ?? 'intensive',
        })
      : {
          evaluatedBy: 'unavailable' as const,
          correction: null,
          coachingNote: null,
          feedback: null,
          lines: [SPEAKING_FEEDBACK_UNAVAILABLE_NOTE],
        };

    // Real correction evidence flows through the EXISTING Talk pathway only.
    if (feedback.feedback?.correction && this.deps.speakingEvidence) {
      try {
        await this.deps.speakingEvidence.recordFeedbackEvidence(feedback.feedback);
      } catch {
        // Evidence persistence is best-effort; feedback stays visible.
      }
    }

    state.practicedItems += 1;
    state.speakingAnswers += 1;

    const result: AdaptiveLessonAnswerResult = { kind: 'speaking', feedback };
    this.answeredSubmissions.set(submissionKey, result);
    return { session: this.snapshot(session), result };
  }

  private safeCoachingContext() {
    try {
      return this.deps.learnerModel.getCoachingContext({ weaknessLimit: WEAKNESS_LIMIT });
    } catch {
      return undefined;
    }
  }

  /* ---------------- step transitions ---------------- */

  /**
   * Mark the step completed. This records ONLY that the learner finished the
   * step plus the real number of items practiced. It never marks anything
   * mastered, improved or reviewed — those transitions belong to the owning
   * engines and already happened (or not) during the answers above.
   */
  async completeStep(stepId?: string): Promise<AdaptiveLessonSession | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    const index = this.indexOfStep(session, stepId);
    const state = this.stepState(session, index);
    if (!state) return null;

    if (state.status === 'unavailable') {
      // The owning system had nothing real to serve for this step. Continuing
      // past it ONLY advances the lesson: an unavailable step must never be
      // rewritten as completed, and it contributes zero practice of any kind
      // (so completedSteps, the summary and persisted progress stay honest).
      this.resetPracticeCounters(state);
      if (!state.note) state.note = UNAVAILABLE_STEP_NOTE;
      this.advanceFrom(session, index);
      return this.snapshot(session);
    }

    if (state.status !== 'skipped') {
      state.status = 'completed';
      state.completedAt = this.now();
      if (!state.note) state.note = 'Completed by learner';
    }
    this.advanceFrom(session, index);
    return this.snapshot(session);
  }

  /**
   * Skip the step. A skip is recorded as a skip: zero counts, no evaluation,
   * no weakness improvement, no review completion, no progress inflation.
   */
  async skipStep(stepId?: string): Promise<AdaptiveLessonSession | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    const index = this.indexOfStep(session, stepId);
    const state = this.stepState(session, index);
    if (!state) return null;

    if (state.status === 'unavailable') {
      // There was nothing to practice, so this is not a learner skip: the step
      // keeps its honest unavailable status (and still counts as zero).
      this.resetPracticeCounters(state);
      if (!state.note) state.note = UNAVAILABLE_STEP_NOTE;
      this.advanceFrom(session, index);
      return this.snapshot(session);
    }

    state.status = 'skipped';
    state.completedAt = this.now();
    this.resetPracticeCounters(state);
    state.note = 'Skipped by learner — not counted as practice';
    this.advanceFrom(session, index);
    return this.snapshot(session);
  }

  /** Zero every real-activity counter for a step that must not claim practice. */
  private resetPracticeCounters(state: MutableStepState): void {
    state.practicedItems = 0;
    state.reviewItems = 0;
    state.listeningExercises = 0;
    state.speakingAnswers = 0;
    state.pronunciationTargets = 0;
    state.lexicalItems = 0;
  }

  /** Move past `index` when the learner is currently on it. */
  private advanceFrom(session: MutableSession, index: number): void {
    if (index === session.currentIndex) {
      session.currentIndex = Math.min(index + 1, session.plan.steps.length - 1);
    }
  }

  /** Move to the next step without changing any status. */
  async advance(): Promise<AdaptiveLessonSession | null> {
    const session = this.session;
    if (!session || session.completedAt) return null;
    session.currentIndex = Math.min(session.currentIndex + 1, session.plan.steps.length - 1);
    return this.snapshot(session);
  }

  /* ---------------- completion ---------------- */

  /**
   * Finish the lesson and write ONE honest progress record through the
   * existing store. Idempotent: repeating the call never records twice.
   */
  async completeLesson(): Promise<{
    session: AdaptiveLessonSession;
    summary: AdaptiveLessonSummary;
  } | null> {
    const session = this.session;
    if (!session) return null;
    if (session.completedAt && this.lastSummary) {
      return { session: this.snapshot(session), summary: this.lastSummary };
    }

    const completedAt = this.now();
    const progress = this.buildProgress(session);
    const counters = this.aggregateCounters(session);

    // Progress is earned by REAL practice only. Completing the structural
    // wrap-up step — or any step without practicing an item — never produces a
    // session record; that would inflate sessionsCompleted / turnsCompleted.
    const hasRealPractice = progress.practicedItems > 0;
    let persistedProgress = false;
    if (hasRealPractice && this.deps.progress) {
      try {
        await this.deps.progress.record({
          learnerId: session.learnerId,
          recordedAt: completedAt,
          windowStart: session.startedAt,
          windowEnd: completedAt,
          // Real activity only. Score fields are deliberately left unset:
          // adaptive lessons never invent listening/speaking/grammar scores.
          sessionsCompleted: 1,
          turnsCompleted: progress.practicedItems,
          // Owned by the lexical/review engines — never claimed by a lesson.
          newWordsLearned: 0,
          weaknessesImproved: 0,
          weaknessesWorsened: 0,
          notes: `Adaptive lesson (${session.plan.sourceMode}): ${progress.practicedItems} practice ${
            progress.practicedItems === 1 ? 'item' : 'items'
          } across ${progress.practiceStepsCompleted} of ${progress.totalPracticeSteps} practice steps${
            progress.skippedSteps > 0 ? `, ${progress.skippedSteps} skipped` : ''
          }${
            progress.unavailableSteps > 0
              ? `, ${progress.unavailableSteps} without material`
              : ''
          }.`,
        });
        persistedProgress = true;
      } catch {
        persistedProgress = false;
      }
    }

    session.completedAt = completedAt;
    session.currentIndex = session.plan.steps.length - 1;

    const structuralSteps = progress.totalSteps - progress.totalPracticeSteps;
    const lines: string[] = [
      hasRealPractice
        ? `${progress.practicedItems} ${
            progress.practicedItems === 1 ? 'practice item' : 'practice items'
          } completed across ${progress.practiceStepsCompleted} of ${progress.totalPracticeSteps} practice steps.`
        : 'No practice items were completed in this lesson.',
    ];
    lines.push(
      `${progress.completedSteps} of ${progress.totalSteps} lesson steps finished${
        structuralSteps > 0 ? ' (the closing wrap-up is a summary step, not practice)' : ''
      }.`,
    );
    if (progress.skippedSteps > 0) lines.push(`${progress.skippedSteps} steps skipped.`);
    if (counters.reviewItems > 0) lines.push(`${counters.reviewItems} review items practiced.`);
    if (counters.listeningExercises > 0) {
      lines.push(`${counters.listeningExercises} listening exercises completed.`);
    }
    if (counters.speakingAnswers > 0) lines.push(`${counters.speakingAnswers} speaking answers given.`);
    if (counters.pronunciationTargets > 0) {
      lines.push(`${counters.pronunciationTargets} pronunciation repeats practiced.`);
    }
    lines.push(
      persistedProgress
        ? 'Saved to your progress history as one adaptive lesson session.'
        : hasRealPractice
          ? 'Progress could not be saved right now. Your practice itself was still recorded by each engine.'
          : 'Nothing was saved to your progress — no real practice was completed in this lesson.',
    );

    const summary: AdaptiveLessonSummary = {
      lessonId: session.id,
      sourceMode: session.plan.sourceMode,
      stepsCompleted: progress.completedSteps,
      stepsSkipped: progress.skippedSteps,
      stepsUnavailable: progress.unavailableSteps,
      totalSteps: progress.totalSteps,
      totalPracticeSteps: progress.totalPracticeSteps,
      practiceStepsCompleted: progress.practiceStepsCompleted,
      itemsPracticed: progress.practicedItems,
      reviewItemsPracticed: counters.reviewItems,
      listeningExercisesPracticed: counters.listeningExercises,
      speakingPromptsAnswered: counters.speakingAnswers,
      pronunciationTargetsPracticed: counters.pronunciationTargets,
      lexicalItemsPracticed: counters.lexicalItems,
      lines,
      persistedProgress,
      completedAt,
    };

    this.lastSummary = summary;
    // The NEXT lesson must react to the evidence this one just produced.
    this.planCache = null;
    this.materialCache.clear();
    this.reviewPool = null;
    this.reviewPoolNote = null;
    this.reviewAllocation = null;
    // Idempotency guards are lesson-scoped: the next lesson may legitimately
    // serve (and persist) the same item again as fresh retraining.
    this.answeredSubmissions.clear();

    return { session: this.snapshot(session), summary };
  }

  /** The honest summary of the lesson that was just finished, if any. */
  getLastSummary(): AdaptiveLessonSummary | null {
    return this.lastSummary;
  }
}
