/**
 * src/domain/providers/stt.ts
 *
 * SpeechToTextProvider interface.
 *
 * Vendor-agnostic contract for converting spoken audio to text.
 * Implementations may wrap on-device STT, a local model, a free
 * cloud provider, or any future backend.
 */

import type { Uuid } from '../shared/types';

/** Source of audio input. */
export type AudioInput =
  | { kind: 'uri'; uri: string; mimeType?: string }
  | { kind: 'buffer'; buffer: ArrayBuffer | Uint8Array; mimeType?: string }
  | { kind: 'base64'; base64: string; mimeType?: string };

/** Request to transcribe audio. */
export interface STTRequest {
  readonly audio: AudioInput;
  readonly language?: string; // BCP-47, e.g. "en-US"
  readonly localeHint?: string;
  readonly conversationId?: Uuid;
  readonly turnId?: Uuid;
  readonly learnerId?: Uuid;
  readonly enablePartialResults?: boolean;
  readonly profanityFilter?: boolean;
  readonly punctuation?: boolean;
  readonly diarization?: boolean;
}

/** A single transcribed segment (for streaming / partial results). */
export interface STTSegment {
  readonly text: string;
  readonly confidence: number; // 0..1
  readonly isFinal: boolean;
  readonly startMs?: number;
  readonly endMs?: number;
  readonly speakerId?: string;
}

/** Final transcription result. */
export interface STTResult {
  readonly text: string;
  readonly language?: string;
  readonly confidence: number; // 0..1
  readonly segments?: readonly STTSegment[];
  readonly durationMs?: number;
  readonly model?: string;
  readonly latencyMs?: number;
}

/** A streaming chunk of partial transcription. */
export interface STTStreamChunk {
  readonly segment: STTSegment;
  readonly done: boolean;
}

/**
 * SpeechToTextProvider
 *
 * Replaceable interface for any speech-to-text backend.
 * Implementations live in src/services/providers/* and must NOT
 * leak vendor SDK types into the domain layer.
 */
export interface SpeechToTextProvider {
  readonly providerId: string;
  readonly capabilities: readonly ('stream' | 'partial-results' | 'diarization')[];

  /**
   * Transcribe a complete audio blob.
   */
  transcribe(request: STTRequest): Promise<STTResult>;

  /**
   * Stream partial + final transcriptions as audio arrives.
   * Yields STTStreamChunk values until `done` is true.
   */
  stream(request: STTRequest): AsyncIterable<STTStreamChunk>;

  /**
   * Health check.
   */
  healthcheck(): Promise<boolean>;
}

/** Factory signature for creating an STT provider instance. */
export type SpeechToTextProviderFactory = (
  config: Record<string, unknown>,
) => SpeechToTextProvider;