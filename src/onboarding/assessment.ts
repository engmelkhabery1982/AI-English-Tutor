/**
 * src/onboarding/assessment.ts
 *
 * The SMALLEST deterministic assessment aggregator required (Phase 1).
 *
 * It consumes STRUCTURED outcomes produced by the EXISTING engines
 * (ConversationEngine feedback severities, ListeningService result categories,
 * the language-use task's existing correction semantics, real pronunciation
 * observations). It NEVER asks the AI for a CEFR level and never invents
 * evidence: when coverage is too thin it returns `insufficient` and the learner
 * keeps their existing level.
 *
 * Purity: `estimateWorkingLevel(evidence)` depends only on its argument, so the
 * same evidence always produces the same estimate (no clock, no randomness, no
 * network, no AI self-report).
 */

import type { CefrLevel } from '../domain/shared/types';
import type {
  DiagnosticConfidence,
  DiagnosticEvidence,
  DiagnosticLevelEstimate,
  DiagnosticLanguageUseEvidence,
  DiagnosticListeningEvidence,
  DiagnosticSpeakingEvidence,
} from './types';

/** Minimum committed learner turns before connected speech can be judged at all. */
export const MIN_SPEAKING_TURNS_FOR_ESTIMATE = 3;
/** Turns that show the learner held a real conversation (each one substantive). */
const CONNECTED_TURNS = 3;
/** Turns that show sustained, expanding answers. */
const SUSTAINED_TURNS = 6;
/** Coverage thresholds for confidence (coverage only — never AI self-confidence). */
const STRONG_COVERAGE_TURNS = 5;
/** Repeated explicit problems become negative evidence (bounded). */
const REPEATED_UNNATURAL = 2;
const REPEATED_INCORRECT = 3;
/** Bounded corrections counted per conversation (evidence stays representative). */
const MAX_COUNTED_CORRECTIONS = 3;

interface RealEvidence {
  readonly speaking: DiagnosticSpeakingEvidence | null;
  readonly listening: DiagnosticListeningEvidence | null;
  readonly languageUse: DiagnosticLanguageUseEvidence | null;
  /** True when at least one real (non-demo) assessment dimension exists. */
  readonly hasRealDimension: boolean;
}

/**
 * Demo/offline conversation evidence NEVER feeds the estimate (offline demo is
 * practice, not assessment), and an unavailable listening evaluation is not
 * evidence at all.
 */
function selectRealEvidence(evidence: DiagnosticEvidence): RealEvidence {
  const speaking =
    evidence.speaking && evidence.speaking.provenance === 'real' ? evidence.speaking : null;
  const languageUse =
    evidence.languageUse && evidence.languageUse.provenance === 'real'
      ? evidence.languageUse
      : null;
  const listening =
    evidence.listening && evidence.listening.evaluatedBy !== 'unavailable' && evidence.listening.answered > 0
      ? evidence.listening
      : null;
  return {
    speaking,
    listening,
    languageUse,
    hasRealDimension: Boolean(speaking || listening || languageUse),
  };
}

/**
 * Deterministic level estimate.
 *
 * CONSERVATIVE EVIDENCE RULE (why absence of correction is not a positive):
 * the normal ConversationEngine deliberately does NOT correct every sentence.
 * "No correction emitted" therefore only means "nothing was reported" — it is
 * NOT proof of correct grammar or natural phrasing, so it awards NOTHING here.
 * Only what the engine actually reported is used, and it is used only as
 * NEGATIVE evidence (a real, observed problem).
 *
 * Rules (explicit and testable). `signal` starts at 0:
 *   SPEAKING
 *     >= 6 substantive committed turns .......... +2  (sustained, expanding)
 *     >= 3 substantive committed turns .......... +1  (held a real conversation)
 *     >= 3 'incorrect' corrections .............. -2
 *     >= 1 'incorrect' correction ............... -1
 *     >= 2 'unnatural' corrections .............. -1
 *     no corrections at all .....................  0  (neutral — never positive)
 *   LANGUAGE USE (the dedicated rephrasing task)
 *     any reported problem (incorrect/unnatural) . -1
 *     no reported problem .......................  0  (neutral)
 *   LISTENING (one real task, existing evaluator)
 *     understood ................................ +1
 *     partial / missed key meaning .............. -1
 *
 * Mapping: signal <= 0 → A2, 1–2 → B1, >= 3 → B2.
 * A short Phase-1 diagnostic NEVER claims C1/C2 (its evidence cannot support
 * them) and never claims A1, so the ceiling is deliberately B2.
 *
 * Sufficiency (anything less → 'insufficient'): REAL SPEAKING IS REQUIRED.
 *   - a real conversation with >= 3 substantive learner turns, AND
 *   - at least one other real dimension (the language-use task or the listening
 *     task).
 * A short speaking sample plus one language-use item and one listening item is
 * NOT enough for a working level: listening and language use COMPLEMENT real
 * speaking, they never replace it. Demo or too-short speaking → insufficient
 * (the learner keeps their existing/self-reported level).
 */
export function estimateWorkingLevel(evidence: DiagnosticEvidence): DiagnosticLevelEstimate {
  const real = selectRealEvidence(evidence);
  const speaking = real.speaking;
  const languageUse = real.languageUse;
  const listening = real.listening;
  const basis: string[] = [];

  const speakingSufficient =
    speaking !== null && speaking.committedLearnerTurns >= MIN_SPEAKING_TURNS_FOR_ESTIMATE;
  const hasOtherRealDimension =
    (languageUse !== null && languageUse.answered >= 1) ||
    (listening !== null && listening.answered >= 1);

  // Real speaking evidence is REQUIRED: the other parts complement it.
  const sufficient = speakingSufficient && hasOtherRealDimension;

  if (!sufficient) {
    if (!real.hasRealDimension) {
      basis.push('No real assessment evidence was collected yet.');
    } else if (!speaking) {
      basis.push('No real speaking evidence was collected in this session.');
    } else if (!speakingSufficient) {
      basis.push('The speaking sample was too short to judge connected speech.');
    } else {
      basis.push('Only the conversation was completed, so the level stays provisional.');
    }
    return { status: 'insufficient', level: 'unknown', confidence: 'limited', basis };
  }

  let signal = 0;

  if (speaking) {
    if (speaking.committedLearnerTurns >= SUSTAINED_TURNS) {
      signal += 2;
      basis.push('You sustained a long conversation and expanded your answers.');
    } else if (speaking.committedLearnerTurns >= CONNECTED_TURNS) {
      signal += 1;
      basis.push('You held a real conversation and kept your answers going.');
    }

    const incorrect = Math.min(speaking.incorrectCorrections, MAX_COUNTED_CORRECTIONS);
    const unnatural = Math.min(speaking.unnaturalCorrections, MAX_COUNTED_CORRECTIONS);
    if (incorrect >= REPEATED_INCORRECT) {
      signal -= 2;
      basis.push('Several sentences needed a grammatical correction.');
    } else if (incorrect >= 1) {
      signal -= 1;
      basis.push('A sentence needed a grammatical correction.');
    }
    if (unnatural >= REPEATED_UNNATURAL) {
      signal -= 1;
      basis.push('Repeated phrasing was corrected as unnatural.');
    }
  }

  if (languageUse) {
    // Only a REPORTED problem counts: a silent turn is not proof of quality.
    if (languageUse.incorrect + languageUse.unnatural > 0) {
      signal -= 1;
      basis.push('The rephrasing task needed a phrasing or grammar correction.');
    }
  }

  if (listening) {
    if (listening.understood > 0) {
      signal += 1;
      basis.push('You caught the main meaning in the listening task.');
    } else if (listening.partial > 0 || listening.missedKeyMeaning > 0) {
      signal -= 1;
      basis.push('The listening task was only partly understood.');
    }
  }

  return {
    status: 'estimated',
    level: levelFromSignal(signal),
    confidence: confidenceFromCoverage(real),
    basis,
  };
}

/**
 * Deterministic signal → level mapping. The Phase-1 diagnostic is short, so its
 * ceiling is B2: A1 and C1/C2 are never claimed from this evidence at all.
 */
function levelFromSignal(signal: number): CefrLevel {
  if (signal <= 0) return 'A2';
  if (signal <= 2) return 'B1';
  return 'B2';
}

/**
 * Coverage-based confidence. Purely a function of how many real dimensions were
 * observed and how much connected speech existed.
 */
function confidenceFromCoverage(evidence: RealEvidence): DiagnosticConfidence {
  const speaking = evidence.speaking;
  const turns = speaking?.committedLearnerTurns ?? 0;
  const hasLanguageUse = Boolean(evidence.languageUse);
  const hasListening = Boolean(evidence.listening);

  if (turns >= STRONG_COVERAGE_TURNS && hasLanguageUse && hasListening) return 'strong';
  if (turns >= MIN_SPEAKING_TURNS_FOR_ESTIMATE && (hasLanguageUse || hasListening)) {
    return 'moderate';
  }
  return 'limited';
}

/** Learner-facing sentence for the estimate (never a score, never official). */
export function describeEstimate(estimate: DiagnosticLevelEstimate): string {
  if (estimate.status !== 'estimated') {
    return 'Not enough evidence yet. Keep using Talk and your lessons, and your level will become clearer.';
  }
  return `Your working level looks around ${estimate.level} based on today's diagnostic practice.`;
}

/** Learner-facing sentence for the confidence (derived from coverage only). */
export function describeConfidence(confidence: DiagnosticConfidence): string {
  switch (confidence) {
    case 'strong':
      return 'Confidence: strong evidence';
    case 'moderate':
      return 'Confidence: moderate evidence';
    case 'limited':
    default:
      return 'Confidence: limited evidence';
  }
}

/** Focus areas derived ONLY from real recorded corrections (bounded, no invention). */
export function focusAreasFromEvidence(evidence: DiagnosticEvidence): readonly string[] {
  const notes: string[] = [];
  const speaking = evidence.speaking && evidence.speaking.provenance === 'real' ? evidence.speaking : null;
  const languageUse =
    evidence.languageUse && evidence.languageUse.provenance === 'real' ? evidence.languageUse : null;

  for (const note of speaking?.correctionNotes ?? []) {
    if (note && !notes.includes(note)) notes.push(note);
  }
  for (const note of languageUse?.notes ?? []) {
    if (note && !notes.includes(note)) notes.push(note);
  }
  return notes.slice(0, 4);
}

/** Positive observations derived from successful REAL evidence (never persisted). */
export function strengthsFromEvidence(evidence: DiagnosticEvidence): readonly string[] {
  const lines: string[] = [];
  const speaking = evidence.speaking && evidence.speaking.provenance === 'real' ? evidence.speaking : null;
  const listening = evidence.listening;

  // Only REAL positives: connected speaking that was actually observed and real
  // task outcomes. The absence of a correction is never reported as a strength.
  if (speaking && speaking.committedLearnerTurns >= SUSTAINED_TURNS) {
    lines.push('You kept a long conversation going and expanded on your answers.');
  } else if (speaking && speaking.committedLearnerTurns >= CONNECTED_TURNS) {
    lines.push('You held a real conversation in English from start to finish.');
  }
  if (listening && listening.understood > 0) {
    lines.push('You caught the main meaning of spoken English at natural speed.');
  } else if (listening && listening.mostlyUnderstood > 0) {
    lines.push('You followed most of the listening task.');
  }
  return lines;
}
