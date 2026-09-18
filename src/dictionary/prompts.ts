/**
 * src/dictionary/prompts.ts
 *
 * Structured prompts for Dictionary lookup and contextual sense disambiguation.
 * Uses provider-neutral ConversationRequest compatible with existing AIProvider.
 */

import type { ConversationRequest } from '../conversation-engine/types';
import type { CoachingContext } from '../learner-model';
import type { ResolveContextMeaningInput } from './types';

/**
 * Creates a neutral coaching context for dictionary operations where no
 * active learner profile or conversation history is applicable.
 */
export function createNeutralDictionaryCoachingContext(): CoachingContext {
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
 * Builds the structured ConversationRequest for comprehensive dictionary lookup.
 */
export function buildDictionaryLookupRequest(word: string): ConversationRequest {
  const cleanWord = word.trim();
  const systemPrompt = `You are an expert bilingual English-Arabic lexicographer and English language teacher.
Analyze the given English word and output a structured lexical breakdown.

STRICT REQUIREMENTS:
1. Arabic must be natural Modern Standard Arabic (الفصحى), accurate and context-appropriate.
2. SENSES: Identify ALL common and meaningful senses of the word. Do NOT mix multiple meanings into one vague definition.
   Every meaningful sense MUST have BOTH a genuine English definition AND a genuine Arabic meaning. NEVER copy one language into the other.
   Every meaningful sense must have:
   - senseId: unique identifier like "sense-1", "sense-2", etc.
   - partOfSpeech: "noun" | "verb" | "adjective" | "adverb" | "preposition" | "conjunction" | "pronoun" | "phrase" | "phrasal_verb" | "other"
   - distinction: concise label distinguishing this sense from other senses (e.g., "operate or manage", "physical movement on foot")
   - englishDefinition: clear English explanation (MUST be real English)
   - arabicMeaning: precise Arabic equivalent for THIS specific sense (MUST be real Arabic)
   - examples: array of natural sentences demonstrating this sense, each with "english", "arabic" translation, and "context" (e.g. "business", "everyday conversation")
   - contexts: array of domain/context labels (e.g. ["business", "management"])
   - register: "formal" | "neutral" | "informal" | "slang" | "professional"
   - collocations: common collocations for this sense (e.g. ["run a company", "run a meeting"])
   - phrasalVerbs: relevant phrasal verbs connected to this sense or word if applicable
   - commonMistakes: genuine learner pitfalls if applicable (e.g. preposition confusion, false friends)
3. EXPRESSIONS: Provide key idioms, collocations, and phrasal verbs with their actual English and Arabic meanings:
   - expression: the phrase or collocation
   - englishMeaning: the genuine English meaning
   - arabicMeaning: the genuine Arabic meaning in MSA
   - type: "collocation" | "idiom" | "phrasal_verb" | "common_expression"
   - exampleSentence: an optional authentic example sentence
4. Pronunciation: provide IPA and phonetic spelling if confident; otherwise null.
5. Output MUST be ONLY valid JSON matching this schema:
{
  "word": "${cleanWord}",
  "pronunciation": {
    "ipa": "/.../",
    "phoneticSpelling": "..."
  },
  "primaryPartOfSpeech": "verb" | "noun" | "adjective" | "adverb" | "phrase" | "other",
  "senses": [
    {
      "senseId": "sense-1",
      "partOfSpeech": "verb",
      "distinction": "...",
      "englishDefinition": "...",
      "arabicMeaning": "...",
      "examples": [
        { "id": "ex-1", "english": "...", "arabic": "...", "context": "..." }
      ],
      "contexts": ["..."],
      "register": "neutral",
      "collocations": ["..."],
      "phrasalVerbs": ["..."],
      "commonMistakes": ["..."]
    }
  ],
  "expressions": [
    {
      "expression": "...",
      "englishMeaning": "...",
      "arabicMeaning": "...",
      "type": "collocation" | "idiom" | "phrasal_verb" | "common_expression",
      "exampleSentence": "..."
    }
  ],
  "commonExpressions": ["..."],
  "collocations": ["..."],
  "phrasalUses": ["..."],
  "learnerMistakes": ["..."]
}`;

  return {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Provide the full dictionary breakdown for the English word: "${cleanWord}". Return strictly JSON.`,
      },
    ],
    mode: 'coach',
    topic: `Dictionary lookup: ${cleanWord}`,
    coachingContext: createNeutralDictionaryCoachingContext(),
  };
}

/**
 * Builds the structured ConversationRequest for contextual word sense disambiguation.
 */
export function buildContextMeaningRequest(input: ResolveContextMeaningInput): ConversationRequest {
  const cleanWord = input.word.trim();
  const cleanSentence = input.sentence.trim();

  let knownSensesPrompt = '';
  if (input.knownSenses && input.knownSenses.length > 0) {
    knownSensesPrompt = `\nKnown senses for "${cleanWord}":\n` +
      input.knownSenses
        .map(
          (s, idx) =>
            `${idx + 1}. [ID: ${s.senseId}] (${s.partOfSpeech}) ${s.distinction} - EN: ${s.englishDefinition} | AR: ${s.arabicMeaning}`
        )
        .join('\n');
  }

  const systemPrompt = `You are an expert bilingual English-Arabic teacher and linguist.
Determine the exact contextual meaning of an English word as used in a given sentence.

STRICT REQUIREMENTS:
1. Identify which sense is intended in the provided sentence.
2. If known senses are provided, reference the matching senseId.
3. Provide:
   - arabicMeaning: Arabic translation of the word in THIS sentence in natural Modern Standard Arabic.
   - englishExplanation: clear explanation of what the word means here.
   - whyFits: specific syntactic/semantic clues explaining why this sense applies.
   - certainty: MUST be strictly one of qualitative categories:
     "clear" | "likely" | "ambiguous" | "insufficient_context"
     DO NOT output any numbers, scores, or percentage values.
   - alternativeSense: if the sentence is genuinely ambiguous, describe the possible alternative interpretation; otherwise null.
4. Output MUST be ONLY valid JSON matching this schema:
{
  "word": "${cleanWord}",
  "sentence": "${cleanSentence}",
  "selectedSenseId": "sense-id-or-null",
  "distinction": "concise sense description",
  "arabicMeaning": "المعنى العربي في هذا السياق",
  "englishExplanation": "...",
  "whyFits": "...",
  "certainty": "clear" | "likely" | "ambiguous" | "insufficient_context",
  "alternativeSense": {
    "senseId": "...",
    "distinction": "...",
    "arabicMeaning": "...",
    "englishExplanation": "...",
    "reason": "..."
  } | null
}`;

  return {
    systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Target word: "${cleanWord}"\nSentence: "${cleanSentence}"${knownSensesPrompt}\n\nResolve the contextual meaning. Return strictly valid JSON.`,
      },
    ],
    mode: 'coach',
    topic: `Contextual meaning: ${cleanWord}`,
    coachingContext: createNeutralDictionaryCoachingContext(),
  };
}
