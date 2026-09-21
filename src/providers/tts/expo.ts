/**
 * src/providers/tts/expo.ts
 *
 * Real Text-to-Speech provider using official Expo Speech (expo-speech).
 * Hardened for mobile lifecycle:
 * - at most one active TTS playback per owned surface (generation token)
 * - replay interrupts/replaces previous playback safely
 * - stop/cancel idempotent
 * - stale completion cannot mutate replacement session (generation check)
 * - bounded watchdog/timeout to avoid permanent pending promise if native callback never arrives
 */

import type * as ExpoSpeechModule from 'expo-speech';
import { sanitizeTextForTTS } from './sanitizer';
import type { TextToSpeechProvider, TTSOptions } from './types';
import { beginRequestDiagnostics, finishRequestDiagnostics } from '../request-diagnostics';

let speechModulePromise: Promise<typeof ExpoSpeechModule> | null = null;
async function getSpeechModule(): Promise<typeof ExpoSpeechModule> {
  if (!speechModulePromise) {
    speechModulePromise = import('expo-speech');
  }
  return speechModulePromise;
}

const TTS_WATCHDOG_MS = 60_000; // 60s max per utterance – prevents permanent hang if callback lost

export class ExpoTTSProvider implements TextToSpeechProvider {
  readonly id = 'expo-speech';
  readonly supportsSpeechRate = true;

  private generation = 0;
  private active = false;
  private disposed = false;
  private pendingStop: Promise<void> | null = null;

  private trackStop(promise: Promise<unknown>): void {
    const safe = promise.then(() => undefined).catch(() => undefined);
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
    if (!cleanText || cleanText.length === 0) {
      return;
    }

    // Invalidate previous playback synchronously – replay interrupts safely
    this.generation += 1;
    const gen = this.generation;

    // Stop any existing speech before starting new speech – await teardown
    if (this.pendingStop) {
      try {
        await this.pendingStop;
      } catch {}
    }
    try {
      await this.stopInternal();
    } catch {}

    if (this.disposed || this.generation !== gen) return;

    this.active = true;

    // INTERNAL dev/debug counters only — local speech synthesis, no network,
    // never any spoken content.
    const diagnostics = beginRequestDiagnostics({ type: 'tts', providerId: this.id });
    let diagnosticsFailure: string | null = null;

    return new Promise(async (resolve) => {
      let resolved = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          if (watchdog) clearTimeout(watchdog);
          this.active = false;
          finishRequestDiagnostics(diagnostics, {
            ok: diagnosticsFailure === null,
            failureKind: diagnosticsFailure,
          });
          resolve();
        }
      };

      // Bounded watchdog – avoids permanent pending promise if native callback never arrives
      watchdog = setTimeout(() => {
        // Do not invent fake completion – just resolve the promise and stop
        diagnosticsFailure = 'timeout';
        try {
          this.stopInternal().catch(() => {});
        } finally {
          finish();
        }
      }, TTS_WATCHDOG_MS);

      try {
        const Speech = await getSpeechModule();
        if (this.disposed || this.generation !== gen) {
          finish();
          return;
        }
        Speech.speak(cleanText, {
          language: options?.language ?? 'en-US',
          rate: options?.rate ?? 1.0,
          pitch: options?.pitch ?? 1.0,
          onStart: () => {
            if (this.generation === gen) options?.onStart?.();
          },
          onDone: () => {
            if (this.generation === gen) options?.onDone?.();
            finish();
          },
          onStopped: () => {
            // Treat stopped as done for lifecycle, but don't mutate replacement
            if (this.generation === gen) options?.onDone?.();
            finish();
          },
          onError: (err: Error) => {
            diagnosticsFailure = 'playback_error';
            if (this.generation === gen) options?.onError?.(err);
            finish();
          },
        });
      } catch (err: unknown) {
        diagnosticsFailure = 'playback_error';
        const error = err instanceof Error ? err : new Error(String(err));
        if (this.generation === gen) options?.onError?.(error);
        finish();
      }
    });
  }

  private async stopInternal(): Promise<void> {
    try {
      const Speech = await getSpeechModule();
      await Speech.stop();
    } catch {
      // Ignore stop failure on unsupported platforms
    }
  }

  async stop(): Promise<void> {
    // Idempotent stop – bump generation to invalidate stale callbacks
    this.generation += 1;
    this.active = false;
    const p = this.stopInternal();
    this.trackStop(p);
    try {
      await p;
    } catch {}
  }

  async isSpeaking(): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.active) return false;
    try {
      const Speech = await getSpeechModule();
      return await Speech.isSpeakingAsync();
    } catch {
      return this.active;
    }
  }

  /** Synchronous invalidation for task switch / background */
  invalidate(): void {
    this.generation += 1;
    this.active = false;
    this.trackStop(this.stopInternal());
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.active = false;
    try {
      await this.stopInternal();
    } catch {}
    if (this.pendingStop) {
      try {
        await this.pendingStop;
      } catch {}
    }
  }
}

export function createExpoTTSProvider(): TextToSpeechProvider {
  return new ExpoTTSProvider();
}
