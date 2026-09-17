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
}

export type VoiceStatusListener = (status: VoiceStatus) => void;
