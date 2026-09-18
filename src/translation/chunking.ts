/**
 * src/translation/chunking.ts
 *
 * Deterministic, paragraph-aware text chunking foundation for long texts.
 * Ensures:
 * - Bounded chunk size
 * - Paragraph, sentence, and word boundary preservation where possible
 * - Deterministic chunk IDs and indexes
 * - Guaranteed exact preservation of every character without silent dropping or duplication
 * - Invariant: chunks.map(c => c.text).join('') === originalText
 * - Order preservation during reconstruction
 */

import type { ChunkingOptions, TextChunk, TranslatedTextChunk } from './types';

export const DEFAULT_MAX_CHUNK_SIZE = 1200;

/**
 * Splits text into deterministic chunks using offset-based slicing of the original string.
 * Strictly guarantees: chunks.map(c => c.text).join('') === originalText.
 */
export function chunkLongText(text: string, options?: ChunkingOptions): TextChunk[] {
  if (!text || text.length === 0) {
    return [];
  }

  const maxChunkSize = Math.max(10, options?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE);

  // If text already fits within maxChunkSize, return single chunk with exact offsets
  if (text.length <= maxChunkSize) {
    return [
      {
        chunkId: 'chunk-0',
        index: 0,
        text,
        characterCount: text.length,
        startOffset: 0,
        endOffset: text.length,
      },
    ];
  }

  const chunks: TextChunk[] = [];
  let currentOffset = 0;
  let chunkIndex = 0;

  while (currentOffset < text.length) {
    const remainingLength = text.length - currentOffset;
    if (remainingLength <= maxChunkSize) {
      const chunkText = text.slice(currentOffset, text.length);
      chunks.push({
        chunkId: `chunk-${chunkIndex}`,
        index: chunkIndex,
        text: chunkText,
        characterCount: chunkText.length,
        startOffset: currentOffset,
        endOffset: text.length,
      });
      break;
    }

    // Look for best cut point in window (currentOffset, currentOffset + maxChunkSize]
    const windowEnd = currentOffset + maxChunkSize;
    const windowSlice = text.slice(currentOffset, windowEnd);

    let splitOffset = -1;

    // 1. Try paragraph break: \n\n+ (or \r\n\r\n+)
    // Cut point is right AFTER the newline sequence
    const paragraphMatches = [...windowSlice.matchAll(/(\r?\n){2,}/g)];
    if (paragraphMatches.length > 0) {
      const lastMatch = paragraphMatches[paragraphMatches.length - 1];
      const matchEnd = (lastMatch.index ?? 0) + lastMatch[0].length;
      if (matchEnd > 0) {
        splitOffset = currentOffset + matchEnd;
      }
    }

    // 2. Try single newline break if no paragraph break
    if (splitOffset === -1) {
      const newlineMatches = [...windowSlice.matchAll(/\r?\n/g)];
      if (newlineMatches.length > 0) {
        const lastMatch = newlineMatches[newlineMatches.length - 1];
        const matchEnd = (lastMatch.index ?? 0) + lastMatch[0].length;
        if (matchEnd > 0) {
          splitOffset = currentOffset + matchEnd;
        }
      }
    }

    // 3. Try sentence boundary: punctuation followed by space or newline: ([.!?؟]+[\s]+)
    if (splitOffset === -1) {
      const sentenceMatches = [...windowSlice.matchAll(/[.!?؟]+(\s+|$)/g)];
      if (sentenceMatches.length > 0) {
        const lastMatch = sentenceMatches[sentenceMatches.length - 1];
        const matchEnd = (lastMatch.index ?? 0) + lastMatch[0].length;
        if (matchEnd > 0) {
          splitOffset = currentOffset + matchEnd;
        }
      }
    }

    // 4. Try word boundary: any whitespace character
    if (splitOffset === -1) {
      const whitespaceMatches = [...windowSlice.matchAll(/\s+/g)];
      if (whitespaceMatches.length > 0) {
        const lastMatch = whitespaceMatches[whitespaceMatches.length - 1];
        const matchEnd = (lastMatch.index ?? 0) + lastMatch[0].length;
        if (matchEnd > 0) {
          splitOffset = currentOffset + matchEnd;
        }
      }
    }

    // 5. Hard boundary: oversized token with no whitespace, cut at windowEnd
    if (splitOffset === -1 || splitOffset <= currentOffset) {
      splitOffset = windowEnd;
    }

    const chunkText = text.slice(currentOffset, splitOffset);
    chunks.push({
      chunkId: `chunk-${chunkIndex}`,
      index: chunkIndex,
      text: chunkText,
      characterCount: chunkText.length,
      startOffset: currentOffset,
      endOffset: splitOffset,
    });

    chunkIndex++;
    currentOffset = splitOffset;
  }

  return chunks;
}

/**
 * Reconstructs translated text from chunks, strictly maintaining chunk order.
 * By default uses empty string separator since source chunks preserve exact whitespace/delimiters.
 */
export function reconstructLongText(
  chunks: readonly TranslatedTextChunk[],
  joinSeparator = ''
): string {
  if (!chunks || chunks.length === 0) return '';

  // Sort by index to guarantee deterministic sequence
  const sorted = [...chunks].sort((a, b) => a.index - b.index);

  return sorted
    .map((chunk) => chunk.translatedText || chunk.originalText)
    .join(joinSeparator);
}

/**
 * Validates that chunking produced sequential, non-duplicated, ordered chunks.
 */
export function validateChunkSequence(chunks: readonly TextChunk[]): {
  readonly valid: boolean;
  readonly hasDuplicates: boolean;
  readonly isStrictlySequential: boolean;
} {
  const seenIds = new Set<string>();
  let hasDuplicates = false;
  let isStrictlySequential = true;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (seenIds.has(chunk.chunkId)) {
      hasDuplicates = true;
    }
    seenIds.add(chunk.chunkId);

    if (chunk.index !== i) {
      isStrictlySequential = false;
    }
  }

  return {
    valid: !hasDuplicates && isStrictlySequential,
    hasDuplicates,
    isStrictlySequential,
  };
}

/**
 * Splits a chunk into leading structural whitespace, semantic content, and trailing structural whitespace.
 * Strictly guarantees: leadingWhitespace + content + trailingWhitespace === rawText.
 */
export function splitChunkWhitespace(rawText: string): {
  readonly leadingWhitespace: string;
  readonly content: string;
  readonly trailingWhitespace: string;
} {
  if (!rawText || rawText.length === 0) {
    return { leadingWhitespace: '', content: '', trailingWhitespace: '' };
  }

  const leadingMatch = rawText.match(/^\s*/);
  const leadingWhitespace = leadingMatch ? leadingMatch[0] : '';

  // If the entire chunk is whitespace, there is no semantic content
  if (leadingWhitespace.length === rawText.length) {
    return {
      leadingWhitespace,
      content: '',
      trailingWhitespace: '',
    };
  }

  const trailingMatch = rawText.match(/\s*$/);
  const trailingWhitespace = trailingMatch ? trailingMatch[0] : '';

  const content = rawText.slice(
    leadingWhitespace.length,
    rawText.length - trailingWhitespace.length
  );

  return {
    leadingWhitespace,
    content,
    trailingWhitespace,
  };
}
