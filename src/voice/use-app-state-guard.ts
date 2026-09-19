/**
 * src/voice/use-app-state-guard.ts
 *
 * React hook for AppState background policy – minimal production-safe.
 * Reuses createVoiceAppStateGuard from app-state.ts
 */

import { useEffect, useRef } from 'react';
import { createVoiceAppStateGuard, type VoiceAppStateTarget } from './app-state';

export function useVoiceAppStateGuard(target: VoiceAppStateTarget | null): void {
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (!targetRef.current) return;
    const guard = createVoiceAppStateGuard({
      invalidate: () => {
        try {
          targetRef.current?.invalidate?.();
        } catch {}
      },
      stopRecording: async () => {
        try {
          await targetRef.current?.stopRecording?.();
        } catch {}
      },
      stopTTS: async () => {
        try {
          await targetRef.current?.stopTTS?.();
        } catch {}
      },
      onBackground: () => {
        try {
          targetRef.current?.onBackground?.();
        } catch {}
      },
      onForeground: () => {
        try {
          targetRef.current?.onForeground?.();
        } catch {}
      },
    });
    return () => guard.dispose();
  }, []);
}
