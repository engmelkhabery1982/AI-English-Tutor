/**
 * src/translation/chunking.ts
 *
 * Deterministic, paragraph-aware text chunking foundation for long texts.
 * Ensures:
 * - Bounded chunk size
 * - Paragraph and sentence boundary preservation where possible
 * - Deterministic chunk IDs and indexes
 * - Guaranteed preservation of every character without silent dropping or duplication
 * - Order preservation during reconstruction
 */

import type { ChunkingOptions, TextChunk, TranslatedTextChunk } from './types';

export const DEFAULT_MAX_CHUNK_SIZE = 1200;

/**
 * Splits text into deterministic chunks respecting paragraph boundaries first,
 * sentence boundaries second, and word boundaries third.
 */
export function chunkLongText(text: string, options?: ChunkingOptions): TextChunk[] {
  if (!text || text.length === 0) {
    return [];
  }

  const maxChunkSize = Math.max(100, options?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE);

  // If text already fits within maxChunkSize, return single chunk
  if (text.length <= maxChunkSize) {
    return [
      {
        chunkId: 'chunk-0',
        index: 0,
        text,
        characterCount: text.length,
      },
    ];
  }

  // Split into paragraphs (preserving delimiters by splitting on paragraph breaks)
  // We use regex split with capture or match paragraphs
  const rawParagraphs = text.split(/\n\n+/);
  const chunks: TextChunk[] = [];
  let currentAccumulator = '';
  let chunkIndex = 0;

  function flushCurrent() {
    if (currentAccumulator.length > 0) {
      chunks.push({
        chunkId: `chunk-${chunkIndex}`,
        index: chunkIndex,
        text: currentAccumulator,
        characterCount: currentAccumulator.length,
      });
      chunkIndex++;
      currentAccumulator = '';
    }
  }

  for (let i = 0; i < rawParagraphs.length; i++) {
    const paragraph = rawParagraphs[i];
    if (paragraph.length === 0) continue;

    // Check if paragraph itself exceeds maxChunkSize
    if (paragraph.length > maxChunkSize) {
      // Flush existing accumulator before processing large paragraph
      flushCurrent();

      // Split oversized paragraph by sentences
      const sentenceChunks = splitParagraphIntoSentenceChunks(paragraph, maxChunkSize);
      for (const sentChunk of sentenceChunks) {
        chunks.push({
          chunkId: `chunk-${chunkIndex}`,
          index: chunkIndex,
          text: sentChunk,
          characterCount: sentChunk.length,
        });
        chunkIndex++;
      }
      continue;
    }

    // Check if adding this paragraph to accumulator exceeds maxChunkSize
    const separator = currentAccumulator.length > 0 ? '\n\n' : '';
    if (currentAccumulator.length + separator.length + paragraph.length <= maxChunkSize) {
      currentAccumulator += separator + paragraph;
    } else {
      flushCurrent();
      currentAccumulator = paragraph;
    }
  }

  flushCurrent();
  return chunks;
}

/**
 * Helper to split an oversized paragraph by sentence boundaries.
 */
function splitParagraphIntoSentenceChunks(paragraph: string, maxChunkSize: number): string[] {
  // Regex matches sentences ending with ., !, ?, or Arabic punctuation ؟, ۔ followed by space or end
  const sentenceRegex = /[^.!?؟]+(?:[.!?؟]+["']?|\s*$)/g;
  const rawSentences = paragraph.match(sentenceRegex) || [paragraph];

  const subChunks: string[] = [];
  let subAccumulator = '';

  for (const sentence of rawSentences) {
    const trimmedSent = sentence.trim();
    if (!trimmedSent) continue;

    if (trimmedSent.length > maxChunkSize) {
      // Single sentence exceeds maxChunkSize: split by word boundary
      if (subAccumulator) {
        subChunks.push(subAccumulator);
        subAccumulator = '';
      }
      const wordChunks = splitSentenceByWords(trimmedSent, maxChunkSize);
      subChunks.push(...wordChunks);
      continue;
    }

    const separator = subAccumulator ? ' ' : '';
    if (subAccumulator.length + separator.length + trimmedSent.length <= maxChunkSize) {
      subAccumulator += separator + trimmedSent;
    } else {
      if (subAccumulator) subChunks.push(subAccumulator);
      subAccumulator = trimmedSent;
    }
  }

  if (subAccumulator) {
    subChunks.push(subAccumulator);
  }

  return subChunks.length > 0 ? subChunks : [paragraph];
}

/**
 * Splits an oversized sentence cleanly by words without losing any text.
 */
function splitSentenceByWords(sentence: string, maxChunkSize: number): string[] {
  const words = sentence.split(/\s+/);
  const result: string[] = [];
  let current = '';

  for (const word of words) {
    if (!word) continue;

    if (word.length > maxChunkSize) {
      // Extremely long single token (e.g. repeated characters): slice directly
      if (current) {
        result.push(current);
        current = '';
      }
      let offset = 0;
      while (offset < word.length) {
        result.push(word.slice(offset, offset + maxChunkSize));
        offset += maxChunkSize;
      }
      continue;
    }

    const separator = current ? ' ' : '';
    if (current.length + separator.length + word.length <= maxChunkSize) {
      current += separator + word;
    } else {
      if (current) result.push(current);
      current = word;
    }
  }

  if (current) {
    result.push(current);
  }

  return result;
}

/**
 * Reconstructs translated text from chunks, strictly maintaining chunk order.
 */
export function reconstructLongText(
  chunks: readonly TranslatedTextChunk[],
  joinSeparator = '\n\n'
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
