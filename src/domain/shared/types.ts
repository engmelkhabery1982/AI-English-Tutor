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
}

/** Spaced-repetition scheduling fields (item-level convenience copy). */
export interface ReviewSchedule {
  readonly state: MasteryState;
  readonly lastReviewAt?: IsoDate;
  readonly nextReviewAt?: IsoDate;
  readonly reviewCount: number;
  readonly consecutiveCorrect: number;
  readonly easeFactor?: number; // future SM-style factor
}