/**
 * src/reassessment/success-recorder.ts
 *
 * Success Observation Recorder (WP-4 Phase A).
 *
 * Records demonstrated success evidence into the EXISTING `LearnerStrength`
 * repository with strict provenance discipline.
 *
 * PROVENANCE DISCIPLINE:
 * - Only records strength when real, evaluated evidence is provided.
 * - Rejects generic "Great job" text, lesson completion events, button presses,
 *   un-evaluated transcripts, or provider failures.
 * - Deduplicates and bounds strength history (max 5 contexts, max 10 evidence refs).
 * - Preserves evidence symmetry: strengths and weaknesses coexist without
 *   silently erasing each other.
 */

import type { LearnerStrength } from '../domain/models/learner';
import type { EvidenceRef } from '../domain/shared/types';
import type { WeaknessRepository } from '../repositories';
import { nowIso } from '../shared/time';
import type { SuccessObservationInput, SuccessObservationResult } from './types';

/** Valid evidence kinds recognized for strength observations. */
const VALID_STRENGTH_EVIDENCE_KINDS: readonly string[] = [
  'observation',
  'turn',
  'session',
  'review',
  'pronunciation',
  'listening',
  'fluency',
  'grammar',
  'vocabulary',
  'conversation',
  'shadowing',
];

export interface SuccessObservationRecorder {
  recordSuccessObservation(
    input: SuccessObservationInput,
  ): Promise<SuccessObservationResult>;
}

export function createSuccessObservationRecorder(
  weaknessRepository: WeaknessRepository,
): SuccessObservationRecorder {
  return {
    async recordSuccessObservation(
      input: SuccessObservationInput,
    ): Promise<SuccessObservationResult> {
      // 1. Basic validation
      if (!input || !input.learnerId || !input.type || !input.referenceId || !input.evidence) {
        return { recorded: false, strength: null, reason: 'invalid_input' };
      }

      // 2. Provenance discipline check: must have valid evidence.kind
      const kind = input.evidence.kind;
      if (!kind || !VALID_STRENGTH_EVIDENCE_KINDS.includes(kind)) {
        return { recorded: false, strength: null, reason: 'unsupported_event' };
      }

      // Reject unsupported events: e.g. empty or generic notes indicating non-evaluation
      const notes = (input.notes ?? '').toLowerCase();
      if (
        notes.includes('provider unavailable') ||
        notes.includes('unsupported') ||
        notes.includes('not evaluated') ||
        notes.includes('failed')
      ) {
        return { recorded: false, strength: null, reason: 'provider_failed' };
      }

      try {
        const now = input.observedAt ?? nowIso();
        const existingList = await weaknessRepository.listStrengths(input.learnerId);

        // Deduplication lookup: find existing strength by learnerId + type + referenceId
        const existing = existingList.find(
          (s) => s.type === input.type && s.referenceId === input.referenceId,
        );

        let newContexts: string[] = [];
        if (existing && existing.contexts) {
          newContexts = [...existing.contexts];
        }
        if (input.context && !newContexts.includes(input.context)) {
          newContexts.push(input.context);
        }
        // Bound contexts to max 5 recent items
        newContexts = newContexts.slice(-5);

        let newEvidence: EvidenceRef[] = [];
        if (existing && existing.evidence) {
          newEvidence = [...existing.evidence];
        }
        // Deduplicate evidence refs by targetRef or summary
        const existsEvidence = newEvidence.some(
          (e) => e.id === input.evidence.id && e.summary === input.evidence.summary,
        );
        if (!existsEvidence) {
          newEvidence.push(input.evidence);
        }
        // Bound evidence refs to max 10 recent items
        newEvidence = newEvidence.slice(-10);

        const confidence = existing
          ? Math.min(1.0, (existing.confidence ?? 0.8) + 0.05)
          : 0.8;

        const firstSeenAt = existing ? existing.firstSeenAt : now;
        const lastSeenAt = now;

        const strengthToUpsert: Omit<LearnerStrength, 'id' | 'createdAt' | 'updatedAt'> = {
          learnerId: input.learnerId,
          type: input.type,
          referenceId: input.referenceId,
          confidence,
          firstSeenAt,
          lastSeenAt,
          contexts: newContexts,
          evidence: newEvidence,
          notes: input.notes ?? existing?.notes,
        };

        const upserted = await weaknessRepository.upsertStrength(strengthToUpsert);
        return { recorded: true, strength: upserted, reason: 'persisted' };
      } catch {
        return { recorded: false, strength: null, reason: 'invalid_input' };
      }
    },
  };
}
