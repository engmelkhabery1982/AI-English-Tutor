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
import { appDatabaseLifecycleToken } from '../data/local/sqlite/app-database';
import {
  SQLiteProgressRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { LearnerModel } from '../learner-model';
import {
  createSuccessObservationRecorder,
  type SuccessObservationRecorder,
} from '../reassessment/success-recorder';
import { resolveTalkCoaching } from '../talk-demo';
import { createRecoverableSingleFlight } from '../shared/single-flight';
import {
  createSpeakingPracticeService,
  type SpeakingPracticeService,
  type SpeakingPracticeServiceOptions,
  type SpeakingProgressPort,
} from './service';

export * from './types';
export * from './planner';
export * from './prompts';
export * from './seed';
export * from './turn-rules';
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

// Default composition bootstrap — the canonical application database owns the
// adapter lifecycle (see src/data/local/sqlite/app-database.ts) and Talk is
// resolved through ITS lifecycle-aware default composition. The value is cached
// for ONE database lifecycle: a close invalidates it, so the next request
// re-resolves on the new connection instead of keeping a closed adapter.
const defaultComposition = createRecoverableSingleFlight<DefaultSpeakingComposition>(
  async () => {
    const resolution = await resolveTalkCoaching();
    if (!resolution.learnerModel || !resolution.databaseAdapter) {
      // No persisted learner state: Deep Speaking stays unavailable rather
      // than planning from demo data and calling it personalization.
      throw new Error(
        'Persisted learner data could not be composed from the local database.',
      );
    }
    return {
      service: createSpeakingService(
        resolution.learnerModel,
        resolution.databaseAdapter,
      ),
      adapter: resolution.databaseAdapter,
    };
  },
  // Cached for ONE database lifecycle only (see app-database.ts).
  { lifecycleToken: appDatabaseLifecycleToken },
);

/**
 * The canonical app composition behind the default speaking service: the
 * service itself PLUS the one database adapter it runs on (the same
 * `ai_english_tutor.db` composition used by Talk / Listening / Adaptive
 * Lessons / Review). Exposing the adapter here lets OTHER production
 * compositions (e.g. fluency) attach evidence writers to the SAME database
 * instead of opening a second one.
 */
export interface DefaultSpeakingComposition {
  readonly service: SpeakingPracticeService;
  readonly adapter: DatabaseAdapter;
}

/** Compose (once per database lifecycle, reused) on the default app database. */
export function createDefaultSpeakingComposition(): Promise<DefaultSpeakingComposition> {
  return defaultComposition();
}

/** Compose the service on the default app database (reused across calls). */
export async function createDefaultSpeakingService(): Promise<SpeakingPracticeService> {
  return (await createDefaultSpeakingComposition()).service;
}

/**
 * The canonical composition, or null when no persisted learner state can be
 * composed (the honest "unavailable" answer — never demo data presented as
 * real state).
 */
export async function resolveDefaultSpeakingComposition(): Promise<DefaultSpeakingComposition | null> {
  try {
    return await createDefaultSpeakingComposition();
  } catch {
    return null;
  }
}

/**
 * The EXISTING success-observation recorder over a canonical composition's
 * own adapter.
 *
 * WP-4 production wiring: fluency success evidence must land in the SAME
 * learner-strength store the rest of the app uses — same adapter, same
 * EXISTING weakness repository, no second database and no second stack.
 */
export function createSpeakingSuccessRecorder(
  adapter: DatabaseAdapter,
): SuccessObservationRecorder {
  return createSuccessObservationRecorder(new SQLiteWeaknessRepository(adapter));
}
