/**
 * src/voice/tts-controller.ts
 *
 * Global TTS interruption / overlap / teardown hardening.
 *
 * Required:
 * - at most one active TTS playback per owned voice surface
 * - replay interrupts/replaces previous playback safely
 * - leaving/unmounting stops TTS
 * - task switch stops old TTS
 * - stale TTS completion cannot mutate replacement session (generation token)
 * - stop/cancel idempotent
 * - no permanent pending promise if native/provider completion callback never arrives (watchdog in provider)
 */

import type { TextToSpeechProvider, TTSOptions } from '../providers/tts/types';

export class TTSController {
  private generation = 0;
  private activeGen: number | null = null;
  private disposed = false;
  private pendingStop: Promise<void> | null = null;

  constructor(private readonly provider: TextToSpeechProvider) {}

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

  /** Synchronous invalidation for task switch / background / unmount */
  invalidate(): void {
    this.generation += 1;
    this.activeGen = null;
    try {
      const anyProv = this.provider as any;
      if (typeof anyProv.invalidate === 'function') {
        anyProv.invalidate();
      } else {
        this.trackStop(anyProv.stop?.() ?? Promise.resolve());
      }
    } catch {}
  }

  /** Speak – interrupts previous playback safely, single-flight per surface */
  async speak(text: string, options?: TTSOptions & { generation?: number }): Promise<void> {
    if (this.disposed) return;
    // Invalidate previous playback synchronously
    this.generation += 1;
    const gen = this.generation;
    this.activeGen = gen;

    if (this.pendingStop) {
      try {
        await this.pendingStop;
      } catch {}
    }
    if (this.disposed || this.generation !== gen) return;

    try {
      // Wrap callbacks to check generation – stale completion cannot mutate replacement
      const wrapped: TTSOptions = {
        ...options,
        onStart: () => {
          if (this.generation === gen) options?.onStart?.();
        },
        onDone: () => {
          if (this.generation === gen) {
            this.activeGen = null;
            options?.onDone?.();
          }
        },
        onError: (e) => {
          if (this.generation === gen) {
            this.activeGen = null;
            options?.onError?.(e);
          }
        },
      };
      await this.provider.speak(text, wrapped);
      if (this.generation === gen) {
        this.activeGen = null;
      }
    } catch {
      if (this.generation === gen) this.activeGen = null;
    }
  }

  /** Idempotent stop */
  async stop(): Promise<void> {
    this.generation += 1;
    this.activeGen = null;
    const p = this.provider.stop().catch(() => {});
    this.trackStop(p);
    await p;
  }

  isActive(): boolean {
    return this.activeGen !== null && this.generation === this.activeGen;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.activeGen = null;
    try {
      await this.provider.stop();
    } catch {}
    if (this.pendingStop) {
      try {
        await this.pendingStop;
      } catch {}
    }
    // Also dispose provider if it has dispose
    try {
      const anyProv = this.provider as any;
      if (typeof anyProv.dispose === 'function') {
        await anyProv.dispose();
      }
    } catch {}
  }
}

export function createTTSController(provider: TextToSpeechProvider): TTSController {
  return new TTSController(provider);
}
