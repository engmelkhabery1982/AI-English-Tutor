/**
 * src/listening/service.ts
 *
 * ListeningService (Phase 1): plans bounded sessions, evaluates answers
 * (deterministic-first), and persists evidence through the EXISTING
 * learner-weakness lifecycle, the EXISTING Adaptive Review system, the
 * EXISTING vocabulary/expression repositories, and the EXISTING progress
 * records — no second learner model, no second scheduler, no analytics DB.
 *
 * - Weakness identity: stable ids like "word_recognition:deadline" mapped to
 *   a deterministic UUID-shaped referenceId; repeated problems deduplicate
 *   into ONE weakness row and advance conservatively (observed → repeated →
 *   confirmed; stable/mastered → relapsed; never regress; no shortcuts).
 * - Review items: created ONCE per weakness via EXACT getByReference lookup
 *   (future-scheduled and retired rows count as existing) — existing review
 *   history is never reset.
 * - Failures are non-destructive: evaluation results always reach the UI;
 *   persistence problems are reported without losing the visible feedback.
 */

import type { IsoDate } from '../domain/shared/types';
import type { ProgressRecord } from '../domain/models/learning';
import type { ExpressionItem } from '../domain/models/vocabulary';
import type { AIProvider } from '../providers/ai/types';
import type {
  ExpressionRepository,
  ProgressRepository,
  ReviewRepository,
  UserProfileRepository,
  VocabularyRepository,
  WeaknessRepository,
} from '../repositories';
import type {
  ListeningEvaluation,
  ListeningExercise,
  ListeningResultCategory,
  ListeningSessionSummary,
} from './types';
import { evaluateListeningAnswer } from './evaluator';
import { recordListeningSuccess, type SuccessObservationRecorder } from '../reassessment';
import { planListeningSession, stableReferenceId } from './generator';
import type { ListeningGeneratedContentOptions } from './generator';
import {
  deepEvaluationView,
  planDeepListeningSession,
  resolveDeepListeningPlan,
  syntheticExerciseForStep,
} from './deep';
import type {
  DeepListeningActivity,
  DeepListeningTaskType,
  DiscourseKind,
  DeepSpeechRateLevel,
  DeepSessionOptions,
  PlannedDeepSession,
  ShadowingAttempt,
  ShadowingPronunciationPort,
  ShadowingSession,
  SpeechRateCapability,
} from './deep';

/** Max missed key items persisted per exercise (bounded evidence). */
const MAX_MISSED_PER_EXERCISE = 2;
/** Bounded evidence entries per weakness (append-only, most recent kept). */
const MAX_EVIDENCE_ENTRIES = 20;
const MAX_CONTEXTS = 10;

export interface ListeningServiceDeps {
  readonly successRecorder?: SuccessObservationRecorder;
  readonly weaknesses: {
    readonly listWeaknesses: WeaknessRepository['listWeaknesses'];
    readonly upsertWeakness: WeaknessRepository['upsertWeakness'];
    /**
     * EXACT lookup by (learnerId, type, referenceId) — required, so a
     * learner with many weaknesses can never get duplicate/regressed rows.
     */
    readonly getWeaknessByReference: (
      learnerId: string,
      type: 'listening',
      referenceId: string,
    ) => Promise<Awaited<ReturnType<WeaknessRepository['listWeaknesses']>>[number] | null>;
  };
  /** Existing review repository — the ONLY scheduler. */
  readonly review?: {
    readonly upsert: NonNullable<ReviewRepository['upsert']>;
    readonly getByReference: (
      learnerId: string,
      kind: 'listening',
      referenceId: string,
    ) => Promise<Awaited<ReturnType<ReviewRepository['listDue']>>[number] | null>;
  };
  readonly vocabulary: Pick<VocabularyRepository, 'list' | 'listDue' | 'upsert' | 'get' | 'getByHeadword'>;
  readonly expressions?: Pick<ExpressionRepository, 'list' | 'listDue' | 'upsert' | 'getByExpression'>;
  /** Existing progress records — counts only, never legacy score fields. */
  readonly progress?: Pick<ProgressRepository, 'record'>;
  /** EXISTING AI provider — only for open-ended comprehension evaluation. */
  readonly aiProvider?: AIProvider;
  /** EXISTING profile repository — the ONLY source of the learner id (never fabricated). */
  readonly profile?: Pick<UserProfileRepository, 'get'>;
  /**
   * WP-2: the EXISTING pronunciation engine, used ONLY by shadowing, through
   * this narrow port. Absent → shadowing stays qualitative and local, and no
   * pronunciation evidence is ever fabricated.
   */
  readonly pronunciation?: ShadowingPronunciationPort;
}

/** True when the result indicates a comprehension problem worth persisting. */
function isProblemResult(result: ListeningResultCategory): boolean {
  return (
    result === 'partial' ||
    result === 'missed_key_meaning' ||
    result === 'misunderstood'
  );
}

/**
 * WP-4 evidence integrity: true ONLY for a result that is itself positive
 * evidence of comprehension.
 *
 * - 'understood' is the single category the evaluator reaches from a real
 *   POSITIVE signal: the answer matched the material exactly (or an explicit
 *   acceptable variant), so comprehension was demonstrated, not inferred.
 * - 'mostly_understood' is deliberately NOT success evidence: the evaluator
 *   can return it from a partial word-overlap ratio (with missed key items)
 *   or from an open-ended/model answer. It describes incomplete
 *   comprehension, so claiming strength from it would be inference.
 * - 'partial' / 'missed_key_meaning' / 'misunderstood' are problems.
 * - 'insufficient_evidence' means NO usable evidence exists (empty answer,
 *   unjudgeable turn). Absence of a judgment is never evidence of success,
 *   so it can neither create a weakness NOR a strength row.
 *
 * The previous "anything that is not a problem creates strength" rule let
 * 'insufficient_evidence' fabricate a strength claim; that is exactly what
 * this predicate removes.
 */
function createsSuccessEvidence(result: ListeningResultCategory): boolean {
  return result === 'understood';
}

function persistenceTag(exercise: ListeningExercise): string {
  return `exercise:${exercise.type}`;
}

export class ListeningService {
  constructor(private readonly deps: ListeningServiceDeps) {}

  /**
   * Resolve the active learner via the EXISTING profile repository.
   * Returns null when there is no profile — the caller shows an honest
   * state instead of fabricating a learner.
   */
  async resolveLearnerId(): Promise<string | null> {
    if (!this.deps.profile) return null;
    try {
      const profile = await this.deps.profile.get();
      return profile && profile.id ? profile.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Plan ONE bounded practice session. Deterministic for the same inputs;
   * no fabricated learner data — when there is no profile data the session
   * is general and clearly labeled.
   */
  async startSession(
    learnerId: string,
    options?: {
      difficulty?: 'easy' | 'medium' | 'hard';
      now?: IsoDate;
      targetCount?: number;
      /**
       * WP-1: explicitly allow ONE bounded generated exercise to fill the
       * session's general slot. Off by default, so a caller that must never
       * trigger generation (Adaptive Lessons) keeps its existing behaviour.
       */
      allowGeneratedContent?: boolean;
    },
  ): Promise<{ exercises: readonly ListeningExercise[]; sourceNote: string }> {
    if (!learnerId) {
      return {
        exercises: [],
        sourceNote: 'No learner profile found yet. Set up your profile to start listening practice.',
      };
    }
    try {
      const generatedContent = await this.resolveGeneratedContent(options);
      return await planListeningSession(
        {
          weaknesses: { listWeaknesses: this.deps.weaknesses.listWeaknesses },
          vocabulary: this.deps.vocabulary,
          expressions: this.deps.expressions,
        },
        learnerId,
        {
          ...options,
          ...(generatedContent ? { generatedContent } : {}),
        },
      );
    } catch {
      // Planning must never crash the screen — an honest empty session.
      return {
        exercises: [],
        sourceNote: 'Listening practice is unavailable right now. Please try again.',
      };
    }
  }

  /**
   * The opt-in generated-content context, assembled from the EXISTING profile
   * read (level + real stored goals). Returns undefined unless the caller
   * explicitly allowed generation AND a real provider is configured, so the
   * default path never calls AI.
   */
  private async resolveGeneratedContent(options?: {
    allowGeneratedContent?: boolean;
  }): Promise<ListeningGeneratedContentOptions | undefined> {
    if (!options?.allowGeneratedContent) return undefined;
    const provider = this.deps.aiProvider;
    if (!provider) return undefined;
    if (!this.deps.profile) return undefined;
    try {
      const profile = await this.deps.profile.get();
      if (!profile) return undefined;
      return {
        provider,
        // The stored working level is used AS-IS: WP-1 never infers or
        // promotes a level, and 'unknown' resolves conservatively.
        level: profile.currentLevel,
        learningGoals: profile.learningGoals ?? [],
      };
    } catch {
      // No honest learner level available → no generated content.
      return undefined;
    }
  }

  /**
   * WP-2: plan ONE bounded DEEP listening session.
   *
   * Additive and opt-in: the Phase-1 `startSession` path (and therefore the
   * Adaptive Lessons integration) is completely unaffected. Deep activities
   * are planned by the same engine, over the same repositories, with the same
   * bounded reads, and every activity is served through `evaluateDeepAnswer`.
   */
  async startDeepSession(
    learnerId: string,
    options?: {
      targetCount?: number;
      taskTypes?: readonly DeepListeningTaskType[];
      discourseKinds?: readonly DiscourseKind[];
      speechRateLevel?: DeepSpeechRateLevel;
      /** The playback capability of the REAL provider the screen will use. */
      speechRateCapability?: SpeechRateCapability;
      /** Opt-in: allow ONE generated deep activity (default off). */
      allowGeneratedContent?: boolean;
      now?: IsoDate;
    },
  ): Promise<PlannedDeepSession> {
    const capability: SpeechRateCapability = options?.speechRateCapability ?? {
      supported: false,
      providerId: null,
      reason: 'no_provider',
    };
    if (!learnerId) {
      return {
        activities: [],
        plan: resolveDeepListeningPlan({
          level: 'unknown',
          evidence: null,
          speechRateCapability: capability,
        }),
        sourceNote: 'No learner profile found yet. Set up your profile to start deep listening practice.',
      };
    }
    try {
      const profile = this.deps.profile ? await this.deps.profile.get() : null;
      const generated =
        options?.allowGeneratedContent && this.deps.aiProvider
          ? { provider: this.deps.aiProvider }
          : undefined;
      const deepOptions: DeepSessionOptions = {
        // The stored working level is used AS-IS: a level is a claim, never
        // inferred and never promoted here.
        level: profile?.currentLevel ?? 'unknown',
        learningGoals: profile?.learningGoals ?? [],
        speechRateCapability: capability,
        ...(options?.targetCount !== undefined ? { targetCount: options.targetCount } : {}),
        ...(options?.taskTypes !== undefined ? { taskTypes: options.taskTypes } : {}),
        ...(options?.discourseKinds !== undefined ? { discourseKinds: options.discourseKinds } : {}),
        ...(options?.speechRateLevel !== undefined
          ? { requestedSpeechRate: options.speechRateLevel }
          : {}),
        ...(options?.now !== undefined ? { now: options.now } : {}),
        ...(generated !== undefined ? { generatedContent: generated } : {}),
      };
      return await planDeepListeningSession(
        {
          weaknesses: { listWeaknesses: this.deps.weaknesses.listWeaknesses },
          vocabulary: this.deps.vocabulary,
          expressions: this.deps.expressions,
        },
        learnerId,
        deepOptions,
      );
    } catch {
      // Planning must never crash the screen — an honest empty session.
      return {
        activities: [],
        plan: resolveDeepListeningPlan({
          level: 'unknown',
          evidence: null,
          speechRateCapability: capability,
        }),
        sourceNote: 'Deep listening practice is unavailable right now. Please try again.',
      };
    }
  }

  /**
   * WP-2: answer ONE step of a deep activity.
   *
   * The step is expressed as an EXISTING listening exercise and evaluated by
   * the EXISTING path (deterministic-first; a deep answer is never judged by a
   * model), so weakness lifecycle and one-time review scheduling stay with
   * their existing owner. Returns `evaluation: null` for a step that does not
   * exist — never a fabricated result.
   */
  async evaluateDeepAnswer(
    learnerId: string,
    activity: DeepListeningActivity,
    stepId: string,
    answer: string,
    opts?: { replayCount?: number; now?: IsoDate },
  ): Promise<{ evaluation: ListeningEvaluation | null; persistenceError: boolean }> {
    const exercise = syntheticExerciseForStep(activity, stepId);
    if (!exercise) return { evaluation: null, persistenceError: false };
    const result = await this.evaluateAnswer(learnerId, exercise, answer, {
      ...(opts?.replayCount !== undefined ? { replayCount: opts.replayCount } : {}),
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
    });
    return {
      evaluation: deepEvaluationView(result.evaluation, activity, stepId),
      persistenceError: result.persistenceError,
    };
  }

  /**
   * WP-2: judge ONE shadowing repeat.
   *
   * Repetition and replays are LOCAL practice state: this records nothing by
   * itself. A real transcript is routed to the EXISTING pronunciation path (the
   * only owner of pronunciation evidence); without that path — or without a
   * transcript — the judgement stays local and qualitative, and nothing at all
   * is persisted.
   *
   * WP-4 evidence integrity: this is the PRODUCTION path the app really uses
   * (DeepListeningPanel → ShadowingVoiceController → here → session). The
   * owning service resolves the REAL learner id through the EXISTING profile
   * repository and passes ONLY that narrow identity plus its own success
   * recorder into the session (which stays repository-free). No profile →
   * no identity → no strength row; a matched, non-stale attempt may persist
   * strength evidence.
   */
  async submitShadowingAttempt(
    session: ShadowingSession,
    transcript: string | null,
    opts?: { now?: IsoDate; checkStale?: () => boolean },
  ): Promise<ShadowingAttempt> {
    // The real learner id — never a fallback, never fabricated.
    const learnerId = await this.resolveLearnerId();
    return session.submit(
      transcript,
      this.deps.pronunciation,
      opts?.now,
      opts?.checkStale,
      {
        ...(learnerId ? { learnerId } : {}),
        ...(this.deps.successRecorder ? { successRecorder: this.deps.successRecorder } : {}),
      },
    );
  }

  /**
   * Evaluate one answer (typed or chosen option). Persistence of evidence,
   * weaknesses and review items is failure-safe: the evaluation result is
   * ALWAYS returned; persistence problems are flagged, never thrown away
   * with the learner's visible feedback.
   */
  async evaluateAnswer(
    learnerId: string,
    exercise: ListeningExercise,
    answer: string,
    opts?: { replayCount?: number; now?: IsoDate },
  ): Promise<{ evaluation: ListeningEvaluation; persistenceError: boolean }> {
    const now = opts?.now ?? new Date().toISOString();

    // 1. Evaluate (deterministic first; existing AIProvider for open-ended).
    const evaluation = await evaluateListeningAnswer(this.deps.aiProvider, exercise, answer);

    // 2. Persist evidence — non-destructive on failure.
    let persistenceError = false;
    try {
      await this.persistEvidence(learnerId, exercise, evaluation, {
        replayCount: opts?.replayCount ?? 0,
        now,
      });
    } catch {
      persistenceError = true;
    }
    return { evaluation, persistenceError };
  }

  /**
   * Persist one exercise outcome: weakness lifecycle (conservative, exact
   * lookups) + one-time review scheduling through the EXISTING system.
   */
  private async persistEvidence(
    learnerId: string,
    exercise: ListeningExercise,
    evaluation: ListeningEvaluation,
    opts: { replayCount: number; now: IsoDate },
  ): Promise<void> {
    // General exercises still produce evidence when the learner struggles:
    // missed key items become listening weaknesses (deduplicated by identity).
    if (!isProblemResult(evaluation.result)) {
      // WP-4 evidence integrity: ONLY a positive comprehension result may
      // create strength evidence. Incomplete or absent evidence
      // ('insufficient_evidence') and 'mostly_understood' write NOTHING —
      // a missing judgment is never a success claim.
      if (createsSuccessEvidence(evaluation.result) && this.deps.successRecorder) {
        const referenceId = exercise.weaknessReferenceId ?? stableReferenceId(`listening:${exercise.id}`);
        const context = exercise.lexicalItemId
          ? `lexical:${exercise.lexicalItemId}`
          : persistenceTag(exercise);
        await recordListeningSuccess(this.deps.successRecorder, {
          learnerId,
          referenceId,
          context,
          summary: evaluation.feedbackLines.join(' ') || 'Understood listening exercise content.',
        });
      }
      return;
    }

    const missedItems =
      evaluation.missedItems.length > 0
        ? evaluation.missedItems
        : exercise.keyItems.slice(0, MAX_MISSED_PER_EXERCISE);

    for (const item of missedItems.slice(0, MAX_MISSED_PER_EXERCISE)) {
      const kind = /\s+/.test(item.trim()) ? 'expression_recognition' : 'word_recognition';
      const normalized = item.toLowerCase().trim();
      const identity = `${kind}:${normalized}`;
      const referenceId = exercise.weaknessReferenceId ?? stableReferenceId(identity);

      // EXACT lookup — never a capped-list scan.
      const existing = await this.deps.weaknesses.getWeaknessByReference(
        learnerId,
        'listening',
        referenceId,
      );

      let nextStatus: 'observed' | 'repeated' | 'confirmed' | 'relapsed' = 'observed';
      if (existing) {
        if (existing.status === 'stable' || existing.status === 'mastered') {
          nextStatus = 'relapsed';
        } else if (existing.status === 'observed') {
          nextStatus = 'repeated';
        } else if (existing.status === 'repeated') {
          nextStatus = 'confirmed';
        } else {
          // confirmed/active_training/improving/relapsed stay until Review
          // practice moves them — never regress, no shortcuts.
          nextStatus = existing.status as typeof nextStatus;
        }
      }

      const contextTag = exercise.lexicalItemId
        ? `lexical:${exercise.lexicalItemId}`
        : persistenceTag(exercise);
      const contexts = Array.from(
        new Set([...(existing?.contexts ?? []), contextTag, `replays:${opts.replayCount}`]),
      )
        .slice(-MAX_CONTEXTS);

      const evidence = [
        ...(existing?.evidence ?? []),
        {
          id: `${referenceId}-${opts.now}`,
          kind: 'turn' as const,
          at: opts.now,
          summary: `${exercise.type} — result: ${evaluation.result}; replays: ${opts.replayCount}; missed '${item}'${
            exercise.contextTopic ? ` (topic: ${exercise.contextTopic})` : ''
          }`,
        },
      ].slice(-MAX_EVIDENCE_ENTRIES);

      const weakness = await this.deps.weaknesses.upsertWeakness({
        learnerId,
        type: 'listening',
        referenceId,
        severity: 0.5,
        status: nextStatus,
        lastSeenAt: opts.now,
        firstSeenAt: existing?.firstSeenAt ?? opts.now,
        occurrenceCount: (existing?.occurrenceCount ?? 0) + 1,
        contexts,
        notes: identity,
        evidence,
        resolved: false,
      });

      // ---- EXISTING Review system: create ONCE, never reset history ----
      if (this.deps.review?.upsert && this.deps.review?.getByReference) {
        const existingReview = await this.deps.review.getByReference(
          learnerId,
          'listening',
          weakness.id,
        );
        if (!existingReview) {
          await this.deps.review.upsert({
            learnerId,
            kind: 'listening',
            referenceId: weakness.id,
            prompt: this.reviewPromptFor(exercise, item),
            expectedResponse: item,
            contextTopic: exercise.contextTopic,
            state: 'learning',
            dueAt: opts.now,
            reviewCount: 0,
            consecutiveCorrect: 0,
            outcomeHistory: [],
          });
        }
      }
    }
  }

  /** Review prompt for a listening retraining item (played via existing TTS in Review). */
  private reviewPromptFor(exercise: ListeningExercise, item: string): string {
    switch (exercise.type) {
      case 'expression_in_context':
        return `Listen and choose the meaning of '${item}'`;
      case 'missing_word':
        return `Listen and identify the missing word ('${item}')`;
      case 'listen_and_choose':
        return `Listen and choose what '${item}' means`;
      default:
        return `Listen and type what you hear (focus: '${item}')`;
    }
  }

  /**
   * Record a completed session in the EXISTING progress records — REAL
   * counts only (sessions/exercises). Legacy numeric score fields are never
   * populated. There is NO dedicated listening dashboard metric in Phase 1:
   * listening sessions appear as regular activity counts, and listening
   * problems appear as regular 'listening' learner weaknesses in the
   * existing dashboard weakness cards.
   */
  async recordSessionCompleted(
    learnerId: string,
    summary: ListeningSessionSummary,
    opts?: { now?: IsoDate },
  ): Promise<void> {
    if (!this.deps.progress) return;
    const now = opts?.now ?? new Date().toISOString();
    const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
    const dayEnd = `${now.slice(0, 10)}T23:59:59.999Z`;
    try {
      await this.deps.progress.record({
        learnerId,
        recordedAt: now,
        windowStart: dayStart,
        windowEnd: dayEnd,
        sessionsCompleted: 1,
        turnsCompleted: summary.exercisesCompleted,
        newWordsLearned: 0,
      } as Omit<ProgressRecord, 'id'>);
    } catch {
      // Non-destructive: session completion UI feedback is unaffected.
    }
  }

  /**
   * Save a missed/interesting word through the EXISTING vocabulary
   * repository with HONEST semantics:
   * - the listening sentence is NEVER stored as a definition — it is kept
   *   as a usage example (source: 'learner-created', context
   *   'from listening practice') when a meaning row exists;
   * - a placeholder definition is NEVER invented: only a REAL meaning
   *   carried by the exercise (e.g. the item's known meaning) is stored;
   *   otherwise the item is saved with an EMPTY meanings array and the
   *   learner can add a definition through the existing workspace editor;
   * - an already-saved headword is reused untouched (no duplicate, no
   *   change to its meanings, examples or meaning.review history).
   */
  async saveVocabulary(
    learnerId: string,
    headword: string,
    opts?: { meaning?: string; exampleText?: string },
  ): Promise<{ item: Awaited<ReturnType<VocabularyRepository['upsert']>>; created: boolean }> {
    const normalized = headword.toLowerCase().trim();
    // Exact lookup – never capped list – to preserve SRS and avoid missing due to limit
    if (this.deps.vocabulary.getByHeadword) {
      try {
        const exact = await this.deps.vocabulary.getByHeadword(learnerId, headword.trim(), 'word');
        if (exact) return { item: exact, created: false };
      } catch {}
    }
    const saved = await this.deps.vocabulary.list(learnerId, { limit: 500 });
    const existing = saved.find((v) => v.headword.toLowerCase().trim() === normalized);
    if (existing) return { item: existing, created: false };

    const realMeaning = opts?.meaning?.trim();
    const examples = opts?.exampleText?.trim()
      ? [
          {
            text: opts.exampleText.trim(),
            source: 'learner-created' as const,
            context: 'from listening practice',
          },
        ]
      : [];
    const created = await this.deps.vocabulary.upsert({
      learnerId,
      headword: headword.trim(),
      type: 'word',
      meanings: realMeaning
        ? [{ definition: realMeaning, examples }]
        : [],
      source: { addedBy: 'learner-created', addedAt: new Date().toISOString() },
      tags: ['listening'],
    });
    return { item: created, created: true };
  }

  /**
   * Save an expression through the EXISTING expression repository with the
   * same honest no-duplicate, no-fake-definition semantics.
   */
  async saveExpression(
    learnerId: string,
    expression: string,
    opts?: { meaning?: string; exampleText?: string },
  ): Promise<{ item: ExpressionItem; created: boolean } | null> {
    if (!this.deps.expressions) return null;
    const normalized = expression.toLowerCase().trim();
    if (this.deps.expressions.getByExpression) {
      try {
        const exact = await this.deps.expressions.getByExpression(learnerId, expression.trim(), 'common_expression');
        if (exact) return { item: exact, created: false };
      } catch {}
    }
    const saved = await this.deps.expressions.list(learnerId, { limit: 500 });
    const existing = saved.find((e) => e.expression.toLowerCase().trim() === normalized);
    if (existing) return { item: existing, created: false };

    const realMeaning = opts?.meaning?.trim();
    const examples = opts?.exampleText?.trim()
      ? [
          {
            text: opts.exampleText.trim(),
            source: 'learner-created' as const,
            context: 'from listening practice',
          },
        ]
      : [];
    const created = await this.deps.expressions.upsert({
      learnerId,
      expression: expression.trim(),
      type: 'common_expression',
      meanings: realMeaning
        ? [{ definition: realMeaning, examples }]
        : [],
      source: { addedBy: 'learner-created', addedAt: new Date().toISOString() },
      tags: ['listening'],
    });
    return { item: created, created: true };
  }
}
