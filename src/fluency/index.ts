/**
 * src/fluency/index.ts
 *
 * Public surface of WP-3 (Fluency / Automaticity / Interaction).
 *
 * Screens never touch SQLite and never build conversation/voice systems:
 * they receive an injected FluencyPracticeService (composed over the
 * EXISTING SpeakingPracticeService) and create the EXISTING voice
 * coordinator over the session the service exposes.
 *
 * COMPOSITION RULES FOLLOWED HERE
 * - Reuse, never rebuild: the speaking service (ConversationEngine,
 *   ConversationOrchestrator, ConversationSession), the voice stack,
 *   conversation memory and learning persistence are composed as-is behind
 *   the injected speaking service.
 * - No silent demo fallback at this layer: the underlying speaking service
 *   already resolves the provider honestly, and this layer reports isRealAI
 *   so the UI can label demo practice truthfully.
 */

import type { IsoDate } from '../domain/shared/types';
import {
  createDefaultSpeakingService,
  type SpeakingPracticeService,
} from '../deep-speaking';
import type { SuccessObservationRecorder } from '../reassessment';
import {
  FluencyPracticeService,
  createFluencyPracticeService,
} from './service';

export * from './types';
export * from './tasks';
export * from './support-policy';
export * from './evidence';
export * from './repair-policy';
export {
  FluencyPracticeService,
  createFluencyPracticeService,
  practiceTypeForFluencyTask,
} from './service';

/**
 * Compose a FluencyPracticeService on the default speaking service (which
 * itself composes the EXISTING learner model + canonical app database).
 * Reused across calls; throws honestly when no persisted learner state can
 * be composed (the caller shows that instead of fake personalization).
 */
export async function createDefaultFluencyService(): Promise<FluencyPracticeService> {
  const speaking: SpeakingPracticeService = await createDefaultSpeakingService();
  return createFluencyPracticeService(speaking);
}

/** Test/composition seam: build a fluency service over any speaking service. */
export function createFluencyServiceFor(
  speaking: SpeakingPracticeService,
  options?: {
    readonly now?: () => IsoDate;
    /**
     * The EXISTING success-observation recorder. The learner id is still
     * resolved by the owning speaking service — the caller supplies evidence
     * plumbing only, never an identity, so no learner id can be fabricated
     * here.
     */
    readonly successRecorder?: SuccessObservationRecorder;
  },
): FluencyPracticeService {
  return new FluencyPracticeService({
    speaking,
    ...(options?.now ? { now: options.now } : {}),
    ...(options?.successRecorder ? { successRecorder: options.successRecorder } : {}),
  });
}
