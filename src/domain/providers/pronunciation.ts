/**
 * src/domain/providers/pronunciation.ts
 *
 * PronunciationProvider interface.
 *
 * Vendor-agnostic contract for analyzing spoken pronunciation.
 *
 * IMPORTANT: This interface is intentionally narrow. Real
 * pronunciation analysis requires acoustic/phonetic signal
 * processing that is NOT yet implemented. The provider interface
 * exists so a concrete implementation can be dropped in later
 * without touching the learning app.
 *
 * No fake scores are produced by this interface. A concrete
 * provider returns analysis only when it is technically supportable.
 */

import type { IsoDate, Uuid } from '../shared/types';

/** Reference audio the learner produced. */
export interface PronunciationSample {
  readonly audio: ArrayBuffer | Uint8Array;
  readonly mimeType?: string;
  readonly referenceText: string; // what the learner was supposed to say
  readonly turnId?: Uuid;
  readonly learnerId?: Uuid;
  readonly language?: string;
  readonly sampleRate?: number;
}

/** A single phoneme / sound the learner attempted. */
export interface PhonemeResult {
  readonly phoneme: string; // IPA, e.g. "θ"
  readonly word: string;
  readonly expected: string;
  readonly observed?: string;
  readonly confidence: number; // 0..1
  readonly feedback?: string; // e.g. "place tongue between teeth"
  readonly isCorrect: boolean;
}

/** Acoustic metrics for a sample. */
export interface PronunciationMetrics {
  readonly overallScore?: number; // 0..1, only if supportable
  readonly accuracy?: number; // 0..1
  readonly fluency?: number; // 0..1
  readonly completeness?: number; // 0..1
  readonly naturalness?: number; // 0..1
}

/** Result of analyzing a pronunciation sample. */
export interface PronunciationAnalysis {
  readonly sampleId: Uuid;
  readonly referenceText: string;
  readonly transcribedText?: string;
  readonly metrics: PronunciationMetrics;
  readonly phonemes: readonly PhonemeResult[];
  readonly feedback?: string;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
  readonly providerId: string;
  readonly model?: string;
  readonly latencyMs?: number;
  readonly analyzedAt: IsoDate;
}

/** Request to analyze pronunciation. */
export interface PronunciationRequest {
  readonly sample: PronunciationSample;
  readonly focusPhonemes?: readonly string[]; // e.g. ["θ", "ð"]
  readonly focusWords?: readonly string[];
  readonly referenceAudio?: ArrayBuffer | Uint8Array; // native speaker reference
  readonly language?: string;
}

/**
 * PronunciationProvider
 *
 * Replaceable interface for any pronunciation analysis backend.
 * Implementations live in src/services/providers/* and must NOT
 * leak vendor SDK types into the domain layer.
 *
 * Implementations MUST return analysis only when technically
 * supportable. If a provider cannot analyze, it should reject
 * rather than fabricate a score.
 */
export interface PronunciationProvider {
  readonly providerId: string;
  readonly capabilities: readonly (
    | 'phoneme-analysis'
    | 'word-level'
    | 'sentence-level'
    | 'reference-comparison'
    | 'on-device'
  )[];

  /**
   * Analyze a pronunciation sample.
   * Rejects if the provider cannot support the request.
   */
  analyze(request: PronunciationRequest): Promise<PronunciationAnalysis>;

  /**
   * Health check.
   */
  healthcheck(): Promise<boolean>;
}

/** Factory signature for creating a pronunciation provider instance. */
export type PronunciationProviderFactory = (
  config: Record<string, unknown>,
) => PronunciationProvider;