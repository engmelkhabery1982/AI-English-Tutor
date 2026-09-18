/**
 * src/content-generation/request.ts
 *
 * WP-1: normalize + validate ONE ContentRequest and give it a deterministic
 * `requestKey`.
 *
 * NORMALIZATION RULES
 * - term/goal arrays are trimmed, whitespace-collapsed, lowercased,
 *   deduplicated and sorted with a locale-independent comparison, so array
 *   order can NEVER change the key;
 * - every list is bounded by CONTENT_REQUEST_BOUNDS (the excess is dropped
 *   deterministically — the owning service also bounds its own reads);
 * - nothing is repaired: anything structurally invalid is REJECTED with an
 *   explicit reason instead of being coerced into a valid-looking request.
 *
 * The key itself reuses the repository's existing stable-key digest (see
 * ../learning-progression/stable-key) so WP-2/WP-3 can add re-serving,
 * repetition and caching on this exact contract.
 */

import { getSkill } from '../curriculum/catalog';
import type { SkillDomain } from '../curriculum/types';
import { CURRICULUM_DOMAINS } from '../curriculum/types';
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
} from '../learning-progression';
import type {
  DifficultyProfile,
  DiscourseLength,
  GrammarComplexity,
  ProgressionLevel,
  SpeechStyle,
  SupportLevel,
} from '../learning-progression/types';
import { mapLearningGoals } from '../professional-english';
import { CONTENT_REQUEST_BOUNDS, CONTENT_TASK_TYPES } from './types';
import type {
  ContentContext,
  ContentRequest,
  ContentRequestBuildResult,
  ContentRequestInput,
  ContentRequestRejection,
  ContentTargetSkill,
  ContentTaskType,
} from './types';

/** The canonical key version — bump only with a deliberate contract change. */
export const CONTENT_REQUEST_KEY_VERSION = 'content-request:v1';

/** Trim + collapse internal whitespace. */
function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Normalize a bounded term list: lowercase, deduplicate, sort.
 * Deterministic and locale-independent (plain code-unit comparison).
 */
export function normalizeTermList(
  values: readonly string[] | undefined,
  limit: number,
): readonly string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const term = collapse(raw).toLowerCase().slice(0, CONTENT_REQUEST_BOUNDS.termLength);
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    normalized.push(term);
  }
  return normalized.sort(compareStrings).slice(0, limit);
}

/** Deterministic, locale-independent string comparison. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Normalize the bounded goal list carried for context honesty only. */
function normalizeGoals(values: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const goal = collapse(raw).slice(0, CONTENT_REQUEST_BOUNDS.topicLength);
    if (goal.length === 0 || seen.has(goal)) continue;
    seen.add(goal);
    normalized.push(goal);
  }
  // Sorted for the same reason as the term lists: array ORDER must never be
  // able to change a request key.
  return normalized.sort(compareStrings).slice(0, CONTENT_REQUEST_BOUNDS.learningGoals);
}

/**
 * True when the learner's REAL stored goals support a professional context.
 * Reuses the EXISTING professional-english goal mapping — a profession is
 * never inferred from anything else.
 */
export function hasSupportedProfessionalContext(
  learningGoals: readonly string[],
): boolean {
  return mapLearningGoals(learningGoals).some((goal) => goal !== 'everyday_fluency');
}

function reject(
  reason: ContentRequestRejection,
  message: string,
): ContentRequestBuildResult {
  return { status: 'rejected', reason, message };
}

/* ------------------------------------------------------------------ *
 * Runtime guards (values come from persistence, not only from the type)
 * ------------------------------------------------------------------ */

/** The runtime shape actually inspected before anything is trusted. */
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

function isMember<T>(order: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (order as readonly string[]).includes(value);
}

function isProgressionLevel(value: unknown): value is ProgressionLevel {
  return value === 'unknown' || (typeof value === 'string' && isKnownLevel(value));
}

function isSkillDomain(value: unknown): value is SkillDomain {
  return isMember(CURRICULUM_DOMAINS, value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validate the difficulty profile and REBUILD it field by field, so the
 * request never carries an unchecked cast of persisted data.
 */
function readProfile(profile: ProfileLike | undefined): DifficultyProfile | null {
  if (!profile) return null;
  if (!isProgressionLevel(profile.level)) return null;
  if (!isMember(DISCOURSE_LENGTH_ORDER, profile.discourseLength)) return null;
  if (!isMember(GRAMMAR_COMPLEXITY_ORDER, profile.grammarComplexity)) return null;
  if (!isMember(SUPPORT_LEVEL_ORDER, profile.supportLevel)) return null;
  if (!isNonNegativeInteger(profile.newLanguageBudget)) return null;
  const style = profile.speechStyle;
  if (!style) return null;
  if (!isMember(TEXT_REGISTERS, style.register)) return null;
  if (!isMember(SENTENCE_SHAPES, style.sentenceShape)) return null;
  if (!isMember(CONTRACTION_DENSITIES, style.contractionDensity)) return null;
  if (!isMember(LEXICAL_STYLES, style.lexicalStyle)) return null;
  if (profile.domain !== undefined && !isSkillDomain(profile.domain)) return null;

  const speechStyle: SpeechStyle = {
    register: style.register,
    sentenceShape: style.sentenceShape,
    contractionDensity: style.contractionDensity,
    lexicalStyle: style.lexicalStyle,
  };

  return {
    level: profile.level,
    ...(profile.domain !== undefined ? { domain: profile.domain } : {}),
    discourseLength: profile.discourseLength as DiscourseLength,
    newLanguageBudget: profile.newLanguageBudget,
    grammarComplexity: profile.grammarComplexity as GrammarComplexity,
    supportLevel: profile.supportLevel as SupportLevel,
    speechStyle,
    evidenceAdjusted: profile.evidenceAdjusted === true,
  };
}

/* ------------------------------------------------------------------ *
 * Canonical identity
 * ------------------------------------------------------------------ */

/**
 * The canonical identity of a NORMALIZED request. Only the request's real
 * content is included, so an identical normalized request always produces an
 * identical key.
 */
export function canonicalContentRequestIdentity(request: {
  readonly level: string;
  readonly taskType: string;
  readonly targetSkill: ContentTargetSkill;
  readonly knownVocabulary: readonly string[];
  readonly targetExpressions: readonly string[];
  readonly newLanguageBudget: number;
  readonly grammarComplexity: string;
  readonly discourseLength: string;
  readonly supportLevel: string;
  readonly speechStyle: SpeechStyle;
  readonly context: ContentContext;
  readonly listeningObjective?: string;
}): string {
  return [
    CONTENT_REQUEST_KEY_VERSION,
    `level=${request.level}`,
    `task=${request.taskType}`,
    `domain=${request.targetSkill.domain}`,
    `skill=${request.targetSkill.skillId ?? '-'}`,
    `known=${request.knownVocabulary.join(',')}`,
    `targets=${request.targetExpressions.join(',')}`,
    `budget=${request.newLanguageBudget}`,
    `grammar=${request.grammarComplexity}`,
    `discourse=${request.discourseLength}`,
    `support=${request.supportLevel}`,
    `register=${request.speechStyle.register}`,
    `shape=${request.speechStyle.sentenceShape}`,
    `contractions=${request.speechStyle.contractionDensity}`,
    `lexical=${request.speechStyle.lexicalStyle}`,
    `topic=${request.context.topic ?? '-'}`,
    `goals=${request.context.learningGoals.join(',')}`,
    `professional=${request.context.professionalContext ?? '-'}`,
    `objective=${request.listeningObjective ?? '-'}`,
  ].join('|');
}

/**
 * Build, normalize and validate ONE content request.
 *
 * Invalid input is REJECTED with an explicit reason: nothing is silently
 * coerced, clamped or repaired.
 */
export function buildContentRequest(input: ContentRequestInput): ContentRequestBuildResult {
  const candidateTaskType = input?.taskType as ContentTaskType | undefined;
  if (!CONTENT_TASK_TYPES.includes(candidateTaskType as ContentTaskType)) {
    return reject(
      'invalid_task_type',
      `Unsupported task type: ${String(candidateTaskType)}. WP-1 generates material only for ${CONTENT_TASK_TYPES.join(', ')}.`,
    );
  }
  const taskType = candidateTaskType as ContentTaskType;

  const profile = readProfile(input?.difficultyProfile as unknown as ProfileLike | undefined);
  if (!profile) {
    return reject(
      'invalid_difficulty_profile',
      'The difficulty profile is missing or carries an unambiguously invalid field.',
    );
  }

  // The budget is a real constraint: a negative, non-integer or oversized
  // budget is rejected rather than clamped.
  if (profile.newLanguageBudget > CONTENT_REQUEST_BOUNDS.newLanguageBudget) {
    return reject(
      'invalid_budget',
      `newLanguageBudget must be an integer between 0 and ${CONTENT_REQUEST_BOUNDS.newLanguageBudget}.`,
    );
  }

  const targetSkill = input?.targetSkill;
  if (!targetSkill || !isSkillDomain(targetSkill.domain)) {
    return reject('invalid_skill', 'targetSkill.domain is not a curriculum domain.');
  }
  if (targetSkill.skillId !== undefined) {
    const node = getSkill(targetSkill.skillId);
    if (!node) {
      return reject(
        'invalid_skill',
        `targetSkill.skillId "${targetSkill.skillId}" is not an existing curriculum skill.`,
      );
    }
    if (node.domain !== targetSkill.domain) {
      return reject(
        'invalid_skill',
        `targetSkill.skillId "${targetSkill.skillId}" belongs to ${node.domain}, not ${targetSkill.domain}.`,
      );
    }
  }

  const learningGoals = normalizeGoals(input.context?.learningGoals);
  const rawProfessional = input.context?.professionalContext;
  const professionalContext =
    typeof rawProfessional === 'string' && collapse(rawProfessional).length > 0
      ? collapse(rawProfessional).slice(0, CONTENT_REQUEST_BOUNDS.professionalContextLength)
      : undefined;

  // HONESTY: professional context is only honest when the learner's REAL
  // stored goals support professional practice. Otherwise it is REJECTED —
  // never dropped silently and never replaced by an invented profession.
  if (professionalContext !== undefined && !hasSupportedProfessionalContext(learningGoals)) {
    return reject(
      'unsupported_professional_context',
      'Professional context was supplied without any supported professional learner goal.',
    );
  }

  const rawTopic = input.context?.topic;
  const topic =
    typeof rawTopic === 'string' && collapse(rawTopic).length > 0
      ? collapse(rawTopic).slice(0, CONTENT_REQUEST_BOUNDS.topicLength)
      : undefined;

  const rawObjective = input.listeningObjective;
  const listeningObjective =
    typeof rawObjective === 'string' && collapse(rawObjective).length > 0
      ? collapse(rawObjective).slice(0, CONTENT_REQUEST_BOUNDS.objectiveLength)
      : undefined;

  const knownVocabulary = normalizeTermList(
    input.knownVocabulary,
    CONTENT_REQUEST_BOUNDS.knownVocabulary,
  );
  const targetExpressions = normalizeTermList(
    input.targetExpressions,
    CONTENT_REQUEST_BOUNDS.targetExpressions,
  );

  const context: ContentContext = {
    ...(topic !== undefined ? { topic } : {}),
    learningGoals,
    ...(professionalContext !== undefined ? { professionalContext } : {}),
  };

  const requestKey = stableKey(
    canonicalContentRequestIdentity({
      level: profile.level,
      taskType,
      targetSkill,
      knownVocabulary,
      targetExpressions,
      newLanguageBudget: profile.newLanguageBudget,
      grammarComplexity: profile.grammarComplexity,
      discourseLength: profile.discourseLength,
      supportLevel: profile.supportLevel,
      speechStyle: profile.speechStyle,
      context,
      ...(listeningObjective !== undefined ? { listeningObjective } : {}),
    }),
  );

  const request: ContentRequest = {
    requestKey,
    level: profile.level,
    difficultyProfile: profile,
    targetSkill,
    knownVocabulary,
    targetExpressions,
    // The scalar difficulty fields are COPIED from the profile, so the
    // request can never disagree with it.
    newLanguageBudget: profile.newLanguageBudget,
    grammarComplexity: profile.grammarComplexity,
    discourseLength: profile.discourseLength,
    supportLevel: profile.supportLevel,
    speechStyle: profile.speechStyle,
    taskType,
    context,
    ...(listeningObjective !== undefined ? { listeningObjective } : {}),
  };

  return { status: 'ok', request };
}
