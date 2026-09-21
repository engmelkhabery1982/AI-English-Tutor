/**
 * src/voice/timings.ts
 *
 * Lightweight INTERNAL voice-latency diagnostics (development/debug only).
 *
 * Records a timestamp for each voice pipeline milestone so slow stages on real
 * devices can be attributed (mic tap → recorder active → stop → STT → provider
 * → first chunk → completion → TTS). Deliberately minimal:
 * - no API key, no network, no analytics backend, no persistence,
 * - event names and timestamps ONLY — never transcript contents, never audio,
 *   never personal data,
 * - inactive unless the app runs in development (`__DEV__`) or a debugger
 *   explicitly opts in (`globalThis.__VOICE_TIMINGS__` / setVoiceTimingsEnabled),
 * - one small in-memory ring buffer; `console.debug` output only when enabled.
 */

/** The voice pipeline milestones that are worth timing. */
export type VoiceTimingEvent =
  | 'mic_tap'
  | 'recorder_start_requested'
  | 'recorder_active'
  | 'stop_requested'
  | 'recorder_stopped'
  | 'stt_started'
  | 'stt_completed'
  | 'provider_request_started'
  | 'first_tutor_chunk'
  | 'tutor_response_completed'
  | 'tts_requested'
  | 'tts_playback_started'
  | 'tts_completed'
  | 'tts_failed';

export interface VoiceTimingEntry {
  readonly event: VoiceTimingEvent;
  /** Epoch milliseconds of the mark. */
  readonly at: number;
  /** Milliseconds since the previous mark (0 for the first mark). */
  readonly deltaMs: number;
}

/** Bound the diagnostic buffer: it is a rolling window, not a log archive. */
const MAX_ENTRIES = 200;

const entries: VoiceTimingEntry[] = [];
let lastAt: number | null = null;
let override: boolean | null = null;

function detectEnabled(): boolean {
  if (override !== null) return override;
  const g = globalThis as { __DEV__?: unknown; __VOICE_TIMINGS__?: unknown };
  return g.__VOICE_TIMINGS__ === true || g.__DEV__ === true;
}

/**
 * Explicit override (debugging/tests). `null` restores the default detection
 * (`__DEV__` or the global opt-in flag).
 */
export function setVoiceTimingsEnabled(enabled: boolean | null): void {
  override = enabled;
}

/** Empties the diagnostic buffer (e.g. at the start of a measurement). */
export function resetVoiceTimings(): void {
  entries.length = 0;
  lastAt = null;
}

/** The recorded marks, oldest first (empty while diagnostics are disabled). */
export function getVoiceTimingLog(): readonly VoiceTimingEntry[] {
  return entries;
}

/**
 * Records ONE pipeline milestone. Cheap no-op while diagnostics are disabled;
 * never throws, never blocks, never records payload content.
 */
export function markVoiceTiming(event: VoiceTimingEvent): void {
  if (!detectEnabled()) return;
  const at = Date.now();
  const deltaMs = lastAt === null ? 0 : Math.max(0, at - lastAt);
  lastAt = at;
  entries.push({ event, at, deltaMs });
  if (entries.length > MAX_ENTRIES) entries.shift();
  try {
    // Development-only diagnostic output (guarded by detectEnabled above).
    // eslint-disable-next-line no-console
    console.debug(`[voice-timing] ${event} +${deltaMs}ms`);
  } catch {
    // Diagnostics must never break the voice pipeline.
  }
}
