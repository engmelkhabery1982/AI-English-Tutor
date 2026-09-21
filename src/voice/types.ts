/**
 * src/voice/types.ts
 *
 * Types for the Voice Conversation MVP state machine, recorder, and coordinator.
 */

export type VoiceState =
  | 'idle'
  | 'requesting_permission'
  | 'recording'
  | 'transcribing'
  | 'sending'
  | 'speaking'
  | 'error';

export interface AudioRecordingResult {
  readonly uri: string;
  readonly base64?: string;
  readonly mimeType: string;
  readonly durationMs: number;
}

export interface AudioRecorderService {
  requestPermissions(): Promise<boolean>;
  hasPermissions(): Promise<boolean>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<AudioRecordingResult>;
  isRecording(): boolean;
  getElapsedSeconds(): number;
}

export interface VoiceStatus {
  readonly state: VoiceState;
  readonly elapsedSeconds: number;
  readonly recognizedTranscript: string | null;
  readonly errorMessage: string | null;
  readonly isMuted: boolean;
  readonly isSpeaking: boolean;
  readonly canRecord: boolean;
  readonly canStopRecording: boolean;
  readonly canSendText: boolean;
  /**
   * True while an async voice operation (STT or AI response) is still running.
   * Used to keep the UI honest when the session was replaced mid-operation:
   * the old work is cancelled and its result will be discarded.
   */
  readonly isProcessing?: boolean;
  /**
   * True while the coordinator is atomically switching to another conversation
   * session. No new voice work may start until the switch completes.
   */
  readonly isSwitching?: boolean;
  /**
   * The learner's OWN transcript that has not been committed into the
   * conversation yet because the tutor reply failed. It is preserved so the
   * learner can retry the SAME turn (or edit it as text) instead of recording
   * again. Null when nothing is recoverable.
   */
  readonly pendingTranscript?: string | null;
  /** True when a preserved transcript can be sent again (explicit learner Retry). */
  readonly canRetryPendingTurn?: boolean;
  /**
   * True when the recording itself survived a failed transcription and can be
   * transcribed again without asking the learner to speak a second time.
   */
  readonly canRetryTranscription?: boolean;
  /**
   * True when TTS playback of an ALREADY-COMMITTED tutor response failed for
   * the CURRENT turn (audio-only failure: the tutor text is intact). Playback
   * cancelled by an intentional stop, a session replacement or disposal is
   * never reported as a failure. Drives the "Audio didn't play / Replay"
   * recovery affordance.
   */
  readonly audioPlaybackFailed?: boolean;
  /** True while the failed tutor audio can be replayed (no regeneration). */
  readonly canReplayAudio?: boolean;
}

export type VoiceStatusListener = (status: VoiceStatus) => void;
