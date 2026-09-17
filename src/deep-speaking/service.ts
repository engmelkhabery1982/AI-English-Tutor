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
 */

import type {
  AIProvider,
  ConversationFeedback,
} from '../providers/ai/types';
import type { ConversationRequest } from '../conversation-engine/types';
import type { ConversationEngine } from '../conversation-engine';
import type {
  ConversationSession,
  ConversationSessionConfig,
  ConversationSessionResult,
} from '../conversation-session';
import type { CoachingContext, CoachingRecentConversation } from '../learner-model';
import type { LearnerModel } from '../learner-model';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { IsoDate } from '../domain/shared/types';

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
  resolveTalkCoaching,
  type TalkProviderKind,
} from '../talk-demo';
import { generateId } from '../shared/id';
import { nowIso } from '../shared/time';

import { planSpeakingPractice } from './planner';
import {
  buildSpeakingCoachingPrompt,
  buildTutorOpeningMessage,
  isShortAnswer,
  shouldReformulate,
} from './prompts';
import type {
  SpeakingPracticePlan,
  SpeakingPracticePlanResult,
  SpeakingPracticeProgress,
  SpeakingPracticeSession,
  SpeakingPracticeSummary,
  SpeakingPlannerOptions,
  SpeakingSummarySection,
  SpeakingTurnGoal,
  SpeakingTurnGoalKind,
} from './types';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const MAX_REFORMULATIONS = 2;
const MAX_SECTION_ITEMS = 4;

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
  readonly session: SpeakingPracticeSession;
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
  finalized: boolean;
  abandoned: boolean;
  /** Set of feedback object identities already persisted (dedup). */
  persistedFeedback: WeakSet<ConversationFeedback>;
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export interface SpeakingPracticeServiceDeps {
  readonly learnerModel: LearnerModel;
  readonly databaseAdapter?: DatabaseAdapter;
  readonly aiProvider?: AIProvider;
  readonly disableAI?: boolean;
  readonly memoryService?: ConversationMemoryService;
  readonly learningPersistence?: LearningPersistenceService;
  readonly now?: () => IsoDate;
}

export class SpeakingPracticeService {
  private readonly deps: SpeakingPracticeServiceDeps;
  private handle: SpeakingSessionHandle | null = null;

  constructor(deps: SpeakingPracticeServiceDeps) {
    this.deps = deps;
  }

  /* ----------------------------- planning ----------------------------- */

  async planPractice(
    options?: SpeakingPlannerOptions,
  ): Promise<SpeakingPracticePlanResult> {
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

    return planSpeakingPractice(
      {
        coaching,
        hasProfile: true,
        recentConversations,
        now: this.deps.now?.() ?? nowIso(),
      },
      options,
    );
  }

  /* --------------------------- start practice -------------------------- */

  async startPractice(
    plan: SpeakingPracticePlan,
  ): Promise<{
    readonly session: SpeakingPracticeSession;
    readonly conversationSession: ConversationSession;
    readonly providerKind: TalkProviderKind;
    readonly isRealAI: boolean;
  }> {
    if (this.handle) {
      throw new Error('A speaking practice session is already in progress.');
    }

    const now = this.deps.now?.() ?? nowIso();
    const aiProvider = this.resolveAIProvider();
    const isRealAI = aiProvider !== null && !this.deps.disableAI;
    const providerKind: TalkProviderKind = isRealAI ? 'gemini' : 'demo';
    const resolvedProvider = aiProvider ?? createDemoAIProvider();

    // Mutable turn-goal state — the decorator reads this on every buildRequest.
    let currentTurnGoal: SpeakingTurnGoal = plan.turnGoals[0] ?? {
      turnIndex: 0,
      goal: 'open',
      instruction: 'Open the conversation.',
    };

    // EXISTING engine → decorator → orchestrator → session
    const innerEngine = createConversationEngine(this.deps.learnerModel);
    const engine = createSpeakingEngineDecorator(innerEngine, {
      plan,
      getCurrentTurnGoal: () => currentTurnGoal,
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
        coaching.profile.learnerId,
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
      currentTurnGoal,
      reformulationsUsed: 0,
      finalizationLock: null,
      finalized: false,
      abandoned: false,
      persistedFeedback: new WeakSet<ConversationFeedback>(),
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
    const openingMessage = buildTutorOpeningMessage(handle.session.plan);
    const result = await handle.conversationSession.openConversation!(
      { userMessage: openingMessage },
      onChunk,
    );
    // Note feedback from the opening (vocabulary suggestions, etc.)
    if (result.ok) {
      handle.recorder.noteFeedback(handle.conversationSession.getLastFeedback());
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
    if (handle.abandoned) {
      throw new Error('This speaking practice session has been closed.');
    }
    if (handle.finalized || handle.finalizationLock) {
      throw new Error('This speaking practice session is already complete.');
    }
    if (handle.session.learnerTurnCount >= handle.session.plan.hardMaxTurns) {
      throw new Error('The maximum number of turns for this session has been reached.');
    }

    const result = await handle.conversationSession.send(
      { userMessage: message },
      onChunk,
    );

    if (!result.ok) {
      // AI failure: do not increment, do not persist, do not note feedback.
      return result;
    }

    // Turn committed successfully.
    handle.session = {
      ...handle.session,
      learnerTurnCount: handle.session.learnerTurnCount + 1,
    };

    const feedback = handle.conversationSession.getLastFeedback();

    // Note feedback for conversation memory (recorder dedups by identity).
    handle.recorder.noteFeedback(feedback);

    // Feed REAL feedback exactly once to the existing LearningPersistenceService.
    if (handle.isRealAI && feedback) {
      this.persistFeedbackOnce(handle, feedback);
    }

    // Update the turn goal for the NEXT tutor reply based on this answer.
    this.updateTurnGoal(handle, message, feedback);

    return result;
  }

  /* ---------------------- turn-goal adaptation ------------------------ */

  /**
   * Update the current turn goal for the next tutor reply based on the
   * learner's answer and any real correction evidence.
   */
  private updateTurnGoal(
    handle: SpeakingSessionHandle,
    learnerAnswer: string,
    feedback: ConversationFeedback | null,
  ): void {
    const plan = handle.session.plan;
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
        instruction:
          'Ask the learner to reformulate their previous answer more naturally. ' +
          'Do not provide the final answer before they try.',
      };
      return;
    }

    // Check expansion (qualitative short-answer heuristic)
    if (isShortAnswer(learnerAnswer)) {
      handle.currentTurnGoal = {
        turnIndex: nextTurnIndex,
        goal: 'expand',
        instruction:
          'The learner\'s previous answer was short. Ask ONE focused follow-up ' +
          'that requires elaboration — a reason, an example, or "what happened next".',
      };
      return;
    }

    // Otherwise, use the planner's predetermined turn goal for this index.
    const plannedGoal = plan.turnGoals.find(
      (g) => g.turnIndex === nextTurnIndex,
    );
    handle.currentTurnGoal =
      plannedGoal ??
      plan.turnGoals.find((g) => g.goal === 'follow_up') ??
      handle.currentTurnGoal;
  }

  /* ------------------------- feedback persist ------------------------- */

  /**
   * Feed a REAL ConversationFeedback to the existing LearningPersistenceService
   * exactly once. Dedup is by object identity (WeakSet).
   */
  private persistFeedbackOnce(
    handle: SpeakingSessionHandle,
    feedback: ConversationFeedback,
  ): void {
    if (handle.persistedFeedback.has(feedback)) return;
    handle.persistedFeedback.add(feedback);
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
   * Finalize the speaking practice session. Idempotent: calling twice
   * returns the same summary. Racing with dispose() cannot duplicate
   * memory finalization (shared finalizationLock).
   */
  async completePractice(): Promise<SpeakingPracticeSummary> {
    const handle = this.handle;
    if (!handle) {
      throw new Error('No active speaking practice session.');
    }
    if (handle.finalizationLock) {
      return handle.finalizationLock;
    }

    const promise = this.finalizeInternal(handle);
    handle.finalizationLock = promise;
    try {
      return await promise;
    } finally {
      // Keep the lock resolved so repeated calls return the same promise.
      // The `finalized` flag prevents re-entry into finalizeInternal.
    }
  }

  private async finalizeInternal(
    handle: SpeakingSessionHandle,
  ): Promise<SpeakingPracticeSummary> {
    if (handle.finalized) {
      // Should not reach here because finalizationLock guards entry,
      // but defensive: never finalize twice.
      throw new Error('Session already finalized.');
    }

    handle.session = { ...handle.session, completed: true, endedAt: nowIso() };

    // Finalize conversation memory through the EXISTING exactly-once path.
    let persistence: FinalizeConversationResult;
    try {
      persistence = await finalizeConversationWithReview({
        session: handle.conversationSession,
        recorder: handle.recorder,
        isRealAI: handle.isRealAI,
        service: handle.memoryService,
      });
    } catch {
      persistence = {
        ok: false,
        reason: 'persistence-failed',
        errorMessage: 'This conversation could not be saved.',
      };
    }

    handle.finalized = true;

    const summary = this.buildSummary(handle, persistence);
    return summary;
  }

  /* ----------------------------- dispose ------------------------------ */

  /**
   * Safe teardown (screen unmount / leaving). Idempotent.
   * If the session had committed learner turns and was not already completed,
   * finalizes memory once. Never finalizes twice.
   */
  async dispose(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    handle.abandoned = true;

    // Abandon the conversation session first (prevents late commits).
    handle.conversationSession.abandon?.();

    // If not already finalized and there were real learner turns, finalize once.
    if (!handle.finalized && !handle.finalizationLock) {
      if (handle.recorder.hasCommittedLearnerTurn(handle.conversationSession)) {
        const promise = this.finalizeInternal(handle).catch(() => undefined as unknown as SpeakingPracticeSummary);
        handle.finalizationLock = promise as Promise<SpeakingPracticeSummary>;
        try {
          await promise;
        } catch {
          // Disposal failures are non-destructive.
        }
      }
    } else if (handle.finalizationLock) {
      // A completion is in flight: wait for it to settle.
      try {
        await handle.finalizationLock;
      } catch {
        // Ignore.
      }
    }

    this.handle = null;
  }

  /* --------------------------- summary build -------------------------- */

  private buildSummary(
    handle: SpeakingSessionHandle,
    persistence: FinalizeConversationResult,
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

    // What went well — only when there were clean learner turns.
    const corrections = snapshot.feedback
      .map((f) => f.correction)
      .filter(
        (c): c is NonNullable<typeof c> =>
          Boolean(c && c.original && c.improved),
      );
    const cleanTurns = Math.max(0, learnerTurns - corrections.length);
    if (learnerTurns > 0 && cleanTurns > 0) {
      sections.push({
        id: 'went_well',
        title: 'What went well',
        items: [
          `${cleanTurns} of your ${learnerTurns} turns were understood without a correction.`,
        ],
      });
    }

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
      generatedAt: nowIso(),
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
export function createSpeakingPracticeService(
  learnerModel: LearnerModel,
  adapter?: DatabaseAdapter,
  options?: {
    readonly aiProvider?: AIProvider;
    readonly disableAI?: boolean;
  },
): SpeakingPracticeService {
  return new SpeakingPracticeService({
    learnerModel,
    ...(adapter ? { databaseAdapter: adapter } : {}),
    ...(options?.aiProvider ? { aiProvider: options.aiProvider } : {}),
    ...(options?.disableAI ? { disableAI: true } : {}),
  });
}
