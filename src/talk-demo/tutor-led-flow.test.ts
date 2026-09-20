/**
 * src/talk-demo/tutor-led-flow.test.ts
 *
 * Natural Voice Conversation Phase 2 — Tutor-Led Conversational Flow.
 *
 * These tests exercise the Talk feature through the EXISTING systems only:
 * ConversationEngine, ConversationOrchestrator, ConversationSession,
 * VoiceSessionCoordinator, the existing recorder/STT/TTS providers, the
 * existing Gemini/Demo AI providers, the existing LearnerModel and the
 * existing PronunciationEngine. No second conversation/adaptive/persistence
 * engine is introduced anywhere in the flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';
import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import {
  createConversationSession,
  CONVERSATION_OPENING_DISCARDED_MESSAGE,
} from '../conversation-session';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createPronunciationEngine, type PronunciationEngine } from '../pronunciation';
import type {
  AIProvider,
  AIProviderResult,
  ConversationFeedback,
  ConversationRequest,
} from '../providers/ai';
import { createDemoSTTProvider } from '../providers/stt';
import type { SpeechToTextProvider, STTAudioInput, STTResult } from '../providers/stt';
import { createDemoTTSProvider } from '../providers/tts/demo';
import type { TextToSpeechProvider, TTSOptions } from '../providers/tts';
import { createDemoAudioRecorder, DemoAudioRecorder } from '../voice/recorder';
import {
  createVoiceSessionCoordinator,
  describeVoiceTurn,
  VOICE_SESSION_CHANGED_MESSAGE,
  type VoiceState,
  type VoiceStatus,
} from '../voice';
import {
  createTalkLearnerModel,
  createTalkSession,
  createTalkVoiceCoordinator,
  TALK_REAL_STT_UNAVAILABLE_MESSAGE,
} from '.';
import { createDemoLearnerModel } from './demo-learner-model';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-01-15T10:00:00.000Z';

/** Let pending microtasks/timers run. */
async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** STT wrapper that records the audio it was handed. */
function createSpySTT(inner: SpeechToTextProvider): SpeechToTextProvider & {
  readonly calls: readonly STTAudioInput[];
} {
  const calls: STTAudioInput[] = [];
  return {
    id: `spy:${inner.id}`,
    calls,
    async transcribe(audio: STTAudioInput): Promise<STTResult> {
      calls.push(audio);
      return inner.transcribe(audio);
    },
  };
}

/**
 * Recorder that tolerates repeated stop calls (returns the audio again instead
 * of throwing) — models a permissive native recorder so the coordinator's
 * single-turn guarantee can be tested independently of the recorder.
 */
class PermissiveRecorder extends DemoAudioRecorder {
  private readonly permissiveLastResult = {
    uri: 'file:///mock/permissive-audio.m4a',
    base64: 'cGVybWlzc2l2ZS1hdWRpbw==',
    mimeType: 'audio/m4a',
    durationMs: 1500,
  };

  override async stopRecording() {
    try {
      return await super.stopRecording();
    } catch {
      return this.permissiveLastResult;
    }
  }
}

/**
 * Recorder whose cleanup can be held open, so a session switch can be observed
 * while the OLD recorder is still shutting down.
 */
class GatedRecorder extends DemoAudioRecorder {
  private stopResolvers: (() => void)[] = [];
  private releasePermissionFn: (() => void) | null = null;
  private granted = true;
  holdStop = false;
  holdPermission = false;

  /** Model an ungranted microphone so requestPermissions() is really used. */
  requireRequest(): void {
    this.granted = false;
    this.setPermission(false);
  }

  override async hasPermissions(): Promise<boolean> {
    return this.granted;
  }

  override async requestPermissions(): Promise<boolean> {
    if (this.holdPermission) {
      await new Promise<void>((resolve) => {
        this.releasePermissionFn = resolve;
      });
    }
    this.granted = true;
    this.setPermission(true);
    return true;
  }

  override async stopRecording() {
    if (this.holdStop) {
      await new Promise<void>((resolve) => {
        this.stopResolvers.push(resolve);
      });
    }
    return super.stopRecording();
  }

  releaseStop(): void {
    const pending = this.stopResolvers;
    this.stopResolvers = [];
    for (const release of pending) release();
  }

  releasePermission(): void {
    const release = this.releasePermissionFn;
    this.releasePermissionFn = null;
    release?.();
  }
}

/**
 * TTS whose `stop()` can be held open (playback cleanup in flight) while it can
 * still start new playback — the exact shape of the reset/session race.
 */
class GatedTTS implements TextToSpeechProvider {
  readonly id = 'gated-tts';
  readonly log: string[] = [];
  holdStop = false;
  private holdNextStopFlag = false;
  private active = false;
  private speakToken = 0;
  private releaseStopFns: (() => void)[] = [];
  private resolveSpoken: (() => void) | null = null;

  async speak(text: string, options?: TTSOptions): Promise<void> {
    const token = (this.speakToken += 1);
    this.active = true;
    this.log.push(`speak:${text.slice(0, 14)}`);
    options?.onStart?.();
    await new Promise<void>((resolve) => {
      this.resolveSpoken = resolve;
    });
    // A newer playback started while this one was pending: it is not ours to end.
    if (this.speakToken !== token) return;
    this.active = false;
    this.log.push('done');
    options?.onDone?.();
  }

  /** Hold ONLY the next stop, so newer cleanup can still proceed. */
  holdNextStop(): void {
    this.holdNextStopFlag = true;
  }

  async stop(): Promise<void> {
    this.log.push('stop');
    // A stop only ever ends the playback that was active when it was requested.
    const tokenAtStop = this.speakToken;
    const gated = this.holdStop || this.holdNextStopFlag;
    this.holdNextStopFlag = false;
    if (gated) {
      await new Promise<void>((resolve) => {
        this.releaseStopFns.push(resolve);
      });
    }
    if (this.speakToken !== tokenAtStop) return;
    this.active = false;
    const resolve = this.resolveSpoken;
    this.resolveSpoken = null;
    resolve?.();
  }

  async isSpeaking(): Promise<boolean> {
    return this.active;
  }

  releaseStop(): void {
    const pending = this.releaseStopFns;
    this.releaseStopFns = [];
    for (const release of pending) release();
  }
}

/** AI provider whose FIRST call is deferred and whose later calls answer at once. */
function createDeferredFirstProvider(
  firstReply: string,
  immediateReply = 'Understood — what happened next?',
  firstFeedback: ConversationFeedback | null = null,
): AIProvider & { resolveFirst: () => void; readonly requests: number } {
  let resolveFirst: ((result: AIProviderResult) => void) | null = null;
  const state = { requests: 0 };
  return {
    id: 'deferred-first-ai',
    get requests() {
      return state.requests;
    },
    resolveFirst: () => {
      resolveFirst?.({
        ok: true,
        response: { content: firstReply, feedback: firstFeedback },
      });
    },
    async generate(): Promise<AIProviderResult> {
      state.requests += 1;
      if (state.requests === 1) {
        return new Promise<AIProviderResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { ok: true, response: { content: immediateReply } };
    },
  };
}

/** Tick until the predicate holds (bounded): used for in-flight landmarks. */
async function waitFor(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('waitFor: the expected state was never reached');
}

/** TTS that keeps "speaking" until it is stopped — used for barge-in tests. */
class HangingTTS implements TextToSpeechProvider {
  readonly id = 'hanging-tts';
  readonly log: string[] = [];
  private active = false;
  private resolveDone: (() => void) | null = null;

  async speak(text: string, options?: TTSOptions): Promise<void> {
    this.active = true;
    this.log.push(`speak:${text.slice(0, 12)}`);
    options?.onStart?.();
    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    this.active = false;
    this.log.push('done');
    options?.onDone?.();
  }

  async stop(): Promise<void> {
    if (this.active) {
      this.log.push('stop');
    }
    this.active = false;
    const resolve = this.resolveDone;
    this.resolveDone = null;
    resolve?.();
  }

  async isSpeaking(): Promise<boolean> {
    return this.active;
  }
}

/** TTS whose playback always fails — the turn itself must survive. */
function createFailingTTS(): TextToSpeechProvider {
  return {
    id: 'failing-tts',
    async speak(): Promise<void> {
      throw new Error('speech engine unavailable');
    },
    async stop(): Promise<void> {
      // no-op
    },
    async isSpeaking(): Promise<boolean> {
      return false;
    },
  };
}

/** AI provider returning a fixed learner-facing reply (no network). */
function createStubProvider(
  content: string,
  feedback: ConversationFeedback | null = null,
): AIProvider & { readonly requests: readonly ConversationRequest[] } {
  const requests: ConversationRequest[] = [];
  return {
    id: 'stub-ai',
    requests,
    async generate(request: ConversationRequest): Promise<AIProviderResult> {
      requests.push(request);
      return { ok: true, response: { content, feedback } };
    },
  };
}

/** AI provider that always fails (honest failure path). */
function createFailingProvider(): AIProvider {
  return {
    id: 'failing-ai',
    async generate(): Promise<AIProviderResult> {
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'The tutor is unavailable right now.',
          retryable: true,
        },
      };
    },
  };
}

/** AI provider whose reply is resolved manually (late-result races). */
function createDeferredProvider(): AIProvider & { resolve: (content: string) => void } {
  let resolveResult: ((result: AIProviderResult) => void) | null = null;
  return {
    id: 'deferred-ai',
    resolve: (content: string) => {
      resolveResult?.({ ok: true, response: { content } });
    },
    async generate(): Promise<AIProviderResult> {
      return new Promise<AIProviderResult>((resolve) => {
        resolveResult = resolve;
      });
    },
  };
}

/**
 * Compose the EXISTING session stack around a test provider, optionally with a
 * caller-provided learner model (defaults to the existing demo learner model).
 */
function buildSessionWithProvider(
  provider: AIProvider,
  mode: 'natural' | 'coach' | 'intensive' = 'natural',
  topic?: string,
  learnerModel?: Parameters<typeof createConversationEngine>[0],
) {
  const engine = createConversationEngine(learnerModel ?? createDemoLearnerModel());
  const orchestrator = createConversationOrchestrator(engine, provider);
  return createConversationSession(orchestrator, { mode, topic });
}

function createTalkFlow<T extends TextToSpeechProvider = ReturnType<typeof createDemoTTSProvider>>(
  options: {
    provider?: AIProvider;
    stt?: SpeechToTextProvider;
    tts?: T;
    recorder?: ReturnType<typeof createDemoAudioRecorder> | GatedRecorder | PermissiveRecorder;
    mode?: 'natural' | 'coach' | 'intensive';
  } = {},
) {
  // Without an injected provider this helper exercises the EXPLICIT offline
  // demo conversation — Demo Mode is requested, never assumed.
  const session = options.provider
    ? buildSessionWithProvider(options.provider, options.mode ?? 'natural')
    : createTalkSession({ mode: options.mode ?? 'natural' }, { isDemo: true }).session;
  const recorder = options.recorder ?? createDemoAudioRecorder();
  const stt = options.stt ?? createDemoSTTProvider({ defaultTranscript: 'Hello there.' });
  const tts = (options.tts ?? createDemoTTSProvider()) as T;
  const coordinator = createVoiceSessionCoordinator({
    session,
    recorder,
    sttProvider: stt,
    ttsProvider: tts,
  });
  return { session, recorder, stt, tts, coordinator };
}

/** Mocked Gemini fetch returning the given replies in order. */
function createGeminiFetch(textReplies: string[]) {
  const calls: { body: Record<string, unknown> }[] = [];
  const mockFetch: typeof fetch = vi.fn(async (_input, init) => {
    const body = JSON.parse((init?.body as string) || '{}');
    calls.push({ body });
    const reply = textReplies[Math.min(calls.length - 1, textReplies.length - 1)];
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: reply }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return { mockFetch, calls };
}

describe('Talk — tutor-led conversational flow', () => {
  const originalEnvKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  });

  afterEach(() => {
    if (typeof originalEnvKey === 'string') {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = originalEnvKey;
    } else {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    }
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────── turn flow

  it('1. a spoken turn goes through the existing STT provider and ConversationSession', async () => {
    const { mockFetch, calls } = createGeminiFetch([
      'That sounds fun! What did you enjoy most?',
    ]);
    const bundle = createTalkSession(
      { mode: 'natural', topic: 'Weekend plans' },
      { apiKey: 'mock-key', fetchImpl: mockFetch },
    );
    const stt = createSpySTT(
      createDemoSTTProvider({ defaultTranscript: 'I visited my family on Friday.' }),
    );
    const tts = createDemoTTSProvider();
    const coordinator = createVoiceSessionCoordinator({
      session: bundle.session,
      recorder: createDemoAudioRecorder(),
      sttProvider: stt,
      ttsProvider: tts,
    });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(true);
    // The audio from the EXISTING recorder reached the EXISTING STT provider…
    expect(stt.calls).toHaveLength(1);
    // …and the recognized transcript became the learner turn of the session.
    const history = bundle.session.getHistory();
    expect(history.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(history[0].content).toBe('I visited my family on Friday.');
    // The reply came from the real AI request path using the engine's system prompt.
    expect(calls).toHaveLength(1);
    const systemInstruction = calls[0].body.systemInstruction as {
      parts: { text: string }[];
    };
    expect(systemInstruction.parts[0].text).toContain('Mode: Natural Conversation');
    expect(history[1].content).toBe('That sounds fun! What did you enjoy most?');
  });

  it('2. one learner utterance produces at most one submitted user turn', async () => {
    const { session, recorder, coordinator } = createTalkFlow({
      recorder: new PermissiveRecorder(),
      // Even a recorder that happily returns audio twice must not produce two turns.
      stt: createDemoSTTProvider({ defaultTranscript: 'Only once, please.', delayMs: 5 }),
    });

    await coordinator.startRecording();
    // A double tap on the mic must not submit the same audio twice.
    const [first, second] = await Promise.all([
      coordinator.stopRecordingAndProcess(),
      coordinator.stopRecordingAndProcess(),
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);

    const userTurns = session.getHistory().filter((turn) => turn.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0].content).toBe('Only once, please.');
    expect(recorder.isRecording()).toBe(false);
  });

  it('3. the tutor reply is produced by the existing AI provider through the session', async () => {
    const provider = createStubProvider('Nice! How did that go for you?');
    const { session, coordinator } = createTalkFlow({ provider });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();

    expect(provider.requests).toHaveLength(1);
    // The request is the existing engine contract (system prompt + history + user message).
    expect(provider.requests[0].messages.at(-1)).toEqual({
      role: 'user',
      content: 'Hello there.',
    });
    expect(provider.requests[0].systemPrompt).toContain('Mode: Natural Conversation');
    expect(session.getHistory().at(-1)?.content).toBe('Nice! How did that go for you?');
  });

  // ────────────────────────────────────────────────────── spoken reply purity

  it('4. TTS speaks the learner-facing tutor reply', async () => {
    const { tts, coordinator } = createTalkFlow({
      provider: createStubProvider('Lovely — tell me more about your day.'),
    });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();

    expect(tts.getSpokenTexts()).toHaveLength(1);
    expect(tts.getSpokenTexts()[0]).toBe('Lovely — tell me more about your day.');
  });

  it('5. feedback JSON and hidden metadata are never spoken, but stay in the feedback UI', async () => {
    const feedbackPayload = JSON.stringify({
      correction: {
        original: 'I went to meeting yesterday',
        improved: 'I went to a meeting yesterday',
        explanation: 'Use an article before a singular countable noun.',
        severity: 'incorrect',
      },
      vocabulary: {
        headword: 'catch up',
        type: 'phrasal_verb',
        meaning: 'to talk with someone after time apart',
        example: 'Let us catch up next week.',
      },
      coachingNote: null,
    });
    const { mockFetch } = createGeminiFetch([
      `Great, thanks for telling me! What happened next?\n[FEEDBACK]${feedbackPayload}[/FEEDBACK]`,
    ]);
    const bundle = createTalkSession(
      { mode: 'coach' },
      { apiKey: 'mock-key', fetchImpl: mockFetch },
    );
    const tts = createDemoTTSProvider();
    const coordinator = createVoiceSessionCoordinator({
      session: bundle.session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'I went to meeting yesterday' }),
      ttsProvider: tts,
    });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();
    expect(result.ok).toBe(true);

    const spoken = tts.getSpokenTexts();
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toBe('Great, thanks for telling me! What happened next?');
    expect(spoken[0]).not.toContain('[FEEDBACK]');
    expect(spoken[0]).not.toContain('[/FEEDBACK]');
    expect(spoken[0]).not.toContain('{');
    expect(spoken[0]).not.toContain('severity');
    expect(spoken[0]).not.toContain('usageMetadata');
    // Internal analysis never becomes part of the persisted conversation either.
    expect(bundle.session.getHistory().at(-1)?.content).not.toContain('[FEEDBACK]');

    // Structured feedback is available to the visible feedback panel instead.
    expect(bundle.session.getLastFeedback()?.correction?.improved).toBe(
      'I went to a meeting yesterday',
    );
  });

  // ──────────────────────────────────────────────────────────── interruption

  it('6. tutor playback is stopped before the microphone opens (barge-in)', async () => {
    const tts = new HangingTTS();
    const { recorder, coordinator } = createTalkFlow({ tts });

    const speaking = coordinator.speakResponse('Hello! Tell me about your weekend.');
    await tick();
    expect(coordinator.getStatus().state).toBe('speaking');
    expect(tts.log).toEqual(['speak:Hello! Tell ']);

    const started = await coordinator.startRecording();
    expect(started).toBe(true);

    // TTS was stopped first, and only then did the recorder start.
    expect(tts.log[0]).toBe('speak:Hello! Tell ');
    expect(tts.log[1]).toBe('stop');
    expect(coordinator.getStatus().state).toBe('recording');
    expect(recorder.isRecording()).toBe(true);

    await speaking;
  });

  it('7. tutor playback and the microphone are never active at the same time', async () => {
    const tts = new HangingTTS();
    const { recorder, coordinator } = createTalkFlow({ tts });

    const speaking = coordinator.speakResponse('Interrupt me whenever you like.');
    await tick();
    expect(await tts.isSpeaking()).toBe(true);

    await coordinator.startRecording();
    // The mic is open and no playback is running.
    expect(recorder.isRecording()).toBe(true);
    expect(await tts.isSpeaking()).toBe(false);

    // The reverse direction is guarded too: replaying while recording must not
    // start playback over the open microphone.
    await coordinator.speakResponse('This must not play over the microphone.');
    expect(await tts.isSpeaking()).toBe(false);
    expect(coordinator.getStatus().state).toBe('recording');
    expect(tts.log).not.toContain('speak:This must no');

    await coordinator.stopSpeaking();
    await speaking;
  });

  it('7b. the microphone stays available while the tutor is speaking, and interrupting keeps one clean history', async () => {
    const provider = createStubProvider('Tell me about your weekend!');
    const tts = new HangingTTS();
    const { session, recorder, coordinator } = createTalkFlow({ provider, tts });

    await coordinator.startRecording();
    const turn = coordinator.stopRecordingAndProcess();
    await tick(3);

    // Tutor playback is running…
    expect(coordinator.getStatus().state).toBe('speaking');
    // …the conversational turn is already complete (not "in flight")…
    expect(coordinator.getStatus().isProcessing).toBe(false);
    // …and the learner can interrupt with the microphone (barge-in is allowed).
    expect(coordinator.getStatus().canRecord).toBe(true);

    const bargedIn = await coordinator.startRecording();
    expect(bargedIn).toBe(true);
    expect(await tts.isSpeaking()).toBe(false);
    expect(recorder.isRecording()).toBe(true);

    // The interrupted turn is still intact exactly once: user + tutor reply.
    const result = await turn;
    expect(result.ok).toBe(true);
    const history = session.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('Hello there.');
    expect(history[1].content).toBe('Tell me about your weekend!');

    await coordinator.stopSpeaking();
  });

  // ─────────────────────────────────────────────────── learner-ready state

  it('8. after the tutor finishes speaking the learner is in a clean ready state', async () => {
    const { recorder, tts, coordinator } = createTalkFlow({
      provider: createStubProvider('Great! What will you do next?'),
    });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();
    await tick();

    expect(tts.getSpokenTexts()).toHaveLength(1);

    const status = coordinator.getStatus();
    expect(status.state).toBe('idle');
    expect(status.isSpeaking).toBe(false);
    expect(status.isProcessing).toBe(false);
    expect(status.canRecord).toBe(true);

    const view = describeVoiceTurn(status);
    expect(view.phase).toBe('ready');
    expect(view.micIsPrimary).toBe(true);
    expect(view.label).toBe('Your turn');

    // The microphone is offered as the obvious next action but never opened
    // automatically: recording only starts on an explicit tap.
    expect(recorder.isRecording()).toBe(false);
  });

  it('9. every voice lifecycle phase maps to an obvious learner-facing state', () => {
    const base: VoiceStatus = {
      state: 'idle',
      elapsedSeconds: 0,
      recognizedTranscript: null,
      errorMessage: null,
      isMuted: false,
      isSpeaking: false,
      canRecord: true,
      canStopRecording: false,
      canSendText: true,
      isProcessing: false,
    };

    const cases: readonly [Partial<VoiceStatus>, VoiceState, string, boolean][] = [
      [{}, 'idle', 'Your turn', true],
      [
        { state: 'recording', canRecord: false, canStopRecording: true },
        'recording',
        'Listening…',
        true,
      ],
      [
        { state: 'transcribing', canRecord: false, canSendText: false, isProcessing: true },
        'transcribing',
        'Transcribing…',
        false,
      ],
      [
        { state: 'sending', isProcessing: true, canRecord: false, canSendText: false },
        'sending',
        'Thinking…',
        false,
      ],
      [{ state: 'speaking', isSpeaking: true }, 'speaking', 'Tutor speaking…', true],
      [
        { state: 'error', errorMessage: 'Microphone permission is required.' },
        'error',
        'Microphone permission is required.',
        true,
      ],
    ];

    for (const [patch, expectedState, expectedLabel, micIsPrimary] of cases) {
      const status: VoiceStatus = { ...base, ...patch };
      const view = describeVoiceTurn(status);
      expect(status.state).toBe(expectedState);
      expect(view.label).toBe(expectedLabel);
      expect(view.micIsPrimary).toBe(micIsPrimary);
    }

    // A text/opening turn waiting on the AI reuses the same "thinking" phase.
    expect(describeVoiceTurn(base, true).phase).toBe('thinking');
  });

  // ──────────────────────────────────────────── failure & integrity invariants

  it('10. a failed STT changes no conversation history', async () => {
    const stt = createDemoSTTProvider();
    stt.setMockFailure(true, 'Audio was not clear.');
    const { session, tts, coordinator } = createTalkFlow({ stt });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);
    expect(session.getLastFeedback()).toBeNull();
    expect(tts.getSpokenTexts()).toEqual([]);
    expect(coordinator.getStatus().state).toBe('error');
    expect(coordinator.getStatus().isProcessing).toBe(false);
  });

  it('11. a failed AI response fabricates no assistant history', async () => {
    const { session, tts, coordinator } = createTalkFlow({ provider: createFailingProvider() });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(false);
    expect(session.getHistory().filter((turn) => turn.role === 'assistant')).toHaveLength(0);
    expect(session.getHistory()).toEqual([]);
    expect(tts.getSpokenTexts()).toEqual([]);
    // The learner sees ONE classified, actionable sentence from the provider
    // failure catalog; the raw provider text stays available for diagnostics only.
    expect(coordinator.getStatus().errorMessage).toBe(
      'The tutor service is busy right now. Your answer was not lost. Try again.',
    );
    expect(result.error).toBe(coordinator.getStatus().errorMessage);
    expect(result.technical).toContain('The tutor is unavailable right now.');
    expect(result.failure?.kind).toBe('service_busy');
    // The failed turn preserved the learner's own transcript for an explicit Retry.
    expect(coordinator.getStatus().pendingTranscript).toBe('Hello there.');
    expect(coordinator.getStatus().canRetryPendingTurn).toBe(true);
  });

  it('12. a TTS failure preserves the successful conversation turn', async () => {
    const { session, coordinator } = createTalkFlow({
      provider: createStubProvider('Wonderful! Tell me more.'),
      tts: createFailingTTS(),
    });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(true);
    expect(session.getHistory()).toHaveLength(2);
    expect(session.getHistory()[0].content).toBe('Hello there.');
    expect(session.getHistory()[1].content).toBe('Wonderful! Tell me more.');
    expect(coordinator.getStatus().state).toBe('idle');
  });

  // ───────────────────────────────────────────────────── session integrity

  it('13. changing the mode cancels active recording and playback', async () => {
    const tts = new HangingTTS();
    const { session, recorder, coordinator } = createTalkFlow({ tts });

    const speaking = coordinator.speakResponse('Talking about the weather.');
    await tick();
    await coordinator.startRecording();
    expect(recorder.isRecording()).toBe(true);

    // Talk's mode switch invalidates the active voice work (coordinator.reset())
    // and swaps in the session of the new mode.
    const newSession = createTalkSession({ mode: 'coach' }, { isDemo: true }).session;
    await coordinator.reset();
    coordinator.setSession(newSession);

    expect(recorder.isRecording()).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isProcessing).toBe(false);
    expect(describeVoiceTurn(coordinator.getStatus()).phase).toBe('ready');
    expect(session.getHistory()).toEqual([]);
    expect(newSession.getHistory()).toEqual([]);

    await speaking;
  });

  it('14. New Chat cancels active voice work without touching either conversation', async () => {
    const tts = createDemoTTSProvider();
    const { session, recorder, coordinator } = createTalkFlow({
      stt: createDemoSTTProvider({ defaultTranscript: 'Cancelled by New Chat.', delayMs: 25 }),
      tts,
    });

    await coordinator.startRecording();
    const pending = coordinator.stopRecordingAndProcess();
    await tick();

    // New Chat: cancel everything, then start the replacement conversation.
    const newSession = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    await coordinator.reset();
    coordinator.setSession(newSession);

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(recorder.isRecording()).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isProcessing).toBe(false);
    expect(newSession.getHistory()).toEqual([]);
    expect(session.getHistory()).toEqual([]);
    expect(newSession.getLastFeedback()).toBeNull();
    expect(tts.getSpokenTexts()).toEqual([]);
  });

  it('15. a late STT result from the old session is never submitted to the replacement', async () => {
    const stt = createDemoSTTProvider({
      defaultTranscript: 'Words recorded for the old conversation.',
      delayMs: 30,
    });
    const tts = createDemoTTSProvider();
    const { session, coordinator } = createTalkFlow({ stt, tts });

    await coordinator.startRecording();
    const pending = coordinator.stopRecordingAndProcess();

    const replacement = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    await coordinator.reset();
    coordinator.setSession(replacement);

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toBe(VOICE_SESSION_CHANGED_MESSAGE);
    expect(replacement.getHistory()).toEqual([]);
    expect(session.getHistory()).toEqual([]);
    expect(tts.getSpokenTexts()).toEqual([]);
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('16. a late AI result from the old session never appears in the replacement', async () => {
    const provider = createDeferredProvider();
    const tts = createDemoTTSProvider();
    const { coordinator } = createTalkFlow({ provider, tts });

    await coordinator.startRecording();
    const pending = coordinator.stopRecordingAndProcess();
    await tick(3);
    expect(coordinator.getStatus().state).toBe('sending');

    const replacement = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    await coordinator.reset();
    coordinator.setSession(replacement);

    // The old conversation's AI reply finally arrives…
    provider.resolve('Late reply from the previous conversation.');
    const result = await pending;
    await tick();

    expect(result.ok).toBe(false);
    // The replacement conversation never receives the abandoned reply…
    expect(replacement.getHistory()).toEqual([]);
    expect(replacement.getHistory().map((turn) => turn.content)).not.toContain(
      'Late reply from the previous conversation.',
    );
    // …it is never spoken…
    expect(tts.getSpokenTexts()).toEqual([]);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isProcessing).toBe(false);
  });

  it('17. disposing on unmount stops the recorder and playback and refuses new voice work', async () => {
    const tts = new HangingTTS();
    const { recorder, coordinator } = createTalkFlow({ tts });

    await coordinator.startRecording();
    expect(recorder.isRecording()).toBe(true);

    await coordinator.dispose();

    expect(recorder.isRecording()).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isProcessing).toBe(false);
    // No new voice work can start after unmount…
    expect(await coordinator.startRecording()).toBe(false);
    // …and late voice work is refused instead of writing anywhere.
    const late = await coordinator.stopRecordingAndProcess();
    expect(late.ok).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('18. a late STT arrival after unmount does not speak or submit anything', async () => {
    const stt = createDemoSTTProvider({ defaultTranscript: 'Late unmount words.', delayMs: 25 });
    const tts = createDemoTTSProvider();
    const { session, coordinator } = createTalkFlow({ stt, tts });

    await coordinator.startRecording();
    const pending = coordinator.stopRecordingAndProcess();
    await coordinator.dispose();

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);
    expect(tts.getSpokenTexts()).toEqual([]);
  });

  // ──────────────────────────────────────────────────────── tutor-led prompt

  it('19. Natural mode asks for concise flowing replies with one follow-up question', () => {
    const engine = createConversationEngine(createDemoLearnerModel());
    const prompt = engine.buildRequest({ userMessage: 'Hello!', mode: 'natural' }).systemPrompt;

    expect(prompt).toContain('Mode: Natural Conversation');
    expect(prompt).toContain('Prioritize natural, authentic, and flowing conversational exchange');
    expect(prompt).toContain('Correct selectively and unobtrusively');
    expect(prompt).toContain('Usually end your reply with ONE short relevant follow-up question');
    expect(prompt).toContain('Keep the spoken reply short');
    expect(prompt).toContain('continue the current context instead of restarting a new topic');
    // No lectures: replies stay conversational.
    expect(prompt).toContain('rather than turning every response into a lecture or lesson');
  });

  it('20. Coach and Intensive modes stay distinct from Natural', () => {
    const engine = createConversationEngine(createDemoLearnerModel());

    const natural = engine.buildRequest({ userMessage: 'Hello!', mode: 'natural' }).systemPrompt;
    const coach = engine.buildRequest({ userMessage: 'Hello!', mode: 'coach' }).systemPrompt;
    const intensive = engine.buildRequest({ userMessage: 'Hello!', mode: 'intensive' })
      .systemPrompt;

    expect(coach).toContain('Mode: Coach Mode');
    expect(coach).toContain('Provide somewhat more explicit coaching');
    expect(coach).toContain('Maintain conversation flow');
    expect(coach).toContain('one relevant follow-up question');

    expect(intensive).toContain('Mode: Intensive Practice');
    expect(intensive).toContain('Focus directly and deliberately on learner weaknesses');
    expect(intensive).toContain('Offer more frequent, focused corrections');
    expect(intensive).toContain('use the target language in their next turn');

    // Each mode keeps its own instruction block.
    expect(natural).not.toContain('Mode: Coach Mode');
    expect(natural).not.toContain('Mode: Intensive Practice');
    expect(coach).not.toContain('Mode: Intensive Practice');
    expect(intensive).not.toContain('Mode: Coach Mode');
    // Natural mode still corrects selectively instead of correcting everything.
    expect(natural).toContain('only important mistakes or clearly unnatural wording');
  });

  it('21. an open conversation lets the tutor start an everyday topic', () => {
    const engine = createConversationEngine(createDemoLearnerModel());
    const request = engine.buildRequest({ userMessage: 'Hello!', mode: 'natural' });

    expect(request.systemPrompt).toContain('Topic Focus: Open conversation');
    expect(request.systemPrompt).toContain('The learner has not chosen a topic');
    expect(request.systemPrompt).toContain('open with a short, natural everyday prompt');

    // Topic continuity: no sudden subject changes once a topic exists.
    const topicRequest = engine.buildRequest({
      userMessage: 'Hello!',
      mode: 'natural',
      topic: 'Job interview',
    });
    expect(topicRequest.systemPrompt).toContain('Topic Focus: Job interview');
    expect(topicRequest.systemPrompt).toContain('Do not jump to an unrelated subject');
  });

  it('22. persisted coaching context is still consumed through the existing ConversationEngine', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();

    const profileRepo = new SQLiteUserProfileRepository(adapter);
    const profile = await profileRepo.update({
      displayName: 'Talk Learner',
      targetLanguage: 'en',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: ['Speak confidently at work'],
    });

    const weaknesses = new SQLiteWeaknessRepository(adapter);
    await weaknesses.upsertWeakness({
      learnerId: profile.id,
      type: 'grammar',
      referenceId: 'ref-conditionals',
      status: 'confirmed',
      severity: 0.7,
      occurrenceCount: 4,
      contexts: ['job interview practice'],
      evidence: [],
      resolved: false,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });

    // The Talk composition composes the REAL learner model on the existing repos…
    const learnerModel = createTalkLearnerModel(adapter);
    expect(learnerModel).not.toBeNull();
    // …loads the persisted snapshot through the existing LearnerModel API…
    await learnerModel!.refresh();

    // …and the Talk bundle can be given that exact model.
    const bundle = createTalkSession(
      { mode: 'natural' },
      { databaseAdapter: adapter, learnerModel: learnerModel! },
    );
    expect(bundle.session.getConfig().mode).toBe('natural');

    // The EXISTING engine consumes the persisted coaching context for the turn.
    const provider = createStubProvider('Thanks for sharing! What happened next?');
    const session = buildSessionWithProvider(provider, 'natural', undefined, learnerModel!);
    const result = await session.send({ userMessage: 'Hello!' });
    expect(result.ok).toBe(true);

    const context = provider.requests[0].coachingContext;
    expect(context.profile.currentLevel).toBe('B1');
    expect(context.profile.learningGoals).toContain('Speak confidently at work');
    expect(context.activeWeaknesses.length).toBeGreaterThan(0);

    // …and it is rendered into the tutor's system prompt (no invented learner data).
    const prompt = provider.requests[0].systemPrompt;
    expect(prompt).toContain('Active Weaknesses (Persisted):');
    expect(prompt).toContain('[grammar]');
    expect(prompt).toContain('Occurrences: 4');
    expect(prompt).toContain('job interview practice');
    expect(prompt).toContain('Current CEFR Level: B1');

    await adapter.close();
  });

  it('45. a replaced session cannot commit a turn that resolves while voice teardown is still running', async () => {
    // The old turn's AI answer is held open; its feedback carries vocabulary so
    // the persistence side effect is observable too.
    const staleFeedback: ConversationFeedback = {
      correction: null,
      vocabulary: {
        headword: 'stale',
        type: 'word',
        meaning: 'left over from the replaced conversation',
        example: 'This turn should never be stored.',
      },
      coachingNote: 'stale coaching note',
    };
    const provider = createDeferredFirstProvider(
      'Stale tutor reply from the replaced conversation.',
      'Fresh reply in the new conversation.',
      staleFeedback,
    );

    const saveSpy = vi.fn(async () => undefined);
    const session = createConversationSession(
      createConversationOrchestrator(createConversationEngine(createDemoLearnerModel()), provider),
      { mode: 'natural', onSaveVocabulary: saveSpy },
    );

    const recorder = createDemoAudioRecorder();
    const tts = new GatedTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider({
        defaultTranscript: 'Old learner turn in the replaced conversation.',
        delayMs: 5,
      }),
      ttsProvider: tts,
    });

    // 1. The old voice turn reaches the AI request and is held there.
    await coordinator.startRecording();
    const pendingTurn = coordinator.stopRecordingAndProcess();
    await waitFor(() => provider.requests === 1);
    expect(pendingTurn).toBeDefined();
    expect(session.getHistory()).toEqual([]);

    // 2. The replacement begins, and teardown is held so the switch has NOT
    //    finished when the old AI answer arrives.
    tts.holdStop = true;
    // The replacement conversation uses the same provider: its FIRST (stale)
    // answer was consumed by the replaced conversation above, so it answers
    // immediately from here on.
    const replacement = buildSessionWithProvider(provider, 'natural');
    const switching = coordinator.switchSession(replacement);
    await tick();
    expect(coordinator.getStatus().isSwitching).toBe(true);

    // 3. The OLD AI request resolves while the switch is still inside teardown.
    provider.resolveFirst();
    const staleTurn = await pendingTurn;

    // 4. The replaced session must not commit anything: no learner turn, no
    //    assistant turn, no feedback and no vocabulary persistence.
    expect(staleTurn.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);
    expect(session.getLastFeedback()).toBeNull();
    expect(session.getSavedVocabulary()).toEqual([]);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(session.getHistory().some((turn) => turn.content.includes('Stale tutor'))).toBe(false);
    // …and the replacement conversation stays untouched by the stale turn.
    expect(replacement.getHistory()).toEqual([]);
    expect(replacement.getLastFeedback()).toBeNull();

    // 5. Releasing teardown completes the switch normally.
    tts.holdStop = false;
    tts.releaseStop();
    const installed = await switching;
    expect(installed).toBe(replacement);
    expect(coordinator.getStatus().isSwitching).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');

    // 6. The replacement session works normally afterwards.
    const fresh = await replacement.send({ userMessage: 'Hello again.' });
    expect(fresh.ok).toBe(true);
    expect(replacement.getHistory().map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(replacement.getHistory()[1].content).toBe('Fresh reply in the new conversation.');
    expect(replacement.getLastFeedback()).toBeNull();

    // …and the new conversation is writable through the SAME session API.
    const second = await replacement.send({ userMessage: 'One more thing.' });
    expect(second.ok).toBe(true);
    expect(replacement.getHistory()).toHaveLength(4);

    // Voice work is available again too: the microphone can open and only the
    // changed lifecycle of the replacement session owns it.
    await coordinator.startRecording();
    expect(coordinator.getStatus().state).toBe('recording');
    expect(coordinator.getStatus().canStopRecording).toBe(true);

    // The replaced conversation never received anything.
    expect(session.getHistory()).toEqual([]);
    expect(saveSpy).not.toHaveBeenCalled();

    await coordinator.dispose();
  });

  it('23. Talk introduces no second conversation, adaptive or persistence engine', () => {
    const root = join(__dirname, '..');
    const talkSource = readFileSync(join(root, 'talk-demo', 'index.ts'), 'utf8');
    const screenSource = readFileSync(join(root, 'screens', 'TalkScreen.tsx'), 'utf8');

    // Talk composes the EXISTING stack instead of a parallel one.
    expect(talkSource).toContain("from '../conversation-engine'");
    expect(talkSource).toContain("from '../conversation-orchestrator'");
    expect(talkSource).toContain("from '../conversation-session'");
    expect(talkSource).toContain("from '../learner-model'");
    // …and never turns Talk into an adaptive lesson runner.
    expect(talkSource).not.toContain('adaptive-lessons');
    expect(screenSource).not.toContain('adaptive-lessons');
    expect(screenSource).not.toContain('AdaptiveLessonService');

    // The Talk session only exposes the EXISTING session API surface.
    const session = createTalkSession({ mode: 'natural' }, { isDemo: true }).session as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(session).sort()).toEqual(
      [
        'abandon',
        'clear',
        'getConfig',
        'getHistory',
        'getLastFeedback',
        'getSavedVocabulary',
        // Additive recovery probe (Work Order 1): lets a surface detect that the
        // conversation it still shows was closed, instead of sending a turn that
        // can only be discarded. It adds no second engine.
        'isAbandoned',
        'isVocabularySaved',
        'openConversation',
        'saveVocabularyItem',
        'send',
        'sendStream',
        // Additive learner-agency methods (Work Order 2): help runs through
        // the SAME session/engine (requestAssistance commits a tutor-only
        // turn) and the temporary correction override only re-maps the mode of
        // the next request. Both extend the ONE existing contract; neither is
        // a second conversation engine, and neither can submit a learner answer.
        'requestAssistance',
        'setModeOverride',
      ].sort(),
    );
  });

  it('24. the tutor opening turn runs through the existing AI path and stores only the tutor reply', async () => {
    const { mockFetch, calls } = createGeminiFetch([
      'Hi! I am your English tutor. What would you like to talk about today?',
    ]);
    const bundle = createTalkSession(
      { mode: 'natural' },
      { apiKey: 'mock-key', fetchImpl: mockFetch },
    );

    const openConversation = bundle.session.openConversation;
    expect(typeof openConversation).toBe('function');
    const result = await openConversation!({
      userMessage: 'Begin the conversation now: greet me briefly.',
    });

    expect(result.ok).toBe(true);
    // The opening reply came from the existing AI request path…
    expect(calls).toHaveLength(1);
    // …and only the REAL tutor turn is stored (never the instruction as a learner turn).
    const history = bundle.session.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('assistant');
    expect(history[0].content).toContain('What would you like to talk about today?');
    expect(history.some((turn) => turn.role === 'user')).toBe(false);
    expect(history[0].content).not.toContain('Begin the conversation now');
    // No fabricated assessment for a turn the learner never spoke.
    expect(bundle.session.getLastFeedback()).toBeNull();
  });

  it('25. a failed opening fabricates no tutor turn and reports honestly', async () => {
    const failing = buildSessionWithProvider(createFailingProvider());
    const failed = await failing.openConversation!({
      userMessage: 'Begin the conversation now.',
    });

    expect(failed.ok).toBe(false);
    expect(failing.getHistory()).toEqual([]);
    expect(failing.getLastFeedback()).toBeNull();

    // An opening is refused once a real turn exists as well.
    const working = createTalkFlow({ provider: createStubProvider('Hello! How are you?') });
    await working.coordinator.startRecording();
    await working.coordinator.stopRecordingAndProcess();
    const second = await working.session.openConversation!({
      userMessage: 'Begin the conversation now.',
    });
    expect(second.ok).toBe(false);
    expect(working.session.getHistory()).toHaveLength(2);
  });

  // ──────────────────────────────────────────────────────── provider honesty

  it('26. Demo is explicit, and with no provider at all the state is "configuration required"', async () => {
    // With no key and no Demo request there is NO provider: nothing is scripted.
    const unconfigured = createTalkSession({ mode: 'natural' });
    expect(unconfigured.providerKind).toBe('unavailable');
    expect(unconfigured.providerInfo.isRealAI).toBe(false);
    expect(unconfigured.providerInfo.allowsPersonalizedFeedback).toBe(false);
    expect(unconfigured.providerInfo.label.toLowerCase()).toContain('configuration required');
    const blocked = await unconfigured.session.send({ userMessage: 'Hello!' });
    expect(blocked.ok).toBe(false);
    expect(unconfigured.session.getHistory()).toEqual([]);

    // Explicit Demo Mode is still precisely labelled as NOT real AI.
    const demo = createTalkSession({ mode: 'natural' }, { isDemo: true });
    expect(demo.providerKind).toBe('demo');
    expect(demo.providerInfo.isRealAI).toBe(false);
    expect(demo.providerInfo.allowsPersonalizedFeedback).toBe(false);
    expect(demo.providerInfo.label.toLowerCase()).toContain('not real ai');

    const real = createTalkSession(
      { mode: 'natural' },
      { apiKey: 'mock-key', fetchImpl: createGeminiFetch(['Hello!']).mockFetch },
    );
    expect(real.providerKind).toBe('gemini');
    expect(real.providerInfo.isRealAI).toBe(true);
    expect(real.providerInfo.allowsPersonalizedFeedback).toBe(true);
  });

  it('27. a real conversation never silently falls back to scripted demo speech recognition', async () => {
    // Explicit Demo Mode is honest about being a demo: the deterministic
    // transcript is intentional and the bundle says so.
    const demo = createTalkSession({ mode: 'natural' }, { isDemo: true });
    const demoCoordinator = createTalkVoiceCoordinator({
      session: demo.session,
      providerKind: demo.providerKind,
      recorder: createDemoAudioRecorder(),
      ttsProvider: createDemoTTSProvider(),
    });
    await demoCoordinator.startRecording();
    const demoResult = await demoCoordinator.stopRecordingAndProcess();
    expect(demoResult.ok).toBe(true);
    expect(demoResult.transcript).toBe('Yesterday I went to a meeting with my manager.');

    // A REAL conversation without a real STT provider fails honestly instead of
    // presenting a scripted transcript as the learner's own speech.
    const real = createTalkSession(
      { mode: 'natural' },
      { apiKey: 'mock-key', fetchImpl: createGeminiFetch(['Hello!']).mockFetch },
    );
    const realCoordinator = createTalkVoiceCoordinator({
      session: real.session,
      providerKind: real.providerKind,
      apiKey: '',
      recorder: createDemoAudioRecorder(),
      ttsProvider: createDemoTTSProvider(),
    });
    await realCoordinator.startRecording();
    const realResult = await realCoordinator.stopRecordingAndProcess();

    expect(realResult.ok).toBe(false);
    expect(realResult.error).toBe(TALK_REAL_STT_UNAVAILABLE_MESSAGE);
    expect(real.session.getHistory()).toEqual([]);
    expect(real.session.getLastFeedback()).toBeNull();

    // The unconfigured state (no key, no Demo request) gets NO scripted
    // transcript either: it fails honestly and leaves no history.
    const unconfigured = createTalkSession({ mode: 'natural' });
    expect(unconfigured.providerKind).toBe('unavailable');
    const unconfiguredCoordinator = createTalkVoiceCoordinator({
      session: unconfigured.session,
      providerKind: unconfigured.providerKind,
      recorder: createDemoAudioRecorder(),
      ttsProvider: createDemoTTSProvider(),
    });
    await unconfiguredCoordinator.startRecording();
    const unconfiguredResult = await unconfiguredCoordinator.stopRecordingAndProcess();
    expect(unconfiguredResult.ok).toBe(false);
    expect(unconfiguredResult.transcript ?? '').not.toContain(
      'Yesterday I went to a meeting with my manager.',
    );
    expect(unconfigured.session.getHistory()).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────── typed fallback

  it('28. the typed fallback still works and is blocked only while the mic owns the turn', async () => {
    const provider = createStubProvider('Thanks for typing! What happened next?');
    const { session, coordinator } = createTalkFlow({ provider });

    expect(coordinator.getStatus().canSendText).toBe(true);

    const typed = await session.send({ userMessage: 'I typed this instead of speaking.' });
    expect(typed.ok).toBe(true);
    expect(session.getHistory().map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(session.getHistory()[0].content).toBe('I typed this instead of speaking.');
    expect(provider.requests).toHaveLength(1);

    // While the microphone records/transcribes, text input may not race the turn.
    await coordinator.startRecording();
    expect(coordinator.getStatus().canSendText).toBe(false);
    await coordinator.stopRecordingAndProcess();
    expect(coordinator.getStatus().canSendText).toBe(true);
  });

  // ──────────────────────────────────────────────────── conversational quality

  it('29. the conversation continues after a correction instead of stopping at it', async () => {
    const feedback: ConversationFeedback = {
      correction: {
        original: 'I go to meeting yesterday',
        improved: 'I went to a meeting yesterday',
        explanation: 'Use the past simple with "yesterday".',
        severity: 'incorrect',
      },
    };
    const provider = createStubProvider(
      'Good — so it was yesterday. What did your manager say?',
      feedback,
    );
    const { session, coordinator } = createTalkFlow({ provider });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(true);
    // The correction runs alongside the conversation, not instead of it.
    expect(session.getHistory().at(-1)?.content).toContain('What did your manager say?');
    expect(session.getLastFeedback()?.correction?.severity).toBe('incorrect');
    expect(session.getLastFeedback()?.correction?.improved).toBe('I went to a meeting yesterday');
  });

  it('30. a second spoken turn reuses the existing history as context', async () => {
    const provider = createStubProvider('Nice! And then?');
    const { session, coordinator } = createTalkFlow({ provider });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();
    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();

    expect(provider.requests).toHaveLength(2);
    // The previous exchange is carried into the next turn as context.
    expect(provider.requests[1].messages).toHaveLength(3);
    expect(provider.requests[1].messages[0]).toEqual({ role: 'user', content: 'Hello there.' });
    expect(provider.requests[1].messages[1].role).toBe('assistant');
    expect(provider.requests[1].messages[2].role).toBe('user');
    expect(session.getHistory()).toHaveLength(4);
    // Exactly one user turn per utterance.
    expect(session.getHistory().filter((turn) => turn.role === 'user')).toHaveLength(2);
  });

  it('31. pronunciation analysis stays secondary, qualitative and non-blocking', async () => {
    const provider = createStubProvider('Great, tell me more about your day.');
    const { session, coordinator } = createTalkFlow({ provider });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();
    expect(result.ok).toBe(true);
    // The conversation turn is fully committed BEFORE any pronunciation work runs.
    expect(session.getHistory()).toHaveLength(2);

    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profileRepo = new SQLiteUserProfileRepository(adapter);
    await profileRepo.update({
      displayName: 'Pronunciation Learner',
      targetLanguage: 'en',
      currentLevel: 'B1',
      targetLevel: 'B2',
    });
    const engine: PronunciationEngine = createPronunciationEngine(adapter);

    const outcome = await engine.analyzeSpokenTurn({
      transcript: 'Hello there.',
      context: session.getHistory()[0].content,
      mode: 'natural',
    });

    if (outcome) {
      for (const line of outcome.feedbackLines) {
        expect(typeof line).toBe('string');
      }
      // Qualitative feedback only: no numeric scores, precision or mastery claims.
      expect(outcome).not.toHaveProperty('score');
      expect(JSON.stringify(outcome)).not.toMatch(/score|phoneme|accent rating|mastery/i);
    }

    // Analysis never rewrites the conversation that already happened.
    expect(session.getHistory()).toHaveLength(2);
    expect(session.getHistory()[1].content).toBe('Great, tell me more about your day.');

    await adapter.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCKER-class regressions: session switching, reset races, opening races
  // ═══════════════════════════════════════════════════════════════════════

  it('33. an older async reset cannot overwrite the NEW session recording state', async () => {
    const tts = new GatedTTS();
    const { recorder, coordinator } = createTalkFlow({ tts });

    await coordinator.startRecording();
    expect(recorder.isRecording()).toBe(true);

    // An old reset is still awaiting its playback cleanup…
    tts.holdNextStop();
    const oldReset = coordinator.reset();
    await tick();

    // …while the coordinator is already moved to a NEW session that records.
    const newSession = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    coordinator.setSession(newSession);
    const started = await coordinator.startRecording();
    expect(started).toBe(true);
    expect(coordinator.getStatus().state).toBe('recording');

    // The old reset NOW finishes (late): it must NOT clobber the new lifecycle.
    tts.releaseStop();
    await oldReset;

    const status = coordinator.getStatus();
    expect(status.state).toBe('recording');
    expect(status.canStopRecording).toBe(true);
    expect(status.isProcessing).toBe(false);
    expect(recorder.isRecording()).toBe(true);
    expect(newSession.getHistory()).toEqual([]);

    await coordinator.dispose();
  });

  it('34. an older async reset cannot overwrite the NEW session speaking state', async () => {
    const tts = new GatedTTS();
    const { session, coordinator } = createTalkFlow({ tts });

    // The old reset is held open inside playback cleanup.
    tts.holdNextStop();
    const oldReset = coordinator.reset();
    await tick();

    // The new session starts speaking while the old reset is still pending.
    const newSession = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    coordinator.setSession(newSession);
    const speaking = coordinator.speakResponse('Hello from the new conversation.');
    await tick();
    expect(coordinator.getStatus().state).toBe('speaking');

    // The old reset NOW finishes (late): it must NOT clobber the new lifecycle.
    tts.releaseStop();
    await oldReset;

    // Still speaking: the stale reset wrote nothing.
    expect(coordinator.getStatus().state).toBe('speaking');
    expect(coordinator.getStatus().isSpeaking).toBe(true);
    expect(session.getHistory()).toEqual([]);
    expect(newSession.getHistory()).toEqual([]);

    await coordinator.dispose();
    await speaking;
  });

  it('35. a session switch AWAITS recorder cleanup before the new session is active', async () => {
    const recorder = new GatedRecorder();
    const { coordinator } = createTalkFlow({ recorder });

    await coordinator.startRecording();
    expect(recorder.isRecording()).toBe(true);

    recorder.holdStop = true;
    const replacement = createTalkSession({ mode: 'coach' }, { isDemo: true }).session;
    const switching = coordinator.switchSession(replacement);
    await tick();

    // The switch is in flight: no new voice work may start, and the new session
    // is NOT active yet.
    expect(coordinator.getStatus().isSwitching).toBe(true);
    expect(coordinator.getStatus().canRecord).toBe(false);
    expect(coordinator.getStatus().canSendText).toBe(false);
    expect(await coordinator.startRecording()).toBe(false);
    expect(coordinator.getStatus().state).toBe('recording'); // old session still owns the mic until cleanup finishes

    // Releasing the old recorder cleanup completes the switch.
    recorder.releaseStop();
    const installed = await switching;
    expect(installed).toBe(replacement);
    expect(recorder.isRecording()).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isSwitching).toBe(false);
    expect(coordinator.getStatus().canRecord).toBe(true);
  });

  it('36. a session switch AWAITS TTS cleanup before the new session is active', async () => {
    const tts = new GatedTTS();
    const { session, coordinator } = createTalkFlow({ tts });

    const speaking = coordinator.speakResponse('Old conversation playback.');
    await tick();
    expect(coordinator.getStatus().state).toBe('speaking');

    tts.holdStop = true;
    const replacement = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    const switching = coordinator.switchSession(replacement);
    await tick();
    expect(coordinator.getStatus().isSwitching).toBe(true);

    tts.holdStop = false;
    tts.releaseStop();
    const installed = await switching;

    expect(installed).toBe(replacement);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isSpeaking).toBe(false);
    expect(coordinator.getStatus().isSwitching).toBe(false);
    expect(session.getHistory()).toEqual([]);
    expect(replacement.getHistory()).toEqual([]);

    await coordinator.dispose();
    await speaking.catch(() => undefined);
  });

  it('37. New Chat during recording leaves the replacement conversation clean', async () => {
    const recorder = new GatedRecorder();
    const tts = createDemoTTSProvider();
    const { session, coordinator } = createTalkFlow({
      recorder,
      tts,
      stt: createDemoSTTProvider({ defaultTranscript: 'Recorded in the old chat.' }),
    });

    await coordinator.startRecording();
    expect(recorder.isRecording()).toBe(true);

    // New Chat = atomic switch to a fresh session (talk screen behaviour).
    const replacement = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    const installed = await coordinator.switchSession(replacement);

    expect(installed).toBe(replacement);
    expect(recorder.isRecording()).toBe(false);
    expect(coordinator.getStatus().isProcessing).toBe(false);
    expect(replacement.getHistory()).toEqual([]);
    expect(session.getHistory()).toEqual([]);
    expect(tts.getSpokenTexts()).toEqual([]);

    // The new conversation works normally afterwards.
    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();
    expect(result.ok).toBe(true);
    expect(replacement.getHistory()).toHaveLength(2);
    expect(session.getHistory()).toEqual([]);
  });

  it('38. mode change during tutor playback leaves the replacement conversation clean', async () => {
    const tts = new GatedTTS();
    const { session, coordinator } = createTalkFlow({
      provider: createStubProvider('Tutor reply from the previous mode.'),
      tts,
    });

    await coordinator.startRecording();
    const oldTurn = coordinator.stopRecordingAndProcess();
    await tick(3);
    expect(coordinator.getStatus().state).toBe('speaking');

    // Mode change = atomic switch while playback is still running.
    const replacement = createTalkSession({ mode: 'intensive' }).session;
    const installed = await coordinator.switchSession(replacement);

    expect(installed).toBe(replacement);
    expect(await tts.isSpeaking()).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isSwitching).toBe(false);
    expect(replacement.getHistory()).toEqual([]);

    // The interrupted old turn keeps its own history exactly once.
    const old = await oldTurn;
    expect(old.ok).toBe(true);
    expect(session.getHistory()).toHaveLength(2);
    expect(replacement.getHistory()).toEqual([]);
  });

  it('39. changing the session during a permission request captures nothing', async () => {
    const recorder = new GatedRecorder();
    const { coordinator } = createTalkFlow({ recorder });

    recorder.requireRequest();
    recorder.holdPermission = true;
    const starting = coordinator.startRecording();
    await tick();
    expect(coordinator.getStatus().state).toBe('requesting_permission');

    const replacement = createTalkSession({ mode: 'natural' }, { isDemo: true }).session;
    const installed = await coordinator.switchSession(replacement);
    expect(installed).toBe(replacement);

    recorder.releasePermission();
    const started = await starting;

    expect(started).toBe(false);
    expect(recorder.isRecording()).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isProcessing).toBe(false);
    expect(replacement.getHistory()).toEqual([]);
  });

  it('40. an opening in flight and a typed send can never both commit', async () => {
    const provider = createDeferredFirstProvider('Hi! What would you like to talk about?');
    const { session, coordinator } = createTalkFlow({ provider });

    const opening = session.openConversation!({
      userMessage: 'Begin the conversation now.',
    });
    await tick();
    expect(provider.requests).toBe(1);

    // The learner takes over while the opening request is still in flight.
    const typed = await session.send({ userMessage: 'Actually, let me start.' });
    expect(typed.ok).toBe(true);
    expect(session.getHistory()).toHaveLength(2);
    expect(session.getHistory()[0]).toEqual({
      role: 'user',
      content: 'Actually, let me start.',
    });

    // The opening lands later: it is discarded, never appended out of order.
    provider.resolveFirst();
    const openingResult = await opening;

    expect(openingResult.ok).toBe(false);
    if (!openingResult.ok) {
      expect(openingResult.error.code).toBe('cancelled');
      expect(openingResult.error.message).toBe(CONVERSATION_OPENING_DISCARDED_MESSAGE);
    }
    const history = session.getHistory();
    expect(history).toHaveLength(2);
    expect(history.map((turn) => turn.content)).not.toContain(
      'Hi! What would you like to talk about?',
    );
    expect(history.some((turn) => turn.role === 'assistant' && turn.content.startsWith('Hi!'))).toBe(
      false,
    );
    expect(session.getLastFeedback()).toBeNull();
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('41. an opening is discarded when the conversation was cleared before it resolved', async () => {
    const provider = createDeferredFirstProvider('Welcome! Tell me about your day.');
    const { session } = createTalkFlow({ provider });

    const opening = session.openConversation!({ userMessage: 'Begin the conversation now.' });
    await tick();

    // New Chat clears the conversation while the opening is in flight.
    session.clear();

    provider.resolveFirst();
    const result = await opening;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cancelled');
    }
    expect(session.getHistory()).toEqual([]);
    expect(session.getLastFeedback()).toBeNull();
  });

  it('42. a stale opening never appears in the replacement session', async () => {
    const provider = createDeferredFirstProvider('Stale opening from the old conversation.');
    const { session, coordinator } = createTalkFlow({ provider });

    const opening = session.openConversation!({ userMessage: 'Begin the conversation now.' });
    await tick();

    const replacement = createTalkSession({ mode: 'natural' }).session;
    const installed = await coordinator.switchSession(replacement);
    expect(installed).toBe(replacement);

    provider.resolveFirst();
    const result = await opening;

    expect(result.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);
    expect(replacement.getHistory()).toEqual([]);
    expect(replacement.getLastFeedback()).toBeNull();
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('43. a normal opening still stores exactly one tutor turn and the typed fallback still works', async () => {
    const { mockFetch, calls } = createGeminiFetch([
      'Hello! I am your tutor. What shall we talk about?',
      'Great — tell me more about that.',
    ]);
    const bundle = createTalkSession(
      { mode: 'natural' },
      { apiKey: 'mock-key', fetchImpl: mockFetch },
    );

    const opening = await bundle.session.openConversation!({
      userMessage: 'Begin the conversation now.',
    });
    expect(opening.ok).toBe(true);
    expect(bundle.session.getHistory()).toHaveLength(1);
    expect(bundle.session.getHistory()[0].role).toBe('assistant');

    // The learner then types normally through the same session.
    const typed = await bundle.session.send({ userMessage: 'I went hiking yesterday.' });
    expect(typed.ok).toBe(true);
    expect(bundle.session.getHistory().map((turn) => turn.role)).toEqual([
      'assistant',
      'user',
      'assistant',
    ]);
    expect(bundle.session.getHistory()[1].content).toBe('I went hiking yesterday.');
    expect(calls).toHaveLength(2);
    // The second request carries the opening as conversation context.
    const secondContents = calls[1].body.contents as { role: string }[];
    expect(secondContents.map((entry) => entry.role)).toEqual(['model', 'user']);
  });

  it('44. switching sessions while a voice turn is in flight discards its late result', async () => {
    const stt = createDemoSTTProvider({ defaultTranscript: 'Late words.', delayMs: 25 });
    const tts = createDemoTTSProvider();
    const { session, coordinator } = createTalkFlow({ stt, tts });

    await coordinator.startRecording();
    const pending = coordinator.stopRecordingAndProcess();
    await tick();

    const replacement = createTalkSession({ mode: 'natural' }).session;
    const installed = await coordinator.switchSession(replacement);
    expect(installed).toBe(replacement);

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toBe(VOICE_SESSION_CHANGED_MESSAGE);
    expect(replacement.getHistory()).toEqual([]);
    expect(session.getHistory()).toEqual([]);
    expect(tts.getSpokenTexts()).toEqual([]);
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('47. disposing the coordinator abandons the ACTIVE session before any awaited teardown', async () => {
    // Held AI: the first two requests stay pending until released by hand; any
    // later probe answers immediately, so a wrongly-accepted probe fails fast
    // instead of hanging the test.
    const held: ((result: AIProviderResult) => void)[] = [];
    let calls = 0;
    const provider: AIProvider = {
      id: 'held-then-immediate-ai',
      generate: () => {
        calls += 1;
        if (calls > 2) {
          return Promise.resolve({ ok: true, response: { content: 'Probe reply.' } });
        }
        return new Promise<AIProviderResult>((resolve) => {
          held.push(resolve);
        });
      },
    };
    const tts = new GatedTTS();
    const { session, coordinator } = createTalkFlow({ provider, tts });

    // A committed turn pair already exists.
    const committed = session.send({ userMessage: 'I went to the office.' });
    held.shift()?.({ ok: true, response: { content: 'Nice! What happened next?' } });
    await committed;
    expect(session.getHistory()).toHaveLength(2);

    // A second answer is still in flight when the screen goes away.
    const inFlight = session.send({ userMessage: 'Then I went home.' });

    // Unmount begins; recorder/TTS teardown is held open.
    tts.holdStop = true;
    const disposal = coordinator.dispose();

    // The session is non-writable IMMEDIATELY — before teardown finishes.
    expect(coordinator.getStatus().state).not.toBe('speaking');
    expect((await session.send({ userMessage: 'Blocked during disposal.' })).ok).toBe(false);

    // The held answer resolves while teardown is still awaiting: discarded.
    held.shift()?.({ ok: true, response: { content: 'Late reply from a dead screen.' } });
    const late = await inFlight;
    expect(late.ok).toBe(false);
    expect(session.getHistory()).toHaveLength(2);
    expect(session.getHistory().map((turn) => turn.content)).toEqual([
      'I went to the office.',
      'Nice! What happened next?',
    ]);

    tts.holdStop = false;
    tts.releaseStop();
    await disposal;
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().isProcessing).toBe(false);
  });

  it('32. Adaptive Lessons behaviour and voice guards are unchanged', async () => {
    const adaptive = await import('../adaptive-lessons/voice');

    expect(adaptive.STALE_TARGET_MESSAGE.length).toBeGreaterThan(0);
    expect(adaptive.VOICE_NAVIGATION_BLOCKED_MESSAGE.length).toBeGreaterThan(0);
    expect(adaptive.isAdaptiveVoiceWorkActive({ state: 'recording' })).toBe(true);
    expect(adaptive.isAdaptiveVoiceWorkActive({ state: 'transcribing' })).toBe(true);
    expect(adaptive.isAdaptiveVoiceWorkActive({ state: 'submitting' })).toBe(true);
    expect(adaptive.isAdaptiveVoiceWorkActive({ state: 'idle' })).toBe(false);
    expect(adaptive.isAdaptiveVoiceWorkActive({ state: 'feedback' })).toBe(false);

    // Adaptive Lessons keeps its own module boundary: it never depends on Talk.
    const source = readFileSync(join(__dirname, '..', 'adaptive-lessons', 'voice.ts'), 'utf8');
    expect(source).not.toContain("from '../talk-demo'");
    expect(source).not.toContain('TalkScreen');
  });
});
