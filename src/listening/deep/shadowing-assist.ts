/**
 * src/listening/deep/shadowing-assist.ts
 *
 * Work Order 2 — learner-controlled Shadowing assistance state.
 *
 * The required flow: Listen → Repeat → (reveal transcript if needed) →
 * understand meaning → replay → slower where supported → shadow again →
 * feedback. The AUTOMATIC support progression in `./shadowing` stays exactly
 * as it is; everything here only ADDS learner-controlled presentation on top:
 *
 * - revealing the transcript is learner assistance, never a failed attempt;
 * - reading the meaning creates no performance evidence;
 * - replaying and changing speed create no performance evidence;
 * - none of this can mark an attempt complete or touch ShadowingSession state.
 *
 * The state is a pure reducer module: the panel owns one per activity, and a
 * later visual redesign can re-skin these transitions without changing rules.
 */

import type { ShadowingSession } from './shadowing';

export type ShadowingMeaningStatus =
  | 'idle' // not requested yet
  | 'loading' // provider-backed explanation in flight
  | 'ready' // an explanation is available (curated or generated)
  | 'failed'; // generation failed; retry is safe

export interface ShadowingAssistState {
  /** True while the learner manually reads the full chunk text. */
  readonly transcriptRevealed: boolean;
  /** True while the meaning card is open. */
  readonly meaningVisible: boolean;
  readonly meaningStatus: ShadowingMeaningStatus;
  /** Explanation text: curated activity explanation or generated help. */
  readonly meaningText: string | null;
  /** Honest note when the meaning source is AI-generated. */
  readonly meaningIsGenerated: boolean;
  /** Friendly, already-classified error sentence when generation failed. */
  readonly meaningError: string | null;
  /** Number of assist uses in this activity — presentation only. */
  readonly assistUses: number;
  /** Learner-facing note after a failed meaning generation + retry option. */
  readonly canRetryMeaning: boolean;
}

export function initialShadowingAssistState(): ShadowingAssistState {
  return {
    transcriptRevealed: false,
    meaningVisible: false,
    meaningStatus: 'idle',
    meaningText: null,
    meaningIsGenerated: false,
    meaningError: null,
    assistUses: 0,
    canRetryMeaning: false,
  };
}

/* ------------------------------------------------------------------ *
 * Transcript reveal — learner assistance, NOT an attempt
 * ------------------------------------------------------------------ */

export function revealTranscript(state: ShadowingAssistState): ShadowingAssistState {
  if (state.transcriptRevealed) return state;
  return { ...state, transcriptRevealed: true, assistUses: state.assistUses + 1 };
}

export function hideTranscript(state: ShadowingAssistState): ShadowingAssistState {
  if (!state.transcriptRevealed) return state;
  return { ...state, transcriptRevealed: false };
}

export function toggleTranscript(state: ShadowingAssistState): ShadowingAssistState {
  return state.transcriptRevealed ? hideTranscript(state) : revealTranscript(state);
}

/**
 * What the learner may currently READ. The manual reveal SUPPLEMENTS the
 * automatic support progression: the session's automatic visibility keeps
 * evolving exactly as before, while an open manual reveal simply shows the
 * full chunk for as long as the learner keeps it open.
 */
export function readableChunkFor(
  session: Pick<ShadowingSession, 'visibleChunk' | 'chunk'>,
  state: ShadowingAssistState,
): string | null {
  if (state.transcriptRevealed) return session.chunk;
  return session.visibleChunk;
}

/* ------------------------------------------------------------------ *
 * Meaning / explanation
 * ------------------------------------------------------------------ */

export function openMeaning(state: ShadowingAssistState): ShadowingAssistState {
  if (state.meaningVisible) return state;
  return { ...state, meaningVisible: true, assistUses: state.assistUses + 1 };
}

export function closeMeaning(state: ShadowingAssistState): ShadowingAssistState {
  if (!state.meaningVisible) return state;
  return { ...state, meaningVisible: false };
}

/** The curated explanation on the activity is authoritative when present. */
export function curatedMeaning(activity: { explanation?: string; canonicalWrittenForm?: string } | null): string | null {
  const explanation = (activity?.explanation ?? '').trim();
  if (explanation.length > 0) return explanation;
  return null;
}

export function beginMeaningRequest(state: ShadowingAssistState): ShadowingAssistState {
  return {
    ...state,
    meaningVisible: true,
    meaningStatus: 'loading',
    meaningError: null,
    canRetryMeaning: false,
  };
}

export function meaningLoaded(state: ShadowingAssistState, text: string, generated: boolean): ShadowingAssistState {
  return {
    ...state,
    meaningStatus: 'ready',
    meaningText: text,
    meaningIsGenerated: generated,
    meaningError: null,
    canRetryMeaning: false,
  };
}

export function meaningFailed(state: ShadowingAssistState, friendlyError: string | null): ShadowingAssistState {
  return {
    ...state,
    meaningStatus: 'failed',
    meaningError: friendlyError ?? 'The tutor could not explain this right now.',
    // A failure must NEVER clear what the learner already has: previous text
    // stays visible while the retry affordance appears.
    canRetryMeaning: true,
  };
}

/**
 * Stale-guard helper: when the activity changed (index/token moved) while a
 * meaning request was in flight, the panel discards the result and the state
 * is reset for the NEW activity — never written onto the old one.
 */
export function resetAssistForActivity(next: ShadowingAssistState | null = null): ShadowingAssistState {
  return next ?? initialShadowingAssistState();
}

/* ------------------------------------------------------------------ *
 * Replay / speed — playback, never performance
 * ------------------------------------------------------------------ */


