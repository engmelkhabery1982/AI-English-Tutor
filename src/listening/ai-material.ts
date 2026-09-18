/**
 * src/listening/ai-material.ts
 *
 * WP-1: how the LISTENING ENGINE serves AI-generated material.
 *
 * The listening engine REMAINS the owner of:
 * - which exercise slot the material fills,
 * - the listening objective it targets,
 * - the internal consistency rules below,
 * - the deterministic fallback it serves when generation cannot be trusted.
 *
 * The content transformer owns request normalization, structural validation
 * and provenance; this module owns the LISTENING text rules, expressed with
 * the SAME normalization the EXISTING evaluator uses (`normalizeAnswerText`)
 * so there are never two subtly different sets of listening text rules.
 *
 * WP-1 LIMIT: AI material is allowed ONLY for `listen_and_type`,
 * `missing_word` and `listen_and_answer`. `listen_and_choose` and
 * `expression_in_context` stay on their existing deterministic saved-meaning
 * builders, and NO AI distractors are produced.
 */

import type { SkillDomain } from '../curriculum/types';
import {
  DISCOURSE_LENGTH_ORDER,
  resolveDifficultyProfile,
  toProgressionEvidence,
} from '../learning-progression';
import type {
  DifficultyProfile,
  LearnerProgressionEvidence,
  ProgressionLevel,
} from '../learning-progression/types';
import {
  buildContentRequest,
  generateControlledMaterial,
} from '../content-generation';
import type {
  ContentGenerationFailure,
  ContentTargetSkill,
  ContentTaskType,
  GeneratedMaterial,
  MaterialProvenance,
} from '../content-generation';
import type { AIProvider } from '../providers/ai/types';
import { generateId } from '../shared/id';
import { normalizeAnswerText } from './evaluator';
import type {
  ListeningDifficulty,
  ListeningExercise,
  ListeningExerciseSource,
} from './types';

/** Every failure the listening layer can report for generated material. */
export type ListeningMaterialFailure =
  | ContentGenerationFailure
  | 'invalid_target'
  | 'inconsistent_material';

/** Outcome of trying to serve one generated listening exercise. */
export interface ListeningGeneratedOutcome {
  /** The exercise to serve, or null when the caller must fall back. */
  readonly exercise: ListeningExercise | null;
  /** Honest provenance of the SERVED material, or null when nothing was served. */
  readonly provenance: MaterialProvenance | null;
  readonly requestKey: string | null;
  readonly failure: ListeningMaterialFailure | null;
  /** Bounded diagnostic for logs/tests (never shown as a score). */
  readonly detail: string | null;
}

/** Input assembled by the OWNING listening engine (it already loaded these). */
export interface ListeningGeneratedInput {
  readonly learnerId: string;
  /** The stored working level (from the existing profile, never inferred). */
  readonly level: ProgressionLevel;
  /** Already-loaded learner evidence (the rows the planner just read). */
  readonly evidence?: LearnerProgressionEvidence | null;
  readonly domain?: SkillDomain;
  readonly knownVocabulary: readonly string[];
  readonly targetExpressions: readonly string[];
  readonly listeningObjective?: string;
  readonly topic?: string;
  readonly learningGoals?: readonly string[];
  readonly professionalContext?: string;
  readonly targetSkill?: ContentTargetSkill;
  readonly taskType: ContentTaskType;
}

/* ------------------------------------------------------------------ *
 * Deterministic mapping helpers (listening-owned)
 * ------------------------------------------------------------------ */

/**
 * The listening difficulty band implied by a difficulty profile. Derived from
 * the profile's qualitative bands only — never from a numeric score.
 */
export function listeningDifficultyFor(profile: DifficultyProfile): ListeningDifficulty {
  const index = DISCOURSE_LENGTH_ORDER.indexOf(profile.discourseLength);
  if (profile.grammarComplexity === 'advanced' || index >= 2) return 'hard';
  if (profile.grammarComplexity === 'intermediate' || index >= 1) return 'medium';
  return 'easy';
}

/**
 * Honest provenance of DETERMINISTIC material, derived from the listening
 * engine's own existing source label. Used when generated material is
 * discarded and the deterministic exercise is served instead.
 */
export function deterministicProvenanceForSource(
  source: ListeningExerciseSource,
): MaterialProvenance {
  switch (source) {
    case 'listening_weakness':
    case 'due_vocabulary':
    case 'due_expression':
      return 'personalized';
    case 'general':
    default:
      return 'general';
  }
}

/** Token sequence under the EXISTING evaluator normalization. */
function tokens(text: string): readonly string[] {
  return normalizeAnswerText(text).split(' ').filter(Boolean);
}

/** True when `needle` occurs as a contiguous whole-word sequence in `haystack`. */
function containsSequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Listening internal consistency
 * ------------------------------------------------------------------ */

/**
 * Verify that a validated material payload is internally consistent as a
 * LISTENING exercise BEFORE it is served.
 *
 * - `listen_and_type`: normalized expectedAnswer must match normalized
 *   speakText exactly.
 * - `missing_word`: expectedAnswer must occur in speakText as the intended
 *   whole-word occurrence, and gappedText must be that same passage with
 *   exactly that occurrence replaced by the existing `___` gap.
 * - every `keyItem` must really occur in the spoken material, judged with the
 *   same normalization the evaluator uses.
 * - `question`, where present, must not reveal the expected answer.
 *
 * Returns null when consistent, otherwise the failing issue.
 */
export function validateListeningMaterialConsistency(
  material: GeneratedMaterial,
): 'missing_text' | 'internal_inconsistency' | null {
  const spoken = tokens(material.speakText);
  const expected = tokens(material.expectedAnswer);
  if (spoken.length === 0 || expected.length === 0) return 'missing_text';

  // Every key item must really occur in the spoken material.
  for (const keyItem of material.keyItems) {
    const keyTokens = tokens(keyItem);
    if (keyTokens.length === 0) return 'internal_inconsistency';
    if (!containsSequence(spoken, keyTokens)) return 'internal_inconsistency';
  }

  // A question must never reveal the expected answer.
  if (material.question !== undefined) {
    const question = tokens(material.question);
    if (question.length === 0) return 'missing_text';
    if (containsSequence(question, expected)) return 'internal_inconsistency';
  }

  switch (material.taskType) {
    case 'listen_and_type': {
      if (normalizeAnswerText(material.speakText) !== normalizeAnswerText(material.expectedAnswer)) {
        return 'internal_inconsistency';
      }
      return null;
    }
    case 'missing_word': {
      if (material.gappedText === undefined) return 'internal_inconsistency';
      if (!containsSequence(spoken, expected)) return 'internal_inconsistency';
      // The gapped text must be the SAME passage with exactly one occurrence
      // of the answer replaced by the existing standard gap.
      const gapped = tokens(material.gappedText);
      const gapPattern = ['___'];
      let rebuilt = false;
      for (let start = 0; start + expected.length <= spoken.length; start += 1) {
        if (!containsSequence(spoken.slice(start, start + expected.length), expected)) continue;
        const candidate = [
          ...spoken.slice(0, start),
          ...gapPattern,
          ...spoken.slice(start + expected.length),
        ];
        if (
          candidate.length === gapped.length &&
          candidate.every((token, index) => token === gapped[index])
        ) {
          rebuilt = true;
          break;
        }
      }
      return rebuilt ? null : 'internal_inconsistency';
    }
    case 'listen_and_answer': {
      if (material.question === undefined) return 'internal_inconsistency';
      // The expected answer must at least be supported by the passage.
      if (!containsSequence(spoken, expected)) return 'internal_inconsistency';
      return null;
    }
    default:
      return 'internal_inconsistency';
  }
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

function failure(
  reason: ListeningMaterialFailure,
  detail: string,
  requestKey: string | null,
): ListeningGeneratedOutcome {
  return { exercise: null, provenance: null, requestKey, failure: reason, detail };
}

/**
 * Try to serve ONE generated listening exercise.
 *
 * Never throws: every failure (no provider, timeout, invalid JSON, invalid
 * material, internally inconsistent material, unsupported target) produces an
 * honest outcome with `exercise: null`, so the caller immediately falls back
 * to its existing deterministic material.
 */
export async function generateListeningExercise(
  provider: AIProvider | null | undefined,
  input: ListeningGeneratedInput,
): Promise<ListeningGeneratedOutcome> {
  const profile = resolveDifficultyProfile(
    input.level,
    input.evidence ?? null,
    input.domain ?? 'listening',
  );

  const built = buildContentRequest({
    difficultyProfile: profile,
    targetSkill: input.targetSkill ?? { domain: input.domain ?? 'listening' },
    knownVocabulary: input.knownVocabulary,
    targetExpressions: input.targetExpressions,
    taskType: input.taskType,
    context: {
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      ...(input.learningGoals !== undefined ? { learningGoals: input.learningGoals } : {}),
      ...(input.professionalContext !== undefined
        ? { professionalContext: input.professionalContext }
        : {}),
    },
    ...(input.listeningObjective !== undefined
      ? { listeningObjective: input.listeningObjective }
      : {}),
  });

  if (built.status === 'rejected') {
    // An invalid request is never sent anywhere: fall back immediately.
    return failure('invalid_target', `${built.reason}: ${built.message}`, null);
  }
  const request = built.request;

  const generated = await generateControlledMaterial(provider, request);
  if (generated.status !== 'generated') {
    return failure(generated.reason, generated.detail, generated.requestKey);
  }

  const inconsistency = validateListeningMaterialConsistency(generated.material);
  if (inconsistency !== null) {
    // Discard the item. No failure evidence is persisted from it, and the
    // caller serves its existing deterministic material for this slot.
    return failure(
      'inconsistent_material',
      `Generated listening material failed internal consistency (${inconsistency}).`,
      generated.requestKey,
    );
  }

  const material = generated.material;
  const exercise: ListeningExercise = {
    id: generateId(),
    learnerId: input.learnerId,
    type: request.taskType,
    difficulty: listeningDifficultyFor(profile),
    speakText: material.speakText,
    ...(material.question !== undefined ? { question: material.question } : {}),
    ...(material.gappedText !== undefined ? { gappedText: material.gappedText } : {}),
    expectedAnswer: material.expectedAnswer,
    keyItems: material.keyItems,
    // The material is not tied to one stored weakness or lexical item, so the
    // existing source label stays honest: personalization is carried by
    // `contentProvenance` below.
    source: 'general',
    contextTopic: material.contextTopic ?? request.context.topic ?? 'generated practice',
    ...(material.explanation !== undefined ? { explanation: material.explanation } : {}),
    contentProvenance: generated.provenance,
    materialOrigin: 'ai',
    requestKey: request.requestKey,
  };

  return {
    exercise,
    provenance: generated.provenance,
    requestKey: request.requestKey,
    failure: null,
    detail: null,
  };
}

/** Build the resolver evidence from the EXISTING weaknesses the engine loaded. */
export function listeningEvidenceFromWeaknesses(
  rows: readonly {
    readonly type: string;
    readonly status: string;
    readonly resolved: boolean;
  }[],
): LearnerProgressionEvidence {
  return toProgressionEvidence(rows);
}
