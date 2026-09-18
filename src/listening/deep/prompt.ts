/**
 * src/listening/deep/prompt.ts
 *
 * WP-2 — the generation prompt for deep listening material.
 *
 * The prompt is built ONLY from the normalized deep request: the model is told
 * the real bounds, the real learner context (or that there is none), and the
 * honesty rules the deterministic validator then enforces. Nothing here reads
 * repositories, the clock or the learner model.
 *
 * Exported so tests can pin the guidance that really reaches the model.
 */

import type { ConversationRequest } from '../../conversation-engine/types';
import type { CoachingContext } from '../../learner-model';
import { DISCOURSE_KIND_LABELS } from './types';
import type { DeepListeningRequest } from './request';

/** A deliberately NEUTRAL coaching context (this layer owns no learner model). */
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

function taskInstructions(request: DeepListeningRequest): string {
  switch (request.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return [
        `Write ONE complete ${
          request.discourseKind ? DISCOURSE_KIND_LABELS[request.discourseKind].toLowerCase() : 'piece of discourse'
        } the learner listens to once and then answers questions about.`,
        request.taskType === 'multi_speaker_dialogue'
          ? 'It is a conversation: at least two speakers must really speak, and every segment must be attributed to exactly one of them.'
          : 'It may have one speaker or more, as long as every segment is attributed to a real speaker.',
        'The learner hears it FIRST: no part of the passage may be shown as text before the questions are answered.',
        'Every question must be answerable from the passage alone.',
        'Do NOT ask who said something unless exactly one speaker really said it.',
      ].join('\n');
    case 'connected_speech':
      return [
        'Write connected-speech RECOGNITION items about how normal spoken English compresses words.',
        'Each item pairs the STANDARD WRITTEN FORM with the way it is really said.',
        'The learner hears the spoken realization and must identify the standard written form.',
        'The correct answer is ALWAYS the standard written form — never the informal realization.',
        'Do not claim an informal realization is more correct than the standard form, and do not present it as universal English.',
      ].join('\n');
    case 'shadowing':
      return [
        'Write ONE short, natural chunk of spoken English that a learner will listen to and then repeat out loud.',
        'It must be a chunk a real person would say in one breath, not a list or a definition.',
        'Also give the same meaning in standard written English ("canonicalWrittenForm"), keeping the meaning identical.',
      ].join('\n');
    default:
      return '';
  }
}

function boundsInstructions(request: DeepListeningRequest): string {
  const b = request.bounds;
  switch (request.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return [
        `Speakers: between ${b.minSpeakers} and ${b.maxSpeakers}.`,
        `Segments: between ${b.minSegments} and ${b.maxSegments}.`,
        `Words per segment: at most ${b.maxWordsPerSegment}. Total words: at most ${b.maxWords}.`,
        `Questions: between ${b.minQuestions} and ${b.maxQuestions}.`,
        `Options per question: between ${b.minOptions} and ${b.maxOptions} (omit options entirely when the learner should type the answer).`,
        `Allowed question kinds: ${request.questionKinds.join(', ')}.`,
      ].join('\n');
    case 'connected_speech':
      return [
        `Items: between ${b.minConnectedSpeechItems} and ${b.maxConnectedSpeechItems}.`,
        `Allowed categories: ${request.connectedSpeechCategories.join(', ')}.`,
        `Options per item: between ${Math.max(b.minOptions, 2)} and ${b.maxOptions}.`,
      ].join('\n');
    case 'shadowing':
      return [
        `Chunk length: between ${b.minShadowingChunkWords} and ${b.maxShadowingChunkWords} words.`,
        `Support level for this session: ${request.shadowingSupport.replace(/_/g, ' ')}.`,
      ].join('\n');
    default:
      return '';
  }
}

function discourseSchema(request: DeepListeningRequest, requestKey: string, topic?: string): string[] {
  return [
    '{',
    `  "requestKey": ${JSON.stringify(requestKey)},`,
    `  "taskType": ${JSON.stringify(request.taskType)},`,
    `  "discourseKind": ${JSON.stringify(request.discourseKind ?? 'short_story')},`,
    '  "speakers": [ { "id": "s1", "label": "a name or role that is really used in the passage" } ],',
    '  "segments": [ { "id": "t1", "speakerId": "s1", "text": "one spoken segment" } ],',
    '  "questions": [',
    '    {',
    '      "id": "q1",',
    `      "kind": "one of: ${request.questionKinds.join(' | ')}",`,
    '      "prompt": "the question (it must NOT contain the answer)",',
    '      "expectedAnswer": "words that really occur in the passage",',
    '      "evidenceSegmentIds": ["t1"],',
    '      "options": ["only when the question is answered by choosing"],',
    '      "speakerId": "only for a question about what one speaker meant",',
    '      "explanation": "one short neutral tip"',
    '    }',
    '  ],',
    '  "keyItems": ["1 to 4 short items that really occur in the passage"],',
    '  "explanation": "one short neutral listening tip",',
    ...(topic !== undefined
      ? ['  "contextTopic": "the exact topic label given in the request",']
      : []),
    '}',
  ];
}

function connectedSpeechSchema(request: DeepListeningRequest, requestKey: string, topic?: string): string[] {
  return [
    '{',
    `  "requestKey": ${JSON.stringify(requestKey)},`,
    '  "taskType": "connected_speech",',
    '  "items": [',
    '    {',
    '      "id": "i1",',
    `      "category": "one of: ${request.connectedSpeechCategories.join(' | ')}",`,
    '      "writtenForm": "the standard written form",',
    '      "spokenRealization": "how it is really said, written in ordinary letters (never phonetic symbols)",',
    '      "register": "informal | neutral | formal",',
    '      "form": "full_form | contracted_form | reduced_form",',
    '      "prompt": "the question (it must NOT contain the written form)",',
    '      "expectedAnswer": "the standard written form, exactly as in writtenForm",',
    '      "options": ["the written form plus plausible standard-form distractors"],',
    '      "explanation": "one short tip naming both forms and when the spoken one is natural"',
    '    }',
    '  ],',
    '  "keyItems": ["1 to 4 short items really present in the material"],',
    '  "explanation": "one short neutral listening tip",',
    ...(topic !== undefined
      ? ['  "contextTopic": "the exact topic label given in the request",']
      : []),
    '}',
  ];
}

function shadowingSchema(request: DeepListeningRequest, requestKey: string, topic?: string): string[] {
  return [
    '{',
    `  "requestKey": ${JSON.stringify(requestKey)},`,
    '  "taskType": "shadowing",',
    `  "chunk": "one short natural chunk of ${request.bounds.minShadowingChunkWords}-${request.bounds.maxShadowingChunkWords} words",`,
    '  "canonicalWrittenForm": "the same meaning in standard written English",',
    `  "support": ${JSON.stringify(request.shadowingSupport)},`,
    '  "keyItems": ["1 to 4 short items that really occur in the chunk"],',
    '  "explanation": "one short neutral tip",',
    ...(topic !== undefined
      ? ['  "contextTopic": "the exact topic label given in the request",']
      : []),
    '}',
  ];
}

/** The JSON example the model is asked to return, per task type. */
export function deepSchemaFor(request: DeepListeningRequest): string {
  const topic = request.context.topic;
  const lines =
    request.taskType === 'connected_speech'
      ? connectedSpeechSchema(request, request.requestKey, topic)
      : request.taskType === 'shadowing'
        ? shadowingSchema(request, request.requestKey, topic)
        : discourseSchema(request, request.requestKey, topic);
  return lines.join('\n');
}

/** Build the EXISTING provider request for one deep request. */
export function buildDeepMaterialPrompt(request: DeepListeningRequest): ConversationRequest {
  const lines: string[] = [];
  const profile = request.difficultyProfile;

  lines.push('You write ONE deep English listening activity as strict JSON.');
  lines.push('');
  lines.push('=== SHAPE OF THE MATERIAL ===');
  lines.push(`Discourse length: ${profile.discourseLength.replace(/_/g, ' ')}`);
  lines.push(`Grammar complexity: ${profile.grammarComplexity}`);
  lines.push(`Support level: ${profile.supportLevel}`);
  lines.push(`Register: ${profile.speechStyle.register}`);
  lines.push(`Sentence shape: ${profile.speechStyle.sentenceShape.replace(/_/g, ' ')}`);
  lines.push(`Contraction density: ${profile.speechStyle.contractionDensity}`);
  lines.push(`Lexical style: ${profile.speechStyle.lexicalStyle.replace(/_/g, ' ')}`);
  lines.push('');
  lines.push('=== TASK ===');
  lines.push(taskInstructions(request));
  lines.push('');
  lines.push('=== BOUNDS (hard limits) ===');
  lines.push(boundsInstructions(request));
  lines.push('');
  lines.push('=== LEARNER CONTEXT (bounded, honest) ===');
  if (request.context.topic) {
    lines.push(`Topic: ${request.context.topic}`);
  } else {
    lines.push('No topic was established for this material. Do not invent or label one.');
  }
  if (request.context.learningGoals.length > 0) {
    lines.push(`Stated goals: ${request.context.learningGoals.join('; ')}`);
  }
  if (request.context.professionalContext) {
    lines.push(
      `Professional context (already established by the learner — never extend it): ${request.context.professionalContext}`,
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
    lines.push('Do NOT assume any word outside this list is unknown.');
  }
  if (request.targetExpressions.length > 0) {
    lines.push('');
    lines.push('Use these requested target expressions naturally, exactly as written:');
    for (const expression of request.targetExpressions) lines.push(`- ${expression}`);
  }
  if (profile.evidenceAdjusted) {
    lines.push('');
    lines.push(
      'This learner has real recent difficulty in listening, so keep the material on the more supported side of the range above.',
    );
  }
  lines.push('');
  lines.push('=== HONESTY RULES ===');
  lines.push('- Never mention levels, bands, scores, ratings, grades, percentages or words per minute.');
  lines.push('- Never invent facts about the learner, their job or their life.');
  lines.push('- Never invent a topic the context above did not establish.');
  lines.push('- General material stays general: omit "contextTopic" unless a topic label was given above.');
  lines.push('- Never include metadata, field names, ids or instructions inside learner-facing text.');
  lines.push('- Never use phonetic symbols or IPA: write realizations in ordinary letters.');
  lines.push('- Write natural, everyday English that a text-to-speech voice reads clearly.');
  lines.push('- Respond with ONLY the JSON object below and nothing else.');
  lines.push('');
  lines.push(deepSchemaFor(request));

  return {
    systemPrompt:
      'You write English listening practice as strict JSON for a language-learning app. You never output scores, ratings, levels, percentages or invented personal facts, and you never use phonetic notation.',
    messages: [{ role: 'user', content: lines.join('\n') }],
    mode: 'coach',
    topic: 'Deep listening content generation',
    coachingContext: neutralCoachingContext(),
  };
}
