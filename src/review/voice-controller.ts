/**
 * src/review/voice-controller.ts
 *
 * The Review surface's voice path — the SAME controller the Review screen uses
 * (there is no second voice stack). It is a small, single-flight state machine
 * over the existing recorder/STT providers with the lifecycle guarantees the
 * rest of the app gets from the voice session coordinator:
 *
 *   - ONE operation at a time: repeated mic taps are ignored while an operation
 *     is in flight, so two recordings can never overlap and a double "stop"
 *     transcribes once;
 *   - generation-invalidated callbacks: `reset()` (item switch) and `dispose()`
 *     (leave/unmount) invalidate every in-flight callback SYNCHRONOUSLY, so a
 *     late transcript can never populate a replacement item or a new task;
 *   - terminal disposal: a disposed controller never records, transcribes or
 *     mutates state again, and never reuses the recorder illegally (an open
 *     recording is stopped best-effort, never awaited by the caller).
 *
 * The controller only ever produces a transcript for the caller to review and
 * submit: it never persists anything, so a transcript by itself can never
 * become learner evidence.
 */

import type { AudioRecorderService } from '../voice/types';
import type { SpeechToTextProvider } from '../providers/stt/types';

export type ReviewVoiceState = 'idle' | 'recording' | 'transcribing' | 'error';

export interface ReviewVoiceStatus {
  readonly state: ReviewVoiceState;
  readonly isRecording: boolean;
  readonly isTranscribing: boolean;
  readonly isBusy: boolean;
  readonly isDisposed: boolean;
  /** False when no real speech recognition exists (voice answers unavailable). */
  readonly isAvailable: boolean;
  /** The transcript of the CURRENT attempt; '' once an attempt is invalidated. */
  readonly transcript: string;
  readonly error: string | null;
}

export interface ReviewVoiceControllerOptions {
  /**
   * True when the injected STT cannot produce real speech recognition. The
   * controller then refuses to open the microphone and reports the honest
   * learner-facing message instead of inventing a transcript.
   */
  readonly unavailable?: boolean;
  readonly unavailableMessage?: string | null;
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class ReviewVoiceController {
  private _isRecording = false;
  private _userAnswer = '';
  private _error: string | null = null;
  private _state: ReviewVoiceState = 'idle';
  private _busy = false;
  private _disposed = false;
  /** Bumped synchronously whenever earlier work must never land. */
  private generation = 0;
  /**
   * Identity of the operation that currently owns the controller. An
   * abandoned operation (item switch / disposal) no longer owns it, so its
   * outcome can never overwrite the state of a newer operation.
   */
  private operationToken = 0;
  private activeOperation: number | null = null;

  private readonly unavailable: boolean;
  private readonly unavailableMessage: string | null;

  constructor(
    private readonly recorder: AudioRecorderService,
    private readonly stt: SpeechToTextProvider,
    options: ReviewVoiceControllerOptions = {},
  ) {
    this.unavailable = options.unavailable ?? false;
    this.unavailableMessage = options.unavailableMessage ?? null;
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  get userAnswer(): string {
    return this._userAnswer;
  }

  get error(): string | null {
    return this._error;
  }

  get isBusy(): boolean {
    return this._busy;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get isAvailable(): boolean {
    return !this.unavailable;
  }

  /** Snapshot for the UI. */
  getStatus(): ReviewVoiceStatus {
    return {
      state: this._state,
      isRecording: this._isRecording,
      isTranscribing: this._state === 'transcribing',
      isBusy: this._busy,
      isDisposed: this._disposed,
      isAvailable: !this.unavailable,
      transcript: this._userAnswer,
      error: this._error,
    };
  }

  /** Clears the answer box (typing, item change). Never resurrects old work. */
  clearAnswer(): void {
    if (this._disposed) return;
    this._userAnswer = '';
  }

  /**
   * Item switch: invalidates everything in flight BEFORE anything else runs.
   * An open recording is stopped best-effort — the shared recorder must never
   * keep running for an item the learner already left (invariant: at most one
   * active recording per surface).
   */
  reset(): void {
    if (this._disposed) return;
    const wasRecording = this._isRecording;
    this.generation += 1;
    // The abandoned operation keeps unwinding in the background, but it no
    // longer owns the controller — the mic is immediately usable for the new
    // item while its result is guaranteed to be discarded.
    this.abandonActiveOperation();
    this._userAnswer = '';
    this._error = null;
    this._isRecording = false;
    this._state = 'idle';
    if (wasRecording) {
      void this.recorder.stopRecording().catch(() => undefined);
    }
  }

  private abandonActiveOperation(): void {
    this.activeOperation = null;
    this._busy = false;
  }

  /**
   * Terminal disposal (unmount / leaving the surface): synchronously
   * invalidates all callbacks, then tears the recorder down best-effort.
   * Idempotent; a disposed controller is never reused.
   */
  dispose(): void {
    if (this._disposed) return;
    const wasRecording = this._isRecording;
    this._disposed = true;
    this.generation += 1;
    this.abandonActiveOperation();
    this._isRecording = false;
    this._busy = false;
    this._state = 'idle';
    this._userAnswer = '';
    this._error = null;
    if (wasRecording) {
      void this.recorder.stopRecording().catch(() => undefined);
    }
  }

  /**
   * Starts or stops (and transcribes) the current attempt.
   *
   * Single-flight: while an operation is in flight every further call is a
   * no-op returning the current status — a double mic tap cannot open two
   * recordings and a double stop cannot transcribe twice.
   */
  async toggleRecording(): Promise<ReviewVoiceStatus> {
    if (this._disposed || this._busy) {
      return this.getStatus();
    }
    if (this.unavailable) {
      this._error = this.unavailableMessage ?? 'Voice answers are unavailable right now.';
      this._state = 'error';
      return this.getStatus();
    }
    return this._isRecording ? this.stopAndTranscribe() : this.start();
  }

  private isStale(generation: number): boolean {
    return this._disposed || generation !== this.generation;
  }

  private async start(): Promise<ReviewVoiceStatus> {
    const token = ++this.operationToken;
    this.activeOperation = token;
    this._busy = true;
    this._error = null;
    const generation = this.generation;
    try {
      const hasPermissions = await this.recorder.hasPermissions();
      if (this.isStale(generation)) {
        return this.getStatus();
      }
      if (!hasPermissions) {
        const granted = await this.recorder.requestPermissions();
        if (this.isStale(generation)) {
          return this.getStatus();
        }
        if (!granted) {
          this._error = 'Microphone permission denied';
          this._state = 'error';
          return this.getStatus();
        }
      }

      await this.recorder.startRecording();
      if (this.isStale(generation)) {
        // The learner left the item/surface while the microphone was opening:
        // never keep an orphaned recording running.
        void this.recorder.stopRecording().catch(() => undefined);
        return this.getStatus();
      }

      this._isRecording = true;
      this._state = 'recording';
    } catch (error) {
      if (!this.isStale(generation)) {
        this._isRecording = false;
        this._state = 'error';
        this._error = describeError(error, 'Failed to start recording');
      }
    } finally {
      this.finishOperation(token);
    }
    return this.getStatus();
  }

  private async stopAndTranscribe(): Promise<ReviewVoiceStatus> {
    const token = ++this.operationToken;
    this.activeOperation = token;
    this._busy = true;
    this._isRecording = false;
    this._state = 'transcribing';
    const generation = this.generation;
    try {
      const result = await this.recorder.stopRecording();
      if (this.isStale(generation)) {
        return this.getStatus();
      }

      const sttRes = await this.stt.transcribe({
        uri: result.uri,
        base64: result.base64,
        mimeType: result.mimeType,
        durationMs: result.durationMs,
      });

      // A transcript that arrives after the attempt was invalidated (item
      // switch, leave, unmount) is discarded — it belongs to the old attempt.
      if (this.isStale(generation)) {
        return this.getStatus();
      }

      if (sttRes.ok && sttRes.transcript) {
        this._userAnswer = sttRes.transcript;
        this._error = null;
        this._state = 'idle';
      } else if (sttRes.ok) {
        this._error = 'No speech was recognized. Try again or type your answer.';
        this._state = 'error';
      } else {
        this._error = sttRes.error || 'Failed to transcribe speech.';
        this._state = 'error';
      }
    } catch (error) {
      if (!this.isStale(generation)) {
        this._isRecording = false;
        this._state = 'error';
        this._error = describeError(error, 'Error transcribing audio.');
      }
    } finally {
      this.finishOperation(token);
    }
    return this.getStatus();
  }

  /** Only the operation that still owns the controller may release it. */
  private finishOperation(token: number): void {
    if (this.activeOperation === token) {
      this.activeOperation = null;
      this._busy = false;
    }
  }
}
