/**
 * src/translation/prompts.ts
 *
 * Structured prompts for English <-> Arabic translation and document blocks.
 * Employs provider-neutral ConversationRequest compatible with existing AIProvider.
 */

import type { ConversationRequest } from '../conversation-engine/types';
import type { CoachingContext } from '../learner-model';
import type {
  DocumentBlock,
  TranslationDirection,
  TranslationOptions,
} from './types';

/**
 * Creates a neutral coaching context for translation operations.
 */
export function createNeutralTranslationCoachingContext(): CoachingContext {
  return {
    profile: {
      learnerId: '',
      displayName: '',
      currentLevel: 'unknown',
      targetLevel: 'unknown',
      learningGoals: [],
      preferredModes: [],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentConversations: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Detects whether the predominant script of the text is Arabic or English.
 */
export function detectLanguageDirection(text: string): TranslationDirection {
  if (!text) return 'en-to-ar';
  // Arabic Unicode range \u0600-\u06FF, \u0750-\u077F, \u08A0-\u08FF
  const arabicMatches = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g);
  const latinMatches = text.match(/[A-Za-z]/g);

  const arabicCount = arabicMatches ? arabicMatches.length : 0;
  const latinCount = latinMatches ? latinMatches.length : 0;

  return arabicCount > latinCount ? 'ar-to-en' : 'en-to-ar';
}

/**
 * Builds structured ConversationRequest for text translation with pedagogical metadata.
 */
export function buildTextTranslationRequest(
  text: string,
  options?: TranslationOptions
): ConversationRequest {
  const direction = options?.direction ?? detectLanguageDirection(text);
  const style = options?.style ?? 'natural';
  const arabicVariety = options?.arabicVariety ?? 'msa';

  const varietyInstruction =
    arabicVariety === 'egyptian'
      ? 'Use natural Egyptian Arabic dialect (اللهجة المصرية) for Arabic text.'
      : 'Use natural Modern Standard Arabic (الفصحى المعاصرة) for Arabic text. Do NOT use regional colloquial dialects unless explicitly requested.';

  const styleInstruction =
    style === 'literal'
      ? 'Emphasize literal, word-by-word structural accuracy while preserving basic sense.'
      : style === 'professional'
        ? 'Use formal, professional, clear tone suitable for business or academic documents.'
        : 'Use natural, fluent phrasing that sounds like a native speaker while faithfully preserving meaning.';

  const directionInstruction =
    direction === 'en-to-ar'
      ? 'Source Language: English. Target Language: Arabic.'
      : 'Source Language: Arabic. Target Language: English.';

  const systemPrompt = `You are an expert professional translator and bilingual English-Arabic language tutor.
${directionInstruction}

STYLE & ARABIC GUIDELINES:
- ${varietyInstruction}
- ${styleInstruction}
- Faithfully preserve meaning; avoid altering nuances merely to sound flowery.
- Preserve proper names, numbers, acronyms, and formatting accurately.

DISTINCTIONS & LEARNING HOOKS:
1. "translatedText": The main, high-quality translation.
2. "literalTranslation": Provide a literal/word-for-word translation ONLY when it is genuinely pedagogically useful (e.g. for idioms, metaphors, or culturally specific phrases). If the sentence is already direct, return null.
3. "alternatives": Array of alternative translations ONLY if there are genuinely distinct, equally natural ways to translate this sentence.
4. "explanation": A concise linguistic or cultural explanation if any phrase requires cultural/contextual unpacking; otherwise null.
5. "learningNotes": Array of useful grammar, collocation, or usage notes for an English learner.
6. "learningCandidates": Extract useful English learning items from the text:
   - "vocabulary": array of { "headword", "partOfSpeech", "contextMeaning", "arabicMeaning" }
   - "expressions": array of { "expression", "meaning", "arabicMeaning" }
   - "collocations": array of { "collocation", "usageNote" }
   - "phrasalVerbs": array of { "phrasalVerb", "meaning", "exampleInText" }

OUTPUT STRICTLY VALID JSON ONLY matching this schema:
{
  "translatedText": "...",
  "direction": "${direction}",
  "style": "${style}",
  "arabicVariety": "${arabicVariety}",
  "literalTranslation": "..." | null,
  "alternatives": ["..."],
  "explanation": "..." | null,
  "learningNotes": ["..."],
  "learningCandidates": {
    "vocabulary": [],
    "expressions": [],
    "collocations": [],
    "phrasalVerbs": []
  }
}`;

  return {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Translate the following text:\n"""\n${text}\n"""\n\nReturn strictly valid JSON.`,
      },
    ],
    mode: 'coach',
    topic: `Translation: ${direction}`,
    coachingContext: createNeutralTranslationCoachingContext(),
  };
}

/**
 * Builds structured ConversationRequest for translating document blocks while preserving IDs.
 */
export function buildDocumentBlocksTranslationRequest(
  blocks: readonly DocumentBlock[],
  options?: TranslationOptions
): ConversationRequest {
  const sampleText = blocks.map((b) => b.text).join(' ');
  const direction = options?.direction ?? detectLanguageDirection(sampleText);
  const arabicVariety = options?.arabicVariety ?? 'msa';

  const varietyInstruction =
    arabicVariety === 'egyptian'
      ? 'Use Egyptian Arabic dialect (اللهجة المصرية).'
      : 'Use Modern Standard Arabic (الفصحى المعاصرة).';

  const systemPrompt = `You are an expert document translation engine.
Translate the provided document blocks from ${direction === 'en-to-ar' ? 'English to Arabic' : 'Arabic to English'}.
Target Arabic variety: ${varietyInstruction}

STRICT REQUIREMENTS:
1. You MUST retain every block's exact "id" and "order".
2. Do NOT merge blocks or change the order of blocks.
3. Translate the text faithfully according to block type (title, heading, paragraph, list_item, table_cell).
4. Output MUST be ONLY valid JSON matching this schema:
{
  "blocks": [
    {
      "id": "block-id",
      "type": "paragraph",
      "order": 0,
      "originalText": "...",
      "translatedText": "...",
      "alternatives": ["..."]
    }
  ]
}`;

  const payload = blocks.map((b) => ({
    id: b.id,
    type: b.type,
    order: b.order,
    text: b.text,
  }));

  return {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Translate the following document blocks:\n${JSON.stringify(payload, null, 2)}\n\nReturn strictly valid JSON.`,
      },
    ],
    mode: 'coach',
    topic: 'Document Blocks Translation',
    coachingContext: createNeutralTranslationCoachingContext(),
  };
}
