/**
 * src/content-generation/types.ts
 *
 * WP-1: the ONE shared ContentRequest contract and the controlled material
 * payload it produces.
 *
 * This module is a PURE REQUEST → MATERIAL transformer in architectural
 * ownership. It deliberately does NOT:
 * - read repositories or the learner model / coaching context,
 * - persist anything or schedule anything,
 * - decide WHICH skill, weakness or item to train,
 * - mutate learner evidence (no weaknesses, strengths, reviews or progress).
 *
 * Selection stays with the owning engine; the owning engine assembles the
 * request from evidence it already loaded. The transformer's only contextual
 * input is the validated ContentRequest.
 */

import type { SkillDomain } from '../curriculum/types';
import type {
  DifficultyProfile,
  DiscourseLength,
  GrammarComplexity,
  ProgressionLevel,
  SpeechStyle,
  SupportLevel,
} from '../learning-progression/types';

/**
 * The exercise tasks WP-1 may generate AI material for.
 *
 * Deliberately SMALL: `listen_and_choose` and `expression_in_context` stay on
 * their existing deterministic saved-meaning builders, and no AI distractors
 * are produced anywhere in WP-1.
 */
export type ContentTaskType = 'listen_and_type' | 'missing_word' | 'listen_and_answer';

/** Every supported task type, in stable declaration order. */
export const CONTENT_TASK_TYPES: readonly ContentTaskType[] = [
  'listen_and_type',
  'missing_word',
  'listen_and_answer',
] as const;

/**
 * Honest provenance for generated material — the EXISTING project vocabulary
 * (same three values the speaking coach already uses).
 *
 * personalized: real learner evidence materially shaped the content AND the
 *               requested target was honored.
 * mixed:        real evidence shaped some of it, but the requested target
 *               could not be honored (or only part of it was).
 * general:      no material learner evidence was used at all.
 *
 * A learner merely HAVING a profile (or a level) is NOT personalization.
 */
export type MaterialProvenance = 'personalized' | 'mixed' | 'general';

/** The curriculum target the material is for. Never guessed. */
export interface ContentTargetSkill {
  readonly domain: SkillDomain;
  /**
   * An EXISTING curriculum skill id — present only when the caller has a
   * genuine mapping. Never invented to make a plan look more specific.
   */
  readonly skillId?: string;
}

/** Bounded, honest context for the material. */
export interface ContentContext {
  /** Bounded topic label (from the owning engine's real context). */
  readonly topic?: string;
  /**
   * REAL stored learner goals used only for honesty gating (bounded).
   * They are never turned into invented facts about the learner.
   */
  readonly learningGoals: readonly string[];
  /**
   * Real profession/industry context. Only ever set from supported learner
   * context — a profession is never inferred.
   */
  readonly professionalContext?: string;
}

/** Input accepted by `buildContentRequest` (pre-normalization). */
export interface ContentRequestInput {
  readonly difficultyProfile: DifficultyProfile;
  readonly targetSkill: ContentTargetSkill;
  /** Already bounded/explicitly evidenced known vocabulary. */
  readonly knownVocabulary: readonly string[];
  /** Bounded target expressions from saved/real evidence first. */
  readonly targetExpressions: readonly string[];
  readonly taskType: ContentTaskType;
  readonly context: {
    readonly topic?: string;
    readonly learningGoals?: readonly string[];
    readonly professionalContext?: string;
  };
  /** Existing listening objective, when the owning engine supports one. */
  readonly listeningObjective?: string;
}

/**
 * The normalized, validated request every generated material echoes.
 *
 * The scalar difficulty fields are COPIED from `difficultyProfile` by
 * `buildContentRequest`, so the request can never carry a disagreement
 * between the profile and the fields derived from it.
 */
export interface ContentRequest {
  /**
   * Deterministic key of the NORMALIZED request. Identical normalized
   * requests produce an identical key (array order is normalized away).
   * WP-1 does not cache or persist material: the key exists so later work
   * can add re-serving, repetition and caching without a contract change.
   */
  readonly requestKey: string;
  /** The stored working level the profile was resolved from. */
  readonly level: ProgressionLevel;
  readonly difficultyProfile: DifficultyProfile;
  readonly targetSkill: ContentTargetSkill;
  /**
   * Bounded vocabulary the system has REAL evidence for.
   *
   * HONESTY: this is NOT the learner's complete vocabulary. It means
   * "bounded vocabulary supported by stored evidence".
   */
  readonly knownVocabulary: readonly string[];
  /** Bounded target expressions (saved/real evidence first). */
  readonly targetExpressions: readonly string[];
  /**
   * How many deliberately introduced TARGET language items the material may
   * introduce. It does NOT claim that every other word is known.
   */
  readonly newLanguageBudget: number;
  readonly grammarComplexity: GrammarComplexity;
  readonly discourseLength: DiscourseLength;
  readonly supportLevel: SupportLevel;
  /** TEXT behaviour only — never TTS delivery or speak rate. */
  readonly speechStyle: SpeechStyle;
  readonly taskType: ContentTaskType;
  readonly context: ContentContext;
  readonly listeningObjective?: string;
}

/** Why a request was rejected (never silently repaired). */
export type ContentRequestRejection =
  | 'invalid_task_type'
  | 'invalid_difficulty_profile'
  | 'invalid_budget'
  | 'invalid_skill'
  | 'unsupported_professional_context';

/** Result of building (normalizing + validating) a content request. */
export type ContentRequestBuildResult =
  | { readonly status: 'ok'; readonly request: ContentRequest }
  | {
      readonly status: 'rejected';
      readonly reason: ContentRequestRejection;
      readonly message: string;
    };

/* ------------------------------------------------------------------ *
 * Generated material
 * ------------------------------------------------------------------ */

/**
 * Validated material payload. `speakText` is what the EXISTING TTS speaks;
 * the payload carries NO scores, ratings, levels or percentages.
 */
export interface GeneratedMaterial {
  readonly requestKey: string;
  readonly taskType: ContentTaskType;
  readonly speakText: string;
  readonly question?: string;
  readonly gappedText?: string;
  readonly expectedAnswer: string;
  readonly keyItems: readonly string[];
  readonly contextTopic?: string;
  readonly explanation?: string;
  /** Optional echo of the requested target expressions the text really uses. */
  readonly targetExpressionsUsed: readonly string[];
  /** Optional echo of the introduced-new-language count. */
  readonly newLanguageItems: number;
}

/** Why material was thrown away (invalid material is DISCARDED, not repaired). */
export type GenerationValidationIssue =
  | 'unparseable_output'
  | 'request_key_mismatch'
  | 'unsupported_task_type'
  | 'unexpected_field'
  | 'missing_text'
  | 'invalid_enum'
  | 'invalid_skill'
  | 'budget_out_of_bounds'
  | 'vocabulary_out_of_bounds'
  | 'expressions_out_of_bounds'
  | 'context_dishonest'
  | 'provenance_dishonest'
  | 'internal_inconsistency';

/** Result of validating raw model output against its request. */
export type GenerationValidationResult =
  | { readonly ok: true; readonly material: GeneratedMaterial }
  | { readonly ok: false; readonly issue: GenerationValidationIssue };

/** Why controlled generation produced no material. */
export type ContentGenerationFailure =
  | 'no_provider'
  | 'provider_error'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'invalid_output';

/** Result of the request → material transform. */
export type ControlledMaterialResult =
  | {
      readonly status: 'generated';
      readonly requestKey: string;
      readonly provenance: MaterialProvenance;
      readonly material: GeneratedMaterial;
    }
  | {
      /**
       * No material was produced. There is deliberately NO provenance here:
       * nothing was served by this transformer, so it must not claim any.
       * The owning engine labels whatever deterministic material it serves
       * instead (see the listening layer's fallback provenance).
       */
      readonly status: 'unavailable';
      readonly requestKey: string;
      readonly reason: ContentGenerationFailure;
      /** Bounded, human-readable diagnostic (never a score). */
      readonly detail: string;
    };

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * Every bound is explicit so no request can carry an unbounded amount of
 * learner data into a prompt, and no material can be unboundedly long.
 */
export const CONTENT_REQUEST_BOUNDS = {
  /** Max normalized known-vocabulary entries put in a request. */
  knownVocabulary: 20,
  /** Max normalized target expressions put in a request. */
  targetExpressions: 3,
  /** Max stored goals carried in the request context. */
  learningGoals: 5,
  /** Max length of a vocabulary/expression entry. */
  termLength: 60,
  /** Max length of the topic label. */
  topicLength: 120,
  /** Max length of the listening objective. */
  objectiveLength: 200,
  /** Max length of the (bounded) professional context. */
  professionalContextLength: 160,
  /** Max deliberately introduced new-language items. */
  newLanguageBudget: 12,
  /** Max key items in one generated exercise. */
  keyItems: 4,
  /** Max words in one generated spoken passage. */
  speakTextWords: 60,
  /** Max sentences in one generated spoken passage. */
  speakTextSentences: 4,
  /** Max length of a generated explanation line. */
  explanationLength: 240,
} as const;
