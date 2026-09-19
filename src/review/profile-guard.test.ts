/**
 * src/review/profile-guard.test.ts
 *
 * Regression tests for the real-device first-launch Review blocker:
 * a fresh install has no learner profile, and
 * `SQLiteUserProfileRepository.get()` THROWS the known
 * "No user profile found" condition. Review must treat that as its normal
 * no-profile state — never as "Could not load your saved reviews",
 * never with a fake review queue, and without auto-creating a profile.
 *
 * Genuine database failures must still surface as errors.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import { SQLiteUserProfileRepository } from '../data/local/sqlite/repositories';
import {
  isProfileNotFoundError,
  readReviewLearnerProfile,
} from './profile-guard';

async function freshProfileRepo(): Promise<SQLiteUserProfileRepository> {
  const adapter = new SqlJsAdapter(':memory:');
  await adapter.init();
  return new SQLiteUserProfileRepository(adapter);
}

describe('Review first-launch profile handling (real repository)', () => {
  it('fresh install / no profile => "missing" (no-profile state), not an error', async () => {
    const repo = await freshProfileRepo();
    await expect(readReviewLearnerProfile(repo)).resolves.toEqual({
      status: 'missing',
    });
  });

  it('does NOT create a profile: the repository is still empty afterwards', async () => {
    const repo = await freshProfileRepo();
    await readReviewLearnerProfile(repo);
    // The guard must never auto-create: the known throw is unchanged.
    await expect(repo.get()).rejects.toThrow('No user profile found');
  });

  it('does NOT weaken the repository contract: get() still throws when empty', async () => {
    const repo = await freshProfileRepo();
    await expect(repo.get()).rejects.toThrow(
      'No user profile found. Call update() first to create one.',
    );
  });

  it('existing profile => "ok" with the real learner id', async () => {
    const repo = await freshProfileRepo();
    const created = await repo.update({
      displayName: 'Returning learner',
      targetLanguage: 'en',
      targetLevel: 'A2',
      currentLevel: 'A1',
      learningGoals: ['conversation'],
      preferredModes: ['natural'],
    });
    await expect(readReviewLearnerProfile(repo)).resolves.toEqual({
      status: 'ok',
      learnerId: created.id,
    });
  });

  it('real database failures are re-thrown, never classified as missing', async () => {
    const sqlFailure = {
      get: () =>
        Promise.reject(new Error('SQLITE_ERROR: no such table: learner_profile')),
    };
    await expect(readReviewLearnerProfile(sqlFailure)).rejects.toThrow(
      'no such table',
    );

    const lockedDb = {
      get: () => Promise.reject(new Error('database is locked')),
    };
    await expect(readReviewLearnerProfile(lockedDb)).rejects.toThrow(
      'database is locked',
    );

    const unexpected = { get: () => Promise.reject(new Error('boom')) };
    await expect(readReviewLearnerProfile(unexpected)).rejects.toThrow('boom');
  });

  it('defensively treats a null or id-less result as missing', async () => {
    await expect(
      readReviewLearnerProfile({ get: async () => null }),
    ).resolves.toEqual({ status: 'missing' });
    await expect(
      readReviewLearnerProfile({ get: async () => ({}) }),
    ).resolves.toEqual({ status: 'missing' });
  });

  it('classifies ONLY the known repository condition as "no profile found"', () => {
    expect(
      isProfileNotFoundError(
        new Error('No user profile found. Call update() first to create one.'),
      ),
    ).toBe(true);
    expect(
      isProfileNotFoundError(new Error('database is locked')),
    ).toBe(false);
    expect(isProfileNotFoundError('No user profile found')).toBe(false);
    expect(isProfileNotFoundError(null)).toBe(false);
  });
});

describe('ReviewScreen wiring (source contract)', () => {
  const reviewSrc = readFileSync(
    new URL('../screens/ReviewScreen.tsx', import.meta.url),
    'utf8',
  );

  it('routes BOTH Review entry points through the profile guard', () => {
    expect(reviewSrc).toContain(
      "import { readReviewLearnerProfile } from '../review/profile-guard'",
    );
    expect(reviewSrc.match(/readReviewLearnerProfile\(profileRepo\)/g)).toHaveLength(2);
  });

  it('treats a missing profile as the no-profile state, never a load failure', () => {
    expect(reviewSrc).toContain("profileOutcome.status === 'missing'");
    // The existing intended UX (no-profile banner + onboarding entry) is
    // what the missing branch drives.
    expect(reviewSrc).toContain('setHasNoProfile(true)');
    expect(reviewSrc).toContain('navigation.navigate(\'Onboarding\')');
  });
});
