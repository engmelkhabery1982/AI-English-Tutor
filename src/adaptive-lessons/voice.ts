/**
 * src/adaptive-lessons/voice.ts
 *
 * Voice-first execution for Adaptive Lessons (Phase 2).
 *
 * WHAT THIS MODULE IS
 * - The lifecycle + routing layer that lets the EXISTING voice stack drive an
 *   adaptive lesson: tutor prompt → EXISTING TextToSpeechProvider, learner
 *   answer → EXISTING recorder → EXISTING SpeechToTextProvider → transcript
 *   shown to the learner → submission through the EXISTING
 *   AdaptiveLessonService methods (which delegate to the owning engine).
 * - A real, explicit state machine (idle / playing_prompt / recording /
 *   transcribing / submitting / feedback / error) with overlapping operations
 *   refused and TTS/microphone mutual exclusion enforced.
 *
 * WHAT THIS MODULE IS NOT
 * - No second lesson engine, no second evaluator, no second scheduler, no
 *   second persistence path: every submission goes through
 *   AdaptiveLessonService.submitReviewAnswer / submitListeningAnswer /
 *   submitSpeakingAnswer / submitPronunciationAttempt.
 * - No new voice stack: the recorder, the STT provider and the TTS provider
 *   are the EXISTING abstractions, injected (never re-implemented).
 * - No silent demo fallback: when no real speech provider is configured the
 *   voice actions are simply unavailable (text remains the fallback) and
 *   nothing is ever fabricated.
 * - No scores, percentages, ratings, XP or streaks anywhere.
 *
 * HONESTY RULES
 * - A voice failure (permission denied, recording failure, transcription
 *   failure, TTS failure, unavailable provider, unavailable engine) submits
 *   NOTHING: no practice count, no weakness evidence, no review history, no
 *   automatic advance and no completed step. The learner can retry or type.
 * - A listening exercise may only ever be PLAYED through its own exercise
 *   audio; the hidden transcript/expected answer is never spoken before the
 *   learner answers (and the reveal still comes from the existing engine's
 *   evaluation, after submission).
 * - Duplicate submissions cannot happen: identical answers for the same item
 *   are answered from the lesson's cached outcome instead of being sent twice.
 */

import type { ListeningExercise } from '../listening/types';
import type { SpeechToTextProvider } from '../providers/stt';
import type { TextToSpeechProvider } from '../providers/tts';
import type { AudioRecorderService, AudioRecordingResult } from '../voice/types';
import type { AdaptiveLessonStepMaterial, AdaptiveLessonSubmitOutcome } from './types';

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/** Real, learner-visible voice lifecycle of one lesson step. */
export type AdaptiveVoiceState =
  | 'idle'
  | 'playing_prompt'
  | 'recording'
  | 'transcribing'
  | 'submitting'
  | 'feedback'
  | 'error';

/** Why a voice action could not run. Each reason maps to an honest message. */
export type AdaptiveVoiceFailureReason =
  | 'no-target'
  | 'voice-unavailable'
  | 'speech-unavailable'
  | 'permission-denied'
  | 'recording-failed'
  | 'transcription-failed'
  | 'empty-answer'
  | 'submission-failed'
  | 'submission-unavailable'
  | 'speech-failed'
  | 'busy'
  | 'disposed';

export interface AdaptiveVoiceFailure {
  readonly ok: false;
  readonly reason: AdaptiveVoiceFailureReason;
  /** Learner-facing message. Always explains that nothing was saved. */
  readonly message: string;
}

export interface AdaptiveVoicePlayResult {
  readonly ok: true;
}

export interface AdaptiveVoiceRecordingStart {
  readonly ok: true;
}

export interface AdaptiveVoiceAnswerResult {
  readonly ok: true;
  /** Outcome produced by the OWNING existing system (never a lesson copy). */
  readonly outcome: AdaptiveLessonSubmitOutcome | null;
  /** The transcript the learner's speech produced. */
  readonly transcript: string;
  /** True when this exact answer was already sent for this item. */
  readonly duplicate: boolean;
}

export type AdaptiveVoiceFailureResult = AdaptiveVoiceFailure;

/* ------------------------------------------------------------------ *
 * Honest messages (single source of truth for the UI)
 * ------------------------------------------------------------------ */

export const VOICE_UNAVAILABLE_MESSAGE =
  'Voice capture needs a configured speech provider. You can type your answer instead.';

export const SPEECH_UNAVAILABLE_MESSAGE =
  'Audio playback is not available right now. You can still read the task and answer.';

export const PERMISSION_DENIED_MESSAGE =
  'Microphone permission was denied, so nothing was recorded. You can type your answer instead.';

export const RECORDING_FAILED_MESSAGE =
  'Recording could not start, so nothing was recorded. You can type your answer instead.';

export const TRANSCRIPTION_FAILED_MESSAGE =
  'Speech could not be transcribed, so nothing was sent. You can type your answer instead.';

export const EMPTY_ANSWER_MESSAGE =
  'No speech was recognized, so nothing was sent. You can try again or type your answer.';

export const SUBMISSION_FAILED_MESSAGE =
  'That answer could not be checked right now. Nothing was saved. You can try again or type.';

export const SUBMISSION_UNAVAILABLE_MESSAGE =
  'This step is no longer open, so the answer was not sent and nothing was saved.';

export const NO_VOICE_TARGET_MESSAGE =
  'This step does not take a spoken answer. Use the options or type your answer.';

export const CHOICE_EXERCISE_MESSAGE =
  'This exercise is answered by choosing an option, so listening stays choice-based.';

export const BUSY_MESSAGE = 'Please wait for the current voice action to finish.';

export const DISPOSED_MESSAGE = 'This lesson was closed.';

export const FEEDBACK_NOT_READY_MESSAGE =
  'Feedback cannot be played before your answer has been checked.';

export const SPEECH_FAILED_MESSAGE =
  'Feedback could not be played aloud. You can read it below.';

/* ------------------------------------------------------------------ *
 * Targets — which EXISTING submission path an item uses
 * ------------------------------------------------------------------ */

/**
 * What the learner is currently answering. Derived from the material the
 * EXISTING owning systems produced; `speakText`/`audioText` only ever hold
 * text the learner can already see (or the exercise's own audio).
 */
export type AdaptiveVoiceTarget =
  | {
      readonly kind: 'review';
      readonly stepId: string;
      readonly itemId: string;
      /** Task text the tutor may speak. Never the hidden expected answer. */
      readonly speakText: string | null;
    }
  | {
      readonly kind: 'listening';
      readonly stepId: string;
      readonly itemId: string;
      /** The exercise's OWN audio (speakText + question) — nothing else. */
      readonly audioText: string;
      /** Choice exercises stay choice-based: no spoken answer is offered. */
      readonly choiceBased: boolean;
    }
  | {
      readonly kind: 'speaking';
      readonly stepId: string;
      readonly speakText: string | null;
    }
  | {
      readonly kind: 'pronunciation';
      readonly stepId: string;
      readonly speakText: string | null;
    };

/**
 * Choice-based listening exercises keep their options. Everything else is
 * genuinely open-ended and can therefore take a spoken answer.
 */
export function isChoiceBasedListeningExercise(exercise: ListeningExercise): boolean {
  if (exercise.type === 'listen_and_choose' || exercise.type === 'expression_in_context') {
    return true;
  }
  return (exercise.options?.length ?? 0) > 0;
}

/**
 * The exercise's own audio text. Deliberately built from `speakText` and the
 * comprehension `question` only: the expected answer and the (hidden) revealed
 * transcript are never included, and are never spoken before the answer.
 */
export function listeningAudioText(exercise: ListeningExercise): string {
  const spoken = exercise.speakText.trim();
  const question = exercise.question?.trim();
  if (!question) return spoken;
  return spoken.length > 0 ? `${spoken} ${question}` : question;
}

function trimOrNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the voice target for the material the learner is looking at.
 * Returns null for steps that have no answer (wrap-up, unavailable) so no
 * voice affordance is ever offered for them.
 */
export function resolveAdaptiveVoiceTarget(
  material: AdaptiveLessonStepMaterial | null | undefined,
  itemIndex = 0,
): AdaptiveVoiceTarget | null {
  if (!material) return null;

  switch (material.kind) {
    case 'review': {
      const candidate = material.candidates[itemIndex];
      if (!candidate) return null;
      // Repeat tasks practice a target the learner already sees, so it may be
      // spoken. Every other review item keeps its expected answer hidden.
      const speakText =
        candidate.exerciseType === 'pronunciation_repeat'
          ? trimOrNull(candidate.expectedAnswer)
          : trimOrNull(candidate.prompt);
      return {
        kind: 'review',
        stepId: material.step.id,
        itemId: candidate.id,
        speakText,
      };
    }
    case 'listening': {
      const exercise = material.exercises[itemIndex];
      if (!exercise) return null;
      return {
        kind: 'listening',
        stepId: material.step.id,
        itemId: exercise.id,
        audioText: listeningAudioText(exercise),
        choiceBased: isChoiceBasedListeningExercise(exercise),
      };
    }
    case 'speaking':
      return {
        kind: 'speaking',
        stepId: material.step.id,
        speakText: trimOrNull(material.prompt),
      };
    case 'pronunciation':
      return {
        kind: 'pronunciation',
        stepId: material.step.id,
        speakText: trimOrNull(material.target),
      };
    default:
      // 'wrap_up' and 'unavailable' have nothing to answer.
      return null;
  }
}

/** Stable identity of one answerable item (used for dedup + replay counts). */
export function voiceTargetKey(target: AdaptiveVoiceTarget): string {
  const itemId = target.kind === 'listening' || target.kind === 'review' ? target.itemId : '';
  return `${target.kind}::${target.stepId}::${itemId}`;
}

/* ------------------------------------------------------------------ *
 * Learner-visible state labels
 * ------------------------------------------------------------------ */

/** Primary action label for the current lifecycle state. */
export function adaptiveVoiceActionLabel(
  state: AdaptiveVoiceState,
  speakingFeedback = false,
): string {
  switch (state) {
    case 'playing_prompt':
      return 'Playing prompt…';
    case 'recording':
      return 'Listening… Tap to stop';
    case 'transcribing':
      return 'Transcribing…';
    case 'submitting':
      return 'Checking…';
    case 'feedback':
      return speakingFeedback ? 'Playing feedback…' : 'Tap to speak again';
    case 'error':
      return 'Try again';
    case 'idle':
    default:
      return 'Tap to speak';
  }
}

/** Short honest hint shown under the voice action (no metrics). */
export function adaptiveVoiceStateHint(state: AdaptiveVoiceState): string | null {
  switch (state) {
    case 'playing_prompt':
      return null;
    case 'recording':
      return 'Tap the button again to send what you said.';
    case 'transcribing':
      return 'Your recording is being turned into text.';
    case 'submitting':
      return 'Checking your answer with the practice system that owns it.';
    case 'feedback':
      return 'Your answer was sent. You can read the feedback below.';
    case 'error':
      return null;
    case 'idle':
    default:
      return 'Speak your answer, or type it below.';
  }
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

export interface AdaptiveVoiceStatus {
  readonly state: AdaptiveVoiceState;
  /** e.g. "Tap to speak", "Listening… Tap to stop", "Checking…". */
  readonly label: string;
  readonly hint: string | null;
  /** Transcript produced by the EXISTING STT provider, shown to the learner. */
  readonly transcript: string | null;
  readonly errorMessage: string | null;
  /** Real outcome of the last submission (owning engine output). */
  readonly lastOutcome: AdaptiveLessonSubmitOutcome | null;
  /** How many times the current listening exercise audio was played. */
  readonly replayCount: number;
  readonly voiceInputAvailable: boolean;
  readonly speechOutputAvailable: boolean;
  readonly speakingFeedback: boolean;
  readonly canPlayPrompt: boolean;
  readonly canStartRecording: boolean;
  readonly canStopRecording: boolean;
  readonly canSpeakFeedback: boolean;
  readonly isBusy: boolean;
}

export type AdaptiveVoiceStatusListener = (status: AdaptiveVoiceStatus) => void;

/* ------------------------------------------------------------------ *
 * Submission port (the EXISTING AdaptiveLessonService surface)
 * ------------------------------------------------------------------ */

/**
 * The EXISTING submission surface of AdaptiveLessonService. Declared
 * structurally so the real service satisfies it unchanged — this module never
 * re-implements evaluation, scheduling or persistence.
 */
export interface AdaptiveLessonVoiceSubmissionPort {
  submitReviewAnswer(
    candidateId: string,
    answer: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null>;
  submitListeningAnswer(
    exerciseId: string,
    answer: string,
    stepId?: string,
    replayCount?: number,
  ): Promise<AdaptiveLessonSubmitOutcome | null>;
  submitSpeakingAnswer(
    answer: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null>;
  submitPronunciationAttempt(
    transcript: string,
    stepId?: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null>;
}

export interface AdaptiveLessonVoiceControllerDeps {
  /** The EXISTING AdaptiveLessonService (all submissions go through it). */
  readonly service: AdaptiveLessonVoiceSubmissionPort;
  /** EXISTING recorder. Absent → no microphone affordance at all. */
  readonly recorder?: AudioRecorderService;
  /** EXISTING STT provider. Absent → no microphone affordance at all. */
  readonly stt?: SpeechToTextProvider;
  /** EXISTING TTS provider. Absent → nothing can be played aloud. */
  readonly tts?: TextToSpeechProvider;
}

/* ------------------------------------------------------------------ *
 * Controller
 * ------------------------------------------------------------------ */

export class AdaptiveLessonVoiceController {
  private readonly service: AdaptiveLessonVoiceSubmissionPort;
  private readonly recorder: AudioRecorderService | null;
  private readonly stt: SpeechToTextProvider | null;
  private readonly tts: TextToSpeechProvider | null;

  private state: AdaptiveVoiceState = 'idle';
  private target: AdaptiveVoiceTarget | null = null;
  private transcript: string | null = null;
  private errorMessage: string | null = null;
  private replayCount = 0;
  private speakingFeedback = false;
  private pendingStart = false;
  private disposed = false;
  private lastOutcome: AdaptiveLessonSubmitOutcome | null = null;

  /** Cached outcomes keyed by item + normalized answer (double-tap safety). */
  private readonly outcomes = new Map<string, AdaptiveLessonSubmitOutcome>();
  private readonly listeners = new Set<AdaptiveVoiceStatusListener>();
  /** Invalidates completions of speech that was stopped/replaced. */
  private speakToken = 0;

  constructor(deps: AdaptiveLessonVoiceControllerDeps) {
    this.service = deps.service;
    this.recorder = deps.recorder ?? null;
    this.stt = deps.stt ?? null;
    this.tts = deps.tts ?? null;
  }

  /* ------------------------------ wiring ----------------------------- */

  /**
   * Point the controller at the item the learner is answering.
   *
   * Moving to another item discards audio that belongs to the previous one,
   * resets the replay count (so it is preserved per exercise, never leaked)
   * and stops playback that belonged to the old item.
   */
  setTarget(target: AdaptiveVoiceTarget | null): void {
    const nextKey = target ? voiceTargetKey(target) : null;
    const currentKey = this.target ? voiceTargetKey(this.target) : null;
    this.target = target;
    if (nextKey === currentKey) return;

    this.replayCount = 0;
    this.transcript = null;
    this.lastOutcome = null;
    this.errorMessage = null;

    if (this.state === 'recording') {
      // Never send audio for a different item.
      void this.cancelRecording();
    } else if (this.state !== 'submitting' && this.state !== 'transcribing') {
      if (this.state !== 'idle') this.setState('idle');
    }
    void this.stopSpeakingInternal();
    this.speakToken += 1;
    this.speakingFeedback = false;
    this.notify();
  }

  getTarget(): AdaptiveVoiceTarget | null {
    return this.target;
  }

  subscribe(listener: AdaptiveVoiceStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): AdaptiveVoiceStatus {
    const voiceInputAvailable = Boolean(this.recorder && this.stt);
    const speechOutputAvailable = Boolean(this.tts);
    const target = this.target;
    const choiceBased = target?.kind === 'listening' && target.choiceBased;
    const promptText =
      target === null
        ? null
        : target.kind === 'listening'
          ? trimOrNull(target.audioText)
          : target.speakText;
    const busy = this.isBusy();

    return {
      state: this.state,
      label: adaptiveVoiceActionLabel(this.state, this.speakingFeedback),
      hint: this.state === 'error' && this.errorMessage
        ? this.errorMessage
        : adaptiveVoiceStateHint(this.state),
      transcript: this.transcript,
      errorMessage: this.errorMessage,
      lastOutcome: this.lastOutcome,
      replayCount: this.replayCount,
      voiceInputAvailable,
      speechOutputAvailable,
      speakingFeedback: this.speakingFeedback,
      canPlayPrompt:
        !this.disposed &&
        !busy &&
        this.state !== 'playing_prompt' &&
        speechOutputAvailable &&
        promptText !== null,
      canStartRecording:
        !this.disposed &&
        !busy &&
        voiceInputAvailable &&
        target !== null &&
        !choiceBased,
      canStopRecording: !this.disposed && this.state === 'recording',
      canSpeakFeedback:
        !this.disposed &&
        !busy &&
        speechOutputAvailable &&
        this.state === 'feedback' &&
        this.lastOutcome !== null,
      isBusy: busy,
    };
  }

  /* ----------------------------- actions ----------------------------- */

  /**
   * Speak the task through the EXISTING TTS provider.
   *
   * Listening exercises play their OWN audio and each play is counted, so the
   * real replay count is preserved into the existing evaluation path. Nothing
   * hidden is ever spoken: the text comes from the resolved target.
   */
  async playPrompt(): Promise<AdaptiveVoicePlayResult | AdaptiveVoiceFailure> {
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
    const target = this.target;
    if (!target) return this.fail('no-target', NO_VOICE_TARGET_MESSAGE);

    const text =
      target.kind === 'listening' ? trimOrNull(target.audioText) : target.speakText;
    if (!text) return this.fail('no-target', NO_VOICE_TARGET_MESSAGE);

    if (this.isBusy() || this.state === 'playing_prompt') {
      // Never start speech while the microphone is open (or about to be).
      return this.fail('busy', BUSY_MESSAGE);
    }
    const tts = this.tts;
    if (!tts) return this.fail('speech-unavailable', SPEECH_UNAVAILABLE_MESSAGE);

    this.errorMessage = null;
    const token = (this.speakToken += 1);
    this.setState('playing_prompt');

    try {
      await tts.speak(text);
    } catch {
      if (token === this.speakToken) {
        this.state = 'idle';
        this.notify();
      }
      return this.fail('speech-unavailable', SPEECH_UNAVAILABLE_MESSAGE);
    }

    if (token !== this.speakToken) {
      // Playback was stopped (e.g. the learner started recording): the token
      // was invalidated, so this completion must not touch the live state.
      return { ok: true };
    }
    // The exercise audio really played: the real replay count is preserved for
    // the existing listening evaluation path.
    if (target.kind === 'listening') this.replayCount += 1;
    this.state = 'idle';
    this.notify();
    return { ok: true };
  }

  /**
   * Open the microphone.
   *
   * Order is enforced: any TTS playback is stopped and awaited BEFORE the
   * recorder is opened, so TTS and recording never run concurrently. Every
   * failure path (permission, recorder, provider) records nothing.
   */
  async startRecording(): Promise<AdaptiveVoiceRecordingStart | AdaptiveVoiceFailure> {
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
    const target = this.target;
    if (!target) return this.fail('no-target', NO_VOICE_TARGET_MESSAGE);
    if (target.kind === 'listening' && target.choiceBased) {
      return this.fail('no-target', CHOICE_EXERCISE_MESSAGE);
    }
    if (this.isBusy()) return this.fail('busy', BUSY_MESSAGE);

    const recorder = this.recorder;
    const stt = this.stt;
    if (!recorder || !stt) return this.fail('voice-unavailable', VOICE_UNAVAILABLE_MESSAGE);

    this.errorMessage = null;
    this.transcript = null;
    this.pendingStart = true;
    this.notify();

    try {
      // 1. TTS must be silent before the microphone opens.
      await this.stopSpeakingInternal();
      this.speakToken += 1;
      this.speakingFeedback = false;
      if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
      if (this.state === 'playing_prompt') this.setState('idle');

      // 2. Permission — a denial records and submits nothing.
      const granted = await this.ensureMicrophonePermission(recorder);
      if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
      if (!granted) return this.fail('permission-denied', PERMISSION_DENIED_MESSAGE);

      // 3. Only now may the recorder start.
      await recorder.startRecording();
      if (this.disposed) {
        await this.discardRecording();
        return this.fail('disposed', DISPOSED_MESSAGE);
      }
    } catch {
      this.pendingStart = false;
      return this.fail('recording-failed', RECORDING_FAILED_MESSAGE);
    }

    this.pendingStart = false;
    this.setState('recording');
    return { ok: true };
  }

  /**
   * Stop the recording, transcribe it with the EXISTING STT provider and
   * submit the transcript through the EXISTING AdaptiveLessonService method
   * that owns this item. Failures record nothing at all.
   */
  async stopRecordingAndSubmit(): Promise<AdaptiveVoiceAnswerResult | AdaptiveVoiceFailure> {
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
    const target = this.target;
    if (!target) return this.fail('no-target', NO_VOICE_TARGET_MESSAGE);
    if (this.state !== 'recording') return this.fail('busy', BUSY_MESSAGE);

    const recorder = this.recorder;
    const stt = this.stt;
    if (!recorder || !stt) return this.fail('voice-unavailable', VOICE_UNAVAILABLE_MESSAGE);

    this.errorMessage = null;
    this.setState('transcribing');

    let audio: AudioRecordingResult;
    try {
      audio = await recorder.stopRecording();
    } catch {
      return this.fail('recording-failed', RECORDING_FAILED_MESSAGE);
    }
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);

    let transcript = '';
    try {
      const result = await stt.transcribe({
        uri: audio.uri,
        ...(audio.base64 ? { base64: audio.base64 } : {}),
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
      });
      if (result.ok) transcript = (result.transcript ?? '').trim();
      if (!transcript && !this.disposed) {
        const detail = result.error?.trim();
        return this.fail(
          'transcription-failed',
          detail ? `${detail} You can type your answer instead.` : TRANSCRIPTION_FAILED_MESSAGE,
        );
      }
    } catch {
      if (!this.disposed) {
        return this.fail('transcription-failed', TRANSCRIPTION_FAILED_MESSAGE);
      }
    }
    // An unmounted/closed lesson must never submit late audio.
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);

    this.transcript = transcript;
    return this.submitTranscript(transcript);
  }

  /**
   * Submit a typed answer through the SAME gate (correct owning path, same
   * double-submission protection). Text never requires a voice provider.
   */
  async submitTypedAnswer(answer: string): Promise<AdaptiveVoiceAnswerResult | AdaptiveVoiceFailure> {
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
    if (this.isBusy()) return this.fail('busy', BUSY_MESSAGE);
    if (!this.target) return this.fail('no-target', NO_VOICE_TARGET_MESSAGE);
    return this.submitTranscript(answer);
  }

  /** Abandon an active recording without transcribing or submitting it. */
  async cancelRecording(): Promise<void> {
    if (this.state === 'recording') {
      await this.discardRecording();
      this.transcript = null;
      if (this.state === 'recording') this.setState('idle');
    }
    this.pendingStart = false;
  }

  /**
   * Speak qualitative feedback AFTER the answer was judged by the owning
   * engine. Refused in every other state, so nothing hidden is spoken early.
   * A TTS failure never rolls back the submission or the feedback itself.
   */
  async speakFeedback(lines: readonly string[]): Promise<AdaptiveVoicePlayResult | AdaptiveVoiceFailure> {
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
    const text = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .trim();
    if (!text) return this.fail('no-target', NO_VOICE_TARGET_MESSAGE);
    if (this.state !== 'feedback' || this.lastOutcome === null) {
      return this.fail('busy', FEEDBACK_NOT_READY_MESSAGE);
    }
    const tts = this.tts;
    if (!tts) return this.fail('speech-unavailable', SPEECH_UNAVAILABLE_MESSAGE);

    const token = (this.speakToken += 1);
    this.speakingFeedback = true;
    this.notify();
    try {
      await tts.speak(text);
    } catch {
      if (token === this.speakToken) {
        this.speakingFeedback = false;
        this.notify();
      }
      // Feedback stays on screen; only the playback failed.
      return this.fail('speech-failed', SPEECH_FAILED_MESSAGE);
    }
    if (token === this.speakToken) {
      this.speakingFeedback = false;
      this.notify();
    }
    return { ok: true };
  }

  /** Stop any playback (safe to call at any time). */
  async stopSpeaking(): Promise<void> {
    await this.stopSpeakingInternal();
    this.speakToken += 1;
    this.speakingFeedback = false;
    if (this.state === 'playing_prompt') this.setState('idle');
    this.notify();
  }

  /**
   * Safe teardown (screen unmount / leaving the lesson): playback is stopped,
   * an in-flight recording is discarded and any late transcription result is
   * ignored, so nothing is submitted after the learner left.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingStart = false;
    await this.discardRecording();
    await this.stopSpeakingInternal();
    this.speakToken += 1;
    this.speakingFeedback = false;
    this.transcript = null;
    this.state = 'idle';
    this.listeners.clear();
  }

  /* ---------------------------- internals ---------------------------- */

  private isBusy(): boolean {
    return (
      this.pendingStart ||
      this.state === 'recording' ||
      this.state === 'transcribing' ||
      this.state === 'submitting'
    );
  }

  private async ensureMicrophonePermission(recorder: AudioRecorderService): Promise<boolean> {
    try {
      if (await recorder.hasPermissions()) return true;
    } catch {
      // Fall through to the explicit request below.
    }
    try {
      return await recorder.requestPermissions();
    } catch {
      return false;
    }
  }

  private async discardRecording(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;
    if (!recorder.isRecording()) return;
    try {
      await recorder.stopRecording();
    } catch {
      // Discarding: a stop failure is harmless and stays unreported.
    }
  }

  private async stopSpeakingInternal(): Promise<void> {
    const tts = this.tts;
    if (!tts) return;
    try {
      await tts.stop();
    } catch {
      // Stop failures are harmless; the state machine still forbids overlap.
    }
  }

  /**
   * Route ONE answer to the EXISTING submission method of the owning system.
   * This is the only place a lesson answer leaves the voice layer.
   */
  private async routeSubmission(
    target: AdaptiveVoiceTarget,
    answer: string,
  ): Promise<AdaptiveLessonSubmitOutcome | null> {
    switch (target.kind) {
      case 'review':
        // EXISTING ReviewService path (evaluation, weakness lifecycle, schedule).
        return this.service.submitReviewAnswer(target.itemId, answer, target.stepId);
      case 'listening':
        // EXISTING ListeningService path, with the real replay count preserved.
        return this.service.submitListeningAnswer(
          target.itemId,
          answer,
          target.stepId,
          this.replayCount,
        );
      case 'speaking':
        // EXISTING conversation / AIProvider stack.
        return this.service.submitSpeakingAnswer(answer, target.stepId);
      case 'pronunciation':
        // EXISTING PronunciationEngine path (qualitative only).
        return this.service.submitPronunciationAttempt(answer, target.stepId);
    }
  }

  private async submitTranscript(
    rawAnswer: string,
  ): Promise<AdaptiveVoiceAnswerResult | AdaptiveVoiceFailure> {
    const target = this.target;
    if (!target) return this.fail('no-target', NO_VOICE_TARGET_MESSAGE);
    const answer = rawAnswer.trim();
    if (!answer) return this.fail('empty-answer', EMPTY_ANSWER_MESSAGE);
    // Never submit while the microphone is open, while it is being opened or
    // while another submission is already in flight. (Being in `transcribing`
    // is exactly the state that leads here, so it is not a conflict.)
    if (this.pendingStart || this.state === 'recording' || this.state === 'submitting') {
      return this.fail('busy', BUSY_MESSAGE);
    }

    const key = `${voiceTargetKey(target)}::${answer.toLowerCase()}`;
    const cached = this.outcomes.get(key);
    if (cached) {
      // Double tap / retry of an answer that was already sent: the owning
      // engine is NOT asked again and nothing is counted twice.
      this.transcript = answer;
      this.lastOutcome = cached;
      this.setState('feedback');
      return { ok: true, outcome: cached, transcript: answer, duplicate: true };
    }

    this.setState('submitting');
    let outcome: AdaptiveLessonSubmitOutcome | null;
    try {
      outcome = await this.routeSubmission(target, answer);
    } catch {
      return this.fail('submission-failed', SUBMISSION_FAILED_MESSAGE);
    }
    if (this.disposed) return this.fail('disposed', DISPOSED_MESSAGE);
    if (!outcome) {
      // The service refused (no open session / unknown step): nothing counted.
      return this.fail('submission-unavailable', SUBMISSION_UNAVAILABLE_MESSAGE);
    }

    this.transcript = answer;
    if (outcome.result.kind === 'none') {
      // The owning system refused the answer (e.g. the item is no longer part
      // of this step): nothing was evaluated or counted, so it is not cached
      // and the learner can try again.
      this.setState('idle');
      return { ok: true, outcome, transcript: answer, duplicate: false };
    }
    this.outcomes.set(key, outcome);
    this.lastOutcome = outcome;
    this.setState('feedback');
    return { ok: true, outcome, transcript: answer, duplicate: false };
  }

  private setState(state: AdaptiveVoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.notify();
  }

  /**
   * Record one honest failure. Nothing was submitted, counted or completed.
   * `busy`/`no-target`/`speech-failed` keep the current state so a refused
   * duplicate tap or a failed playback never destroys the visible step.
   */
  private fail(reason: AdaptiveVoiceFailureReason, message: string): AdaptiveVoiceFailure {
    const preservesState =
      reason === 'busy' || reason === 'no-target' || reason === 'speech-failed';
    if (!preservesState) {
      this.errorMessage = message;
      if (!this.disposed) {
        this.state = 'error';
      }
    } else if (reason === 'speech-failed') {
      this.errorMessage = message;
    }
    this.notify();
    return { ok: false, reason, message };
  }

  private notify(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // Listener errors must never break the lesson.
      }
    }
  }
}

export function createAdaptiveLessonVoiceController(
  deps: AdaptiveLessonVoiceControllerDeps,
): AdaptiveLessonVoiceController {
  return new AdaptiveLessonVoiceController(deps);
}

/* ------------------------------------------------------------------ *
 * Provider resolution — EXISTING factories only, no demo fallback
 * ------------------------------------------------------------------ */

export interface AdaptiveVoiceInputProviderLoaders {
  /** Returns the real configured key, or null when none is configured. */
  readonly getApiKey: () => string | null;
  readonly createRecorder: () => AudioRecorderService;
  readonly createStt: (apiKey: string) => SpeechToTextProvider;
}

export interface AdaptiveVoiceInputProviders {
  readonly recorder: AudioRecorderService;
  readonly stt: SpeechToTextProvider;
}

/**
 * Build voice-input providers from the EXISTING talk-demo factories.
 *
 * Returns null when no real speech provider is configured. There is
 * deliberately NO demo fallback: a demo STT would manufacture a transcript the
 * learner never said. The caller then simply keeps text as the fallback.
 */
export function resolveAdaptiveVoiceInputProviders(
  loaders: AdaptiveVoiceInputProviderLoaders,
): AdaptiveVoiceInputProviders | null {
  let apiKey: string | null = null;
  try {
    apiKey = loaders.getApiKey();
  } catch {
    apiKey = null;
  }
  const key = apiKey?.trim();
  if (!key) return null;

  try {
    return { recorder: loaders.createRecorder(), stt: loaders.createStt(key) };
  } catch {
    return null;
  }
}

/**
 * Lazily create the EXISTING TTS provider. Returns null (and therefore no
 * playback affordance) when it cannot be created — never a substitute voice.
 */
export function resolveAdaptiveSpeechOutputProvider(
  createProvider: () => TextToSpeechProvider,
): TextToSpeechProvider | null {
  try {
    return createProvider();
  } catch {
    return null;
  }
}
