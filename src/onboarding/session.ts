/**
 * src/onboarding/session.ts
 *
 * The diagnostic SESSION STATE MACHINE (Phase 1).
 *
 * Progression lives HERE — in a small, independently testable domain object —
 * never only inside React side effects.
 *
 * Deterministic rules:
 * - The step order is fixed: profile → speaking → listening → language_use →
 *   pronunciation → summary.
 * - `advance()` moves to the next step exactly once; an explicit state machine
 *   (not a note in the UI) owns it.
 * - A step can be SKIPPED (learner opted out) or marked UNAVAILABLE (the
 *   infrastructure for it is not available). Neither is treated as a learner
 *   failure and neither fabricates evidence.
 * - Every step has its own token. Recording with a stale token is REFUSED, so a
 *   late result from a replaced step can never mutate the current one.
 * - Only `complete()` marks the diagnostic completed, and it refuses while
 *   required steps are still open or the diagnostic was abandoned — an
 *   interrupted diagnostic can never be reported as completed.
 */

import type { IsoDate, Uuid } from '../domain/shared/types';
import type {
  DiagnosticEvidence,
  DiagnosticLanguageUseEvidence,
  DiagnosticListeningEvidence,
  DiagnosticPronunciationEvidence,
  DiagnosticSpeakingEvidence,
  DiagnosticStatus,
  DiagnosticStepId,
  DiagnosticStepSnapshot,
  DiagnosticStepStatus,
} from './types';

/** Fixed, ordered diagnostic flow. */
export const DIAGNOSTIC_STEP_ORDER: readonly DiagnosticStepId[] = [
  'profile',
  'speaking',
  'listening',
  'language_use',
  'pronunciation',
  'summary',
];

/** Steps that must be resolved (recorded or explicitly skipped) before completion. */
const REQUIRED_STEPS: readonly DiagnosticStepId[] = ['profile', 'speaking', 'summary'];

export interface DiagnosticSessionSnapshot {
  readonly learnerId: Uuid;
  readonly status: DiagnosticStatus;
  readonly startedAt: IsoDate;
  readonly currentStepId: DiagnosticStepId;
  readonly currentStepToken: number;
  readonly steps: readonly DiagnosticStepSnapshot[];
  readonly evidence: DiagnosticEvidence;
  readonly isComplete: boolean;
}

export interface DiagnosticSession {
  readonly learnerId: Uuid;
  readonly startedAt: IsoDate;
  getStatus(): DiagnosticStatus;
  getCurrentStepId(): DiagnosticStepId;
  /** Token of the CURRENT step: capture it, then pass it back when recording. */
  getCurrentStepToken(): number;
  snapshot(): DiagnosticSessionSnapshot;

  /** Records real structured evidence for the CURRENT step (token-guarded). */
  recordSpeaking(evidence: DiagnosticSpeakingEvidence, token: number): boolean;
  recordLanguageUse(evidence: DiagnosticLanguageUseEvidence, token: number): boolean;

  /** Records the learner profile step (the draft was saved through the repo). */
  markProfileStepDone(token: number): boolean;

  /** Records listening evidence produced by the EXISTING ListeningService. */
  recordListening(evidence: DiagnosticListeningEvidence, token: number): boolean;
  /** Marks listening UNAVAILABLE (infrastructure) — never a learner error. */
  markListeningUnavailable(reason: string, token: number): boolean;

  /** Records real, qualitative pronunciation observations. */
  recordPronunciation(evidence: DiagnosticPronunciationEvidence, token: number): boolean;
  markPronunciationUnavailable(reason: string, token: number): boolean;

  /** The learner finished the summary step (nothing was fabricated). */
  markSummaryDone(token: number): boolean;

  /** Skips an optional step the learner declined. */
  skipStep(stepId: DiagnosticStepId): boolean;

  /** Moves to the next step. Returns the new current step, or null at the end. */
  advance(): DiagnosticStepId | null;

  /** Terminal: an abandoned diagnostic can never complete or produce a level. */
  abandon(): void;
  /** True only when every required step is resolved AND nothing was abandoned. */
  canComplete(): boolean;
  /** Marks the diagnostic completed. Refuses (false) when not allowed. */
  complete(): boolean;
}

interface MutableStepState {
  id: DiagnosticStepId;
  status: DiagnosticStepStatus;
  token: number;
  unavailableReason?: string;
}

export function createDiagnosticSession(input: {
  readonly learnerId: Uuid;
  readonly startedAt: IsoDate;
}): DiagnosticSession {
  const steps: MutableStepState[] = DIAGNOSTIC_STEP_ORDER.map((id, index) => ({
    id,
    status: index === 0 ? 'active' : 'pending',
    token: 0,
  }));
  let status: DiagnosticStatus = 'in_progress';
  let currentIndex = 0;
  let evidence: DiagnosticEvidence = {
    speaking: null,
    listening: null,
    languageUse: null,
    pronunciation: null,
  };

  const current = (): MutableStepState => steps[currentIndex];

  const isCurrent = (stepId: DiagnosticStepId, token: number): boolean =>
    status === 'in_progress' &&
    current().id === stepId &&
    current().token === token &&
    // A step that has already been resolved accepts no further evidence, so a
    // repeated result can never be recorded twice.
    current().status === 'active';

  /** Replaces one evidence block without mutating the previous snapshot. */
  const setEvidence = (patch: Partial<DiagnosticEvidence>): void => {
    evidence = { ...evidence, ...patch };
  };

  const stepSnapshot = (step: MutableStepState): DiagnosticStepSnapshot => ({
    id: step.id,
    status: step.status,
    ...(step.unavailableReason ? { unavailableReason: step.unavailableReason } : {}),
  });

  const session: DiagnosticSession = {
    learnerId: input.learnerId,
    startedAt: input.startedAt,

    getStatus: () => status,

    getCurrentStepId: () => current().id,

    getCurrentStepToken: () => current().token,

    snapshot: () => ({
      learnerId: input.learnerId,
      status,
      startedAt: input.startedAt,
      currentStepId: current().id,
      currentStepToken: current().token,
      steps: steps.map(stepSnapshot),
      evidence,
      isComplete: status === 'completed',
    }),

    markProfileStepDone: (token) => {
      if (!isCurrent('profile', token)) return false;
      current().status = 'done';
      return true;
    },

    recordSpeaking: (speaking, token) => {
      if (!isCurrent('speaking', token)) return false;
      // A step that produced no committed learner turn is not usable evidence.
      if (speaking.committedLearnerTurns <= 0) return false;
      // The step spans several turns: recording REPLACES its evidence and keeps
      // it open until the flow advances past it.
      setEvidence({ speaking });
      return true;
    },

    recordListening: (listening, token) => {
      if (!isCurrent('listening', token)) return false;
      setEvidence({ listening });
      return true;
    },

    markListeningUnavailable: (reason, token) => {
      if (!isCurrent('listening', token)) return false;
      current().status = 'unavailable';
      current().unavailableReason = reason;
      setEvidence({ listening: null });
      return true;
    },

    recordLanguageUse: (languageUse, token) => {
      if (!isCurrent('language_use', token)) return false;
      if (languageUse.answered <= 0) return false;
      setEvidence({ languageUse });
      return true;
    },

    recordPronunciation: (pronunciation, token) => {
      if (!isCurrent('pronunciation', token)) return false;
      if (!pronunciation.observed) return false;
      setEvidence({ pronunciation });
      return true;
    },

    markPronunciationUnavailable: (reason, token) => {
      if (!isCurrent('pronunciation', token)) return false;
      current().status = 'unavailable';
      current().unavailableReason = reason;
      setEvidence({ pronunciation: null });
      return true;
    },

    markSummaryDone: (token) => {
      if (!isCurrent('summary', token)) return false;
      current().status = 'done';
      return true;
    },

    skipStep: (stepId) => {
      if (status !== 'in_progress') return false;
      const index = steps.findIndex((step) => step.id === stepId);
      if (index < 0) return false;
      const step = steps[index];
      if (step.status !== 'pending' && step.status !== 'active') return false;
      step.status = 'skipped';
      if (index === currentIndex) {
        const next = nextOpenIndex(currentIndex);
        if (next !== null) currentIndex = next;
      }
      return true;
    },

    advance: () => {
      if (status !== 'in_progress') return null;
      // The learner has finished the current step: it becomes resolved here, and
      // only here, so its evidence can no longer change afterwards.
      if (current().status === 'active') current().status = 'done';
      const index = steps.findIndex((step) => step.id === current().id);
      // Advance one step at a time; later steps are entered one by one so the
      // screen always knows which step is authoritative right now.
      if (index >= steps.length - 1) return null;
      const next = index + 1;
      currentIndex = next;
      steps[next].token += 1; // a NEW step token: stale results are refused
      if (steps[next].status === 'pending') steps[next].status = 'active';
      return steps[next].id;
    },

    abandon: () => {
      if (status === 'completed') return;
      status = 'abandoned';
    },

    canComplete: () => {
      if (status !== 'in_progress') return false;
      return REQUIRED_STEPS.every((id) => {
        const step = steps.find((entry) => entry.id === id);
        return step !== undefined && (step.status === 'done' || step.status === 'unavailable');
      });
    },

    complete: () => {
      if (!session.canComplete()) return false;
      steps[steps.length - 1].status = 'done';
      status = 'completed';
      return true;
    },
  };

  /** First still-open step after `index` (used when a step is skipped). */
  function nextOpenIndex(index: number): number | null {
    for (let i = index + 1; i < steps.length; i += 1) {
      if (steps[i].status === 'pending' || steps[i].status === 'active') return i;
    }
    return null;
  }

  return session;
}
