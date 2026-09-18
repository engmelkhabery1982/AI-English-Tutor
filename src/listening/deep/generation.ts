/**
 * src/listening/deep/generation.ts
 *
 * WP-2 — controlled generation of ONE deep listening activity.
 *
 * VALIDATED deep request → EXISTING AIProvider → STRICTLY VALIDATED material.
 *
 * Never throws, never repairs: an unavailable provider, a timeout, invalid
 * JSON, invalid enums or semantically invalid material all produce an honest
 * outcome with `activity: null`, and the caller immediately serves its own
 * deterministic deep material instead.
 *
 * It reuses the EXISTING AIProvider abstraction (no new SDK, no second Gemini
 * client) and the EXISTING text normalization; it persists nothing, schedules
 * nothing, selects nothing and touches no learner evidence.
 */

import { generateId } from '../../shared/id';
import type { AIProvider } from '../../providers/ai/types';
import { listeningDifficultyFor } from '../ai-material';
import type { ListeningDifficulty } from '../types';
import type { DeepListeningRequest } from './request';
import { buildDeepMaterialPrompt } from './prompt';
import {
  resolveDeepMaterialProvenance,
  validateDeepListeningResponse,
} from './validation';
import type { DeepListeningMaterial, DeepValidationIssue } from './validation';
import type {
  ComprehensionQuestion,
  ConnectedSpeechItem,
  DeepListeningActivity,
  DeepListeningSource,
  DeepMaterialOrigin,
  DeepMaterialProvenance,
  DiscourseSegment,
  DiscourseSpeaker,
  ShadowingSupportLevel,
} from './types';

/** Every failure the deep layer can report for generated material. */
export type DeepGenerationFailure =
  | 'no_provider'
  | 'provider_error'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'invalid_output';

/** Outcome of trying to serve ONE generated deep activity. */
export interface DeepGenerationOutcome {
  /** The activity to serve, or null when the caller must fall back. */
  readonly activity: DeepListeningActivity | null;
  /** Honest provenance of the SERVED material, or null when nothing was served. */
  readonly provenance: DeepMaterialProvenance | null;
  readonly requestKey: string;
  readonly failure: DeepGenerationFailure | null;
  /** The validation issue when generation was rejected as invalid, else null. */
  readonly validationIssue: DeepValidationIssue | null;
  /** Bounded diagnostic for logs/tests (never shown as a score). */
  readonly detail: string | null;
}

export interface DeepGenerationInput {
  readonly learnerId: string;
  readonly request: DeepListeningRequest;
}

function failure(
  reason: DeepGenerationFailure,
  detail: string,
  requestKey: string,
  validationIssue: DeepValidationIssue | null = null,
): DeepGenerationOutcome {
  return {
    activity: null,
    provenance: null,
    requestKey,
    failure: reason,
    validationIssue,
    detail,
  };
}

/* ------------------------------------------------------------------ *
 * Material → activity
 * ------------------------------------------------------------------ */

export interface MaterialToActivityInput {
  readonly learnerId: string;
  readonly request: DeepListeningRequest;
  readonly source: DeepListeningSource;
  readonly materialOrigin: DeepMaterialOrigin;
  readonly provenance: DeepMaterialProvenance;
  readonly difficulty?: ListeningDifficulty;
}

/**
 * Convert validated material into the activity the engine serves. Ids are
 * assigned HERE (the model never invents them) and the topic label falls back
 * to the request's own topic, never to an invented one.
 */
export function materialToActivity(
  material: DeepListeningMaterial,
  input: MaterialToActivityInput,
): DeepListeningActivity {
  const difficulty = input.difficulty ?? listeningDifficultyFor(input.request.difficultyProfile);
  const base = {
    id: generateId(),
    learnerId: input.learnerId,
    difficulty,
    source: input.source,
    contentProvenance: input.provenance,
    materialOrigin: input.materialOrigin,
    requestKey: input.request.requestKey,
    ...(material.contextTopic !== undefined
      ? { contextTopic: material.contextTopic }
      : input.request.context.topic !== undefined
        ? { contextTopic: input.request.context.topic }
        : {}),
    ...(material.explanation !== undefined ? { explanation: material.explanation } : {}),
    keyItems: material.keyItems,
  };

  switch (material.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return {
        ...base,
        taskType: material.taskType,
        discourseKind: material.discourseKind,
        supportLevel: input.request.supportLevel,
        speakers: material.speakers,
        segments: material.segments,
        questions: material.questions,
      };
    case 'connected_speech':
      return { ...base, taskType: 'connected_speech', items: material.items };
    case 'shadowing':
      return {
        ...base,
        taskType: 'shadowing',
        chunk: material.chunk,
        canonicalWrittenForm: material.canonicalWrittenForm,
        support: material.support,
        maxRepeats: 3,
      };
    default:
      // Unreachable: the union is exhaustive. Kept explicit so a future member
      // cannot silently disappear into a wrong branch.
      throw new Error('Unsupported deep material');
  }
}

/**
 * The raw JSON-shaped payload of an activity — the same shape the validator
 * accepts. Used to prove that the DETERMINISTIC material satisfies exactly the
 * same strict contract as generated material.
 */
export function activityToRawMaterial(
  activity: DeepListeningActivity,
): Record<string, unknown> {
  const common: Record<string, unknown> = {
    requestKey: activity.requestKey,
    taskType: activity.taskType,
    ...(activity.contextTopic !== undefined ? { contextTopic: activity.contextTopic } : {}),
    ...(activity.explanation !== undefined ? { explanation: activity.explanation } : {}),
    keyItems: [...activity.keyItems],
  };
  switch (activity.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return {
        ...common,
        discourseKind: activity.discourseKind,
        speakers: activity.speakers.map((speaker: DiscourseSpeaker) => ({ ...speaker })),
        segments: activity.segments.map((segment: DiscourseSegment) => ({ ...segment })),
        questions: activity.questions.map((question: ComprehensionQuestion) => ({
          id: question.id,
          kind: question.kind,
          prompt: question.prompt,
          expectedAnswer: question.expectedAnswer,
          ...(question.acceptableAnswers !== undefined
            ? { acceptableAnswers: [...question.acceptableAnswers] }
            : {}),
          ...(question.options !== undefined ? { options: [...question.options] } : {}),
          evidenceSegmentIds: [...question.evidenceSegmentIds],
          ...(question.speakerId !== undefined ? { speakerId: question.speakerId } : {}),
          ...(question.explanation !== undefined ? { explanation: question.explanation } : {}),
        })),
      };
    case 'connected_speech':
      return {
        ...common,
        items: activity.items.map((item: ConnectedSpeechItem) => ({
          id: item.id,
          category: item.category,
          writtenForm: item.writtenForm,
          spokenRealization: item.spokenRealization,
          register: item.register,
          form: item.form,
          prompt: item.prompt,
          expectedAnswer: item.expectedAnswer,
          ...(item.options !== undefined ? { options: [...item.options] } : {}),
          explanation: item.explanation,
        })),
      };
    case 'shadowing':
      return {
        ...common,
        chunk: activity.chunk,
        canonicalWrittenForm: activity.canonicalWrittenForm,
        support: activity.support as ShadowingSupportLevel,
      };
    default:
      return common;
  }
}

/* ------------------------------------------------------------------ *
 * Generation
 * ------------------------------------------------------------------ */

/**
 * Try to serve ONE generated deep activity. Never throws.
 */
export async function generateDeepListeningActivity(
  provider: AIProvider | null | undefined,
  input: DeepGenerationInput,
): Promise<DeepGenerationOutcome> {
  const { request } = input;
  if (!provider) {
    return failure(
      'no_provider',
      'No content provider is available, so nothing was generated.',
      request.requestKey,
    );
  }

  let result;
  try {
    result = await provider.generate(buildDeepMaterialPrompt(request));
  } catch {
    return failure(
      'provider_error',
      'The content provider failed while generating deep listening material.',
      request.requestKey,
    );
  }

  if (!result.ok) {
    const code = result.error?.code;
    if (code === 'timeout') {
      return failure(
        'provider_timeout',
        'The content provider timed out; deterministic material is used instead.',
        request.requestKey,
      );
    }
    if (code === 'unavailable') {
      return failure(
        'provider_unavailable',
        'The content provider is unavailable right now.',
        request.requestKey,
      );
    }
    return failure(
      'provider_error',
      `The content provider returned an error (${String(code ?? 'unknown')}).`,
      request.requestKey,
    );
  }

  const content = result.response?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return failure('invalid_output', 'The provider returned no content.', request.requestKey);
  }

  const validation = validateDeepListeningResponse(request, content);
  if (!validation.ok) {
    // Invalid material is DISCARDED — never repaired, never trusted.
    return failure(
      'invalid_output',
      `Generated deep listening material was rejected (${validation.issue}).`,
      request.requestKey,
      validation.issue,
    );
  }

  const provenance = resolveDeepMaterialProvenance(request, validation.material);
  const activity = materialToActivity(validation.material, {
    learnerId: input.learnerId,
    request,
    // The material is not tied to one stored weakness or lexical item, so the
    // source label stays honest; personalization is carried by `provenance`.
    source: 'general',
    materialOrigin: 'ai',
    provenance,
  });

  return {
    activity,
    provenance,
    requestKey: request.requestKey,
    failure: null,
    validationIssue: null,
    detail: null,
  };
}
