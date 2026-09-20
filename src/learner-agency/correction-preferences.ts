/**
 * src/learner-agency/correction-preferences.ts
 *
 * Work Order 2 — correction intensity, persisted through the ONE existing
 * settings architecture: the single `learner_profile` row (its additive
 * `preferences` JSON). There is deliberately no second preference store and
 * no parallel mode system — the intensity maps onto the EXISTING
 * ConversationMode the conversation engine already honors.
 *
 * The temporary "fewer corrections for now" override NEVER touches this
 * service: it is session-local UI state resolved per turn
 * (`resolveEffectiveConversationMode`) so it disappears with the practice
 * session and cannot silently rewrite the learner's stored choice.
 */

import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import { SQLiteUserProfileRepository } from '../data/local/sqlite/repositories';
import type { CorrectionIntensity, LearnerPreferences } from '../domain/shared/types';
import type { UserProfileRepository } from '../repositories';
import {
  DEFAULT_CORRECTION_INTENSITY,
  isCorrectionIntensity,
} from './types';

export interface CorrectionPreferenceResult {
  readonly intensity: CorrectionIntensity;
  /** Where the value came from — honest presentation of default vs stored. */
  readonly origin: 'stored' | 'default' | 'invalid-stored' | 'unavailable';
}

export interface CorrectionPreferencesService {
  load(): Promise<CorrectionPreferenceResult>;
  /** Persist one intensity. False only on storage failure (never silent). */
  save(intensity: CorrectionIntensity): Promise<boolean>;
  /**
   * Merge ONE preference key without clobbering the rest of the profile row.
   * The profile update stays additive: learning goals, modes and levels are
   * never touched here.
   */
  updatePreferences(patch: Partial<{ correctionIntensity: CorrectionIntensity }>): Promise<boolean>;
  get(): Promise<{ preferences: Record<string, unknown>; profileId: string | null } | null>;
}

export interface CorrectionPreferencesOptions {
  readonly userProfileRepository?: UserProfileRepository;
  readonly databaseAdapter?: DatabaseAdapter;
}

export function createCorrectionPreferencesService(
  options?: CorrectionPreferencesOptions,
): CorrectionPreferencesService {
  let repo: UserProfileRepository | null = options?.userProfileRepository ?? null;
  let adapter: DatabaseAdapter | null = options?.databaseAdapter ?? null;
  const injected = Boolean(options?.userProfileRepository);

  async function ensureRepo(): Promise<UserProfileRepository | null> {
    try {
      if (!repo && !adapter && !injected) {
        const { getAppDatabase } = await import('../data/local/sqlite/app-database');
        adapter = (await getAppDatabase()).adapter;
      }
      if (adapter && !repo) repo = new SQLiteUserProfileRepository(adapter);
      return repo;
    } catch {
      return null;
    }
  }

  async function get(): Promise<{ preferences: Record<string, unknown>; profileId: string | null } | null> {
    const r = await ensureRepo();
    if (!r) return null;
    try {
      const profile = await r.get();
      if (!profile || !profile.id) return null;
      const preferences =
        profile.preferences && typeof profile.preferences === 'object'
          ? (profile.preferences as Record<string, unknown>)
          : {};
      return { preferences, profileId: profile.id };
    } catch {
      // No profile yet (fresh install) is NOT an error the learner should see.
      return null;
    }
  }

  return {
    async get() {
      return get();
    },

    async load(): Promise<CorrectionPreferenceResult> {
      const current = await get();
      if (!current) {
        return { intensity: DEFAULT_CORRECTION_INTENSITY, origin: 'unavailable' };
      }
      const stored = current.preferences.correctionIntensity;
      if (stored === undefined) {
        return { intensity: DEFAULT_CORRECTION_INTENSITY, origin: 'default' };
      }
      if (!isCorrectionIntensity(stored)) {
        return { intensity: DEFAULT_CORRECTION_INTENSITY, origin: 'invalid-stored' };
      }
      return { intensity: stored, origin: 'stored' };
    },

    async save(intensity: CorrectionIntensity): Promise<boolean> {
      if (!isCorrectionIntensity(intensity)) return false;
      return this.updatePreferences({ correctionIntensity: intensity });
    },

    async updatePreferences(patch): Promise<boolean> {
      const r = await ensureRepo();
      if (!r) return false;
      // Values are validated BEFORE touching storage: an invalid intensity can
      // never reach the profile row.
      if (
        'correctionIntensity' in patch &&
        patch.correctionIntensity !== undefined &&
        !isCorrectionIntensity(patch.correctionIntensity)
      ) {
        return false;
      }
      try {
        const current = await get();
        if (!current) {
          // No profile row yet (fresh install): preferences live ON the profile,
          // so saving here must NOT invent a learner profile outside onboarding.
          return false;
        }
        const merged = {
          ...(current?.preferences ?? {}),
          ...(patch.correctionIntensity ? { correctionIntensity: patch.correctionIntensity } : {}),
        } as LearnerPreferences;
        await r.update({ preferences: merged });
        return true;
      } catch {
        return false;
      }
    },
  };
}
