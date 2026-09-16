/**
 * src/providers/stt/types.ts
 *
 * Provider-neutral interfaces and types for Speech-to-Text (STT).
 */

export interface STTAudioInput {
  readonly uri?: string;
  readonly base64?: string;
  readonly mimeType?: string;
  readonly durationMs?: number;
}

export interface STTResult {
  readonly ok: boolean;
  readonly transcript?: string;
  readonly error?: string;
}

export interface SpeechToTextProvider {
  readonly id: string;
  transcribe(input: STTAudioInput): Promise<STTResult>;
}
