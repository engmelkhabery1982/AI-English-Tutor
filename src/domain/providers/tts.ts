/**
 * src/domain/providers/tts.ts
 *
 * TextToSpeechProvider interface.
 *
 * Vendor-agnostic contract for converting text to spoken audio.
 * Implementations may wrap a free TTS engine, a local model, a
 * free cloud provider, or any future backend.
 */

import type { Uuid, VoiceGender } from '../shared/types';

/** A single voice offered by a TTS provider. */
export interface TTSVoice {
  readonly voiceId: string;
  readonly name: string;
  readonly gender?: VoiceGender;
  readonly language?: string; // BCP-47
  readonly accent?: string;
  readonly style?: 'neutral' | 'conversational' | 'encouraging' | 'professional';
  readonly isLocal?: boolean; // true for on-device voices
}

/** Request to synthesize speech. */
export interface TTSRequest {
  readonly text: string;
  readonly voiceId?: string;
  readonly language?: string;
  readonly speed?: number; // 0.5..2.0
  readonly pitch?: number;
  readonly style?: TTSVoice['style'];
  readonly learnerId?: Uuid;
  readonly conversationId?: Uuid;
  readonly turnId?: Uuid;
  readonly outputFormat?: 'mp3' | 'wav' | 'aac' | 'opus';
  readonly sampleRate?: number;
}

/** Result of synthesizing speech. */
export interface TTSResult {
  readonly audio: ArrayBuffer | Uint8Array;
  readonly mimeType: string;
  readonly durationMs?: number;
  readonly voiceId?: string;
  readonly model?: string;
  readonly latencyMs?: number;
}

/**
 * TextToSpeechProvider
 *
 * Replaceable interface for any text-to-speech backend.
 * Implementations live in src/services/providers/* and must NOT
 * leak vendor SDK types into the domain layer.
 */
export interface TextToSpeechProvider {
  readonly providerId: string;
  readonly voices: readonly TTSVoice[];

  /**
   * Synthesize speech for the given text.
   */
  synthesize(request: TTSRequest): Promise<TTSResult>;

  /**
   * Stream synthesized audio as it is produced.
   * Yields Uint8Array chunks.
   */
  stream(request: TTSRequest): AsyncIterable<Uint8Array>;

  /**
   * List available voices (may be async for remote providers).
   */
  listVoices?(language?: string): Promise<readonly TTSVoice[]>;

  /**
   * Health check.
   */
  healthcheck(): Promise<boolean>;
}

/** Factory signature for creating a TTS provider instance. */
export type TextToSpeechProviderFactory = (
  config: Record<string, unknown>,
) => TextToSpeechProvider;