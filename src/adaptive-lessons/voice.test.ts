/**
 * src/adaptive-lessons/voice.test.ts
 *
 * Adaptive Lessons — Voice-First Execution (Phase 2) tests.
 *
 * Strategy:
 * - The pure parts (target resolution, listening audio text, state labels,
 *   provider resolution) are pinned exactly — they are what the UI and the
 *   honesty rules depend on.
 * - The controller is driven through fakes for the EXISTING recorder, STT and
 *   TTS abstractions plus a fake AdaptiveLessonService port, so lifecycle
 *   ordering, TTS/microphone exclusion, duplicate-tap protection and failure
 *   behaviour are verified deterministically (no audio device, no network).
 * - Routing, evidence and progress invariants are verified against the REAL
 *   AdaptiveLessonService / ReviewService / ListeningService / Pronunciation
 *   Engine on the real SQLite repositories (SqlJsAdapter) — the same basis the
 *   Phase 1 suite uses.
 * - Structural checks pin the new module and the screen to the existing voice
 *   stack: no demo fallback providers, no new dependency, no gamification, no
 *   second engine, no SQLite in the screen.
 *
 * All previously existing suites keep passing in the same run.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteConversationRepository,
  SQLiteExpressionRepository,
  SQLiteMistakeRepository,
  SQLiteProgressRepository,
  SQLitePronunciationRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { AppRepositories } from '../repositories';
import { createLearnerModel } from '../learner-model';
import { createListeningService, stableReferenceId } from '../listening';
import type { ListeningExercise } from '../listening';
import { createPronunciationEngine } from '../pronunciation';
import { ReviewService } from '../review';
import type { ReviewItem } from '../domain/models/learning';
import type { LearnerWeakness } from '../domain/models/learner';
import type { WeaknessStatus } from '../domain/shared/types';
import type { SpeechToTextProvider, STTAudioInput, STTResult } from '../providers/stt';
import type { TextToSpeechProvider, TTSOptions } from '../providers/tts';
import type { AudioRecorderService, AudioRecordingResult } from '../voice/types';
import { AdaptiveLessonService } from './service';
import type {
  AdaptiveLessonSession,
  AdaptiveLessonStepMaterial,
  AdaptiveLessonSubmitOutcome,
} from './types';
import {
  adaptiveVoiceActionLabel,
  BUSY_MESSAGE,
  CHOICE_EXERCISE_MESSAGE,
  createAdaptiveLessonVoiceController,
  EMPTY_ANSWER_MESSAGE,
  isChoiceBasedListeningExercise,
  listeningAudioText,
  PERMISSION_DENIED_MESSAGE,
  resolveAdaptiveSpeechOutputProvider,
  resolveAdaptiveVoiceInputProviders,
  resolveAdaptiveVoiceTarget,
  SUBMISSION_FAILED_MESSAGE,
  TRANSCRIPTION_FAILED_MESSAGE,
  VOICE_UNAVAILABLE_MESSAGE,
  voiceTargetKey,
} from './voice';
import type { AdaptiveLessonVoiceSubmissionPort, AdaptiveVoiceTarget } from './voice';

const NOW = '2026-09-18T12:00:00.000Z';
const DUE_AT = '2026-09-18T09:00:00.000Z';

// The existing engines read "now" from the real clock, so the seeded evidence
// must be due in the same frame the Phase 1 suite uses.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

/* ================================================================== *
 * 1. Fakes for the EXISTING voice abstractions
 * ================================================================== */

type Log = string[];

/**
 * Controllable TTS fake. `speak()` stays pending until the test completes the
 * playback (or the controller stops it), which is exactly what an in-flight
 * Expo Speech playback looks like to the state machine.
 */
class FakeTts implements TextToSpeechProvider {
  readonly id = 'fake-tts';
  readonly spoken: string[] = [];
  speaking = false;
  failSpeak = false;
  private pending: (() => void) | null = null;

  constructor(private readonly log: Log = []) {}

  async speak(text: string, options?: TTSOptions): Promise<void> {
    this.log.push(`tts:speak:${text}`);
    this.spoken.push(text);
    if (this.failSpeak) throw new Error('tts unavailable');
    this.speaking = true;
    options?.onStart?.();
    await new Promise<void>((resolve) => {
      this.pending = () => {
        this.speaking = false;
        this.pending = null;
        options?.onDone?.();
        resolve();
      };
    });
  }

  /** Let a started playback finish naturally. */
  complete(): void {
    this.pending?.();
  }

  async stop(): Promise<void> {
    this.log.push('tts:stop');
    this.speaking = false;
    this.pending?.();
  }

  async isSpeaking(): Promise<boolean> {
    return this.speaking;
  }
}

class FakeRecorder implements AudioRecorderService {
  permissionGranted = true;
  recording = false;
  failStart = false;
  failStop = false;
  onStartRecording: (() => void) | null = null;
  startedWhileSpeaking = false;
  private speakingProbe: (() => boolean) | null = null;

  constructor(readonly log: Log = []) {}

  watchTts(probe: () => boolean): void {
    this.speakingProbe = probe;
  }

  async requestPermissions(): Promise<boolean> {
    this.log.push('recorder:requestPermissions');
    return this.permissionGranted;
  }

  async hasPermissions(): Promise<boolean> {
    this.log.push('recorder:hasPermissions');
    return this.permissionGranted;
  }

  async startRecording(): Promise<void> {
    this.log.push('recorder:startRecording');
    this.startedWhileSpeaking = this.speakingProbe ? this.speakingProbe() : false;
    this.onStartRecording?.();
    if (this.failStart) throw new Error('recorder unavailable');
    this.recording = true;
  }

  async stopRecording(): Promise<AudioRecordingResult> {
    this.log.push('recorder:stopRecording');
    if (this.failStop) throw new Error('stop failed');
    this.recording = false;
    return {
      uri: 'file:///tmp/answer.m4a',
      base64: 'ZGVtby1hdWRpbw==',
      mimeType: 'audio/m4a',
      durationMs: 1200,
    };
  }

  isRecording(): boolean {
    return this.recording;
  }

  getElapsedSeconds(): number {
    return 1;
  }
}

class FakeStt implements SpeechToTextProvider {
  readonly id = 'fake-stt';
  calls = 0;
  fail = false;
  throwOnTranscribe = false;
  transcript = 'hello world';
  /** Optional gate so a test can hold the transcription in flight. */
  hold: Promise<void> | null = null;

  async transcribe(_input: STTAudioInput): Promise<STTResult> {
    this.calls += 1;
    if (this.hold) await this.hold;
    if (this.throwOnTranscribe) throw new Error('stt down');
    if (this.fail) return { ok: false, error: 'Speech service unavailable' };
    return { ok: true, transcript: this.transcript };
  }
}

/** Records every submission and returns a real-shaped outcome. */
class FakeVoiceService implements AdaptiveLessonVoiceSubmissionPort {
  readonly calls: { method: string; args: readonly unknown[] }[] = [];
  outcome: AdaptiveLessonSubmitOutcome | null = reviewOutcome();
  throwOnSubmit = false;

  async submitReviewAnswer(
    candidateId: string,
    answer: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    return this.record('submitReviewAnswer', [candidateId, answer, stepId]);
  }

  async submitListeningAnswer(
    exerciseId: string,
    answer: string,
    stepId?: string,
    replayCount?: number,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    return this.record('submitListeningAnswer', [exerciseId, answer, stepId, replayCount]);
  }

  async submitSpeakingAnswer(
    answer: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    return this.record('submitSpeakingAnswer', [answer, stepId]);
  }

  async submitPronunciationAttempt(
    transcript: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    return this.record('submitPronunciationAttempt', [transcript, stepId]);
  }

  private async record(
    method: string,
    args: readonly unknown[],
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    this.calls.push({ method, args });
    if (this.throwOnSubmit) throw new Error('service unavailable');
    return this.outcome;
  }
}

function reviewOutcome(): AdaptiveLessonSubmitOutcome {
  return {
    session: { id: 'session' } as unknown as AdaptiveLessonSession,
    result: {
      kind: 'review',
      evaluation: { result: 'correct', feedback: 'Nice work.' },
      persisted: true,
      persistenceError: false,
    },
  };
}

interface Harness {
  readonly log: Log;
  readonly tts: FakeTts;
  readonly recorder: FakeRecorder;
  readonly stt: FakeStt;
  readonly service: FakeVoiceService;
  readonly controller: ReturnType<typeof createAdaptiveLessonVoiceController>;
}

function createHarness(options?: {
  target?: AdaptiveVoiceTarget | null;
  withRecorder?: boolean;
  withStt?: boolean;
  withTts?: boolean;
  service?: FakeVoiceService;
}): Harness {
  const log: Log = [];
  const tts = new FakeTts(log);
  const recorder = new FakeRecorder(log);
  const stt = new FakeStt();
  const service = options?.service ?? new FakeVoiceService();
  recorder.watchTts(() => tts.speaking);

  const controller = createAdaptiveLessonVoiceController({
    service,
    ...(options?.withRecorder === false ? {} : { recorder }),
    ...(options?.withStt === false ? {} : { stt }),
    ...(options?.withTts === false ? {} : { tts }),
  });
  controller.setTarget(options?.target ?? reviewTarget());

  return { log, tts, recorder, stt, service, controller };
}

/* ---------------------------- target fixtures ---------------------------- */

function reviewTarget(overrides?: {
  stepId?: string;
  itemId?: string;
  speakText?: string | null;
}): AdaptiveVoiceTarget {
  return {
    kind: 'review',
    stepId: overrides?.stepId ?? 'step-review',
    itemId: overrides?.itemId ?? 'candidate-1',
    speakText: overrides?.speakText === undefined ? 'What word matches this definition?' : overrides.speakText,
  };
}

function speakingTarget(stepId = 'step-speaking'): AdaptiveVoiceTarget {
  return { kind: 'speaking', stepId, speakText: 'Talk about your week.' };
}

function pronunciationTarget(stepId = 'step-pronunciation'): AdaptiveVoiceTarget {
  return { kind: 'pronunciation', stepId, speakText: 'development' };
}

function listeningTarget(overrides?: {
  stepId?: string;
  itemId?: string;
  audioText?: string;
  choiceBased?: boolean;
}): AdaptiveVoiceTarget {
  return {
    kind: 'listening',
    stepId: overrides?.stepId ?? 'step-listening',
    itemId: overrides?.itemId ?? 'exercise-1',
    audioText: overrides?.audioText ?? 'The deadline is Friday.',
    choiceBased: overrides?.choiceBased ?? false,
  };
}

/** Real listening exercise shape (the EXISTING domain type). */
function listeningExercise(partial: Partial<ListeningExercise> & { id: string }): ListeningExercise {
  return {
    learnerId: 'learner-1',
    type: 'listen_and_answer',
    difficulty: 'easy',
    speakText: 'The deadline is Friday.',
    expectedAnswer: 'Friday',
    keyItems: ['deadline'],
    source: 'general',
    ...partial,
  };
}

/* ================================================================== *
 * 2. Pure parts — targets, audio text, labels, providers
 * ================================================================== */

describe('Voice-first lessons — target resolution and listening integrity', () => {
  it('1. resolves one EXISTING submission path per material kind', () => {
    const reviewMaterial = {
      kind: 'review',
      step: { id: 'step-review' },
      candidates: [
        {
          id: 'candidate-1',
          prompt: 'What word matches this definition?',
          expectedAnswer: 'deadline',
          exerciseType: 'vocabulary_recall',
        },
      ],
    } as unknown as AdaptiveLessonStepMaterial;
    const review = resolveAdaptiveVoiceTarget(reviewMaterial, 0);
    expect(review).toEqual({
      kind: 'review',
      stepId: 'step-review',
      itemId: 'candidate-1',
      speakText: 'What word matches this definition?',
    });
    // The hidden expected answer never becomes speakable text.
    expect(JSON.stringify(review)).not.toContain('deadline');

    const listeningMaterial = {
      kind: 'listening',
      step: { id: 'step-listening' },
      exercises: [listeningExercise({ id: 'exercise-1', question: 'When is it due?' })],
      sourceNote: 'General practice',
    } as unknown as AdaptiveLessonStepMaterial;
    const listening = resolveAdaptiveVoiceTarget(listeningMaterial, 0);
    expect(listening?.kind).toBe('listening');
    expect(listening && listening.kind === 'listening' ? listening.audioText : '').toBe(
      'The deadline is Friday. When is it due?',
    );
    expect(listening && listening.kind === 'listening' ? listening.choiceBased : true).toBe(false);

    const speakingMaterial = {
      kind: 'speaking',
      step: { id: 'step-speaking' },
      prompt: 'Talk about your week.',
      aiAvailable: true,
    } as unknown as AdaptiveLessonStepMaterial;
    expect(resolveAdaptiveVoiceTarget(speakingMaterial, 0)).toEqual({
      kind: 'speaking',
      stepId: 'step-speaking',
      speakText: 'Talk about your week.',
    });

    const pronunciationMaterial = {
      kind: 'pronunciation',
      step: { id: 'step-pronunciation' },
      target: 'development',
      wordExamples: [],
    } as unknown as AdaptiveLessonStepMaterial;
    expect(resolveAdaptiveVoiceTarget(pronunciationMaterial, 0)).toEqual({
      kind: 'pronunciation',
      stepId: 'step-pronunciation',
      speakText: 'development',
    });
  });

  it('2. steps with nothing to answer never offer a voice target', () => {
    const wrapUp = {
      kind: 'wrap_up',
      step: { id: 'step-wrap' },
      lines: ['1 of 3 practice steps completed.'],
    } as unknown as AdaptiveLessonStepMaterial;
    const unavailable = {
      kind: 'unavailable',
      step: { id: 'step-unavailable' },
      message: 'Nothing was available to practice for this step.',
    } as unknown as AdaptiveLessonStepMaterial;

    expect(resolveAdaptiveVoiceTarget(wrapUp, 0)).toBeNull();
    expect(resolveAdaptiveVoiceTarget(unavailable, 0)).toBeNull();
    expect(resolveAdaptiveVoiceTarget(null, 0)).toBeNull();
  });

  it('3. a pronunciation repeat task may speak only the visible repeat target', () => {
    const material = {
      kind: 'review',
      step: { id: 'step-review' },
      candidates: [
        {
          id: 'candidate-pron',
          prompt: 'Listen and repeat clearly: "development"',
          expectedAnswer: 'development',
          exerciseType: 'pronunciation_repeat',
        },
      ],
    } as unknown as AdaptiveLessonStepMaterial;

    const target = resolveAdaptiveVoiceTarget(material, 0);
    expect(target?.kind).toBe('review');
    expect(target?.kind === 'review' ? target.speakText : null).toBe('development');
  });

  it('4. listening audio is the exercise audio only — never the hidden transcript', () => {
    const exercise = listeningExercise({
      id: 'exercise-choice',
      type: 'listen_and_choose',
      speakText: 'I need to meet the deadline.',
      question: undefined,
      expectedAnswer: 'a time by which something must be finished',
      revealedTranscript: undefined,
    } as Partial<ListeningExercise> & { id: string });
    // The existing evaluation reveals the transcript AFTER the answer; the
    // voice layer must never need it before that point.
    const evaluationReveal = 'a time by which something must be finished';

    expect(listeningAudioText(exercise)).toBe('I need to meet the deadline.');
    expect(listeningAudioText(exercise)).not.toContain(evaluationReveal);
    expect(listeningAudioText(exercise)).not.toContain(exercise.expectedAnswer);

    const target = resolveAdaptiveVoiceTarget(
      {
        kind: 'listening',
        step: { id: 'step-listening' },
        exercises: [exercise],
        sourceNote: 'General practice',
      } as unknown as AdaptiveLessonStepMaterial,
      0,
    );
    expect(JSON.stringify(target)).not.toContain(evaluationReveal);
  });

  it('5. choice-based listening exercises stay choice-based', () => {
    expect(
      isChoiceBasedListeningExercise(listeningExercise({ id: 'a', type: 'listen_and_choose' })),
    ).toBe(true);
    expect(
      isChoiceBasedListeningExercise(listeningExercise({ id: 'b', type: 'expression_in_context' })),
    ).toBe(true);
    expect(
      isChoiceBasedListeningExercise(
        listeningExercise({ id: 'c', type: 'listen_and_answer', options: ['one', 'two'] }),
      ),
    ).toBe(true);
    expect(
      isChoiceBasedListeningExercise(listeningExercise({ id: 'd', type: 'listen_and_answer' })),
    ).toBe(false);

    const target = resolveAdaptiveVoiceTarget(
      {
        kind: 'listening',
        step: { id: 'step-listening' },
        exercises: [listeningExercise({ id: 'choice', type: 'listen_and_choose', options: ['x'] })],
        sourceNote: 'General practice',
      } as unknown as AdaptiveLessonStepMaterial,
      0,
    );
    expect(target?.kind === 'listening' ? target.choiceBased : false).toBe(true);
  });

  it('6. the identity of an item drives dedup and replay counting', () => {
    expect(voiceTargetKey(reviewTarget())).toBe('review::step-review::candidate-1');
    expect(voiceTargetKey(speakingTarget())).toBe('speaking::step-speaking::');
    expect(voiceTargetKey(pronunciationTarget())).toBe('pronunciation::step-pronunciation::');
    expect(voiceTargetKey(listeningTarget())).toBe('listening::step-listening::exercise-1');
  });

  it('7. the UI labels expose the real lifecycle state', () => {
    expect(adaptiveVoiceActionLabel('idle')).toBe('Tap to speak');
    expect(adaptiveVoiceActionLabel('recording')).toContain('Listening…');
    expect(adaptiveVoiceActionLabel('transcribing')).toBe('Transcribing…');
    expect(adaptiveVoiceActionLabel('submitting')).toBe('Checking…');
    expect(adaptiveVoiceActionLabel('playing_prompt')).toBe('Playing prompt…');
    expect(adaptiveVoiceActionLabel('feedback', true)).toBe('Playing feedback…');
    expect(adaptiveVoiceActionLabel('error')).toBe('Try again');
  });

  it('8. no demo fallback provider is ever created (honest unavailability)', () => {
    const created: string[] = [];
    const recorder = new FakeRecorder();
    const stt = new FakeStt();

    // No real key configured → NO providers at all, and no factory is called.
    expect(
      resolveAdaptiveVoiceInputProviders({
        getApiKey: () => null,
        createRecorder: () => {
          created.push('recorder');
          return recorder;
        },
        createStt: () => {
          created.push('stt');
          return stt;
        },
      }),
    ).toBeNull();
    expect(created).toEqual([]);

    // A blank key is still "no provider".
    expect(
      resolveAdaptiveVoiceInputProviders({
        getApiKey: () => '   ',
        createRecorder: () => recorder,
        createStt: () => stt,
      }),
    ).toBeNull();

    // A real key produces the REAL providers.
    const providers = resolveAdaptiveVoiceInputProviders({
      getApiKey: () => 'real-key',
      createRecorder: () => recorder,
      createStt: (apiKey) => {
        expect(apiKey).toBe('real-key');
        return stt;
      },
    });
    expect(providers).not.toBeNull();
    expect(providers?.recorder).toBe(recorder);
    expect(providers?.stt).toBe(stt);

    // A broken factory degrades to "no voice", never to a substitute provider.
    expect(
      resolveAdaptiveVoiceInputProviders({
        getApiKey: () => 'real-key',
        createRecorder: () => {
          throw new Error('recorder unavailable');
        },
        createStt: () => stt,
      }),
    ).toBeNull();
    expect(resolveAdaptiveSpeechOutputProvider(() => new FakeTts())).not.toBeNull();
    expect(
      resolveAdaptiveSpeechOutputProvider(() => {
        throw new Error('tts unavailable');
      }),
    ).toBeNull();
  });
});

/* ================================================================== *
 * 3. Lifecycle — ordering, exclusion, duplicates, teardown
 * ================================================================== */

describe('Voice-first lessons — lifecycle integrity', () => {
  it('9. TTS is stopped BEFORE the recorder opens', async () => {
    const { log, tts, recorder, controller } = createHarness({ target: pronunciationTarget() });

    const playing = controller.playPrompt();
    expect(tts.speaking).toBe(true);

    const started = await controller.startRecording();
    expect(started.ok).toBe(true);
    expect(tts.speaking).toBe(false);
    expect(recorder.recording).toBe(true);
    expect(recorder.startedWhileSpeaking).toBe(false);

    const stopIndex = log.indexOf('tts:stop');
    const startIndex = log.indexOf('recorder:startRecording');
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(stopIndex);

    tts.complete();
    await playing;
  });

  it('10. TTS and microphone recording are never active at the same time', async () => {
    const { tts, recorder, controller } = createHarness({ target: speakingTarget() });

    const started = await controller.startRecording();
    expect(started.ok).toBe(true);
    expect(tts.speaking).toBe(false);

    // Playback is refused while the microphone is open.
    const played = await controller.playPrompt();
    expect(played.ok).toBe(false);
    expect(tts.spoken).toEqual([]);
    expect(recorder.recording).toBe(true);

    // The same invariant holds while a transcription/submission is running.
    const second = createHarness({ target: speakingTarget('step-2') });
    const hold = deferred();
    second.stt.hold = hold.promise;
    await second.controller.startRecording();
    const answer = second.controller.stopRecordingAndSubmit();
    expect(second.controller.getStatus().state).toBe('transcribing');
    const refused = await second.controller.playPrompt();
    expect(refused.ok).toBe(false);
    expect(second.tts.spoken).toEqual([]);
    hold.resolve();
    await answer;
  });

  it('11. a double tap cannot duplicate a submission', async () => {
    const { controller, service } = createHarness({ target: reviewTarget() });
    await controller.startRecording();

    const first = controller.stopRecordingAndSubmit();
    const second = controller.stopRecordingAndSubmit();
    const [a, b] = await Promise.all([first, second]);

    expect(service.calls).toHaveLength(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('busy');

    // A later repeat of the SAME answer is answered from the cached outcome and
    // the owning engine is still not asked twice.
    const repeat = await controller.submitTypedAnswer('hello world');
    expect(repeat.ok).toBe(true);
    if (repeat.ok) {
      expect(repeat.duplicate).toBe(true);
      expect(repeat.outcome).toBe(a.ok ? a.outcome : null);
    }
    expect(service.calls).toHaveLength(1);
  });

  it('12. the voice action reports its real state while working', async () => {
    const harness = createHarness({ target: speakingTarget() });
    const hold = deferred();
    harness.stt.hold = hold.promise;

    expect(harness.controller.getStatus().label).toBe('Tap to speak');
    await harness.controller.startRecording();
    expect(harness.controller.getStatus().state).toBe('recording');
    expect(harness.controller.getStatus().label).toContain('Listening…');

    const submitting = harness.controller.stopRecordingAndSubmit();
    expect(harness.controller.getStatus().state).toBe('transcribing');
    expect(harness.controller.getStatus().label).toBe('Transcribing…');

    hold.resolve();
    const result = await submitting;
    expect(result.ok).toBe(true);
    expect(harness.controller.getStatus().state).toBe('feedback');
    expect(harness.service.calls[0].method).toBe('submitSpeakingAnswer');
  });

  it('13. unmount discards an active recording and submits nothing', async () => {
    const { controller, recorder, stt, service } = createHarness({ target: speakingTarget() });
    await controller.startRecording();
    expect(recorder.recording).toBe(true);

    await controller.dispose();

    expect(recorder.recording).toBe(false);
    expect(recorder.log).toContain('recorder:stopRecording');
    expect(stt.calls).toBe(0);
    expect(service.calls).toEqual([]);
    expect(controller.getStatus().state).toBe('idle');
  });

  it('14. unmount during transcription stops playback and never submits late audio', async () => {
    const harness = createHarness({ target: speakingTarget() });
    const hold = deferred();
    harness.stt.hold = hold.promise;

    await harness.controller.startRecording();
    const submitting = harness.controller.stopRecordingAndSubmit();
    expect(harness.controller.getStatus().state).toBe('transcribing');

    await harness.controller.dispose();
    hold.resolve();
    const result = await submitting;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('disposed');
    expect(harness.service.calls).toEqual([]);
    expect(harness.tts.speaking).toBe(false);
  });

  it('15. feedback is spoken only AFTER the answer was judged', async () => {
    const { controller, tts, service } = createHarness({ target: listeningTarget() });

    // Before any answer: refused, so a hidden listening transcript can never be
    // played early.
    const early = await controller.speakFeedback(['Heard: "The deadline is Friday."']);
    expect(early.ok).toBe(false);
    expect(tts.spoken).toEqual([]);
    expect(service.calls).toEqual([]);

    await controller.startRecording();
    const answer = controller.stopRecordingAndSubmit();
    tts.complete();
    await answer;
    expect(controller.getStatus().state).toBe('feedback');

    const spoken = controller.speakFeedback(['Heard: "The deadline is Friday."']);
    expect(tts.spoken).toContain('Heard: "The deadline is Friday."');
    tts.complete();
    expect((await spoken).ok).toBe(true);
  });

  it('16. a TTS failure never rolls back the answer that was already submitted', async () => {
    const { controller, tts, service } = createHarness({ target: reviewTarget() });
    await controller.startRecording();
    const answer = controller.stopRecordingAndSubmit();
    tts.complete();
    const submitted = await answer;
    expect(submitted.ok).toBe(true);
    expect(service.calls).toHaveLength(1);

    tts.failSpeak = true;
    const spoken = await controller.speakFeedback(['Correct', 'Nice work.']);
    expect(spoken.ok).toBe(false);
    if (!spoken.ok) expect(spoken.reason).toBe('speech-failed');
    // The lesson state still shows the real feedback step.
    expect(controller.getStatus().state).toBe('feedback');
    expect(controller.getStatus().lastOutcome).toBe(submitted.ok ? submitted.outcome : null);
  });
});

/* ================================================================== *
 * 4. Routing — the existing submission methods own every answer
 * ================================================================== */

describe('Voice-first lessons — answers route to the owning system', () => {
  it('17. a review transcript goes to submitReviewAnswer', async () => {
    const { controller, stt, service } = createHarness({ target: reviewTarget({ itemId: 'item-7' }) });
    stt.transcript = 'deadline';
    await controller.startRecording();
    const result = await controller.stopRecordingAndSubmit();

    expect(result.ok).toBe(true);
    expect(service.calls).toEqual([
      { method: 'submitReviewAnswer', args: ['item-7', 'deadline', 'step-review'] },
    ]);
    if (result.ok) {
      expect(result.transcript).toBe('deadline');
      expect(result.duplicate).toBe(false);
      expect(result.outcome?.result.kind).toBe('review');
    }
    // The transcript is shown to the learner (status carries it).
    expect(controller.getStatus().transcript).toBe('deadline');
  });

  it('18. a listening transcript goes to submitListeningAnswer with the real replay count', async () => {
    const { controller, tts, stt, service } = createHarness({ target: listeningTarget() });
    stt.transcript = 'Friday';

    // Two real plays of the exercise audio.
    const first = controller.playPrompt();
    tts.complete();
    await first;
    const second = controller.playPrompt();
    tts.complete();
    await second;
    expect(controller.getStatus().replayCount).toBe(2);
    expect(tts.spoken).toEqual(['The deadline is Friday.', 'The deadline is Friday.']);

    await controller.startRecording();
    const result = await controller.stopRecordingAndSubmit();

    expect(result.ok).toBe(true);
    expect(service.calls).toEqual([
      { method: 'submitListeningAnswer', args: ['exercise-1', 'Friday', 'step-listening', 2] },
    ]);
  });

  it('19. a speaking transcript goes to the existing speaking pathway', async () => {
    const { controller, stt, tts, service } = createHarness({ target: speakingTarget('step-say') });
    stt.transcript = 'I had a busy week.';
    await controller.startRecording();
    const answer = controller.stopRecordingAndSubmit();
    tts.complete();
    await answer;

    expect(service.calls).toEqual([
      { method: 'submitSpeakingAnswer', args: ['I had a busy week.', 'step-say'] },
    ]);
  });

  it('20. a pronunciation transcript goes to the existing pronunciation pathway', async () => {
    const { controller, stt, service } = createHarness({
      target: pronunciationTarget('step-pron'),
    });
    stt.transcript = 'development';
    await controller.startRecording();
    await controller.stopRecordingAndSubmit();

    expect(service.calls).toEqual([
      { method: 'submitPronunciationAttempt', args: ['development', 'step-pron'] },
    ]);
    expect(JSON.stringify(service.calls)).not.toMatch(/score|percent|rating/i);
  });

  it('21. a choice-based listening exercise refuses a spoken answer', async () => {
    const { controller, stt, recorder, service } = createHarness({
      target: listeningTarget({ choiceBased: true }),
    });
    const started = await controller.startRecording();

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.reason).toBe('no-target');
      expect(started.message).toBe(CHOICE_EXERCISE_MESSAGE);
    }
    expect(recorder.recording).toBe(false);
    expect(stt.calls).toBe(0);
    expect(service.calls).toEqual([]);
    expect(controller.getStatus().canStartRecording).toBe(false);
  });

  it('22. moving to another item discards the previous audio and resets replays', async () => {
    const { controller, recorder, stt, service } = createHarness({ target: listeningTarget() });
    await controller.startRecording();
    expect(recorder.recording).toBe(true);

    controller.setTarget(listeningTarget({ itemId: 'exercise-2' }));

    expect(recorder.recording).toBe(false);
    expect(controller.getStatus().replayCount).toBe(0);
    expect(stt.calls).toBe(0);
    expect(service.calls).toEqual([]);
  });

  it('23. a typed answer uses the same routing and needs no voice provider', async () => {
    const { controller, service } = createHarness({
      target: listeningTarget(),
      withRecorder: false,
      withStt: false,
      withTts: false,
    });
    expect(controller.getStatus().voiceInputAvailable).toBe(false);
    expect(controller.getStatus().speechOutputAvailable).toBe(false);

    const result = await controller.submitTypedAnswer('Friday');
    expect(result.ok).toBe(true);
    expect(service.calls).toEqual([
      { method: 'submitListeningAnswer', args: ['exercise-1', 'Friday', 'step-listening', 0] },
    ]);
    // Typing is always possible, even with no voice stack at all.
    expect(controller.getStatus().canStartRecording).toBe(false);
  });
});

/* ================================================================== *
 * 5. Failures — a voice failure must record nothing
 * ================================================================== */

describe('Voice-first lessons — failure isolation', () => {
  it('24. microphone denial submits nothing and offers the text fallback', async () => {
    const { controller, recorder, stt, service } = createHarness({ target: speakingTarget() });
    recorder.permissionGranted = false;

    const started = await controller.startRecording();

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.reason).toBe('permission-denied');
      expect(started.message).toBe(PERMISSION_DENIED_MESSAGE);
    }
    expect(recorder.recording).toBe(false);
    expect(recorder.log).not.toContain('recorder:startRecording');
    expect(stt.calls).toBe(0);
    expect(service.calls).toEqual([]);
    expect(controller.getStatus().state).toBe('error');
    expect(controller.getStatus().errorMessage).toBe(PERMISSION_DENIED_MESSAGE);
  });

  it('25. a recorder failure submits nothing', async () => {
    const { controller, recorder, stt, service } = createHarness({ target: speakingTarget() });
    recorder.failStart = true;

    const started = await controller.startRecording();

    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.reason).toBe('recording-failed');
    expect(stt.calls).toBe(0);
    expect(service.calls).toEqual([]);
    expect(controller.getStatus().transcript).toBeNull();
  });

  it('26. an STT failure or an empty transcript submits nothing', async () => {
    for (const setup of ['failed', 'empty', 'threw'] as const) {
      const harness = createHarness({ target: reviewTarget() });
      if (setup === 'failed') harness.stt.fail = true;
      if (setup === 'empty') harness.stt.transcript = '   ';
      if (setup === 'threw') harness.stt.throwOnTranscribe = true;

      await harness.controller.startRecording();
      const result = await harness.controller.stopRecordingAndSubmit();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('transcription-failed');
        expect(result.message).toContain('type your answer');
        if (setup === 'threw') expect(result.message).toBe(TRANSCRIPTION_FAILED_MESSAGE);
        if (setup === 'empty') expect(result.message).toBe(TRANSCRIPTION_FAILED_MESSAGE);
      }
      expect(harness.service.calls).toEqual([]);
      expect(harness.controller.getStatus().state).toBe('error');
      // The learner can retry immediately.
      expect(harness.controller.getStatus().canStartRecording).toBe(true);
    }
  });

  it('27. no voice provider means no microphone affordance and no submission', async () => {
    const { controller, service, stt } = createHarness({
      target: speakingTarget(),
      withRecorder: false,
      withStt: false,
    });

    const started = await controller.startRecording();

    expect(started.ok).toBe(false);
    if (!started.ok) {
      expect(started.reason).toBe('voice-unavailable');
      expect(started.message).toBe(VOICE_UNAVAILABLE_MESSAGE);
    }
    expect(controller.getStatus().voiceInputAvailable).toBe(false);
    expect(stt.calls).toBe(0);
    expect(service.calls).toEqual([]);
  });

  it('28. a failing service reports honestly and is retryable', async () => {
    const { controller, tts, service } = createHarness({ target: reviewTarget() });
    service.throwOnSubmit = true;
    await controller.startRecording();
    const answer = controller.stopRecordingAndSubmit();
    tts.complete();
    const first = await answer;

    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.reason).toBe('submission-failed');
      expect(first.message).toBe(SUBMISSION_FAILED_MESSAGE);
    }
    expect(service.calls).toHaveLength(1);

    service.throwOnSubmit = false;
    const retry = await controller.submitTypedAnswer('hello world');
    expect(retry.ok).toBe(true);
    expect(service.calls).toHaveLength(2);
    expect(retry.ok ? retry.duplicate : true).toBe(false);
  });

  it('29. a refused (null) outcome says nothing was saved and caches nothing', async () => {
    const { controller, service } = createHarness({ target: reviewTarget() });
    service.outcome = null;
    await controller.startRecording();
    const result = await controller.stopRecordingAndSubmit();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('submission-unavailable');
    expect(controller.getStatus().state).toBe('error');

    service.outcome = reviewOutcome();
    const retry = await controller.submitTypedAnswer('hello world');
    expect(retry.ok).toBe(true);
    expect(service.calls).toHaveLength(2);
  });

  it("30. an owning engine's honest refusal (kind: none) is surfaced and is not cached", async () => {
    const { controller, service } = createHarness({ target: reviewTarget() });
    service.outcome = {
      session: { id: 'session' } as unknown as AdaptiveLessonSession,
      result: { kind: 'none', message: 'That item is no longer part of this step.' },
    };
    await controller.startRecording();
    const result = await controller.stopRecordingAndSubmit();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.outcome?.result.kind).toBe('none');
      expect(result.duplicate).toBe(false);
    }
    // Nothing was evaluated or counted, so the answer was NOT cached and the
    // learner can try again.
    expect(controller.getStatus().state).toBe('idle');
    service.outcome = reviewOutcome();
    const retry = await controller.submitTypedAnswer('hello world');
    expect(retry.ok ? retry.duplicate : true).toBe(false);
    expect(service.calls).toHaveLength(2);
  });

  it('31. an empty typed answer is refused without touching the service', async () => {
    const { controller, service } = createHarness({ target: reviewTarget() });
    const result = await controller.submitTypedAnswer('   ');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('empty-answer');
      expect(result.message).toBe(EMPTY_ANSWER_MESSAGE);
    }
    expect(service.calls).toEqual([]);
  });

  it('32. a busy action is refused with an honest message instead of queueing work', async () => {
    const { controller, service } = createHarness({ target: reviewTarget() });
    await controller.startRecording();
    const result = await controller.startRecording();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('busy');
      expect(result.message).toBe(BUSY_MESSAGE);
    }
    expect(service.calls).toEqual([]);
  });

  it('33. a failed TTS playback records nothing', async () => {
    const { controller, tts, service } = createHarness({ target: reviewTarget() });
    tts.failSpeak = true;

    const played = await controller.playPrompt();

    expect(played.ok).toBe(false);
    expect(service.calls).toEqual([]);
    expect(controller.getStatus().state).toBe('error');
  });
});

/* ================================================================== *
 * 6. Real service integration — routing, evidence, progress invariants
 * ================================================================== */

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  repos: AppRepositories;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  review: SQLiteReviewRepository;
  progress: SQLiteProgressRepository;
  pronunciation: SQLitePronunciationRepository;
  profileRepo: SQLiteUserProfileRepository;
}

async function createContext(): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const weaknesses = new SQLiteWeaknessRepository(adapter);
  const vocabulary = new SQLiteVocabularyRepository(adapter);
  const review = new SQLiteReviewRepository(adapter);
  const progress = new SQLiteProgressRepository(adapter);
  const pronunciation = new SQLitePronunciationRepository(adapter);

  const repos: AppRepositories = {
    profile: profileRepo,
    conversations: new SQLiteConversationRepository(adapter),
    mistakes: new SQLiteMistakeRepository(adapter),
    pronunciation,
    weaknesses,
    vocabulary,
    expressions: new SQLiteExpressionRepository(adapter),
    review,
    lessons: { get: async () => null, list: async () => [] },
    exercises: { get: async () => null, list: async () => [] },
    progress,
  };

  const profile = await profileRepo.update({
    displayName: 'Voice Tester',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: ['Work meetings'],
    preferredModes: [],
  });

  return {
    adapter,
    learnerId: profile.id,
    repos,
    weaknesses,
    vocabulary,
    review,
    progress,
    pronunciation,
    profileRepo,
  };
}

function createLessonService(ctx: TestContext, options?: { progressRecords?: { count: number } }) {
  const learnerModel = createLearnerModel(ctx.repos);
  return new AdaptiveLessonService({
    learnerModel,
    profile: ctx.profileRepo,
    review: new ReviewService(ctx.repos),
    listening: createListeningService(ctx.adapter),
    pronunciation: createPronunciationEngine(ctx.adapter),
    progress: {
      record: async (record) => {
        if (options?.progressRecords) options.progressRecords.count += 1;
        return ctx.progress.record(record);
      },
    },
    now: () => NOW,
  });
}

let itemSeq = 500;
function seqId(): string {
  itemSeq += 1;
  return `${String(itemSeq).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

async function seedReviewItem(ctx: TestContext, headword: string): Promise<ReviewItem> {
  const upsert = ctx.review.upsert;
  if (!upsert) throw new Error('review.upsert is required by this test');
  return upsert.call(ctx.review, {
    learnerId: ctx.learnerId,
    kind: 'vocabulary',
    referenceId: seqId(),
    prompt: 'What word matches this definition?',
    expectedResponse: headword,
    state: 'learning',
    dueAt: DUE_AT,
    reviewCount: 0,
    consecutiveCorrect: 0,
    outcomeHistory: [],
  });
}

async function seedListeningWeakness(ctx: TestContext): Promise<LearnerWeakness> {
  return ctx.weaknesses.upsertWeakness({
    learnerId: ctx.learnerId,
    type: 'listening',
    referenceId: stableReferenceId('word_recognition:deadline'),
    severity: 0.6,
    status: 'repeated' as WeaknessStatus,
    lastSeenAt: NOW,
    firstSeenAt: NOW,
    occurrenceCount: 2,
    contexts: [],
    evidence: [],
    notes: 'word_recognition:deadline',
    resolved: false,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Drive the controller from a real prepared step material, submitting through
 * the REAL AdaptiveLessonService (the port assignment is the type-level proof
 * that no submission path is bypassed).
 */
function harnessForService(
  service: AdaptiveLessonService,
  material: AdaptiveLessonStepMaterial,
  itemIndex = 0,
): { harness: Harness; target: AdaptiveVoiceTarget } {
  const target = resolveAdaptiveVoiceTarget(material, itemIndex);
  if (!target) throw new Error('this material has no voice target');

  const log: Log = [];
  const tts = new FakeTts(log);
  const recorder = new FakeRecorder(log);
  const stt = new FakeStt();
  recorder.watchTts(() => tts.speaking);

  const controller = createAdaptiveLessonVoiceController({ service, recorder, stt, tts });
  controller.setTarget(target);

  return {
    harness: { log, tts, recorder, stt, service: new FakeVoiceService(), controller },
    target,
  };
}

describe('Voice-first lessons — real service integration', () => {
  it('34. a spoken review answer flows through ReviewService and updates the real schedule', async () => {
    const ctx = await createContext();
    const item = await seedReviewItem(ctx, 'deadline');
    const service = createLessonService(ctx);

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.type === 'review' || entry.type === 'vocabulary' || entry.type === 'expression',
    );
    expect(step).toBeTruthy();
    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('review');
    if (material?.kind !== 'review') return;

    const { harness } = harnessForService(service, material);
    harness.stt.transcript = material.candidates[0].expectedAnswer;

    const started = await harness.controller.startRecording();
    expect(started.ok).toBe(true);
    const result = await harness.controller.stopRecordingAndSubmit();
    expect(result.ok).toBe(true);

    // The OWNING engine evaluated and persisted the real answer.
    const stored = await ctx.review.get(item.id);
    expect(stored?.reviewCount).toBe(1);
    expect(stored?.outcomeHistory).toHaveLength(1);
    expect(service.getProgress()?.practicedItems).toBe(1);
    if (result.ok && result.outcome?.result.kind === 'review') {
      expect(result.outcome.result.persisted).toBe(true);
    } else {
      throw new Error('expected a persisted review outcome');
    }
  });

  it('35. a spoken listening answer keeps the replay count in the real evidence', async () => {
    const ctx = await createContext();
    const weakness = await seedListeningWeakness(ctx);
    const service = createLessonService(ctx);

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.type === 'listening' && entry.personalized,
    );
    expect(step).toBeTruthy();
    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('listening');
    if (material?.kind !== 'listening') return;

    const { harness, target } = harnessForService(service, material);
    expect(target.kind).toBe('listening');

    // Play the exercise audio twice through the EXISTING TTS provider.
    for (let play = 0; play < 2; play += 1) {
      const playing = harness.controller.playPrompt();
      harness.tts.complete();
      await playing;
    }
    expect(harness.controller.getStatus().replayCount).toBe(2);
    // ONLY the exercise's own audio is ever spoken before the answer: the
    // hidden transcript/expected answer is never spoken or revealed early.
    const exercise = material.exercises[0];
    expect(harness.tts.spoken).toEqual([
      listeningAudioText(exercise),
      listeningAudioText(exercise),
    ]);
    expect(target.kind === 'listening' ? target.audioText : '').toBe(
      listeningAudioText(exercise),
    );

    harness.stt.transcript = 'something completely different';
    await harness.controller.startRecording();
    const result = await harness.controller.stopRecordingAndSubmit();
    expect(result.ok).toBe(true);

    // Existing pathway persisted real evidence with the real replay count.
    const rows = await ctx.weaknesses.listWeaknesses(ctx.learnerId, 50);
    const updated = rows.find((row) => row.id === weakness.id);
    expect(updated).toBeTruthy();
    expect(updated!.contexts).toContain('replays:2');
    expect(updated!.occurrenceCount).toBeGreaterThan(2);
    const evidence = JSON.stringify(updated!.evidence);
    expect(evidence).toContain('replays: 2');
  });

  it('36. a voice failure counts no practice, creates no evidence and completes no step', async () => {
    const ctx = await createContext();
    const item = await seedReviewItem(ctx, 'deadline');
    const progressRecords = { count: 0 };
    const service = createLessonService(ctx, { progressRecords });

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.type === 'review' || entry.type === 'vocabulary' || entry.type === 'expression',
    )!;
    const material = await service.prepareStep(step.id);
    if (material?.kind !== 'review') throw new Error('expected review material');

    const { harness } = harnessForService(service, material);
    harness.stt.fail = true;

    await harness.controller.startRecording();
    const result = await harness.controller.stopRecordingAndSubmit();
    expect(result.ok).toBe(false);

    // Nothing was evaluated, counted, persisted or advanced.
    const stored = await ctx.review.get(item.id);
    expect(stored?.reviewCount).toBe(0);
    expect(stored?.outcomeHistory).toHaveLength(0);
    const state = service.getCurrentSession()?.steps.find((entry) => entry.stepId === step.id);
    expect(state?.practicedItems).toBe(0);
    expect(state?.status).not.toBe('completed');
    expect(service.getCurrentSession()?.completedAt).toBeUndefined();
    expect(service.getProgress()?.practicedItems).toBe(0);
    expect(service.getProgress()?.practiceStepsCompleted).toBe(0);
    expect(progressRecords.count).toBe(0);
    expect(service.getLastSummary()).toBeNull();
  });

  it('37. microphone denial counts no practice and creates no review history', async () => {
    const ctx = await createContext();
    const item = await seedReviewItem(ctx, 'deadline');
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.type === 'review' || entry.type === 'vocabulary' || entry.type === 'expression',
    )!;
    const material = await service.prepareStep(step.id);
    if (material?.kind !== 'review') throw new Error('expected review material');

    const { harness } = harnessForService(service, material);
    harness.recorder.permissionGranted = false;

    const started = await harness.controller.startRecording();
    expect(started.ok).toBe(false);

    const stored = await ctx.review.get(item.id);
    expect(stored?.reviewCount).toBe(0);
    const reviewRows = await ctx.review.list(ctx.learnerId, 50);
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0].outcomeHistory).toHaveLength(0);
    expect(service.getProgress()?.practicedItems).toBe(0);
  });

  it('38. a speaking answer with no AI provider is accepted as practice but never fabricated', async () => {
    const ctx = await createContext();
    await seedReviewItem(ctx, 'deadline');
    const progressRecords = { count: 0 };
    const service = createLessonService(ctx, { progressRecords });

    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find((entry) => entry.type === 'speaking');
    expect(step).toBeTruthy();
    const material = await service.prepareStep(step!.id);
    expect(material?.kind).toBe('speaking');
    if (material?.kind !== 'speaking') return;
    expect(material.aiAvailable).toBe(false);

    const { harness } = harnessForService(service, material);
    harness.stt.transcript = 'I had a busy week.';
    await harness.controller.startRecording();
    const result = await harness.controller.stopRecordingAndSubmit();
    expect(result.ok).toBe(true);

    if (result.ok && result.outcome?.result.kind === 'speaking') {
      // No fabricated evaluation: the existing port reports it is unavailable.
      expect(result.outcome.result.feedback.evaluatedBy).toBe('unavailable');
      expect(result.outcome.result.feedback.lines.join(' ')).toMatch(/not available/i);
      expect(JSON.stringify(result.outcome.result.feedback)).not.toMatch(/score|percent|rating/i);
    }
    expect(service.getProgress()?.practicedItems).toBe(1);
  });

  it('39. cancelling an active recording leaves the lesson untouched', async () => {
    const ctx = await createContext();
    const item = await seedReviewItem(ctx, 'deadline');
    const service = createLessonService(ctx);
    const session = (await service.startLesson()).session!;
    const step = session.plan.steps.find(
      (entry) => entry.type === 'review' || entry.type === 'vocabulary' || entry.type === 'expression',
    )!;
    const material = await service.prepareStep(step.id);
    if (material?.kind !== 'review') throw new Error('expected review material');

    const { harness } = harnessForService(service, material);
    await harness.controller.startRecording();
    await harness.controller.cancelRecording();

    expect(harness.recorder.recording).toBe(false);
    expect(harness.stt.calls).toBe(0);
    expect(harness.controller.getStatus().state).toBe('idle');
    const stored = await ctx.review.get(item.id);
    expect(stored?.reviewCount).toBe(0);
    expect(service.getProgress()?.practicedItems).toBe(0);
  });
});

/* ================================================================== *
 * 7. Structural checks — scope discipline
 * ================================================================== */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('Voice-first lessons — architecture and scope discipline', () => {
  const voiceSrc = readFileSync(join(__dirname, './voice.ts'), 'utf8');
  const screenSrc = readFileSync(join(__dirname, '../screens/AdaptiveLessonScreen.tsx'), 'utf8');
  const indexSrc = readFileSync(join(__dirname, './index.ts'), 'utf8');

  it('40. the voice layer reuses the existing voice stack and engine surface', () => {
    expect(voiceSrc).toContain("from '../voice/types'");
    expect(voiceSrc).toContain("from '../providers/stt'");
    expect(voiceSrc).toContain("from '../providers/tts'");
    expect(voiceSrc).toContain("from '../listening/types'");
    // Every answer goes through the EXISTING submission methods.
    expect(voiceSrc).toContain('submitReviewAnswer');
    expect(voiceSrc).toContain('submitListeningAnswer');
    expect(voiceSrc).toContain('submitSpeakingAnswer');
    expect(voiceSrc).toContain('submitPronunciationAttempt');
    // No second engine, scheduler, evaluator, store or table.
    const src = stripComments(voiceSrc);
    expect(src).not.toMatch(/CREATE TABLE|ALTER TABLE|PRAGMA user_version/i);
    expect(src).not.toContain('data/local/sqlite');
    expect(src).not.toContain('transitionWeaknessLifecycle');
    expect(src).not.toContain('calculateNextIntervalDays');
    expect(src).not.toContain('new ReviewService');
    expect(src).not.toContain('new ReviewPlanner');
    expect(src).not.toMatch(/planListeningSession|buildWeaknessExercise/);
    expect(src).not.toContain('recordSessionCompleted');
    // No demo/substitute voice provider may ever be created here.
    expect(src).not.toMatch(/createDemo(STT|TTS|AudioRecorder|AIProvider)/);
    expect(src).not.toContain('DemoAIProvider');
    expect(src).not.toMatch(/gemini|openai|elevenlabs/i);
    expect(indexSrc).toContain("export * from './voice'");
  });

  it('41. the screen wires the voice layer to the EXISTING providers and lifecycle', () => {
    expect(screenSrc).toContain('createAdaptiveLessonVoiceController');
    expect(screenSrc).toContain('resolveAdaptiveVoiceTarget');
    expect(screenSrc).toContain('resolveAdaptiveVoiceInputProviders');
    expect(screenSrc).toContain('controller.dispose()');
    expect(screenSrc).toContain('createExpoAudioRecorder');
    expect(screenSrc).toContain('createGeminiSTTProvider');
    expect(screenSrc).toContain('createExpoTTSProvider');
    // Still the Phase 1 service surface, still no SQLite and no demo engine.
    expect(screenSrc).toContain('AdaptiveLessonService');
    expect(screenSrc).toContain('createDefaultAdaptiveLessonService');
    expect(screenSrc).toContain('prepareStep');
    expect(screenSrc).toContain('skipStep');
    expect(screenSrc).toContain('completeLesson');
    expect(screenSrc).toContain('submitPronunciationAttempt');
    expect(screenSrc).not.toContain('ExpoSqliteAdapter');
    expect(screenSrc).not.toContain('data/local/sqlite');
    const src = stripComments(screenSrc);
    expect(src).not.toMatch(/\b(XP|streak|streaks|badge|badges|leaderboard|levelUp)\b/i);
    expect(src).not.toMatch(/estimatedMinutes|durationMinutes|minutesLeft/);
    // The primary voice action shows its real state and the transcript that
    // was submitted is shown to the learner.
    expect(screenSrc).toContain('Tap to speak');
    expect(screenSrc).toContain('Playing feedback…');
    expect(screenSrc).toContain('You said');
    expect(screenSrc).toContain('Hear feedback');
    // The real replay count is preserved on the text path too.
    expect(screenSrc).toContain('replayCount');
    expect(screenSrc).toMatch(/submitListeningAnswer\(\s*exercise\.id,\s*answer,\s*currentStep\.id,\s*replayCount,?\s*\)/);
  });

  it('42. the feature introduces no new dependency', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const files = [
      './voice.ts',
      '../screens/AdaptiveLessonScreen.tsx',
      '../adaptive-lessons/index.ts',
    ];
    const importPattern = /(?:from|import)\s+\(?\s*'([^'.][^']*)'/g;
    for (const file of files) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      let match = importPattern.exec(src);
      while (match !== null) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) {
          const packageName = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0];
          expect(declared.has(packageName), `${file} imports undeclared ${packageName}`).toBe(true);
        }
        match = importPattern.exec(src);
      }
      importPattern.lastIndex = 0;
    }
  });

  it('43. voice status never exposes a score, percentage or rating', async () => {
    const harness = createHarness({ target: reviewTarget() });
    const spy = vi.fn();
    harness.controller.subscribe(spy);
    await harness.controller.startRecording();
    await harness.controller.stopRecordingAndSubmit();

    const serialized = JSON.stringify(harness.controller.getStatus());
    expect(serialized).not.toMatch(/score|percent|rating|grade/i);
    expect(spy).toHaveBeenCalled();
  });
});
