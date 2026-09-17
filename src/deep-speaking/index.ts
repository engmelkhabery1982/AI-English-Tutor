/**
 * src/deep-speaking/index.ts
 *
 * Public surface of the Deep Speaking Practice / Speaking Coach (Phase 1).
 *
 * Screens never touch SQLite: they receive an injected service or await
 * createDefaultSpeakingService(), which composes the EXISTING systems on the
 * SAME canonical app database (exactly like Talk / Adaptive Lessons /
 * Listening / Progress).
 *
 * COMPOSITION RULES FOLLOWED HERE
 * - Reuse, never rebuild: LearnerModel, conversation stack, voice stack,
 *   conversation memory and learning persistence are composed as-is.
 * - No silent demo fallback: the plan is built from the persisted learner model
 *   only. When no persisted learner state can be composed, the caller is told
 *   honestly instead of receiving demo data labeled as personalization.
 * - The EXISTING progress store is composed here (behind the service) so the
 *   screen never opens a database.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { SQLiteProgressRepository } from '../data/local/sqlite/repositories';
import type { LearnerModel } from '../learner-model';
import { resolveTalkCoaching } from '../talk-demo';
import {
  createSpeakingPracticeService,
  type SpeakingPracticeService,
  type SpeakingPracticeServiceOptions,
  type SpeakingProgressPort,
} from './service';

export * from './types';
export * from './planner';
export * from './prompts';
export * from './service';

/**
 * The EXISTING progress store on the composed adapter.
 * Deep Speaking only ever writes real counts (session completed + learner
 * turns) with a descriptive note — never a speaking score.
 */
function createProgressPort(adapter: DatabaseAdapter): SpeakingProgressPort {
  const progress = new SQLiteProgressRepository(adapter);
  return { record: (record) => progress.record(record) };
}

/**
 * Compose a SpeakingPracticeService on a given adapter + learner model.
 * Same canonical database as Talk / Adaptive Lessons / Listening.
 */
export function createSpeakingService(
  learnerModel: LearnerModel,
  adapter?: DatabaseAdapter,
  options?: SpeakingPracticeServiceOptions,
): SpeakingPracticeService {
  const progress =
    options?.progress ?? (adapter ? createProgressPort(adapter) : undefined);
  return createSpeakingPracticeService(learnerModel, adapter, {
    ...(options ?? {}),
    ...(progress ? { progress } : {}),
  });
}

// Default composition bootstrap — adapter lifecycle lives behind composition,
// never inside UI screens (SAME pattern as Talk / Adaptive Lessons / etc.).
let defaultServicePromise: Promise<SpeakingPracticeService> | null = null;

/** Compose the service on the default app database (reused across calls). */
export function createDefaultSpeakingService(): Promise<SpeakingPracticeService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const resolution = await resolveTalkCoaching();
      if (!resolution.learnerModel || !resolution.databaseAdapter) {
        // No persisted learner state: Deep Speaking stays unavailable rather
        // than planning from demo data and calling it personalization.
        throw new Error(
          'Persisted learner data could not be composed from the local database.',
        );
      }
      return createSpeakingService(
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
