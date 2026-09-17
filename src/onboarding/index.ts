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

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { createTalkComposition } from '../talk-demo';
import { createOnboardingService, type OnboardingService } from './service';

/** The listening task type is the EXISTING ListeningService type (re-exported). */
export type { ListeningExercise } from '../listening';

export * from './types';
export * from './assessment';
export * from './session';
export * from './speaking';
export * from './service';

/** Compose the onboarding service on a GIVEN adapter (tests / embedding). */
export function createOnboardingServiceOn(adapter: DatabaseAdapter): OnboardingService {
  const composition = createTalkComposition(adapter);
  return createOnboardingService({
    adapter,
    learnerModel: composition.learnerModel,
  });
}

// Default composition bootstrap — adapter lifecycle lives behind composition,
// never inside UI screens (SAME pattern as Talk / Listening / Pronunciation).
let defaultServicePromise: Promise<OnboardingService> | null = null;

/** Compose the service on the default app database (reused across calls). */
export function createDefaultOnboardingService(): Promise<OnboardingService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();
      return createOnboardingServiceOn(adapter);
    })().catch((error: unknown) => {
      // Allow a later retry instead of caching a failed bootstrap forever.
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
