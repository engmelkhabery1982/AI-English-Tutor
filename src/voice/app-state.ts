/**
 * src/voice/app-state.ts
 *
 * Minimal production-safe AppState / background policy for voice surfaces.
 *
 * When app becomes inactive/backgrounded while voice activity is running:
 * - invalidate active voice attempt synchronously (generation bump)
 * - stop active recording safely (best-effort, never throws)
 * - stop active TTS (idempotent)
 * - prevent late STT/AI/pronunciation results from mutating or persisting
 * - do not fabricate failure evidence
 * - do not auto-restart mic on foreground
 *
 * On foreground: return to stable idle/recoverable state, learner explicitly starts again.
 *
 * Usage: screens subscribe via `useVoiceAppState` hook or via `createVoiceAppStateGuard`.
 * Avoid per-screen duplicate AppState implementations – reuse this shared layer.
 */

import { AppState, type AppStateStatus } from 'react-native';

export interface VoiceAppStateTarget {
  /** Synchronous invalidation – must bump generation / invalidate callbacks immediately */
  invalidate?: () => void;
  /** Stop recording safely – best-effort, never throws */
  stopRecording?: () => Promise<void> | void;
  /** Stop TTS – idempotent */
  stopTTS?: () => Promise<void> | void;
  /** Optional: called when app goes background – for logging/telemetry, no evidence fabrication */
  onBackground?: () => void;
  /** Optional: called when app returns foreground */
  onForeground?: () => void;
}

export interface VoiceAppStateGuard {
  readonly dispose: () => void;
}

/**
 * Creates a guard that listens to AppState and invalidates voice work on background.
 * Synchronous invalidation FIRST, then async stop of recorder/TTS.
 * Does NOT auto-restart on foreground.
 */
export function createVoiceAppStateGuard(target: VoiceAppStateTarget): VoiceAppStateGuard {
  let currentState = AppState.currentState;
  let disposed = false;

  const handleChange = (nextState: AppStateStatus) => {
    if (disposed) return;
    const prev = currentState;
    currentState = nextState;

    // Transition to background / inactive
    const goingBackground =
      (prev === 'active' && (nextState === 'background' || nextState === 'inactive')) ||
      (prev === 'inactive' && nextState === 'background');

    const comingForeground = (prev === 'background' || prev === 'inactive') && nextState === 'active';

    if (goingBackground) {
      // Synchronous invalidation FIRST – stale callbacks impossible
      try {
        target.invalidate?.();
      } catch {}
      try {
        target.onBackground?.();
      } catch {}

      // Then best-effort stop recording and TTS – never throws, never fabricates evidence
      void (async () => {
        try {
          await target.stopRecording?.();
        } catch {}
        try {
          await target.stopTTS?.();
        } catch {}
      })();
    }

    if (comingForeground) {
      try {
        target.onForeground?.();
      } catch {}
      // Do NOT auto-restart mic – return to stable idle
    }
  };

  const subscription = AppState.addEventListener('change', handleChange);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        subscription.remove();
      } catch {}
    },
  };
}

/**
 * React hook wrapper for screens – use inside useEffect.
 * Returns a dispose function.
 * For non-React usage, use createVoiceAppStateGuard directly.
 * NOTE: The React hook implementation lives in use-app-state-guard.ts;
 * this alias is kept for backward compat but renamed to avoid barrel conflict.
 */
export function createVoiceAppStateGuardHook(target: VoiceAppStateTarget): { dispose: () => void } {
  return createVoiceAppStateGuard(target);
}

/**
 * Helper for Talk/Fluency/etc that own a VoiceSessionCoordinator.
 * Provides the target shape expected by the guard.
 */
export function coordinatorToAppStateTarget(coordinator: {
  setSession?: (s: any) => void;
  generation?: number;
  invalidate?: () => void;
  recorder?: { isRecording?: () => boolean; stopRecording?: () => Promise<any> };
  stopSpeaking?: () => Promise<void>;
  stopPlayback?: () => Promise<void>;
  cancelRecording?: () => void;
  reset?: () => Promise<void>;
  dispose?: () => Promise<void>;
  ttsProvider?: { stop?: () => Promise<void>; invalidate?: () => void };
}): VoiceAppStateTarget {
  return {
    invalidate: () => {
      // Synchronous invalidation: bump generation if available, abandon session, stop recorder sync
      try {
        // If coordinator has explicit invalidate (our hardened recorder), use it
        // Otherwise, bump generation by calling setSession with same session? No – use reset path
        // For VoiceSessionCoordinator, we need to invalidate without awaiting
        // The coordinator's generation is private, but reset() bumps it – we call a sync invalidation
        // We try to call invalidate if exists, else we call cancelRecording which is sync-ish
        const anyCoord = coordinator as any;
        if (typeof anyCoord.invalidate === 'function') {
          anyCoord.invalidate();
        } else if (anyCoord.recorder && typeof anyCoord.recorder.invalidate === 'function') {
          anyCoord.recorder.invalidate();
        } else if (typeof anyCoord.cancelRecording === 'function') {
          anyCoord.cancelRecording();
        }
        if (anyCoord.ttsProvider && typeof anyCoord.ttsProvider.invalidate === 'function') {
          anyCoord.ttsProvider.invalidate();
        }
      } catch {}
    },
    stopRecording: async () => {
      try {
        const anyCoord = coordinator as any;
        if (anyCoord.recorder && typeof anyCoord.recorder.stopRecording === 'function') {
          if (anyCoord.recorder.isRecording?.()) {
            await anyCoord.recorder.stopRecording();
          }
        } else if (typeof anyCoord.cancelRecording === 'function') {
          anyCoord.cancelRecording();
        }
      } catch {}
    },
    stopTTS: async () => {
      try {
        const anyCoord = coordinator as any;
        if (typeof anyCoord.stopSpeaking === 'function') {
          await anyCoord.stopSpeaking();
        } else if (anyCoord.ttsProvider && typeof anyCoord.ttsProvider.stop === 'function') {
          await anyCoord.ttsProvider.stop();
        }
      } catch {}
    },
  };
}
