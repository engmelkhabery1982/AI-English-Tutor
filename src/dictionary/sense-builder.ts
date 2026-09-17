/**
 * src/dictionary/sense-builder.ts
 *
 * Validates, normalizes, and constructs Dictionary entries, senses,
 * contextual meaning resolutions, and non-persisted learning candidates.
 */

import type {
  ContextCertainty,
  ContextualMeaningResult,
  DictionaryEntry,
  DictionaryLearningCandidates,
  DictionaryPartOfSpeech,
  DictionaryRegister,
  DictionarySense,
  DictionarySenseExample,
  SaveExpressionCandidate,
  SaveSenseCandidate,
  SaveWordCandidate,
} from './types';

const ALLOWED_PARTS_OF_SPEECH: readonly DictionaryPartOfSpeech[] = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'preposition',
  'conjunction',
  'pronoun',
  'interjection',
  'phrase',
  'phrasal_verb',
  'other',
];

const ALLOWED_REGISTERS: readonly DictionaryRegister[] = [
  'formal',
  'neutral',
  'informal',
  'slang',
  'professional',
];

const ALLOWED_CERTAINTIES: readonly ContextCertainty[] = [
  'clear',
  'likely',
  'ambiguous',
  'insufficient_context',
];

/**
 * Extracts raw JSON substring from an AI text response.
 */
export function extractJsonString(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  // Match fenced code block ```json ... ``` or standard { ... }
  const fencedMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1];
  }
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  return braceMatch ? braceMatch[0] : null;
}

/**
 * Normalizes a raw string to a recognized DictionaryPartOfSpeech.
 */
export function normalizePartOfSpeech(pos: unknown): DictionaryPartOfSpeech {
  if (typeof pos !== 'string') return 'other';
  const clean = pos.toLowerCase().trim();
  return ALLOWED_PARTS_OF_SPEECH.includes(clean as DictionaryPartOfSpeech)
    ? (clean as DictionaryPartOfSpeech)
    : 'other';
}

/**
 * Normalizes a raw string to a recognized DictionaryRegister.
 */
export function normalizeRegister(reg: unknown): DictionaryRegister | undefined {
  if (typeof reg !== 'string') return undefined;
  const clean = reg.toLowerCase().trim();
  return ALLOWED_REGISTERS.includes(clean as DictionaryRegister)
    ? (clean as DictionaryRegister)
    : undefined;
}

/**
 * Normalizes an array of strings safely.
 */
function normalizeStringArray(arr: unknown): readonly string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

/**
 * Normalizes examples for a specific sense.
 */
function normalizeSenseExamples(
  rawExamples: unknown,
  senseId: string
): readonly DictionarySenseExample[] {
  if (!Array.isArray(rawExamples)) return [];
  return rawExamples
    .map((ex, index): DictionarySenseExample | null => {
      if (typeof ex === 'string') {
        const text = ex.trim();
        if (!text) return null;
        return {
          id: `${senseId}-ex-${index + 1}`,
          english: text,
          arabic: '',
        };
      }
      if (typeof ex === 'object' && ex !== null) {
        const item = ex as Record<string, unknown>;
        const english = typeof item.english === 'string' ? item.english.trim() : '';
        if (!english) return null;
        const arabic = typeof item.arabic === 'string' ? item.arabic.trim() : '';
        const context = typeof item.context === 'string' ? item.context.trim() : undefined;
        return {
          id: typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : `${senseId}-ex-${index + 1}`,
          english,
          arabic,
          context,
        };
      }
      return null;
    })
    .filter((ex): ex is DictionarySenseExample => ex !== null);
}

/**
 * Safely parses and validates raw AI response into a structured DictionaryEntry.
 */
export function parseDictionaryEntry(rawText: string, fallbackWord: string): DictionaryEntry | null {
  const jsonStr = extractJsonString(rawText);
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const word =
      typeof parsed.word === 'string' && parsed.word.trim().length > 0
        ? parsed.word.trim()
        : fallbackWord.trim();

    const rawSenses = Array.isArray(parsed.senses) ? parsed.senses : [];
    if (rawSenses.length === 0) return null;

    const senses: DictionarySense[] = [];

    rawSenses.forEach((rawSense, idx) => {
      if (typeof rawSense !== 'object' || rawSense === null) return;
      const s = rawSense as Record<string, unknown>;

      const senseId =
        typeof s.senseId === 'string' && s.senseId.trim().length > 0
          ? s.senseId.trim()
          : `sense-${idx + 1}`;

      const partOfSpeech = normalizePartOfSpeech(s.partOfSpeech);
      const distinction =
        typeof s.distinction === 'string' && s.distinction.trim().length > 0
          ? s.distinction.trim()
          : `Meaning ${idx + 1}`;

      const englishDefinition =
        typeof s.englishDefinition === 'string' && s.englishDefinition.trim().length > 0
          ? s.englishDefinition.trim()
          : typeof s.definition === 'string'
            ? (s.definition as string).trim()
            : '';

      const arabicMeaning =
        typeof s.arabicMeaning === 'string' && s.arabicMeaning.trim().length > 0
          ? s.arabicMeaning.trim()
          : typeof s.translation === 'string'
            ? (s.translation as string).trim()
            : '';

      // Must have at least an English definition or Arabic meaning
      if (!englishDefinition && !arabicMeaning) return;

      const examples = normalizeSenseExamples(s.examples, senseId);
      const contexts = normalizeStringArray(s.contexts);
      const register = normalizeRegister(s.register);
      const collocations = normalizeStringArray(s.collocations);
      const phrasalVerbs = normalizeStringArray(s.phrasalVerbs);
      const commonMistakes = normalizeStringArray(s.commonMistakes);

      senses.push({
        senseId,
        partOfSpeech,
        distinction,
        englishDefinition: englishDefinition || arabicMeaning,
        arabicMeaning: arabicMeaning || englishDefinition,
        examples,
        contexts: contexts.length > 0 ? contexts : ['general'],
        register,
        collocations: collocations.length > 0 ? collocations : undefined,
        phrasalVerbs: phrasalVerbs.length > 0 ? phrasalVerbs : undefined,
        commonMistakes: commonMistakes.length > 0 ? commonMistakes : undefined,
      });
    });

    if (senses.length === 0) return null;

    let pronunciation = null;
    if (typeof parsed.pronunciation === 'object' && parsed.pronunciation !== null) {
      const p = parsed.pronunciation as Record<string, unknown>;
      const ipa = typeof p.ipa === 'string' && p.ipa.trim().length > 0 ? p.ipa.trim() : undefined;
      const phoneticSpelling =
        typeof p.phoneticSpelling === 'string' && p.phoneticSpelling.trim().length > 0
          ? p.phoneticSpelling.trim()
          : undefined;
      if (ipa || phoneticSpelling) {
        pronunciation = { ipa, phoneticSpelling };
      }
    }

    const primaryPartOfSpeech = normalizePartOfSpeech(
      parsed.primaryPartOfSpeech ?? senses[0]?.partOfSpeech
    );

    const commonExpressions = normalizeStringArray(parsed.commonExpressions);
    const collocations = normalizeStringArray(parsed.collocations);
    const phrasalUses = normalizeStringArray(parsed.phrasalUses);
    const learnerMistakes = normalizeStringArray(parsed.learnerMistakes);

    return {
      word,
      pronunciation,
      primaryPartOfSpeech,
      senses,
      commonExpressions: commonExpressions.length > 0 ? commonExpressions : undefined,
      collocations: collocations.length > 0 ? collocations : undefined,
      phrasalUses: phrasalUses.length > 0 ? phrasalUses : undefined,
      learnerMistakes: learnerMistakes.length > 0 ? learnerMistakes : undefined,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Safely parses and validates raw AI response into a ContextualMeaningResult.
 */
export function parseContextualMeaning(
  rawText: string,
  word: string,
  sentence: string
): ContextualMeaningResult | null {
  const jsonStr = extractJsonString(rawText);
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const arabicMeaning =
      typeof parsed.arabicMeaning === 'string' && parsed.arabicMeaning.trim().length > 0
        ? parsed.arabicMeaning.trim()
        : '';
    const englishExplanation =
      typeof parsed.englishExplanation === 'string' && parsed.englishExplanation.trim().length > 0
        ? parsed.englishExplanation.trim()
        : '';

    if (!arabicMeaning && !englishExplanation) return null;

    const rawCertainty =
      typeof parsed.certainty === 'string' ? parsed.certainty.toLowerCase().trim() : '';
    const certainty: ContextCertainty = ALLOWED_CERTAINTIES.includes(rawCertainty as ContextCertainty)
      ? (rawCertainty as ContextCertainty)
      : 'likely';

    const selectedSenseId =
      typeof parsed.selectedSenseId === 'string' && parsed.selectedSenseId.trim().length > 0
        ? parsed.selectedSenseId.trim()
        : undefined;

    const distinction =
      typeof parsed.distinction === 'string' && parsed.distinction.trim().length > 0
        ? parsed.distinction.trim()
        : undefined;

    const whyFits =
      typeof parsed.whyFits === 'string' && parsed.whyFits.trim().length > 0
        ? parsed.whyFits.trim()
        : 'Fits the grammatical and situational context of the sentence.';

    let alternativeSense = null;
    if (typeof parsed.alternativeSense === 'object' && parsed.alternativeSense !== null) {
      const alt = parsed.alternativeSense as Record<string, unknown>;
      const altArabic = typeof alt.arabicMeaning === 'string' ? alt.arabicMeaning.trim() : '';
      const altEn = typeof alt.englishExplanation === 'string' ? alt.englishExplanation.trim() : '';
      if (altArabic || altEn) {
        alternativeSense = {
          senseId: typeof alt.senseId === 'string' ? alt.senseId.trim() : undefined,
          distinction: typeof alt.distinction === 'string' ? alt.distinction.trim() : undefined,
          arabicMeaning: altArabic,
          englishExplanation: altEn,
          reason: typeof alt.reason === 'string' ? alt.reason.trim() : '',
        };
      }
    }

    return {
      word,
      sentence,
      selectedSenseId,
      distinction,
      arabicMeaning,
      englishExplanation,
      whyFits,
      certainty,
      alternativeSense,
    };
  } catch {
    return null;
  }
}

/**
 * Builds non-persisted candidate structures from a DictionaryEntry for downstream integration.
 * NEVER writes to disk, SQLite, or repositories.
 */
export function buildLearningCandidates(entry: DictionaryEntry): DictionaryLearningCandidates {
  const wordCandidate: SaveWordCandidate = {
    headword: entry.word,
    type: entry.primaryPartOfSpeech === 'phrase' ? 'phrase' : 'word',
    meanings: entry.senses.map((s) => ({
      definition: s.englishDefinition,
      partOfSpeech: s.partOfSpeech,
      arabicMeaning: s.arabicMeaning,
      examples: s.examples.map((ex) => ({
        text: ex.english,
        translation: ex.arabic || undefined,
        context: ex.context,
      })),
    })),
    pronunciation: entry.pronunciation?.ipa ? { ipa: entry.pronunciation.ipa } : undefined,
    tags: [entry.primaryPartOfSpeech, 'dictionary-core'],
  };

  const senseCandidates: SaveSenseCandidate[] = entry.senses.map((s) => ({
    headword: entry.word,
    senseId: s.senseId,
    distinction: s.distinction,
    definition: s.englishDefinition,
    arabicMeaning: s.arabicMeaning,
    partOfSpeech: s.partOfSpeech,
    examples: s.examples.map((ex) => ({
      text: ex.english,
      translation: ex.arabic || undefined,
      context: ex.context,
    })),
  }));

  const expressionCandidates: SaveExpressionCandidate[] = [];

  // Add collocations
  if (entry.collocations) {
    for (const coll of entry.collocations) {
      expressionCandidates.push({
        expression: coll,
        type: 'collocation',
        meaning: `Common collocation with '${entry.word}'`,
        arabicMeaning: `تعبير متلازم شائع مع '${entry.word}'`,
      });
    }
  }

  // Add expressions
  if (entry.commonExpressions) {
    for (const expr of entry.commonExpressions) {
      expressionCandidates.push({
        expression: expr,
        type: 'common_expression',
        meaning: `Idiomatic or common expression: '${expr}'`,
        arabicMeaning: `تعبير اصطلاحي شائع: '${expr}'`,
      });
    }
  }

  // Add phrasal uses
  if (entry.phrasalUses) {
    for (const phr of entry.phrasalUses) {
      expressionCandidates.push({
        expression: phr,
        type: 'phrasal_verb',
        meaning: `Phrasal usage of '${entry.word}': '${phr}'`,
        arabicMeaning: `فعل مركب من '${entry.word}': '${phr}'`,
      });
    }
  }

  return {
    wordCandidate,
    senseCandidates,
    expressionCandidates,
    reviewAction: {
      suggestedItem: entry.word,
      targetType: 'vocabulary',
      prompt: `Review word '${entry.word}' across all ${entry.senses.length} senses`,
    },
    speakingPracticeAction: {
      topic: `Using multiple meanings of "${entry.word}"`,
      prompt: `Practice using "${entry.word}" in different contexts: ${entry.senses
        .slice(0, 3)
        .map((s) => `(${s.distinction})`)
        .join(', ')}`,
      targetSenses: entry.senses.map((s) => s.distinction),
    },
  };
}
