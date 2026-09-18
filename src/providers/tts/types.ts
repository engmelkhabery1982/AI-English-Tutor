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
  /**
   * OPTIONAL, explicit playback-capability declaration.
   *
   * `true` ONLY when `TTSOptions.rate` really changes the delivered speech on
   * the platforms this provider runs on. Absent or `false` means speed control
   * is not honestly available — consumers must degrade and say so instead of
   * offering a control that does nothing.
   */
  readonly supportsSpeechRate?: boolean;
  /**
   * OPTIONAL list of distinct synthesized voices this provider can really
   * produce. Absent means ONE voice only, so multi-speaker material must mark
   * speaker changes with text cues rather than claiming several voices.
   */
  readonly supportedVoices?: readonly string[];
  speak(text: string, options?: TTSOptions): Promise<void>;
  stop(): Promise<void>;
  isSpeaking(): Promise<boolean>;
}
