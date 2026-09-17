/**
 * src/talk-demo/turn-controls.ts
 *
 * Learner-facing control rules for one Talk turn.
 *
 * Pure derivation from state that already exists (VoiceStatus + the screen's
 * turn flags): it decides whether the microphone and the text composer are
 * available right now, and whether the microphone is the obvious primary action.
 * It is NOT a second state machine — the coordinator remains the single source
 * of voice truth.
 *
 * Why it lives outside the screen: these rules are the guarantee that a learner
 * turn and an in-flight tutor opening can never be submitted concurrently, so
 * they must be covered by tests without a React Native renderer.
 */

import type { VoiceStatus } from '../voice';

export interface TalkTurnControlInput {
  readonly voiceStatus: VoiceStatus;
  readonly inputText: string;
  /** The tutor's opening turn is being produced (or is about to be). */
  readonly isOpening: boolean;
  /** A learner turn (typed or spoken) is being processed. */
  readonly isSending: boolean;
  /** The coordinator is atomically switching to another conversation session. */
  readonly isSwitching: boolean;
  /** Talk is still resolving the persisted coaching context. */
  readonly isPreparing: boolean;
}

export interface TalkTurnControls {
  readonly micDisabled: boolean;
  readonly sendDisabled: boolean;
  /** True only when the microphone is the obvious next action. */
  readonly microphoneIsPrimary: boolean;
}

export function resolveTalkTurnControls(input: TalkTurnControlInput): TalkTurnControls {
  const voiceStatus = input.voiceStatus;
  const recording = voiceStatus.state === 'recording';

  // The conversation is not ready (resolving persisted context, or switching
  // sessions): no new learner turn may start yet.
  const conversationBusy = input.isPreparing || input.isSwitching;

  // While the tutor produces the opening turn, BOTH learner inputs are blocked:
  // the opening and a learner turn must never mutate the same session at once.
  const openingBlocksInput = input.isOpening;

  const micDisabled =
    conversationBusy ||
    openingBlocksInput ||
    input.isSending ||
    (!voiceStatus.canRecord && !recording);

  const sendDisabled =
    conversationBusy ||
    openingBlocksInput ||
    input.isSending ||
    input.inputText.trim().length === 0 ||
    !voiceStatus.canSendText;

  const microphoneIsPrimary = !micDisabled && !input.isSending && !input.isOpening;

  return { micDisabled, sendDisabled, microphoneIsPrimary };
}
