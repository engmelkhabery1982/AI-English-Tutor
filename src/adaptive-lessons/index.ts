/**
 * src/adaptive-lessons/index.ts
 *
 * Public surface of the Adaptive Lessons Engine (Phase 1).
 *
 * DATABASE OWNERSHIP (Wave 2): the default composition reuses the CANONICAL
 * application database owner instead of opening its own adapter.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { getApplicationDatabase } from '../data/local/sqlite/ApplicationDatabase';
import { createTalkComposition } from '../talk-demo';
import { createReviewService } from '../review/factory';
import { AdaptiveLessonService } from './service';

export * from './types';
export * from './planner';
export * from './prompts';
export * from './service';
export * from './speaking';

type AdaptiveLessonDepsHint = ConstructorParameters<typeof AdaptiveLessonService>[0];

/** Compose the service on a given adapter (tests / embedding). */
export function createAdaptiveLessonServiceOn(
  adapter: DatabaseAdapter,
  options?: Partial<AdaptiveLessonDepsHint>,
): AdaptiveLessonService {
  const composition = createTalkComposition(adapter);
  return new AdaptiveLessonService({
    adapter,
    learnerModel: composition.learnerModel,
    review: createReviewService(adapter),
    ...options,
  });
}

// Default composition bootstrap — adapter lifecycle lives behind the
// CANONICAL owner, never inside UI screens.
let defaultServicePromise: Promise<AdaptiveLessonService> | null = null;

/** Compose the service on the canonical application database (reused app-wide). */
export function createDefaultAdaptiveLessonService(): Promise<AdaptiveLessonService> {
  if (!defaultServicePromise) {
    defaultServicePromise = (async () => {
      const adapter = await getApplicationDatabase().getAdapter();
      return createAdaptiveLessonServiceOn(adapter);
    })().catch((error: unknown) => {
      defaultServicePromise = null;
      throw error;
    });
  }
  return defaultServicePromise;
}
