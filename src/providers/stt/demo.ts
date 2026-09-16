/**
 * src/providers/stt/demo.ts
 *
 * Demo/offline Speech-to-Text provider for tests and demo environments.
 * Returns deterministic transcriptions without requiring external network or API keys.
 */

import type { SpeechToTextProvider, STTAudioInput, STTResult } from './types';

export interface DemoSTTProviderOptions {
  readonly defaultTranscript?: string;
  readonly shouldFail?: boolean;
  readonly failureMessage?: string;
  readonly delayMs?: number;
}

export class DemoSTTProvider implements SpeechToTextProvider {
  readonly id = 'demo-stt';
  private transcript: string;
  private shouldFail: boolean;
  private failureMessage: string;
  private delayMs: number;

  constructor(options?: DemoSTTProviderOptions) {
    this.transcript =
      options?.defaultTranscript ??
      'Yesterday I went to a meeting with my manager.';
    this.shouldFail = options?.shouldFail ?? false;
    this.failureMessage =
      options?.failureMessage ?? 'Demo STT failed to transcribe audio.';
    this.delayMs = options?.delayMs ?? 0;
  }

  setMockTranscript(transcript: string): void {
    this.transcript = transcript;
  }

  setMockFailure(fail: boolean, message?: string): void {
    this.shouldFail = fail;
    if (message) {
      this.failureMessage = message;
    }
  }

  async transcribe(input: STTAudioInput): Promise<STTResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (this.shouldFail) {
      return {
        ok: false,
        error: this.failureMessage,
      };
    }

    if (!input || (!input.base64 && !input.uri)) {
      return {
        ok: false,
        error: 'No audio data was provided for transcription.',
      };
    }

    if (!this.transcript || this.transcript.trim().length === 0) {
      return {
        ok: false,
        error: 'No speech could be recognized. Please try speaking again.',
      };
    }

    return {
      ok: true,
      transcript: this.transcript.trim(),
    };
  }
}

export function createDemoSTTProvider(
  options?: DemoSTTProviderOptions
): DemoSTTProvider {
  return new DemoSTTProvider(options);
}
