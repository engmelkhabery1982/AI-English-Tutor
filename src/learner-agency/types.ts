/**
 * src/learner-agency/types.ts
 *
 * Work Order 2 — learner agency contracts.
 *
 * Provider-neutral, reusable types for the learner-assistance layer:
 * conversation help actions (I don't know / hint / example / explain /
 * repeat / slower / skip / change topic), correction intensity preference,
 * Save to Review provenance, and assessment response coaching.
 *
 * This module imports ONLY shared domain primitives (and the provider-neutral
 * feedback vocabulary category). It never imports React, repositories or AI
 * provider SDKs, so the interaction CONTRACT below can be re-skinned by a
 * future visual layer without changing any logic.
 */

import type {
  CorrectionIntensity,
  IsoDate,
  SaveSource,
  SavedItemOrigin,
  Uuid,
  VocabularyCategory,
} from '../domain/shared/types';

/* Re-exported so feature surfaces import the whole agency contract from one
 * place; the CANONICAL definitions live in the domain layer. */
export type { CorrectionIntensity, SaveSource, SavedItemOrigin, VocabularyCategory };

/* ------------------------------------------------------------------ *
 * 1. Correction intensity (maps onto the EXISTING ConversationMode)
 * ------------------------------------------------------------------ */

/** The mode the existing ConversationMode already persists as 'coach' is
 *  learner-facing 'Balanced'; 'natural' is 'Natural / light'. */
export const CORRECTION_INTENSITY_TO_MODE: Readonly<
  Record<CorrectionIntensity, 'natural' | 'coach' | 'intensive'>
> = {
  natural: 'natural',
  balanced: 'coach',
  intensive: 'intensive',
} as const;

/** Inverse mapping (persisted/legacy ConversationMode → intensity label). */
export const MODE_TO_CORRECTION_INTENSITY: Readonly<
  Record<'natural' | 'coach' | 'intensive', CorrectionIntensity>
> = {
  natural: 'natural',
  coach: 'balanced',
  intensive: 'intensive',
} as const;

/** The temporary override id — NEVER persisted, only session-local. */
export const TEMPORARY_FEWER_CORRECTIONS = 'fewer_now' as const;
export type TemporaryCorrectionOverride = typeof TEMPORARY_FEWER_CORRECTIONS;

export const CORRECTION_INTENSITY_OPTIONS: readonly {
  readonly key: CorrectionIntensity;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    key: 'natural',
    label: 'Natural / light',
    description: 'Keep the conversation flowing. Correct only important mistakes.',
  },
  {
    key: 'balanced',
    label: 'Balanced',
    description: 'Correct what is useful without dominating the conversation.',
  },
  {
    key: 'intensive',
    label: 'Intensive',
    description: 'Correct more often, including smaller phrasing issues.',
  },
] as const;

/** Default for a profile that has never chosen. */
export const DEFAULT_CORRECTION_INTENSITY: CorrectionIntensity = 'balanced';

/** Runtime guard for stored/passed values (never trust a stored string). */
export function isCorrectionIntensity(value: unknown): value is CorrectionIntensity {
  return value === 'natural' || value === 'balanced' || value === 'intensive';
}

/**
 * The effective ConversationMode for one turn: the temporary "fewer
 * corrections for now" override wins for the current practice session and is
 * mapped to the EXISTING light-correction mode. Nothing is persisted here.
 */
export function resolveEffectiveConversationMode(
  intensity: CorrectionIntensity,
  temporary: TemporaryCorrectionOverride | null,
): 'natural' | 'coach' | 'intensive' {
  if (temporary === TEMPORARY_FEWER_CORRECTIONS) return 'natural';
  return CORRECTION_INTENSITY_TO_MODE[intensity];
}

/* ------------------------------------------------------------------ *
 * 2. Conversation help actions
 * ------------------------------------------------------------------ */

/** Identifiers for the reusable learner-assistance actions. */
export type HelpActionId =
  | 'dont_know'
  | 'hint'
  | 'example'
  | 'explain'
  | 'repeat'
  | 'slower'
  | 'skip'
  | 'change_topic';

/** Every help action, in stable UI order. */
export const HELP_ACTION_IDS: readonly HelpActionId[] = [
  'dont_know',
  'hint',
  'example',
  'explain',
  'repeat',
  'slower',
  'skip',
  'change_topic',
] as const;

/**
 * The four provider-backed actions: they ask the REAL tutor for scaffolding
 * through the existing engine/provider path. The rest are local.
 */
export const PROVIDER_HELP_ACTIONS: readonly HelpActionId[] = [
  'dont_know',
  'hint',
  'example',
  'explain',
  'skip',
] as const;

export function isProviderHelpAction(id: HelpActionId): boolean {
  return PROVIDER_HELP_ACTIONS.includes(id);
}

export interface HelpActionDescriptor {
  readonly id: HelpActionId;
  readonly label: string;
  readonly accessibilityLabel: string;
  /** Local (no provider call needed) vs provider-backed. */
  readonly kind: 'provider' | 'playback' | 'local';
}

export const HELP_ACTION_DESCRIPTORS: readonly HelpActionDescriptor[] = [
  {
    id: 'dont_know',
    label: "I don't know",
    accessibilityLabel: 'Say you do not know. The tutor will give a clue and continue.',
    kind: 'provider',
  },
  {
    id: 'hint',
    label: 'Hint',
    accessibilityLabel: 'Ask for a short hint without giving the answer',
    kind: 'provider',
  },
  {
    id: 'example',
    label: 'Example',
    accessibilityLabel: 'See one example answer. It is never counted as your reply.',
    kind: 'provider',
  },
  {
    id: 'explain',
    label: 'Explain',
    accessibilityLabel: 'Ask the tutor to explain the meaning or grammar here',
    kind: 'provider',
  },
  {
    id: 'repeat',
    label: 'Repeat',
    accessibilityLabel: 'Play the tutor message again',
    kind: 'playback',
  },
  {
    id: 'slower',
    label: 'Slower',
    accessibilityLabel: 'Play the tutor message again more slowly',
    kind: 'playback',
  },
  {
    id: 'skip',
    label: 'Skip',
    accessibilityLabel: 'Skip this question. Nothing is marked right or wrong.',
    kind: 'provider',
  },
  {
    id: 'change_topic',
    label: 'Change topic',
    accessibilityLabel: 'Change the conversation topic explicitly',
    kind: 'local',
  },
] as const;

/**
 * EVIDENCE SAFETY — the single rule every help action obeys:
 * no help action ever submits a learner answer, ever counts a learner turn,
 * ever creates learner evidence, and ever marks anything complete.
 * `HELP_ACTION_IS_EVIDENCE_SAFE` is asserted by tests for EVERY action id so a
 * future action cannot be added without declaring its evidence posture.
 */
export function helpActionIsEvidenceSafe(id: HelpActionId): boolean {
  switch (id) {
    case 'dont_know':
    case 'hint':
    case 'example':
    case 'explain':
    case 'skip':
      // Tutor-only replies: committed to the conversation as TUTOR turns, never
      // as learner turns, and feedback/weakness persistence is never reached.
      return true;
    case 'repeat':
    case 'slower':
      // Pure playback through the existing voice path: creates no attempt.
      return true;
    case 'change_topic':
      // Opens the explicit topic draft; the session switch stays the existing
      // single atomic path. No result is fabricated.
      return true;
    default:
      return false;
  }
}

/**
 * Instructions sent to the EXISTING engine/provider for one help action.
 *
 * Each is written so the tutor's reply (a) scaffolds without submitting an
 * answer for the learner and (b) is safe to commit as a TUTOR-only turn.
 */
export const HELP_ACTION_PROMPT_INSTRUCTIONS: Readonly<Record<HelpActionId, string>> = {
  dont_know:
    'The learner used their "I don\'t know" option for your last question. This is NOT a wrong answer and must not be treated as one: do not mark it correct or incorrect, and do not record any weakness from it. Scaffold gently: give one small clue or a simpler either/or version of the question, then ask that ONE question again so the learner can try.',
  hint:
    'The learner asked for a hint for your last question. Give ONE short hint (maximum two sentences) that narrows the possible answers WITHOUT answering for them. Do not record this as their answer. End by inviting their attempt.',
  example:
    'The learner asked to see an example answer for your last question. Provide exactly ONE short example answer a learner at their level could give, starting with "For example,". State clearly that this is an example from the tutor, not the learner\'s own answer. Then invite the learner to try their own version.',
  explain:
    'The learner asked you to explain something from the current exchange. In at most three short sentences, explain the meaning, intent, or grammar of the relevant phrase in plain words a learner at their level can follow. Do not ask a new topic question; finish by asking them to try again with this in mind.',
  repeat:
    'The learner asked you to repeat. Restate your last message (same meaning, natural phrasing) and keep it short.',
  slower:
    'The learner asked for slower, clearer speech. Restate your last message in two very short, simple sentences.',
  skip:
    'The learner asked to skip this question. Acknowledge in ONE short sentence that skipping is fine (it is neither correct nor wrong), then ask ONE different natural question on the same topic.',
  change_topic:
    'The learner wants to change topic. Acknowledge briefly and open a fresh everyday topic with ONE short question.',
};

/**
 * The hidden instruction turn is prepended with this marker so it is
 * identifiable in code paths that must exclude it. It is never shown.
 */
export const ASSISTANCE_INSTRUCTION_PREFIX = '[LEARNER_HELP_REQUEST]' as const;

/**
 * Builds the non-committed instruction text for one provider help action.
 * Pure + deterministic: the learner's own typed message is never involved.
 */
export function buildHelpInstruction(action: HelpActionId, topic: string | null): string {
  const base = HELP_ACTION_PROMPT_INSTRUCTIONS[action];
  const topicLine = topic && topic.trim().length > 0
    ? ` Stay inside the current topic "${topic.trim()}".`
    : '';
  return `${ASSISTANCE_INSTRUCTION_PREFIX}${base}${topicLine}`;
}

/* ------------------------------------------------------------------ *
 * 3. Help request lifecycle control (pure; used by Talk and later surfaces)
 * ------------------------------------------------------------------ */

export interface HelpControlInput {
  /** A provider-backed help request is already in flight. */
  readonly helpInFlight: boolean;
  /** A learner/tutor conversation turn is in flight. */
  readonly turnInFlight: boolean;
  /** The conversation is being switched/replaced. */
  readonly isSwitching: boolean;
  /** A real or explicitly-demo provider can answer. */
  readonly providerAvailable: boolean;
  /** There is something spoken/typed to repeat or slow down. */
  readonly hasLastTutorText: boolean;
  /** The session is live (an abandoned/closed session cannot host help). */
  readonly sessionActive: boolean;
}

export interface HelpControls {
  /** Provider-backed actions enabled. */
  readonly providerActionsEnabled: boolean;
  /** Repeat/slower playback enabled. */
  readonly playbackEnabled: boolean;
  /** Skip enabled (a provider action that needs a live session). */
  readonly skipEnabled: boolean;
  /** Change topic enabled — available even without a provider. */
  readonly changeTopicEnabled: boolean;
}

/**
 * One place decides when help actions may run — mirroring the Work Order 1
 * turn-control rules: a help request and a learner turn can NEVER be in flight
 * at the same time, repeated taps cannot stack, and playback always remains
 * available whenever there is a message to replay.
 */
export function resolveHelpControls(input: HelpControlInput): HelpControls {
  const busy = input.helpInFlight || input.turnInFlight || input.isSwitching;
  const providerActionsEnabled =
    input.providerAvailable && input.sessionActive && !busy;
  return {
    providerActionsEnabled,
    playbackEnabled: input.hasLastTutorText && !input.turnInFlight && !input.isSwitching,
    skipEnabled: providerActionsEnabled,
    // Changing topic only opens the explicit draft UI; safe without a provider.
    changeTopicEnabled: !input.isSwitching && !input.turnInFlight && !input.helpInFlight,
  };
}

/* ------------------------------------------------------------------ *
 * 4. Save to Review — generic language-item contract
 * ------------------------------------------------------------------ */

/** One request to save a language item for review (generic across surfaces). */
export interface SaveLanguageItemInput {
  readonly learnerId: Uuid;
  /** The EXACT source text the learner wants to keep. Preserved verbatim. */
  readonly text: string;
  readonly itemType: VocabularyCategory;
  /** The sentence/context this item came from (where available). */
  readonly contextSentence?: string;
  /** Learner-selected meaning, or tutor-provided meaning (marked generated). */
  readonly selectedMeaning?: string;
  readonly explanation?: string;
  readonly example?: string;
  readonly usageNote?: string;
  /** Origin feature (which surface saved it). */
  readonly origin: SavedItemOrigin;
  /** Optional provenance reference (conversation/exercise id). */
  readonly originRef?: string;
  /** Default 'manual_learner' — the learner pressing Save IS a manual save. */
  readonly source?: SaveSource;
  /**
   * True when selectedMeaning/example/explanation came from the AI tutor for
   * THIS save. Generated text is persisted with this marker so it can never be
   * presented as authoritative dictionary truth.
   */
  readonly meaningIsGenerated?: boolean;
}

/** Deterministic outcome of a save attempt. */
export type SaveLanguageItemResult =
  | {
      readonly ok: true;
      readonly id: Uuid;
      /** Deterministic duplicate handling: no second row is ever created. */
      readonly duplicate: boolean;
      readonly reason: 'created' | 'already_saved';
      /** The learner-facing review queue state: never altered by saving. */
      readonly reviewQueued: boolean;
    }
  | { readonly ok: false; readonly reason: 'invalid_input' | 'no_profile' | 'persistence_failed' };

/** Review prompt built for a saved item (deterministic, no AI). */
export function savedItemReviewPrompt(text: string, meaning: string | null): string {
  const shown = (meaning ?? '').trim().length > 0 ? meaning!.trim() : text.trim();
  return `Remember what "${text.trim()}" means and use it: ${shown}`;
}

/* ------------------------------------------------------------------ *
 * 5. Assessment response coaching (presentation layer only)
 * ------------------------------------------------------------------ */

/** Communicated BEFORE the assessment starts. */
export const ASSESSMENT_PRE_GUIDANCE =
  'This check works best with real answers: for each question, answer in 2–3 sentences and give an example when you can. One-word answers do not give enough evidence, and no level will be invented from them.';

/** Shown with speaking prompts during assessment. */
export const ASSESSMENT_SPEAKING_GUIDANCE =
  'Answer in 2–3 sentences and give an example.';

/** Shown when an answer is too short to carry enough evidence. */
export const SHORT_ANSWER_NUDGES: readonly string[] = [
  'Tell me a little more.',
  'Can you give an example?',
  'Why do you think that?',
  'What happened next?',
] as const;

/** Learner-facing label when they still choose to finish with short answers. */
export const ANSWER_ANYWAY_LABEL = 'Continue anyway' as const;

/** Minimum word count for an answer to count as substantive guidance. */
export const MIN_ASSESSMENT_ANSWER_WORDS = 8;

/**
 * Returns a nudge when an answer is too short to contribute much evidence, or
 * null when it looks substantive. Pure + deterministic. This NEVER gates the
 * assessment state machine and NEVER changes any evidence threshold: it only
 * prompts for expansion before completion is allowed.
 */
export function assessAnswerSubstance(text: string): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return SHORT_ANSWER_NUDGES[0];
  const words = trimmed.split(/[\s]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return SHORT_ANSWER_NUDGES[0];
  if (words.length < MIN_ASSESSMENT_ANSWER_WORDS) {
    // Deterministic rotation so repeated short answers vary the nudge.
    return SHORT_ANSWER_NUDGES[words.length % SHORT_ANSWER_NUDGES.length];
  }
  return null;
}

/**
 * A save provenance line used by list surfaces (structured, not visual):
 * lets a later design show "Saved by me" vs "Detected from practice" without
 * any persistence rewrite.
 */
export function describeSaveSource(source: SaveSource | undefined): {
  readonly key: 'saved_by_me' | 'detected_from_practice';
  readonly label: string;
} {
  if (source === 'manual_learner') {
    return { key: 'saved_by_me', label: 'Saved by me' };
  }
  return { key: 'detected_from_practice', label: 'Detected from practice' };
}

/** Timestamped save marker stored inside the existing source JSON. */
export interface SavedItemMarker {
  readonly saveSource: SaveSource;
  readonly saveOrigin: SavedItemOrigin;
  readonly saveOriginRef?: string;
  readonly contextSentence?: string;
  readonly containsGeneratedText?: boolean;
  readonly createdAt: IsoDate;
}
