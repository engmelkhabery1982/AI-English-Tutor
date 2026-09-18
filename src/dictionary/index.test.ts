/**
 * src/dictionary/index.test.ts
 *
 * Tests for the Dictionary & Sense Disambiguation Core.
 * Uses fake/injected AIProvider exclusively without network or database dependencies.
 */

import { describe, expect, it } from 'vitest';
import type { AIProvider, AIProviderResult, ConversationRequest } from '../providers/ai/types';
import {
  createDictionaryService,
  createNeutralDictionaryCoachingContext,
  parseContextualMeaning,
  parseDictionaryEntry,
  validateSenseDistinctions,
} from './index';

function createMockAIProvider(
  handler: (request: ConversationRequest) => AIProviderResult
): AIProvider {
  return {
    id: 'mock-dictionary-ai',
    generate: async (request: ConversationRequest): Promise<AIProviderResult> => {
      return handler(request);
    },
  };
}

describe('Dictionary Core (Phase 1)', () => {
  const multiSenseRunJson = JSON.stringify({
    word: 'run',
    pronunciation: {
      ipa: '/rʌn/',
      phoneticSpelling: 'ruhn',
    },
    primaryPartOfSpeech: 'verb',
    senses: [
      {
        senseId: 'run-physical',
        partOfSpeech: 'verb',
        distinction: 'move swiftly on foot',
        englishDefinition: 'to move rapidly using one legs faster than walking',
        arabicMeaning: 'يركض / يجري',
        examples: [
          {
            id: 'ex-run-1',
            english: 'He runs five kilometers every morning.',
            arabic: 'هو يجري خمسة كيلومترات كل صباح.',
            context: 'daily routine',
          },
        ],
        contexts: ['sports', 'fitness', 'everyday'],
        register: 'neutral',
        collocations: ['run fast', 'run a marathon'],
        phrasalVerbs: ['run away'],
        commonMistakes: ["Do not say 'I am running by car'."],
      },
      {
        senseId: 'run-manage',
        partOfSpeech: 'verb',
        distinction: 'manage or operate',
        englishDefinition: 'to manage, direct, or be in charge of an organization or business',
        arabicMeaning: 'يدير / يتولى تشغيل',
        examples: [
          {
            id: 'ex-run-2',
            english: 'She runs a successful tech company in Cairo.',
            arabic: 'هي تدير شركة تقنية ناجحة في القاهرة.',
            context: 'business',
          },
        ],
        contexts: ['business', 'management', 'leadership'],
        register: 'professional',
        collocations: ['run a company', 'run a meeting'],
        phrasalVerbs: ['run out of'],
      },
      {
        senseId: 'run-execute',
        partOfSpeech: 'verb',
        distinction: 'execute a computer program',
        englishDefinition: 'to execute or process instructions on a computer system',
        arabicMeaning: 'يشغّل / ينفّذ برنامجاً',
        examples: [
          {
            id: 'ex-run-3',
            english: 'Run the script to deploy the database migrations.',
            arabic: 'شغّل البرنامج النصي لتنفيذ تحديثات قاعدة البيانات.',
            context: 'technology',
          },
        ],
        contexts: ['technology', 'programming'],
        register: 'professional',
        collocations: ['run a script', 'run software'],
      },
    ],
    expressions: [
      {
        expression: 'run a business',
        englishMeaning: 'to manage or direct a commercial enterprise',
        arabicMeaning: 'يدير عملاً تجارياً',
        type: 'collocation',
        exampleSentence: 'She runs a successful business in Cairo.',
      },
      {
        expression: 'run out of',
        englishMeaning: 'to use up all available supply of something',
        arabicMeaning: 'ينفد منه شيء',
        type: 'phrasal_verb',
        exampleSentence: 'We ran out of time during the meeting.',
      },
    ],
    commonExpressions: ['in the long run', 'run of the mill'],
    collocations: ['run smoothly', 'run late'],
    phrasalUses: ['run out of', 'run into', 'run over'],
    learnerMistakes: ["Conflating 'run a business' with walking quickly."],
  });

  const singleSenseBilingualJson = JSON.stringify({
    word: 'bilingual',
    pronunciation: {
      ipa: '/baɪˈlɪŋɡwəl/',
    },
    primaryPartOfSpeech: 'adjective',
    senses: [
      {
        senseId: 'bilingual-1',
        partOfSpeech: 'adjective',
        distinction: 'speaking two languages fluently',
        englishDefinition: 'able to speak and understand two languages fluently',
        arabicMeaning: 'مزدوج اللغة / ثنائي اللغة',
        examples: [
          {
            id: 'bilingual-ex-1',
            english: 'She grew up in a bilingual household speaking English and Arabic.',
            arabic: 'نشأت في أسرة ثنائية اللغة تتحدث الإنجليزية والعربية.',
            context: 'family / language',
          },
        ],
        contexts: ['linguistics', 'education', 'daily life'],
        register: 'neutral',
        collocations: ['bilingual education', 'bilingual speaker'],
      },
    ],
    collocations: ['fluent bilingual'],
  });

  it('1. parses a one-sense word properly without fabricating multiple senses', async () => {
    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: singleSenseBilingualJson },
    }));

    const service = createDictionaryService(mockProvider);
    const result = await service.lookupWord('bilingual');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.word).toBe('bilingual');
      expect(result.entry.senses).toHaveLength(1);
      expect(result.entry.senses[0].senseId).toBe('bilingual-1');
      expect(result.entry.senses[0].distinction).toBe('speaking two languages fluently');
      expect(result.entry.senses[0].arabicMeaning).toBe('مزدوج اللغة / ثنائي اللغة');
    }
  });

  it('2. parses a multi-sense word properly with distinct senses', async () => {
    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: multiSenseRunJson },
    }));

    const service = createDictionaryService(mockProvider);
    const result = await service.lookupWord('run');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.word).toBe('run');
      expect(result.entry.senses.length).toBeGreaterThanOrEqual(3);
      const senseIds = result.entry.senses.map((s) => s.senseId);
      expect(senseIds).toEqual(['run-physical', 'run-manage', 'run-execute']);
    }
  });

  it('3. ensures separate Arabic meaning per sense', async () => {
    const entry = parseDictionaryEntry(multiSenseRunJson, 'run');
    expect(entry).not.toBeNull();
    if (entry) {
      const arabicMeanings = entry.senses.map((s) => s.arabicMeaning);
      expect(arabicMeanings[0]).toContain('يركض');
      expect(arabicMeanings[1]).toContain('يدير');
      expect(arabicMeanings[2]).toContain('يشغّل');
      // Verify all Arabic meanings are distinct
      const uniqueArabic = new Set(arabicMeanings);
      expect(uniqueArabic.size).toBe(entry.senses.length);
    }
  });

  it('4. ensures separate English definition per sense', async () => {
    const entry = parseDictionaryEntry(multiSenseRunJson, 'run');
    expect(entry).not.toBeNull();
    if (entry) {
      const englishDefs = entry.senses.map((s) => s.englishDefinition);
      expect(englishDefs[0]).toContain('move rapidly');
      expect(englishDefs[1]).toContain('manage, direct');
      expect(englishDefs[2]).toContain('execute or process');
      const uniqueEnglish = new Set(englishDefs);
      expect(uniqueEnglish.size).toBe(entry.senses.length);
    }
  });

  it('5. maps examples to the correct sense', async () => {
    const entry = parseDictionaryEntry(multiSenseRunJson, 'run');
    expect(entry).not.toBeNull();
    if (entry) {
      const physicalExamples = entry.senses[0].examples;
      expect(physicalExamples[0].english).toContain('runs five kilometers');
      expect(physicalExamples[0].arabic).toContain('يجري خمسة كيلومترات');

      const manageExamples = entry.senses[1].examples;
      expect(manageExamples[0].english).toContain('runs a successful tech company');
      expect(manageExamples[0].arabic).toContain('تدير شركة تقنية ناجحة');
    }
  });

  it('6. contextual resolution selects correct sense for business context', async () => {
    const resolvedJson = JSON.stringify({
      word: 'run',
      sentence: 'He runs a medical clinic downtown.',
      selectedSenseId: 'run-manage',
      distinction: 'manage or operate',
      arabicMeaning: 'يدير',
      englishExplanation: "In this sentence, 'runs' means being in charge of managing the clinic.",
      whyFits: "The object is 'a medical clinic', which is an organization that is managed.",
      certainty: 'clear',
      alternativeSense: null,
    });

    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: resolvedJson },
    }));

    const service = createDictionaryService(mockProvider);
    const result = await service.resolveMeaningInContext({
      word: 'run',
      sentence: 'He runs a medical clinic downtown.',
    });

    expect(result.word).toBe('run');
    expect(result.selectedSenseId).toBe('run-manage');
    expect(result.arabicMeaning).toBe('يدير');
    expect(result.certainty).toBe('clear');
    expect(result.whyFits).toContain('medical clinic');
  });

  it('7. contextual resolution remains honest for ambiguous context', async () => {
    const ambiguousJson = JSON.stringify({
      word: 'run',
      sentence: 'He had to run immediately.',
      selectedSenseId: 'run-physical',
      distinction: 'move swiftly on foot',
      arabicMeaning: 'يركض / يفر بسرعة',
      englishExplanation: 'Could mean moving fast physically or departing in haste.',
      whyFits: "Without an object, 'to run' usually signifies rapid movement or departure.",
      certainty: 'ambiguous',
      alternativeSense: {
        senseId: 'run-depart',
        distinction: 'depart hurriedly',
        arabicMeaning: 'يغادر على عجل',
        englishExplanation: 'Informally used for leaving urgently.',
        reason: "Could mean 'leave urgently' rather than athletic running.",
      },
    });

    const mockProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: ambiguousJson },
    }));

    const service = createDictionaryService(mockProvider);
    const result = await service.resolveMeaningInContext({
      word: 'run',
      sentence: 'He had to run immediately.',
    });

    expect(result.certainty).toBe('ambiguous');
    expect(result.alternativeSense).not.toBeNull();
    expect(result.alternativeSense?.arabicMeaning).toBe('يغادر على عجل');
  });

  it('8. confirms certainty uses qualitative values and no confidence percentage', async () => {
    const rawAiOutput = JSON.stringify({
      word: 'spring',
      sentence: 'Water began to spring from the rock.',
      arabicMeaning: 'ينبع / يتدفق',
      englishExplanation: 'To emerge suddenly or flow out.',
      whyFits: "Subject is 'water' and preposition is 'from'.",
      certainty: 'clear',
      // Ensure that if AI mistakenly attempts to include a percentage, the parser discards it
      confidencePercent: 98,
    });

    const parsed = parseContextualMeaning(
      rawAiOutput,
      'spring',
      'Water began to spring from the rock.'
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.certainty).toBe('clear');
    // Ensure no score property exists in the parsed result type
    expect((parsed as unknown as Record<string, unknown>).confidencePercent).toBeUndefined();
    expect((parsed as unknown as Record<string, unknown>).score).toBeUndefined();
  });

  it('validates multi-meaning training plan creation', () => {
    const entry = parseDictionaryEntry(multiSenseRunJson, 'run');
    expect(entry).not.toBeNull();
    if (entry) {
      const mockProvider = createMockAIProvider(() => ({
        ok: true,
        response: { content: '{}' },
      }));
      const service = createDictionaryService(mockProvider);
      const plan = service.createMultiSenseTraining(entry);

      expect(plan.word).toBe('run');
      expect(plan.senseCount).toBe(3);
      expect(plan.items).toHaveLength(3);

      // Verify each sense is drilled
      expect(plan.items[0].senseId).toBe('run-physical');
      expect(plan.items[1].senseId).toBe('run-manage');
      expect(plan.items[2].senseId).toBe('run-execute');

      // Verify distractors are drawn from other senses
      expect(plan.items[0].distractorChoices.some((d) => d.includes('يدير'))).toBe(true);
      expect(plan.items[1].distractorChoices.some((d) => d.includes('يركض'))).toBe(true);
    }
  });

  it('20. learning candidates do not auto-persist', () => {
    const entry = parseDictionaryEntry(multiSenseRunJson, 'run');
    expect(entry).not.toBeNull();
    if (entry) {
      const mockProvider = createMockAIProvider(() => ({
        ok: true,
        response: { content: '{}' },
      }));
      const service = createDictionaryService(mockProvider);
      const candidates = service.extractLearningCandidates(entry);

      // Candidates are pure data structures ready for UI consumption
      expect(candidates.wordCandidate.headword).toBe('run');
      expect(candidates.wordCandidate.meanings).toHaveLength(3);
      expect(candidates.senseCandidates).toHaveLength(3);
      expect(candidates.expressionCandidates.length).toBeGreaterThan(0);
      expect(candidates.reviewAction.suggestedItem).toBe('run');
      expect(candidates.speakingPracticeAction.targetSenses.length).toBe(3);
    }
  });

  it('22. existing AIProvider is reused without SDK duplication', async () => {
    let capturedRequest: ConversationRequest | null = null;

    const mockProvider = createMockAIProvider((req) => {
      capturedRequest = req;
      return {
        ok: true,
        response: { content: singleSenseBilingualJson },
      };
    });

    const service = createDictionaryService(mockProvider);
    await service.lookupWord('bilingual');

    expect(capturedRequest).not.toBeNull();
    const req = capturedRequest as ConversationRequest | null;
    expect(req?.systemPrompt).toContain('bilingual English-Arabic lexicographer');
    expect(req?.coachingContext.profile.currentLevel).toBe('unknown');
  });

  it('handles AI failure honestly without inventing success', async () => {
    const mockFailingProvider = createMockAIProvider(() => ({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'AI service temporarily unavailable.',
        retryable: true,
      },
    }));

    const service = createDictionaryService(mockFailingProvider);
    const result = await service.lookupWord('resilience');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.word).toBe('resilience');
      expect(result.error.code).toBe('ai_unavailable');
      expect(result.error.message).toContain('AI service temporarily unavailable');
    }
  });

  it('handles malformed AI structured output safely', async () => {
    const mockMalformedProvider = createMockAIProvider(() => ({
      ok: true,
      response: { content: 'This is not json at all!' },
    }));

    const service = createDictionaryService(mockMalformedProvider);
    const result = await service.lookupWord('serendipity');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_response');
    }
  });

  it('verifies neutral dictionary coaching context and sense distinction validation', () => {
    const neutralCtx = createNeutralDictionaryCoachingContext();
    expect(neutralCtx.profile.currentLevel).toBe('unknown');
    expect(neutralCtx.profile.displayName).toBe('');

    const entry = parseDictionaryEntry(multiSenseRunJson, 'run');
    expect(entry).not.toBeNull();
    if (entry) {
      const check = validateSenseDistinctions(entry.senses);
      expect(check.valid).toBe(true);
      expect(check.duplicateCount).toBe(0);
    }
  });

  it('enforces bilingual integrity: drops senses lacking real English or Arabic without cross-copying', () => {
    const rawWithMissingFields = JSON.stringify({
      word: 'lead',
      primaryPartOfSpeech: 'verb',
      senses: [
        {
          senseId: 'lead-guide',
          partOfSpeech: 'verb',
          distinction: 'guide or direct',
          englishDefinition: 'to guide on a way especially by going in advance',
          arabicMeaning: 'يقود / يرشد',
          examples: [
            { id: 'ex-1', english: 'She led the team.', arabic: 'قادت الفريق.' },
          ],
        },
        {
          senseId: 'lead-missing-arabic',
          partOfSpeech: 'verb',
          distinction: 'cause to happen',
          englishDefinition: 'to culminate in a specific result',
          // arabicMeaning missing!
          examples: [],
        },
        {
          senseId: 'lead-missing-english',
          partOfSpeech: 'verb',
          distinction: 'lead mineral',
          // englishDefinition missing!
          arabicMeaning: 'عنصر الرصاص الكيميائي',
          examples: [],
        },
      ],
    });

    const parsed = parseDictionaryEntry(rawWithMissingFields, 'lead');
    expect(parsed).not.toBeNull();
    // Only the valid sense with both English and Arabic should be kept
    expect(parsed?.senses).toHaveLength(1);
    expect(parsed?.senses[0].senseId).toBe('lead-guide');
    expect(parsed?.senses[0].englishDefinition).toBe('to guide on a way especially by going in advance');
    expect(parsed?.senses[0].arabicMeaning).toBe('يقود / يرشد');

    // Completely invalid entry where no sense has both fields
    const completelyInvalidJson = JSON.stringify({
      word: 'bad',
      primaryPartOfSpeech: 'adjective',
      senses: [
        { senseId: 'bad-1', englishDefinition: 'something not good' }, // no arabic
      ],
    });
    expect(parseDictionaryEntry(completelyInvalidJson, 'bad')).toBeNull();
  });

  it('enforces real expression semantic data and excludes placeholders', () => {
    const rawWithExpressions = JSON.stringify({
      word: 'take',
      primaryPartOfSpeech: 'verb',
      senses: [
        {
          senseId: 'take-grasp',
          partOfSpeech: 'verb',
          distinction: 'grasp or hold',
          englishDefinition: 'to reach out and get into one hands',
          arabicMeaning: 'يأخذ / يمسك',
          examples: [{ id: 'ex-1', english: 'Take my hand.', arabic: 'أمسك بيدي.' }],
        },
      ],
      // Raw string lists without meanings
      commonExpressions: ['take off', 'take for granted'],
      collocations: ['take time'],
      // Real structured expressions with semantic meanings
      expressions: [
        {
          expression: 'take into account',
          englishMeaning: 'to consider or remember something when assessing a situation',
          arabicMeaning: 'يأخذ بعين الاعتبار',
          type: 'idiom',
          exampleSentence: 'We must take all costs into account.',
        },
        {
          expression: 'incomplete expression lacking arabic',
          englishMeaning: 'an explanation without translation',
          // arabicMeaning missing!
        },
      ],
    });

    const entry = parseDictionaryEntry(rawWithExpressions, 'take');
    expect(entry).not.toBeNull();
    if (entry) {
      expect(entry.expressions).toHaveLength(1);
      expect(entry.expressions?.[0].expression).toBe('take into account');

      const candidates = createDictionaryService(
        createMockAIProvider(() => ({ ok: true, response: { content: '{}' } }))
      ).extractLearningCandidates(entry);

      // Only the expression with real semantic data should be exposed
      expect(candidates.expressionCandidates).toHaveLength(1);
      expect(candidates.expressionCandidates[0].expression).toBe('take into account');
      expect(candidates.expressionCandidates[0].meaning).toBe(
        'to consider or remember something when assessing a situation'
      );
      expect(candidates.expressionCandidates[0].arabicMeaning).toBe('يأخذ بعين الاعتبار');
      expect(candidates.expressionCandidates[0].meaning).not.toContain('Common collocation with');
      expect(candidates.expressionCandidates[0].arabicMeaning).not.toContain('تعبير متلازم شائع');
    }
  });

  it('builds grounded training plans: omits senses without examples and draws distractors from real senses', () => {
    const entry = parseDictionaryEntry(
      JSON.stringify({
        word: 'break',
        primaryPartOfSpeech: 'verb',
        senses: [
          {
            senseId: 'break-fracture',
            partOfSpeech: 'verb',
            distinction: 'separate into pieces',
            englishDefinition: 'to separate into parts with suddenness or violence',
            arabicMeaning: 'يكسر / يحطّم',
            examples: [
              {
                id: 'ex-b-1',
                english: 'The vase broke into pieces.',
                arabic: 'انكسرت المزهرية إلى قطع.',
              },
            ],
          },
          {
            senseId: 'break-rest',
            partOfSpeech: 'noun',
            distinction: 'short rest period',
            englishDefinition: 'a pause or period of rest in work or activity',
            arabicMeaning: 'استراحة / فترة راحة',
            examples: [
              {
                id: 'ex-b-2',
                english: 'Let us take a ten-minute coffee break.',
                arabic: 'دعونا نأخذ استراحة قهوة لعشر دقائق.',
              },
            ],
          },
          {
            senseId: 'break-no-examples',
            partOfSpeech: 'verb',
            distinction: 'violate a law',
            englishDefinition: 'to fail to observe a law or regulation',
            arabicMeaning: 'يخالف / ينتهك قانوناً',
            // No examples provided!
            examples: [],
          },
        ],
      }),
      'break'
    );

    expect(entry).not.toBeNull();
    if (entry) {
      const service = createDictionaryService(
        createMockAIProvider(() => ({ ok: true, response: { content: '{}' } }))
      );
      const plan = service.createMultiSenseTraining(entry);

      // Sense with no examples must be safely omitted
      expect(plan.items).toHaveLength(2);
      expect(plan.items.map((i) => i.senseId)).toEqual(['break-fracture', 'break-rest']);

      // Distractors must come from real other senses
      expect(plan.items[0].distractorChoices).toContain('short rest period (استراحة / فترة راحة)');
      expect(plan.items[1].distractorChoices).toContain('separate into pieces (يكسر / يحطّم)');
      // Never contains fake strings
      expect(plan.items[0].distractorChoices).not.toContain('Opposite meaning / unrelated action');
    }
  });

  it('handles single-sense words in training without fabricating distractors', () => {
    const entry = parseDictionaryEntry(singleSenseBilingualJson, 'bilingual');
    expect(entry).not.toBeNull();
    if (entry) {
      const service = createDictionaryService(
        createMockAIProvider(() => ({ ok: true, response: { content: '{}' } }))
      );
      const plan = service.createMultiSenseTraining(entry);

      expect(plan.items).toHaveLength(1);
      const item = plan.items[0];
      expect(item.distractorChoices).toHaveLength(0);
      expect(item.isQualitativePractice).toBe(true);
      expect(item.comprehensionQuestion).toContain('Review the usage of');
    }
  });

  describe('Contextual Meaning Parser Honesty Regression Tests (Blocker 2)', () => {
    const validPayload = {
      word: 'run',
      sentence: 'He runs a company.',
      selectedSenseId: 'run-manage',
      distinction: 'manage or operate',
      arabicMeaning: 'يدير',
      englishExplanation: 'In charge of managing an organization.',
      whyFits: 'The direct object is a business organization.',
      certainty: 'clear',
      alternativeSense: null,
    };

    it('valid complete result still parses successfully', () => {
      const parsed = parseContextualMeaning(
        JSON.stringify(validPayload),
        'run',
        'He runs a company.'
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.arabicMeaning).toBe('يدير');
      expect(parsed?.englishExplanation).toBe('In charge of managing an organization.');
      expect(parsed?.whyFits).toBe('The direct object is a business organization.');
      expect(parsed?.certainty).toBe('clear');
    });

    it('missing whyFits => parser rejects (returns null)', () => {
      const payload = { ...validPayload };
      delete (payload as Record<string, unknown>).whyFits;

      const parsed = parseContextualMeaning(
        JSON.stringify(payload),
        'run',
        'He runs a company.'
      );
      expect(parsed).toBeNull();
    });

    it('whitespace-only whyFits => parser rejects (returns null)', () => {
      const payload = { ...validPayload, whyFits: '   \n  ' };
      const parsed = parseContextualMeaning(
        JSON.stringify(payload),
        'run',
        'He runs a company.'
      );
      expect(parsed).toBeNull();
    });

    it('invalid certainty => parser rejects (returns null) and does not default to likely', () => {
      const payload = { ...validPayload, certainty: 'absolutely_certain_99%' };
      const parsed = parseContextualMeaning(
        JSON.stringify(payload),
        'run',
        'He runs a company.'
      );
      expect(parsed).toBeNull();
    });

    it('missing certainty => parser rejects (returns null)', () => {
      const payload = { ...validPayload };
      delete (payload as Record<string, unknown>).certainty;

      const parsed = parseContextualMeaning(
        JSON.stringify(payload),
        'run',
        'He runs a company.'
      );
      expect(parsed).toBeNull();
    });

    it('missing Arabic meaning => parser rejects (returns null)', () => {
      const payload = { ...validPayload, arabicMeaning: '' };
      const parsed = parseContextualMeaning(
        JSON.stringify(payload),
        'run',
        'He runs a company.'
      );
      expect(parsed).toBeNull();
    });

    it('missing English explanation => parser rejects (returns null)', () => {
      const payload = { ...validPayload, englishExplanation: '   ' };
      const parsed = parseContextualMeaning(
        JSON.stringify(payload),
        'run',
        'He runs a company.'
      );
      expect(parsed).toBeNull();
    });

    it('alternativeSense is omitted when missing required fields', () => {
      const payloadWithIncompleteAlt = {
        ...validPayload,
        alternativeSense: {
          senseId: 'run-physical',
          // arabicMeaning missing
          englishExplanation: 'Physical running',
          reason: 'Could be running physically',
        },
      };

      const parsed = parseContextualMeaning(
        JSON.stringify(payloadWithIncompleteAlt),
        'run',
        'He runs a company.'
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.alternativeSense).toBeNull();
    });
  });

  describe('Known Sense ID Validation Tests (Blocker 3)', () => {
    const knownSenses = [
      {
        senseId: 'run-physical',
        partOfSpeech: 'verb' as const,
        distinction: 'move fast on foot',
        englishDefinition: 'to move swiftly on foot',
        arabicMeaning: 'يركض',
        examples: [],
        contexts: ['sports'],
      },
      {
        senseId: 'run-manage',
        partOfSpeech: 'verb' as const,
        distinction: 'manage or operate',
        englishDefinition: 'to manage an organization',
        arabicMeaning: 'يدير',
        examples: [],
        contexts: ['business'],
      },
    ];

    it('valid known selectedSenseId accepted when knownSenses are supplied', async () => {
      const aiResponse = JSON.stringify({
        word: 'run',
        sentence: 'She runs the clinic.',
        selectedSenseId: 'run-manage',
        distinction: 'manage or operate',
        arabicMeaning: 'يدير',
        englishExplanation: 'Managing a facility.',
        whyFits: 'Clinic is an organization.',
        certainty: 'clear',
        alternativeSense: null,
      });

      const service = createDictionaryService(
        createMockAIProvider(() => ({
          ok: true,
          response: { content: aiResponse },
        }))
      );

      const result = await service.resolveMeaningInContext({
        word: 'run',
        sentence: 'She runs the clinic.',
        knownSenses,
      });

      expect(result.certainty).toBe('clear');
      expect(result.selectedSenseId).toBe('run-manage');
      expect(result.arabicMeaning).toBe('يدير');
    });

    it('unknown selectedSenseId rejected safely with honest insufficient_context', async () => {
      const aiResponse = JSON.stringify({
        word: 'run',
        sentence: 'She runs the clinic.',
        selectedSenseId: 'run-hallucinated-id-999',
        distinction: 'hallucinated distinction',
        arabicMeaning: 'يدير',
        englishExplanation: 'Managing a facility.',
        whyFits: 'Clinic is an organization.',
        certainty: 'clear',
        alternativeSense: null,
      });

      const service = createDictionaryService(
        createMockAIProvider(() => ({
          ok: true,
          response: { content: aiResponse },
        }))
      );

      const result = await service.resolveMeaningInContext({
        word: 'run',
        sentence: 'She runs the clinic.',
        knownSenses,
      });

      expect(result.certainty).toBe('insufficient_context');
      expect(result.selectedSenseId).toBeUndefined();
      expect(result.englishExplanation).toContain('did not match the supplied known senses');
      expect(result.whyFits).toContain('Sense ID mismatch with known senses');
    });

    it('unknown alternativeSense ID is omitted rather than exposed as valid', async () => {
      const aiResponse = JSON.stringify({
        word: 'run',
        sentence: 'She had to run.',
        selectedSenseId: 'run-physical',
        distinction: 'move fast on foot',
        arabicMeaning: 'يركض',
        englishExplanation: 'Moving swiftly.',
        whyFits: 'Speed context.',
        certainty: 'likely',
        alternativeSense: {
          senseId: 'run-hallucinated-alt-id',
          distinction: 'hallucinated alt',
          arabicMeaning: 'معنى بديل غير موجود',
          englishExplanation: 'Alternative meaning not in known list',
          reason: 'Context is ambiguous',
        },
      });

      const service = createDictionaryService(
        createMockAIProvider(() => ({
          ok: true,
          response: { content: aiResponse },
        }))
      );

      const result = await service.resolveMeaningInContext({
        word: 'run',
        sentence: 'She had to run.',
        knownSenses,
      });

      // selectedSenseId was valid ('run-physical')
      expect(result.selectedSenseId).toBe('run-physical');
      expect(result.certainty).toBe('likely');
      // But hallucinated alternative sense ID must be omitted (set to null)
      expect(result.alternativeSense).toBeNull();
    });

    it('valid alternativeSense ID is preserved when in knownSenses', async () => {
      const aiResponse = JSON.stringify({
        word: 'run',
        sentence: 'She had to run.',
        selectedSenseId: 'run-physical',
        distinction: 'move fast on foot',
        arabicMeaning: 'يركض',
        englishExplanation: 'Moving swiftly.',
        whyFits: 'Speed context.',
        certainty: 'likely',
        alternativeSense: {
          senseId: 'run-manage',
          distinction: 'manage or operate',
          arabicMeaning: 'يدير',
          englishExplanation: 'Could manage something',
          reason: 'Ambiguous phrasing',
        },
      });

      const service = createDictionaryService(
        createMockAIProvider(() => ({
          ok: true,
          response: { content: aiResponse },
        }))
      );

      const result = await service.resolveMeaningInContext({
        word: 'run',
        sentence: 'She had to run.',
        knownSenses,
      });

      expect(result.selectedSenseId).toBe('run-physical');
      expect(result.alternativeSense).not.toBeNull();
      expect(result.alternativeSense?.senseId).toBe('run-manage');
    });

    it('behavior without knownSenses remains unchanged', async () => {
      const aiResponse = JSON.stringify({
        word: 'run',
        sentence: 'She runs the clinic.',
        selectedSenseId: 'any-arbitrary-sense-id',
        distinction: 'manage',
        arabicMeaning: 'يدير',
        englishExplanation: 'Managing.',
        whyFits: 'Valid context reason.',
        certainty: 'clear',
        alternativeSense: null,
      });

      const service = createDictionaryService(
        createMockAIProvider(() => ({
          ok: true,
          response: { content: aiResponse },
        }))
      );

      const result = await service.resolveMeaningInContext({
        word: 'run',
        sentence: 'She runs the clinic.',
        // no knownSenses
      });

      expect(result.certainty).toBe('clear');
      expect(result.selectedSenseId).toBe('any-arbitrary-sense-id');
      expect(result.arabicMeaning).toBe('يدير');
    });
  });
});
