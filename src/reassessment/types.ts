/**
 * src/reassessment/types.ts
 *
 * WP-4 Evidence Symmetry & Reassessment — Domain Types.
 *
 * CORE PRINCIPLES:
 * - Evidence Symmetry: successes/strengths are recorded with the same
 *   provenance discipline as weaknesses.
 * - No fake precision: no numeric scores, no 0-100 percentages, no XP or stars,
 *   no artificial confidence meters or native-likeness metrics.
 * - Level changes require explicit user acceptance (never silent overwrite).
 */

import type { CefrLevelInput, EvidenceRef, IsoDate, Uuid } from '../domain/shared/types';
import type { LearnerStrength } from '../domain/models/learner';
import type { DiagnosticConfidence } from '../onboarding/types';

/** Sources of demonstrated success evidence. */
export type SuccessEvidenceSource =
  | 'pronunciation_engine'
  | 'listening_service'
  | 'shadowing_session'
  | 'fluency_service'
  | 'vocabulary_workspace'
  | 'conversation_session'
  | 'onboarding_diagnostic'
  | 'curriculum_progression';

/** Input for recording a demonstrated strength observation. */
export interface SuccessObservationInput {
  readonly learnerId: Uuid;
  readonly type: LearnerStrength['type'];
  readonly referenceId: Uuid; // stable skill/item id (e.g., 'listening:multi_speaker', 'vocab:resilient', 'pron:θ')
  readonly source: SuccessEvidenceSource;
  readonly context?: string;
  readonly evidence: EvidenceRef;
  readonly notes?: string;
  readonly observedAt?: IsoDate;
}

/** Outcome of a strength observation recording attempt. */
export interface SuccessObservationResult {
  readonly recorded: boolean;
  readonly strength: LearnerStrength | null;
  readonly reason?: 'unsupported_event' | 'invalid_input' | 'provider_failed' | 'persisted';
}

/** Check if reassessment is available for a learner. */
export interface ReassessmentEligibility {
  readonly available: boolean;
  readonly reason: 'sufficient_evidence' | 'manual_request' | 'insufficient_evidence' | 'recent_assessment';
  readonly message: string;
  readonly newEvidenceCount?: number;
  readonly daysSinceLastEstimate?: number;
}

/** Qualitative shift status for one domain or overall. */
export type AbilityShiftStatus = 'stronger' | 'weaker' | 'mixed' | 'insufficient' | 'unchanged';

/** Qualitative change observation in one specific capability domain. */
export interface DomainAbilityChange {
  readonly domain: 'listening' | 'speaking' | 'pronunciation' | 'grammar' | 'vocabulary';
  readonly status: AbilityShiftStatus;
  readonly summary: string;
  readonly evidenceDetails?: readonly string[];
}

/** Full qualitative ability change report between assessment periods. */
export interface QualitativeChangeReport {
  readonly overallSummary: string;
  readonly domains: readonly DomainAbilityChange[];
  readonly hasSufficientEvidence: boolean;
}

/** Decision state for a reassessment estimate. */
export type ReassessmentDecision = 'accepted' | 'kept' | 'pending';

/** Durable record of a diagnostic or reassessment run. */
export interface ReassessmentRecord {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly assessmentKind: 'onboarding' | 'reassessment';
  readonly status: 'estimated' | 'insufficient';
  readonly proposedLevel: CefrLevelInput;
  readonly previousLevel: CefrLevelInput;
  readonly confidence: DiagnosticConfidence;
  readonly decision: ReassessmentDecision;
  readonly acceptedLevel?: CefrLevelInput | null;
  readonly basis: readonly string[];
  readonly qualitativeSummary: QualitativeChangeReport;
  readonly generatedAt: IsoDate;
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}
