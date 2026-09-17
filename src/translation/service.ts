/**
 * src/translation/service.ts
 *
 * Core service for English <-> Arabic translation, long-text chunked translation,
 * and block-based document translation.
 *
 * Exclusively reuses the existing AIProvider abstraction.
 * Preserves original source text on failure and never auto-persists learning items.
 */

import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import {
  buildDocumentBlocksTranslationRequest,
  buildTextTranslationRequest,
  detectLanguageDirection,
} from './prompts';
import { chunkLongText, reconstructLongText } from './chunking';
import type {
  ChunkingOptions,
  DocumentTranslationRequest,
  DocumentTranslationResult,
  TextChunk,
  TranslatedDocumentBlock,
  TranslatedLongTextResult,
  TranslatedTextChunk,
  TranslationDirection,
  TranslationLearningCandidates,
  TranslationOptions,
  TranslationResult,
  TranslationSuccess,
} from './types';

export interface TranslationService {
  /**
   * Translate a segment of text between English and Arabic with pedagogical metadata.
   */
  translateText(text: string, options?: TranslationOptions): Promise<TranslationResult>;

  /**
   * Translate long text deterministically via paragraph-aware chunking.
   */
  translateLongText(
    text: string,
    options?: TranslationOptions & ChunkingOptions
  ): Promise<TranslatedLongTextResult>;

  /**
   * Translate structured document blocks preserving order and block identity.
   */
  translateDocument(request: DocumentTranslationRequest): Promise<DocumentTranslationResult>;
}

/**
 * Extracts raw JSON substring safely from AI output.
 */
function extractJsonString(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const fencedMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1];
  }
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  return braceMatch ? braceMatch[0] : null;
}

/**
 * Normalizes learning candidates safely.
 */
function normalizeLearningCandidates(raw: unknown): TranslationLearningCandidates {
  const empty: TranslationLearningCandidates = {
    vocabulary: [],
    expressions: [],
    collocations: [],
    phrasalVerbs: [],
  };

  if (typeof raw !== 'object' || raw === null) return empty;
  const obj = raw as Record<string, unknown>;

  const vocabulary = Array.isArray(obj.vocabulary)
    ? obj.vocabulary
        .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
        .map((v) => ({
          headword: String(v.headword || '').trim(),
          partOfSpeech: typeof v.partOfSpeech === 'string' ? v.partOfSpeech.trim() : undefined,
          contextMeaning: String(v.contextMeaning || v.meaning || '').trim(),
          arabicMeaning: String(v.arabicMeaning || '').trim(),
        }))
        .filter((v) => v.headword.length > 0)
    : [];

  const expressions = Array.isArray(obj.expressions)
    ? obj.expressions
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({
          expression: String(e.expression || '').trim(),
          meaning: String(e.meaning || '').trim(),
          arabicMeaning: String(e.arabicMeaning || '').trim(),
        }))
        .filter((e) => e.expression.length > 0)
    : [];

  const collocations = Array.isArray(obj.collocations)
    ? obj.collocations
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({
          collocation: String(c.collocation || '').trim(),
          usageNote: String(c.usageNote || c.note || '').trim(),
        }))
        .filter((c) => c.collocation.length > 0)
    : [];

  const phrasalVerbs = Array.isArray(obj.phrasalVerbs)
    ? obj.phrasalVerbs
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map((p) => ({
          phrasalVerb: String(p.phrasalVerb || '').trim(),
          meaning: String(p.meaning || '').trim(),
          exampleInText: String(p.exampleInText || p.example || '').trim(),
        }))
        .filter((p) => p.phrasalVerb.length > 0)
    : [];

  return { vocabulary, expressions, collocations, phrasalVerbs };
}

/**
 * Normalizes string arrays safely.
 */
function normalizeStringArray(arr: unknown): readonly string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

/**
 * Factory creating a TranslationService instance using the provided AIProvider.
 */
export function createTranslationService(aiProvider: AIProvider): TranslationService {
  if (!aiProvider || typeof aiProvider.generate !== 'function') {
    throw new Error('Valid AIProvider instance with generate method is required.');
  }

  async function translateTextInternal(
    text: string,
    options?: TranslationOptions
  ): Promise<TranslationResult> {
    const cleanText = (text || '').trim();
    if (!cleanText) {
      return {
        ok: false,
        originalText: text,
        error: {
          code: 'empty_input',
          message: 'Cannot translate empty text.',
        },
      };
    }

    const direction: TranslationDirection =
      options?.direction ?? detectLanguageDirection(cleanText);
    const style = options?.style ?? 'natural';
    const arabicVariety = options?.arabicVariety ?? 'msa';

    try {
      const request = buildTextTranslationRequest(cleanText, options);
      const result: AIProviderResult = await aiProvider.generate(request);

      if (!result.ok) {
        return {
          ok: false,
          originalText: cleanText,
          error: {
            code: 'ai_unavailable',
            message: result.error?.message || 'AI provider was unable to generate translation.',
          },
        };
      }

      const rawContent = result.response?.content || '';
      const jsonStr = extractJsonString(rawContent);

      if (!jsonStr) {
        return {
          ok: false,
          originalText: cleanText,
          error: {
            code: 'invalid_response',
            message: 'Failed to extract valid JSON translation from AI response.',
          },
        };
      }

      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const translatedText =
        typeof parsed.translatedText === 'string' ? parsed.translatedText.trim() : '';

      if (!translatedText) {
        return {
          ok: false,
          originalText: cleanText,
          error: {
            code: 'invalid_response',
            message: 'AI response lacked translatedText content.',
          },
        };
      }

      const literalTranslation =
        typeof parsed.literalTranslation === 'string' &&
        parsed.literalTranslation.trim().length > 0 &&
        parsed.literalTranslation.trim() !== translatedText
          ? parsed.literalTranslation.trim()
          : null;

      const alternatives = normalizeStringArray(parsed.alternatives).filter(
        (alt) => alt !== translatedText
      );

      const explanation =
        typeof parsed.explanation === 'string' && parsed.explanation.trim().length > 0
          ? parsed.explanation.trim()
          : null;

      const learningNotes = normalizeStringArray(parsed.learningNotes);
      const learningCandidates = normalizeLearningCandidates(parsed.learningCandidates);

      const successData: TranslationSuccess = {
        originalText: cleanText,
        translatedText,
        direction,
        style,
        arabicVariety,
        literalTranslation,
        alternatives,
        explanation,
        learningNotes,
        learningCandidates,
      };

      return {
        ok: true,
        data: successData,
      };
    } catch (err) {
      return {
        ok: false,
        originalText: cleanText,
        error: {
          code: 'unknown',
          message: err instanceof Error ? err.message : 'Unknown translation failure.',
        },
      };
    }
  }

  return {
    translateText: translateTextInternal,

    async translateLongText(
      text: string,
      options?: TranslationOptions & ChunkingOptions
    ): Promise<TranslatedLongTextResult> {
      const cleanText = (text || '').trim();
      const direction = options?.direction ?? detectLanguageDirection(cleanText);

      if (!cleanText) {
        return {
          originalText: text,
          translatedText: '',
          direction,
          chunks: [],
          overallSuccess: true,
          failedChunkIndexes: [],
        };
      }

      const chunks: TextChunk[] = chunkLongText(cleanText, options);
      const translatedChunks: TranslatedTextChunk[] = [];
      const failedIndexes: number[] = [];

      for (const chunk of chunks) {
        const chunkResult = await translateTextInternal(chunk.text, options);
        if (chunkResult.ok) {
          translatedChunks.push({
            chunkId: chunk.chunkId,
            index: chunk.index,
            originalText: chunk.text,
            translatedText: chunkResult.data.translatedText,
            success: true,
          });
        } else {
          // Failure preserves original chunk text honestly
          failedIndexes.push(chunk.index);
          translatedChunks.push({
            chunkId: chunk.chunkId,
            index: chunk.index,
            originalText: chunk.text,
            translatedText: chunk.text,
            success: false,
          });
        }
      }

      const overallSuccess = failedIndexes.length === 0;
      const translatedText = reconstructLongText(translatedChunks);

      return {
        originalText: cleanText,
        translatedText,
        direction,
        chunks: translatedChunks,
        overallSuccess,
        failedChunkIndexes: failedIndexes,
      };
    },

    async translateDocument(
      request: DocumentTranslationRequest
    ): Promise<DocumentTranslationResult> {
      const blocks = request.blocks;
      const direction =
        request.options?.direction ??
        detectLanguageDirection(blocks.map((b) => b.text).join(' '));

      if (blocks.length === 0) {
        return {
          documentId: request.documentId,
          blocks: [],
          direction,
          overallSuccess: true,
          failedBlockIds: [],
        };
      }

      // Translate document blocks via AIProvider
      try {
        const aiRequest = buildDocumentBlocksTranslationRequest(blocks, request.options);
        const result: AIProviderResult = await aiProvider.generate(aiRequest);

        if (!result.ok || !result.response?.content) {
          // AI failure: preserve every original block unmodified with success: false
          const fallbackBlocks: TranslatedDocumentBlock[] = blocks.map((b) => ({
            id: b.id,
            type: b.type,
            originalText: b.text,
            translatedText: b.text,
            order: b.order,
            success: false,
            metadata: b.metadata,
          }));

          return {
            documentId: request.documentId,
            blocks: fallbackBlocks,
            direction,
            overallSuccess: false,
            failedBlockIds: blocks.map((b) => b.id),
          };
        }

        const jsonStr = extractJsonString(result.response.content);
        if (!jsonStr) {
          const fallbackBlocks: TranslatedDocumentBlock[] = blocks.map((b) => ({
            id: b.id,
            type: b.type,
            originalText: b.text,
            translatedText: b.text,
            order: b.order,
            success: false,
            metadata: b.metadata,
          }));

          return {
            documentId: request.documentId,
            blocks: fallbackBlocks,
            direction,
            overallSuccess: false,
            failedBlockIds: blocks.map((b) => b.id),
          };
        }

        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const rawTranslatedBlocks = Array.isArray(parsed.blocks)
          ? parsed.blocks
          : Array.isArray(parsed.translatedBlocks)
            ? parsed.translatedBlocks
            : [];

        // Map by block id to retain deterministic identity
        const translatedMap = new Map<string, { translatedText: string; alternatives?: string[] }>();
        for (const item of rawTranslatedBlocks) {
          if (typeof item === 'object' && item !== null) {
            const b = item as Record<string, unknown>;
            const id = typeof b.id === 'string' ? b.id.trim() : '';
            const translatedText = typeof b.translatedText === 'string' ? b.translatedText.trim() : '';
            const alternatives = normalizeStringArray(b.alternatives) as string[];
            if (id && translatedText) {
              translatedMap.set(id, { translatedText, alternatives });
            }
          }
        }

        const translatedBlocks: TranslatedDocumentBlock[] = [];
        const failedBlockIds: string[] = [];

        // Guarantee preservation of original input block order and metadata
        for (const originalBlock of blocks) {
          const match = translatedMap.get(originalBlock.id);
          if (match) {
            translatedBlocks.push({
              id: originalBlock.id,
              type: originalBlock.type,
              originalText: originalBlock.text,
              translatedText: match.translatedText,
              order: originalBlock.order,
              alternatives: match.alternatives,
              success: true,
              metadata: originalBlock.metadata,
            });
          } else {
            failedBlockIds.push(originalBlock.id);
            translatedBlocks.push({
              id: originalBlock.id,
              type: originalBlock.type,
              originalText: originalBlock.text,
              translatedText: originalBlock.text,
              order: originalBlock.order,
              success: false,
              metadata: originalBlock.metadata,
            });
          }
        }

        return {
          documentId: request.documentId,
          blocks: translatedBlocks,
          direction,
          overallSuccess: failedBlockIds.length === 0,
          failedBlockIds,
        };
      } catch {
        const fallbackBlocks: TranslatedDocumentBlock[] = blocks.map((b) => ({
          id: b.id,
          type: b.type,
          originalText: b.text,
          translatedText: b.text,
          order: b.order,
          success: false,
          metadata: b.metadata,
        }));

        return {
          documentId: request.documentId,
          blocks: fallbackBlocks,
          direction,
          overallSuccess: false,
          failedBlockIds: blocks.map((b) => b.id),
        };
      }
    },
  };
}
