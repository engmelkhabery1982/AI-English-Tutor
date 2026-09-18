/**
 * src/content-generation/validation.ts
 *
 * WP-1: STRICT validation of raw model output.
 *
 * Malformed output is REJECTED, and invalid generated material is DISCARDED.
 * Semantically invalid learning material is never silently "repaired" and then
 * treated as trustworthy — the caller falls back to its own deterministic
 * material instead.
 *
 * VALIDATION COVERAGE
 * - required text is non-empty,
 * - enum values are valid (task type, provenance),
 * - the requested skill/domain is honored (a material may not claim another),
 * - the new-language budget is non-negative and within the request,
 * - its vocabulary (key items + passage size) is bounded,
 * - its target expressions are bounded AND really requested,
 * - the requestKey matches exactly,
 * - only allowed task types are produced, and the payload matches the task,
 * - context claims are honest (no invented topic, no level/score claims),
 * - provenance claims are honest (never more personalized than the request
 *   supports).
 *
 * Listening-specific TEXT consistency (expectedAnswer/speakText agreement,
 * gapped text, key items occurring in the passage, question revealing the
 * answer) belongs to the listening engine, which owns the EXISTING text
 * normalization used by its evaluator. It is deliberately NOT re-implemented
 * here.
 */

import { getSkill } from '../curriculum/catalog';
import { CONTENT_REQUEST_BOUNDS, CONTENT_TASK_TYPES } from './types';
import type {
  ContentRequest,
  ContentTaskType,
  GeneratedMaterial,
  GenerationValidationIssue,
  GenerationValidationResult,
  MaterialProvenance,
} from './types';

const PROVENANCE_ORDER: Readonly<Record<MaterialProvenance, number>> = {
  general: 0,
  mixed: 1,
  personalized: 2,
};

/** Claim patterns that must never appear in generated learning material. */
const FORBIDDEN_CLAIM_PATTERNS: readonly RegExp[] = [
  // A level band claim.
  /\b[ABC][12]\b/,
  // A percentage claim.
  /\d+\s*%/,
  // A score/rating claim about the learner.
  /\b(your|the)\s+(score|rating|grade|band)\b/i,
];

function normalizeForContainment(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Prompt-honoring containment check (NOT answer evaluation). */
function mentionsText(haystack: string, needle: string): boolean {
  const target = normalizeForContainment(needle);
  if (target.length === 0) return false;
  return normalizeForContainment(haystack).includes(target);
}

/**
 * Honest provenance for accepted material — computed HERE, never taken from
 * the model's own claim.
 *
 * PERSONALIZED: real learner evidence materially shaped the material and the
 *               requested target(s) were honored.
 * MIXED:        real evidence shaped part of the request/material, or the
 *               requested target could not be fully honored.
 * GENERAL:      no material learner evidence was used.
 */
export function resolveMaterialProvenance(
  request: ContentRequest,
  speakText: string,
): MaterialProvenance {
  const objective = request.listeningObjective;
  const objectiveHonored = objective !== undefined ? mentionsText(speakText, objective) : false;
  const targets = request.targetExpressions;
  const honoredTargets = targets.filter((target) => mentionsText(speakText, target));

  // No learner evidence whatsoever: the material is honestly general. A
  // learner merely HAVING a profile or a level is not personalization.
  const hasLearnerEvidence =
    targets.length > 0 || objective !== undefined || request.knownVocabulary.length > 0;
  if (!hasLearnerEvidence) return 'general';

  if (targets.length > 0) {
    const allTargetsHonored = honoredTargets.length === targets.length;
    const objectiveSatisfied = objective === undefined || objectiveHonored;
    return allTargetsHonored && objectiveSatisfied ? 'personalized' : 'mixed';
  }

  if (objective !== undefined) return objectiveHonored ? 'personalized' : 'mixed';

  // Only the bounded known-vocabulary context could have shaped this request:
  // real evidence shaped part of it, but the target itself was never targeted.
  return 'mixed';
}

/** The first JSON object in a model response, when there is one. */
export function extractJsonObject(content: string): string | null {
  const match = /\{[\s\S]*\}/.exec(content ?? '');
  return match ? match[0] : null;
}

function fail(issue: GenerationValidationIssue): GenerationValidationResult {
  return { ok: false, issue };
}

function readOptionalString(
  raw: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null; // malformed
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null; // present but empty = malformed
}

function containsForbiddenClaim(values: readonly string[]): boolean {
  return values.some((value) => FORBIDDEN_CLAIM_PATTERNS.some((pattern) => pattern.test(value)));
}

/**
 * Validate ONE raw model response against its request.
 *
 * Reads the response text, extracts the JSON object, and validates every
 * required field. Returns the FIRST failing issue — material is either fully
 * valid or discarded.
 */
export function validateGeneratedMaterial(
  request: ContentRequest,
  responseContent: string,
): GenerationValidationResult {
  const json = extractJsonObject(responseContent);
  if (!json) return fail('unparseable_output');

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fail('unparseable_output');
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return fail('unparseable_output');
  }

  // ---- requestKey must match exactly -------------------------------------
  if (raw.requestKey !== request.requestKey) return fail('request_key_mismatch');

  // ---- only the allowed task types, and only the REQUESTED one -----------
  const taskType = raw.taskType;
  if (typeof taskType !== 'string' || !CONTENT_TASK_TYPES.includes(taskType as ContentTaskType)) {
    return fail('unsupported_task_type');
  }
  if (taskType !== request.taskType) return fail('unsupported_task_type');

  // ---- the requested skill may be echoed, never replaced -----------------
  if (raw.skillId !== undefined && raw.skillId !== null) {
    if (typeof raw.skillId !== 'string') return fail('invalid_skill');
    if (raw.skillId !== request.targetSkill.skillId) return fail('invalid_skill');
    if (!getSkill(raw.skillId)) return fail('invalid_skill');
  }

  // ---- required text is non-empty ---------------------------------------
  const speakText = readOptionalString(raw, 'speakText');
  if (!speakText) return fail('missing_text');
  const expectedAnswer = readOptionalString(raw, 'expectedAnswer');
  if (!expectedAnswer) return fail('missing_text');

  // ---- task-shaped payload ----------------------------------------------
  const question = readOptionalString(raw, 'question');
  const gappedText = readOptionalString(raw, 'gappedText');
  if (question === null || gappedText === null) return fail('missing_text');
  if (request.taskType === 'listen_and_answer') {
    if (question === undefined) return fail('missing_text');
    if (gappedText !== undefined) return fail('unexpected_field');
  } else if (request.taskType === 'missing_word') {
    if (gappedText === undefined) return fail('missing_text');
  } else if (gappedText !== undefined) {
    // listen_and_type: a gap does not belong to this task.
    return fail('unexpected_field');
  }

  // ---- bounded vocabulary (key items + passage size) ---------------------
  const keyItemsRaw = raw.keyItems;
  if (!Array.isArray(keyItemsRaw) || keyItemsRaw.length === 0) {
    return fail('vocabulary_out_of_bounds');
  }
  if (keyItemsRaw.length > CONTENT_REQUEST_BOUNDS.keyItems) {
    return fail('vocabulary_out_of_bounds');
  }
  const keyItems: string[] = [];
  for (const item of keyItemsRaw) {
    if (typeof item !== 'string') return fail('vocabulary_out_of_bounds');
    const trimmed = item.trim();
    if (trimmed.length === 0 || trimmed.length > CONTENT_REQUEST_BOUNDS.termLength) {
      return fail('vocabulary_out_of_bounds');
    }
    keyItems.push(trimmed);
  }
  const speakWords = speakText.split(/\s+/).filter(Boolean).length;
  if (speakWords === 0 || speakWords > CONTENT_REQUEST_BOUNDS.speakTextWords) {
    return fail('vocabulary_out_of_bounds');
  }
  const sentences = speakText.split(/[.!?]+/).filter((part) => part.trim().length > 0).length;
  if (sentences > CONTENT_REQUEST_BOUNDS.speakTextSentences) {
    return fail('vocabulary_out_of_bounds');
  }

  // ---- bounded expressions (and they must have been REQUESTED) ----------
  const targetsRaw = raw.targetExpressionsUsed;
  let targetExpressionsUsed: readonly string[] = [];
  if (targetsRaw !== undefined && targetsRaw !== null) {
    if (!Array.isArray(targetsRaw)) return fail('expressions_out_of_bounds');
    if (targetsRaw.length > CONTENT_REQUEST_BOUNDS.targetExpressions) {
      return fail('expressions_out_of_bounds');
    }
    const requested = request.targetExpressions;
    const used: string[] = [];
    for (const entry of targetsRaw) {
      if (typeof entry !== 'string') return fail('expressions_out_of_bounds');
      const trimmed = entry.trim();
      if (trimmed.length === 0) return fail('expressions_out_of_bounds');
      if (!requested.includes(trimmed.toLowerCase())) {
        // Claiming an expression the request never asked for is dishonesty.
        return fail('expressions_out_of_bounds');
      }
      used.push(trimmed.toLowerCase());
    }
    targetExpressionsUsed = used;
  }

  // ---- non-negative budget, within the request ---------------------------
  const budgetRaw = raw.newLanguageItems;
  let newLanguageItems = 0;
  if (budgetRaw !== undefined && budgetRaw !== null) {
    if (
      typeof budgetRaw !== 'number' ||
      !Number.isInteger(budgetRaw) ||
      budgetRaw < 0 ||
      budgetRaw > request.newLanguageBudget
    ) {
      return fail('budget_out_of_bounds');
    }
    newLanguageItems = budgetRaw;
  }

  // ---- context honesty ---------------------------------------------------
  const contextTopic = readOptionalString(raw, 'contextTopic');
  if (contextTopic === null) return fail('context_dishonest');
  if (contextTopic !== undefined && request.context.topic !== undefined) {
    if (normalizeForContainment(contextTopic) !== normalizeForContainment(request.context.topic)) {
      // The material may not invent a topic the request did not establish.
      return fail('context_dishonest');
    }
  }
  const explanation = readOptionalString(raw, 'explanation');
  if (explanation === null) return fail('context_dishonest');
  if (
    explanation !== undefined &&
    explanation.length > CONTENT_REQUEST_BOUNDS.explanationLength
  ) {
    return fail('context_dishonest');
  }
  if (
    containsForbiddenClaim([speakText, question ?? '', gappedText ?? '', explanation ?? ''])
  ) {
    // No level band, percentage or score/rating claim may reach a learner.
    return fail('context_dishonest');
  }

  // ---- provenance honesty ------------------------------------------------
  const material: GeneratedMaterial = {
    requestKey: request.requestKey,
    taskType: taskType as ContentTaskType,
    speakText,
    ...(question !== undefined ? { question } : {}),
    ...(gappedText !== undefined ? { gappedText } : {}),
    expectedAnswer,
    keyItems,
    ...(contextTopic !== undefined ? { contextTopic } : {}),
    ...(explanation !== undefined ? { explanation } : {}),
    targetExpressionsUsed,
    newLanguageItems,
  };

  const computedProvenance = resolveMaterialProvenance(request, speakText);
  const claimedProvenance = raw.provenance;
  if (claimedProvenance !== undefined && claimedProvenance !== null) {
    if (typeof claimedProvenance !== 'string' || !(claimedProvenance in PROVENANCE_ORDER)) {
      return fail('provenance_dishonest');
    }
    if (
      PROVENANCE_ORDER[claimedProvenance as MaterialProvenance] > PROVENANCE_ORDER[computedProvenance]
    ) {
      // A model may never claim MORE personalization than the request supports.
      return fail('provenance_dishonest');
    }
  }

  return { ok: true, material };
}
