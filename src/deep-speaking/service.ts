/**
 * src/deep-speaking/service.ts
 *
 * SpeakingPracticeService: the orchestration layer that binds Deep Speaking
 * to the EXISTING systems.
 *
 * REUSE CONTRACT
 * - ConversationEngine: a thin decorator augments only the systemPrompt of
 *   the request the existing engine already built. No second engine.
 * - ConversationSession: the existing session owns the conversation, history,
 *   feedback, vocabulary auto-save and abandon semantics.
 * - AIProvider: same provider resolution as Talk (Gemini when configured,
 *   honest demo fallback otherwise).
 * - LearnerModel: getCoachingContext() is the primary personalization input.
 * - VoiceSessionCoordinator: created at the UI layer on the session this
 *   service produces — the coordinator's race protections are inherited.
 * - ConversationMemoryService + ConversationMemoryRecorder: exactly-once
 *   finalization, same as Talk.
 * - LearningPersistenceService: real feedback is fed exactly once after each
 *   committed REAL AI learner turn — same ownership as Talk.
 * - VocabularyPersistenceService: wired via the session's onSaveVocabulary
 *   callback, same as Talk.
 *
 * ASYNC / IDEMPOTENCY GUARANTEES
 * - No learner turn accepted after completion starts.
 * - No turn accepted after abandon/dispose.
 * - completePractice() cannot finalize twice.
 * - dispose() cannot finalize twice.
 * - completePractice() and dispose() racing cannot duplicate memory
 *   finalization (a shared finalization lock guards both).
 * - hardMaxTurns cannot be exceeded.
 * - AI failure never increments learnerTurnCount.
 * - Failed turn never produces learning persistence.
 * - Stale/abandoned session result is ignored.
 * - Demo feedback never becomes learner evidence.
 * - Real committed feedback is persisted once per learner TURN (never deduped
 *   by feedback object identity, so two turns are always both recorded).
 */

import type {
  AIProvider,
  ConversationFeedback,
} from '../providers/ai/types';
import type { ConversationEngine } from '../conversation-engine';
import type {
  ConversationSession,
  ConversationSessionConfig,
  ConversationSessionResult,
} from '../conversation-session';
import type { CoachingContext, CoachingRecentConversation } from '../learner-model';
import type { LearnerModel } from '../learner-model';
import { getSkill } from '../curriculum/catalog';
import {
  resolveDifficultyProfile,
  toProgressionEvidence,
} from '../learning-progression';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { IsoDate } from '../domain/shared/types';
import type { ProgressRecord } from '../domain/models/learning';

import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import { createConversationSession } from '../conversation-session';
import { createDemoAIProvider } from '../providers/ai/demo';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import {
  createConversationMemoryRecorder,
  createConversationMemoryService,
  finalizeConversationWithReview,
  type ConversationMemoryRecorder,
  type ConversationMemoryService,
  type FinalizeConversationResult,
} from '../talk-demo/conversation-memory';
import {
  createLearningPersistenceService,
  type LearningPersistenceService,
} from '../talk-demo/learning-persistence';
import {
  createVocabularyPersistenceService,
} from '../talk-demo/vocabulary-persistence';
import {
  getGeminiApiKey,
  type TalkProviderKind,
} from '../talk-demo';
import { generateId } from '../shared/id';
import { nowIso } from '../shared/time';

import { boundedKnownVocabulary, planSpeakingPractice } from './planner';
import {
  TURN_GOAL_INSTRUCTIONS,
  buildSpeakingCoachingPrompt,
  buildTutorOpeningMessage,
  isShortAnswer,
  shouldReformulate,
} from './prompts';
import type {
  SpeakingCurriculumTarget,
  SpeakingPracticePlan,
  SpeakingPracticePlanResult,
  SpeakingProgressionGuidance,
  SpeakingPracticeProgress,
  SpeakingPracticeSession,
  SpeakingPracticeSummary,
  SpeakingPlannerOptions,
  SpeakingSummarySection,
  SpeakingTurnGoal,
} from './types';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const MAX_REFORMULATIONS = 2;
const MAX_SECTION_ITEMS = 4;

/* ------------------------------------------------------------------ *
 * WP-1 progression guidance assembly (pure, over ALREADY-LOADED state)
 * ------------------------------------------------------------------ */

/**
 * Keep only a curriculum target the EXISTING catalog really has.
 *
 * A skillId that does not exist is dropped (the honest domain-level target is
 * kept); a made-up skillId must never reach the coach prompt. This is pure and
 * performs no I/O — `getSkill` reads the static catalog only.
 */
function normalizeCurriculumTarget(
  target: SpeakingCurriculumTarget | undefined,
): SpeakingCurriculumTarget | undefined {
  if (!target || !target.domain) return undefined;
  if (!target.skillId) return { domain: target.domain };
  if (!getSkill(target.skillId)) return { domain: target.domain };
  return { domain: target.domain, skillId: target.skillId };
}

/**
 * Assemble the ALREADY-RESOLVED progression guidance from the coaching
 * context the service already holds.
 *
 * PURE over the loaded snapshot: no repository read, no AI call, no clock
 * read, no write-back and no level promotion. The stored working level is used
 * as-is and real negative evidence may only make the guidance MORE supported.
 */
function assembleProgressionGuidance(
  coaching: CoachingContext,
  curriculumTarget: SpeakingCurriculumTarget | undefined,
): SpeakingProgressionGuidance {
  const workingLevel = coaching.profile.currentLevel;
  // The coaching context already exposes only ACTIVE weakness rows, so every
  // row it hands over is unresolved by construction — nothing is assumed away.
  const difficultyProfile = resolveDifficultyProfile(
    workingLevel,
    toProgressionEvidence(
      coaching.activeWeaknesses.map((weakness) => ({
        type: weakness.type,
        status: weakness.status,
        resolved: false,
      })),
    ),
    'speaking',
  );
  // Bounded saved-lexicon context from lists the coaching context ALREADY
  // loaded (bounded reads owned by the learner model).
  const knownVocabulary = boundedKnownVocabulary([
    ...coaching.vocabularyFocus.map((entry) => entry.headword),
    ...coaching.expressionFocus.map((entry) => entry.expression),
  ]);
  const targetSkill = normalizeCurriculumTarget(curriculumTarget);
  return {
    workingLevel,
    difficultyProfile,
    knownVocabulary,
    ...(targetSkill ? { targetSkill } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Thin ConversationEngine decorator (augments systemPrompt only)
 * ------------------------------------------------------------------ */

interface SpeakingEngineContext {
  readonly plan: SpeakingPracticePlan;
  /** Mutable: the current turn goal the tutor should follow. */
  getCurrentTurnGoal: () => SpeakingTurnGoal;
}

/**
 * Wraps the EXISTING ConversationEngine so that the systemPrompt is augmented
 * with Deep Speaking coaching instructions. buildRequest logic, CoachingContext
 * cloning, history slicing — all remain owned by the existing engine.
 */
function createSpeakingEngineDecorator(
  inner: ConversationEngine,
  context: SpeakingEngineContext,
): ConversationEngine {
  return {
    buildRequest(input) {
      const request = inner.buildRequest(input);
      const coachingPrompt = buildSpeakingCoachingPrompt(
        context.plan,
        context.getCurrentTurnGoal(),
      );
      return {
        ...request,
        systemPrompt: `${request.systemPrompt}\n\n${coachingPrompt}`,
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Session handle (internal)
 * ------------------------------------------------------------------ */

interface SpeakingSessionHandle {
  session: SpeakingPracticeSession;
  readonly conversationSession: ConversationSession;
  readonly recorder: ConversationMemoryRecorder;
  readonly memoryService: ConversationMemoryService;
  readonly learningPersistence: LearningPersistenceService;
  readonly isRealAI: boolean;
  readonly providerKind: TalkProviderKind;
  /** Mutable turn-goal state. */
  currentTurnGoal: SpeakingTurnGoal;
  reformulationsUsed: number;
  /** Finalization lock: prevents complete/dispose from double-finalizing. */
  finalizationLock: Promise<SpeakingPracticeSummary> | null;
  /** Re-entrancy guard: a finalization is running right now. */
  finalizing: boolean;
  finalized: boolean;
  abandoned: boolean;
  /** The learner turn that is currently in flight (if any). */
  pendingTurn: Promise<ConversationSessionResult> | null;
  /** The (single) finalized summary, returned by repeated completePractice(). */
  summary: SpeakingPracticeSummary | null;
  /**
   * Learner-turn indexes whose feedback was already persisted. The dedup key is
   * the COMMITTED TURN, never the feedback object: two different turns are both
   * recorded even when a provider returns the same feedback object, while a
   * re-entrant call for the same turn cannot double-record it.
   */
  persistedTurnIndexes: Set<number>;
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

/**
 * The EXISTING progress store, injected by composition (never opened here).
 * Only real counts are recorded: one completed session, the real number of
 * learner turns, and a descriptive note. No speaking score is ever written.
 */
export interface SpeakingProgressPort {
  record(record: Omit<ProgressRecord, 'id'>): Promise<ProgressRecord>;
}

export interface SpeakingPracticeServiceDeps {
  readonly learnerModel: LearnerModel;
  readonly databaseAdapter?: DatabaseAdapter;
  readonly aiProvider?: AIProvider;
  readonly disableAI?: boolean;
  readonly memoryService?: ConversationMemoryService;
  readonly learningPersistence?: LearningPersistenceService;
  /** EXISTING progress store (optional; injected by composition). */
  readonly progress?: SpeakingProgressPort;
  /**
   * False when `learnerModel` is the deterministic demo model rather than real
   * persisted learner state. Such a plan is never labeled personalized.
   */
  readonly evidenceIsReal?: boolean;
  /**
   * WP-1: a GENUINELY mapped existing curriculum skill, supplied by composition
   * (never inferred here). Only a skill the existing catalog really has is used;
   * anything else is dropped rather than guessed.
   */
  readonly curriculumTarget?: SpeakingCurriculumTarget;
  readonly now?: () => IsoDate;
}

export class SpeakingPracticeService {
  private readonly deps: SpeakingPracticeServiceDeps;
  private handle: SpeakingSessionHandle | null = null;
  /**
   * The last finalized summary. Kept so completePractice() stays idempotent
   * even after dispose() released the session (the callers can race).
   */
  private lastSummary: SpeakingPracticeSummary | null = null;

  constructor(deps: SpeakingPracticeServiceDeps) {
    this.deps = deps;
  }

  private now(): IsoDate {
    return this.deps.now?.() ?? nowIso();
  }

  /* ---------------------------- identity ------------------------------ */

  /**
   * The REAL active learner id of the loaded learner model, or null when no
   * profile is available.
   *
   * Narrow owner accessor: composition layers that need the learner identity
   * (e.g. the fluency service recording success evidence) ask the OWNER —
   * which owns the learner model — instead of reaching into it. There is no
   * fallback and no placeholder: an unavailable identity returns null, and
   * callers must then persist nothing rather than fabricate a learner.
   */
  getLearnerId(): string | null {
    try {
      const learnerId = this.deps.learnerModel.getCoachingContext().profile.learnerId;
      return learnerId ? learnerId : null;
    } catch {
      // An unreadable learner model is an unavailable identity, never a
      // guessed one.
      return null;
    }
  }

  /* ----------------------------- planning ----------------------------- */

  async planPractice(
    options?: SpeakingPlannerOptions,
  ): Promise<SpeakingPracticePlanResult> {
    // Refresh the persisted snapshot first (best effort) so the plan is built
    // from CURRENT real evidence — never from a stale in-memory snapshot.
    try {
      await this.deps.learnerModel.refresh();
    } catch {
      // A refresh failure is not fatal: planning continues on the last
      // successfully loaded snapshot.
    }

    const coaching = this.deps.learnerModel.getCoachingContext();
    const learnerId = coaching.profile.learnerId;
    if (!learnerId) {
      return {
        status: 'no-profile',
        message: 'Set up your learning profile before starting speaking practice.',
        plan: null,
      };
    }

    let recentConversations: readonly CoachingRecentConversation[] = [];
    try {
      recentConversations = this.deps.learnerModel.recentConversations ?? [];
    } catch {
      recentConversations = [];
    }

    const evidenceIsReal = this.deps.evidenceIsReal !== false;

    return planSpeakingPractice(
      {
        coaching,
        hasProfile: true,
        recentConversations,
        now: this.now(),
        ...(evidenceIsReal ? { evidenceIsReal: true } : { evidenceIsReal: false }),
        // WP-1: working-level guidance is assembled ONLY from REAL stored
        // learner state. A demo/unknown snapshot is never presented to the
        // coach as the learner's level.
        ...(evidenceIsReal
          ? { progression: assembleProgressionGuidance(coaching, this.deps.curriculumTarget) }
          : {}),
      },
      options,
    );
  }

  /* --------------------------- start practice -------------------------- */

  async startPractice(
    plan: SpeakingPracticePlan,
  ): Promise<{
    session: SpeakingPracticeSession;
    readonly conversationSession: ConversationSession;
    readonly providerKind: TalkProviderKind;
    readonly isRealAI: boolean;
  }> {
    const existing = this.handle;
    if (existing && !existing.finalized && !existing.abandoned) {
      // An ACTIVE practice is still running: it is never silently replaced.
      throw new Error('A speaking practice session is already in progress.');
    }
    // A finished/abandoned handle (or a previously disposed one) is replaced.
    this.handle = null;
    this.lastSummary = null;

    const now = this.now();
    const aiProvider = this.resolveAIProvider();
    const isRealAI = aiProvider !== null && !this.deps.disableAI;
    const providerKind: TalkProviderKind = isRealAI ? 'gemini' : 'demo';
    const resolvedProvider = aiProvider ?? createDemoAIProvider();

    // Mutable turn-goal state. The decorator and the service share ONE box, so
    // every buildRequest sees the CURRENT goal and a goal change is impossible
    // to miss (a captured primitive would silently freeze the opening goal).
    const turnGoal: { current: SpeakingTurnGoal } = {
      current: plan.turnGoals[0] ?? {
        turnIndex: 0,
        goal: 'open',
        instruction: TURN_GOAL_INSTRUCTIONS.open,
      },
    };

    // EXISTING engine → decorator → orchestrator → session
    const innerEngine = createConversationEngine(this.deps.learnerModel);
    const engine = createSpeakingEngineDecorator(innerEngine, {
      plan,
      getCurrentTurnGoal: () => turnGoal.current,
    });
    const orchestrator = createConversationOrchestrator(engine, resolvedProvider);

    // Vocabulary persistence (same as Talk)
    const vocabPersistence = createVocabularyPersistenceService({
      ...(this.deps.databaseAdapter ? { databaseAdapter: this.deps.databaseAdapter } : {}),
    });

    const sessionConfig: ConversationSessionConfig = {
      mode: plan.coachingMode,
      ...(plan.topic ? { topic: plan.topic } : {}),
      onSaveVocabulary: async (vocab) => {
        const saved = await vocabPersistence.saveVocabulary(vocab);
        if (!saved) {
          throw new Error('Vocabulary persistence failed or no learner profile exists');
        }
      },
    };

    const conversationSession = createConversationSession(orchestrator, sessionConfig);

    // Conversation memory recorder (same as Talk)
    const recorder = createConversationMemoryRecorder({ startedAt: now });

    // Memory service
    const memoryService =
      this.deps.memoryService ??
      createConversationMemoryService({
        ...(this.deps.databaseAdapter ? { databaseAdapter: this.deps.databaseAdapter } : {}),
      });

    // Learning persistence (same as Talk)
    const learningPersistence =
      this.deps.learningPersistence ??
      createLearningPersistenceService(
        this.deps.databaseAdapter,
        plan.learnerId,
      );

    const session: SpeakingPracticeSession = {
      id: generateId(),
      plan,
      startedAt: now,
      conversationSession,
      learnerTurnCount: 0,
      completed: false,
    };

    this.handle = {
      session,
      conversationSession,
      recorder,
      memoryService,
      learningPersistence,
      isRealAI,
      providerKind,
      // Same box the decorator reads: reads and writes stay in sync.
      get currentTurnGoal(): SpeakingTurnGoal {
        return turnGoal.current;
      },
      set currentTurnGoal(next: SpeakingTurnGoal) {
        turnGoal.current = next;
      },
      reformulationsUsed: 0,
      finalizationLock: null,
      finalizing: false,
      finalized: false,
      abandoned: false,
      pendingTurn: null,
      summary: null,
      persistedTurnIndexes: new Set<number>(),
    };

    return { session, conversationSession, providerKind, isRealAI };
  }

  /* ----------------------- tutor opening turn ------------------------- */

  /**
   * Sends the tutor opening via the EXISTING session.openConversation().
   * The opening instruction is NOT learner speech and is never counted.
   */
  async openConversation(
    onChunk?: (chunk: string) => void,
  ): Promise<ConversationSessionResult> {
    const handle = this.requireActiveHandle();
    const openConversation = handle.conversationSession.openConversation?.bind(
      handle.conversationSession,
    );
    if (!openConversation) {
      throw new Error('The conversation session cannot open a conversation.');
    }
    const openingMessage = buildTutorOpeningMessage(handle.session.plan);
    // The opening is a TUTOR turn only: it is never counted as learner work and
    // its (non-existent) feedback is never attributed to the learner. Its goal
    // is the plan's opening goal; once it is delivered, the goal advances to
    // the reply that will follow the learner's first answer.
    const result = await openConversation({ userMessage: openingMessage }, onChunk);
    if (result.ok) {
      handle.currentTurnGoal =
        this.plannedGoalFor(handle, handle.session.learnerTurnCount + 1) ?? {
          turnIndex: handle.session.learnerTurnCount + 1,
          goal: 'follow_up',
          instruction: TURN_GOAL_INSTRUCTIONS.follow_up,
        };
    }
    return result;
  }

  /* --------------------------- learner turn --------------------------- */

  /**
   * Send a learner turn through the EXISTING session. After a successful
   * REAL AI turn, feed the feedback exactly once to the existing
   * LearningPersistenceService.
   *
   * Returns the session result. The caller (screen) is responsible for
   * voice/text guards; this method enforces semantic bounds:
   * - no turn after completion/abandon
   * - no turn beyond hardMaxTurns
   * - AI failure does not increment learnerTurnCount
   * - failed turn produces no learning persistence
   * - demo feedback never becomes learner evidence
   */
  async sendLearnerTurn(
    message: string,
    onChunk?: (chunk: string) => void,
  ): Promise<ConversationSessionResult> {
    const handle = this.requireActiveHandle();
    this.assertTurnAllowed(handle);

    // One learner turn at a time: a double submit can never be counted twice.
    const turn = this.performLearnerTurn(handle, message, onChunk);
    handle.pendingTurn = turn;
    try {
      return await turn;
    } finally {
      if (handle.pendingTurn === turn) handle.pendingTurn = null;
    }
  }

  /**
   * True while a learner turn is in flight. The UI uses this as the
   * authoritative liveness signal before it touches the voice stack.
   */
  hasActiveLearnerTurn(): boolean {
    return this.handle?.pendingTurn != null;
  }

  /** Synchronous refusal rules shared by every learner-turn entry point. */
  private assertTurnAllowed(handle: SpeakingSessionHandle): void {
    if (handle.abandoned) {
      throw new Error('This speaking practice session has been closed.');
    }
    if (handle.finalized || handle.finalizationLock || handle.finalizing) {
      throw new Error('This speaking practice session is already complete.');
    }
    if (handle.pendingTurn) {
      throw new Error('A learner turn is already being processed.');
    }
    if (handle.session.learnerTurnCount >= handle.session.plan.hardMaxTurns) {
      throw new Error('The maximum number of turns for this session has been reached.');
    }
  }

  /**
   * The actual turn. Counting, evidence persistence and goal adaptation happen
   * ONLY for a turn the EXISTING session really committed.
   */
  private async performLearnerTurn(
    handle: SpeakingSessionHandle,
    message: string,
    onChunk?: (chunk: string) => void,
  ): Promise<ConversationSessionResult> {
    // Deterministic pre-call goal: the learner's message is known BEFORE the
    // request is built, so a short answer receives ONE focused elaboration
    // follow-up in the tutor reply to that very answer. A pending
    // reformulation request (from real correction evidence) keeps priority.
    if (
      handle.currentTurnGoal.goal !== 'reformulate' &&
      isShortAnswer(message)
    ) {
      handle.currentTurnGoal = {
        turnIndex: handle.session.learnerTurnCount + 1,
        goal: 'expand',
        instruction: TURN_GOAL_INSTRUCTIONS.expand,
      };
    }

    const result = await handle.conversationSession.send(
      { userMessage: message },
      onChunk,
    );

    if (!result.ok) {
      // AI failure (or a turn refused by a closed session): do not increment,
      // do not persist, do not note feedback.
      return result;
    }

    // Turn committed successfully.
    handle.session = {
      ...handle.session,
      learnerTurnCount: handle.session.learnerTurnCount + 1,
    };

    // The feedback that belongs to THIS committed turn (the session returns the
    // feedback of the turn it just committed). It is never read from a stale
    // "last feedback" slot.
    const feedback = result.feedback ?? null;

    // Note feedback for conversation memory (recorder dedups by identity).
    handle.recorder.noteFeedback(feedback);

    // Feed the REAL committed feedback exactly once for THIS turn.
    if (handle.isRealAI && feedback) {
      this.persistFeedbackForTurn(handle, feedback);
    }

    // Update the turn goal for the NEXT tutor reply based on this evidence.
    this.updateTurnGoal(handle, feedback);

    return result;
  }

  /* ---------------------- turn-goal adaptation ------------------------ */

  /**
   * Choose the goal for the NEXT tutor reply from the evidence of the turn that
   * was just committed:
   * - real incorrect/unnatural correction → one reformulation request,
   * - otherwise → the plan's goal for the next reply (fallback: follow-up).
   *
   * Correction evidence only exists AFTER the reply to that turn, so the
   * reformulation request necessarily rides on the following reply — the same
   * single-request-per-turn pipeline, never an extra AI call.
   */
  private updateTurnGoal(
    handle: SpeakingSessionHandle,
    feedback: ConversationFeedback | null,
  ): void {
    const nextTurnIndex = handle.session.learnerTurnCount + 1;

    // Check reformulation (only with real correction evidence)
    if (
      shouldReformulate(
        feedback,
        handle.isRealAI,
        handle.reformulationsUsed,
        MAX_REFORMULATIONS,
      )
    ) {
      handle.reformulationsUsed += 1;
      handle.currentTurnGoal = {
        turnIndex: nextTurnIndex,
        goal: 'reformulate',
        instruction: TURN_GOAL_INSTRUCTIONS.reformulate,
      };
      return;
    }

    // Otherwise, use the planner's predetermined goal for the next reply.
    handle.currentTurnGoal =
      this.plannedGoalFor(handle, nextTurnIndex) ?? handle.currentTurnGoal;
  }

  /** The planned goal of the tutor reply to learner turn `turnIndex`. */
  private plannedGoalFor(
    handle: SpeakingSessionHandle,
    turnIndex: number,
  ): SpeakingTurnGoal | null {
    const goals = handle.session.plan.turnGoals;
    return (
      goals.find((goal) => goal.turnIndex === turnIndex) ??
      goals.find((goal) => goal.goal === 'follow_up') ??
      null
    );
  }

  /* ------------------------- feedback persist ------------------------- */

  /**
   * Feed the REAL feedback of the turn that just committed to the existing
   * LearningPersistenceService, exactly once for THAT TURN.
   *
   * The ownership key is the committed learner-turn index (single-flight turns
   * guarantee one commit per index). Deduplicating by feedback object identity
   * would be wrong: two distinct committed turns must both be recorded even if a
   * provider happens to reuse the same object.
   */
  private persistFeedbackForTurn(
    handle: SpeakingSessionHandle,
    feedback: ConversationFeedback,
  ): void {
    const turnIndex = handle.session.learnerTurnCount;
    if (handle.persistedTurnIndexes.has(turnIndex)) return;
    handle.persistedTurnIndexes.add(turnIndex);
    // Non-blocking: persistence failure must not corrupt the conversation.
    void handle.learningPersistence.recordFeedbackEvidence(feedback).catch(() => {
      // Swallow: same non-destructive semantics as Talk.
    });
  }

  /* ----------------------------- progress ----------------------------- */

  getProgress(): SpeakingPracticeProgress {
    const handle = this.handle;
    if (!handle) {
      return {
        totalTurns: 0,
        learnerTurns: 0,
        remaining: 0,
        isComplete: true,
        label: 'No active session.',
      };
    }
    const total = handle.session.plan.targetTurns;
    const learnerTurns = handle.session.learnerTurnCount;
    const remaining = Math.max(0, total - learnerTurns);
    const isComplete = handle.session.completed || handle.finalized;
    return {
      totalTurns: total,
      learnerTurns,
      remaining,
      isComplete,
      label: `${learnerTurns} of ${total} turns${remaining > 0 ? ` · ${remaining} remaining` : ''}`,
    };
  }

  /* --------------------------- complete ------------------------------- */

  /**
   * Finalize the speaking practice session.
   *
   * Idempotent: repeated calls (including one that races dispose()) return the
   * SAME summary and finalize conversation memory exactly once. An in-flight
   * learner turn is awaited first, so a turn that is already committed is never
   * lost from the summary and a failed turn is never counted.
   */
  async completePractice(): Promise<SpeakingPracticeSummary> {
    const handle = this.handle;
    if (!handle) {
      // Already disposed (or finalized by disposal): the same summary is
      // returned instead of failing the caller.
      if (this.lastSummary) return this.lastSummary;
      throw new Error('No active speaking practice session.');
    }
    if (handle.finalizationLock) {
      return handle.finalizationLock;
    }
    if (handle.finalized && handle.summary) {
      return handle.summary;
    }

    // The lock is assigned SYNCHRONOUSLY (before any await below), so a
    // concurrent dispose()/completePractice() can never start a second
    // finalization.
    const promise = (async (): Promise<SpeakingPracticeSummary> => {
      const pending = handle.pendingTurn;
      if (pending) {
        try {
          await pending;
        } catch {
          // A failed turn is not evidence; finalization continues.
        }
      }
      return this.finalizeInternal(handle);
    })();
    handle.finalizationLock = promise;
    try {
      return await promise;
    } catch (error) {
      // A finalization that failed may be retried; a successful one keeps its lock.
      if (handle.finalizationLock === promise) handle.finalizationLock = null;
      throw error;
    }
  }

  private async finalizeInternal(
    handle: SpeakingSessionHandle,
  ): Promise<SpeakingPracticeSummary> {
    if (handle.finalizing || handle.finalized) {
      // Defensive: never finalize twice, even if a caller bypassed the lock.
      if (handle.summary) return handle.summary;
      throw new Error('Session already finalized.');
    }
    handle.finalizing = true;

    const endedAt = this.now();
    handle.session = { ...handle.session, completed: true, endedAt };

    // Finalize conversation memory through the EXISTING exactly-once path.
    let persistence: FinalizeConversationResult;
    try {
      const review = await finalizeConversationWithReview({
        session: handle.conversationSession,
        recorder: handle.recorder,
        isRealAI: handle.isRealAI,
        ...(endedAt ? { endedAt } : {}),
        service: handle.memoryService,
      });
      persistence = review.persistence;
    } catch {
      persistence = {
        ok: false,
        reason: 'persistence-failed',
        errorMessage: 'This conversation could not be saved.',
      };
    }

    let summary: SpeakingPracticeSummary;
    try {
      summary = this.buildSummary(handle, persistence, endedAt);
    } catch (error) {
      // A failed finalization releases the re-entrancy guard so the caller can
      // retry it; nothing was marked finalized.
      handle.finalizing = false;
      throw error;
    }

    handle.summary = summary;
    this.lastSummary = summary;
    handle.finalized = true;
    handle.finalizing = false;
    // ONE honest progress record, only for a real AI session with real learner
    // turns. It is written behind the same finalization lock, so it can never be
    // recorded twice, and it never carries a speaking score.
    await this.recordProgressOnce(handle, summary);
    return summary;
  }

  /**
   * Records real, existing-supported counts through the EXISTING progress store.
   * No score, percentage, level change or gamification field is ever written.
   */
  private async recordProgressOnce(
    handle: SpeakingSessionHandle,
    summary: SpeakingPracticeSummary,
  ): Promise<void> {
    const progress = this.deps.progress;
    if (!progress) return;
    // Demo/offline sessions are not real learner practice.
    if (!handle.isRealAI) return;
    if (summary.learnerTurns <= 0) return;
    try {
      await progress.record({
        learnerId: handle.session.plan.learnerId,
        recordedAt: summary.generatedAt,
        windowStart: handle.session.startedAt,
        windowEnd: summary.generatedAt,
        sessionsCompleted: 1,
        turnsCompleted: summary.learnerTurns,
        // Owned by the other existing engines — never claimed here.
        newWordsLearned: 0,
        weaknessesImproved: 0,
        weaknessesWorsened: 0,
        notes: `Speaking practice (${handle.session.plan.practiceType}, ${handle.session.plan.source}): ${summary.learnerTurns} learner turn${
          summary.learnerTurns === 1 ? '' : 's'
        } with the tutor.`,
      });
    } catch {
      // Progress persistence must never fail the completed practice session.
    }
  }

  /* ----------------------------- dispose ------------------------------ */

  /**
   * Safe teardown (screen unmount / leaving). Idempotent.
   * If the session had committed learner turns and was not already completed,
   * finalizes memory once. Never finalizes twice.
   */
  async dispose(): Promise<void> {
    const handle = this.handle;
    if (!handle) return; // Already disposed: idempotent.

    // SYNCHRONOUS refusal first: the handle stops accepting turns in this tick,
    // before the first await, so a late AI/STT result can never start new work.
    this.handle = null;
    handle.abandoned = true;

    // Abandon the conversation session (discards in-flight work).
    handle.conversationSession.abandon?.();

    // A completion that is already running owns finalization: just wait.
    if (handle.finalizationLock) {
      try {
        await handle.finalizationLock;
      } catch {
        // A completion failure is reported to its own caller.
      }
      return;
    }

    if (handle.finalized) return;

    // Nothing was practiced: there is nothing to finalize or persist.
    if (!handle.recorder.hasCommittedLearnerTurn(handle.conversationSession)) return;

    // Real learner turns exist: finalize them exactly once.
    const promise = this.finalizeInternal(handle);
    handle.finalizationLock = promise;
    try {
      await promise;
    } catch {
      // Disposal failures are non-destructive.
    }
  }

  /* --------------------------- summary build -------------------------- */

  private buildSummary(
    handle: SpeakingSessionHandle,
    persistence: FinalizeConversationResult,
    endedAt: IsoDate,
  ): SpeakingPracticeSummary {
    const history = handle.conversationSession.getHistory();
    const learnerTurns = history.filter((t) => t.role === 'user').length;
    const tutorTurns = history.filter((t) => t.role === 'assistant').length;

    // Collect all feedback from the session (the recorder holds it).
    const snapshot = handle.recorder.snapshot({
      session: handle.conversationSession,
      isRealAI: handle.isRealAI,
    });

    const sections: SpeakingSummarySection[] = [];

    // NO praise section: the existing feedback model corrects selectively, so
    // the absence of a correction is NOT evidence that grammar, naturalness or
    // fluency were good. This summary only reports explicit, real evidence
    // (corrections and stored vocabulary) plus the real turn count the UI shows.
    const corrections = snapshot.feedback
      .map((f) => f.correction)
      .filter(
        (c): c is NonNullable<typeof c> =>
          Boolean(c && c.original && c.improved),
      );

    // Useful corrections — only real corrections.
    if (corrections.length > 0) {
      const seen = new Set<string>();
      const items: string[] = [];
      for (const c of corrections) {
        const key = `${c.original}=>${c.improved}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const explanation = c.explanation?.trim();
        items.push(
          `"${c.original.trim()}" → "${c.improved.trim()}"${explanation ? ` — ${explanation}` : ''}`,
        );
        if (items.length >= MAX_SECTION_ITEMS) break;
      }
      if (items.length > 0) {
        sections.push({ id: 'corrections', title: 'Useful corrections', items });
      }
    }

    // Expressions to reuse — only saved/suggested vocabulary with real meanings.
    const wordItems: string[] = [];
    const savedKeys = new Set(
      snapshot.savedVocabulary.map((v) => v.headword.trim().toLowerCase()),
    );
    for (const v of snapshot.savedVocabulary) {
      if (!v.headword.trim() || !v.meaning?.trim()) continue;
      wordItems.push(`Saved: "${v.headword.trim()}" — ${v.meaning.trim()}`);
      if (wordItems.length >= MAX_SECTION_ITEMS) break;
    }
    if (wordItems.length < MAX_SECTION_ITEMS) {
      for (const entry of snapshot.feedback) {
        const vocab = entry.vocabulary;
        if (!vocab?.headword?.trim() || !vocab.meaning?.trim()) continue;
        const key = vocab.headword.trim().toLowerCase();
        if (savedKeys.has(key)) continue;
        savedKeys.add(key);
        wordItems.push(`Suggested: "${vocab.headword.trim()}" — ${vocab.meaning.trim()}`);
        if (wordItems.length >= MAX_SECTION_ITEMS) break;
      }
    }
    if (wordItems.length > 0) {
      sections.push({ id: 'expressions', title: 'Expressions to reuse', items: wordItems });
    }

    // Practice next — from plan focus areas (real evidence only).
    const practiceItems: string[] = [];
    for (const w of handle.session.plan.weaknessTargets) {
      practiceItems.push(
        `${w.type.replace(/_/g, ' ')}${w.label ? `: "${w.label}"` : ''} (${w.occurrenceCount} time${w.occurrenceCount === 1 ? '' : 's'})`,
      );
    }
    for (const expr of handle.session.plan.targetExpressions) {
      practiceItems.push(`Use "${expr.headword}" in your next conversation.`);
    }
    if (practiceItems.length > 0) {
      sections.push({
        id: 'practice_next',
        title: 'What to practise next',
        items: practiceItems.slice(0, MAX_SECTION_ITEMS),
      });
    }

    const isDemo = !handle.isRealAI;
    let notice: string;
    if (isDemo) {
      notice = 'Offline demo session — nothing from this practice was saved to your learning memory.';
    } else if (!persistence.ok && persistence.reason === 'persistence-failed') {
      notice = 'This conversation could not be saved. Nothing was lost from the practice itself.';
    } else if (!persistence.ok && persistence.reason === 'empty') {
      notice = 'Nothing to save from this session yet.';
    } else if (persistence.ok) {
      notice = 'Saved to your learning memory.';
    } else {
      notice = 'This session was not saved.';
    }

    return {
      sessionId: handle.session.id,
      planId: handle.session.plan.id,
      practiceType: handle.session.plan.practiceType,
      source: handle.session.plan.source,
      learnerTurns,
      tutorTurns,
      sections,
      hasEvidence: sections.length > 0,
      isDemo,
      notice,
      persistence,
      generatedAt: endedAt,
    };
  }

  /* ------------------------------ helpers ----------------------------- */

  private requireActiveHandle(): SpeakingSessionHandle {
    if (!this.handle) {
      throw new Error('No active speaking practice session. Call startPractice first.');
    }
    return this.handle;
  }

  private resolveAIProvider(): AIProvider | null {
    if (this.deps.disableAI) return null;
    if (this.deps.aiProvider) return this.deps.aiProvider;
    const key = getGeminiApiKey();
    return key ? createGeminiAIProvider({ apiKey: key }) : null;
  }
}

/* ------------------------------------------------------------------ *
 * Composition factory
 * ------------------------------------------------------------------ */

/**
 * Compose a SpeakingPracticeService on the existing learner model + adapter.
 * Same canonical database as Talk/Adaptive Lessons/Listening/etc.
 */
export interface SpeakingPracticeServiceOptions {
  readonly aiProvider?: AIProvider;
  readonly disableAI?: boolean;
  /** EXISTING progress store, composed by the caller (never opened here). */
  readonly progress?: SpeakingProgressPort;
  /** False when the learner model is the demo model (never personalized). */
  readonly evidenceIsReal?: boolean;
}

export function createSpeakingPracticeService(
  learnerModel: LearnerModel,
  adapter?: DatabaseAdapter,
  options?: SpeakingPracticeServiceOptions,
): SpeakingPracticeService {
  return new SpeakingPracticeService({
    learnerModel,
    ...(adapter ? { databaseAdapter: adapter } : {}),
    ...(options?.aiProvider ? { aiProvider: options.aiProvider } : {}),
    ...(options?.disableAI ? { disableAI: true } : {}),
    ...(options?.progress ? { progress: options.progress } : {}),
    ...(options?.evidenceIsReal === false ? { evidenceIsReal: false } : {}),
  });
}
