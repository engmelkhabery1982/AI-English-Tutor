/**
 * src/dictionary/service.ts
 *
 * Core service for Dictionary lookup, sense disambiguation, and multi-meaning training.
 * Reuses the existing AIProvider abstraction exclusively; never touches SQLite or Gemini SDK directly.
 */

import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import {
  buildContextMeaningRequest,
  buildDictionaryLookupRequest,
} from './prompts';
import {
  buildLearningCandidates,
  parseContextualMeaning,
  parseDictionaryEntry,
} from './sense-builder';
import { buildMultiSenseTrainingPlan } from './examples';
import type {
  ContextualMeaningResult,
  DictionaryEntry,
  DictionaryLearningCandidates,
  DictionaryLookupResult,
  MultiSenseTrainingPlan,
  ResolveContextMeaningInput,
} from './types';

export interface DictionaryService {
  /**
   * Look up an English word and return all distinct senses, definitions,
   * Arabic meanings, examples, and collocations.
   */
  lookupWord(word: string): Promise<DictionaryLookupResult>;

  /**
   * Disambiguate which sense of a word is used in a specific sentence.
   * Returns qualitative certainty and never a fake confidence percentage.
   */
  resolveMeaningInContext(input: ResolveContextMeaningInput): Promise<ContextualMeaningResult>;

  /**
   * Generate multi-sense training covering all distinct senses of the word.
   */
  createMultiSenseTraining(entry: DictionaryEntry): MultiSenseTrainingPlan;

  /**
   * Extract non-persisted learning candidates (words, senses, expressions)
   * for future UI saving into VocabularyWorkspace or Review.
   */
  extractLearningCandidates(entry: DictionaryEntry): DictionaryLearningCandidates;
}

/**
 * Factory creating a DictionaryService instance using the provided AIProvider.
 */
export function createDictionaryService(aiProvider: AIProvider): DictionaryService {
  if (!aiProvider || typeof aiProvider.generate !== 'function') {
    throw new Error('Valid AIProvider instance with generate method is required.');
  }

  return {
    async lookupWord(word: string): Promise<DictionaryLookupResult> {
      const cleanWord = (word || '').trim();
      if (!cleanWord) {
        return {
          ok: false,
          word: cleanWord,
          error: {
            code: 'word_not_found',
            message: 'A non-empty English word must be provided.',
          },
        };
      }

      try {
        const request = buildDictionaryLookupRequest(cleanWord);
        const result: AIProviderResult = await aiProvider.generate(request);

        if (!result.ok) {
          return {
            ok: false,
            word: cleanWord,
            error: {
              code: 'ai_unavailable',
              message: result.error?.message || 'AI provider was unable to generate dictionary response.',
            },
          };
        }

        const rawContent = result.response?.content || '';
        const entry = parseDictionaryEntry(rawContent, cleanWord);

        if (!entry) {
          return {
            ok: false,
            word: cleanWord,
            error: {
              code: 'invalid_response',
              message: 'Failed to parse structured dictionary entry from AI provider response.',
            },
          };
        }

        return {
          ok: true,
          entry,
        };
      } catch (err) {
        return {
          ok: false,
          word: cleanWord,
          error: {
            code: 'unknown',
            message: err instanceof Error ? err.message : 'Unknown error during dictionary lookup.',
          },
        };
      }
    },

    async resolveMeaningInContext(
      input: ResolveContextMeaningInput
    ): Promise<ContextualMeaningResult> {
      const cleanWord = (input.word || '').trim();
      const cleanSentence = (input.sentence || '').trim();

      if (!cleanWord || !cleanSentence) {
        return {
          word: cleanWord,
          sentence: cleanSentence,
          arabicMeaning: '',
          englishExplanation: 'Insufficient input to resolve meaning.',
          whyFits: 'Sentence or word is empty.',
          certainty: 'insufficient_context',
          alternativeSense: null,
        };
      }

      try {
        const request = buildContextMeaningRequest({
          word: cleanWord,
          sentence: cleanSentence,
          knownSenses: input.knownSenses,
        });

        const result: AIProviderResult = await aiProvider.generate(request);

        if (!result.ok || !result.response?.content) {
          return {
            word: cleanWord,
            sentence: cleanSentence,
            arabicMeaning: '',
            englishExplanation: 'Unable to analyze context with AI provider.',
            whyFits: 'AI provider failed to generate a response.',
            certainty: 'insufficient_context',
            alternativeSense: null,
          };
        }

        const parsed = parseContextualMeaning(result.response.content, cleanWord, cleanSentence);
        if (!parsed) {
          return {
            word: cleanWord,
            sentence: cleanSentence,
            arabicMeaning: '',
            englishExplanation: 'Failed to parse contextual meaning response.',
            whyFits: 'AI response was malformed or lacked required semantic justification.',
            certainty: 'insufficient_context',
            alternativeSense: null,
          };
        }

        // Validate returned sense IDs against known senses when known senses are supplied
        if (input.knownSenses && input.knownSenses.length > 0) {
          const knownSenseIds = new Set(input.knownSenses.map((s) => s.senseId));

          if (parsed.selectedSenseId && !knownSenseIds.has(parsed.selectedSenseId)) {
            return {
              word: cleanWord,
              sentence: cleanSentence,
              arabicMeaning: '',
              englishExplanation:
                'The AI returned a sense ID that did not match the supplied known senses.',
              whyFits: 'Sense ID mismatch with known senses.',
              certainty: 'insufficient_context',
              alternativeSense: null,
            };
          }

          if (
            parsed.alternativeSense?.senseId &&
            !knownSenseIds.has(parsed.alternativeSense.senseId)
          ) {
            return {
              ...parsed,
              alternativeSense: null,
            };
          }
        }

        return parsed;
      } catch (err) {
        return {
          word: cleanWord,
          sentence: cleanSentence,
          arabicMeaning: '',
          englishExplanation:
            err instanceof Error ? err.message : 'Error resolving meaning in context.',
          whyFits: 'Unexpected execution exception.',
          certainty: 'insufficient_context',
          alternativeSense: null,
        };
      }
    },

    createMultiSenseTraining(entry: DictionaryEntry): MultiSenseTrainingPlan {
      return buildMultiSenseTrainingPlan(entry);
    },

    extractLearningCandidates(entry: DictionaryEntry): DictionaryLearningCandidates {
      return buildLearningCandidates(entry);
    },
  };
}
