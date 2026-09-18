/**
 * src/listening/deep/request.ts
 *
 * WP-2 — the deterministic DEEP LISTENING REQUEST.
 *
 * Normalize + validate one deep request and give it a deterministic
 * `requestKey`, following the EXACT discipline the WP-1 shared request
 * already established:
 *
 * - array lists are trimmed, whitespace-collapsed, lowercased, deduplicated
 *   and sorted with the shared locale-independent comparison, so ORDER and
 *   CASING can never change a key;
 * - every value that materially changes the generated material is part of the
 *   canonical identity — including `evidenceAdjusted`, because it changes the
 *   instructions the model receives;
 * - nothing is repaired: structurally invalid input is REJECTED with an
 *   explicit reason instead of being coerced into a valid-looking request.
 *
 * The key reuses the shared `stableKey` digest, so deep material can later be
 * re-served or cached without touching this contract.
 */

import {
  CONTENT_REQUEST_BOUNDS,
  compareStrings,
  hasSupportedProfessionalContext,
  normalizeTermList,
} from '../../content-generation';
import {
  CONTRACTION_DENSITIES,
  DISCOURSE_LENGTH_ORDER,
  GRAMMAR_COMPLEXITY_ORDER,
  LEXICAL_STYLES,
  SENTENCE_SHAPES,
  SUPPORT_LEVEL_ORDER,
  TEXT_REGISTERS,
  isKnownLevel,
  stableKey,
} from '../../learning-progression';
import type {
  DifficultyProfile,
  ProgressionLevel,
  SupportLevel,
} from '../../learning-progression/types';
import {
  CONNECTED_SPEECH_CATEGORIES,
  COMPREHENSION_QUESTION_KINDS,
  DEEP_LISTENING_TASK_TYPES,
  DISCOURSE_KINDS,
  SHADOWING_SUPPORT_ORDER,
} from './types';
import type {
  ComprehensionQuestionKind,
  ConnectedSpeechCategory,
  DeepListeningBounds,
  DeepListeningTaskType,
  DiscourseKind,
  ShadowingSupportLevel,
} from './types';

/** The canonical deep key version — bump only with a deliberate change. */
export const DEEP_REQUEST_KEY_VERSION = 'listening-deep:v1';

/** Bounded learner context carried for honesty only. */
export interface DeepListeningContext {
  readonly topic?: string;
  readonly learningGoals: readonly string[];
  readonly professionalContext?: string;
}

/** The normalized, validated deep request every deep material echoes. */
export interface DeepListeningRequest {
  readonly requestKey: string;
  readonly taskType: DeepListeningTaskType;
  /** Pinned for the discourse task types only. */
  readonly discourseKind?: DiscourseKind;
  readonly level: ProgressionLevel;
  readonly difficultyProfile: DifficultyProfile;
  readonly supportLevel: SupportLevel;
  readonly bounds: DeepListeningBounds;
  readonly questionKinds: readonly ComprehensionQuestionKind[];
  readonly connectedSpeechCategories: readonly ConnectedSpeechCategory[];
  readonly shadowingSupport: ShadowingSupportLevel;
  /** Bounded vocabulary the system has REAL evidence for (never "all words"). */
  readonly knownVocabulary: readonly string[];
  readonly targetExpressions: readonly string[];
  readonly context: DeepListeningContext;
  readonly listeningObjective?: string;
}

/** Input accepted by `buildDeepListeningRequest` (pre-normalization). */
export interface DeepListeningRequestInput {
  readonly difficultyProfile: DifficultyProfile;
  readonly taskType: DeepListeningTaskType;
  readonly bounds: DeepListeningBounds;
  readonly discourseKind?: DiscourseKind;
  readonly questionKinds?: readonly ComprehensionQuestionKind[];
  readonly connectedSpeechCategories?: readonly ConnectedSpeechCategory[];
  readonly shadowingSupport?: ShadowingSupportLevel;
  readonly knownVocabulary?: readonly string[];
  readonly targetExpressions?: readonly string[];
  readonly context?: {
    readonly topic?: string;
    readonly learningGoals?: readonly string[];
    readonly professionalContext?: string;
  };
  readonly listeningObjective?: string;
}

/** Why a deep request was rejected (never silently repaired). */
export type DeepRequestRejection =
  | 'invalid_task_type'
  | 'invalid_difficulty_profile'
  | 'invalid_bounds'
  | 'invalid_discourse_kind'
  | 'invalid_question_kind'
  | 'invalid_connected_speech_category'
  | 'invalid_shadowing_support'
  | 'unsupported_professional_context';

export type DeepRequestBuildResult =
  | { readonly status: 'ok'; readonly request: DeepListeningRequest }
  | { readonly status: 'rejected'; readonly reason: DeepRequestRejection; readonly message: string };

function reject(reason: DeepRequestRejection, message: string): DeepRequestBuildResult {
  return { status: 'rejected', reason, message };
}

/** Collapse whitespace (deterministic, locale-independent). */
function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function readBoundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = collapse(value);
  return collapsed.length === 0 ? undefined : collapsed.slice(0, limit);
}

function isMember<T>(order: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (order as readonly string[]).includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/* ------------------------------------------------------------------ *
 * Runtime guards (values may come from persistence or from a caller)
 * ------------------------------------------------------------------ */

interface ProfileLike {
  readonly level?: unknown;
  readonly domain?: unknown;
  readonly discourseLength?: unknown;
  readonly newLanguageBudget?: unknown;
  readonly grammarComplexity?: unknown;
  readonly supportLevel?: unknown;
  readonly speechStyle?: {
    readonly register?: unknown;
    readonly sentenceShape?: unknown;
    readonly contractionDensity?: unknown;
    readonly lexicalStyle?: unknown;
  };
  readonly evidenceAdjusted?: unknown;
}

function readDifficultyProfile(value: ProfileLike | undefined): DifficultyProfile | null {
  if (!value) return null;
  if (!(value.level === 'unknown' || (typeof value.level === 'string' && isKnownLevel(value.level)))) {
    return null;
  }
  if (!isMember(DISCOURSE_LENGTH_ORDER, value.discourseLength)) return null;
  if (!isMember(GRAMMAR_COMPLEXITY_ORDER, value.grammarComplexity)) return null;
  if (!isMember(SUPPORT_LEVEL_ORDER, value.supportLevel)) return null;
  if (!isNonNegativeInteger(value.newLanguageBudget)) return null;
  const style = value.speechStyle;
  if (!style) return null;
  if (!isMember(TEXT_REGISTERS, style.register)) return null;
  if (!isMember(SENTENCE_SHAPES, style.sentenceShape)) return null;
  if (!isMember(CONTRACTION_DENSITIES, style.contractionDensity)) return null;
  if (!isMember(LEXICAL_STYLES, style.lexicalStyle)) return null;

  return {
    level: value.level as ProgressionLevel,
    discourseLength: value.discourseLength,
    newLanguageBudget: value.newLanguageBudget,
    grammarComplexity: value.grammarComplexity,
    supportLevel: value.supportLevel,
    speechStyle: {
      register: style.register,
      sentenceShape: style.sentenceShape,
      contractionDensity: style.contractionDensity,
      lexicalStyle: style.lexicalStyle,
    },
    evidenceAdjusted: value.evidenceAdjusted === true,
  };
}

/**
 * Validate the request bounds field by field. Bounds are a real constraint:
 * a negative, non-integer, empty or inverted range is REJECTED, never clamped.
 */
export function readDeepListeningBounds(value: unknown): DeepListeningBounds | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const keys: readonly (keyof DeepListeningBounds)[] = [
    'minSpeakers',
    'maxSpeakers',
    'minSegments',
    'maxSegments',
    'maxWordsPerSegment',
    'maxWords',
    'minQuestions',
    'maxQuestions',
    'minOptions',
    'maxOptions',
    'minConnectedSpeechItems',
    'maxConnectedSpeechItems',
    'minShadowingChunkWords',
    'maxShadowingChunkWords',
    'maxKeyItems',
    'maxExplanationLength',
  ];
  const read: Partial<Record<keyof DeepListeningBounds, number>> = {};
  for (const key of keys) {
    const rawValue = raw[key];
    if (!isNonNegativeInteger(rawValue)) return null;
    read[key] = rawValue;
  }
  const b = read as Record<keyof DeepListeningBounds, number>;
  const atLeastOne = [
    b.minSpeakers,
    b.maxSpeakers,
    b.minSegments,
    b.maxSegments,
    b.maxWordsPerSegment,
    b.minQuestions,
    b.maxQuestions,
    b.minConnectedSpeechItems,
    b.maxConnectedSpeechItems,
    b.minShadowingChunkWords,
    b.maxShadowingChunkWords,
    b.maxKeyItems,
    b.maxExplanationLength,
  ];
  if (atLeastOne.some((entry) => entry < 1)) return null;
  if (b.maxSpeakers < b.minSpeakers) return null;
  if (b.maxSegments < b.minSegments) return null;
  if (b.maxQuestions < b.minQuestions) return null;
  if (b.maxWords < b.maxWordsPerSegment) return null;
  if (b.maxWordsPerSegment < 1) return null;
  if (b.maxOptions < b.minOptions) return null;
  if (b.maxConnectedSpeechItems < b.minConnectedSpeechItems) return null;
  if (b.maxShadowingChunkWords < b.minShadowingChunkWords) return null;

  return {
    minSpeakers: b.minSpeakers,
    maxSpeakers: b.maxSpeakers,
    minSegments: b.minSegments,
    maxSegments: b.maxSegments,
    maxWordsPerSegment: b.maxWordsPerSegment,
    maxWords: b.maxWords,
    minQuestions: b.minQuestions,
    maxQuestions: b.maxQuestions,
    minOptions: b.minOptions,
    maxOptions: b.maxOptions,
    minConnectedSpeechItems: b.minConnectedSpeechItems,
    maxConnectedSpeechItems: b.maxConnectedSpeechItems,
    minShadowingChunkWords: b.minShadowingChunkWords,
    maxShadowingChunkWords: b.maxShadowingChunkWords,
    maxKeyItems: b.maxKeyItems,
    maxExplanationLength: b.maxExplanationLength,
  };
}

/* ------------------------------------------------------------------ *
 * Canonical identity
 * ------------------------------------------------------------------ */

/** The canonical identity of a NORMALIZED deep request. */
export function canonicalDeepRequestIdentity(request: {
  readonly taskType: string;
  readonly discourseKind?: string;
  readonly level: string;
  readonly supportLevel: string;
  readonly grammarComplexity: string;
  readonly discourseLength: string;
  readonly newLanguageBudget: number;
  readonly evidenceAdjusted: boolean;
  readonly bounds: DeepListeningBounds;
  readonly questionKinds: readonly string[];
  readonly connectedSpeechCategories: readonly string[];
  readonly shadowingSupport: string;
  readonly knownVocabulary: readonly string[];
  readonly targetExpressions: readonly string[];
  readonly context: DeepListeningContext;
  readonly listeningObjective?: string;
}): string {
  const b = request.bounds;
  return [
    DEEP_REQUEST_KEY_VERSION,
    `task=${request.taskType}`,
    `discourseKind=${request.discourseKind ?? '-'}`,
    `level=${request.level}`,
    `support=${request.supportLevel}`,
    `grammar=${request.grammarComplexity}`,
    `discourse=${request.discourseLength}`,
    `budget=${request.newLanguageBudget}`,
    // Part of the identity: the prompt says something materially different for
    // evidence-adjusted requests, so two such requests must never share a key.
    `evidenceAdjusted=${request.evidenceAdjusted ? 'true' : 'false'}`,
    `bounds=${[
      b.minSpeakers,
      b.maxSpeakers,
      b.minSegments,
      b.maxSegments,
      b.maxWordsPerSegment,
      b.maxWords,
      b.minQuestions,
      b.maxQuestions,
      b.minOptions,
      b.maxOptions,
      b.minConnectedSpeechItems,
      b.maxConnectedSpeechItems,
      b.minShadowingChunkWords,
      b.maxShadowingChunkWords,
      b.maxKeyItems,
      b.maxExplanationLength,
    ].join(',')}`,
    `questions=${request.questionKinds.join(',')}`,
    `connected=${request.connectedSpeechCategories.join(',')}`,
    `shadowingSupport=${request.shadowingSupport}`,
    `known=${request.knownVocabulary.join(',')}`,
    `targets=${request.targetExpressions.join(',')}`,
    `topic=${request.context.topic ?? '-'}`,
    `goals=${request.context.learningGoals.join(',')}`,
    `professional=${request.context.professionalContext ?? '-'}`,
    `objective=${request.listeningObjective ?? '-'}`,
  ].join('|');
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * Build, normalize and validate ONE deep listening request.
 * Invalid input is REJECTED explicitly; nothing is silently coerced.
 */
export function buildDeepListeningRequest(
  input: DeepListeningRequestInput,
): DeepRequestBuildResult {
  const candidateTaskType = input?.taskType as DeepListeningTaskType | undefined;
  if (!isMember(DEEP_LISTENING_TASK_TYPES, candidateTaskType)) {
    return reject(
      'invalid_task_type',
      `Unsupported deep task type: ${String(candidateTaskType)}. WP-2 supports ${DEEP_LISTENING_TASK_TYPES.join(', ')}.`,
    );
  }
  const taskType: DeepListeningTaskType = candidateTaskType;

  const profile = readDifficultyProfile(
    input?.difficultyProfile as unknown as ProfileLike | undefined,
  );
  if (!profile) {
    return reject(
      'invalid_difficulty_profile',
      'The difficulty profile is missing or carries an unambiguously invalid field.',
    );
  }

  const bounds = readDeepListeningBounds(input?.bounds);
  if (!bounds) {
    return reject(
      'invalid_bounds',
      'Deep listening bounds are missing, non-integer, empty or inverted.',
    );
  }

  const isDiscourse = taskType === 'long_discourse' || taskType === 'multi_speaker_dialogue';
  const rawDiscourseKind = input?.discourseKind;
  if (rawDiscourseKind !== undefined && !isMember(DISCOURSE_KINDS, rawDiscourseKind)) {
    return reject('invalid_discourse_kind', `Unknown discourse kind: ${String(rawDiscourseKind)}.`);
  }
  if (!isDiscourse && rawDiscourseKind !== undefined) {
    return reject(
      'invalid_discourse_kind',
      'A discourse kind only belongs to the discourse task types.',
    );
  }

  const questionKindsRaw = input?.questionKinds ?? COMPREHENSION_QUESTION_KINDS;
  if (!Array.isArray(questionKindsRaw) || questionKindsRaw.length === 0) {
    return reject('invalid_question_kind', 'At least one comprehension question kind is required.');
  }
  const questionKinds: ComprehensionQuestionKind[] = [];
  for (const kind of questionKindsRaw) {
    if (!isMember(COMPREHENSION_QUESTION_KINDS, kind)) {
      return reject('invalid_question_kind', `Unknown comprehension question kind: ${String(kind)}.`);
    }
    if (!questionKinds.includes(kind)) questionKinds.push(kind);
  }

  const categoriesRaw = input?.connectedSpeechCategories ?? CONNECTED_SPEECH_CATEGORIES;
  if (!Array.isArray(categoriesRaw) || categoriesRaw.length === 0) {
    return reject(
      'invalid_connected_speech_category',
      'At least one connected-speech category is required.',
    );
  }
  const connectedSpeechCategories: ConnectedSpeechCategory[] = [];
  for (const category of categoriesRaw) {
    if (!isMember(CONNECTED_SPEECH_CATEGORIES, category)) {
      return reject(
        'invalid_connected_speech_category',
        `Unknown connected-speech category: ${String(category)}.`,
      );
    }
    if (!connectedSpeechCategories.includes(category)) connectedSpeechCategories.push(category);
  }

  const shadowingSupport = input?.shadowingSupport ?? 'full_transcript';
  if (!isMember(SHADOWING_SUPPORT_ORDER, shadowingSupport)) {
    return reject(
      'invalid_shadowing_support',
      `Unknown shadowing support level: ${String(shadowingSupport)}.`,
    );
  }

  const learningGoals = normalizeTermList(
    input?.context?.learningGoals,
    CONTENT_REQUEST_BOUNDS.learningGoals,
  );
  const topic = readBoundedText(input?.context?.topic, CONTENT_REQUEST_BOUNDS.topicLength);
  const professionalContext = readBoundedText(
    input?.context?.professionalContext,
    CONTENT_REQUEST_BOUNDS.professionalContextLength,
  );

  // HONESTY: professional context is only honest when the learner's REAL
  // stored goals support professional practice — never inferred, never
  // silently dropped.
  if (professionalContext !== undefined && !hasSupportedProfessionalContext(learningGoals)) {
    return reject(
      'unsupported_professional_context',
      'Professional context was supplied without any supported professional learner goal.',
    );
  }

  const context: DeepListeningContext = {
    ...(topic !== undefined ? { topic } : {}),
    learningGoals,
    ...(professionalContext !== undefined ? { professionalContext } : {}),
  };

  const knownVocabulary = normalizeTermList(
    input?.knownVocabulary,
    CONTENT_REQUEST_BOUNDS.knownVocabulary,
  );
  const targetExpressions = normalizeTermList(
    input?.targetExpressions,
    CONTENT_REQUEST_BOUNDS.targetExpressions,
  );

  const listeningObjective = readBoundedText(
    input?.listeningObjective,
    CONTENT_REQUEST_BOUNDS.objectiveLength,
  );

  const requestKey = stableKey(
    canonicalDeepRequestIdentity({
      taskType,
      ...(isDiscourse && rawDiscourseKind !== undefined ? { discourseKind: rawDiscourseKind } : {}),
      level: profile.level,
      supportLevel: profile.supportLevel,
      grammarComplexity: profile.grammarComplexity,
      discourseLength: profile.discourseLength,
      newLanguageBudget: profile.newLanguageBudget,
      evidenceAdjusted: profile.evidenceAdjusted,
      bounds,
      questionKinds,
      connectedSpeechCategories,
      shadowingSupport,
      knownVocabulary,
      targetExpressions,
      context,
      ...(listeningObjective !== undefined ? { listeningObjective } : {}),
    }),
  );

  return {
    status: 'ok',
    request: {
      requestKey,
      taskType,
      ...(isDiscourse && rawDiscourseKind !== undefined ? { discourseKind: rawDiscourseKind } : {}),
      level: profile.level,
      difficultyProfile: profile,
      supportLevel: profile.supportLevel,
      bounds,
      questionKinds,
      connectedSpeechCategories,
      shadowingSupport,
      knownVocabulary,
      targetExpressions,
      context,
      ...(listeningObjective !== undefined ? { listeningObjective } : {}),
    },
  };
}

/** Sort helper reused by callers that need the same deterministic ordering. */
export const deepCompareStrings = compareStrings;
