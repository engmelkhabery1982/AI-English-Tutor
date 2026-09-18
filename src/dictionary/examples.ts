/**
 * src/dictionary/examples.ts
 *
 * Sense-aware examples and grounded multi-meaning training plan generator.
 * Creates training items ONLY from verified structured dictionary data.
 * Never fabricates fallback example sentences or artificial distractors.
 */

import type {
  DictionaryEntry,
  DictionarySense,
  MultiSenseTrainingPlan,
  SensePracticeItem,
} from './types';

/**
 * Builds a grounded training plan covering all distinct senses of a headword.
 * Strictly enforces:
 * - Uses only genuine example sentences from structured sense data (never generates pseudo-sentences).
 * - Multi-sense items draw distractors exclusively from other real senses of the word.
 * - Single-sense items do not fabricate distractors (distractorChoices is empty).
 * - Senses lacking grounded examples are safely omitted.
 */
export function buildMultiSenseTrainingPlan(entry: DictionaryEntry): MultiSenseTrainingPlan {
  const items: SensePracticeItem[] = [];

  for (let i = 0; i < entry.senses.length; i++) {
    const currentSense = entry.senses[i];
    const otherSenses = entry.senses.filter((_, idx) => idx !== i);

    // Pick a genuine grounded example from this sense with both English and Arabic
    const groundedExample = currentSense.examples?.find(
      (ex) =>
        typeof ex.english === 'string' &&
        ex.english.trim().length > 0 &&
        typeof ex.arabic === 'string' &&
        ex.arabic.trim().length > 0
    );

    // If a sense lacks grounded example material, omit that exercise
    if (!groundedExample) {
      continue;
    }

    const promptSentence = groundedExample.english.trim();
    const sentenceArabicTranslation = groundedExample.arabic.trim();
    const correctChoice = `${currentSense.distinction} (${currentSense.arabicMeaning})`;

    let distractorChoices: string[] = [];
    let comprehensionQuestion: string;
    let isQualitativePractice = false;

    if (otherSenses.length > 0) {
      // Multi-sense word: distractors are formed strictly from other real senses
      distractorChoices = otherSenses.map(
        (other) => `${other.distinction} (${other.arabicMeaning})`
      );
      comprehensionQuestion = `What is the specific meaning of "${entry.word}" in: "${promptSentence}"?`;
    } else {
      // Single-sense word: honest qualitative practice without fabricated distractors
      distractorChoices = [];
      isQualitativePractice = true;
      comprehensionQuestion = `Review the usage of "${entry.word}" (${currentSense.distinction}) in context: "${promptSentence}".`;
    }

    const item: SensePracticeItem = {
      senseId: currentSense.senseId,
      distinction: currentSense.distinction,
      partOfSpeech: currentSense.partOfSpeech,
      arabicMeaning: currentSense.arabicMeaning,
      englishDefinition: currentSense.englishDefinition,
      targetCollocation: currentSense.collocations?.[0],
      promptSentence,
      sentenceArabicTranslation,
      comprehensionQuestion,
      correctChoice,
      distractorChoices,
      explanation: `In this context, "${entry.word}" means "${currentSense.englishDefinition}" (${currentSense.arabicMeaning}). Key sense: ${currentSense.distinction}.`,
      isQualitativePractice,
    };

    items.push(item);
  }

  return {
    word: entry.word,
    senseCount: entry.senses.length,
    items,
  };
}

/**
 * Validates that all senses in an entry have distinct definitions and Arabic translations.
 */
export function validateSenseDistinctions(senses: readonly DictionarySense[]): {
  readonly valid: boolean;
  readonly duplicateCount: number;
} {
  const seenArabic = new Set<string>();
  const seenEnglish = new Set<string>();
  let duplicateCount = 0;

  for (const s of senses) {
    const arNorm = s.arabicMeaning.trim().toLowerCase();
    const enNorm = s.englishDefinition.trim().toLowerCase();
    if (seenArabic.has(arNorm) && seenEnglish.has(enNorm)) {
      duplicateCount++;
    }
    seenArabic.add(arNorm);
    seenEnglish.add(enNorm);
  }

  return {
    valid: duplicateCount === 0,
    duplicateCount,
  };
}
