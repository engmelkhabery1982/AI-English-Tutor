/**
 * src/providers/tts/types.ts
 *
 * Provider-neutral interfaces and types for Text-to-Speech (TTS).
 */

export interface TTSOptions {
  readonly language?: string;
  readonly rate?: number;
  readonly pitch?: number;
  readonly onStart?: () => void;
  readonly onDone?: () => void;
  readonly onError?: (error: Error) => void;
}

export interface TextToSpeechProvider {
  readonly id: string;
  speak(text: string, options?: TTSOptions): Promise<void>;
  stop(): Promise<void>;
  isSpeaking(): Promise<boolean>;
}
