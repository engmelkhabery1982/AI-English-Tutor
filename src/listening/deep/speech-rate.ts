/**
 * src/listening/deep/speech-rate.ts
 *
 * WP-2 — VARIABLE SPEECH RATE, honestly.
 *
 * POLICY (the whole point of this module)
 * - The three conceptual levels exist: `slower`, `natural`, `faster`.
 * - Whether they can be USED depends on the EXISTING TextToSpeechProvider:
 *   a provider is rate-capable only when it explicitly declares
 *   `supportsSpeechRate === true` (i.e. `TTSOptions.rate` really changes
 *   delivery). An absent declaration means UNKNOWN, and unknown is treated as
 *   unsupported — never as supported.
 * - When the provider cannot change speed, the UI offers only `natural` and
 *   says so. Nothing is silently ignored and nothing is faked.
 * - There is deliberately NO words-per-minute figure: the project has no
 *   reliable WPM measurement, so none is invented.
 * - Playback state (speed changes, replays) is LOCAL UI state. It carries no
 *   learner evidence: this module never touches a repository, a weakness, a
 *   review item or the clock.
 */

import type { TextToSpeechProvider } from '../../providers/tts/types';

/** The three conceptual listening-speed levels. */
export type DeepSpeechRateLevel = 'slower' | 'natural' | 'faster';

/** Every speech-rate level, in stable order (natural is the neutral default). */
export const DEEP_SPEECH_RATE_LEVELS: readonly DeepSpeechRateLevel[] = [
  'slower',
  'natural',
  'faster',
] as const;

/** Learner-facing labels (no numbers, no WPM). */
export const SPEECH_RATE_LABELS: Readonly<Record<DeepSpeechRateLevel, string>> = {
  slower: 'Slower',
  natural: 'Natural',
  faster: 'Faster',
};

/** Playback multipliers handed to the EXISTING TTS `rate` option. */
export const SPEECH_RATE_MULTIPLIERS: Readonly<Record<DeepSpeechRateLevel, number>> = {
  slower: 0.75,
  natural: 1,
  faster: 1.25,
};

/** True for a valid speech-rate level (runtime guard for stored/UI values). */
export function isDeepSpeechRateLevel(value: unknown): value is DeepSpeechRateLevel {
  return (
    typeof value === 'string' &&
    (DEEP_SPEECH_RATE_LEVELS as readonly string[]).includes(value)
  );
}

/** Why speed control is (not) available. */
export type SpeechRateUnsupportedReason =
  | 'provider_declares_rate_support'
  | 'provider_does_not_declare_rate_support'
  | 'no_provider';

/** Honest capability of the playback layer. */
export interface SpeechRateCapability {
  readonly supported: boolean;
  readonly providerId: string | null;
  readonly reason: SpeechRateUnsupportedReason;
}

/**
 * Resolve the playback capability from the EXISTING provider.
 *
 * A provider that does not declare `supportsSpeechRate` is NOT assumed to
 * support speed control, even though `TTSOptions.rate` exists: accepting an
 * option and honoring it are different things.
 */
export function resolveSpeechRateCapability(
  provider: TextToSpeechProvider | null | undefined,
): SpeechRateCapability {
  if (!provider) {
    return { supported: false, providerId: null, reason: 'no_provider' };
  }
  const supported = provider.supportsSpeechRate === true;
  return {
    supported,
    providerId: provider.id,
    reason: supported
      ? 'provider_declares_rate_support'
      : 'provider_does_not_declare_rate_support',
  };
}

/** Shown when the device/provider cannot change playback speed. */
export const SPEECH_RATE_UNSUPPORTED_NOTE =
  'Speed control is not available on this playback provider, so the audio plays at its normal speed.';

/** Shown whenever speed control IS used: scope honesty, no WPM claim. */
export const SPEECH_RATE_SCOPE_NOTE =
  'Speed changes playback only — this is not a words-per-minute measure.';

/** Shown when an unsupported request was degraded instead of silently dropped. */
export const SPEECH_RATE_DEGRADED_NOTE =
  'Speed control is unavailable here, so your choice was kept as Normal rather than ignored silently.';

/** The resolved playback plan for one activity or session. */
export interface SpeechRatePlan {
  /** The level actually in effect. */
  readonly level: DeepSpeechRateLevel;
  /** What the learner asked for (may differ from `level` when degraded). */
  readonly requestedLevel: DeepSpeechRateLevel;
  /** The multiplier to pass to `TTSOptions.rate`, or null when not applied. */
  readonly rate: number | null;
  readonly capability: SpeechRateCapability;
  /** Levels the UI may offer (only `natural` when unsupported). */
  readonly levels: readonly DeepSpeechRateLevel[];
  /** Learner-facing explanation of what is (not) happening. */
  readonly note: string;
}

/**
 * Resolve ONE playback plan. Deterministic and pure.
 *
 * Unsupported providers degrade to `natural` and SAY SO — the requested
 * level is never silently presented as applied.
 */
export function planSpeechRate(
  requested: DeepSpeechRateLevel | undefined,
  capability: SpeechRateCapability,
): SpeechRatePlan {
  const requestedLevel = requested ?? 'natural';
  if (!capability.supported) {
    return {
      level: 'natural',
      requestedLevel,
      rate: null,
      capability,
      levels: ['natural'],
      note:
        requestedLevel === 'natural'
          ? SPEECH_RATE_UNSUPPORTED_NOTE
          : SPEECH_RATE_DEGRADED_NOTE,
    };
  }
  return {
    level: requestedLevel,
    requestedLevel,
    rate: SPEECH_RATE_MULTIPLIERS[requestedLevel],
    capability,
    levels: DEEP_SPEECH_RATE_LEVELS,
    note: SPEECH_RATE_SCOPE_NOTE,
  };
}

/** The TTS options for a plan: `rate` only when it is really applied. */
export function speechRateTTSOptions(plan: SpeechRatePlan): { rate?: number } {
  return plan.rate === null ? {} : { rate: plan.rate };
}

/**
 * Local playback state for ONE activity.
 * It exists so replay counting and speed changes are provably evidence-free:
 * nothing here can reach a repository.
 */
export interface DeepPlaybackState {
  readonly speechRate: SpeechRatePlan;
  /** Real audio plays so far (replay practice, never an answer). */
  readonly replayCount: number;
  readonly isPlaying: boolean;
}

export function initialPlaybackState(
  requested: DeepSpeechRateLevel | undefined,
  capability: SpeechRateCapability,
): DeepPlaybackState {
  return { speechRate: planSpeechRate(requested, capability), replayCount: 0, isPlaying: false };
}

/** Audio started: no count yet (a failed play must not count as a replay). */
export function beginPlayback(state: DeepPlaybackState): DeepPlaybackState {
  return { ...state, isPlaying: true };
}

/** Audio really finished: this is the only place a replay is counted. */
export function finishPlayback(state: DeepPlaybackState): DeepPlaybackState {
  return { ...state, isPlaying: false, replayCount: state.replayCount + 1 };
}

/** Playback failed: neither counted nor turned into anything else. */
export function abortPlayback(state: DeepPlaybackState): DeepPlaybackState {
  return { ...state, isPlaying: false };
}

/** Change speed — a playback change only, never a new attempt or answer. */
export function withSpeechRate(
  state: DeepPlaybackState,
  requested: DeepSpeechRateLevel,
  capability: SpeechRateCapability,
): DeepPlaybackState {
  return { ...state, speechRate: planSpeechRate(requested, capability) };
}
