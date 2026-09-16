/**
 * src/providers/tts/demo.ts
 *
 * Demo/Mock Text-to-Speech provider for tests and environments without native speech synthesis.
 */

import { sanitizeTextForTTS } from './sanitizer';
import type { TextToSpeechProvider, TTSOptions } from './types';

export class DemoTTSProvider implements TextToSpeechProvider {
  readonly id = 'demo-tts';
  private speaking: boolean = false;
  private readonly spokenList: string[] = [];

  getSpokenTexts(): readonly string[] {
    return this.spokenList;
  }

  getLastSpokenText(): string | null {
    return this.spokenList.length > 0 ? this.spokenList[this.spokenList.length - 1] : null;
  }

  clearSpokenHistory(): void {
    this.spokenList.length = 0;
    this.speaking = false;
  }

  async speak(text: string, options?: TTSOptions): Promise<void> {
    const cleanText = sanitizeTextForTTS(text);
    if (!cleanText || cleanText.length === 0) {
      return;
    }

    this.speaking = true;
    this.spokenList.push(cleanText);
    options?.onStart?.();

    // In demo/test mode, simulate brief playback or immediate completion
    this.speaking = false;
    options?.onDone?.();
  }

  async stop(): Promise<void> {
    this.speaking = false;
  }

  async isSpeaking(): Promise<boolean> {
    return this.speaking;
  }
}

export function createDemoTTSProvider(): DemoTTSProvider {
  return new DemoTTSProvider();
}
