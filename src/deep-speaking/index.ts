/**
 * src/deep-speaking/index.ts
 *
 * Public surface of the Deep Speaking Practice / Speaking Coach (Phase 1).
 *
 * Screens never touch SQLite: they receive an injected service or await
 * createDefaultSpeakingService(), which composes the EXISTING systems on the
 * SAME canonical app database.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import type { LearnerModel } from '../learner-model';
import type { AIProvider } from '../providers/ai/types';
import { resolveTalkCoaching } from '../talk-demo';
import {
  SpeakingPracticeService,
  createSpeakingPracticeService,
} from './service';

export * from './types';
export * from './planner';
export * from './prompts';
export * from './service';

/**
 * Compose a SpeakingPracticeService on a given adapter + learner model.
 * Same canonical database as Talk / Adaptive Lessons / Listening.
 */
export function createSpeakingService(
  learnerModel: LearnerModel,
  adapter?: DatabaseAdapter,
  options?: {
    readonly aiProvider?: AIProvider;
    readonly disableAI?: boolean;
  },
): SpeakingPracticeService {
  return createSpeakingPracticeService(learnerModel, adapter, options);
}

// Default composition bootstrap — adapter lifecycle lives behind composition,
// never inside UI screens (SAME pattern as Talk / Adaptive Lessons / etc.).
let defaultServicePromise: Promise<SpeakingPracticeService> | null = null;

/** Compose the service on the default app database (reused across calls). */
export function createDefaultSpeakingService(): Promise<SpeakingPracticeService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const resolution = await resolveTalkCoaching();
      if (!resolution.learnerModel) {
        throw new Error(
          'Persisted learner data could not be composed from the local database.',
        );
      }
      return createSpeakingPracticeService(
        resolution.learnerModel,
        resolution.databaseAdapter,
      );
    })().catch((error: unknown) => {
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
