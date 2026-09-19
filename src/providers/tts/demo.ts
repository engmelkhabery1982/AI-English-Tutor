/**
 * src/providers/tts/demo.ts
 *
 * Demo/Mock Text-to-Speech provider for tests and environments without native speech synthesis.
 */

import { sanitizeTextForTTS } from './sanitizer';
import type { TextToSpeechProvider, TTSOptions } from './types';

export class DemoTTSProvider implements TextToSpeechProvider {
  readonly id = 'demo-tts';
  readonly supportsSpeechRate = false;
  private speaking: boolean = false;
  private readonly spokenList: string[] = [];
  private generation = 0;
  private disposed = false;
  private pendingStop: Promise<void> | null = null;

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

  private trackStop(p: Promise<unknown>): void {
    const safe = p.then(() => undefined).catch(() => undefined);
    if (this.pendingStop) {
      const prev = this.pendingStop;
      this.pendingStop = prev.then(() => safe).catch(() => undefined);
    } else {
      this.pendingStop = safe;
    }
    const cur = this.pendingStop;
    cur.finally(() => {
      if (this.pendingStop === cur) this.pendingStop = null;
    });
  }

  async speak(text: string, options?: TTSOptions): Promise<void> {
    if (this.disposed) return;
    const cleanText = sanitizeTextForTTS(text);
    if (!cleanText || cleanText.length === 0) return;

    this.generation += 1;
    const gen = this.generation;
    if (this.pendingStop) {
      try {
        await this.pendingStop;
      } catch {}
    }
    if (this.disposed || this.generation !== gen) return;

    this.speaking = true;
    this.spokenList.push(cleanText);
    if (this.generation === gen) options?.onStart?.();
    // Simulate brief playback
    this.speaking = false;
    if (this.generation === gen) options?.onDone?.();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.speaking = false;
    const p = Promise.resolve();
    this.trackStop(p);
    await p;
  }

  async isSpeaking(): Promise<boolean> {
    return this.speaking;
  }

  invalidate(): void {
    this.generation += 1;
    this.speaking = false;
    this.trackStop(Promise.resolve());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.speaking = false;
    if (this.pendingStop) {
      try {
        await this.pendingStop;
      } catch {}
    }
  }
}

export function createDemoTTSProvider(): DemoTTSProvider {
  return new DemoTTSProvider();
}
