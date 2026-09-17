/**
 * src/onboarding/speaking.ts
 *
 * The SPEAKING step + LANGUAGE-USE step of the diagnostic.
 *
 * There is NO separate speaking evaluator here: both steps send real learner
 * turns through the EXISTING ConversationSession (the same engine, prompt
 * builder and structured feedback Talk uses) and only read what that engine
 * actually returned:
 *   - committed turns (real history),
 *   - the structured `ConversationFeedback.correction.severity` values
 *     ('incorrect' | 'unnatural' | 'minor') for the grammar/naturalness split.
 *
 * Integrity rules:
 * - A failed AI call commits nothing and produces NO evidence.
 * - Demo/offline conversations are real practice but NOT assessment evidence:
 *   they are marked `provenance: 'demo'`, never persisted as weakness evidence,
 *   and excluded from the level estimate.
 * - Only the REAL provider's feedback may be persisted, and only through the
 *   EXISTING LearningPersistenceService (single mutation owner).
 */

import type { ConversationFeedback } from '../providers/ai/types';
import type { ConversationMode } from '../domain/shared/types';
import type { ConversationSession, ConversationSessionResult } from '../conversation-session';
import type { LearningPersistenceService } from '../talk-demo/learning-persistence';
import type {
  DiagnosticLanguageUseEvidence,
  DiagnosticProvenance,
  DiagnosticSpeakingEvidence,
  LanguageUseOutcome,
  PronunciationTask,
} from './types';

/** Bounded correction notes kept per step (evidence stays compact + honest). */
const MAX_NOTES = 3;
/** Sentences shorter than this are not treated as connected speaking evidence. */
const MIN_SUBSTANTIVE_CHARS = 12;

/**
 * The bounded language-use tasks (Phase 1 uses exactly ONE per diagnostic).
 * The prompt is tutor-facing text; the LEARNER's answer goes through the normal
 * conversation path, so the existing engine produces the structured feedback.
 */
export interface LanguageUseTask {
  readonly id: string;
  readonly prompt: string;
}

export const LANGUAGE_USE_TASKS: readonly LanguageUseTask[] = [
  {
    id: 'plan-with-reason',
    prompt:
      'Tell me about a plan you have this week, and explain why it matters to you.',
  },
  {
    id: 'opinion-with-reason',
    prompt: 'Give your opinion about working from home, and say why you think so.',
  },
  {
    id: 'problem-and-solution',
    prompt: 'Describe a small problem you had recently and how you solved it.',
  },
];

/** The task the diagnostic uses (deterministic — same task for the same flow). */
export function languageUseTaskForDiagnostic(): LanguageUseTask {
  return LANGUAGE_USE_TASKS[0];
}

/**
 * The bounded Phase-1 pronunciation tasks: plain sentences that are easy to
 * repeat and that contain a few reliably observable contrasts (final consonants,
 * word stress, a contraction). The engine compares the learner's REAL transcript
 * against this known target text — no acoustic analysis is claimed.
 */
export const PRONUNCIATION_TASKS: readonly PronunciationTask[] = [
  {
    id: 'repeat-daily-routine',
    sentence: 'I usually walk to work, but yesterday I took the bus instead.',
  },
  {
    id: 'repeat-work-plan',
    sentence: 'We finished the project last week and the client was very pleased.',
  },
  {
    id: 'repeat-travel-plan',
    sentence: 'Next month I am going to visit my family and stay for three days.',
  },
];

/** The pronunciation task the diagnostic uses (deterministic). */
export function pronunciationTaskForDiagnostic(): PronunciationTask {
  return PRONUNCIATION_TASKS[0];
}

export interface DiagnosticSpeakingStep {
  readonly mode: ConversationMode;
  /** Honest capability description of the provider actually in use. */
  readonly provenance: DiagnosticProvenance;
  /** True only for the REAL AI provider (never the offline demo). */
  readonly isRealAI: boolean;

  /** Tutor opening question through the EXISTING engine (optional support). */
  openConversation(): Promise<ConversationSessionResult | null>;
  /** Sends one learner answer through the EXISTING conversation stack. */
  send(userMessage: string): Promise<ConversationSessionResult>;
  /** Sends one answer for the language-use task (same stack, separate record). */
  sendLanguageUse(userMessage: string): Promise<ConversationSessionResult>;
  /**
   * Absorbs turns that the EXISTING voice coordinator committed directly into
   * the session (mic → STT → session.send → TTS). Driven by the real committed
   * history, so calling it repeatedly never double-counts.
   */
  observeCommittedHistory(options?: {
    readonly purpose?: 'speaking' | 'language_use';
  }): void;

  /** Structured speaking evidence gathered so far (no invented values). */
  getSpeakingEvidence(): DiagnosticSpeakingEvidence;
  /** Structured language-use evidence gathered so far. */
  getLanguageUseEvidence(): DiagnosticLanguageUseEvidence;

  /** Marks the step closed: later results are ignored (not recorded). */
  abandon(): void;
  isAbandoned(): boolean;
}

/** First sentence of an explanation, trimmed and bounded (real content only). */
function noteFromFeedback(feedback: ConversationFeedback | null): string | null {
  const explanation = feedback?.correction?.explanation?.trim();
  if (!explanation) return null;
  const firstSentence = explanation.split(/(?<=[.!?])\s+/)[0]?.trim() ?? explanation;
  return firstSentence.length > 0 ? firstSentence : null;
}

/** Three-way outcome using the EXISTING severity semantics only. */
export function classifyLanguageUse(feedback: ConversationFeedback | null): LanguageUseOutcome {
  const severity = feedback?.correction?.severity;
  if (severity === 'incorrect') return 'incorrect';
  if (severity === 'unnatural') return 'unnatural';
  // 'minor' (a light polish) and no correction both count as natural enough.
  return 'natural';
}

export function createDiagnosticSpeakingStep(input: {
  readonly session: ConversationSession;
  readonly mode: ConversationMode;
  readonly isRealAI: boolean;
  /** EXISTING persistence owner for weakness/review evidence (real AI only). */
  readonly learningPersistence?: LearningPersistenceService;
}): DiagnosticSpeakingStep {
  let abandoned = false;
  /** Turns already absorbed, so voice + text paths never double-count. */
  let countedLearnerTurns = 0;
  let countedTutorTurns = 0;
  let speaking: DiagnosticSpeakingEvidence = {
    provenance: input.isRealAI ? 'real' : 'demo',
    committedLearnerTurns: 0,
    committedTutorTurns: 0,
    incorrectCorrections: 0,
    unnaturalCorrections: 0,
    naturalTurns: 0,
    correctionNotes: [],
  };
  let languageUse: DiagnosticLanguageUseEvidence = {
    provenance: input.isRealAI ? 'real' : 'demo',
    answered: 0,
    natural: 0,
    unnatural: 0,
    incorrect: 0,
    notes: [],
  };

  const pushNote = (notes: readonly string[], note: string | null): readonly string[] => {
    if (!note || notes.includes(note) || notes.length >= MAX_NOTES) return notes;
    return [...notes, note];
  };

  /**
   * Persists real feedback through the EXISTING owner. Demo feedback is never
   * persisted, so an offline diagnostic can never create real learner weakness
   * evidence.
   */
  const persistIfReal = async (feedback: ConversationFeedback | null): Promise<void> => {
    if (!input.isRealAI || !feedback || !input.learningPersistence) return;
    try {
      await input.learningPersistence.recordFeedbackEvidence(feedback);
    } catch {
      // Persistence problems are non-destructive: the visible diagnostic
      // continues and no evidence is fabricated in its place.
    }
  };

  /**
   * Absorbs every turn the session actually committed since the last call —
   * whatever path produced it (text, or the existing voice coordinator). The
   * session's current feedback belongs to the newest committed turn; older
   * uncounted turns are recorded as uncorrected rather than guessed.
   */
  const absorbCommittedHistory = async (
    purpose: 'speaking' | 'language_use' = 'speaking',
  ): Promise<void> => {
    const history = input.session.getHistory();
    const learnerTurns = history.filter((turn) => turn.role === 'user');
    const tutorTotal = history.length - learnerTurns.length;
    const newLearnerTurns = learnerTurns.slice(countedLearnerTurns);
    const newTutorTurns = Math.max(0, tutorTotal - countedTutorTurns);
    if (newLearnerTurns.length === 0 && newTutorTurns === 0) return;

    countedLearnerTurns = learnerTurns.length;
    countedTutorTurns = tutorTotal;

    const feedback: ConversationFeedback | null = input.session.getLastFeedback();
    const severity = feedback?.correction?.severity ?? null;
    const note = noteFromFeedback(feedback);

    if (purpose === 'language_use') {
      // The newest turn is the language-use answer; its structured severity is
      // the existing engine's own classification.
      const outcome = classifyLanguageUse(feedback);
      languageUse = {
        ...languageUse,
        answered: languageUse.answered + newLearnerTurns.length,
        natural: languageUse.natural + (outcome === 'natural' ? 1 : 0),
        unnatural: languageUse.unnatural + (outcome === 'unnatural' ? 1 : 0),
        incorrect: languageUse.incorrect + (outcome === 'incorrect' ? 1 : 0),
        notes: outcome === 'natural' ? languageUse.notes : pushNote(languageUse.notes, note),
      };
      await persistIfReal(feedback);
      return;
    }

    const substantive = newLearnerTurns.filter(
      (turn) => turn.content.trim().length >= MIN_SUBSTANTIVE_CHARS,
    ).length;
    speaking = {
      ...speaking,
      // Only substantive answers count as connected speaking evidence.
      committedLearnerTurns: speaking.committedLearnerTurns + substantive,
      committedTutorTurns: speaking.committedTutorTurns + newTutorTurns,
      incorrectCorrections: speaking.incorrectCorrections + (severity === 'incorrect' ? 1 : 0),
      unnaturalCorrections: speaking.unnaturalCorrections + (severity === 'unnatural' ? 1 : 0),
      naturalTurns: speaking.naturalTurns + (severity === null ? substantive : 0),
      correctionNotes: severity ? pushNote(speaking.correctionNotes, note) : speaking.correctionNotes,
    };
    await persistIfReal(feedback);
  };

  const countSpeakingTurn = async (result: ConversationSessionResult): Promise<void> => {
    if (!result.ok) return; // failed AI/STT: no evidence, nothing persisted
    await absorbCommittedHistory('speaking');
  };

  const countLanguageUseTurn = async (result: ConversationSessionResult): Promise<void> => {
    if (!result.ok) return;
    await absorbCommittedHistory('language_use');
  };

  return {
    mode: input.mode,
    provenance: input.isRealAI ? 'real' : 'demo',
    isRealAI: input.isRealAI,

    async openConversation(): Promise<ConversationSessionResult | null> {
      if (abandoned) return null;
      const open = input.session.openConversation;
      if (typeof open !== 'function') return null;
      try {
        const result = await open.call(input.session, {
          userMessage: 'Start my English assessment conversation.',
        });
        if (abandoned) return null;
        if (result.ok) {
          speaking = { ...speaking, committedTutorTurns: speaking.committedTutorTurns + 1 };
        }
        return result;
      } catch {
        // An opening problem is not learner evidence.
        return null;
      }
    },

    async send(userMessage: string): Promise<ConversationSessionResult> {
      const result = await input.session.send({ userMessage });
      // A result that arrives after the step was closed must not mutate it.
      if (abandoned) return result;
      await countSpeakingTurn(result);
      return result;
    },

    async sendLanguageUse(userMessage: string): Promise<ConversationSessionResult> {
      const result = await input.session.send({ userMessage });
      if (abandoned) return result;
      await countLanguageUseTurn(result);
      return result;
    },

    observeCommittedHistory: (options) => {
      if (abandoned) return;
      void absorbCommittedHistory(options?.purpose ?? 'speaking');
    },

    getSpeakingEvidence: () => speaking,
    getLanguageUseEvidence: () => languageUse,

    abandon: () => {
      abandoned = true;
    },
    isAbandoned: () => abandoned,
  };
}
