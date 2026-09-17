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
/** Turns that show the learner could sustain and expand a conversation. */
const SUSTAINED_TURNS = 5;
const EXPANDED_TURNS = 8;
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
 * Rules (explicit and testable):
 *   signal starts at 0.
 *   SPEAKING  sustained speech:  >= 5 turns +1, >= 8 turns +1 more
 *             no incorrect corrections: +2; no incorrect and <= 2 unnatural: +1
 *             3+ incorrect corrections: -1
 *   LANGUAGE  natural +1, unnatural 0, incorrect -1
 *   LISTENING best outcome: understood +1, mostly_understood 0,
 *             partial -1, missed/misunderstood -1
 *   signal <= 0 → A2, 1–2 → B1, 3–4 → B2, >= 5 → C1
 *
 * A1/C2 are deliberately never produced: a short diagnostic only supports a
 * conservative mid-range working estimate.
 *
 * Sufficiency (anything less → 'insufficient'):
 *   real conversation with >= 3 learner turns AND (real language use OR listening)
 *   OR real language use AND listening (no conversation available).
 */
export function estimateWorkingLevel(evidence: DiagnosticEvidence): DiagnosticLevelEstimate {
  const real = selectRealEvidence(evidence);
  const speaking = real.speaking;
  const languageUse = real.languageUse;
  const listening = real.listening;
  const basis: string[] = [];

  const speakingSufficient =
    speaking !== null && speaking.committedLearnerTurns >= MIN_SPEAKING_TURNS_FOR_ESTIMATE;
  const languageUseSufficient = languageUse !== null && languageUse.answered >= 1;
  const listeningSufficient = listening !== null && listening.answered >= 1;

  const sufficient =
    (speakingSufficient && (languageUseSufficient || listeningSufficient)) ||
    (!speakingSufficient && languageUseSufficient && listeningSufficient);

  if (!sufficient) {
    if (!real.hasRealDimension) {
      basis.push('No real assessment evidence was collected yet.');
    } else if (!speakingSufficient && speaking) {
      basis.push('The conversation was too short to judge connected speech.');
    }
    if (speaking && speaking.committedLearnerTurns >= MIN_SPEAKING_TURNS_FOR_ESTIMATE) {
      basis.push('Only one part of the diagnostic was completed.');
    }
    return { status: 'insufficient', level: 'unknown', confidence: 'limited', basis };
  }

  let signal = 0;

  if (speaking) {
    if (speaking.committedLearnerTurns >= EXPANDED_TURNS) {
      signal += 2;
      basis.push('You sustained a long conversation with connected answers.');
    } else if (speaking.committedLearnerTurns >= SUSTAINED_TURNS) {
      signal += 1;
      basis.push('You kept the conversation going and expanded your answers.');
    }

    const incorrect = Math.min(speaking.incorrectCorrections, MAX_COUNTED_CORRECTIONS);
    const unnatural = Math.min(speaking.unnaturalCorrections, MAX_COUNTED_CORRECTIONS);
    if (incorrect === 0 && unnatural === 0) {
      signal += 2;
      basis.push('The engine reported no corrections in this conversation.');
    } else if (incorrect === 0 && unnatural <= 2) {
      signal += 1;
      basis.push('Only a little unnatural phrasing was corrected in this conversation.');
    }
    if (speaking.incorrectCorrections >= MAX_COUNTED_CORRECTIONS) {
      signal -= 1;
      basis.push('Several sentences needed a grammatical correction.');
    }
  }

  if (languageUse) {
    if (languageUse.natural > 0 && languageUse.incorrect === 0) {
      signal += 1;
      basis.push('You rephrased an idea naturally in your own words.');
    } else if (languageUse.incorrect > 0) {
      signal -= 1;
      basis.push('The rephrasing task needed a grammatical correction.');
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

/** Deterministic signal → level mapping (never A1/C2 — see the module note). */
function levelFromSignal(signal: number): CefrLevel {
  if (signal <= 0) return 'A2';
  if (signal <= 2) return 'B1';
  if (signal <= 4) return 'B2';
  return 'C1';
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

  if (turns >= SUSTAINED_TURNS && hasLanguageUse && hasListening) return 'strong';
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
  const languageUse =
    evidence.languageUse && evidence.languageUse.provenance === 'real' ? evidence.languageUse : null;
  const listening = evidence.listening;

  if (speaking && speaking.committedLearnerTurns >= SUSTAINED_TURNS) {
    lines.push('You kept a full conversation going without switching to your own language.');
  }
  if (speaking && speaking.incorrectCorrections === 0 && speaking.committedLearnerTurns > 0) {
    lines.push('Your sentences were grammatically clear throughout the conversation.');
  }
  if (speaking && speaking.unnaturalCorrections === 0 && speaking.committedLearnerTurns > 0) {
    lines.push('Your phrasing sounded natural for the situations you described.');
  }
  if (languageUse && languageUse.natural > 0 && languageUse.incorrect === 0) {
    lines.push('You found a natural way to say the same idea in your own words.');
  }
  if (listening && listening.understood > 0) {
    lines.push('You caught the main meaning of spoken English at natural speed.');
  } else if (listening && listening.mostlyUnderstood > 0) {
    lines.push('You followed most of the listening task.');
  }
  return lines;
}
