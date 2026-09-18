/**
 * src/listening/types.ts
 *
 * Provider-neutral, QUALITATIVE listening-comprehension types (Phase 1).
 *
 * CORE PRINCIPLES
 * - No percentage comprehension scores, band scores, CEFR listening scores,
 *   numeric fluency ratings, XP, streaks or leaderboards — ever.
 * - Results are qualitative categories only; understanding is never fabricated.
 * - Phase 1 performs NO acoustic analysis: audio comes from the EXISTING
 *   TextToSpeechProvider speaking a known text; evaluation compares the
 *   learner's answer with that known text.
 */

/** The small Phase-1 set of listening exercise types. */
export type ListeningExerciseType =
  | 'listen_and_type'
  | 'listen_and_answer'
  | 'listen_and_choose'
  | 'missing_word'
  | 'expression_in_context';

/** Simple qualitative difficulty (no numeric difficulty scores). */
export type ListeningDifficulty = 'easy' | 'medium' | 'hard';

/** Qualitative comprehension result categories (no numbers). */
export type ListeningResultCategory =
  | 'understood'
  | 'mostly_understood'
  | 'partial'
  | 'missed_key_meaning'
  | 'misunderstood'
  | 'insufficient_evidence';

/** Where an exercise's material came from (honest provenance). */
export type ListeningExerciseSource =
  | 'listening_weakness'
  | 'due_vocabulary'
  | 'due_expression'
  | 'general';

/** One listening exercise. `speakText` is spoken via the EXISTING TTS and is
 *  NOT rendered as text before the first answer; it is revealed after
 *  evaluation as `revealedTranscript`. */
export interface ListeningExercise {
  readonly id: string;
  readonly learnerId: string;
  readonly type: ListeningExerciseType;
  readonly difficulty: ListeningDifficulty;
  /** The text the EXISTING TTS provider speaks for this exercise. */
  readonly speakText: string;
  /** Optional comprehension question (listen_and_answer), spoken after the statement. */
  readonly question?: string;
  /** Shown sentence with a ___ gap (missing_word only). */
  readonly gappedText?: string;
  /** Options for listen_and_choose / expression_in_context (when applicable). */
  readonly options?: readonly string[];
  /** The expected answer (normalized comparison for deterministic types). */
  readonly expectedAnswer: string;
  /** Additional accepted answers (deterministic alternatives). */
  readonly acceptableAnswers?: readonly string[];
  /** Words/phrases whose recognition this exercise checks. */
  readonly keyItems: readonly string[];
  /** Key meaning for expression_in_context feedback. */
  readonly keyMeaning?: string;
  /** Honest provenance — 'general' content is clearly generic, never personalized. */
  readonly source: ListeningExerciseSource;
  /** Linked EXISTING vocabulary/expression id, when the material is lexical. */
  readonly lexicalItemId?: string;
  /** 'vocabulary' or 'expression' when lexicalItemId is set. */
  readonly lexicalItemKind?: 'vocabulary' | 'expression';
  readonly contextTopic?: string;
  /** The listening-weakness reference id this exercise retrains, when any. */
  readonly weaknessReferenceId?: string;
  /** Short learning tip shown with feedback. */
  readonly explanation?: string;
  /**
   * Honest content provenance of THIS exercise's material: whether real
   * learner evidence materially shaped it. `source` above describes WHERE the
   * material came from; this describes how personalized it really is.
   */
  readonly contentProvenance?: 'personalized' | 'mixed' | 'general';
  /**
   * How the material was produced. 'deterministic' means the existing local
   * builders; 'ai' means validated generated material.
   */
  readonly materialOrigin?: 'deterministic' | 'ai';
  /**
   * The deterministic ContentRequest key the material was generated for.
   * Present only on generated material; it exists so later work can re-serve
   * or cache material without changing this contract.
   */
  readonly requestKey?: string;
}

/** Qualitative evaluation of one answer (no numeric scores anywhere). */
export interface ListeningEvaluation {
  readonly result: ListeningResultCategory;
  /** Compact feedback: what was caught, what was missed, the original text, a tip. */
  readonly feedbackLines: readonly string[];
  /** Key items the answer missed (bounded). */
  readonly missedItems: readonly string[];
  /** The transcript/text, revealed AFTER evaluation. */
  readonly revealedTranscript: string;
  /** How this answer was evaluated — honest provenance of the judgment. */
  readonly evaluatedBy: 'local' | 'ai' | 'unavailable';
}

/** Summary returned when a practice session finishes. */
export interface ListeningSessionSummary {
  readonly exercisesCompleted: number;
  readonly problemResults: number;
  readonly understoodResults: number;
}
