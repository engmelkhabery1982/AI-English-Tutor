/**
 * src/providers/tts/expo.ts
 *
 * Real Text-to-Speech provider using official Expo Speech (expo-speech).
 */

import type * as ExpoSpeechModule from 'expo-speech';
import { sanitizeTextForTTS } from './sanitizer';
import type { TextToSpeechProvider, TTSOptions } from './types';

let speechModulePromise: Promise<typeof ExpoSpeechModule> | null = null;
async function getSpeechModule(): Promise<typeof ExpoSpeechModule> {
  if (!speechModulePromise) {
    speechModulePromise = import('expo-speech');
  }
  return speechModulePromise;
}

export class ExpoTTSProvider implements TextToSpeechProvider {
  readonly id = 'expo-speech';
  /**
   * Honest declaration: expo-speech really honors `rate` (0.0–2.0, 1.0 is
   * normal), so slower/natural/faster playback is a real capability here.
   */
  readonly supportsSpeechRate = true;

  async speak(text: string, options?: TTSOptions): Promise<void> {
    const cleanText = sanitizeTextForTTS(text);
    if (!cleanText || cleanText.length === 0) {
      return;
    }

    // Stop any existing speech before starting new speech
    try {
      await this.stop();
    } catch {
      // Ignore stop error
    }

    return new Promise(async (resolve) => {
      let resolved = false;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      try {
        const Speech = await getSpeechModule();
        Speech.speak(cleanText, {
          language: options?.language ?? 'en-US',
          rate: options?.rate ?? 1.0,
          pitch: options?.pitch ?? 1.0,
          onStart: () => {
            options?.onStart?.();
          },
          onDone: () => {
            options?.onDone?.();
            finish();
          },
          onStopped: () => {
            options?.onDone?.();
            finish();
          },
          onError: (err: Error) => {
            options?.onError?.(err);
            finish();
          },
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        options?.onError?.(error);
        finish();
      }
    });
  }

  async stop(): Promise<void> {
    try {
      const Speech = await getSpeechModule();
      await Speech.stop();
    } catch {
      // Ignore stop failure on unsupported platforms
    }
  }

  async isSpeaking(): Promise<boolean> {
    try {
      const Speech = await getSpeechModule();
      return await Speech.isSpeakingAsync();
    } catch {
      return false;
    }
  }
}

export function createExpoTTSProvider(): TextToSpeechProvider {
  return new ExpoTTSProvider();
}
