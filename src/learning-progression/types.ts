/**
 * src/learning-progression/types.ts
 *
 * WP-1 shared foundation: the DIFFICULTY PROFILE.
 *
 * PURPOSE
 * A single deterministic description of HOW material should look for a
 * learner, derived only from the stored WORKING LEVEL plus already-loaded
 * real evidence. It is the shared input for generated content and for
 * prompt guidance, so later work packages can extend it additively instead
 * of inventing parallel difficulty concepts.
 *
 * HONESTY RULES BAKED INTO THE TYPE
 * - `level` is the stored WORKING LEVEL / claim (see ../domain/shared/types
 *   CefrLevelInput). It is NOT proof of proficiency and is never promoted
 *   here.
 * - `unknown` resolves to the most conservative profile.
 * - There is deliberately NO numeric score, band or percentage anywhere.
 * - `speechStyle` describes TEXT behaviour only (register, sentence shape,
 *   contraction density, lexical style). It does NOT control TTS delivery
 *   or speak rate. Audio delivery variables belong to later work and are
 *   intentionally absent so that nothing here pretends to own them.
 * - `supportLevel` is the ONE support axis. There is deliberately no
 *   separate scaffolding / task-independence pair, because those overlap.
 */

import type { CefrLevelInput, WeaknessStatus } from '../domain/shared/types';
import type { SkillDomain } from '../curriculum/types';

/**
 * The learner's level input. Reuses the EXISTING level type — WP-1
 * deliberately does NOT introduce a second proficiency scale.
 */
export type ProgressionLevel = CefrLevelInput;

/** How much spoken/written material one item should contain. */
export type DiscourseLength =
  | 'single_sentence'
  | 'short_paragraph'
  | 'paragraph'
  | 'extended';

/** Qualitative grammatical complexity band (never a score). */
export type GrammarComplexity = 'basic' | 'intermediate' | 'advanced';

/**
 * How much support the material should provide. Replaces the overlapping
 * scaffolding / task-independence concepts with ONE honest axis.
 * More supportive = easier: 'minimal' is the least support.
 */
export type SupportLevel = 'minimal' | 'light' | 'moderate' | 'high';

/** Text register of the material (TEXT behaviour only). */
export type TextRegister = 'everyday' | 'neutral' | 'professional' | 'formal';

/** Sentence shape guidance (TEXT behaviour only). */
export type SentenceShape =
  | 'short_simple'
  | 'simple_with_coordination'
  | 'mixed_clauses'
  | 'complex_clauses';

/** Contraction density guidance (TEXT behaviour only). */
export type ContractionDensity = 'high' | 'moderate' | 'low';

/** Lexical style guidance (TEXT behaviour only). */
export type LexicalStyle = 'high_frequency' | 'common_general' | 'varied' | 'precise';

/**
 * TEXT behaviour of the material. This is deliberately NOT an audio/TTS
 * concern: no speak rate, no prosody, no accent, no connected-speech model.
 */
export interface SpeechStyle {
  readonly register: TextRegister;
  readonly sentenceShape: SentenceShape;
  readonly contractionDensity: ContractionDensity;
  readonly lexicalStyle: LexicalStyle;
}

/**
 * A deterministic difficulty description for ONE learner in ONE domain.
 *
 * Every field is produced by `resolveDifficultyProfile` from the working
 * level (and, optionally, real negative evidence that may only make the
 * profile MORE supported).
 */
export interface DifficultyProfile {
  /** The stored working level this profile was resolved from. */
  readonly level: ProgressionLevel;
  /**
   * The domain this profile was resolved for, when the caller supplied one.
   * WP-1 may resolve identical values for different domains; the argument
   * exists so later work can introduce domain-specific divergence WITHOUT
   * changing the contract.
   */
  readonly domain?: SkillDomain;
  readonly discourseLength: DiscourseLength;
  /** Maximum deliberately introduced target language items (>= 0). */
  readonly newLanguageBudget: number;
  readonly grammarComplexity: GrammarComplexity;
  readonly supportLevel: SupportLevel;
  readonly speechStyle: SpeechStyle;
  /**
   * True when REAL negative evidence from the already-loaded snapshot made
   * this profile more supported. Never true because of invented evidence.
   */
  readonly evidenceAdjusted: boolean;
}

/**
 * One already-loaded piece of negative learner evidence, normalized to the
 * curriculum domain it belongs to. This is a NARROW structural type so any
 * owner service can pass its own already-loaded rows without new reads.
 */
export interface ProgressionWeaknessEvidence {
  readonly domain: SkillDomain;
  /** The EXISTING learner-weakness lifecycle state. */
  readonly status: WeaknessStatus;
  readonly resolved: boolean;
}

/**
 * The already-loaded evidence a difficulty profile may look at.
 *
 * It contains weakness evidence ONLY: session counts, saved-word volume and
 * similar activity metrics are deliberately NOT modelled here, because they
 * are not proof of ability.
 */
export interface LearnerProgressionEvidence {
  readonly weaknesses: readonly ProgressionWeaknessEvidence[];
}
