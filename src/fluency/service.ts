/**
 * src/fluency/service.ts
 *
 * FluencyPracticeService: WP-3 deliberate fluency training as an
 * ORCHESTRATION layer over the EXISTING SpeakingPracticeService.
 *
 * REUSE CONTRACT (no duplicate systems)
 * - Conversation intelligence: the EXISTING SpeakingPracticeService, which
 *   itself owns ConversationEngine → ConversationOrchestrator →
 *   ConversationSession. This service never builds a request, never creates
 *   a session, never calls an AI provider.
 * - Voice: the EXISTING VoiceSessionCoordinator, created by the UI over the
 *   session this service exposes. Recording/STT/TTS lifecycle is never
 *   duplicated here: `speaking`/`processing` name the PRACTICE phase only.
 * - Learner evidence: read-only, behind the speaking service. This module
 *   never touches the learner model, the weakness lifecycle, review or
 *   vocabulary stores.
 * - LearningPersistenceService: used ONLY by the existing speaking service,
 *   exactly once per committed REAL turn. This module never calls it, so
 *   repetition comparison can never double-count feedback.
 * - Conversation memory: finalized ONLY through the existing
 *   speaking.completePractice()/dispose() path, exactly once per underlying
 *   practice. Repeated attempts are distinguished at THIS layer (attempt
 *   number + stable task id) without duplicating committed turns.
 * - Pronunciation: qualitative lines produced by the EXISTING engine may be
 *   passed in per attempt and pass through verbatim (bounded). Nothing is
 *   scored, and unavailable pronunciation is omitted, never invented.
 *
 * COMMITMENT / HONESTY GUARANTEES
 * - Attempt count advances EXACTLY once per committed attempt (single-flight
 *   + exactly-once increment after the underlying session committed).
 * - Failed STT (no transcript) never reaches here; an empty transcript is
 *   refused without advancing.
 * - Failed AI never advances the attempt, writes no evidence, moves no
 *   support, and creates no weakness (provider failure != learner weakness).
 * - Replay is TTS-only at the UI layer and never calls this service, so it
 *   can never create an attempt.
 * - Stale results (New Task / Exit while work is in flight) are discarded via
 *   a generation counter: a stale attempt can never mutate the new task.
 * - Demo/offline attempts are counted but never trusted: no evaluative
 *   comparison, no de-scaffolding, no personalized claim.
 */

import type { CefrLevelInput, IsoDate } from '../domain/shared/types';
import type { ConversationFeedback } from '../providers/ai/types';
import type { ConversationSession } from '../conversation-session';
import type { SpeakingPracticeService } from '../deep-speaking/service';
import type {
  SpeakingPracticeSummary,
  SpeakingPracticeType,
} from '../deep-speaking/types';
import { nowIso } from '../shared/time';

import {
  MAX_ROUNDS_PER_TASK,
  buildFluencyOpeningInstruction,
  cuesForSupport,
  getFluencyTask,
  getTransferTask,
  listFluencyTasks,
  repeatPromptFor,
} from './tasks';
import {
  initialSupportLevel,
  isStrongAttempt,
  resolveSupportLevel,
} from './support-policy';
import {
  buildAttemptEvidence,
  compareAttempts,
  isTaskCompleted,
} from './evidence';
import { evaluateRepairTrigger } from './repair-policy';
import { recordFluencySuccess, type SuccessObservationRecorder } from '../reassessment';
import type {
  FluencyAttemptEvidence,
  FluencyAttemptResult,
  FluencyComparison,
  FluencyCues,
  FluencyPhase,
  FluencyRepairDecision,
  FluencyRepeatPrompt,
  FluencySessionSnapshot,
  FluencySummary,
  FluencySupportLevel,
  FluencyTask,
  FluencyTaskKind,
} from './types';

/* ------------------------------------------------------------------ *
 * Fluency task → existing deep-speaking practice type (additive mapping)
 * ------------------------------------------------------------------ */

/**
 * Map a fluency task onto the EXISTING deep-speaking practice type whose
 * coaching posture fits it. The underlying practice keeps owning turn goals,
 * persistence and memory; the fluency layer only runs the task on top.
 */
export function practiceTypeForFluencyTask(task: FluencyTask): SpeakingPracticeType {
  switch (task.kind) {
    case 'repetition':
      return 'reformulation';
    case 'monologue':
      return 'explain_and_expand';
    case 'repair':
      return 'reformulation';
  }
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export interface FluencyPracticeServiceDeps {
  readonly successRecorder?: SuccessObservationRecorder;
  /** The EXISTING speaking service (owns conversation + persistence + memory). */
  readonly speaking: SpeakingPracticeService;
  readonly now?: () => IsoDate;
}

export interface FluencyStartTaskOptions {
  /**
   * Stored working level for initial support (defaults to guided when
   * absent). Never a proficiency claim — only the starting cue level.
   */
  readonly learnerLevel?: CefrLevelInput;
  /** Explicit starting support (bounded; overrides the level default). */
  readonly initialSupport?: FluencySupportLevel;
  /** Carry this support in (transfer tasks keep the earned level). */
  readonly carrySupport?: FluencySupportLevel;
}

export class FluencyPracticeService {
  private readonly deps: FluencyPracticeServiceDeps;

  private phase: FluencyPhase = 'ready';
  private task: FluencyTask | null = null;
  private attemptNumber = 0;
  private supportLevel: FluencySupportLevel = 'guided';
  private startedSupport: FluencySupportLevel = 'guided';
  private attempts: FluencyAttemptEvidence[] = [];
  private supportByAttempt: FluencySupportLevel[] = [];
  private comparisons: FluencyComparison[] = [];
  private lastRepair: FluencyRepairDecision | null = null;
  private lastFeedback: ConversationFeedback | null = null;
  private lastError: string | null = null;
  private lastTutorReply = '';
  private consecutiveStrong = 0;
  private isRealAI = false;
  private conversationSession: ConversationSession | null = null;
  private summary: FluencySummary | null = null;

  /**
   * Invalidation generation. Bumped synchronously by startTask() and
   * dispose() BEFORE any await, so an in-flight attempt/opening whose
   * generation no longer matches is discarded instead of mutating the
   * new task (or a dead screen).
   */
  private generation = 0;
  /** Single-flight guards (synchronous, like the existing screens). */
  private starting = false;
  private pendingAttempt = false;
  private completing = false;
  private disposed = false;
  private resolvedLearnerLevel: CefrLevelInput | undefined = undefined;

  constructor(deps: FluencyPracticeServiceDeps) {
    this.deps = deps;
  }

  private now(): IsoDate {
    return this.deps.now?.() ?? nowIso();
  }

  /* ------------------------------ state ------------------------------ */

  /** Explicit domain snapshot (task, attempt, support — never hidden). */
  getSnapshot(): FluencySessionSnapshot {
    return {
      phase: this.phase,
      taskId: this.task?.id ?? null,
      taskKind: this.task?.kind ?? null,
      attemptNumber: this.attemptNumber,
      supportLevel: this.supportLevel,
      isRealAI: this.isRealAI,
      hasActiveAttempt: this.pendingAttempt,
      lastError: this.lastError,
      consecutiveStrongAttempts: this.consecutiveStrong,
    };
  }

  getPhase(): FluencyPhase {
    return this.phase;
  }

  /** The EXISTING ConversationSession the UI wires voice over (or null). */
  getConversationSession(): ConversationSession | null {
    return this.conversationSession;
  }

  /** Committed attempt evidence for the current task (oldest first). */
  getAttempts(): readonly FluencyAttemptEvidence[] {
    return [...this.attempts];
  }

  /** Latest repetition comparison (null until the second attempt). */
  getComparison(): FluencyComparison | null {
    return this.comparisons.length > 0
      ? (this.comparisons[this.comparisons.length - 1] ?? null)
      : null;
  }

  /** Latest repair decision (null until the first committed attempt). */
  getRepair(): FluencyRepairDecision | null {
    return this.lastRepair;
  }

  /** Real structured feedback of the last committed attempt (null in demo). */
  getLastFeedback(): ConversationFeedback | null {
    return this.lastFeedback;
  }

  /** Cues currently shown for the active task (bounded by support). */
  getCues(): FluencyCues | null {
    if (!this.task) return null;
    return cuesForSupport(this.task, this.supportLevel);
  }

  /** The active task (null before the first startTask). */
  getTask(): FluencyTask | null {
    return this.task;
  }

  /* ------------------------------ tasks ------------------------------ */

  listTasks(kind?: FluencyTaskKind): readonly FluencyTask[] {
    return listFluencyTasks(kind);
  }

  findTask(taskId: string): FluencyTask | null {
    return getFluencyTask(taskId);
  }

  /* ---------------------------- start task ---------------------------- */

  /**
   * Start (or switch to) a fluency task.
   *
   * - The SAME stable task id persists across every repetition round.
   * - Any in-flight attempt/opening of the previous task is invalidated
   *   synchronously (generation++ before the first await): its late result
   *   is discarded and can never mutate the new task.
   * - The underlying speaking practice is restarted per task (seeded with
   *   the task prompt), so conversation memory keeps the honest topic and
   *   turn bounds never leak across tasks.
   */
  async startTask(
    taskId: string,
    options?: FluencyStartTaskOptions,
  ): Promise<{ task: FluencyTask; supportLevel: FluencySupportLevel; isRealAI: boolean }> {
    if (this.disposed) {
      throw new Error('This fluency practice has been closed.');
    }
    if (this.starting) {
      throw new Error('A fluency task is already being prepared.');
    }
    const task = getFluencyTask(taskId);
    if (!task) {
      throw new Error('This speaking task is not available.');
    }

    // SYNCHRONOUS invalidation first: every in-flight attempt/opening of the
    // previous task is stale from this tick on, before the first await.
    this.starting = true;
    this.generation += 1;
    const generation = this.generation;
    this.phase = 'preparing';
    this.lastError = null;
    this.summary = null;

    try {
      // Close the previous underlying practice (if any). Its partial
      // conversation is finalized through the EXISTING memory path exactly
      // like Talk's New Chat — never duplicated, never rewritten.
      await this.deps.speaking.dispose();

      const planned = await this.deps.speaking.planPractice({
        practiceType: practiceTypeForFluencyTask(task),
        seed: {
          stepId: task.id,
          targetText: task.prompt,
          prompt: buildFluencyOpeningInstruction(task),
        },
      });
      if (this.generation !== generation || this.disposed) return this.staleStart();
      if (planned.status !== 'planned') {
        this.phase = 'error';
        this.lastError = planned.message;
        throw new Error(planned.message);
      }

      const started = await this.deps.speaking.startPractice(planned.plan);
      if (this.generation !== generation || this.disposed) {
        // A newer task (or Exit) replaced this one while it prepared: the
        // orphaned underlying practice is closed, and nothing is installed.
        await this.deps.speaking.dispose();
        return this.staleStart();
      }

      // Install the new task state (attempts reset, support resolved).
      this.task = task;
      this.attemptNumber = 0;
      this.attempts = [];
      this.supportByAttempt = [];
      this.comparisons = [];
      this.lastRepair = null;
      this.lastFeedback = null;
      this.lastTutorReply = '';
      this.consecutiveStrong = 0;
      this.isRealAI = started.isRealAI;
      this.conversationSession = started.conversationSession;
      const planLevel = planned.plan.progression?.workingLevel as CefrLevelInput | undefined;
      const resolvedLevel = options?.learnerLevel ?? planLevel;
      this.resolvedLearnerLevel = resolvedLevel;

      const resolved =
        options?.carrySupport ??
        options?.initialSupport ??
        (resolvedLevel ? initialSupportLevel(resolvedLevel) : 'guided');
      this.supportLevel = resolved;
      this.startedSupport = resolved;

      const opening = await this.deps.speaking.openConversation();
      if (this.generation !== generation || this.disposed) {
        await this.deps.speaking.dispose();
        this.conversationSession = null;
        return this.staleStart();
      }
      if (!opening.ok) {
        // The opening failed honestly: no attempt was counted, nothing was
        // persisted. The learner sees the real reason and can retry.
        this.phase = 'error';
        this.lastError =
          opening.error?.message ??
          'The tutor could not start this task. Please try again.';
        throw new Error(this.lastError);
      }

      this.phase = 'speaking';
      return { task, supportLevel: this.supportLevel, isRealAI: this.isRealAI };
    } finally {
      this.starting = false;
    }
  }

  /** A startTask whose generation was superseded reports itself as stale. */
  private staleStart(): never {
    throw new Error(
      'The conversation changed before this task finished preparing, so it was discarded.',
    );
  }

  /* -------------------------- submit attempt -------------------------- */

  /**
   * Submit ONE learner attempt (transcript already produced by the EXISTING
   * voice stack or typed). The attempt is sent through the EXISTING speaking
   * service: exactly one conversation turn per attempt, so a sustained
   * monologue can never become multiple tutor turns.
   *
   * Exactly-once: the attempt number advances only after the underlying
   * session really committed the turn. Failed, refused and stale submissions
   * never advance, never write evidence and never move support.
   */
  async submitAttempt(input: {
    readonly transcript: string;
    /** Real qualitative pronunciation lines (omit when unavailable). */
    readonly pronunciationLines?: readonly string[];
    readonly onChunk?: (chunk: string) => void;
  }): Promise<FluencyAttemptResult> {
    if (this.disposed) {
      throw new Error('This fluency practice has been closed.');
    }
    if (this.starting) {
      throw new Error('The task is still being prepared. Please wait.');
    }
    if (this.pendingAttempt) {
      throw new Error('An attempt is already being processed.');
    }
    if (this.phase !== 'speaking' && this.phase !== 'repeat_ready' && this.phase !== 'error') {
      throw new Error(
        this.phase === 'processing'
          ? 'An attempt is already being processed.'
          : 'No attempt can be submitted right now.',
      );
    }
    const task = this.task;
    const session = this.conversationSession;
    if (!task || !session) {
      throw new Error('No active fluency task. Start a task first.');
    }
    if (this.attemptNumber >= MAX_ROUNDS_PER_TASK) {
      return {
        ok: false,
        reason: 'refused',
        errorMessage: `This task already has ${MAX_ROUNDS_PER_TASK} attempts. Start the transfer task or finish.`,
      };
    }

    const transcript = input.transcript.trim();
    if (transcript.length === 0) {
      // Failed/empty STT never becomes an attempt: no advance, no evidence.
      return {
        ok: false,
        reason: 'empty',
        errorMessage: 'No speech was recognized. Please try again, or type your answer.',
      };
    }

    // Single-flight from this tick on: a double submit can never count twice.
    this.pendingAttempt = true;
    const generation = this.generation;
    const previousPhase: FluencyPhase =
      this.phase === 'error' ? 'speaking' : this.phase;
    this.phase = 'processing';
    this.lastError = null;

    try {
      let result: Awaited<ReturnType<SpeakingPracticeService['sendLearnerTurn']>>;
      try {
        result = await this.deps.speaking.sendLearnerTurn(transcript, input.onChunk);
      } catch (error) {
        // The underlying service refused the turn (e.g. turn bounds): an
        // honest failure, never an attempt.
        if (this.generation !== generation || this.disposed) {
          return this.staleAttempt();
        }
        this.phase = 'error';
        this.lastError =
          error instanceof Error
            ? error.message
            : 'Your attempt could not be completed. Please try again.';
        return { ok: false, reason: 'failed', errorMessage: this.lastError };
      }

      // STALE GUARD: New Task / Exit while the AI answered. The late result
      // is discarded — it can never mutate the new task.
      if (this.generation !== generation || this.disposed) {
        return this.staleAttempt();
      }

      if (!result.ok) {
        // Failed AI: no committed tutor response, no attempt evidence, no
        // support move, no weakness. Provider failure != learner weakness.
        this.phase = 'error';
        this.lastError =
          result.error?.message ?? 'The tutor could not reply. Please try again.';
        return { ok: false, reason: 'failed', errorMessage: this.lastError };
      }

      // COMMITTED: exactly-once advance for this attempt.
      const committedNumber = this.attemptNumber + 1;
      const previousSupport = this.supportLevel;
      const feedback = result.feedback ?? null;
      const severity = feedback?.correction?.severity ?? null;
      const evidence = buildAttemptEvidence({
        attemptNumber: committedNumber,
        task,
        transcript,
        feedback,
        isRealAI: this.isRealAI,
        ...(input.pronunciationLines ? { pronunciationLines: input.pronunciationLines } : {}),
        now: this.now(),
      });

      this.attemptNumber = committedNumber;
      this.attempts.push(evidence);
      this.supportByAttempt.push(previousSupport);

      // De-scaffolding input: the trailing run of strong attempts. Demo,
      // failed and weak attempts reset it (demo never de-scaffolds).
      if (!this.isRealAI) {
        this.consecutiveStrong = 0;
      } else if (
        isStrongAttempt({
          completed: isTaskCompleted(evidence, task),
          correctionSeverity: severity,
        })
      ) {
        this.consecutiveStrong += 1;
        await this.persistStrongAttemptSuccess(task);
      } else {
        this.consecutiveStrong = 0;
      }
      this.supportLevel = resolveSupportLevel({
        learnerLevel: this.resolvedLearnerLevel ?? 'unknown',
        attemptNumber: committedNumber,
        priorSupport: previousSupport,
        isRealAI: this.isRealAI,
        failed: false,
        consecutiveStrongAttempts: this.consecutiveStrong,
      });

      // Repetition comparison from the second committed attempt on (real
      // structured evidence only; demo yields the honest notice instead).
      let comparison: FluencyComparison | null = null;
      if (this.attempts.length >= 2) {
        const previousAttempt = this.attempts[this.attempts.length - 2];
        const previousAttemptSupport =
          this.supportByAttempt[this.supportByAttempt.length - 2] ?? previousSupport;
        if (previousAttempt) {
          comparison = compareAttempts(task, previousAttempt, evidence, {
            previousSupport: previousAttemptSupport,
            currentSupport: previousSupport,
            now: this.now(),
          });
          this.comparisons.push(comparison);
        }
      }

      // Repair evaluation for THIS committed attempt (real evidence or an
      // explicit repair-exercise contract — never random, never in Talk).
      const repair = evaluateRepairTrigger({
        surface: 'fluency',
        transcript: evidence.transcript,
        wordCount: evidence.wordCount,
        pointsCoveredCount: evidence.pointsCovered.length,
        correctionSeverity: this.isRealAI ? severity : null,
        isRealAI: this.isRealAI,
        repairExercise: task.repairContract?.isRepairExercise === true,
        attemptNumber: committedNumber,
      });
      this.lastRepair = repair;
      this.lastFeedback = this.isRealAI ? feedback : null;
      this.lastTutorReply = session
        .getHistory()
        .filter((turn) => turn.role === 'assistant')
        .at(-1)?.content ?? '';
      this.phase = 'feedback';

      void previousPhase;
      return {
        ok: true,
        evidence,
        feedback: this.lastFeedback,
        tutorReply: this.lastTutorReply,
        comparison,
        repair,
        supportLevel: this.supportLevel,
      };
    } finally {
      this.pendingAttempt = false;
    }
  }

  /** Honest discriminated result for a discarded stale attempt. */
  private staleAttempt(): FluencyAttemptResult {
    return {
      ok: false,
      reason: 'stale',
      errorMessage:
        'The conversation changed before this attempt finished, so it was discarded. Nothing was added to the new task.',
    };
  }

  /* --------------------------- evidence ------------------------------- */

  /**
   * Persist success evidence for ONE committed strong attempt.
   *
   * WP-4 identity integrity: the learner id comes from the OWNING speaking
   * service (`speaking.getLearnerId()`, a narrow accessor over the existing
   * learner model). There is NO `as any` reach-through and NO placeholder
   * fallback:
   * - demo/offline practice (`isRealAI === false`) writes no trusted strength;
   * - a failed AI attempt and a stale attempt never reach this method;
   * - an unavailable learner id writes NOTHING — no fabricated learner row.
   *
   * Persistence failure is non-destructive: a recorder error never breaks the
   * practice or the committed attempt the learner already made.
   */
  private async persistStrongAttemptSuccess(task: FluencyTask): Promise<void> {
    const recorder = this.deps.successRecorder;
    if (!recorder) return;
    // Demo practice is counted, never trusted: no evaluative strength.
    if (!this.isRealAI) return;
    const learnerId = this.resolveLearnerId();
    if (!learnerId) return;
    try {
      await recordFluencySuccess(recorder, {
        learnerId,
        referenceId: `fluency:${task.id}`,
        context: `support:${this.supportLevel}`,
        summary: `Strong fluency attempt on ${task.title}`,
      });
    } catch {
      // Evidence persistence never breaks the learner's practice.
    }
  }

  /**
   * The REAL learner id from the owning speaking service, or null when it is
   * unavailable. Never a fallback value, never a guess.
   */
  private resolveLearnerId(): string | null {
    try {
      return this.deps.speaking.getLearnerId();
    } catch {
      return null;
    }
  }

  /* --------------------- feedback → repeat → next --------------------- */

  /**
   * Acknowledge the tutor feedback: feedback → repeat_ready. Repeat / Next /
   * Finish become valid; submitting directly from `feedback` stays refused
   * so the state machine (not hidden UI timing) owns the transition.
   */
  acknowledgeFeedback(): FluencySessionSnapshot {
    if (this.phase !== 'feedback') {
      throw new Error('There is no feedback to acknowledge right now.');
    }
    this.phase = 'repeat_ready';
    return this.getSnapshot();
  }

  /**
   * Request the deterministic repeat prompt for the next round of the SAME
   * task (repeat_ready → speaking). The task identity never changes here.
   */
  requestRepeat(): FluencyRepeatPrompt {
    if (!this.task) {
      throw new Error('No active fluency task. Start a task first.');
    }
    if (this.phase !== 'feedback' && this.phase !== 'repeat_ready') {
      throw new Error('A repetition can only start after feedback.');
    }
    if (this.attemptNumber >= MAX_ROUNDS_PER_TASK) {
      throw new Error(
        `This task already has ${MAX_ROUNDS_PER_TASK} attempts. Start the transfer task or finish.`,
      );
    }
    const prompt = repeatPromptFor(this.task, this.attemptNumber + 1, this.supportLevel);
    this.phase = 'speaking';
    return prompt;
  }

  /* ------------------------------ transfer ---------------------------- */

  /**
   * Start the transfer variant: a RELATED context with the SAME learning
   * target (avoids memorization). Attempts reset for the new task identity,
   * but the earned support level is carried (gradually less assistance).
   * Returns null when the task has no transfer variant.
   */
  async startTransfer(): Promise<{
    task: FluencyTask;
    supportLevel: FluencySupportLevel;
    isRealAI: boolean;
  } | null> {
    if (!this.task) {
      throw new Error('No active fluency task. Start a task first.');
    }
    const transfer = getTransferTask(this.task);
    if (!transfer) return null;
    return this.startTask(transfer.id, { carrySupport: this.supportLevel });
  }

  /* ------------------------------ complete ---------------------------- */

  /**
   * Finalize the fluency task practice. Idempotent: repeated calls return the
   * SAME summary. Memory is finalized exactly once through the EXISTING
   * speaking path; the fluency summary only adds real counts + evidence.
   */
  async complete(): Promise<FluencySummary> {
    if (this.disposed) {
      throw new Error('This fluency practice has been closed.');
    }
    if (this.summary) return this.summary;
    if (!this.task) {
      throw new Error('No active fluency task. Start a task first.');
    }
    if (this.starting || this.pendingAttempt) {
      throw new Error(
        'Your attempt is still in progress, so it is not counted yet. Finish once it settles — nothing will be lost.',
      );
    }
    if (this.completing) {
      throw new Error('This practice is already being finished.');
    }
    this.completing = true;
    try {
      let underlying: SpeakingPracticeSummary | null = null;
      try {
        underlying = await this.deps.speaking.completePractice();
      } catch {
        // The existing path reports its own failure honestly; the fluency
        // summary still describes the real attempts below.
        underlying = null;
      }
      const comparisons = this.comparisons.slice(-2);
      const attempts = this.attempts.length;
      const isDemo = !this.isRealAI;
      const notice = isDemo
        ? 'Offline demo practice — attempts were counted but nothing was compared or saved.'
        : attempts === 0
          ? 'No attempts were completed for this task.'
          : underlying
            ? 'Saved to your learning memory.'
            : 'This practice could not be saved. Nothing was lost from the practice itself.';
      this.summary = {
        taskId: this.task.id,
        taskTitle: this.task.title,
        taskKind: this.task.kind,
        attempts,
        startedSupport: this.startedSupport,
        endedSupport: this.supportLevel,
        supportTrajectory: [...this.supportByAttempt],
        comparisons,
        hasEvidence: comparisons.some((entry) => entry.hasEvidence),
        isDemo,
        notice,
        underlying,
        generatedAt: this.now(),
      };
      this.phase = 'completed';
      return this.summary;
    } finally {
      this.completing = false;
    }
  }

  /* ------------------------------- dispose ---------------------------- */

  /**
   * Safe teardown (New Task away / Exit / unmount). Idempotent. Invalidates
   * every in-flight attempt/opening synchronously, then closes the underlying
   * practice through the EXISTING dispose path (which finalizes real partial
   * work exactly once and never stores empty/demo sessions as memory).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    // SYNCHRONOUS invalidation first: late results are stale from this tick.
    this.disposed = true;
    this.generation += 1;
    this.conversationSession = null;
    try {
      await this.deps.speaking.dispose();
    } catch {
      // Disposal failures are non-destructive.
    }
  }

  /** True while an attempt submission is in flight (UI liveness signal). */
  hasActiveAttempt(): boolean {
    return this.pendingAttempt || this.starting;
  }

  /** Dismiss a recoverable error back to the last actionable phase. */
  dismissError(): FluencySessionSnapshot {
    if (this.phase !== 'error') {
      throw new Error('There is no error to dismiss.');
    }
    this.lastError = null;
    this.phase = this.attemptNumber === 0 ? 'speaking' : 'repeat_ready';
    return this.getSnapshot();
  }
}

/* ------------------------------------------------------------------ *
 * Composition factory
 * ------------------------------------------------------------------ */

export interface CreateFluencyPracticeServiceOptions {
  readonly now?: () => IsoDate;
  /**
   * The EXISTING success-observation recorder (WP-4 evidence symmetry).
   *
   * Supplying it lets a REAL strong attempt on a REAL learner id persist
   * strength evidence. Omitting it persists NOTHING — which is the honest
   * default: the fluency layer never invents a recorder, a learner id or a
   * strength row.
   */
  readonly successRecorder?: SuccessObservationRecorder;
}

export function createFluencyPracticeService(
  speaking: SpeakingPracticeService,
  options?: CreateFluencyPracticeServiceOptions,
): FluencyPracticeService {
  return new FluencyPracticeService({
    speaking,
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.successRecorder ? { successRecorder: options.successRecorder } : {}),
  });
}
