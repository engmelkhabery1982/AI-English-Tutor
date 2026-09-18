/**
 * src/listening/deep/validation.ts
 *
 * WP-2 — the STRICT, DETERMINISTIC deep-listening content contract.
 *
 * Every deep activity that arrives from a model is checked against the request
 * it was generated for. Malformed or semantically invalid material is
 * REJECTED and never "repaired": the planner serves its own deterministic
 * material instead.
 *
 * WHAT IS CHECKED
 * - the payload parses and its `requestKey`/`taskType` match the request;
 * - required fields exist and are non-empty (no placeholders, no TODOs);
 * - enums are valid and inside what the request allowed;
 * - every answer is really DERIVABLE from the supplied content (contiguous
 *   normalized occurrence, using the EXISTING evaluator normalization);
 * - where options exist, the correct answer is one of them;
 * - questions never leak their own answer;
 * - speaker references exist, are unambiguous, and `speaker_intention`
 *   answers occur only in the referenced speaker's own segments;
 * - `detail`-style answers occur inside the segments they cite (no phantom
 *   transcript/details);
 * - every `keyItem` really occurs in the content;
 * - connected-speech items keep the CANONICAL WRITTEN FORM as the answer, use
 *   a genuinely different realization, carry no invented phonetic notation and
 *   never claim a reduction belongs to a formal register;
 * - shadowing chunks are non-empty and inside the request's chunk bounds;
 * - length bounds from the request are respected;
 * - no forbidden claim (level band, percentage, score/rating, WPM) and no raw
 *   generation metadata ever reaches learner-facing text;
 * - topic claims stay honest, in both directions.
 *
 * The checks are pure: the same payload always produces the same result.
 */

import { extractJsonObject } from '../../content-generation';
import type { MaterialProvenance } from '../../content-generation';
import { normalizeAnswerText } from '../evaluator';
import type {
  ComprehensionQuestion,
  ConnectedSpeechCategory,
  ConnectedSpeechForm,
  ConnectedSpeechItem,
  DiscourseKind,
  DiscourseSegment,
  DiscourseSpeaker,
  ShadowingSupportLevel,
} from './types';
import {
  COMPREHENSION_QUESTION_KINDS,
  CONNECTED_SPEECH_CATEGORIES,
  CONNECTED_SPEECH_REGISTERS,
  DEEP_LISTENING_TASK_TYPES,
  DISCOURSE_KINDS,
  SHADOWING_SUPPORT_ORDER,
} from './types';
import type { DeepListeningRequest } from './request';

/** Why generated deep material was thrown away. */
export type DeepValidationIssue =
  | 'unparseable_output'
  | 'request_key_mismatch'
  | 'unsupported_task_type'
  | 'invalid_enum'
  | 'missing_text'
  | 'out_of_bounds'
  | 'speaker_structure_invalid'
  | 'unknown_speaker'
  | 'unknown_segment'
  | 'ambiguous_speaker_reference'
  | 'answer_not_derivable'
  | 'answer_not_in_options'
  | 'answer_leakage'
  | 'phantom_detail'
  | 'key_item_not_in_content'
  | 'placeholder_text'
  | 'internal_metadata'
  | 'forbidden_claim'
  | 'context_dishonest'
  | 'invalid_reduction_mapping'
  | 'register_dishonest'
  | 'connected_speech_mismatch'
  | 'empty_shadowing_chunk';

const CONNECTED_SPEECH_FORMS: readonly ConnectedSpeechForm[] = [
  'full_form',
  'contracted_form',
  'reduced_form',
] as const;

/** Categories whose realization is informal by nature — never "formal". */
const INFORMAL_CATEGORIES: readonly ConnectedSpeechCategory[] = [
  'reduction',
  'linking',
  'weak_form',
  'elision',
] as const;

/* ------------------------------------------------------------------ *
 * Text checks
 * ------------------------------------------------------------------ */

/** Text that must never reach a learner (unfilled model scaffolding). */
const PLACEHOLDER_PATTERN = /\b(lorem ipsum|placeholder|todo|tbd|n\/a|xxx+)\b|\[\s*\]|\{\s*\}/i;

/** Raw generation metadata that must never become learner-facing text. */
const METADATA_PATTERN =
  /\b(requestkey|tasktype|segmentid|segments|speakerid|evidencesegmentids|json|llm|gpt|gemini|prompt tokens)\b|\{\s*"|"\s*\}/i;

/** Claims the project never makes: levels, percentages, ratings, WPM. */
const FORBIDDEN_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b[ABC][12]\b/,
  /\d+\s*%/,
  /\b(your|the)\s+(score|rating|grade|band|mastery level)\b/i,
  /\b\d+(\.\d+)?\s*(wpm|words per minute)\b/i,
  /\b(pronunciation|fluency|comprehension)\s+(score|rating)\b/i,
];

/** Invented acoustic notation (IPA or bracketed phonetics) is never allowed. */
const PHONETIC_NOTATION_PATTERN = /[/\[\]ˈˌː]|[əɪʊæθðʃʒŋɒɜʌ]/;

function tokens(text: string): readonly string[] {
  return normalizeAnswerText(text).split(' ').filter(Boolean);
}

/** True when `needle` occurs as a contiguous whole-word sequence in `haystack`. */
export function containsNormalizedSequence(haystack: string, needle: string): boolean {
  const hay = tokens(haystack);
  const want = tokens(needle);
  if (want.length === 0 || want.length > hay.length) return false;
  for (let start = 0; start + want.length <= hay.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < want.length; offset += 1) {
      if (hay[start + offset] !== want[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function normalizedText(text: string): string {
  return normalizeAnswerText(text);
}

/** The first honesty problem in one learner-facing string, or null. */
function checkLearnerText(text: string): DeepValidationIssue | null {
  if (PLACEHOLDER_PATTERN.test(text)) return 'placeholder_text';
  if (METADATA_PATTERN.test(text)) return 'internal_metadata';
  if (FORBIDDEN_CLAIM_PATTERNS.some((pattern) => pattern.test(text))) return 'forbidden_claim';
  return null;
}

/* ------------------------------------------------------------------ *
 * Validated material shapes
 * ------------------------------------------------------------------ */

export interface ValidatedDiscourseMaterial {
  readonly taskType: 'long_discourse' | 'multi_speaker_dialogue';
  readonly discourseKind: DiscourseKind;
  readonly contextTopic?: string;
  readonly explanation?: string;
  readonly speakers: readonly DiscourseSpeaker[];
  readonly segments: readonly DiscourseSegment[];
  readonly questions: readonly ComprehensionQuestion[];
  readonly keyItems: readonly string[];
}

export interface ValidatedConnectedSpeechMaterial {
  readonly taskType: 'connected_speech';
  readonly contextTopic?: string;
  readonly explanation?: string;
  readonly items: readonly ConnectedSpeechItem[];
  readonly keyItems: readonly string[];
}

export interface ValidatedShadowingMaterial {
  readonly taskType: 'shadowing';
  readonly contextTopic?: string;
  readonly explanation?: string;
  readonly chunk: string;
  readonly canonicalWrittenForm: string;
  readonly support: ShadowingSupportLevel;
  readonly keyItems: readonly string[];
}

/** Any fully validated deep material payload. */
export type DeepListeningMaterial =
  | ValidatedDiscourseMaterial
  | ValidatedConnectedSpeechMaterial
  | ValidatedShadowingMaterial;

export type DeepValidationResult =
  | { readonly ok: true; readonly material: DeepListeningMaterial }
  | { readonly ok: false; readonly issue: DeepValidationIssue };

function fail(issue: DeepValidationIssue): DeepValidationResult {
  return { ok: false, issue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMember<T>(order: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (order as readonly string[]).includes(value);
}

/** Read a required non-empty string. */
function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Read an optional non-empty string (absent stays absent). */
function readOptionalText(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return readText(value);
}

/** Read a bounded list of non-empty strings (absent → []). */
function readTextList(value: unknown, max: number): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const entry of value) {
    const text = readText(entry);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

/** The topic check shared by every deep task type (honest both directions). */
function checkContextTopic(
  raw: Record<string, unknown>,
  request: DeepListeningRequest,
): DeepValidationIssue | null {
  const claimed = readOptionalText(raw.contextTopic);
  if (claimed === null) return 'context_dishonest';
  if (claimed === undefined) return null;
  const honesty = checkLearnerText(claimed);
  if (honesty !== null) return honesty;
  const established = request.context.topic;
  if (established === undefined) return 'context_dishonest';
  if (normalizedText(claimed) !== normalizedText(established)) return 'context_dishonest';
  return null;
}

/** The optional explanation check (present ⇒ real content). */
function checkExplanation(
  raw: Record<string, unknown>,
  request: DeepListeningRequest,
): DeepValidationIssue | null {
  const explanation = readOptionalText(raw.explanation);
  if (explanation === null) return 'missing_text';
  if (explanation === undefined) return null;
  if (explanation.length > request.bounds.maxExplanationLength) return 'out_of_bounds';
  return checkLearnerText(explanation);
}

/** Key items: bounded, non-empty and really present in the content. */
function checkKeyItems(
  raw: Record<string, unknown>,
  request: DeepListeningRequest,
  contentText: string,
): DeepValidationIssue | null {
  const keyItems = readTextList(raw.keyItems, request.bounds.maxKeyItems);
  if (keyItems === null || keyItems.length === 0) return 'out_of_bounds';
  for (const item of keyItems) {
    if (item.length > request.bounds.maxExplanationLength) return 'out_of_bounds';
    const honesty = checkLearnerText(item);
    if (honesty !== null) return honesty;
    if (!containsNormalizedSequence(contentText, item)) return 'key_item_not_in_content';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Discourse validation
 * ------------------------------------------------------------------ */

function validateDiscourse(
  raw: Record<string, unknown>,
  request: DeepListeningRequest,
): DeepValidationResult {
  const bounds = request.bounds;
  const isMulti = request.taskType === 'multi_speaker_dialogue';

  const rawKind = raw.discourseKind;
  if (!isMember(DISCOURSE_KINDS, rawKind)) return fail('invalid_enum');
  if (request.discourseKind !== undefined && rawKind !== request.discourseKind) {
    return fail('invalid_enum');
  }

  // ---- speakers ----
  if (!Array.isArray(raw.speakers)) return fail('speaker_structure_invalid');
  if (raw.speakers.length < bounds.minSpeakers || raw.speakers.length > bounds.maxSpeakers) {
    return fail('speaker_structure_invalid');
  }
  const speakers: DiscourseSpeaker[] = [];
  for (const entry of raw.speakers) {
    if (!isRecord(entry)) return fail('speaker_structure_invalid');
    const id = readText(entry.id);
    const label = readText(entry.label);
    if (id === null || label === null) return fail('speaker_structure_invalid');
    if (speakers.some((speaker) => speaker.id === id)) return fail('speaker_structure_invalid');
    const honesty = checkLearnerText(label);
    if (honesty !== null) return fail(honesty);
    speakers.push({ id, label });
  }

  // ---- segments ----
  if (!Array.isArray(raw.segments)) return fail('out_of_bounds');
  if (raw.segments.length < bounds.minSegments || raw.segments.length > bounds.maxSegments) {
    return fail('out_of_bounds');
  }
  const segments: DiscourseSegment[] = [];
  let totalWords = 0;
  for (const entry of raw.segments) {
    if (!isRecord(entry)) return fail('out_of_bounds');
    const id = readText(entry.id);
    const speakerId = readText(entry.speakerId);
    const text = readText(entry.text);
    if (id === null || speakerId === null || text === null) return fail('out_of_bounds');
    if (segments.some((segment) => segment.id === id)) return fail('out_of_bounds');
    if (!speakers.some((speaker) => speaker.id === speakerId)) return fail('unknown_speaker');
    const words = wordCount(text);
    if (words === 0 || words > bounds.maxWordsPerSegment) return fail('out_of_bounds');
    totalWords += words;
    const honesty = checkLearnerText(text);
    if (honesty !== null) return fail(honesty);
    segments.push({ id, speakerId, text });
  }
  if (totalWords > bounds.maxWords) return fail('out_of_bounds');

  // Every declared speaker must really speak: a silent speaker is a phantom.
  for (const speaker of speakers) {
    if (!segments.some((segment) => segment.speakerId === speaker.id)) {
      return fail('speaker_structure_invalid');
    }
  }
  const speakingIds = speakers.filter((speaker) =>
    segments.some((segment) => segment.speakerId === speaker.id),
  );
  if (isMulti ? speakingIds.length < 2 : speakingIds.length < bounds.minSpeakers) {
    return fail('speaker_structure_invalid');
  }

  const passage = segments.map((segment) => segment.text).join(' ');

  // ---- questions ----
  if (!Array.isArray(raw.questions)) return fail('out_of_bounds');
  if (raw.questions.length < bounds.minQuestions || raw.questions.length > bounds.maxQuestions) {
    return fail('out_of_bounds');
  }
  const questions: ComprehensionQuestion[] = [];
  for (const entry of raw.questions) {
    if (!isRecord(entry)) return fail('out_of_bounds');
    const id = readText(entry.id);
    const kind = entry.kind;
    const prompt = readText(entry.prompt);
    const expectedAnswer = readText(entry.expectedAnswer);
    if (id === null || prompt === null || expectedAnswer === null) return fail('missing_text');
    if (!isMember(COMPREHENSION_QUESTION_KINDS, kind)) return fail('invalid_enum');
    if (!request.questionKinds.includes(kind)) return fail('invalid_enum');
    if (questions.some((question) => question.id === id)) return fail('out_of_bounds');

    const promptHonesty = checkLearnerText(prompt);
    if (promptHonesty !== null) return fail(promptHonesty);
    const answerHonesty = checkLearnerText(expectedAnswer);
    if (answerHonesty !== null) return fail(answerHonesty);

    // A question must never contain its own answer.
    if (containsNormalizedSequence(prompt, expectedAnswer)) return fail('answer_leakage');
    // The answer must really be derivable from the discourse.
    if (!containsNormalizedSequence(passage, expectedAnswer)) return fail('answer_not_derivable');

    const options = readTextList(entry.options, bounds.maxOptions);
    if (options === null) return fail('out_of_bounds');
    if (options.length > 0) {
      if (options.length < Math.max(bounds.minOptions, 2)) return fail('out_of_bounds');
      const distinct = new Set(options.map((option) => normalizedText(option)));
      if (distinct.size !== options.length) return fail('out_of_bounds');
      if (!options.some((option) => normalizedText(option) === normalizedText(expectedAnswer))) {
        return fail('answer_not_in_options');
      }
      for (const option of options) {
        const honesty = checkLearnerText(option);
        if (honesty !== null) return fail(honesty);
      }
    }

    const evidenceSegmentIds = readTextList(entry.evidenceSegmentIds, bounds.maxSegments);
    if (evidenceSegmentIds === null || evidenceSegmentIds.length === 0) {
      return fail('unknown_segment');
    }
    for (const segmentId of evidenceSegmentIds) {
      if (!segments.some((segment) => segment.id === segmentId)) return fail('unknown_segment');
    }

    const evidenceText = segments
      .filter((segment) => evidenceSegmentIds.includes(segment.id))
      .map((segment) => segment.text)
      .join(' ');

    const rawSpeakerId = readOptionalText(entry.speakerId);
    if (rawSpeakerId === null) return fail('unknown_speaker');
    let speakerId: string | undefined;
    if (rawSpeakerId !== undefined) {
      if (!speakers.some((speaker) => speaker.id === rawSpeakerId)) return fail('unknown_speaker');
      speakerId = rawSpeakerId;
    }

    if (kind === 'speaker_intention') {
      // Asking WHO meant something requires a real, unambiguous attribution.
      if (speakerId === undefined) return fail('ambiguous_speaker_reference');
      if (!segments.some((segment) => segment.speakerId === speakerId && evidenceSegmentIds.includes(segment.id))) {
        return fail('phantom_detail');
      }
      if (!containsNormalizedSequence(evidenceText, expectedAnswer)) return fail('phantom_detail');
      const spokenByOthers = segments
        .filter((segment) => segment.speakerId !== speakerId)
        .map((segment) => segment.text)
        .join(' ');
      if (containsNormalizedSequence(spokenByOthers, expectedAnswer)) {
        return fail('ambiguous_speaker_reference');
      }
    } else if (kind === 'main_idea') {
      // A main idea may be distributed, so the whole evidence set or the whole
      // passage may carry it — but it must be in the evidence it cites.
      if (
        !containsNormalizedSequence(evidenceText, expectedAnswer) &&
        evidenceSegmentIds.length > 1
      ) {
        return fail('phantom_detail');
      }
    } else if (!containsNormalizedSequence(evidenceText, expectedAnswer)) {
      // detail / sequencing / inference / vocabulary_in_context must be
      // answerable from exactly the segments the question cites.
      return fail('phantom_detail');
    }

    const questionExplanation = readOptionalText(entry.explanation);
    if (questionExplanation === null) return fail('missing_text');
    if (questionExplanation !== undefined) {
      if (questionExplanation.length > bounds.maxExplanationLength) return fail('out_of_bounds');
      const honesty = checkLearnerText(questionExplanation);
      if (honesty !== null) return fail(honesty);
    }

    const acceptableAnswers = readTextList(
      entry.acceptableAnswers,
      bounds.maxOptions,
    );
    if (acceptableAnswers === null) return fail('out_of_bounds');
    for (const alternative of acceptableAnswers) {
      const honesty = checkLearnerText(alternative);
      if (honesty !== null) return fail(honesty);
      if (!containsNormalizedSequence(passage, alternative)) return fail('answer_not_derivable');
    }

    questions.push({
      id,
      kind,
      prompt,
      expectedAnswer,
      ...(acceptableAnswers.length > 0 ? { acceptableAnswers } : {}),
      ...(options.length > 0 ? { options } : {}),
      evidenceSegmentIds,
      ...(speakerId !== undefined ? { speakerId } : {}),
      ...(questionExplanation !== undefined ? { explanation: questionExplanation } : {}),
    });
  }

  const contextTopic = readOptionalText(raw.contextTopic);
  const explanation = readOptionalText(raw.explanation);

  return {
    ok: true,
    material: {
      taskType: request.taskType === 'multi_speaker_dialogue' ? 'multi_speaker_dialogue' : 'long_discourse',
      discourseKind: rawKind,
      ...(contextTopic !== undefined && contextTopic !== null ? { contextTopic } : {}),
      ...(explanation !== undefined && explanation !== null ? { explanation } : {}),
      speakers,
      segments,
      questions,
      keyItems: readTextList(raw.keyItems, bounds.maxKeyItems) ?? [],
    },
  };
}

/* ------------------------------------------------------------------ *
 * Connected-speech validation
 * ------------------------------------------------------------------ */

function validateConnectedSpeech(
  raw: Record<string, unknown>,
  request: DeepListeningRequest,
): DeepValidationResult {
  const bounds = request.bounds;
  if (!Array.isArray(raw.items)) return fail('out_of_bounds');
  if (
    raw.items.length < bounds.minConnectedSpeechItems ||
    raw.items.length > bounds.maxConnectedSpeechItems
  ) {
    return fail('out_of_bounds');
  }

  const items: ConnectedSpeechItem[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry)) return fail('out_of_bounds');
    const id = readText(entry.id);
    const writtenForm = readText(entry.writtenForm);
    const spokenRealization = readText(entry.spokenRealization);
    const prompt = readText(entry.prompt);
    const expectedAnswer = readText(entry.expectedAnswer);
    const explanation = readText(entry.explanation);
    if (
      id === null ||
      writtenForm === null ||
      spokenRealization === null ||
      prompt === null ||
      expectedAnswer === null
    ) {
      return fail('missing_text');
    }
    // The canonical meaning must be explained: the item IS the pair of forms.
    if (explanation === null) return fail('missing_text');

    const category = entry.category;
    if (!isMember(CONNECTED_SPEECH_CATEGORIES, category)) return fail('invalid_enum');
    if (!request.connectedSpeechCategories.includes(category)) return fail('invalid_enum');
    const register = entry.register;
    if (!isMember(CONNECTED_SPEECH_REGISTERS, register)) return fail('invalid_enum');
    const form = entry.form;
    if (!isMember(CONNECTED_SPEECH_FORMS, form)) return fail('invalid_enum');

    // The realization must genuinely differ from the written form, must not
    // use invented acoustic notation, and may not claim natural speech is
    // wrong — the exercise teaches recognition, not a correction.
    if (normalizedText(spokenRealization) === normalizedText(writtenForm)) {
      return fail('invalid_reduction_mapping');
    }
    if (PHONETIC_NOTATION_PATTERN.test(spokenRealization)) {
      return fail('invalid_reduction_mapping');
    }
    // Register honesty: informal realizations are never presented as formal.
    if (register === 'formal' && INFORMAL_CATEGORIES.includes(category)) {
      return fail('register_dishonest');
    }
    // Canonical meaning preserved: the answer IS the standard written form.
    if (normalizedText(expectedAnswer) !== normalizedText(writtenForm)) {
      return fail('connected_speech_mismatch');
    }
    // The prompt must not give the written form away.
    if (normalizedText(prompt).includes(normalizedText(writtenForm))) {
      return fail('answer_leakage');
    }

    const options = readTextList(entry.options, bounds.maxOptions);
    if (options === null) return fail('out_of_bounds');
    if (options.length > 0) {
      if (options.length < Math.max(bounds.minOptions, 2)) return fail('out_of_bounds');
      const distinct = new Set(options.map((option) => normalizedText(option)));
      if (distinct.size !== options.length) return fail('out_of_bounds');
      if (!options.some((option) => normalizedText(option) === normalizedText(writtenForm))) {
        return fail('answer_not_in_options');
      }
    }

    for (const text of [prompt, expectedAnswer, explanation, ...options, writtenForm]) {
      const honesty = checkLearnerText(text);
      if (honesty !== null) return fail(honesty);
    }

    items.push({
      id,
      category,
      writtenForm,
      spokenRealization,
      register,
      form,
      prompt,
      expectedAnswer,
      ...(options.length > 0 ? { options } : {}),
      explanation,
    });
  }

  const contextTopic = readOptionalText(raw.contextTopic);
  const explanation = readOptionalText(raw.explanation);

  return {
    ok: true,
    material: {
      taskType: 'connected_speech',
      ...(contextTopic !== undefined && contextTopic !== null ? { contextTopic } : {}),
      ...(explanation !== undefined && explanation !== null ? { explanation } : {}),
      items,
      keyItems: readTextList(raw.keyItems, bounds.maxKeyItems) ?? [],
    },
  };
}

/* ------------------------------------------------------------------ *
 * Shadowing validation
 * ------------------------------------------------------------------ */

function validateShadowing(
  raw: Record<string, unknown>,
  request: DeepListeningRequest,
): DeepValidationResult {
  const bounds = request.bounds;
  const chunk = readText(raw.chunk);
  const canonicalWrittenForm = readText(raw.canonicalWrittenForm);
  if (chunk === null || canonicalWrittenForm === null) return fail('empty_shadowing_chunk');

  const words = wordCount(chunk);
  if (words < bounds.minShadowingChunkWords || words > bounds.maxShadowingChunkWords) {
    return fail('out_of_bounds');
  }
  if (PHONETIC_NOTATION_PATTERN.test(chunk)) return fail('invalid_reduction_mapping');

  const support = raw.support;
  if (!isMember(SHADOWING_SUPPORT_ORDER, support)) return fail('invalid_enum');
  if (support !== request.shadowingSupport) return fail('invalid_enum');

  for (const text of [chunk, canonicalWrittenForm]) {
    const honesty = checkLearnerText(text);
    if (honesty !== null) return fail(honesty);
  }

  const contextTopic = readOptionalText(raw.contextTopic);
  const explanation = readOptionalText(raw.explanation);

  return {
    ok: true,
    material: {
      taskType: 'shadowing',
      ...(contextTopic !== undefined && contextTopic !== null ? { contextTopic } : {}),
      ...(explanation !== undefined && explanation !== null ? { explanation } : {}),
      chunk,
      canonicalWrittenForm,
      support,
      keyItems: readTextList(raw.keyItems, bounds.maxKeyItems) ?? [],
    },
  };
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/**
 * Validate one PARSED deep payload against its request. Pure and
 * deterministic: identical input always yields an identical result.
 */
export function parseDeepListeningMaterial(
  request: DeepListeningRequest,
  raw: unknown,
): DeepValidationResult {
  if (!isRecord(raw)) return fail('unparseable_output');

  if (raw.requestKey !== request.requestKey) return fail('request_key_mismatch');

  const taskType = raw.taskType;
  if (!isMember(DEEP_LISTENING_TASK_TYPES, taskType)) return fail('unsupported_task_type');
  if (taskType !== request.taskType) return fail('unsupported_task_type');

  const topicIssue = checkContextTopic(raw, request);
  if (topicIssue !== null) return fail(topicIssue);
  const explanationIssue = checkExplanation(raw, request);
  if (explanationIssue !== null) return fail(explanationIssue);

  const result =
    taskType === 'connected_speech'
      ? validateConnectedSpeech(raw, request)
      : taskType === 'shadowing'
        ? validateShadowing(raw, request)
        : validateDiscourse(raw, request);

  if (!result.ok) return result;

  // Key items are checked against the content they are supposed to occur in.
  const contentText = contentTextFor(result.material);
  const keyItemIssue = checkKeyItems(raw, request, contentText);
  if (keyItemIssue !== null) return fail(keyItemIssue);

  return result;
}

/** The text a material's key items must really occur in. */
export function contentTextFor(material: DeepListeningMaterial): string {
  switch (material.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return material.segments.map((segment) => segment.text).join(' ');
    case 'connected_speech':
      return material.items
        .map((item) => `${item.spokenRealization} ${item.writtenForm}`)
        .join(' ');
    case 'shadowing':
      return `${material.chunk} ${material.canonicalWrittenForm}`;
    default:
      return '';
  }
}

/**
 * Validate one RAW model response (a string that should contain JSON) against
 * its request. Malformed output is discarded, never repaired.
 */
export function validateDeepListeningResponse(
  request: DeepListeningRequest,
  responseContent: string,
): DeepValidationResult {
  if (typeof responseContent !== 'string') return fail('unparseable_output');
  const json = extractJsonObject(responseContent);
  if (!json) return fail('unparseable_output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail('unparseable_output');
  }
  return parseDeepListeningMaterial(request, parsed);
}

/**
 * Honest provenance for accepted deep material — computed HERE, never taken
 * from the model's own claim. The semantics are exactly the WP-1 contract's
 * (personalized / mixed / general); only the request type differs, so the
 * shared meaning of the words cannot drift.
 */
export function resolveDeepMaterialProvenance(
  request: DeepListeningRequest,
  material: DeepListeningMaterial,
): MaterialProvenance {
  const spoken = contentTextFor(material);
  const objective = request.listeningObjective;
  const objectiveHonored =
    objective !== undefined ? containsNormalizedSequence(spoken, objective) : false;
  const targets = request.targetExpressions;
  const honoredTargets = targets.filter((target) => containsNormalizedSequence(spoken, target));

  const hasLearnerEvidence =
    targets.length > 0 || objective !== undefined || request.knownVocabulary.length > 0;
  if (!hasLearnerEvidence) return 'general';

  if (targets.length > 0) {
    const allTargetsHonored = honoredTargets.length === targets.length;
    const objectiveSatisfied = objective === undefined || objectiveHonored;
    return allTargetsHonored && objectiveSatisfied ? 'personalized' : 'mixed';
  }
  if (objective !== undefined) return objectiveHonored ? 'personalized' : 'mixed';
  return 'mixed';
}
