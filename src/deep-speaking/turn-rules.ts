/**
 * src/deep-speaking/turn-rules.ts
 *
 * The ONE place that decides whether the learner currently has work in flight,
 * and therefore whether "Finish practice" may run.
 *
 * WHY THIS IS NOT INSIDE THE SCREEN
 * Finishing must never destroy an in-flight learner turn and must never turn an
 * unfinished recording into learner evidence. Those rules are the reason this
 * module exists, so they must be covered by tests without a React Native
 * renderer — exactly like `resolveTalkTurnControls` in talk-demo.
 *
 * SEMANTICS
 * - A learner operation is "active" while: the screen is submitting a turn, the
 *   tutor opening is running, the service still owns an in-flight learner turn,
 *   the microphone is being requested / recording / transcribing, the AI turn is
 *   sending, or any voice work is still processing.
 * - Tutor playback (`speaking`) is NOT a learner operation: stopping playback is
 *   non-destructive and never loses learner work.
 * - When an operation is active, finishing is REFUSED synchronously — the
 *   operation is settled by its own path (the learner's answer is committed or
 *   reported as failed), never abandoned behind their back.
 */

import type { VoiceState } from '../voice';

/** Voice states in which the learner's own speech work has not settled yet. */
const ACTIVE_VOICE_STATES: readonly VoiceState[] = [
  'requesting_permission',
  'recording',
  'transcribing',
  'sending',
];

export interface SpeakingTurnLivenessInput {
  readonly voiceState: VoiceState;
  /** The coordinator reports an async voice operation in flight. */
  readonly isVoiceProcessing?: boolean;
  /** A learner turn (typed or spoken) is being submitted by the screen. */
  readonly isSubmitting: boolean;
  /** The tutor opening is running: a learner turn could follow it immediately. */
  readonly isOpening: boolean;
  /** The screen's synchronous single-flight guard. */
  readonly isTurnInFlight: boolean;
  /** The service's own view of its in-flight learner turn. */
  readonly isServiceTurnActive: boolean;
}

/** True while any learner operation is still in flight. */
export function isLearnerOperationActive(input: SpeakingTurnLivenessInput): boolean {
  if (
    input.isSubmitting ||
    input.isOpening ||
    input.isTurnInFlight ||
    input.isServiceTurnActive
  ) {
    return true;
  }
  if (input.isVoiceProcessing === true) return true;
  return ACTIVE_VOICE_STATES.includes(input.voiceState);
}

export interface FinishAvailability {
  readonly allowed: boolean;
  /** Honest reason finishing is unavailable right now (null when allowed). */
  readonly reason: string | null;
}

/** Learner-facing explanation used while finishing is refused. */
export const FINISH_BLOCKED_MESSAGE =
  'Your turn is still in progress, so it is not counted yet. Finish once it settles — nothing will be lost.';

/**
 * Resolve whether finishing may start right now. Refusing is not an error: the
 * operation in flight simply owns the conversation until it settles.
 */
export function resolveFinishAvailability(
  input: SpeakingTurnLivenessInput,
): FinishAvailability {
  return isLearnerOperationActive(input)
    ? { allowed: false, reason: FINISH_BLOCKED_MESSAGE }
    : { allowed: true, reason: null };
}
