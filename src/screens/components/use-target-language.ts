/**
 * src/screens/components/use-target-language.ts
 *
 * The ONE translation-target rule for every contextual inspection entry
 * point (Talk, Reading/Story, Listening transcripts, Deep Listening).
 *
 * It REUSES the exact learner-profile source Learning Tools already uses —
 * the canonical app database through `createAppRepositories(...).profile`
 * (the same call `createLearningTools` makes). No second profile store is
 * introduced. Rule: the profile's `nativeLanguage` wins; the existing app
 * default applies only while the profile language is unavailable.
 */

import { useEffect, useState } from 'react';
import { getAppDatabase } from '../../data/local/sqlite/app-database';
import { createAppRepositories } from '../../adaptive-lessons';
import { isProfileNotFoundError } from '../../review/profile-guard';
import {
  DEFAULT_INSPECTION_TARGET_LANGUAGE,
  resolveTargetLanguage,
} from './inspectable-text';

/**
 * Resolves the Dictionary & Translate target language: learner profile
 * native language when available, otherwise the existing default. Read-only
 * and best-effort — a missing profile or unreadable store simply keeps the
 * default (inspection must always remain available).
 */
export function useTargetLanguage(): string {
  const [targetLanguage, setTargetLanguage] = useState<string>(
    DEFAULT_INSPECTION_TARGET_LANGUAGE,
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { adapter } = await getAppDatabase();
        const repos = createAppRepositories(adapter);
        const profile = await repos.profile.get().catch((error) => {
          if (isProfileNotFoundError(error)) return null;
          throw error;
        });
        if (!cancelled) {
          setTargetLanguage(resolveTargetLanguage(profile?.nativeLanguage));
        }
      } catch {
        // Profile store unreadable → keep the existing default target.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return targetLanguage;
}
