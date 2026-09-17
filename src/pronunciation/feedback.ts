/**
 * src/pronunciation/feedback.ts
 *
 * Builds compact, qualitative user-facing feedback from a pronunciation
 * analysis, respecting the existing coaching modes:
 *   natural   — minimal interruption (only real intelligibility concerns)
 *   coach     — meaningful feedback when evidence supports it
 *   intensive — more detail, including practice hints
 *
 * Every line is either OBSERVED EVIDENCE (what the transcript showed) or
 * clearly phrased INFERENCE/ADVICE ("Try ..."). No numeric scores ever.
 */

import type {
  PronunciationAnalysis,
  PronunciationCoachingMode,
  PronunciationTurnOutcome,
} from './types';

/** Maximum feedback lines per mode. */
const MODE_LIMITS: Readonly<Record<PronunciationCoachingMode, number>> = {
  natural: 1,
  coach: 2,
  intensive: 4,
};

/**
 * Build feedback lines for a turn. Returns [] when the mode and evidence
 * level justify staying quiet (e.g. natural mode with no real concern).
 */
export function buildPronunciationFeedback(
  analysis: PronunciationAnalysis,
  mode: PronunciationCoachingMode,
): readonly string[] {
  // Analysis unavailable: pronunciation is secondary to the conversation,
  // so mention it only in intensive mode.
  if (analysis.insufficientEvidence) {
    if (mode === 'natural') return [];
    const base = 'Not enough evidence to judge pronunciation from this turn.';
    return mode === 'intensive' && analysis.notes ? [base, analysis.notes] : [base];
  }

  const meaningful = analysis.observations.filter((o) => !o.inferenceOnly);

  // Evidence-based but nothing concerning.
  if (meaningful.length === 0 || analysis.overallIntelligibility === 'clear') {
    if (mode === 'natural') return [];
    return ['Speech was clear enough; no specific issue detected.'];
  }

  const lines: string[] = [];
  const limit = MODE_LIMITS[mode];

  // Intelligibility concerns first — they matter most.
  const ordered = [
    ...meaningful.filter((o) => o.type === 'intelligibility'),
    ...meaningful.filter((o) => o.type !== 'intelligibility'),
  ];

  for (const observation of ordered) {
    if (lines.length >= limit) break;
    // OBSERVED EVIDENCE phrasing (factual, from the transcript).
    lines.push(observation.description);
  }

  // INFERENCE / ADVICE phrasing, clearly marked as suggestions.
  if (mode === 'intensive') {
    for (const observation of ordered) {
      if (lines.length >= limit) break;
      if (observation.coachingHint) {
        lines.push(`Suggestion: ${observation.coachingHint}`);
      }
    }
  } else if (mode === 'coach' && lines.length < limit) {
    const withHint = ordered.find((o) => o.coachingHint);
    if (withHint?.coachingHint) {
      lines.push(`Try: ${withHint.coachingHint}`);
    }
  }

  return lines.slice(0, limit);
}

/** Convenience: full turn outcome from an analysis (or failure). */
export function pronunciationOutcomeFromAnalysis(
  analysis: PronunciationAnalysis,
  mode: PronunciationCoachingMode,
): PronunciationTurnOutcome {
  return {
    analysis,
    feedbackLines: buildPronunciationFeedback(analysis, mode),
    unavailable: false,
  };
}
