/**
 * src/listening/deep/index.test.ts
 *
 * WP-2 — LISTENING DEPTH tests (long discourse, multi-speaker, speech rate,
 * connected speech, adaptive difficulty, evidence ownership).
 *
 * Strategy: exercise the REAL deep planner + REAL request/normalization code +
 * REAL deterministic validator against the REAL SQLite repositories
 * (SqlJsAdapter) and the EXISTING listening service, with an injected fake AI
 * provider that reads the bounds it is given and answers like a well-behaved
 * model. No network, no audio device, no real TTS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { SqlJsAdapter } from '../../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../../data/local/sqlite/repositories';
import type { AIProvider, AIProviderResult } from '../../providers/ai/types';
import { createDemoTTSProvider, createExpoTTSProvider } from '../../providers/tts';
import type { TextToSpeechProvider } from '../../providers/tts/types';
import { ListeningService } from '../service';
import { GENERAL_TEMPLATES, planListeningSession, stableReferenceId } from '../generator';
import { evaluateListenAndType } from '../evaluator';
import type { ListeningExercise } from '../types';
import { resolveDifficultyProfile } from '../../learning-progression';
import {
  buildDeepMaterialPrompt,
  buildDeepListeningRequest,
  canonicalDeepRequestIdentity,
  catalogueConnectedSpeechMaterial,
  catalogueDiscourseMaterial,
  discourseEntryFor,
  DISCOURSE_KINDS,
  MULTI_SPEAKER_DISCOURSE_KINDS,
  SOLO_DISCOURSE_KINDS,
  generateDeepListeningActivity,
  activityToRawMaterial,
  materialToActivity,
  deepAnswerSteps,
  deepRequestForTaskType,
  deepSessionSourceNote,
  isMultiSpeakerActivity,
  planSpeechRate,
  parseDeepListeningMaterial,
  planDeepListeningSession,
  resolveDeepListeningPlan,
  resolveSpeakerVoiceCapability,
  resolveSpeechRateCapability,
  retrainingObjective,
  buildSpokenScript,
  speakerHonestyNote,
  speakerSummary,
  SINGLE_VOICE_HONESTY_NOTE,
  SPEECH_RATE_DEGRADED_NOTE,
  SPEECH_RATE_UNSUPPORTED_NOTE,
  deepStepById,
  initialPlaybackState,
  withSpeechRate,
  finishPlayback,
  beginPlayback,
  abortPlayback,
  speechRateTTSOptions,
} from './index';
import type {
  DeepListeningRequest,
  SpeechRateCapability,
  ShadowingListeningActivity,
} from './index';

const NOW = '2026-09-18T12:00:00.000Z';

/* ------------------------------------------------------------------ *
 * Context + service
 * ------------------------------------------------------------------ */

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  expressions: SQLiteExpressionRepository;
  review: SQLiteReviewRepository;
  profileRepo: SQLiteUserProfileRepository;
}

async function createContext(currentLevel = 'B1'): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Deep Listening Tester',
    currentLevel: currentLevel as 'B1',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });
  return {
    adapter,
    learnerId: profile.id,
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    profileRepo,
  };
}

function createService(
  ctx: TestContext,
  options?: { aiProvider?: AIProvider; weaknessSpy?: (input: unknown) => void },
): ListeningService {
  return new ListeningService({
    weaknesses: {
      listWeaknesses: (learnerId, limit) => ctx.weaknesses.listWeaknesses(learnerId, limit),
      upsertWeakness: (weakness) => {
        options?.weaknessSpy?.(weakness);
        return ctx.weaknesses.upsertWeakness(weakness);
      },
      getWeaknessByReference: (learnerId, type, referenceId) =>
        ctx.weaknesses.getWeaknessByReference(learnerId, type, referenceId),
    },
    review: {
      upsert: (item) => ctx.review.upsert(item),
      getByReference: (learnerId, kind, referenceId) =>
        ctx.review.getByReference(learnerId, kind, referenceId),
    },
    vocabulary: ctx.vocabulary,
    expressions: ctx.expressions,
    aiProvider: options?.aiProvider,
    profile: ctx.profileRepo,
  });
}

async function seedListeningWeakness(
  ctx: TestContext,
  target: string,
  status: 'observed' | 'confirmed' = 'confirmed',
): Promise<void> {
  await ctx.weaknesses.upsertWeakness({
    learnerId: ctx.learnerId,
    type: 'listening',
    referenceId: stableReferenceId(`word_recognition:${target}`),
    severity: 0.5,
    status,
    lastSeenAt: NOW,
    firstSeenAt: NOW,
    occurrenceCount: 3,
    contexts: [],
    notes: `word_recognition:${target}`,
    evidence: [],
    resolved: false,
  } as never);
}

function unsupportedRate(): SpeechRateCapability {
  return resolveSpeechRateCapability(null);
}

function deepSessionOptions(overrides: Partial<Parameters<ListeningService['startDeepSession']>[1]> = {}) {
  return {
    targetCount: 3,
    speechRateCapability: unsupportedRate(),
    now: NOW,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * A well-behaved fake model: it reads the bounds it is given
 * ------------------------------------------------------------------ */

interface PromptBounds {
  minSpeakers: number;
  maxSpeakers: number;
  minSegments: number;
  maxSegments: number;
  maxWordsPerSegment: number;
  maxWords: number;
  minQuestions: number;
  maxQuestions: number;
  minOptions: number;
  maxOptions: number;
  minConnected: number;
  maxConnected: number;
  minChunk: number;
  maxChunk: number;
  questionKinds: readonly string[];
  categories: readonly string[];
  shadowingSupport: string;
  discourseKind?: string;
}

function numberFrom(text: string, pattern: RegExp, fallback: number): number {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : fallback;
}

function parsePrompt(text: string): PromptBounds {
  const speakerRange = /Speakers: between (\d+) and (\d+)\./.exec(text);
  const segmentRange = /Segments: between (\d+) and (\d+)\./.exec(text);
  const questionRange = /Questions: between (\d+) and (\d+)\./.exec(text);
  const optionRange = /Options per question: between (\d+) and (\d+)\./.exec(text);
  const itemRange = /Items: between (\d+) and (\d+)\./.exec(text);
  const chunkRange = /Chunk length: between (\d+) and (\d+) words\./.exec(text);
  const discourseKindMatch = /"discourseKind":\s*"([a-z_]+)"/.exec(text);
  const kindMatch = /Allowed question kinds: ([a-z_, ]+)\./.exec(text);
  const categoryMatch = /Allowed categories: ([a-z_, ]+)\./.exec(text);
  const supportMatch = /Support level for this session: ([a-z ]+)\./.exec(text);

  return {
    minSpeakers: speakerRange ? Number(speakerRange[1]) : 1,
    maxSpeakers: speakerRange ? Number(speakerRange[2]) : 2,
    minSegments: segmentRange ? Number(segmentRange[1]) : 3,
    maxSegments: segmentRange ? Number(segmentRange[2]) : 5,
    maxWordsPerSegment: numberFrom(text, /Words per segment: at most (\d+)\./, 20),
    maxWords: numberFrom(text, /Total words: at most (\d+)\./, 60),
    minQuestions: questionRange ? Number(questionRange[1]) : 1,
    maxQuestions: questionRange ? Number(questionRange[2]) : 2,
    minOptions: optionRange ? Number(optionRange[1]) : 2,
    maxOptions: optionRange ? Number(optionRange[2]) : 3,
    minConnected: itemRange ? Number(itemRange[1]) : 2,
    maxConnected: itemRange ? Number(itemRange[2]) : 3,
    minChunk: chunkRange ? Number(chunkRange[1]) : 4,
    maxChunk: chunkRange ? Number(chunkRange[2]) : 8,
    questionKinds: kindMatch ? kindMatch[1].split(',').map((part) => part.trim()) : ['main_idea'],
    categories: categoryMatch ? categoryMatch[1].split(',').map((part) => part.trim()) : ['contraction'],
    shadowingSupport: supportMatch ? supportMatch[1].trim().replace(/ /g, '_') : 'full_transcript',
    discourseKind: discourseKindMatch ? discourseKindMatch[1] : 'short_story',
  };
}

const DISCOURSE_WITNESSES: Readonly<Record<string, { prompt: string; answer: string; evidence: string; speakerId?: string }>> = {
  main_idea: {
    prompt: 'What is the passage mainly about?',
    answer: 'the delivery moved to Friday',
    evidence: 't2',
  },
  detail: {
    prompt: 'What did the first speaker check this morning?',
    answer: 'the schedule again this morning',
    evidence: 't1',
  },
  sequencing: {
    prompt: 'What will happen before lunch?',
    answer: 'send it before lunch',
    evidence: 't4',
  },
  inference: {
    prompt: 'Why did the delivery date change?',
    answer: 'the driver was sick',
    evidence: 't2',
  },
  vocabulary_in_context: {
    prompt: 'What should they do about the new date?',
    answer: 'tell the customers',
    evidence: 't3',
  },
  speaker_intention: {
    prompt: 'Why did the second speaker change the plan?',
    answer: 'because the driver was sick',
    evidence: 't2',
    speakerId: 's2',
  },
};

const DISCOURSE_SEGMENTS = [
  { id: 't1', speakerId: 's1', text: 'I checked the schedule again this morning before the call.' },
  { id: 't2', speakerId: 's2', text: 'The delivery moved to Friday because the driver was sick.' },
  { id: 't3', speakerId: 's1', text: 'We should tell the customers about the new date today.' },
  { id: 't4', speakerId: 's2', text: 'I will write the message and send it before lunch.' },
] as const;

function discoursePayload(requestKey: string, taskType: string, bounds: PromptBounds, topic?: string) {
  const speakers =
    bounds.maxSpeakers >= 2
      ? [
          { id: 's1', label: 'Maya' },
          { id: 's2', label: 'Tom' },
        ]
      : [{ id: 's1', label: 'Maya' }];
  const segments = DISCOURSE_SEGMENTS.map((segment) => ({
    ...segment,
    speakerId: speakers.length > 1 ? segment.speakerId : 's1',
  }));
  const kinds = bounds.questionKinds.filter((kind) => kind in DISCOURSE_WITNESSES);
  const count = Math.max(1, Math.min(bounds.maxQuestions, kinds.length));
  const questions = kinds.slice(0, count).map((kind, index) => {
    const witness = DISCOURSE_WITNESSES[kind];
    const withOptions = kind === 'main_idea';
    return {
      id: `q${index + 1}`,
      kind,
      prompt: witness.prompt,
      expectedAnswer: witness.answer,
      evidenceSegmentIds: [witness.evidence],
      ...(witness.speakerId ? { speakerId: witness.speakerId } : {}),
      ...(withOptions
        ? { options: [witness.answer, 'the office moved to Friday', 'the meeting was cancelled'] }
        : {}),
      explanation: 'Tip: listen for the sentence that carries this information.',
    };
  });
  return {
    requestKey,
    taskType,
    // The pinned discourse kind is echoed exactly as the prompt stated it.
    discourseKind: bounds.discourseKind ?? 'short_story',
    ...(topic ? { contextTopic: topic } : {}),
    speakers,
    segments,
    questions,
    keyItems: ['schedule', 'delivery', 'customers'],
    explanation: 'Tip: this passage keeps two speakers in a clear order.',
  };
}

const CONNECTED_PAIRS = [
  { category: 'contraction', writtenForm: 'they are', spokenRealization: "they're", register: 'neutral', form: 'contracted_form', distractors: ['they have', 'they will'] },
  { category: 'reduction', writtenForm: 'want to', spokenRealization: 'wanna', register: 'informal', form: 'reduced_form', distractors: ['wanted to', 'went to'] },
  { category: 'weak_form', writtenForm: 'has to', spokenRealization: 'hasta', register: 'informal', form: 'reduced_form', distractors: ['have to', 'had to'] },
  { category: 'elision', writtenForm: 'did you', spokenRealization: 'didja', register: 'informal', form: 'reduced_form', distractors: ['do you', 'have you'] },
  { category: 'linking', writtenForm: 'turn it off', spokenRealization: 'turnitoff', register: 'informal', form: 'reduced_form', distractors: ['turn it on', 'turn it over'] },
] as const;

function connectedPayload(requestKey: string, bounds: PromptBounds, topic?: string) {
  const allowed = CONNECTED_PAIRS.filter((pair) => bounds.categories.includes(pair.category));
  const pool = allowed.length > 0 ? allowed : CONNECTED_PAIRS.slice(0, 1);
  const start = Math.min(1, Math.max(0, pool.length - Math.max(bounds.minConnected, 1)));
  const wanted = Math.min(Math.max(bounds.minConnected, 2), bounds.maxConnected);
  const chosen = pool.slice(start, start + wanted);
  const items = chosen.map((pair, index) => ({
    id: `i${index + 1}`,
    category: pair.category,
    writtenForm: pair.writtenForm,
    spokenRealization: pair.spokenRealization,
    register: pair.register,
    form: pair.form,
    prompt: 'Which standard written form matches what you heard?',
    expectedAnswer: pair.writtenForm,
    options: [pair.writtenForm, ...pair.distractors].slice(0, Math.max(bounds.minOptions, 3)),
    explanation: `The spoken form '${pair.spokenRealization}' keeps the meaning of '${pair.writtenForm}'.`,
  }));
  return {
    requestKey,
    taskType: 'connected_speech',
    ...(topic ? { contextTopic: topic } : {}),
    items,
    keyItems: items.map((item) => item.spokenRealization).slice(0, 3),
    explanation: 'Tip: normal speech squeezes words together.',
  };
}

function shadowingPayload(requestKey: string, bounds: PromptBounds, topic?: string) {
  const target = Math.min(Math.max(bounds.minChunk, 6), bounds.maxChunk);
  const pool = ['I', 'will', 'send', 'the', 'final', 'report', 'to', 'you', 'before', 'lunch', 'today'];
  const words = pool.slice(0, Math.max(4, Math.min(target, pool.length)));
  const chunk = `${words.join(' ')}.`;
  return {
    requestKey,
    taskType: 'shadowing',
    ...(topic ? { contextTopic: topic } : {}),
    chunk,
    canonicalWrittenForm: chunk,
    support: bounds.shadowingSupport,
    keyItems: words.slice(1, 3),
    explanation: 'Tip: repeat it in one breath and keep the rhythm.',
  };
}

/** A fake provider that honors the bounds it is given (inferred from the prompt). */
function echoDeepProvider(options?: {
  transform?: (payload: Record<string, unknown>) => Record<string, unknown>;
  captured?: { prompts: string[] };
}): AIProvider {
  return {
    id: 'echo-deep-ai',
    generate: async (request): Promise<AIProviderResult> => {
      const text = request.messages.map((message) => message.content).join('\n');
      options?.captured?.prompts.push(text);
      const requestKey = /"requestKey":\s*"([^"]+)"/.exec(text)?.[1] ?? '';
      const taskType = /"taskType":\s*"([^"]+)"/.exec(text)?.[1] ?? 'long_discourse';
      const topicMatch = /^Topic: (.+)$/m.exec(text);
      const bounds = parsePrompt(text);
      const base =
        taskType === 'connected_speech'
          ? connectedPayload(requestKey, bounds, topicMatch?.[1]?.trim())
          : taskType === 'shadowing'
            ? shadowingPayload(requestKey, bounds, topicMatch?.[1]?.trim())
            : discoursePayload(requestKey, taskType, bounds, topicMatch?.[1]?.trim());
      const payload = options?.transform ? options.transform(base) : base;
      return { ok: true, response: { content: JSON.stringify(payload) } };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

/* ================================================================== *
 * 1–3. Long discourse, generated and parsed
 * ================================================================== */

describe('long discourse', () => {
  it('1. a long discourse activity is generated and parsed correctly', async () => {
    const ctx = await createContext('B1');
    const service = createService(ctx, { aiProvider: echoDeepProvider() });
    const plan = resolveDeepListeningPlan({
      level: 'B1',
      evidence: null,
      speechRateCapability: unsupportedRate(),
    });
    const request = deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    });
    expect(request).not.toBeNull();

    const outcome = await generateDeepListeningActivity(echoDeepProvider(), {
      learnerId: ctx.learnerId,
      request: request!,
    });
    expect(outcome.failure).toBeNull();
    const activity = outcome.activity;
    expect(activity?.taskType).toBe('multi_speaker_dialogue');
    if (!activity || activity.taskType !== 'multi_speaker_dialogue') throw new Error('no activity');
    expect(activity.segments.length).toBeGreaterThanOrEqual(3);
    expect(activity.questions.length).toBeGreaterThanOrEqual(2);
    expect(activity.requestKey).toBe(request!.requestKey);
    // The engine served it through the EXISTING service without a second engine.
    const session = await service.startDeepSession(ctx.learnerId, deepSessionOptions({ targetCount: 1 }));
    expect(session.activities.length).toBe(1);
  });

  it('2. the main-idea question derives from the real content it cites', async () => {
    const ctx = await createContext('B1');
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    const request = deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
    const outcome = await generateDeepListeningActivity(echoDeepProvider(), { learnerId: ctx.learnerId, request });
    const activity = outcome.activity;
    if (!activity || activity.taskType !== 'multi_speaker_dialogue') throw new Error('no activity');
    const mainIdea = activity.questions.find((question) => question.kind === 'main_idea');
    expect(mainIdea).toBeDefined();
    const passage = activity.segments.map((segment) => segment.text).join(' ');
    const cited = activity.segments
      .filter((segment) => mainIdea!.evidenceSegmentIds.includes(segment.id))
      .map((segment) => segment.text)
      .join(' ');
    expect(passage.toLowerCase()).toContain(mainIdea!.expectedAnswer.toLowerCase());
    expect(cited.toLowerCase()).toContain(mainIdea!.expectedAnswer.toLowerCase());
    expect(mainIdea!.prompt.toLowerCase()).not.toContain(mainIdea!.expectedAnswer.toLowerCase());
  });

  it('3. a detail answer really exists in the source content', async () => {
    const ctx = await createContext('B1');
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    const request = deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
    const outcome = await generateDeepListeningActivity(echoDeepProvider(), { learnerId: ctx.learnerId, request });
    const activity = outcome.activity;
    if (!activity || activity.taskType !== 'multi_speaker_dialogue') throw new Error('no activity');
    const detail = activity.questions.find((question) => question.kind === 'detail');
    expect(detail).toBeDefined();
    const cited = activity.segments
      .filter((segment) => detail!.evidenceSegmentIds.includes(segment.id))
      .map((segment) => segment.text)
      .join(' ');
    expect(cited.toLowerCase()).toContain(detail!.expectedAnswer.toLowerCase());
  });
});

/* ================================================================== *
 * 4–7. Multiple speakers + voice honesty
 * ================================================================== */

describe('multiple speakers', () => {
  it('4. multi-speaker speaker references are all valid', async () => {
    const ctx = await createContext('B1');
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    const request = deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
    const outcome = await generateDeepListeningActivity(echoDeepProvider(), { learnerId: ctx.learnerId, request });
    const activity = outcome.activity;
    if (!activity || activity.taskType !== 'multi_speaker_dialogue') throw new Error('no activity');
    const speakerIds = activity.speakers.map((speaker) => speaker.id);
    for (const segment of activity.segments) expect(speakerIds).toContain(segment.speakerId);
    for (const question of activity.questions) {
      if (question.speakerId !== undefined) expect(speakerIds).toContain(question.speakerId);
      for (const segmentId of question.evidenceSegmentIds) {
        expect(activity.segments.map((segment) => segment.id)).toContain(segmentId);
      }
    }
    expect(isMultiSpeakerActivity(activity)).toBe(true);
  });

  it('5. an invalid speaker reference is rejected by the validator', async () => {
    const ctx = await createContext('B1');
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    const request = deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
    const ghostSegment = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const segments = payload.segments as { id: string; speakerId: string; text: string }[];
          segments[0] = { ...segments[0], speakerId: 'ghost' };
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(ghostSegment.failure).toBe('invalid_output');
    expect(ghostSegment.validationIssue).toBe('unknown_speaker');

    const ghostQuestion = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const questions = payload.questions as { id: string; kind: string; speakerId?: string }[];
          questions[0].speakerId = 'ghost';
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(ghostQuestion.failure).toBe('invalid_output');
    expect(ghostQuestion.validationIssue).toBe('unknown_speaker');
  });

  it('6. multi-speaker content stays structurally multi-speaker', async () => {
    const ctx = await createContext('B1');
    const session = await planDeepListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      {
        level: 'B1',
        learningGoals: [],
        speechRateCapability: unsupportedRate(),
        taskTypes: ['multi_speaker_dialogue'],
        targetCount: 1,
        now: NOW,
      },
    );
    const activity = session.activities[0];
    if (!activity || activity.taskType !== 'multi_speaker_dialogue') throw new Error('no activity');
    const speaking = new Set(activity.segments.map((segment) => segment.speakerId));
    expect(speaking.size).toBeGreaterThanOrEqual(2);
    expect(speakerSummary(activity).split(', ').length).toBeGreaterThanOrEqual(2);
  });

  it('7. a single-voice provider never claims real distinct voices', () => {
    const expo = createExpoTTSProvider();
    const capability = resolveSpeakerVoiceCapability(expo);
    expect(capability.distinctVoices).toBe(false);
    expect(capability.voiceCount).toBe(1);

    const entry = discourseEntryFor('workplace_explanation')!;
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    const activity = materialToActivity(
      catalogueDiscourseMaterial(entry, {
        ...(deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
          learningGoals: [],
          knownVocabulary: [],
          targetExpressions: [],
        })!),
      }),
      {
        learnerId: 'learner',
        request: deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
          learningGoals: [],
          knownVocabulary: [],
          targetExpressions: [],
        })!,
        source: 'general',
        materialOrigin: 'deterministic',
        provenance: 'general',
      },
    );
    if (activity.taskType !== 'multi_speaker_dialogue') throw new Error('no dialogue');
    const script = buildSpokenScript(activity, capability);
    expect(script.attribution).toBe('single_voice_text_cues');
    expect(script.speakerCueCount).toBeGreaterThan(0);
    expect(script.text).toContain('says:');
    expect(speakerHonestyNote(activity, capability)).toBe(SINGLE_VOICE_HONESTY_NOTE);
    expect(SINGLE_VOICE_HONESTY_NOTE).toMatch(/not two real voices/i);

    // A provider that really declares several voices is the ONLY way the claim
    // is allowed.
    const multiVoice: TextToSpeechProvider = {
      id: 'fake-multi-voice',
      supportedVoices: ['voice-a', 'voice-b'],
      speak: async () => undefined,
      stop: async () => undefined,
      isSpeaking: async () => false,
    };
    const multiCapability = resolveSpeakerVoiceCapability(multiVoice);
    expect(multiCapability.distinctVoices).toBe(true);
    expect(speakerHonestyNote(activity, multiCapability)).toBeNull();
  });
});

/* ================================================================== *
 * 8–11. Speech rate + evidence safety
 * ================================================================== */

describe('variable speech rate', () => {
  it('8. slower/natural/faster uses the provider capability honestly', () => {
    const capability = resolveSpeechRateCapability(createExpoTTSProvider());
    expect(capability.supported).toBe(true);
    expect(capability.reason).toBe('provider_declares_rate_support');

    const natural = planSpeechRate('natural', capability);
    const slower = planSpeechRate('slower', capability);
    const faster = planSpeechRate('faster', capability);
    expect(natural.rate).toBe(1);
    expect(slower.rate).toBeLessThan(1);
    expect(faster.rate).toBeGreaterThan(1);
    expect(natural.levels).toEqual(['slower', 'natural', 'faster']);
    expect(speechRateTTSOptions(faster)).toEqual({ rate: faster.rate });
    // No words-per-minute claim anywhere.
    expect(faster.note.toLowerCase()).toContain('not a words-per-minute');
  });

  it('9. unsupported speed control degrades honestly', () => {
    const capability = resolveSpeechRateCapability(createDemoTTSProvider());
    expect(capability.supported).toBe(false);
    expect(capability.reason).toBe('provider_does_not_declare_rate_support');
    // A provider with no declaration is never assumed to support speed control.
    expect(resolveSpeechRateCapability(undefined).supported).toBe(false);

    const degraded = planSpeechRate('faster', capability);
    expect(degraded.level).toBe('natural');
    expect(degraded.requestedLevel).toBe('faster');
    expect(degraded.rate).toBeNull();
    expect(degraded.levels).toEqual(['natural']);
    expect(degraded.note).toBe(SPEECH_RATE_DEGRADED_NOTE);
    // The request is not silently ignored: the note says what happened.
    expect(degraded.note).toMatch(/kept as Normal/i);
    expect(planSpeechRate('natural', capability).note).toBe(SPEECH_RATE_UNSUPPORTED_NOTE);
    expect(speechRateTTSOptions(degraded)).toEqual({});
  });

  it('10. changing speed creates no learner evidence', async () => {
    const ctx = await createContext('B1');
    let upserts = 0;
    const service = createService(ctx, { weaknessSpy: () => { upserts += 1; } });
    const capability = resolveSpeechRateCapability(createExpoTTSProvider());

    const session = await service.startDeepSession(
      ctx.learnerId,
      deepSessionOptions({ speechRateCapability: capability, targetCount: 2 }),
    );
    expect(session.plan.speechRate.rate).toBe(1);
    let state = initialPlaybackState('natural', capability);

    state = withSpeechRate(state, 'faster', capability);
    state = withSpeechRate(state, 'slower', capability);
    state = withSpeechRate(state, 'natural', capability);
    expect(state.speechRate.rate).toBe(1);
    expect(state.replayCount).toBe(0);
    expect(upserts).toBe(0);

    // The plan reflects the requested speed without touching evidence either.
    const fasterSession = await service.startDeepSession(
      ctx.learnerId,
      deepSessionOptions({ speechRateCapability: capability, speechRateLevel: 'faster', targetCount: 1 }),
    );
    expect(fasterSession.plan.speechRate.level).toBe('faster');
    expect(upserts).toBe(0);
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
  });

  it('11. replay creates no duplicate attempt or evidence', async () => {
    const ctx = await createContext('B1');
    let upserts = 0;
    const service = createService(ctx, { weaknessSpy: () => { upserts += 1; } });
    const activity = (await service.startDeepSession(ctx.learnerId, deepSessionOptions({ targetCount: 1 })))
      .activities[0];
    expect(activity).toBeDefined();

    // Five real audio plays in the UI: local state only.
    const capability = resolveSpeechRateCapability(createDemoTTSProvider());
    let state = initialPlaybackState(undefined, capability);
    for (let index = 0; index < 5; index += 1) {
      state = beginPlayback(state);
      state = finishPlayback(state);
    }
    expect(state.replayCount).toBe(5);
    expect(upserts).toBe(0);

    // A failed play is not even a replay.
    state = abortPlayback(beginPlayback(state));
    expect(state.replayCount).toBe(5);

    // ONE answer → at most ONE weakness per missed item, however many replays.
    const step = deepAnswerSteps(activity)[0];
    const first = await service.evaluateDeepAnswer(ctx.learnerId, activity, step.id, 'completely wrong', {
      replayCount: state.replayCount,
      now: NOW,
    });
    expect(first.evaluation).not.toBeNull();
    expect(first.evaluation!.result).not.toBe('understood');
    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceCount).toBe(1);

    // Answering again deduplicates into the SAME row (no duplicate evidence).
    await service.evaluateDeepAnswer(ctx.learnerId, activity, step.id, 'also wrong', {
      replayCount: state.replayCount,
      now: NOW,
    });
    const after = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20);
    expect(after).toHaveLength(1);
    expect(after[0].occurrenceCount).toBe(2);
  });
});

/* ================================================================== *
 * 12–13. Connected speech
 * ================================================================== */

describe('connected speech', () => {
  function b1Request(): DeepListeningRequest {
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    return deepRequestForTaskType(plan, 'connected_speech', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
  }

  it('12. a connected-speech activity keeps the canonical written meaning', async () => {
    const ctx = await createContext('B1');
    const request = b1Request();
    const outcome = await generateDeepListeningActivity(echoDeepProvider(), {
      learnerId: ctx.learnerId,
      request,
    });
    expect(outcome.failure).toBeNull();
    const activity = outcome.activity;
    if (!activity || activity.taskType !== 'connected_speech') throw new Error('no activity');
    expect(activity.items.length).toBeGreaterThanOrEqual(2);
    for (const item of activity.items) {
      // The answer IS the canonical written form — never the reduction.
      expect(item.expectedAnswer.toLowerCase()).toBe(item.writtenForm.toLowerCase());
      expect(item.expectedAnswer.toLowerCase()).not.toBe(item.spokenRealization.toLowerCase());
      expect(item.options ?? []).toContain(item.expectedAnswer);
      expect(item.explanation.length).toBeGreaterThan(0);
    }

    // The deterministic catalogue keeps the same rule.
    const catalogue = catalogueConnectedSpeechMaterial(request);
    for (const item of catalogue.items) {
      expect(item.expectedAnswer.toLowerCase()).toBe(item.writtenForm.toLowerCase());
    }
  });

  it('13. invald reduction mappings and register dishonesty are rejected', async () => {
    const ctx = await createContext('B1');
    const request = b1Request();

    const identical = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const items = payload.items as { writtenForm: string; spokenRealization: string }[];
          items[0] = { ...items[0], spokenRealization: items[0].writtenForm };
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(identical.failure).toBe('invalid_output');
    expect(identical.validationIssue).toBe('invalid_reduction_mapping');

    const phonetic = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const items = payload.items as { spokenRealization: string }[];
          items[0] = { ...items[0], spokenRealization: '/ˈɡənə/' };
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(phonetic.validationIssue).toBe('invalid_reduction_mapping');

    const formalReduction = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const items = payload.items as { category: string; register: string }[];
          const reduction = items.find((item) => item.category === 'reduction');
          if (reduction) reduction.register = 'formal';
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(formalReduction.validationIssue).toBe('register_dishonest');

    const wrongAnswer = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const items = payload.items as { spokenRealization: string; expectedAnswer: string }[];
          items[0] = { ...items[0], expectedAnswer: items[0].spokenRealization };
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(wrongAnswer.validationIssue).toBe('connected_speech_mismatch');
  });
});

/* ================================================================== *
 * 19–21. Deterministic contract
 * ================================================================== */

describe('deterministic content contract', () => {
  function b1DiscourseRequest(): DeepListeningRequest {
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    return deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
  }

  it('19. invalid generated answers and options are rejected', async () => {
    const ctx = await createContext('B1');
    const request = b1DiscourseRequest();

    const notDerivable = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const questions = payload.questions as { expectedAnswer: string }[];
          questions[0] = { ...questions[0], expectedAnswer: 'a completely invented fact' };
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(notDerivable.validationIssue).toBe('answer_not_derivable');

    const notInOptions = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const questions = payload.questions as { options?: string[] }[];
          const withOptions = questions.find((question) => question.options);
          if (withOptions?.options) withOptions.options = ['one', 'two', 'three'];
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(notInOptions.validationIssue).toBe('answer_not_in_options');

    const phantomEvidence = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const questions = payload.questions as { kind: string; evidenceSegmentIds: string[] }[];
          const detail = questions.find((question) => question.kind === 'detail');
          if (detail) detail.evidenceSegmentIds = ['t4'];
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(phantomEvidence.validationIssue).toBe('phantom_detail');

    const leaking = await generateDeepListeningActivity(
      echoDeepProvider({
        transform: (payload) => {
          const questions = payload.questions as { kind: string; prompt: string; expectedAnswer: string }[];
          const detail = questions.find((question) => question.kind === 'detail');
          if (detail) detail.prompt = `Did you hear ${detail.expectedAnswer}?`;
          return payload;
        },
      }),
      { learnerId: ctx.learnerId, request },
    );
    expect(leaking.validationIssue).toBe('answer_leakage');
  });

  it('20. a malformed AI payload is rejected', async () => {
    const request = b1DiscourseRequest();
    const malformed: AIProvider = {
      id: 'malformed',
      generate: async () => ({ ok: true, response: { content: 'not json at all' } }),
    };
    // A payload that only echoes the identity is structurally incomplete.
    expect(
      parseDeepListeningMaterial(request, { requestKey: request.requestKey, taskType: request.taskType }),
    ).toEqual({ ok: false, issue: 'invalid_enum' });
    expect(
      parseDeepListeningMaterial(request, {
        requestKey: 'someone-elses-key',
        taskType: 'long_discourse',
      }),
    ).toEqual({ ok: false, issue: 'request_key_mismatch' });
    expect(
      parseDeepListeningMaterial(request, { requestKey: request.requestKey, taskType: 'shadowing' }),
    ).toEqual({ ok: false, issue: 'unsupported_task_type' });

    const outcome = await generateDeepListeningActivity(malformed, { learnerId: 'learner', request });
    expect(outcome.failure).toBe('invalid_output');
    expect(outcome.validationIssue).toBe('unparseable_output');
  });

  it('21. the validator is deterministic for the same payload', () => {
    const request = b1DiscourseRequest();
    const payload = discoursePayload(request.requestKey, request.taskType, {
      minSpeakers: 1,
      maxSpeakers: 3,
      minSegments: 3,
      maxSegments: 6,
      maxWordsPerSegment: 26,
      maxWords: 95,
      minQuestions: 2,
      maxQuestions: 3,
      minOptions: 2,
      maxOptions: 3,
      minConnected: 3,
      maxConnected: 4,
      minChunk: 8,
      maxChunk: 12,
      questionKinds: request.questionKinds,
      categories: request.connectedSpeechCategories,
      shadowingSupport: request.shadowingSupport,
      discourseKind: request.discourseKind,
    });
    const first = parseDeepListeningMaterial(request, payload);
    const second = parseDeepListeningMaterial(request, payload);
    expect(second).toEqual(first);
    expect(first.ok).toBe(true);

    // The planner is deterministic too.
    const planA = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    const planB = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    expect(planB).toEqual(planA);
    expect(deepSessionSourceNote([])).toContain('unavailable');
  });

  it('the deterministic catalogue satisfies the same strict contract at every level', async () => {
    const ctx = await createContext('B1');
    for (const level of ['A1', 'B1', 'C1'] as const) {
      const session = await planDeepListeningSession(
        {
          weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
          vocabulary: ctx.vocabulary,
          expressions: ctx.expressions,
        },
        ctx.learnerId,
        {
          level,
          learningGoals: [],
          speechRateCapability: unsupportedRate(),
          now: NOW,
        },
      );
      expect(session.activities.length).toBeGreaterThan(0);
      for (const activity of session.activities) {
        const request = deepRequestForTaskType(session.plan, activity.taskType, {
          learningGoals: [],
          knownVocabulary: [],
          targetExpressions: [],
        })!;
        const result = parseDeepListeningMaterial(request, activityToRawMaterial(activity));
        const detail = result.ok ? '' : ` (${result.issue})`;
        expect(
          result.ok,
          `${level} / ${activity.taskType} catalogue entry must satisfy the contract${detail}`,
        ).toBe(true);
      }
    }
  });

  it('the canonical identity covers every field that changes generation', () => {
    const plan = resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() });
    const base = deepRequestForTaskType(plan, 'multi_speaker_dialogue', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
    const identity = (request: DeepListeningRequest) =>
      canonicalDeepRequestIdentity({
        taskType: request.taskType,
        ...(request.discourseKind !== undefined ? { discourseKind: request.discourseKind } : {}),
        level: request.level,
        supportLevel: request.supportLevel,
        grammarComplexity: request.difficultyProfile.grammarComplexity,
        discourseLength: request.difficultyProfile.discourseLength,
        newLanguageBudget: request.difficultyProfile.newLanguageBudget,
        evidenceAdjusted: request.difficultyProfile.evidenceAdjusted,
        bounds: request.bounds,
        questionKinds: request.questionKinds,
        connectedSpeechCategories: request.connectedSpeechCategories,
        shadowingSupport: request.shadowingSupport,
        knownVocabulary: request.knownVocabulary,
        targetExpressions: request.targetExpressions,
        context: request.context,
      });

    expect(identity(base)).toBe(identity(base));
    const adjusted: DeepListeningRequest = {
      ...base,
      difficultyProfile: { ...base.difficultyProfile, evidenceAdjusted: true },
    };
    expect(identity(adjusted)).not.toBe(identity(base));
    // Array order and casing normalize away.
    const reordered: DeepListeningRequest = {
      ...base,
      questionKinds: [...base.questionKinds].reverse(),
    };
    expect(identity(reordered)).not.toBe(identity(base));
    const built = buildDeepListeningRequest({
      difficultyProfile: base.difficultyProfile,
      taskType: base.taskType,
      bounds: base.bounds,
      ...(base.discourseKind !== undefined ? { discourseKind: base.discourseKind } : {}),
      questionKinds: base.questionKinds,
      connectedSpeechCategories: base.connectedSpeechCategories,
      shadowingSupport: base.shadowingSupport,
      context: { learningGoals: ['JOB INTERVIEWS', 'job interviews'] },
    });
    expect(built.status).toBe('ok');
    if (built.status === 'ok') {
      expect(built.request.context.learningGoals).toEqual(['job interviews']);
    }
  });

  it('the deterministic validator rejects dishonest topics and metadata', () => {
    const request = b1DiscourseRequest();
    const payload = discoursePayload(request.requestKey, request.taskType, {
      minSpeakers: 1,
      maxSpeakers: 3,
      minSegments: 3,
      maxSegments: 6,
      maxWordsPerSegment: 26,
      maxWords: 95,
      minQuestions: 2,
      maxQuestions: 3,
      minOptions: 2,
      maxOptions: 3,
      minConnected: 3,
      maxConnected: 4,
      minChunk: 8,
      maxChunk: 12,
      questionKinds: request.questionKinds,
      categories: request.connectedSpeechCategories,
      shadowingSupport: request.shadowingSupport,
      discourseKind: request.discourseKind,
    });
    // A topic claimed for a request that established none is dishonest.
    expect(
      parseDeepListeningMaterial(request, { ...payload, contextTopic: 'office life' }),
    ).toEqual({ ok: false, issue: 'context_dishonest' });
    // Raw generation metadata may never reach learner-facing text.
    expect(
      parseDeepListeningMaterial(request, {
        ...payload,
        explanation: 'taskType: long_discourse and requestKey are internal',
      }),
    ).toEqual({ ok: false, issue: 'internal_metadata' });
    // Placeholders are never acceptable content.
    expect(
      parseDeepListeningMaterial(request, { ...payload, explanation: 'TODO' }),
    ).toEqual({ ok: false, issue: 'placeholder_text' });
    // No level band, percentage or score claim.
    expect(
      parseDeepListeningMaterial(request, { ...payload, explanation: 'You are now B2 at 90%.' }),
    ).toEqual({ ok: false, issue: 'forbidden_claim' });
    // A request WITH a topic accepts exactly that topic.
    const topicRequest = deepRequestForTaskType(
      resolveDeepListeningPlan({ level: 'B1', evidence: null, speechRateCapability: unsupportedRate() }),
      'multi_speaker_dialogue',
      { learningGoals: [], knownVocabulary: [], targetExpressions: [], topic: 'office planning' },
    )!;
    const topicPayload = discoursePayload(topicRequest.requestKey, topicRequest.taskType, {
      minSpeakers: 1,
      maxSpeakers: 3,
      minSegments: 3,
      maxSegments: 6,
      maxWordsPerSegment: 26,
      maxWords: 95,
      minQuestions: 2,
      maxQuestions: 3,
      minOptions: 2,
      maxOptions: 3,
      minConnected: 3,
      maxConnected: 4,
      minChunk: 8,
      maxChunk: 12,
      questionKinds: topicRequest.questionKinds,
      categories: topicRequest.connectedSpeechCategories,
      shadowingSupport: topicRequest.shadowingSupport,
      discourseKind: topicRequest.discourseKind,
    }, 'office planning');
    expect(parseDeepListeningMaterial(topicRequest, topicPayload).ok).toBe(true);
    expect(
      parseDeepListeningMaterial(topicRequest, { ...topicPayload, contextTopic: 'space travel' }),
    ).toEqual({ ok: false, issue: 'context_dishonest' });
  });

  it('the prompt is honest about bounds, topics and speed claims', () => {
    const plan = resolveDeepListeningPlan({ level: 'A1', evidence: null, speechRateCapability: unsupportedRate() });
    const request = deepRequestForTaskType(plan, 'long_discourse', {
      learningGoals: [],
      knownVocabulary: [],
      targetExpressions: [],
    })!;
    const prompt = buildDeepMaterialPrompt(request);
    const text = prompt.messages.map((message) => message.content).join('\n');
    expect(text).toContain('No topic was established for this material');
    expect(text).toContain('Never use phonetic symbols or IPA');
    expect(text).toContain('words per minute');
    expect(text).toContain('Questions: between 1 and 2.');
    expect(text).toMatch(/"requestKey":\s*"[0-9a-f-]+"/);
  });
});

/* ================================================================== *
 * 22–23. Adaptive difficulty + existing LearnerModel
 * ================================================================== */

describe('adaptive deep difficulty', () => {
  it('22. the learner level changes the bounded difficulty', async () => {
    const ctx = await createContext('A1');
    const deps = {
      weaknesses: { listWeaknesses: (id: string, limit: number) => ctx.weaknesses.listWeaknesses(id, limit) },
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
    };
    const easy = await planDeepListeningSession(deps, ctx.learnerId, {
      level: 'A1',
      learningGoals: [],
      speechRateCapability: unsupportedRate(),
      now: NOW,
    });
    const hard = await planDeepListeningSession(deps, ctx.learnerId, {
      level: 'C1',
      learningGoals: [],
      speechRateCapability: unsupportedRate(),
      now: NOW,
    });

    expect(easy.plan.bounds.maxQuestions).toBeLessThan(hard.plan.bounds.maxQuestions);
    expect(easy.plan.bounds.maxWords).toBeLessThan(hard.plan.bounds.maxWords);
    expect(easy.plan.shadowingSupport).toBe('full_transcript');
    expect(hard.plan.shadowingSupport).toBe('audio_only');
    expect(easy.plan.taskTypes[0]).toBe('long_discourse');
    expect(hard.plan.taskTypes[0]).toBe('multi_speaker_dialogue');
    expect(easy.plan.discourseKind).not.toBe(hard.plan.discourseKind);

    const easyShadowing = easy.activities.find((activity) => activity.taskType === 'shadowing');
    const hardShadowing = hard.activities.find((activity) => activity.taskType === 'shadowing');
    if (!easyShadowing || easyShadowing.taskType !== 'shadowing') throw new Error('no shadowing');
    if (!hardShadowing || hardShadowing.taskType !== 'shadowing') throw new Error('no shadowing');
    const wordsOf = (activity: ShadowingListeningActivity) =>
      activity.chunk.trim().split(/\s+/).filter(Boolean).length;
    expect(wordsOf(easyShadowing)).toBeLessThan(wordsOf(hardShadowing));
    expect(easy.activities.length).toBe(3);

    // The bands themselves are monotone.
    expect(SOLO_DISCOURSE_KINDS.length).toBeGreaterThan(0);
    expect(MULTI_SPEAKER_DISCOURSE_KINDS.length).toBeGreaterThanOrEqual(2);
    expect(DISCOURSE_KINDS).toContain('meeting_excerpt');
  });

  it('23. real listening weakness influences the plan through the existing evidence path', async () => {
    const ctx = await createContext('B1');
    await seedListeningWeakness(ctx, 'deadline');
    const deps = {
      weaknesses: { listWeaknesses: (id: string, limit: number) => ctx.weaknesses.listWeaknesses(id, limit) },
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
    };
    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20);
    expect(retrainingObjective(rows)).toBe('deadline');

    const session = await planDeepListeningSession(deps, ctx.learnerId, {
      level: 'B1',
      learningGoals: [],
      speechRateCapability: unsupportedRate(),
      now: NOW,
    });
    expect(session.plan.focus).toBe('listening_weakness_retraining');
    expect(session.plan.evidenceAdjusted).toBe(true);
    expect(session.plan.band).toBe('supported');
    // More support than the same level without evidence (moderate → high).
    expect(session.plan.supportLevel).toBe('high');
    expect(
      resolveDifficultyProfile('B1', null, 'listening').supportLevel,
    ).toBe('moderate');
    expect(session.plan.shadowingSupport).toBe('full_transcript');

    // The real weakness target reaches the generation prompt as the objective.
    const captured = { prompts: [] as string[] };
    const service = createService(ctx, {
      aiProvider: echoDeepProvider({ captured }),
    });
    await service.startDeepSession(
      ctx.learnerId,
      deepSessionOptions({ allowGeneratedContent: true, targetCount: 1 }),
    );
    expect(captured.prompts.join('\n')).toContain('Listening objective to serve: deadline');
  });
});

/* ================================================================== *
 * 24–27. Phase-1 compatibility + no second engine/voice stack
 * ================================================================== */

function phaseOneExercise(overrides: Partial<ListeningExercise> = {}): ListeningExercise {
  return {
    id: 'phase1',
    learnerId: 'learner',
    type: 'listen_and_type',
    difficulty: 'easy',
    speakText: 'I usually drink coffee in the morning.',
    expectedAnswer: 'I usually drink coffee in the morning',
    keyItems: ['coffee', 'morning'],
    source: 'general',
    ...overrides,
  };
}

describe('existing behaviour stays intact', () => {
  it('24. the five Phase-1 listening types remain supported', async () => {
    const ctx = await createContext('B1');
    const session = await planListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      { now: NOW },
    );
    const phaseOneTypes = [
      'listen_and_type',
      'listen_and_answer',
      'listen_and_choose',
      'missing_word',
      'expression_in_context',
    ];
    for (const exercise of session.exercises) expect(phaseOneTypes).toContain(exercise.type);
    // No deep task type ever leaks into the Phase-1 session.
    for (const exercise of session.exercises) {
      expect(['long_discourse', 'multi_speaker_dialogue', 'connected_speech', 'shadowing']).not.toContain(
        exercise.type,
      );
    }
    expect(GENERAL_TEMPLATES.length).toBe(8);
  });

  it('25. listening first-meaning integrity is unchanged', async () => {
    const ctx = await createContext('B1');
    const service = createService(ctx);
    const exercise = phaseOneExercise();
    const { evaluation } = await service.evaluateAnswer(ctx.learnerId, exercise, 'I usually drink coffee in the morning', {
      now: NOW,
    });
    expect(evaluation.result).toBe('understood');
    expect(evaluation.revealedTranscript).toBe(exercise.speakText);
    expect(evaluateListenAndType(exercise, '').result).toBe('insufficient_evidence');

    // Deep activities are opt-in: the Phase-1 session has none, and a deep
    // session contains no Phase-1 exercise shape.
    const phaseOne = await service.startSession(ctx.learnerId, { now: NOW });
    const phaseOneTypes = [
      'listen_and_type',
      'listen_and_answer',
      'listen_and_choose',
      'missing_word',
      'expression_in_context',
    ];
    expect(phaseOne.exercises.every((entry) => phaseOneTypes.includes(entry.type))).toBe(true);
    const deep = await service.startDeepSession(ctx.learnerId, deepSessionOptions({ targetCount: 1 }));
    for (const activity of deep.activities) {
      expect(['long_discourse', 'multi_speaker_dialogue', 'connected_speech', 'shadowing']).toContain(
        activity.taskType,
      );
    }
    // A deep step can never be answered through a step that does not exist.
    const shadowingActivity = (await service.startDeepSession(ctx.learnerId, deepSessionOptions({
      targetCount: 1,
      taskTypes: ['shadowing'],
    }))).activities[0];
    expect(shadowingActivity.taskType).toBe('shadowing');
    const missing = await service.evaluateDeepAnswer(ctx.learnerId, shadowingActivity, 'nope', 'x', { now: NOW });
    expect(missing.evaluation).toBeNull();
    expect(deepStepById(shadowingActivity, 'nope')).toBeNull();
  });

  it('26. the Adaptive Lessons integration stays compatible', async () => {
    const ctx = await createContext('B1');
    const service = createService(ctx);
    // The Adaptive Lessons call shape (targetCount + now, NO deep options).
    const planned = await service.startSession(ctx.learnerId, { targetCount: 2, now: NOW });
    expect(planned.exercises.length).toBeGreaterThan(0);
    expect(planned.exercises.length).toBeLessThanOrEqual(2);
    expect(planned.sourceNote.length).toBeGreaterThan(0);
    // Deep planning must not run implicitly.
    const deep = await service.startDeepSession(ctx.learnerId, deepSessionOptions({ targetCount: 1 }));
    expect(deep.activities[0].taskType).not.toBe('listen_and_type');
  });

  it('27a. the deep UI reuses the existing stacks and offers no score', () => {
    const screenSource = readFileSync(join(__dirname, '..', '..', 'screens', 'ListeningScreen.tsx'), 'utf8');
    const panelSource = readFileSync(
      join(__dirname, '..', '..', 'screens', 'listening', 'DeepListeningPanel.tsx'),
      'utf8',
    );
    // The Phase-1 screen keeps its existing wiring and gains the deep tab.
    expect(screenSource).toContain('DeepListeningPanel');
    expect(screenSource).toContain('Deep listening');
    expect(screenSource).toContain("import('../talk-demo')");
    expect(screenSource).not.toMatch(/expo-av/i);

    // The panel drives the EXISTING providers and the deep helpers.
    expect(panelSource).toContain("import('../../talk-demo')");
    expect(panelSource).toContain('playShadowingChunk');
    expect(panelSource).toContain('resolveSpeechRateCapability');
    expect(panelSource).toContain('speechRateTTSOptions');
    expect(panelSource).toContain('submitShadowingAttempt');
    expect(panelSource).toContain('speechRate.levels.length > 1');
    expect(panelSource).not.toMatch(/expo-av|expo-audio/i);
    // No numeric scoring language in the deep UI's rendered strings (comments
    // are allowed to explain the rule they enforce).
    const panelCode = panelSource
      .split('\n')
      .filter((line: string) => !/^\s*(\/\*|\*|\/\/)/.test(line))
      .join('\n');
    expect(panelCode).not.toMatch(/\d+\s*%|\bscore\b|\brating\b|\bwpm\b/i);
  });

  it('27. there is no second voice stack, recorder or pronunciation engine', () => {
    const files = [
      'types.ts',
      'request.ts',
      'validation.ts',
      'prompt.ts',
      'generation.ts',
      'catalogue.ts',
      'planner.ts',
      'speakers.ts',
      'speech-rate.ts',
      'shadowing.ts',
      'evaluation.ts',
    ];
    for (const file of files) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source).not.toMatch(/expo-av|expo-audio|createExpoTTSProvider|createDemoTTSProvider|new Audio/i);
      expect(source).not.toMatch(/createExpoRecorder|new ExpoRecorder/);
      // Deep code only ACCEPTS the existing abstractions.
      expect(source).not.toMatch(/from 'expo-speech'/);
    }
    const serviceSource = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
    expect(serviceSource).toContain('syntheticExerciseForStep');
    expect(serviceSource).toContain('this.evaluateAnswer(learnerId, exercise, answer');
    // Shadowing routes through the existing pronunciation port only.
    const shadowingSource = readFileSync(join(__dirname, 'shadowing.ts'), 'utf8');
    expect(shadowingSource).toContain('analyzeSpokenTurn');
    expect(shadowingSource).not.toMatch(/\b(score|percentage|rating)\s*[:=]/i);
  });

describe('DeepListeningPanel lifecycle & voice composition hardening', () => {
  it('28. DeepListeningPanel disposes shadowing voice controller and cancels active work on activity change/exit', async () => {
    const screenSource = readFileSync(
      join(__dirname, '..', '..', 'screens', 'listening', 'DeepListeningPanel.tsx'),
      'utf8',
    );
    expect(screenSource).toContain('shadowingTokenRef');
    expect(screenSource).toContain('resolveVoiceInput');
    expect(screenSource).toContain('activeController?.dispose()');
    expect(screenSource).toContain('ttsRef.current?.stop()');
  });
});

});
