/**
 * src/translation/types.ts
 *
 * Types and interfaces for the Translation Core & Document/Long-Text Foundation.
 * Supports bidirectional English <-> Arabic translation with pedagogical notes,
 * non-persisted learning candidates, deterministic chunking, and block-based
 * document translation.
 */

export type TranslationDirection = 'en-to-ar' | 'ar-to-en';

export type TranslationStyle = 'natural' | 'literal' | 'professional';

export type ArabicVariety = 'msa' | 'egyptian';

/**
 * Options for configuring translation behavior.
 */
export interface TranslationOptions {
  readonly direction?: TranslationDirection;
  /** Translation style (default: 'natural'). */
  readonly style?: TranslationStyle;
  /** Arabic dialect / variety (default: 'msa'). */
  readonly arabicVariety?: ArabicVariety;
  /** Whether to request a literal breakdown when helpful (default: true). */
  readonly includeLiteralIfUseful?: boolean;
  /** Whether to extract non-persisted learning candidates (default: true). */
  readonly extractLearningCandidates?: boolean;
}

/**
 * Pedagogical learning candidate items extracted from English text.
 * Never auto-persisted; returned purely for UI presentation and user selection.
 */
export interface TranslationVocabularyCandidate {
  readonly headword: string;
  readonly partOfSpeech?: string;
  readonly contextMeaning: string;
  readonly arabicMeaning: string;
}

export interface TranslationExpressionCandidate {
  readonly expression: string;
  readonly meaning: string;
  readonly arabicMeaning: string;
}

export interface TranslationCollocationCandidate {
  readonly collocation: string;
  readonly usageNote: string;
}

export interface TranslationPhrasalVerbCandidate {
  readonly phrasalVerb: string;
  readonly meaning: string;
  readonly exampleInText: string;
}

export interface TranslationLearningCandidates {
  readonly vocabulary: readonly TranslationVocabularyCandidate[];
  readonly expressions: readonly TranslationExpressionCandidate[];
  readonly collocations: readonly TranslationCollocationCandidate[];
  readonly phrasalVerbs: readonly TranslationPhrasalVerbCandidate[];
}

/**
 * Successful translation result for a segment of text.
 */
export interface TranslationSuccess {
  readonly originalText: string;
  readonly translatedText: string;
  readonly direction: TranslationDirection;
  readonly style: TranslationStyle;
  readonly arabicVariety: ArabicVariety;
  /** Literal translation provided ONLY when genuinely useful (e.g. for idioms). */
  readonly literalTranslation?: string | null;
  /** Alternative phrasing when genuinely distinct natural translations exist. */
  readonly alternatives: readonly string[];
  /** Pedagogical or cultural explanation when useful. */
  readonly explanation?: string | null;
  /** Specific learning or grammar notes. */
  readonly learningNotes: readonly string[];
  /** Non-persisted learning candidates extracted from the text. */
  readonly learningCandidates: TranslationLearningCandidates;
}

/**
 * Error descriptor for translation failures.
 * Preserves the original uncorrupted source text.
 */
export interface TranslationError {
  readonly code: 'ai_unavailable' | 'invalid_response' | 'empty_input' | 'timeout' | 'unknown';
  readonly message: string;
}

/**
 * Discriminated union outcome for text translation.
 */
export type TranslationResult =
  | {
      readonly ok: true;
      readonly data: TranslationSuccess;
    }
  | {
      readonly ok: false;
      /** Preserves original source text unmodified on failure. */
      readonly originalText: string;
      readonly error: TranslationError;
    };

/**
 * Deterministic text chunk for long-text translation.
 */
export interface TextChunk {
  readonly chunkId: string;
  readonly index: number;
  readonly text: string;
  readonly characterCount: number;
}

/**
 * Translated counterpart of a single text chunk.
 */
export interface TranslatedTextChunk {
  readonly chunkId: string;
  readonly index: number;
  readonly originalText: string;
  readonly translatedText: string;
  readonly success: boolean;
}

/**
 * Options for deterministic text chunking.
 */
export interface ChunkingOptions {
  /** Maximum character length per chunk (default: 1200). */
  readonly maxChunkSize?: number;
}

/**
 * Overall result of translating long text via deterministic chunking.
 */
export interface TranslatedLongTextResult {
  readonly originalText: string;
  readonly translatedText: string;
  readonly direction: TranslationDirection;
  readonly chunks: readonly TranslatedTextChunk[];
  readonly overallSuccess: boolean;
  readonly failedChunkIndexes: readonly number[];
}

/**
 * Block types for extracted document structures (TXT, PDF, DOCX).
 */
export type DocumentBlockType =
  | 'title'
  | 'heading'
  | 'paragraph'
  | 'list_item'
  | 'table_cell'
  | 'other';

/**
 * Input representation of an already-extracted document block.
 */
export interface DocumentBlock {
  readonly id: string;
  readonly type: DocumentBlockType;
  readonly text: string;
  readonly order: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Output representation of a translated document block preserving ID and order.
 */
export interface TranslatedDocumentBlock {
  readonly id: string;
  readonly type: DocumentBlockType;
  readonly originalText: string;
  readonly translatedText: string;
  readonly order: number;
  readonly alternatives?: readonly string[];
  readonly success: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Input request for document translation.
 */
export interface DocumentTranslationRequest {
  readonly documentId?: string;
  readonly blocks: readonly DocumentBlock[];
  readonly options?: TranslationOptions;
}

/**
 * Complete document translation result preserving block order and identity.
 */
export interface DocumentTranslationResult {
  readonly documentId?: string;
  readonly blocks: readonly TranslatedDocumentBlock[];
  readonly direction: TranslationDirection;
  readonly overallSuccess: boolean;
  readonly failedBlockIds: readonly string[];
}
