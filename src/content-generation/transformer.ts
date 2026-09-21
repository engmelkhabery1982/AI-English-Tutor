/**
 * src/content-generation/transformer.ts
 *
 * WP-1: the CONTROLLED CONTENT TRANSFORMER.
 *
 * VALIDATED ContentRequest → existing AIProvider → VALIDATED MATERIAL
 * + honest provenance.
 *
 * OWNERSHIP BOUNDARY (what it deliberately is NOT)
 * - it is a pure request → material transformer;
 * - it never reads repositories, the learner model or the coaching context;
 * - it never persists, schedules, selects a skill or a weakness, mutates
 *   evidence, writes reviews/progress or caches anything;
 * - it reuses the EXISTING AIProvider abstraction (no new SDK, no second
 *   Gemini client, no raw fetch, no dependency).
 *
 * FAILURE BEHAVIOUR
 * Unavailable provider, timeout, invalid JSON, invalid enum or invalid
 * material all degrade to an explicit `unavailable` result. No retries, no
 * background generation, and no invented personalization.
 */

import type { ConversationRequest } from '../conversation-engine/types';
import type { CoachingContext } from '../learner-model';
import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import type {
  ContentGenerationFailure,
  ContentRequest,
  ContentTaskType,
  ControlledMaterialResult,
} from './types';
import { resolveMaterialProvenance, validateGeneratedMaterial } from './validation';

/**
 * A deliberately NEUTRAL coaching context.
 *
 * The transformer owns NO learner model access (see the ownership boundary
 * above), so the request it builds through the existing abstraction carries
 * an empty, honest context rather than borrowed learner data.
 */
function neutralCoachingContext(): CoachingContext {
  return {
    profile: {
      learnerId: '',
      displayName: '',
      currentLevel: 'unknown',
      targetLevel: 'unknown',
      learningGoals: [],
      preferredModes: [],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: '',
  };
}

/** Human-readable instruction block for the requested task type. */
function taskInstructions(taskType: ContentTaskType): string {
  switch (taskType) {
    case 'listen_and_type':
      return [
        'Write ONE short spoken passage the learner will hear and type back.',
        'The learner must be able to type it exactly, so keep wording unambiguous.',
        '"expectedAnswer" must be the passage verbatim (no punctuation changes).',
        'Do NOT include "question" or "gappedText".',
      ].join('\n');
    case 'missing_word':
      return [
        'Write ONE short spoken passage, then choose ONE content word to remove.',
        '"gappedText" must be the SAME passage with exactly that one word replaced by "___".',
        '"expectedAnswer" must be that removed word only.',
        'Do NOT include "question".',
      ].join('\n');
    case 'listen_and_answer':
      return [
        'Write ONE short spoken passage (a statement or two) the learner will hear.',
        'Add ONE comprehension question about it.',
        'The question must NOT contain the answer, and the answer must be inferable from the passage.',
        '"expectedAnswer" must be a short, natural answer phrase taken from the passage meaning.',
        'Do NOT include "gappedText".',
      ].join('\n');
    default:
      return '';
  }
}

/** JSON schema shown to the model for the requested task type. */
function schemaFor(taskType: ContentTaskType, requestKey: string, topic?: string): string {
  const common = [
    `  "requestKey": ${JSON.stringify(requestKey)},`,
    `  "taskType": ${JSON.stringify(taskType)},`,
    '  "speakText": "the passage that will be spoken",',
  ];
  const taskFields =
    taskType === 'listen_and_answer'
      ? ['  "question": "one comprehension question",']
      : taskType === 'missing_word'
        ? ['  "gappedText": "the same passage with one word replaced by ___",']
        : [];
  return [
    '{',
    ...common,
    ...taskFields,
    '  "expectedAnswer": "the exact expected answer",',
    '  "keyItems": ["1 to 4 short items that really occur in the passage"],',
    // Topic honesty: the property is included ONLY when the request REALLY
    // established a topic. Without one it is omitted from this example
    // entirely (never null, empty, or pseudo-JSON), so the example stays
    // valid JSON and the model is never asked to invent a topic it is
    // forbidden to invent — the prose rules below say to omit it.
    ...(topic !== undefined
      ? ['  "contextTopic": "the exact topic label given in the request",']
      : []),
    '  "explanation": "one short neutral listening tip",',
    '  "targetExpressionsUsed": ["any requested expressions the passage really uses"],',
    '  "newLanguageItems": 0',
    '}',
  ].join('\n');
}

/**
 * Build the EXISTING provider request for one content request.
 *
 * Exported so tests can pin the guidance that reaches the prompt.
 */
export function buildMaterialPrompt(request: ContentRequest): ConversationRequest {
  const lines: string[] = [];

  lines.push('You write ONE short English listening exercise as strict JSON.');
  lines.push('');
  lines.push('=== SHAPE OF THE MATERIAL ===');
  lines.push(`Discourse length: ${request.discourseLength.replace(/_/g, ' ')}`);
  lines.push(`Grammar complexity: ${request.grammarComplexity}`);
  lines.push(`Support level: ${request.supportLevel}`);
  lines.push(`Register: ${request.speechStyle.register}`);
  lines.push(`Sentence shape: ${request.speechStyle.sentenceShape.replace(/_/g, ' ')}`);
  lines.push(`Contraction density: ${request.speechStyle.contractionDensity}`);
  lines.push(`Lexical style: ${request.speechStyle.lexicalStyle.replace(/_/g, ' ')}`);
  lines.push('');
  lines.push('=== TASK ===');
  lines.push(taskInstructions(request.taskType));
  lines.push('');

  lines.push('=== LEARNER CONTEXT (bounded, honest) ===');
  if (request.context.topic) {
    lines.push(`Topic: ${request.context.topic}`);
  } else {
    // No topic was established for this request. Say so explicitly so the
    // model is never asked to invent one (the prompt below forbids it and
    // validation rejects any claimed topic).
    lines.push('No topic was established for this material. Do not invent or label one.');
  }
  if (request.context.learningGoals.length > 0) {
    lines.push(`Stated goals: ${request.context.learningGoals.join('; ')}`);
  }
  if (request.context.professionalContext) {
    lines.push(
      `Professional context (already established by the learner — never extend it or assume anything else): ${request.context.professionalContext}`,
    );
  }
  if (request.listeningObjective) {
    lines.push(`Listening objective to serve: ${request.listeningObjective}`);
  }
  if (request.knownVocabulary.length > 0) {
    lines.push('');
    lines.push(
      'The learner has saved evidence for these items. This is a BOUNDED list, NOT their whole vocabulary:',
    );
    lines.push(`- ${request.knownVocabulary.join(', ')}`);
    lines.push('Do NOT assume any word outside this list is unknown, and do NOT treat ordinary grammar or function words as new vocabulary.');
  }
  if (request.targetExpressions.length > 0) {
    lines.push('');
    lines.push('Weave these requested target expressions in naturally, exactly as written:');
    for (const expression of request.targetExpressions) {
      lines.push(`- ${expression}`);
    }
  }
  if (request.difficultyProfile.evidenceAdjusted) {
    lines.push('');
    lines.push(
      'This learner has real recent difficulty in this area, so keep the material on the more supported side of the range above.',
    );
  }
  lines.push('');

  lines.push('=== BUDGET ===');
  lines.push(
    `Introduce at most ${request.newLanguageBudget} deliberately new target word(s) or phrase(s). Report how many you really introduced in "newLanguageItems".`,
  );
  lines.push(
    'The budget covers deliberate teaching only: it does NOT mean every other word is already known.',
  );
  lines.push('');

  lines.push('=== HONESTY RULES ===');
  lines.push('- Never mention levels, bands, scores, ratings, grades or percentages.');
  lines.push('- Never invent facts about the learner, their job or their life.');
  lines.push('- Never invent a topic the context above did not establish.');
  lines.push('- General material stays general: a neutral everyday scene is NOT a topic the learner chose, so omit "contextTopic" unless a topic label was given above.');
  lines.push('- Write natural, everyday English that a text-to-speech voice reads clearly.');
  lines.push('- Every "keyItems" entry must really occur in "speakText".');
  lines.push('');

  lines.push('Respond with ONLY this JSON object and nothing else:');
  lines.push(schemaFor(request.taskType, request.requestKey, request.context.topic));

  return {
    systemPrompt:
      'You write short English listening practice as strict JSON for a language-learning app. You never output scores, ratings, levels, percentages or invented personal facts.',
    messages: [{ role: 'user', content: lines.join('\n') }],
    mode: 'coach',
    topic: 'Listening content generation',
    coachingContext: neutralCoachingContext(),
    // INTERNAL dev/debug counter label only (this path serves listening
    // exercise generation exclusively).
    diagnosticsType: 'listening_generation',
  };
}

function unavailable(
  requestKey: string,
  reason: ContentGenerationFailure,
  detail: string,
): ControlledMaterialResult {
  return { status: 'unavailable', requestKey, reason, detail };
}

/**
 * Transform ONE validated request into validated material, or an honest
 * `unavailable` result. Never throws.
 */
export async function generateControlledMaterial(
  provider: AIProvider | undefined | null,
  request: ContentRequest,
): Promise<ControlledMaterialResult> {
  if (!provider) {
    return unavailable(
      request.requestKey,
      'no_provider',
      'No content provider is available, so nothing was generated.',
    );
  }

  let result: AIProviderResult;
  try {
    result = await provider.generate(buildMaterialPrompt(request));
  } catch {
    return unavailable(
      request.requestKey,
      'provider_error',
      'The content provider failed while generating material.',
    );
  }

  if (!result.ok) {
    const code = result.error?.code;
    if (code === 'timeout') {
      return unavailable(
        request.requestKey,
        'provider_timeout',
        'The content provider timed out; deterministic material is used instead.',
      );
    }
    if (code === 'unavailable') {
      return unavailable(
        request.requestKey,
        'provider_unavailable',
        'The content provider is unavailable right now.',
      );
    }
    return unavailable(
      request.requestKey,
      'provider_error',
      `The content provider returned an error (${String(code ?? 'unknown')}).`,
    );
  }

  const content = result.response?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    return unavailable(request.requestKey, 'invalid_output', 'The provider returned no content.');
  }

  const validation = validateGeneratedMaterial(request, content);
  if (!validation.ok) {
    // Invalid material is DISCARDED — never repaired and never trusted.
    return unavailable(
      request.requestKey,
      'invalid_output',
      `Generated material was rejected (${validation.issue}).`,
    );
  }

  // Provenance is computed from the request and the accepted material — the
  // model's own claim is only ever validated, never trusted.
  return {
    status: 'generated',
    requestKey: request.requestKey,
    provenance: resolveMaterialProvenance(request, validation.material.speakText),
    material: validation.material,
  };
}
