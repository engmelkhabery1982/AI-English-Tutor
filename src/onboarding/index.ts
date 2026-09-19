/**
 * src/onboarding/index.ts
 *
 * Public surface of Personalized Onboarding & Diagnostic Assessment (Phase 1).
 *
 * Screens never touch SQLite: they receive an injected service or await
 * `createDefaultOnboardingService()`, which composes the EXISTING systems on the
 * SAME canonical app database (no second database, no second profile
 * repository, no second AI provider).
 *
 * DATABASE OWNERSHIP (Wave 2): the default composition reuses the CANONICAL
 * application database owner instead of opening its own adapter.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { getApplicationDatabase } from '../data/local/sqlite/ApplicationDatabase';
import { createTalkComposition } from '../talk-demo';
import { createListeningService } from '../listening';
import { createPronunciationEngine } from '../pronunciation';
import { SQLiteUserProfileRepository } from '../data/local/sqlite/repositories';
import { createOnboardingService, type OnboardingService } from './service';

/** The listening task type is the EXISTING ListeningService type (re-exported). */
export type { ListeningExercise } from '../listening';

export * from './types';
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

// Default composition bootstrap — the adapter lifecycle lives behind the
// CANONICAL owner, never inside UI screens.
let defaultServicePromise: Promise<OnboardingService> | null = null;

/** Compose the service on the canonical application database (reused app-wide). */
export function createDefaultOnboardingService(): Promise<OnboardingService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const adapter = await getApplicationDatabase().getAdapter();
      return createOnboardingServiceOn(adapter);
    })().catch((error: unknown) => {
      // Allow a later retry instead of caching a failed bootstrap forever.
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
