/**
 * src/domain/shared/types.ts
 *
 * Implementation-independent shared primitives.
 *
 * These types are intentionally vendor-agnostic. They must NOT import
 * any third-party SDK types (OpenAI, Google, ElevenLabs, etc.).
 */

/** ISO 8601 date string (e.g. "2026-09-14T22:00:00.000Z"). */
export type IsoDate = string;

/** Unique identifier. */
export type Uuid = string;

/** CEFR language proficiency levels. */
export type CefrLevel =
  | 'A1'
  | 'A2'
  | 'B1'
  | 'B2'
  | 'C1'
  | 'C2';

/** A CEFR level that may be unknown for a new learner. */
export type CefrLevelInput = CefrLevel | 'unknown';

/** Conversation mode for the tutor. */
export type ConversationMode =
  | 'natural' // minimal interruption, feedback later
  | 'coach' // correct important mistakes during conversation
  | 'intensive'; // deliberately practice selected weaknesses

/** Speaker of a conversation turn. */
export type SpeakerRole = 'learner' | 'tutor';

/** Gender / voice preference for TTS. */
export type VoiceGender = 'female' | 'male' | 'neutral';

/**
 * Source provenance for a usage example.
 *
 * Deliberately broader than a simple "curated vs AI" split: examples
 * can originate from the learner's own conversation, a lesson, a
 * manual entry, or be curated. This matters because an example is
 * evidence, not decoration.
 */
export type ExampleSource =
  | 'original-conversation'
  | 'ai-generated'
  | 'learner-created'
  | 'curated'
  | 'lesson'
  | 'manual';

/** A single example sentence with optional translation. */
export interface UsageExample {
  readonly text: string;
  readonly translation?: string;
  readonly context?: string; // e.g. "formal email", "spoken casual"
  readonly source: ExampleSource;
  /** Where this example came from, when it came from a conversation. */
  readonly originConversationId?: Uuid;
  readonly originTurnId?: Uuid;
  readonly createdAt?: IsoDate;
}

/**
 * Per-meaning review state.
 *
 * CRITICAL: mastery is tracked PER MEANING, not per lexical item.
 * A word like "run" can have one meaning mastered (to operate a
 * machine) while another is still new (to flee quickly). Marking
 * the whole item mastered because one meaning is known would
 * silently lose that distinction.
 */
export interface MeaningReview {
  readonly state: MasteryState;
  readonly lastReviewAt?: IsoDate;
  readonly nextReviewAt?: IsoDate;
  readonly reviewCount: number;
  readonly consecutiveCorrect: number;
  readonly easeFactor?: number; // future SM-style factor
  readonly masteredAt?: IsoDate; // when THIS meaning was mastered
}

/** A single definition of a word/phrase. */
export interface Meaning {
  readonly definition: string;
  readonly partOfSpeech?:
    | 'noun'
    | 'verb'
    | 'adjective'
    | 'adverb'
    | 'preposition'
    | 'conjunction'
    | 'pronoun'
    | 'interjection'
    | 'phrase'
    | 'other';
  readonly examples: UsageExample[];
  readonly usageNotes?: string[];
  readonly register?: 'formal' | 'informal' | 'neutral' | 'slang' | 'professional';
  readonly domain?: string; // e.g. "business", "academia", "everyday"
  /** Per-meaning review state. Optional for backwards compatibility. */
  readonly review?: MeaningReview;
}

/** Spelling / pronunciation metadata. */
export interface PronunciationMetadata {
  readonly ipa?: string; // International Phonetic Alphabet
  readonly phoneticSpelling?: string; // e.g. "run" -> /rʌn/
  readonly syllableCount?: number;
  readonly stress?: string; // e.g. "first syllable"
  readonly commonMistakes?: string[]; // e.g. "often mispronounced as 'runn'"
}

/** Mastery state for a spaced-repetition item. */
export type MasteryState =
  | 'new' // never reviewed
  | 'learning' // introduced, low confidence
  | 'familiar' // seen multiple times
  | 'mastered' // high confidence, long interval
  | 'struggling' // repeatedly incorrect / weak
  | 'retired'; // no longer actively reviewed

/**
 * Lifecycle status for a persistent learner weakness.
 *
 * A weakness is not a binary flag. It moves through states as
 * evidence accumulates and as the learner trains it. The system
 * must be able to distinguish a one-time slip from a confirmed,
 * trained, improving, mastered, or relapsed weakness.
 *
 * Transitions are NOT automated here. The data model only needs to
 * represent the state. Future learning logic decides transitions.
 */
export type WeaknessStatus =
  | 'observed' // seen once
  | 'repeated' // seen multiple times
  | 'confirmed' // enough evidence to treat as a real weakness
  | 'active_training' // currently being drilled
  | 'improving' // recent performance is better
  | 'stable' // consistently performing at a plateau
  | 'mastered' // no longer a barrier
  | 'relapsed'; // was improving/mastered, has recurred

/**
 * A reference to the evidence behind a classification.
 *
 * Weaknesses must carry enough provenance that a future algorithm
 * (or a human reviewer) can explain WHY the system classified
 * something as a weakness. Do not store only a numeric score.
 */
export interface EvidenceRef {
  readonly kind: 'turn' | 'session' | 'observation' | 'review';
  readonly id: Uuid;
  readonly at: IsoDate;
  readonly summary?: string;
}

/** Source provenance for a vocabulary item. */
export interface VocabularySource {
  readonly originConversationId?: Uuid;
  readonly originTurnId?: Uuid;
  readonly addedBy: 'system' | 'ai-suggested' | 'learner-created';
  readonly addedAt: IsoDate;
  /**
   * Work Order 2 — universal Save to Review provenance.
   *
   * `saveSource` distinguishes A) an item the LEARNER explicitly saved
   * ('manual_learner', "Saved by me") from B) an item detected automatically
   * from practice/weakness evidence ('detected_practice'). The distinction is
   * PERSISTED inside the existing lexical item `source` JSON — it never relies
   * on a tutor-detected mistake, so a correctly-answered item can still be
   * saved manually.
   */
  readonly saveSource?: SaveSource;
  /** Which feature surface the item was saved from (origin of the save). */
  readonly saveOrigin?: SavedItemOrigin;
  /** Provenance reference (conversation id / turn id / exercise id) as text. */
  readonly saveOriginRef?: string;
  /** The sentence/context the learner saved the item from, EXACT source text. */
  readonly contextSentence?: string;
  /**
   * True when any persisted meaning/example/explanation was AI-GENERATED for
   * this save. Generated text is never silently presented as dictionary truth:
   * surfaces must treat this flag as 'generated' provenance.
   */
  readonly containsGeneratedText?: boolean;
}

/** How a lexical item entered review: manual learner save vs detected practice. */
export type SaveSource = 'manual_learner' | 'detected_practice';

/** Feature surfaces a learner can save a language item from (Work Order 2). */
export type SavedItemOrigin =
  | 'talk'
  | 'listening'
  | 'shadowing'
  | 'review_feedback'
  | 'vocabulary'
  | 'assessment'
  | 'adaptive_lesson'
  | 'daily_tutor'
  | 'fluency'
  | 'deep_speaking'
  | 'professional_english';

/**
 * Work Order 2 — correction intensity.
 *
 * The learner-facing preference lives on the ONE existing profile row
 * (`learner_profile.preferences` JSON). It maps onto the EXISTING
 * ConversationMode — there is deliberately no parallel preference system:
 * - 'natural'   ↔ 'natural' (Natural / light)
 * - 'balanced'  ↔ 'coach'   (useful corrections, flow preserved)
 * - 'intensive' ↔ 'intensive'
 * The temporary "fewer corrections for now" override is SESSION-LOCAL: it is
 * never persisted and only affects the current practice session.
 */
export type CorrectionIntensity = 'natural' | 'balanced' | 'intensive';

/** Persisted learner preferences (additive JSON on the profile row). */
export interface LearnerPreferences {
  readonly correctionIntensity?: CorrectionIntensity;
}

/** The supported language-item categories a learner can save (Work Order 2). */
export type VocabularyCategory =
  | 'word'
  | 'phrase'
  | 'phrasal_verb'
  | 'idiom'
  | 'common_expression'
  | 'collocation'
  | 'linking_expression'
  | 'professional_expression'
  /** Work Order 2: a complete sentence the learner wants to keep and review. */
  | 'sentence';


/** Spaced-repetition scheduling fields (item-level convenience copy). */
export interface ReviewSchedule {
  readonly state: MasteryState;
  readonly lastReviewAt?: IsoDate;
  readonly nextReviewAt?: IsoDate;
  readonly reviewCount: number;
  readonly consecutiveCorrect: number;
  readonly easeFactor?: number; // future SM-style factor
}