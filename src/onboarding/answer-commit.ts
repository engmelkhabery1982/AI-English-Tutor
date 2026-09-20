/**
 * src/onboarding/answer-commit.ts
 *
 * The typed-answer commit controller of the diagnostic assessment.
 *
 * WHY THIS EXISTS (real-device bug)
 * The assessment screen used to clear the learner's typed answer as soon as the
 * send handler finished — even when the turn had FAILED — while "Continue"
 * checks COMMITTED evidence. The learner therefore watched their answer
 * disappear and was then told "Say at least one answer before continuing."
 *
 * CONTRACT (one owner, testable without a React renderer)
 * - The draft is cleared ONLY after the answer really committed. On failure the
 *   EXACT typed text is kept, the learner sees one classified, learner-safe
 *   sentence, and Retry is offered. The learner may edit before retrying.
 * - A failed submission records NO evidence and increments NO committed turn.
 * - Duplicate commits are impossible: a submit/retry while one is in flight is
 *   refused synchronously, and a retry first verifies the committed learner-turn
 *   count (an answer that really committed is never sent a second time).
 * - Nothing is fabricated: this controller never invents an outcome, a level or
 *   evidence. It only decides what the learner keeps and what they are told.
 *
 * Provider text is mapped through the ONE failure path
 * (src/providers/failures.ts): a raw payload never becomes a learner message,
 * but stays available as `technicalDetail` for diagnostics.
 */

import { classifyProviderFailure, type ProviderFailure } from '../providers/failures';

/** Lifecycle of the typed answer box. */
export type AssessmentAnswerPhase = 'idle' | 'submitting' | 'failed';

/** Which diagnostic part the answer belongs to. */
export type AssessmentAnswerPurpose = 'speaking' | 'language_use';

export interface AssessmentAnswerState {
  /** What the input shows. Cleared ONLY after a successful commit. */
  readonly draft: string;
  readonly phase: AssessmentAnswerPhase;
  /** Classified, learner-safe sentence (never a raw provider payload). */
  readonly learnerMessage: string | null;
  /** Raw detail for logs/diagnostics. NEVER render this. */
  readonly technicalDetail: string | null;
  readonly failure: ProviderFailure | null;
  /** True when an explicit learner Retry is currently possible. */
  readonly retryAvailable: boolean;
  /** True while a commit is in flight (Retry/Send are refused). */
  readonly isSubmitting: boolean;
  /** Successful commits only. */
  readonly committedAnswers: number;
  /** The answer that failed and is still preserved in `draft`. */
  readonly preservedAnswer: string | null;
}

/** Step identity captured when a submission starts. */
export interface AssessmentAnswerStep {
  readonly stepId: string;
  readonly stepToken: number;
}

export interface AssessmentAnswerCommitResult {
  readonly ok: boolean;
  /** Provider/service failure text (may be raw — it is classified here). */
  readonly errorMessage?: string | null;
  readonly errorCode?: string | null;
  readonly errorRetryable?: boolean;
}

export interface AssessmentAnswerControllerDeps {
  /**
   * The ONE commit path (the existing onboarding service). It is called at most
   * once per submit/retry and must commit nothing when it reports `ok: false`.
   */
  readonly commit: (input: {
    readonly answer: string;
    readonly purpose: AssessmentAnswerPurpose;
    readonly step: AssessmentAnswerStep;
  }) => Promise<AssessmentAnswerCommitResult>;
  /** Current diagnostic step identity (null before the diagnostic starts). */
  readonly captureStep: () => AssessmentAnswerStep | null;
  /**
   * Committed learner turns in the LIVE conversation. Used to verify the commit
   * state before any replay, so a retry can never duplicate a learner turn.
   */
  readonly observeCommittedLearnerTurns: () => number;
  /** Which part of the diagnostic the typed answer belongs to right now. */
  readonly currentPurpose: () => AssessmentAnswerPurpose;
  /**
   * Called ONLY after a commit really succeeded (evidence recording stays with
   * the existing service/state machine — this controller fabricates nothing).
   */
  readonly onCommitted?: (info: {
    readonly answer: string;
    readonly purpose: AssessmentAnswerPurpose;
    readonly step: AssessmentAnswerStep;
    /** True when the answer had already committed before a retry ran. */
    readonly alreadyCommitted: boolean;
  }) => void;
  /** Called after a failed commit so the caller can log diagnostics. */
  readonly onFailure?: (info: {
    readonly answer: string;
    readonly failure: ProviderFailure;
  }) => void;
}

export interface AssessmentAnswerController {
  getState(): AssessmentAnswerState;
  subscribe(listener: (state: AssessmentAnswerState) => void): () => void;
  /** The learner typed: the draft changes, nothing is submitted. */
  setDraft(text: string): void;
  /** Submits the CURRENT draft. Refused while one submit is in flight. */
  submit(): Promise<AssessmentAnswerState>;
  /** Explicit learner Retry of the preserved (possibly edited) answer. */
  retry(): Promise<AssessmentAnswerState>;
  /** Clears the failure notice but NEVER the learner's preserved answer. */
  dismissMessage(): void;
  /**
   * Step change / restart: drops the failure state. The draft is kept unless the
   * caller says otherwise, so learner text is never destroyed by navigation.
   */
  reset(options?: { readonly clearDraft?: boolean }): void;
}

const INITIAL_STATE: AssessmentAnswerState = {
  draft: '',
  phase: 'idle',
  learnerMessage: null,
  technicalDetail: null,
  failure: null,
  retryAvailable: false,
  isSubmitting: false,
  committedAnswers: 0,
  preservedAnswer: null,
};

/** Honest sentence when the step moved on before a preserved answer was sent. */
export const ASSESSMENT_ANSWER_STEP_CHANGED_MESSAGE =
  'That answer arrived after the assessment step changed, so it was not recorded.';

/**
 * Honest notice when a turn DID commit but produced no assessment evidence yet
 * (for example a one-word answer). The evidence standard is unchanged: nothing is
 * recorded, and the learner is told exactly what is required.
 */
export const ASSESSMENT_SHORT_ANSWER_MESSAGE =
  'Your answer was sent, but it is too short to count as assessment evidence. Please answer in one or two full sentences.';

export function createAssessmentAnswerController(
  deps: AssessmentAnswerControllerDeps,
): AssessmentAnswerController {
  let state: AssessmentAnswerState = INITIAL_STATE;
  const listeners = new Set<(state: AssessmentAnswerState) => void>();
  /** The step identity the preserved answer was written for. */
  let submittedStep: AssessmentAnswerStep | null = null;
  /** Committed learner turns observed when the in-flight submit started. */
  let committedBaseline = 0;
  /**
   * Commit state observed when the CURRENT preserved answer was first submitted.
   * A retry verifies against this original baseline (not a fresh one), so an
   * answer that really committed during the first attempt is detected and never
   * sent a second time.
   */
  let preservedBaseline: number | null = null;
  /** Synchronous in-flight guard: a double tap can never commit twice. */
  let inFlight = false;

  const publish = (next: AssessmentAnswerState): void => {
    state = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // A subscriber problem must never lose the learner's answer.
      }
    }
  };

  const patch = (changes: Partial<AssessmentAnswerState>): AssessmentAnswerState => {
    const next: AssessmentAnswerState = {
      draft: changes.draft ?? state.draft,
      phase: changes.phase ?? state.phase,
      learnerMessage:
        changes.learnerMessage === undefined ? state.learnerMessage : changes.learnerMessage,
      technicalDetail:
        changes.technicalDetail === undefined ? state.technicalDetail : changes.technicalDetail,
      failure: changes.failure === undefined ? state.failure : changes.failure,
      retryAvailable:
        changes.retryAvailable === undefined ? state.retryAvailable : changes.retryAvailable,
      isSubmitting: changes.isSubmitting === undefined ? state.isSubmitting : changes.isSubmitting,
      committedAnswers:
        changes.committedAnswers === undefined ? state.committedAnswers : changes.committedAnswers,
      preservedAnswer:
        changes.preservedAnswer === undefined ? state.preservedAnswer : changes.preservedAnswer,
    };
    publish(next);
    return next;
  };

  /**
   * ONE commit attempt. Shared by `submit()` and `retry()` so the guards exist
   * exactly once and a retry can never take a different path.
   */
  const runCommit = async (rawDraft: string): Promise<AssessmentAnswerState> => {
    if (inFlight) {
      // A repeated tap while a commit is unresolved is refused BEFORE any await:
      // the same answer can never be committed twice.
      return state;
    }
    const answer = rawDraft.trim();
    if (answer.length === 0) return state;

    const step = deps.captureStep();
    if (!step) {
      return patch({
        phase: 'failed',
        learnerMessage:
          'The assessment is not running, so that answer was not sent. Nothing was recorded.',
        technicalDetail: null,
        failure: null,
        retryAvailable: true,
        preservedAnswer: answer,
      });
    }

    // A preserved answer from an EARLIER step is never recorded against a later
    // one: the state machine refuses stale tokens, and so does this controller.
    if (submittedStep && submittedStep.stepId !== step.stepId) {
      return patch({
        phase: 'failed',
        learnerMessage: ASSESSMENT_ANSWER_STEP_CHANGED_MESSAGE,
        technicalDetail: null,
        failure: null,
        retryAvailable: false,
        preservedAnswer: answer,
      });
    }

    inFlight = true;
    submittedStep = step;
    committedBaseline = preservedBaseline ?? deps.observeCommittedLearnerTurns();
    const purpose = deps.currentPurpose();
    patch({ phase: 'submitting', isSubmitting: true, learnerMessage: null, failure: null });

    let result: AssessmentAnswerCommitResult;
    try {
      result = await deps.commit({ answer, purpose, step });
    } catch (err: unknown) {
      result = {
        ok: false,
        errorMessage: err instanceof Error ? err.message : 'That answer could not be sent.',
      };
    } finally {
      inFlight = false;
    }

    const committedNow = deps.observeCommittedLearnerTurns();
    const committed = result.ok || committedNow > committedBaseline;

    if (committed) {
      // SUCCESS (or a commit that really landed despite a reported failure):
      // only now is the learner's text cleared, and only now is it counted.
      deps.onCommitted?.({
        answer,
        purpose,
        step,
        alreadyCommitted: !result.ok,
      });
      preservedBaseline = null;
      return patch({
        draft: '',
        phase: 'idle',
        isSubmitting: false,
        learnerMessage: null,
        technicalDetail: null,
        failure: null,
        retryAvailable: false,
        preservedAnswer: null,
        committedAnswers: state.committedAnswers + 1,
      });
    }

    // FAILURE: the exact typed answer is preserved, no evidence is recorded and
    // no committed turn is counted. The learner sees ONE safe sentence.
    const failure = classifyProviderFailure(
      {
        message: result.errorMessage ?? null,
        ...(result.errorCode ? { code: result.errorCode } : {}),
        ...(result.errorRetryable === undefined ? {} : { retryable: result.errorRetryable }),
      },
      'assessment',
    );
    deps.onFailure?.({ answer, failure });
    // Remember the commit state this preserved answer was submitted against.
    if (preservedBaseline === null) preservedBaseline = committedBaseline;
    return patch({
      // The draft is left exactly as the learner typed it (never trimmed away).
      phase: 'failed',
      isSubmitting: false,
      learnerMessage: failure.message,
      technicalDetail: failure.technical,
      failure,
      retryAvailable: true,
      preservedAnswer: answer,
    });
  };

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },

    setDraft(text) {
      const nextDraft = typeof text === 'string' ? text : '';
      // Editing before a retry is allowed: Retry always sends what the learner
      // sees, so the preserved answer and the visible draft cannot diverge.
      patch({
        draft: nextDraft,
        ...(state.phase === 'failed'
          ? { retryAvailable: nextDraft.trim().length > 0 }
          : {}),
      });
    },

    submit() {
      return runCommit(state.draft);
    },

    retry() {
      if (state.phase !== 'failed') return Promise.resolve(state);
      return runCommit(state.draft);
    },

    dismissMessage() {
      if (state.phase !== 'failed') return;
      patch({ learnerMessage: null, technicalDetail: null, failure: null });
    },

    reset(options) {
      submittedStep = null;
      committedBaseline = 0;
      preservedBaseline = null;
      publish({
        draft: options?.clearDraft === true ? '' : state.draft,
        phase: inFlight ? 'submitting' : 'idle',
        learnerMessage: null,
        technicalDetail: null,
        failure: null,
        retryAvailable: false,
        isSubmitting: inFlight,
        committedAnswers: state.committedAnswers,
        preservedAnswer: null,
      });
    },
  };
}
