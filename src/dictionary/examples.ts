/**
 * src/dictionary/examples.ts
 *
 * Sense-aware examples and multi-meaning training plan generator.
 * Creates training items for ALL meaningful senses of a word so learners
 * master distinct senses without confusing or blending them.
 */

import type {
  DictionaryEntry,
  DictionarySense,
  MultiSenseTrainingPlan,
  SensePracticeItem,
} from './types';

/**
 * Builds an engaging multi-sense training plan covering all distinct senses
 * of a headword.
 */
export function buildMultiSenseTrainingPlan(entry: DictionaryEntry): MultiSenseTrainingPlan {
  const items: SensePracticeItem[] = [];

  for (let i = 0; i < entry.senses.length; i++) {
    const currentSense = entry.senses[i];
    const otherSenses = entry.senses.filter((_, idx) => idx !== i);

    // Pick an example sentence from this sense or create a structured fallback
    const example = currentSense.examples[0];
    const promptSentence =
      example?.english ||
      (currentSense.collocations && currentSense.collocations[0]
        ? `Example: They ${currentSense.collocations[0]}.`
        : `Consider how "${entry.word}" is used when it means "${currentSense.distinction}".`);

    const sentenceArabicTranslation =
      example?.arabic || currentSense.arabicMeaning;

    const correctChoice = `${currentSense.distinction} (${currentSense.arabicMeaning})`;

    // Distractor choices are formed from the OTHER senses of this exact word
    const distractorChoices: string[] = otherSenses.map(
      (other) => `${other.distinction} (${other.arabicMeaning})`
    );

    // If there are no other senses (single-sense word), provide sensible linguistic distractors
    if (distractorChoices.length === 0) {
      distractorChoices.push(
        `Opposite meaning / unrelated action`,
        `Literal physical translation in an inappropriate context`
      );
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
      comprehensionQuestion: `What is the specific meaning of "${entry.word}" in: "${promptSentence}"?`,
      correctChoice,
      distractorChoices,
      explanation: `In this context, "${entry.word}" means "${currentSense.englishDefinition}" (${currentSense.arabicMeaning}). Key sense: ${currentSense.distinction}.`,
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
