/**
 * src/pronunciation/types.ts
 *
 * Provider-neutral, qualitative pronunciation-observation types (Phase 1).
 *
 * CORE PRINCIPLES
 * - No numeric pronunciation scores, ever. Confidence is qualitative only.
 * - Every observation carries its EVIDENCE SOURCE, clearly separating
 *   observed evidence from inference/coaching advice.
 * - Phase 1 performs NO acoustic analysis. The baseline provider derives
 *   observations from transcript comparison only and says so explicitly.
 */

/** Where a pronunciation observation's evidence came from. */
export type PronunciationEvidenceSource =
  | 'acoustic'
  | 'transcript_comparison'
  | 'stt_substitution'
  | 'learner_self_report'
  | 'practice_result'
  | 'ai_explanation_only';

/** One persisted piece of pronunciation evidence (what/when/source — no scores). */
export interface PronunciationEvidenceEntry {
  /** When this evidence was observed. */
  readonly at: string;
  /** Where the evidence came from (e.g. transcript_comparison). */
  readonly source: PronunciationEvidenceSource;
  /** Qualitative confidence only (low | medium | high). */
  readonly confidence?: QualitativeConfidence;
  /** Observed transcript snippet for this occurrence, when available. */
  readonly observed?: string;
}

/** Qualitative pronunciation issue categories (no phoneme scores). */
export type PronunciationObservationType =
  | 'word_pronunciation'
  | 'word_stress'
  | 'sentence_stress'
  | 'vowel'
  | 'consonant'
  | 'ending'
  | 'linking'
  | 'rhythm'
  | 'intonation'
  | 'intelligibility'
  | 'other';

/** Qualitative confidence only — never numeric. */
export type QualitativeConfidence = 'low' | 'medium' | 'high';

/** Overall intelligibility judgement (qualitative). */
export type PronunciationIntelligibility = 'unclear' | 'partially_clear' | 'clear';

/** One qualitative pronunciation observation. */
export interface PronunciationObservation {
  readonly type: PronunciationObservationType;
  /** The word/phrase the issue relates to, when known. */
  readonly target?: string;
  /** What was actually heard/produced, when known. */
  readonly observed?: string;
  /** Factual description of the OBSERVED evidence. */
  readonly description: string;
  /** The evidence source for this observation. */
  readonly evidence: PronunciationEvidenceSource;
  /** Qualitative confidence only. */
  readonly confidence?: QualitativeConfidence;
  /** Coaching advice — INFERENCE, never persisted as evidence. */
  readonly coachingHint?: string;
  /**
   * True when this entry is inference/explanation only (e.g. AI guidance)
   * and must NOT be persisted as pronunciation evidence.
   */
  readonly inferenceOnly?: boolean;
  /** Set when the target matches a saved vocabulary/expression item. */
  readonly lexicalItemId?: string;
}

/** Provider-neutral analysis result. */
export interface PronunciationAnalysis {
  readonly provider: string;
  /** Overall evidence level of this analysis. */
  readonly evidenceLevel: PronunciationEvidenceSource;
  readonly observations: readonly PronunciationObservation[];
  readonly overallIntelligibility?: PronunciationIntelligibility;
  /**
   * True when the provider could not judge pronunciation from the given
   * evidence. No observations may be fabricated in that case.
   */
  readonly insufficientEvidence?: boolean;
  /** Honest provider notes (e.g. why evidence was insufficient). */
  readonly notes?: string;
}

/** Input to a pronunciation provider. */
export interface PronunciationAnalysisInput {
  readonly learnerId: string;
  readonly audioUri?: string;
  readonly transcript: string;
  /** Known target text (e.g. repeat-after-me practice), when available. */
  readonly expectedText?: string;
  readonly context?: string;
}

/** Provider-neutral pronunciation analysis contract. */
export interface PronunciationProvider {
  readonly id: string;
  analyze(input: PronunciationAnalysisInput): Promise<PronunciationAnalysis>;
}

/** Conversation coaching modes (existing names — unchanged). */
export type PronunciationCoachingMode = 'natural' | 'coach' | 'intensive';

/** Outcome of one engine pass over a spoken turn. */
export interface PronunciationTurnOutcome {
  readonly analysis: PronunciationAnalysis;
  /** Compact user-facing feedback lines (possibly empty). */
  readonly feedbackLines: readonly string[];
  /** True when analysis itself failed (non-destructive; conversation continues). */
  readonly unavailable: boolean;
}
