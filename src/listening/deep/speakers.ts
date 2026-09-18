/**
 * src/listening/deep/speakers.ts
 *
 * WP-2 — MULTIPLE SPEAKERS, honestly.
 *
 * The activity shape carries REAL speaker structure (speaker ids, labels and
 * per-segment attribution). The AUDIO side is a separate question, and this
 * module answers it honestly:
 *
 * - A provider may declare `supportedVoices` (2+ real synthesized voices).
 *   Nothing in the EXISTING voice stack declares that today, so the default
 *   is ONE VOICE.
 * - With one voice, speaker identity is preserved STRUCTURALLY: each speaker
 *   turn is introduced by name ("Maya says: …") so the learner can still tell
 *   who is speaking — and the UI says plainly that a single voice reads all
 *   speakers. Distinct real voices are never claimed.
 */

import type { TextToSpeechProvider } from '../../providers/tts/types';
import type { DiscourseListeningActivity, DiscourseSegment } from './types';
import { isMultiSpeakerActivity, speakingSpeakerIds } from './types';

/** What the playback layer can really do about distinct speakers. */
export interface SpeakerVoiceCapability {
  readonly distinctVoices: boolean;
  readonly voiceCount: number;
  readonly reason: 'provider_declares_multiple_voices' | 'single_voice_provider' | 'no_provider';
}

/** Resolve the voice capability from the EXISTING provider (never assumed). */
export function resolveSpeakerVoiceCapability(
  provider: TextToSpeechProvider | null | undefined,
): SpeakerVoiceCapability {
  const voices = provider?.supportedVoices;
  if (Array.isArray(voices) && voices.length >= 2) {
    return {
      distinctVoices: true,
      voiceCount: voices.length,
      reason: 'provider_declares_multiple_voices',
    };
  }
  return {
    distinctVoices: false,
    voiceCount: provider ? 1 : 0,
    reason: provider ? 'single_voice_provider' : 'no_provider',
  };
}

/** One speaker's consecutive turns (consecutive segments, grouped). */
export interface SpeakerTurn {
  readonly speakerId: string;
  readonly label: string;
  readonly segmentIds: readonly string[];
  readonly text: string;
}

/** Group consecutive segments by speaker — deterministic, content-order. */
export function speakerTurns(
  activity: DiscourseListeningActivity,
): readonly SpeakerTurn[] {
  const labelFor = (speakerId: string): string =>
    activity.speakers.find((speaker) => speaker.id === speakerId)?.label ?? 'Speaker';

  const turns: SpeakerTurn[] = [];
  for (const segment of activity.segments) {
    const last = turns[turns.length - 1];
    if (last && last.speakerId === segment.speakerId) {
      turns[turns.length - 1] = {
        ...last,
        segmentIds: [...last.segmentIds, segment.id],
        text: `${last.text} ${segment.text.trim()}`.trim(),
      };
      continue;
    }
    turns.push({
      speakerId: segment.speakerId,
      label: labelFor(segment.speakerId),
      segmentIds: [segment.id],
      text: segment.text.trim(),
    });
  }
  return turns;
}

/** How speaker identity is preserved in the audio. */
export type SpeakerAttribution = 'distinct_voices' | 'single_voice_text_cues';

/** The text handed to the EXISTING TTS, plus how identity is preserved. */
export interface SpokenScript {
  readonly text: string;
  readonly attribution: SpeakerAttribution;
  /** How many speaker cues were really inserted (0 for single-speaker work). */
  readonly speakerCueCount: number;
}

/**
 * Build the spoken script for a discourse activity.
 *
 * - one speaker → the plain passage (no cues needed);
 * - several speakers + real distinct voices → the plain passage;
 * - several speakers + ONE voice → each turn is prefixed with "Label says:"
 *   so attribution is never lost, and the cue count is reported.
 */
export function buildSpokenScript(
  activity: DiscourseListeningActivity,
  capability: SpeakerVoiceCapability,
): SpokenScript {
  const plain = activity.segments.map((segment: DiscourseSegment) => segment.text.trim()).join(' ').trim();
  if (!isMultiSpeakerActivity(activity)) {
    return { text: plain, attribution: 'single_voice_text_cues', speakerCueCount: 0 };
  }
  if (capability.distinctVoices) {
    return { text: plain, attribution: 'distinct_voices', speakerCueCount: 0 };
  }
  const turns = speakerTurns(activity);
  return {
    text: turns.map((turn) => `${turn.label} says: ${turn.text}`).join(' ').trim(),
    attribution: 'single_voice_text_cues',
    speakerCueCount: turns.length,
  };
}

/** Shown to the learner for real multi-speaker material. */
export const SINGLE_VOICE_HONESTY_NOTE =
  'One synthesized voice reads every speaker here. The names and the pauses tell you who is speaking — this is not two real voices.';

/** The honest note for this activity, or null when it does not apply. */
export function speakerHonestyNote(
  activity: DiscourseListeningActivity,
  capability: SpeakerVoiceCapability,
): string | null {
  if (!isMultiSpeakerActivity(activity)) return null;
  return capability.distinctVoices
    ? null
    : SINGLE_VOICE_HONESTY_NOTE;
}

/** Learner-facing speaker summary, e.g. "Maya, Tom" (bounded). */
export function speakerSummary(activity: DiscourseListeningActivity): string {
  const ids = speakingSpeakerIds(activity);
  const labels = activity.speakers
    .filter((speaker) => ids.includes(speaker.id))
    .map((speaker) => speaker.label);
  return labels.join(', ');
}
