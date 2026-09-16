/**
 * src/providers/ai/feedback.ts
 *
 * Structured feedback parsing and stream filtering for AI English Tutor.
 * Safely parses delimited feedback without leaking JSON to the conversational reply.
 */

import type {
  ConversationFeedback,
  ConversationFeedbackCorrection,
  ConversationFeedbackVocabulary,
  VocabularyCategory,
} from './types';

const ALLOWED_VOCAB_TYPES = new Set<VocabularyCategory>([
  'word',
  'phrase',
  'phrasal_verb',
  'idiom',
  'common_expression',
  'collocation',
  'linking_expression',
  'professional_expression',
]);

const ALLOWED_SEVERITIES = new Set<ConversationFeedbackCorrection['severity']>([
  'incorrect',
  'unnatural',
  'minor',
]);

const FEEDBACK_START_TAG = '[FEEDBACK]';
const FEEDBACK_END_TAG = '[/FEEDBACK]';

/**
 * Result of parsing a raw model generation into conversational content and structured feedback.
 */
export interface ParsedModelOutput {
  readonly content: string;
  readonly feedback: ConversationFeedback | null;
  readonly rawText: string;
}

/**
 * Normalizes vocabulary type string from various AI outputs to standard VocabularyCategory.
 */
function normalizeVocabType(rawType: unknown): VocabularyCategory | null {
  if (typeof rawType !== 'string') return null;
  const cleaned = rawType.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (ALLOWED_VOCAB_TYPES.has(cleaned as VocabularyCategory)) {
    return cleaned as VocabularyCategory;
  }
  // Common mappings
  if (cleaned === 'phrasal_verb' || cleaned === 'phrasalverb') return 'phrasal_verb';
  if (cleaned === 'expression' || cleaned === 'common_expression') return 'common_expression';
  if (cleaned === 'idiomatic_expression') return 'idiom';
  if (cleaned === 'verb' || cleaned === 'noun' || cleaned === 'adjective' || cleaned === 'adverb') {
    return 'word';
  }
  return null;
}

/**
 * Safely validates and sanitizes a correction object.
 */
function validateCorrection(raw: unknown): ConversationFeedbackCorrection | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const original = typeof obj.original === 'string' ? obj.original.trim() : '';
  const improved = typeof obj.improved === 'string' ? obj.improved.trim() : '';
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim() : '';

  if (!original || !improved || !explanation) {
    return null;
  }

  const rawSeverity = typeof obj.severity === 'string' ? obj.severity.trim().toLowerCase() : '';
  const severity: ConversationFeedbackCorrection['severity'] = ALLOWED_SEVERITIES.has(
    rawSeverity as ConversationFeedbackCorrection['severity']
  )
    ? (rawSeverity as ConversationFeedbackCorrection['severity'])
    : 'minor';

  return {
    original,
    improved,
    explanation,
    severity,
  };
}

/**
 * Safely validates and sanitizes a vocabulary object.
 */
function validateVocabulary(raw: unknown): ConversationFeedbackVocabulary | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const headword =
    typeof obj.headword === 'string'
      ? obj.headword.trim()
      : typeof obj.expression === 'string'
      ? obj.expression.trim()
      : '';
  const meaning = typeof obj.meaning === 'string' ? obj.meaning.trim() : '';
  const example = typeof obj.example === 'string' ? obj.example.trim() : '';
  const type = normalizeVocabType(obj.type) ?? 'phrase';

  if (!headword || !meaning || !example) {
    return null;
  }

  return {
    headword,
    type,
    meaning,
    example,
  };
}

/**
 * Safely validates and sanitizes a coaching note.
 */
function validateCoachingNote(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

/**
 * Parses a raw model response into conversational content and optional structured feedback.
 */
export function parseFeedbackAndContent(rawText: string): ParsedModelOutput {
  if (!rawText || typeof rawText !== 'string') {
    return {
      content: '',
      feedback: null,
      rawText: rawText || '',
    };
  }

  const feedbackTagIndex = rawText.indexOf(FEEDBACK_START_TAG);
  if (feedbackTagIndex === -1) {
    return {
      content: rawText.trim(),
      feedback: null,
      rawText,
    };
  }

  const conversationalContent = rawText.slice(0, feedbackTagIndex).trim();

  let feedbackBlock = rawText.slice(feedbackTagIndex + FEEDBACK_START_TAG.length);
  const endTagIndex = feedbackBlock.indexOf(FEEDBACK_END_TAG);
  if (endTagIndex !== -1) {
    feedbackBlock = feedbackBlock.slice(0, endTagIndex);
  }

  // Strip markdown code fences if present inside feedback block
  feedbackBlock = feedbackBlock.trim();
  if (feedbackBlock.startsWith('```json')) {
    feedbackBlock = feedbackBlock.slice(7);
  } else if (feedbackBlock.startsWith('```')) {
    feedbackBlock = feedbackBlock.slice(3);
  }
  if (feedbackBlock.endsWith('```')) {
    feedbackBlock = feedbackBlock.slice(0, -3);
  }
  feedbackBlock = feedbackBlock.trim();

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(feedbackBlock);
  } catch {
    // If JSON parsing fails, fallback gracefully without crashing
    return {
      content: conversationalContent || rawText.trim(),
      feedback: null,
      rawText,
    };
  }

  if (!parsedJson || typeof parsedJson !== 'object') {
    return {
      content: conversationalContent || rawText.trim(),
      feedback: null,
      rawText,
    };
  }

  const jsonObj = parsedJson as Record<string, unknown>;
  const correction = validateCorrection(jsonObj.correction);
  const vocabulary = validateVocabulary(jsonObj.vocabulary);
  const coachingNote = validateCoachingNote(jsonObj.coachingNote);

  const hasFeedback = Boolean(correction || vocabulary || coachingNote);
  const feedback: ConversationFeedback | null = hasFeedback
    ? {
        ...(correction && { correction }),
        ...(vocabulary && { vocabulary }),
        ...(coachingNote && { coachingNote }),
      }
    : null;

  return {
    content: conversationalContent || rawText.trim(),
    feedback,
    rawText,
  };
}

/**
 * Stream filter that passes conversational text chunks to onChunk while buffering
 * any partial [FEEDBACK] prefix and discarding feedback content from the live stream.
 */
export class FeedbackStreamFilter {
  private accumulatedRaw = '';
  private emittedLength = 0;
  private hasSeenFeedbackTag = false;
  private readonly onChunk: (chunk: string) => void;

  constructor(onChunk: (chunk: string) => void) {
    this.onChunk = onChunk;
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.accumulatedRaw += chunk;

    if (this.hasSeenFeedbackTag) {
      return;
    }

    const tagIndex = this.accumulatedRaw.indexOf(FEEDBACK_START_TAG);
    if (tagIndex !== -1) {
      this.hasSeenFeedbackTag = true;
      // Emit any conversational text prior to the tag that hasn't been emitted yet
      const unEmitted = this.accumulatedRaw.slice(this.emittedLength, tagIndex);
      if (unEmitted.length > 0) {
        this.onChunk(unEmitted);
        this.emittedLength += unEmitted.length;
      }
      return;
    }

    // Check if the tail might be a partial prefix of [FEEDBACK]
    let potentialPrefixLen = 0;
    for (let len = Math.min(this.accumulatedRaw.length, FEEDBACK_START_TAG.length - 1); len > 0; len--) {
      const tail = this.accumulatedRaw.slice(-len);
      if (FEEDBACK_START_TAG.startsWith(tail)) {
        potentialPrefixLen = len;
        break;
      }
    }

    const safeToEmitEnd = this.accumulatedRaw.length - potentialPrefixLen;
    if (safeToEmitEnd > this.emittedLength) {
      const delta = this.accumulatedRaw.slice(this.emittedLength, safeToEmitEnd);
      this.onChunk(delta);
      this.emittedLength = safeToEmitEnd;
    }
  }

  finish(): ParsedModelOutput {
    if (!this.hasSeenFeedbackTag && this.emittedLength < this.accumulatedRaw.length) {
      const remaining = this.accumulatedRaw.slice(this.emittedLength);
      if (!remaining.includes(FEEDBACK_START_TAG)) {
        this.onChunk(remaining);
        this.emittedLength = this.accumulatedRaw.length;
      }
    }
    return parseFeedbackAndContent(this.accumulatedRaw);
  }

  getRawText(): string {
    return this.accumulatedRaw;
  }
}
