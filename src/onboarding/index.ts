/**
 * src/onboarding/index.ts
 *
 * Public surface of Personalized Onboarding & Diagnostic Assessment (Phase 1).
 *
 * Screens never touch SQLite: they receive an injected service or await
 * `createDefaultOnboardingService()`, which composes the EXISTING systems on the
 * SAME canonical app database (no second database, no second profile
 * repository, no second AI provider).
 */

import {
  appDatabaseLifecycleToken,
  getAppDatabase,
} from '../data/local/sqlite/app-database';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { createRecoverableSingleFlight } from '../shared/single-flight';
import { createTalkComposition } from '../talk-demo';
import { createListeningService } from '../listening';
import { createPronunciationEngine } from '../pronunciation';
import { SQLiteUserProfileRepository } from '../data/local/sqlite/repositories';
import { createOnboardingService, type OnboardingService } from './service';

/** The listening task type is the EXISTING ListeningService type (re-exported). */
export type { ListeningExercise } from '../listening';

export * from './types';
export * from './answer-commit';
export * from './assessment';
export * from './session';
export * from './speaking';
export * from './service';

/**
 * Compose the onboarding service on a GIVEN adapter (tests / embedding).
 *
 * The EXISTING engines are injected here — the same compositions the Talk,
 * Listening and Pronunciation screens use on the SAME adapter:
 *   - the learner model (profile + persisted evidence),
 *   - ListeningService (listening weaknesses + review scheduling owner),
 *   - PronunciationEngine (the ONLY pronunciation analyser/persistence owner).
 * Nothing is re-created per call and no second database is opened.
 */
export function createOnboardingServiceOn(adapter: DatabaseAdapter): OnboardingService {
  const composition = createTalkComposition(adapter);
  return createOnboardingService({
    adapter,
    learnerModel: composition.learnerModel,
    listening: createListeningService(adapter),
    pronunciation: createPronunciationEngine(adapter),
    profileRepository: new SQLiteUserProfileRepository(adapter),
  });
}

// Default composition bootstrap — the canonical application database owns the
// adapter lifecycle (see src/data/local/sqlite/app-database.ts); this factory
// only composes the service ON that shared adapter. A failed bootstrap is not
// cached, so a later call retries.
const defaultService = createRecoverableSingleFlight(
  async () => {
    const { adapter } = await getAppDatabase();
    return createOnboardingServiceOn(adapter);
  },
  // Cached for ONE database lifecycle only (see app-database.ts).
  { lifecycleToken: appDatabaseLifecycleToken },
);

/** Compose the service on the canonical app database (reused across calls). */
export function createDefaultOnboardingService(): Promise<OnboardingService> {
  return defaultService();
}
