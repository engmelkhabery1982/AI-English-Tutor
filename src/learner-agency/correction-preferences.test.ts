/**
 * src/learner-agency/correction-preferences.test.ts
 *
 * Work Order 2 — correction intensity persistence THROUGH THE EXISTING
 * profile/preferences architecture (the `learner_profile` row), verified
 * against the real SQLite stack. There is deliberately no second settings
 * store: these tests also prove the preference lives on the profile row and
 * that other profile fields are never clobbered.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import { SQLiteUserProfileRepository } from '../data/local/sqlite/repositories';
import { createCorrectionPreferencesService } from './correction-preferences';

describe('correction preferences service (real SQLite)', () => {
  let adapter: SqlJsAdapter;
  let profileRepo: SQLiteUserProfileRepository;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    profileRepo = new SQLiteUserProfileRepository(adapter);
    await profileRepo.update({
      displayName: 'Prefs Tester',
      nativeLanguage: 'ar',
      targetLanguage: 'en',
      targetLevel: 'B2',
      currentLevel: 'B1',
      learningGoals: ['work', 'travel'],
      preferredModes: ['natural', 'coach', 'intensive'],
    });
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('loads the default when nothing was chosen, and says so honestly', async () => {
    const service = createCorrectionPreferencesService({ userProfileRepository: profileRepo });
    const loaded = await service.load();
    expect(loaded.intensity).toBe('balanced');
    expect(loaded.origin).toBe('default');
  });

  it('persists a chosen intensity to the profile row and reads it back', async () => {
    const service = createCorrectionPreferencesService({ userProfileRepository: profileRepo });
    expect(await service.save('intensive')).toBe(true);
    expect((await service.load()).intensity).toBe('intensive');

    // It is the EXISTING profile row, not a parallel store.
    const rows = await adapter.query(
      `SELECT preferences FROM learner_profile LIMIT 1`,
      [],
    );
    const raw = rows[0]?.preferences as string | undefined;
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? '{}').correctionIntensity).toBe('intensive');
  });

  it('survives a brand-new service instance (real persistence, not memory)', async () => {
    const first = createCorrectionPreferencesService({ userProfileRepository: profileRepo });
    await first.save('natural');
    const second = createCorrectionPreferencesService({
      databaseAdapter: adapter,
    });
    const loaded = await second.load();
    expect(loaded.intensity).toBe('natural');
    expect(loaded.origin).toBe('stored');
  });

  it('rejects invalid values without writing anything', async () => {
    const service = createCorrectionPreferencesService({ userProfileRepository: profileRepo });
    expect(await service.save('aggressive' as never)).toBe(false);
    const stored = await adapter.query(`SELECT preferences FROM learner_profile LIMIT 1`, []);
    const parsed = JSON.parse((stored[0]?.preferences as string | undefined) ?? '{}');
    expect(parsed.correctionIntensity).toBeUndefined();
  });

  it('reports an invalid stored value honestly and still loads a usable default', async () => {
    await profileRepo.update({ preferences: { correctionIntensity: 'turbo' } } as never);
    const service = createCorrectionPreferencesService({
      databaseAdapter: adapter,
    });
    const loaded = await service.load();
    expect(loaded.intensity).toBe('balanced');
    expect(loaded.origin).toBe('invalid-stored');
  });

  it('merges into the profile WITHOUT clobbering goals, modes or level', async () => {
    const service = createCorrectionPreferencesService({ userProfileRepository: profileRepo });
    expect(await service.save('intensive')).toBe(true);
    // An unrelated profile update must survive round-trips both ways.
    const profile = await profileRepo.get();
    expect(profile.learningGoals).toEqual(['work', 'travel']);
    expect(profile.preferredModes).toEqual(['natural', 'coach', 'intensive']);
    expect(profile.currentLevel).toBe('B1');
    expect((profile.preferences ?? {}).correctionIntensity).toBe('intensive');

    // A later profile save keeps the stored preference (additive update).
    await profileRepo.update({ displayName: 'Renamed Tester' });
    const after = await service.load();
    expect(after.intensity).toBe('intensive');
    expect(after.origin).toBe('stored');
  });

  it('does NOT invent a profile when none exists', async () => {
    const bare = new SqlJsAdapter(':memory:');
    await bare.init();
    try {
      const service = createCorrectionPreferencesService({ databaseAdapter: bare });
      const loaded = await service.load();
      expect(loaded.origin).toBe('unavailable');
      expect(await service.save('natural')).toBe(false);
      const rows = await bare.query(`SELECT COUNT(*) AS count FROM learner_profile`, []);
      expect(Number((rows[0] as { count: number }).count)).toBe(0);
    } finally {
      await bare.close();
    }
  });
});
