/**
 * src/voice/coordinator.ts
 *
 * Coordinates Voice Conversation MVP lifecycle:
 * Audio Recording -> Speech-to-Text -> ConversationSession (streaming) -> Text-to-Speech.
 * Enforces interruption rules, single-turn guarantees, and conversation history integrity.
 *
 * SESSION INTEGRITY (Tutor-Led Conversational Flow)
 * - Every voice operation is bound to the ConversationSession that was active when
 *   it started. If the session is replaced (new chat / mode change) or the
 *   coordinator is disposed while the operation is in flight, the late STT/AI
 *   result is DISCARDED: nothing is submitted to the replacement session, nothing
 *   is spoken, and no history is written. Disposal abandons the active session
 *   BEFORE it awaits teardown, so a late result can never commit into it. A
 *   generation counter invalidates every late state write so the replacement
 *   session can never be mutated by old work.
 * - One learner utterance produces at most ONE submitted conversational turn:
 *   the transcribing state is entered before the recorder is stopped, and a
 *   re-entrant call is refused.
 * - `stopRecordingAndTranscribe()` reuses the SAME recorder/STT lifecycle but
 *   stops after transcription: it never submits a turn, never generates a tutor
 *   reply and never plays conversational TTS, so evidence-only tasks (such as
 *   repeating a known sentence for the pronunciation engine) cannot pollute a
 *   conversation.
 * - Interruption is ordered: any TTS playback is stopped and awaited BEFORE the
 *   microphone opens, so TTS and recording never run concurrently.
 */

import {
  countCommittedLearnerTurns,
  type ConversationSession,
  type ConversationSessionResult,
  type ConversationTurn,
} from '../conversation-session';
import type { SpeechToTextProvider, STTResult } from '../providers/stt';
import type { TextToSpeechProvider } from '../providers/tts';
import { classifyProviderFailure, type ProviderFailure } from '../providers/failures';
import { runWithSafeRetry } from '../shared/safe-retry';
import type {
  AudioRecorderService,
  AudioRecordingResult,
  VoiceState,
  VoiceStatus,
  VoiceStatusListener,
} from './types';

/**
 * Honest message used when a voice operation's result arrives after the session
 * it belonged to was replaced. Nothing was submitted for the new session.
 */
export const VOICE_SESSION_CHANGED_MESSAGE =
  'The conversation changed before this turn finished, so the turn was discarded. Nothing was added to the new conversation.';

/** Message used when a voice operation finishes after the coordinator was disposed. */
export const VOICE_DISPOSED_MESSAGE = 'This conversation was closed.';

/** Message used when voice work is requested while the session is switching. */
export const VOICE_SWITCHING_MESSAGE = 'The conversation is changing. Please try again.';

/** Used when a retry is asked for but nothing recoverable survived. */
/** A stop/retry arrived while nothing was recording: honest and learner-safe. */
export const VOICE_NOTHING_TO_STOP_MESSAGE =
  'Nothing is recording right now, so there was nothing to stop.';

export const VOICE_NOTHING_TO_RETRY_MESSAGE =
  'There is nothing to send again yet. Record your answer first.';

/**
 * The outcome of ONE spoken learner turn (or of a recovery retry).
 *
 * `error` is ALWAYS learner-safe: it comes from the ONE provider-failure
 * classification path (src/providers/failures.ts), never from a raw provider
 * payload. The raw detail is available in `technical` for logs/diagnostics only
 * and must never be rendered.
 */
export interface VoiceTurnOutcome {
  readonly ok: boolean;
  readonly transcript?: string;
  readonly error?: string;
  /** Technical/log detail. NEVER show this to the learner. */
  readonly technical?: string;
  /** The classified failure, so callers can decide recovery (Retry / Type). */
  readonly failure?: ProviderFailure;
}

/**
 * Learner-facing lifecycle of one conversational voice turn. Derived from — and
 * never duplicating — the coordinator's VoiceStatus: it only names the phase
 * the learner needs to understand and what the obvious next action is.
 */
export type VoiceTurnPhase =
  | 'ready'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface VoiceTurnView {
  readonly phase: VoiceTurnPhase;
  /** Short status text for the Talk screen (e.g. "Listening…"). */
  readonly label: string;
  /** What the learner can do right now. */
  readonly hint: string;
  /** True when the microphone is the obvious primary action. */
  readonly micIsPrimary: boolean;
}

/**
 * Maps the existing VoiceStatus onto the learner-facing turn phase.
 * `isTutorThinking` lets the caller report a text/opening turn that is still
 * waiting on the AI, which reuses the same "thinking" phase instead of adding a
 * second state machine.
 */
export function describeVoiceTurn(status: VoiceStatus, isTutorThinking = false): VoiceTurnView {
  switch (status.state) {
    case 'requesting_permission':
      return {
        phase: 'ready',
        label: 'Preparing microphone…',
        hint: 'Waiting for microphone access.',
        micIsPrimary: false,
      };
    case 'recording':
      return {
        phase: 'recording',
        label: 'Listening…',
        hint: 'Tap the microphone when you have finished speaking.',
        micIsPrimary: true,
      };
    case 'transcribing':
      return {
        phase: 'transcribing',
        label: 'Transcribing…',
        hint: 'Turning your speech into text.',
        micIsPrimary: false,
      };
    case 'sending':
      return {
        phase: 'thinking',
        label: 'Thinking…',
        hint: 'The tutor is composing a reply.',
        micIsPrimary: false,
      };
    case 'speaking':
      return {
        phase: 'speaking',
        label: 'Tutor speaking…',
        hint: 'Tap the microphone to interrupt and reply.',
        micIsPrimary: true,
      };
    case 'error':
      return {
        phase: 'error',
        label: status.errorMessage ?? 'Something went wrong.',
        hint: 'Tap the microphone to try again.',
        micIsPrimary: true,
      };
    case 'idle':
    default:
      // Idle while an async turn is still running (or a typed/opening turn is
      // waiting on the AI) is honestly reported as "thinking".
      if (status.isProcessing || isTutorThinking) {
        return {
          phase: 'thinking',
          label: 'Thinking…',
          hint: 'The tutor is composing a reply.',
          micIsPrimary: false,
        };
      }
      return {
        phase: 'ready',
        label: 'Your turn',
        hint: 'Tap to speak, or type your reply.',
        micIsPrimary: true,
      };
  }
}

export interface VoiceSessionCoordinatorConfig {
  readonly recorder: AudioRecorderService;
  readonly sttProvider: SpeechToTextProvider;
  readonly ttsProvider: TextToSpeechProvider;
  readonly session: ConversationSession;
  readonly isMuted?: boolean;
}

export class VoiceSessionCoordinator {
  private readonly recorder: AudioRecorderService;
  private readonly sttProvider: SpeechToTextProvider;
  private readonly ttsProvider: TextToSpeechProvider;
  private session: ConversationSession;

  private state: VoiceState = 'idle';
  private elapsedSeconds: number = 0;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private recognizedTranscript: string | null = null;
  private errorMessage: string | null = null;
  private isMuted: boolean = false;
  private listeners: Set<VoiceStatusListener> = new Set();
  /** An async voice operation (STT / AI response / TTS) is in flight. */
  private processing: boolean = false;
  /**
   * Bumped whenever the active session is replaced or the coordinator is reset
   * or disposed. In-flight operations compare the value they captured at the
   * start; a mismatch means their work is stale and must not be applied.
   */
  private generation: number = 0;
  private disposed: boolean = false;
  /** Settlement of the (single) disposal, so repeated dispose() calls are safe. */
  private disposalPromise: Promise<void> | null = null;
  /**
   * True while `switchSession()` is replacing the active conversation. New voice
   * work is refused during the switch so it can never be captured against a
   * session that is on its way out.
   */
  private switching: boolean = false;
  private appStateSub: { remove: () => void } | null = null;
  private lastAppState: string = 'active';
  private lastAudioUri: string | null = null;
  /**
   * The learner's OWN transcript of a spoken turn that has NOT been committed
   * because the tutor reply failed. Preserved so an explicit Retry sends the
   * SAME turn (no re-recording) and so it can never be committed twice.
   */
  private pendingTurn: {
    readonly transcript: string;
    readonly session: ConversationSession;
    readonly generation: number;
  } | null = null;
  /**
   * A recording that survived a FAILED transcription. Preserved so the learner
   * can transcribe it again instead of speaking a second time. `transcribeOnly`
   * keeps the retry on the SAME contract as the original capture, so an
   * evidence-only repeat can never become a conversation turn.
   */
  private recoverableRecording: {
    readonly audio: AudioRecordingResult;
    readonly session: ConversationSession;
    readonly generation: number;
    readonly transcribeOnly: boolean;
  } | null = null;

  constructor(config: VoiceSessionCoordinatorConfig) {
    this.recorder = config.recorder;
    this.sttProvider = config.sttProvider;
    this.ttsProvider = config.ttsProvider;
    this.session = config.session;
    this.isMuted = config.isMuted ?? false;
    this.setupAppStateGuard();
  }

  private async cleanupAudio(uri: string | null): Promise<void> {
    if (!uri) return;
    try {
      const { cleanupAudioFile } = await import('./audio-cleanup');
      await cleanupAudioFile(uri);
    } catch {
      // Cleanup failures never become evidence or crash
    }
  }

  private setupAppStateGuard(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AppState } = require('react-native');
      if (AppState && typeof AppState.addEventListener === 'function') {
        this.lastAppState = AppState.currentState ?? 'active';
        const sub = AppState.addEventListener('change', (next: string) => {
          const prev = this.lastAppState;
          this.lastAppState = next;
          const goingBackground =
            (prev === 'active' && (next === 'background' || next === 'inactive')) ||
            (prev === 'inactive' && next === 'background');
          if (goingBackground) {
            this.handleBackground();
          } else if ((prev === 'background' || prev === 'inactive') && next === 'active') {
            this.handleForeground();
          }
        });
        this.appStateSub = sub;
      }
    } catch {
      // No AppState in test environment – ignore
    }
  }

  /**
   * Updates the active ConversationSession (e.g. on new chat or mode switch).
   */
  /**
   * Synchronously installs a session without awaiting recorder/TTS cleanup.
   * Kept for same-session/idempotent callers and tests; conversation changes in
   * the app must use the atomic `switchSession()` instead, which stops the old
   * work BEFORE the new session becomes active.
   */
  setSession(newSession: ConversationSession): void {
    if (this.session === newSession) {
      // Same session (e.g. second mic press): active recording must survive.
      return;
    }
    // Identify the session being replaced: it is closed BEFORE anything else, so
    // late async work it holds can never commit into it (same guarantee as the
    // atomic switchSession()).
    const oldSession = this.session;
    // Invalidate every in-flight operation: its result belongs to the previous
    // session and must never be submitted, spoken or written anywhere.
    this.generation += 1;
    oldSession.abandon?.();
    // Playback is stopped without state writes: a cleanup continuation from the
    // previous session must never overwrite the new session's lifecycle.
    void this.stopPlayback();
    if (this.state === 'recording') {
      this.cancelRecording();
    }
    // Preserved work belonged to the replaced session: it is never carried over.
    this.invalidateRecoverableWork();
    this.session = newSession;
    this.recognizedTranscript = null;
    this.errorMessage = null;
    this.state = 'idle';
    this.notifyListeners();
  }

  /**
   * Atomically replaces the active conversation session.
   *
   * Ordering is what makes this safe (see BLOCKER-class races: an old, still
   * awaiting `reset()` could overwrite the NEW session's lifecycle, and an old
   * ConversationSession could still COMMIT a turn during cleanup):
   *   1. capture the OLD session and invalidate every in-flight operation
   *      (generation++),
   *   2. close the OLD session IMMEDIATELY — before any awaiting cleanup — so a
   *      late AI/STT result that resolves during teardown can never commit a
   *      turn, feedback or vocabulary persistence into the replaced session,
   *   3. stop the old recorder and playback and AWAIT that cleanup,
   *   4. only then install and activate the new session, and only if this switch
   *      is still current,
   *   5. every state write is generation/switch guarded, so a superseded or
   *      disposed cleanup can never write into the new lifecycle.
   * New voice work is refused while the switch is running. The INCOMING session
   * is never abandoned.
   */
  async switchSession(newSession: ConversationSession): Promise<ConversationSession | null> {
    if (this.disposed) return null;
    if (this.session === newSession) return newSession;

    // 1. Identify the session being replaced and invalidate all in-flight work.
    const oldSession = this.session;
    this.generation += 1;
    const generation = this.generation;
    this.switching = true;
    // Recovery state of the OUTGOING conversation is invalidated synchronously:
    // a preserved transcript/recording can never be replayed into the new one.
    this.invalidateRecoverableWork();
    this.notifyListeners();

    // 2. The replaced session becomes non-writable at the exact start of the
    // replacement — never after the awaited cleanup, which is a race window in
    // which an old AI request could still commit history/feedback/persistence.
    oldSession.abandon?.();

    // 3. Stop and await old recorder/playback cleanup. No lifecycle state is
    // written here: the guarded writes happen in step 4 (or in a newer switch).
    await this.teardown();

    // 4. A newer switch/reset/dispose superseded this one: install nothing and
    // report it, so the caller never assumes an activation that did not happen.
    if (this.disposed || this.generation !== generation) {
      return null;
    }

    // 5. Activate the new session with a clean lifecycle for it.
    this.session = newSession;
    this.switching = false;
    this.processing = false;
    this.elapsedSeconds = 0;
    this.recognizedTranscript = null;
    this.errorMessage = null;
    this.state = 'idle';
    this.notifyListeners();
    return newSession;
  }

  /**
   * Is the work captured earlier still valid for the ACTIVE session?
   * False when the session was replaced, the coordinator was reset, or it was
   * disposed while the operation was in flight.
   */
  private isCurrent(session: ConversationSession, generation: number): boolean {
    return !this.disposed && this.generation === generation && this.session === session;
  }

  /** State write that only applies while the work is still current. */
  private setStateIfCurrent(
    session: ConversationSession,
    generation: number,
    state: VoiceState,
    errorMessage: string | null = null,
  ): boolean {
    if (!this.isCurrent(session, generation)) return false;
    this.state = state;
    this.errorMessage = errorMessage;
    this.notifyListeners();
    return true;
  }

  /**
   * Subscribes a listener to voice status updates.
   */
  subscribe(listener: VoiceStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  getStatus(): VoiceStatus {
    const isSpeaking = this.state === 'speaking';
    const canRecord =
      (this.state === 'idle' || this.state === 'speaking' || this.state === 'error') &&
      !this.processing &&
      !this.switching &&
      !this.disposed;
    const canStopRecording = this.state === 'recording';
    const canSendText =
      !this.disposed &&
      !this.switching &&
      this.state !== 'recording' &&
      this.state !== 'transcribing';

    // Recovery affordances: an explicit learner Retry is possible while nothing
    // is in flight and the preserved work still belongs to the ACTIVE session.
    const canRetry = !this.disposed && !this.switching && !this.processing;
    const pendingTranscript = canRetry ? this.getPendingTranscript() : null;
    const hasRecoverableRecording = canRetry && this.hasRecoverableRecording();

    return {
      state: this.state,
      elapsedSeconds: this.elapsedSeconds,
      recognizedTranscript: this.recognizedTranscript,
      errorMessage: this.errorMessage,
      isMuted: this.isMuted,
      isSpeaking,
      canRecord,
      canStopRecording,
      canSendText,
      isProcessing: this.processing,
      isSwitching: this.switching,
      pendingTranscript,
      canRetryPendingTurn: pendingTranscript !== null,
      canRetryTranscription: hasRecoverableRecording,
    };
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted && this.state === 'speaking') {
      this.stopSpeaking();
    } else {
      this.notifyListeners();
    }
  }

  toggleMute(): void {
    this.setMuted(!this.isMuted);
  }

  /**
   * Starts push-to-talk audio recording.
   */
  async startRecording(): Promise<boolean> {
    if (this.disposed) return false;
    // Never start new voice work while the conversation session is switching.
    if (this.switching) return false;
    // Prevent starting if already recording, transcribing, or sending — and
    // never open the microphone while another voice operation is in flight.
    if (
      this.processing ||
      this.state === 'recording' ||
      this.state === 'transcribing' ||
      this.state === 'sending' ||
      this.state === 'requesting_permission'
    ) {
      return false;
    }

    // A NEW utterance supersedes any preserved recovery state: the learner chose
    // to speak again, so the previous transcript/recording is dropped (with its
    // temp file) and can never be sent a second time.
    this.invalidateRecoverableWork();

    // Interruption ordering (barge-in): any tutor playback is stopped and
    // AWAITED first, so TTS and the microphone are never active at the same
    // time. `stopSpeaking()` only changes state when playback was active.
    await this.stopSpeaking();

    const session = this.session;
    const generation = this.generation;

    this.errorMessage = null;
    this.recognizedTranscript = null;
    this.state = 'requesting_permission';
    this.notifyListeners();

    try {
      const hasPermission = await this.recorder.hasPermissions();
      if (!hasPermission) {
        const granted = await this.recorder.requestPermissions();
        if (!granted) {
          this.setStateIfCurrent(
            session,
            generation,
            'error',
            'Microphone permission is required for voice conversation.',
          );
          return false;
        }
      }

      await this.recorder.startRecording();
      if (!this.isCurrent(session, generation)) {
        // The session changed (or the screen went away) while we were opening the
        // microphone: discard the recording instead of capturing into nowhere.
        try {
          await this.recorder.stopRecording();
        } catch {
          // Discarding: a stop failure is harmless.
        }
        return false;
      }
      this.state = 'recording';
      this.elapsedSeconds = 0;

      if (this.timerHandle) {
        clearInterval(this.timerHandle);
      }
      this.timerHandle = setInterval(() => {
        this.elapsedSeconds = this.recorder.getElapsedSeconds();
        this.notifyListeners();
      }, 500);

      this.notifyListeners();
      return true;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to start microphone recording.';
      this.setStateIfCurrent(session, generation, 'error', message);
      return false;
    }
  }

  /**
   * Cancels active recording without processing speech.
   */
  cancelRecording(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.recorder.isRecording()) {
      this.recorder.stopRecording().catch(() => {});
    }
    if (!this.processing) {
      this.state = 'idle';
    }
    this.elapsedSeconds = 0;
    this.notifyListeners();
  }

  /**
   * Stops recording, transcribes the audio with the EXISTING STT provider and
   * submits the transcript to the ConversationSession this utterance belongs to.
   *
   * RECOVERY CONTRACT (one utterance, at most one committed turn)
   * - Re-entrancy is refused BEFORE any await, so a double tap can never submit
   *   the same utterance twice.
   * - A TRANSIENT transcription failure (service busy / timeout / interrupted
   *   connection) gets ONE short automatic retry on the SAME audio. STT commits
   *   nothing, so replaying it can never duplicate a learner turn.
   * - When transcription fails, the RECORDING is preserved: the learner retries
   *   the transcription (`retryTranscription()`) instead of speaking again.
   * - When transcription SUCCEEDS but the tutor reply fails, the TRANSCRIPT is
   *   preserved (`getStatus().pendingTranscript`): the learner sends the SAME
   *   turn again (`retryPendingTurn()`) or edits it as text
   *   (`takePendingTranscript()`). Nothing is committed by a failed turn and no
   *   evidence is created from it.
   * - The tutor turn is replayed automatically ONLY while nothing was committed
   *   and no reply content was streamed; otherwise recovery is an explicit
   *   learner Retry, which re-verifies the commit state first.
   * - Every learner-facing message goes through the ONE provider-failure path:
   *   raw provider payloads stay in `technical` (logs only).
   */
  async stopRecordingAndProcess(
    onStreamChunk?: (chunk: string) => void
  ): Promise<VoiceTurnOutcome> {
    if (this.disposed) return { ok: false, error: VOICE_DISPOSED_MESSAGE };
    if (this.switching) return { ok: false, error: VOICE_SWITCHING_MESSAGE };
    // One learner utterance = at most one submitted turn: this guard (plus the
    // immediate state change below) makes a re-entrant call impossible.
    if (this.processing || this.state !== 'recording') {
      return { ok: false, error: VOICE_NOTHING_TO_STOP_MESSAGE };
    }

    // Bind the whole operation to the session that is active right now.
    const session = this.session;
    const generation = this.generation;
    this.processing = true;

    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }

    // Move out of `recording` BEFORE the await: any concurrent call is refused
    // from here on, so the utterance cannot be submitted twice.
    this.state = 'transcribing';
    this.notifyListeners();

    let audio: AudioRecordingResult;
    try {
      audio = await this.recorder.stopRecording();
      this.lastAudioUri = audio?.uri ?? null;
    } catch (err: unknown) {
      this.processing = false;
      this.dropRecoverableRecording();
      const failure = classifyProviderFailure(
        err instanceof Error ? err.message : 'Failed to stop audio recording.',
        'speech',
      );
      this.setStateIfCurrent(session, generation, 'error', failure.message);
      return {
        ok: false,
        error: failure.message,
        ...(failure.technical ? { technical: failure.technical } : {}),
        failure,
      };
    }

    if (!this.isCurrent(session, generation)) {
      // The session was replaced while the audio was being captured: the audio
      // belongs to the previous conversation, so it is not transcribed.
      this.dropRecoverableRecording();
      this.processing = false;
      return { ok: false, error: VOICE_SESSION_CHANGED_MESSAGE };
    }

    return this.runSpokenTurn({
      audio,
      session,
      generation,
      transcribeOnly: false,
      ...(onStreamChunk ? { onStreamChunk } : {}),
    });
  }

  /**
   * TRANSCRIPTION-ONLY stop: the same recorder + STT lifecycle as
   * `stopRecordingAndProcess()`, but it deliberately STOPS after a successful
   * transcription.
   *
   * It never calls `session.send()`, never generates a tutor reply, never plays
   * conversational TTS and therefore never commits a conversation turn, feedback
   * or vocabulary. It exists for tasks that need the learner's real speech as
   * evidence only (e.g. repeating a known sentence so the EXISTING pronunciation
   * engine can compare it with the expected text).
   *
   * Lifecycle integrity is identical to the conversational path: one utterance
   * is transcribed at most once, a duplicate stop is refused, and a replaced or
   * disposed session invalidates the late STT result. A failed transcription
   * preserves the recording, and `retryTranscription()` repeats the SAME
   * transcription-only contract (it can never turn into a conversation turn).
   */
  async stopRecordingAndTranscribe(): Promise<VoiceTurnOutcome> {
    if (this.disposed) return { ok: false, error: VOICE_DISPOSED_MESSAGE };
    if (this.switching) return { ok: false, error: VOICE_SWITCHING_MESSAGE };
    // One utterance = at most one transcription: this guard (plus the immediate
    // state change below) makes a re-entrant/duplicate stop impossible.
    if (this.processing || this.state !== 'recording') {
      return { ok: false, error: VOICE_NOTHING_TO_STOP_MESSAGE };
    }

    // Bind the operation to the session that is active right now.
    const session = this.session;
    const generation = this.generation;
    this.processing = true;

    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }

    // Move out of `recording` BEFORE the await so a concurrent stop is refused.
    this.state = 'transcribing';
    this.notifyListeners();

    let audio: AudioRecordingResult;
    try {
      audio = await this.recorder.stopRecording();
      this.lastAudioUri = audio?.uri ?? null;
    } catch (err: unknown) {
      this.processing = false;
      this.dropRecoverableRecording();
      const failure = classifyProviderFailure(
        err instanceof Error ? err.message : 'Failed to stop audio recording.',
        'speech',
      );
      this.setStateIfCurrent(session, generation, 'error', failure.message);
      return {
        ok: false,
        error: failure.message,
        ...(failure.technical ? { technical: failure.technical } : {}),
        failure,
      };
    }

    if (!this.isCurrent(session, generation)) {
      this.dropRecoverableRecording();
      this.processing = false;
      return { ok: false, error: VOICE_SESSION_CHANGED_MESSAGE };
    }

    return this.runSpokenTurn({ audio, session, generation, transcribeOnly: true });
  }

  /**
   * Retries the transcription of a PRESERVED recording after a failed STT call.
   *
   * The learner does not have to speak again: the same audio is transcribed once
   * more through the SAME provider and the SAME lifecycle guards. A recording
   * captured by the transcription-only path stays transcription-only, so this
   * retry can never commit a conversation turn that the original did not.
   */
  async retryTranscription(onStreamChunk?: (chunk: string) => void): Promise<VoiceTurnOutcome> {
    if (this.disposed) return { ok: false, error: VOICE_DISPOSED_MESSAGE };
    if (this.switching) return { ok: false, error: VOICE_SWITCHING_MESSAGE };
    if (this.processing) {
      return { ok: false, error: 'Your previous answer is still being processed.' };
    }
    const recoverable = this.recoverableRecording;
    if (!recoverable) {
      return { ok: false, error: VOICE_NOTHING_TO_RETRY_MESSAGE };
    }
    if (!this.isCurrent(recoverable.session, recoverable.generation)) {
      // The conversation moved on: the preserved audio belongs to a dead session.
      this.dropRecoverableRecording();
      return { ok: false, error: VOICE_SESSION_CHANGED_MESSAGE };
    }

    this.processing = true;
    this.errorMessage = null;
    this.state = 'transcribing';
    this.notifyListeners();

    return this.runSpokenTurn({
      audio: recoverable.audio,
      session: recoverable.session,
      generation: recoverable.generation,
      transcribeOnly: recoverable.transcribeOnly,
      ...(onStreamChunk ? { onStreamChunk } : {}),
    });
  }

  /**
   * Sends the PRESERVED transcript again after the tutor reply failed.
   *
   * Explicit learner Retry only — never automatic. It cannot duplicate a learner
   * turn: when the transcript is already in the committed history (the previous
   * attempt really did commit), the turn is reported as committed and nothing is
   * sent again.
   */
  async retryPendingTurn(onStreamChunk?: (chunk: string) => void): Promise<VoiceTurnOutcome> {
    if (this.disposed) return { ok: false, error: VOICE_DISPOSED_MESSAGE };
    if (this.switching) return { ok: false, error: VOICE_SWITCHING_MESSAGE };
    if (this.processing) {
      return { ok: false, error: 'Your previous answer is still being processed.' };
    }
    const pending = this.pendingTurn;
    if (!pending) {
      return { ok: false, error: VOICE_NOTHING_TO_RETRY_MESSAGE };
    }
    if (!this.isCurrent(pending.session, pending.generation)) {
      this.pendingTurn = null;
      return { ok: false, error: VOICE_SESSION_CHANGED_MESSAGE };
    }

    // Commit-state verification: a turn that really committed is never replayed.
    const alreadyCommitted = pending.session
      .getHistory()
      .some((turn) => turn.role === 'user' && turn.content === pending.transcript);
    if (alreadyCommitted) {
      this.pendingTurn = null;
      this.processing = false;
      this.errorMessage = null;
      this.state = 'idle';
      this.notifyListeners();
      return { ok: true, transcript: pending.transcript };
    }

    this.processing = true;
    this.errorMessage = null;
    this.state = 'sending';
    this.notifyListeners();

    return this.submitTranscript({
      transcript: pending.transcript,
      session: pending.session,
      generation: pending.generation,
      ...(onStreamChunk ? { onStreamChunk } : {}),
    });
  }

  /** The preserved transcript of an uncommitted spoken turn (or null). */
  getPendingTranscript(): string | null {
    const pending = this.pendingTurn;
    if (!pending) return null;
    if (!this.isCurrent(pending.session, pending.generation)) {
      this.pendingTurn = null;
      return null;
    }
    return pending.transcript;
  }

  /**
   * Hands the preserved transcript to the learner as editable TEXT ("Type
   * instead") and clears the pending voice turn, so the same utterance can never
   * be sent twice (once as text, once as a voice retry).
   */
  takePendingTranscript(): string | null {
    const transcript = this.getPendingTranscript();
    this.pendingTurn = null;
    if (this.state === 'error') {
      this.state = 'idle';
      this.notifyListeners();
    }
    return transcript;
  }

  /** Drops a preserved transcript (the learner moved on). */
  clearPendingTurn(): void {
    this.pendingTurn = null;
    if (this.state === 'error' && !this.processing) {
      this.state = 'idle';
      this.notifyListeners();
    }
  }

  /** True when a recording survived a failed transcription and can be retried. */
  hasRecoverableRecording(): boolean {
    const recoverable = this.recoverableRecording;
    if (!recoverable) return false;
    if (!this.isCurrent(recoverable.session, recoverable.generation)) {
      this.dropRecoverableRecording();
      return false;
    }
    return true;
  }

  /**
   * STT (+ optional turn submission) for ONE recorded utterance. Shared by the
   * first attempt and by `retryTranscription()`, so there is exactly ONE voice
   * pipeline and one set of lifecycle guards.
   */
  private async runSpokenTurn(input: {
    readonly audio: AudioRecordingResult;
    readonly session: ConversationSession;
    readonly generation: number;
    readonly transcribeOnly: boolean;
    readonly onStreamChunk?: (chunk: string) => void;
  }): Promise<VoiceTurnOutcome> {
    const { audio, session, generation } = input;

    // 1. Speech to text. STT commits nothing, so ONE short automatic retry of a
    //    transient failure is safe and cannot duplicate a learner turn.
    const stt = await runWithSafeRetry<STTResult>({
      surface: 'speech',
      committed: () => false,
      run: async () => {
        if (!this.isCurrent(session, generation)) {
          return { ok: false, error: VOICE_SESSION_CHANGED_MESSAGE };
        }
        try {
          return await this.sttProvider.transcribe(audio);
        } catch (err: unknown) {
          return {
            ok: false,
            error:
              err instanceof Error
                ? err.message
                : 'Could not recognize speech. Please try speaking again.',
          };
        }
      },
      failureOf: (result) => (result.ok ? null : { message: result.error ?? null }),
    });

    if (!this.isCurrent(session, generation)) {
      // A late STT result must never be attached to the replacement session.
      this.dropRecoverableRecording();
      this.processing = false;
      return { ok: false, error: VOICE_SESSION_CHANGED_MESSAGE };
    }

    const transcript = stt.result.ok ? (stt.result.transcript ?? '').trim() : '';

    if (!stt.result.ok || transcript.length === 0) {
      // FAILED / EMPTY TRANSCRIPTION: nothing was submitted anywhere, so no turn,
      // no feedback and no evidence exist. The recording is PRESERVED so the
      // learner can retry the transcription instead of speaking again.
      this.recoverableRecording = {
        audio,
        session,
        generation,
        transcribeOnly: input.transcribeOnly,
      };
      this.lastAudioUri = audio?.uri ?? null;
      this.processing = false;
      const failure =
        stt.failure ??
        classifyProviderFailure(
          'Could not recognize speech. Please try speaking again.',
          'speech',
        );
      this.setStateIfCurrent(session, generation, 'error', failure.message);
      return {
        ok: false,
        error: failure.message,
        ...(failure.technical ? { technical: failure.technical } : {}),
        failure,
      };
    }

    // STT succeeded: no consumer needs the temp file any more (pronunciation
    // works on the transcript text, not on the audio).
    this.dropRecoverableRecording();

    if (input.transcribeOnly) {
      // STOP HERE (the whole point of this operation): return the real transcript
      // to the caller. Nothing is submitted to the ConversationSession, nothing
      // is spoken, and the coordinator returns to a calm idle state.
      this.recognizedTranscript = transcript;
      this.processing = false;
      if (this.isCurrent(session, generation)) {
        this.state = 'idle';
        this.notifyListeners();
      }
      return { ok: true, transcript };
    }

    this.recognizedTranscript = transcript;
    this.state = 'sending';
    this.notifyListeners();

    // 2. Submit the transcript to the session this utterance belongs to. From
    //    here the transcript is PRESERVED until the turn really commits.
    this.pendingTurn = { transcript, session, generation };
    return this.submitTranscript({
      transcript,
      session,
      generation,
      ...(input.onStreamChunk ? { onStreamChunk: input.onStreamChunk } : {}),
    });
  }

  /**
   * Submits ONE transcript to the session it belongs to. Shared by the first
   * attempt and by an explicit learner retry of a preserved transcript, so the
   * commit guards exist exactly once.
   */
  private async submitTranscript(input: {
    readonly transcript: string;
    readonly session: ConversationSession;
    readonly generation: number;
    readonly onStreamChunk?: (chunk: string) => void;
  }): Promise<VoiceTurnOutcome> {
    const { transcript, session, generation } = input;
    const baselineLearnerTurns = countCommittedLearnerTurns(session);
    let streamed = false;
    const onChunk = input.onStreamChunk
      ? (chunk: string) => {
          streamed = true;
          input.onStreamChunk?.(chunk);
        }
      : undefined;

    const sent = await runWithSafeRetry<ConversationSessionResult>({
      surface: 'tutor',
      run: async (): Promise<ConversationSessionResult> => {
        if (!this.isCurrent(session, generation)) {
          return {
            ok: false,
            error: {
              code: 'cancelled',
              message: VOICE_SESSION_CHANGED_MESSAGE,
              retryable: false,
            },
            history: session.getHistory(),
          };
        }
        try {
          return onChunk
            ? await session.send({ userMessage: transcript }, onChunk)
            : await session.send({ userMessage: transcript });
        } catch (err: unknown) {
          return {
            ok: false,
            error: {
              code: 'unknown',
              message:
                err instanceof Error ? err.message : 'Error processing tutor response.',
              retryable: true,
            },
            history: session.getHistory(),
          };
        }
      },
      failureOf: (result) =>
        result.ok
          ? null
          : {
              message: result.error?.message ?? null,
              code: result.error?.code ?? null,
              retryable: result.error?.retryable,
            },
      /**
       * Commit-state verification: an automatic replay is refused as soon as a
       * learner turn was committed or reply content was streamed. The state is
       * then uncertain, and only an explicit learner Retry — which re-verifies
       * the committed history — may proceed.
       */
      committed: () => streamed || countCommittedLearnerTurns(session) !== baselineLearnerTurns,
    });

    const result = sent.result;

    if (!this.isCurrent(session, generation)) {
      // The session was replaced while the tutor was answering: never commit and
      // never keep the transcript for the replacement conversation.
      this.pendingTurn = null;
      this.processing = false;
      return { ok: false, transcript, error: VOICE_SESSION_CHANGED_MESSAGE };
    }

    if (!result.ok) {
      this.processing = false;
      const failure =
        sent.failure ?? classifyProviderFailure(result.error?.message ?? null, 'tutor');
      // The transcript SURVIVES a failed tutor reply: the learner retries the
      // SAME turn (or edits it as text) instead of recording again. Nothing was
      // committed, so no evidence exists for this attempt.
      this.pendingTurn = { transcript, session, generation };
      this.errorMessage = failure.message;
      this.state = 'error';
      this.notifyListeners();
      return {
        ok: false,
        transcript,
        error: failure.message,
        ...(failure.technical ? { technical: failure.technical } : {}),
        failure,
      };
    }

    // COMMITTED exactly once: the preserved transcript is no longer pending.
    this.pendingTurn = null;
    // The conversational turn is now complete, so playback no longer counts as
    // in-flight work: the learner can interrupt the tutor and speak (barge-in).
    this.processing = false;

    // 3. Play the learner-facing tutor reply via TTS if not muted.
    if (!this.isMuted) {
      const history = session.getHistory();
      const lastAssistantTurn = this.findLastAssistantTurn(history);
      if (lastAssistantTurn && lastAssistantTurn.content.trim().length > 0) {
        try {
          await this.speakResponse(lastAssistantTurn.content, session, generation);
        } catch {
          // TTS failure must not roll back conversation or fail the turn.
        }
        return { ok: true, transcript };
      }
    }

    if (this.isCurrent(session, generation)) {
      this.state = 'idle';
      this.notifyListeners();
    }
    return { ok: true, transcript };
  }

  /**
   * Invalidates EVERY preserved recovery state (pending transcript + preserved
   * recording). Preserved work belongs to exactly one session/generation, so it
   * is dropped whenever the conversation changes or the coordinator is reset,
   * backgrounded or disposed: it can never be replayed into another session.
   */
  private invalidateRecoverableWork(): void {
    this.pendingTurn = null;
    this.dropRecoverableRecording();
  }

  /**
   * Drops the preserved recording (and its temp file). Called whenever the
   * recoverable state stops being valid: a new utterance, a successful
   * transcription, a session switch, a reset, backgrounding or disposal.
   */
  private dropRecoverableRecording(): void {
    this.recoverableRecording = null;
    const uri = this.lastAudioUri;
    this.lastAudioUri = null;
    if (uri) void this.cleanupAudio(uri);
  }

  /**
   * Helper to find the latest assistant response in history.
   */
  private findLastAssistantTurn(
    history: readonly ConversationTurn[]
  ): ConversationTurn | null {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        return history[i];
      }
    }
    return null;
  }

  /**
   * Speaks the assistant response text aloud.
   *
   * Work Order 2 (minimal, additive): an optional `rate` may be supplied to
   * the EXISTING TTS provider for learner "slower/repeat" playback. It is
   * passed straight through as a provider option — there is no second TTS
   * path — and callers must only offer it when the provider really declares
   * `supportsSpeechRate`. Playback never creates a learner attempt.
   */
  async speakResponse(
    text: string,
    session: ConversationSession = this.session,
    generation: number = this.generation,
    options?: { readonly rate?: number },
  ): Promise<void> {
    // Never play tutor audio while the microphone is active: the recorder and
    // TTS must not run at the same time (barge-in always wins over playback).
    if (
      this.state === 'recording' ||
      this.state === 'transcribing' ||
      this.state === 'requesting_permission'
    ) {
      return;
    }

    if (this.isMuted || !text || text.trim().length === 0) {
      if (this.isCurrent(session, generation)) {
        this.state = 'idle';
        this.notifyListeners();
      }
      return;
    }

    if (!this.setStateIfCurrent(session, generation, 'speaking')) return;

    try {
      await this.ttsProvider.speak(text, {
        ...(options?.rate !== undefined ? { rate: options.rate } : {}),
        onStart: () => {
          if (this.isCurrent(session, generation)) {
            this.state = 'speaking';
            this.notifyListeners();
          }
        },
        onDone: () => {
          if (this.isCurrent(session, generation) && this.state === 'speaking') {
            this.state = 'idle';
            this.notifyListeners();
          }
        },
        onError: () => {
          if (this.isCurrent(session, generation) && this.state === 'speaking') {
            this.state = 'idle';
            this.notifyListeners();
          }
        },
      });
    } catch {
      // TTS failure must NOT roll back the conversation
      if (this.isCurrent(session, generation) && this.state === 'speaking') {
        this.state = 'idle';
        this.notifyListeners();
      }
    }
  }

  /**
   * Work Order 2 (read-only accessor): the SAME TTS provider this coordinator
   * plays on. Surfaces use it ONLY to resolve honest playback capability
   * (e.g. whether the provider really supports a speech-rate change). It is
   * not a second playback path: playback stays owned by this coordinator.
   */
  getPlaybackProvider(): TextToSpeechProvider {
    return this.ttsProvider;
  }

  /**
   * Stops any currently active text-to-speech playback.
   */
  /**
   * Stops playback WITHOUT touching lifecycle state. Used by session switches so
   * old playback cleanup can never write into the new session's state.
   */
  private async stopPlayback(): Promise<void> {
    try {
      await this.ttsProvider.stop();
    } catch {
      // Ignore stop errors
    }
  }

  async stopSpeaking(): Promise<void> {
    const generation = this.generation;
    await this.stopPlayback();
    // A switch/reset/dispose that started during the stop owns the state now.
    if (this.disposed || this.switching || this.generation !== generation) {
      return;
    }
    if (this.state === 'speaking') {
      this.state = 'idle';
      this.notifyListeners();
    }
  }

  /**
   * Replays the last tutor response aloud.
   *
   * Work Order 2: an optional `rate` supports the learner's "Slower" control
   * through this SAME existing playback path (the caller only supplies it when
   * the provider declares speech-rate capability). Replaying — at any speed —
   * never creates a learner attempt or evidence.
   */
  async replayLastResponse(options?: { readonly rate?: number }): Promise<void> {
    if (this.disposed) return;
    // Read from — and rebind to — the session that is active right now: a replay
    // must never re-speak the previous conversation's reply.
    const session = this.session;
    const generation = this.generation;
    const lastAssistantTurn = this.findLastAssistantTurn(session.getHistory());
    if (!lastAssistantTurn || lastAssistantTurn.content.trim().length === 0) {
      return;
    }

    await this.stopSpeaking();
    await this.speakResponse(lastAssistantTurn.content, session, generation, options);
  }

  /**
   * Stops the recorder (if active) and playback, awaiting both. Writes NO
   * lifecycle state, so it is safe inside a switch/reset that may be superseded.
   */
  private async teardown(): Promise<void> {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.recorder.isRecording()) {
      try {
        await this.recorder.stopRecording();
      } catch {
        // Ignore
      }
    }
    await this.stopPlayback();
  }

  /**
   * Full reset (e.g. when New Chat or mode change is pressed).
   */
  async reset(): Promise<void> {
    // Invalidate in-flight operations first: nothing they produce may be
    // applied after a reset (new chat, mode change, unmount).
    this.generation += 1;
    const generation = this.generation;
    await this.teardown();

    // A newer switch/reset/dispose owns the coordinator now: this (older) reset
    // must not overwrite the new session's lifecycle state.
    if (this.disposed || this.generation !== generation) {
      return;
    }

    this.switching = false;
    this.processing = false;
    this.state = 'idle';
    this.elapsedSeconds = 0;
    this.recognizedTranscript = null;
    this.errorMessage = null;
    this.invalidateRecoverableWork();
    this.notifyListeners();
  }

  /**
   * AppState / background policy – minimal production-safe.
   * When app becomes inactive/backgrounded while voice activity is running:
   * - invalidate active voice attempt SYNCHRONOUSLY (generation++)
   * - stop active recording safely (best-effort)
   * - stop active TTS (idempotent)
   * - prevent late STT/AI results from mutating or persisting
   * - do not fabricate failure evidence
   * - do not auto-restart mic on foreground
   * Foreground returns to stable idle/recoverable state.
   */
  handleBackground(): void {
    if (this.disposed) return;
    // Synchronous invalidation FIRST
    this.generation += 1;
    this.session.abandon?.();
    // Preserved recovery work belonged to the interrupted attempt: it is dropped
    // instead of surviving into the next foreground turn (its temp file is
    // cleaned by the owned-uri handling right below).
    this.pendingTurn = null;
    this.recoverableRecording = null;
    // Stop timer synchronously
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    // Cleanup owned temp audio file – stale/disposed cleans owned, failures no evidence/crash
    const ownedUri = this.lastAudioUri;
    this.lastAudioUri = null;
    if (ownedUri) void this.cleanupAudio(ownedUri);
    // Invalidate recorder synchronously if it supports it, else best-effort stop
    try {
      const recAny = this.recorder as any;
      if (typeof recAny.invalidate === 'function') {
        recAny.invalidate();
      } else if (this.recorder.isRecording()) {
        // Best-effort async stop, but we already cleared active state synchronously
        this.recorder.stopRecording().catch(() => {});
      }
    } catch {}
    // Invalidate TTS synchronously
    try {
      const ttsAny = this.ttsProvider as any;
      if (typeof ttsAny.invalidate === 'function') {
        ttsAny.invalidate();
      } else {
        void this.stopPlayback();
      }
    } catch {}
    // Return to stable idle – no evidence fabrication
    this.switching = false;
    this.processing = false;
    this.state = 'idle';
    this.elapsedSeconds = 0;
    // Keep recognizedTranscript? No – clear to avoid stale transcript populating new task
    this.recognizedTranscript = null;
    this.errorMessage = null;
    this.notifyListeners();
  }

  /** Foreground – ensure idle recoverable state, no auto-restart */
  handleForeground(): void {
    if (this.disposed) return;
    // Already idle after background, but ensure stable state
    if (this.state !== 'idle' && this.state !== 'error') {
      this.state = 'idle';
      this.notifyListeners();
    }
  }

  /**
   * Safe teardown (screen unmount): in-flight voice work is invalidated, the
   * ACTIVE conversation session is closed immediately, an active recording is
   * stopped and any playback is stopped. Late STT/AI results are discarded
   * instead of being applied to a dead screen.
   *
   * Ordering matters for exactly the same reason as `switchSession()`: an AI
   * request already inside `session.send()` could resolve WHILE teardown is
   * still awaiting recorder/playback cleanup, and — if the session were still
   * writable — it would commit a stale learner/tutor turn, feedback and
   * vocabulary side effects. So the active session is abandoned BEFORE the first
   * await; the awaited cleanup then runs against an already non-writable session.
   *
   * Disposal is terminal and idempotent: it is allowed to write the final idle
   * state, and a second call returns the same settlement promise without
   * restarting teardown (the active session's abandonment is likewise idempotent).
   */
  async dispose(): Promise<void> {
    const pending = this.disposalPromise;
    if (pending) return pending;
    const disposal = this.performDisposal();
    this.disposalPromise = disposal;
    return disposal;
  }

  /** One-shot disposal body (see dispose() for the ordering contract). */
  private async performDisposal(): Promise<void> {
    // 1. Terminal flag + invalidate every in-flight operation.
    this.disposed = true;
    this.generation += 1;
    if (this.appStateSub) {
      try {
        this.appStateSub.remove();
      } catch {}
      this.appStateSub = null;
    }
    const ownedUri = this.lastAudioUri;
    this.lastAudioUri = null;
    // Terminal: no preserved transcript or recording survives disposal.
    this.pendingTurn = null;
    this.recoverableRecording = null;
    if (ownedUri) {
      try {
        await this.cleanupAudio(ownedUri);
      } catch {}
    }
    // 2. The ACTIVE session becomes non-writable IMMEDIATELY — before any
    //    awaited teardown — so a late STT/AI result that resolves during cleanup
    //    can never commit history, feedback or vocabulary persistence.
    this.session.abandon?.();
    // 3. Stop and await recorder/playback cleanup (writes no lifecycle state).
    await this.teardown();
    // 4. Settle the terminal coordinator state.
    this.switching = false;
    this.processing = false;
    this.state = 'idle';
    this.elapsedSeconds = 0;
    this.recognizedTranscript = null;
    this.errorMessage = null;
    this.notifyListeners();
  }
}

export function createVoiceSessionCoordinator(
  config: VoiceSessionCoordinatorConfig
): VoiceSessionCoordinator {
  return new VoiceSessionCoordinator(config);
}
