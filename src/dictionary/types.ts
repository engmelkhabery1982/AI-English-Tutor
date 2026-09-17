/**
 * src/dictionary/types.ts
 *
 * Types and interfaces for the Dictionary & Sense Disambiguation Core.
 *
 * Designed to represent rich lexical entries where a word is NOT reduced to
 * a single flat translation. Every important meaning has its own distinct
 * sense with definition, Arabic meaning, examples, contexts, and registers.
 */

export type DictionaryPartOfSpeech =
  | 'noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'preposition'
  | 'conjunction'
  | 'pronoun'
  | 'interjection'
  | 'phrase'
  | 'phrasal_verb'
  | 'other';

export type DictionaryRegister =
  | 'formal'
  | 'neutral'
  | 'informal'
  | 'slang'
  | 'professional';

/**
 * A natural usage example sentence attached to a specific sense.
 */
export interface DictionarySenseExample {
  readonly id: string;
  readonly english: string;
  readonly arabic: string;
  readonly context?: string;
}

/**
 * An individual meaning/sense of a word.
 * Every meaning must have its own distinct senseId, partOfSpeech,
 * englishDefinition, arabicMeaning, examples, and contexts.
 */
export interface DictionarySense {
  readonly senseId: string;
  readonly partOfSpeech: DictionaryPartOfSpeech;
  /** Short distinction tag (e.g. "operate/manage a business", "move fast on foot"). */
  readonly distinction: string;
  readonly englishDefinition: string;
  readonly arabicMeaning: string;
  readonly examples: readonly DictionarySenseExample[];
  readonly contexts: readonly string[];
  readonly register?: DictionaryRegister;
  readonly collocations?: readonly string[];
  readonly phrasalVerbs?: readonly string[];
  readonly commonMistakes?: readonly string[];
}

/**
 * Pronunciation information when genuinely provided by AI response.
 */
export interface DictionaryPronunciation {
  readonly ipa?: string;
  readonly phoneticSpelling?: string;
}

/**
 * Comprehensive structured dictionary entry for a headword.
 */
export interface DictionaryEntry {
  readonly word: string;
  readonly pronunciation?: DictionaryPronunciation | null;
  readonly primaryPartOfSpeech: DictionaryPartOfSpeech;
  readonly senses: readonly DictionarySense[];
  readonly commonExpressions?: readonly string[];
  readonly collocations?: readonly string[];
  readonly phrasalUses?: readonly string[];
  readonly learnerMistakes?: readonly string[];
  readonly fetchedAt: string;
}

/**
 * Qualitative certainty categories for contextual disambiguation.
 * Never use artificial percentage numbers or fake confidence scores.
 */
export type ContextCertainty =
  | 'clear'
  | 'likely'
  | 'ambiguous'
  | 'insufficient_context';

/**
 * Input to resolve which word sense is used in a specific sentence.
 */
export interface ResolveContextMeaningInput {
  readonly word: string;
  readonly sentence: string;
  readonly knownSenses?: readonly DictionarySense[];
}

/**
 * Secondary candidate when a sentence is genuinely ambiguous.
 */
export interface AlternativeSenseCandidate {
  readonly senseId?: string;
  readonly distinction?: string;
  readonly arabicMeaning: string;
  readonly englishExplanation: string;
  readonly reason: string;
}

/**
 * Result of contextual word disambiguation.
 */
export interface ContextualMeaningResult {
  readonly word: string;
  readonly sentence: string;
  readonly selectedSenseId?: string;
  readonly distinction?: string;
  readonly arabicMeaning: string;
  readonly englishExplanation: string;
  readonly whyFits: string;
  readonly certainty: ContextCertainty;
  readonly alternativeSense?: AlternativeSenseCandidate | null;
}

/**
 * A single multi-sense training exercise item.
 */
export interface SensePracticeItem {
  readonly senseId: string;
  readonly distinction: string;
  readonly partOfSpeech: DictionaryPartOfSpeech;
  readonly arabicMeaning: string;
  readonly englishDefinition: string;
  readonly targetCollocation?: string;
  readonly promptSentence: string;
  readonly sentenceArabicTranslation: string;
  readonly comprehensionQuestion: string;
  readonly correctChoice: string;
  readonly distractorChoices: readonly string[];
  readonly explanation: string;
}

/**
 * Multi-sense training plan covering all meaningful senses of a word.
 */
export interface MultiSenseTrainingPlan {
  readonly word: string;
  readonly senseCount: number;
  readonly items: readonly SensePracticeItem[];
}

/**
 * Learning integration candidates ready for future UI to save into
 * VocabularyWorkspace or Review/Deep Speaking without auto-persisting here.
 */
export interface SaveWordCandidate {
  readonly headword: string;
  readonly type: 'word' | 'phrase';
  readonly meanings: readonly {
    readonly definition: string;
    readonly partOfSpeech?: string;
    readonly arabicMeaning: string;
    readonly examples: readonly {
      readonly text: string;
      readonly translation?: string;
      readonly context?: string;
    }[];
  }[];
  readonly pronunciation?: {
    readonly ipa?: string;
  };
  readonly tags?: readonly string[];
}

export interface SaveSenseCandidate {
  readonly headword: string;
  readonly senseId: string;
  readonly distinction: string;
  readonly definition: string;
  readonly arabicMeaning: string;
  readonly partOfSpeech?: string;
  readonly examples: readonly {
    readonly text: string;
    readonly translation?: string;
    readonly context?: string;
  }[];
}

export interface SaveExpressionCandidate {
  readonly expression: string;
  readonly type: 'collocation' | 'idiom' | 'phrasal_verb' | 'common_expression';
  readonly meaning: string;
  readonly arabicMeaning: string;
  readonly exampleSentence?: string;
}

export interface DictionaryLearningCandidates {
  readonly wordCandidate: SaveWordCandidate;
  readonly senseCandidates: readonly SaveSenseCandidate[];
  readonly expressionCandidates: readonly SaveExpressionCandidate[];
  readonly reviewAction: {
    readonly suggestedItem: string;
    readonly targetType: 'vocabulary' | 'expression';
    readonly prompt: string;
  };
  readonly speakingPracticeAction: {
    readonly topic: string;
    readonly prompt: string;
    readonly targetSenses: readonly string[];
  };
}

/**
 * Explicit outcome for dictionary lookup.
 */
export type DictionaryLookupResult =
  | {
      readonly ok: true;
      readonly entry: DictionaryEntry;
    }
  | {
      readonly ok: false;
      readonly word: string;
      readonly error: {
        readonly code: 'word_not_found' | 'invalid_response' | 'ai_unavailable' | 'unknown';
        readonly message: string;
      };
    };
