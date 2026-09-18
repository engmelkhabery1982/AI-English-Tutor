/**
 * src/learning-progression/difficulty.ts
 *
 * WP-1: the ONE deterministic difficulty-profile resolver.
 *
 * PURITY CONTRACT (non-negotiable)
 * - pure and deterministic: identical input → identical output;
 * - no repositories, no AI, no network, no clock reads, no randomness;
 * - it operates ONLY over the already-loaded inputs it is given;
 * - it NEVER writes anything back (no level update, no evidence mutation).
 *
 * LEVEL FIDELITY
 * `level` is a stored WORKING LEVEL, not proven proficiency. WP-1 cannot
 * reliably distinguish every historical source of that level without a schema
 * change, so it does NOT:
 * - fabricate level provenance,
 * - infer or promote a level,
 * - treat completed sessions or saved words as proof of ability.
 *
 * REAL negative evidence already present in the loaded snapshot MAY make the
 * profile MORE SUPPORTED (shorter discourse, smaller budget, more support).
 * Negative evidence can NEVER raise complexity.
 *
 * `unknown` resolves to the most conservative profile.
 */

import type { SkillDomain } from '../curriculum/types';
import { hasUrgentNegativeEvidence } from './evidence';
import type {
  DifficultyProfile,
  DiscourseLength,
  GrammarComplexity,
  LearnerProgressionEvidence,
  ProgressionLevel,
  SpeechStyle,
  SupportLevel,
} from './types';

/** Discourse length from shortest to longest (index order is the scale). */
export const DISCOURSE_LENGTH_ORDER: readonly DiscourseLength[] = [
  'single_sentence',
  'short_paragraph',
  'paragraph',
  'extended',
] as const;

/** Support from least to most supportive (index order is the scale). */
export const SUPPORT_LEVEL_ORDER: readonly SupportLevel[] = [
  'minimal',
  'light',
  'moderate',
  'high',
] as const;

/** Grammar complexity from simplest to most complex. */
export const GRAMMAR_COMPLEXITY_ORDER: readonly GrammarComplexity[] = [
  'basic',
  'intermediate',
  'advanced',
] as const;

/** The conservative baseline used when the working level is not known. */
export const UNKNOWN_LEVEL_PROFILE: DifficultyProfile['level'] = 'unknown';

/** The one conservative text style used when the level is not known. */
const CONSERVATIVE_SPEECH_STYLE: SpeechStyle = {
  register: 'everyday',
  sentenceShape: 'short_simple',
  contractionDensity: 'moderate',
  lexicalStyle: 'high_frequency',
};

/**
 * The conservative BASE profile per stored level.
 *
 * `unknown` is deliberately the most conservative row: it is shorter and
 * introduces less new language than the lowest known level.
 */
const BASE_PROFILES: Readonly<
  Record<
    ProgressionLevel,
    {
      readonly discourseLength: DiscourseLength;
      readonly newLanguageBudget: number;
      readonly grammarComplexity: GrammarComplexity;
      readonly supportLevel: SupportLevel;
      readonly speechStyle: SpeechStyle;
    }
  >
> = {
  unknown: {
    discourseLength: 'single_sentence',
    newLanguageBudget: 1,
    grammarComplexity: 'basic',
    supportLevel: 'high',
    speechStyle: CONSERVATIVE_SPEECH_STYLE,
  },
  A1: {
    discourseLength: 'single_sentence',
    newLanguageBudget: 2,
    grammarComplexity: 'basic',
    supportLevel: 'high',
    speechStyle: {
      register: 'everyday',
      sentenceShape: 'short_simple',
      contractionDensity: 'moderate',
      lexicalStyle: 'high_frequency',
    },
  },
  A2: {
    discourseLength: 'short_paragraph',
    newLanguageBudget: 3,
    grammarComplexity: 'basic',
    supportLevel: 'moderate',
    speechStyle: {
      register: 'everyday',
      sentenceShape: 'simple_with_coordination',
      contractionDensity: 'moderate',
      lexicalStyle: 'high_frequency',
    },
  },
  B1: {
    discourseLength: 'short_paragraph',
    newLanguageBudget: 4,
    grammarComplexity: 'intermediate',
    supportLevel: 'moderate',
    speechStyle: {
      register: 'neutral',
      sentenceShape: 'simple_with_coordination',
      contractionDensity: 'high',
      lexicalStyle: 'common_general',
    },
  },
  B2: {
    discourseLength: 'paragraph',
    newLanguageBudget: 5,
    grammarComplexity: 'intermediate',
    supportLevel: 'light',
    speechStyle: {
      register: 'neutral',
      sentenceShape: 'mixed_clauses',
      contractionDensity: 'high',
      lexicalStyle: 'varied',
    },
  },
  C1: {
    discourseLength: 'extended',
    newLanguageBudget: 6,
    grammarComplexity: 'advanced',
    supportLevel: 'light',
    speechStyle: {
      register: 'professional',
      sentenceShape: 'complex_clauses',
      contractionDensity: 'moderate',
      lexicalStyle: 'varied',
    },
  },
  C2: {
    discourseLength: 'extended',
    newLanguageBudget: 8,
    grammarComplexity: 'advanced',
    supportLevel: 'minimal',
    speechStyle: {
      register: 'formal',
      sentenceShape: 'complex_clauses',
      contractionDensity: 'low',
      lexicalStyle: 'precise',
    },
  },
};

/** The most conservative difficulty profile (used when the level is unknown). */
export const CONSERVATIVE_DIFFICULTY_PROFILE: DifficultyProfile = {
  level: UNKNOWN_LEVEL_PROFILE,
  ...BASE_PROFILES.unknown,
  evidenceAdjusted: false,
};

/** True when the level input is a real stored level (not 'unknown'). */
export function isKnownLevel(level: string): boolean {
  return level === 'A1' || level === 'A2' || level === 'B1' || level === 'B2' || level === 'C1' || level === 'C2';
}

/** Step an ordered scale one position DOWN (easier), never past the floor. */
function stepDown<T>(order: readonly T[], value: T): { value: T; stepped: boolean } {
  const index = order.indexOf(value);
  if (index <= 0) return { value, stepped: false };
  return { value: order[index - 1], stepped: true };
}

/** Step an ordered scale one position UP (more of it), never past the ceiling. */
function stepUp<T>(order: readonly T[], value: T): { value: T; stepped: boolean } {
  const index = order.indexOf(value);
  if (index < 0 || index >= order.length - 1) return { value, stepped: false };
  return { value: order[index + 1], stepped: true };
}

/**
 * Resolve the deterministic difficulty profile for ONE learner in ONE domain.
 *
 * @param level   the stored WORKING level (never promoted here)
 * @param evidence the ALREADY-LOADED learner evidence snapshot (optional)
 * @param domain  optional existing curriculum domain; WP-1 may resolve the
 *                same values for several domains, but the argument is
 *                threaded so later work can diverge without a contract change
 */
export function resolveDifficultyProfile(
  level: ProgressionLevel,
  evidence?: LearnerProgressionEvidence | null,
  domain?: SkillDomain,
): DifficultyProfile {
  const base = BASE_PROFILES[level] ?? BASE_PROFILES.unknown;
  const resolvedLevel: ProgressionLevel = BASE_PROFILES[level] ? level : 'unknown';

  const baseProfile: DifficultyProfile = {
    level: resolvedLevel,
    ...(domain !== undefined ? { domain } : {}),
    discourseLength: base.discourseLength,
    newLanguageBudget: base.newLanguageBudget,
    grammarComplexity: base.grammarComplexity,
    supportLevel: base.supportLevel,
    speechStyle: base.speechStyle,
    evidenceAdjusted: false,
  };

  // Real, repeated negative evidence makes practice MORE SUPPORTED only:
  // shorter input, a smaller deliberate new-language budget and more support.
  // Grammar complexity and speech style are never raised by evidence, and
  // they are never raised at all here.
  if (!hasUrgentNegativeEvidence(evidence, domain)) {
    return baseProfile;
  }

  const support = stepUp(SUPPORT_LEVEL_ORDER, base.supportLevel);
  const discourse = stepDown(DISCOURSE_LENGTH_ORDER, base.discourseLength);
  const adjusted = support.stepped || discourse.stepped || base.newLanguageBudget > 1;
  if (!adjusted) {
    // Already at the most supported end of every axis: the profile is
    // unchanged, and it must not claim an adjustment it did not make.
    return baseProfile;
  }

  return {
    ...baseProfile,
    supportLevel: support.value,
    discourseLength: discourse.value,
    newLanguageBudget: base.newLanguageBudget > 1 ? base.newLanguageBudget - 1 : base.newLanguageBudget,
    evidenceAdjusted: true,
  };
}
