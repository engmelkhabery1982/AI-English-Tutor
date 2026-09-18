/**
 * src/listening/ai-material.test.ts
 *
 * WP-1 — Phase 5 tests: listening integration with controlled AI material.
 *
 * Strategy: exercise the REAL listening planner / service against the REAL
 * SQLite repositories (SqlJsAdapter) with injected fake AI providers, so
 * exercise construction, evaluator consistency, deterministic fallback,
 * provenance honesty and bounded reads are verified without network, audio or
 * a real TTS voice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteExpressionRepository,
  SQLiteProgressRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import type { ListeningExercise } from './types';
import { ListeningService } from './service';
import { planListeningSession, stableReferenceId } from './generator';
import {
  deterministicProvenanceForSource,
  generateListeningExercise,
  listeningEvidenceFromWeaknesses,
  listeningDifficultyFor,
  validateListeningMaterialConsistency,
} from './ai-material';
import { resolveDifficultyProfile } from '../learning-progression';
import { buildContentRequest, generateControlledMaterial } from '../content-generation';
import type { GeneratedMaterial } from '../content-generation';

const NOW = '2026-09-18T12:00:00.000Z';

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  expressions: SQLiteExpressionRepository;
  review: SQLiteReviewRepository;
  profileRepo: SQLiteUserProfileRepository;
}

async function createContext(currentLevel = 'B1'): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Listening WP1 Tester',
    currentLevel: currentLevel as 'B1',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });
  return {
    adapter,
    learnerId: profile.id,
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    profileRepo,
  };
}

function createService(
  ctx: TestContext,
  options?: { aiProvider?: AIProvider },
): ListeningService {
  return new ListeningService({
    weaknesses: {
      listWeaknesses: (learnerId, limit) => ctx.weaknesses.listWeaknesses(learnerId, limit),
      upsertWeakness: (weakness) => ctx.weaknesses.upsertWeakness(weakness),
      getWeaknessByReference: (learnerId, type, referenceId) =>
        ctx.weaknesses.getWeaknessByReference(learnerId, type, referenceId),
    },
    review: {
      upsert: (item) => ctx.review.upsert(item),
      getByReference: (learnerId, kind, referenceId) =>
        ctx.review.getByReference(learnerId, kind, referenceId),
    },
    vocabulary: ctx.vocabulary,
    expressions: ctx.expressions,
    progress: new SQLiteProgressRepository(ctx.adapter),
    aiProvider: options?.aiProvider,
    profile: ctx.profileRepo,
  });
}

/**
 * A provider that reads the requestKey/taskType out of the prompt it is given
 * and answers with VALID material for exactly that request — the closest
 * honest stand-in for a well-behaved model.
 */
function echoProvider(options?: {
  transform?: (material: Record<string, unknown>) => Record<string, unknown>;
  calls?: { count: number };
}): AIProvider {
  return {
    id: 'echo-listening-ai',
    generate: async (request): Promise<AIProviderResult> => {
      if (options?.calls) options.calls.count += 1;
      const text = request.messages.map((message) => message.content).join('\n');
      const requestKey = /"requestKey":\s*"([^"]+)"/.exec(text)?.[1] ?? '';
      const taskType = /"taskType":\s*"([^"]+)"/.exec(text)?.[1] ?? 'listen_and_type';
      const base: Record<string, unknown> = {
        requestKey,
        taskType,
        speakText: 'I usually drink coffee in the morning.',
        expectedAnswer: 'I usually drink coffee in the morning',
        keyItems: ['coffee', 'morning'],
        contextTopic: 'daily routine',
        explanation: 'Tip: listen for the stressed content words.',
      };
      if (taskType === 'missing_word') {
        base.gappedText = 'I usually drink ___ in the morning.';
        base.expectedAnswer = 'coffee';
      }
      if (taskType === 'listen_and_answer') {
        base.question = 'What does the speaker usually drink?';
        base.expectedAnswer = 'coffee';
      }
      const payload = options?.transform ? options.transform(base) : base;
      return { ok: true, response: { content: JSON.stringify(payload) } };
    },
  };
}

function always(impl: () => AIProviderResult | Promise<AIProviderResult>): AIProvider {
  return { id: 'fake-ai', generate: async () => impl() };
}

async function saveVocab(ctx: TestContext, headword: string, definition: string): Promise<void> {
  await ctx.vocabulary.upsert({
    learnerId: ctx.learnerId,
    headword,
    type: 'word',
    meanings: [{ definition, examples: [] }],
    source: { addedBy: 'learner-created', addedAt: NOW },
  });
}

async function seedListeningWeakness(ctx: TestContext, target: string): Promise<void> {
  await ctx.weaknesses.upsertWeakness({
    learnerId: ctx.learnerId,
    type: 'listening',
    referenceId: stableReferenceId(`word_recognition:${target}`),
    severity: 0.5,
    status: 'confirmed',
    lastSeenAt: NOW,
    firstSeenAt: NOW,
    occurrenceCount: 3,
    contexts: [],
    notes: `word_recognition:${target}`,
    evidence: [],
    resolved: false,
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

/* ================================================================== *
 * Internal consistency
 * ================================================================== */

function material(overrides: Partial<GeneratedMaterial> = {}): GeneratedMaterial {
  return {
    requestKey: 'key',
    taskType: 'listen_and_type',
    speakText: 'I usually drink coffee in the morning.',
    expectedAnswer: 'I usually drink coffee in the morning',
    keyItems: ['coffee', 'morning'],
    targetExpressionsUsed: [],
    newLanguageItems: 0,
    ...overrides,
  };
}

describe('listening material consistency (evaluator normalization)', () => {
  it('1. a matching listen_and_type material is consistent', () => {
    expect(validateListeningMaterialConsistency(material())).toBeNull();
  });

  it('2. a mismatch between expectedAnswer and speakText is rejected', () => {
    expect(
      validateListeningMaterialConsistency(
        material({ expectedAnswer: 'I usually drink tea in the evening' }),
      ),
    ).toBe('internal_inconsistency');
  });

  it('3. punctuation/case differences are tolerated by the shared normalization', () => {
    expect(
      validateListeningMaterialConsistency(
        material({ expectedAnswer: 'I usually drink coffee in the morning' }),
      ),
    ).toBeNull();
  });

  it('4. a valid missing_word material is consistent', () => {
    expect(
      validateListeningMaterialConsistency(
        material({
          taskType: 'missing_word',
          speakText: 'She bought fresh bread at the bakery.',
          gappedText: 'She bought fresh ___ at the bakery.',
          expectedAnswer: 'bread',
          keyItems: ['bread'],
        }),
      ),
    ).toBeNull();
  });

  it('5. a gapped text that is not the same passage is rejected', () => {
    expect(
      validateListeningMaterialConsistency(
        material({
          taskType: 'missing_word',
          speakText: 'She bought fresh bread at the bakery.',
          gappedText: 'She bought fresh ___ at the shop.',
          expectedAnswer: 'bread',
          keyItems: ['bread'],
        }),
      ),
    ).toBe('internal_inconsistency');
  });

  it('6. a gapped text that keeps the answer is rejected', () => {
    expect(
      validateListeningMaterialConsistency(
        material({
          taskType: 'missing_word',
          speakText: 'She bought fresh bread at the bakery.',
          gappedText: 'She bought fresh bread at the ___.',
          expectedAnswer: 'bread',
          keyItems: ['bread'],
        }),
      ),
    ).toBe('internal_inconsistency');
  });

  it('7. an answer that does not occur in the passage is rejected', () => {
    expect(
      validateListeningMaterialConsistency(
        material({
          taskType: 'missing_word',
          speakText: 'She bought fresh bread at the bakery.',
          gappedText: 'She bought fresh ___ at the bakery.',
          expectedAnswer: 'croissant',
          keyItems: ['bread'],
        }),
      ),
    ).toBe('internal_inconsistency');
  });

  it('8. an absent key item is rejected', () => {
    expect(
      validateListeningMaterialConsistency(material({ keyItems: ['coffee', 'bicycle'] })),
    ).toBe('internal_inconsistency');
  });

  it('9. a question that reveals the expected answer is rejected', () => {
    expect(
      validateListeningMaterialConsistency(
        material({
          taskType: 'listen_and_answer',
          speakText: 'I usually drink coffee in the morning.',
          expectedAnswer: 'coffee',
          question: 'Does the speaker drink coffee?',
          keyItems: ['coffee'],
        }),
      ),
    ).toBe('internal_inconsistency');
  });

  it('10. a genuine comprehension question is accepted', () => {
    expect(
      validateListeningMaterialConsistency(
        material({
          taskType: 'listen_and_answer',
          speakText: 'The meeting moved from Monday to Wednesday because the manager was traveling.',
          expectedAnswer: 'the manager was traveling',
          question: 'Why did the meeting move?',
          keyItems: ['meeting', 'Wednesday'],
        }),
      ),
    ).toBeNull();
  });

  it('11. an unsupported task payload fails closed', () => {
    expect(
      validateListeningMaterialConsistency(
        material({ taskType: 'listen_and_choose' as never, question: undefined }),
      ),
    ).toBe('internal_inconsistency');
  });

  it('12. empty material text fails closed', () => {
    expect(validateListeningMaterialConsistency(material({ speakText: '   ' }))).toBe(
      'missing_text',
    );
  });
});

/* ================================================================== *
 * Generation outcomes
 * ================================================================== */

function generatedInput(overrides: Partial<Parameters<typeof generateListeningExercise>[1]> = {}) {
  return {
    learnerId: 'learner-1',
    level: 'B1' as const,
    knownVocabulary: [],
    targetExpressions: [],
    taskType: 'listen_and_type' as const,
    ...overrides,
  };
}

describe('generateListeningExercise outcomes', () => {
  it('13. valid material becomes a listening exercise with honest metadata', async () => {
    const outcome = await generateListeningExercise(
      echoProvider(),
      generatedInput({ level: 'B2' }),
    );
    expect(outcome.exercise).not.toBeNull();
    expect(outcome.failure).toBeNull();
    expect(outcome.provenance).toBe('general');
    expect(outcome.requestKey).toBeTruthy();
    expect(outcome.exercise?.requestKey).toBe(outcome.requestKey);
    expect(outcome.exercise?.materialOrigin).toBe('ai');
    expect(outcome.exercise?.difficulty).toBe('hard');
    expect(outcome.exercise?.source).toBe('general');
    expect(outcome.exercise?.keyItems).toEqual(['coffee', 'morning']);
  });

  it('14. malformed output falls back instead of serving material', async () => {
    const outcome = await generateListeningExercise(
      always(() => ({ ok: true, response: { content: 'Sure! Here you go.' } })),
      generatedInput(),
    );
    expect(outcome.exercise).toBeNull();
    expect(outcome.provenance).toBeNull();
    expect(outcome.failure).toBe('invalid_output');
    expect(outcome.detail).toContain('unparseable_output');
  });

  it('15. a provider timeout falls back', async () => {
    const outcome = await generateListeningExercise(
      always(() => ({
        ok: false,
        error: { code: 'timeout', message: 'timed out', retryable: true },
      })),
      generatedInput(),
    );
    expect(outcome.exercise).toBeNull();
    expect(outcome.failure).toBe('provider_timeout');
  });

  it('16. a provider that throws falls back', async () => {
    const outcome = await generateListeningExercise(
      always(() => {
        throw new Error('provider explosion');
      }),
      generatedInput(),
    );
    expect(outcome.exercise).toBeNull();
    expect(outcome.failure).toBe('provider_error');
  });

  it('17. no provider means nothing is generated (the request is still built honestly)', async () => {
    const first = await generateListeningExercise(null, generatedInput());
    const second = await generateListeningExercise(null, generatedInput());
    expect(first.exercise).toBeNull();
    expect(first.failure).toBe('no_provider');
    // The request identity is deterministic even when generation is impossible.
    expect(first.requestKey).toBeTruthy();
    expect(first.requestKey).toBe(second.requestKey);
  });

  it('18. internally inconsistent material is discarded, never persisted as practice', async () => {
    const outcome = await generateListeningExercise(
      echoProvider({
        transform: (payload) => ({ ...payload, keyItems: ['coffee', 'not-in-the-sentence'] }),
      }),
      generatedInput(),
    );
    expect(outcome.exercise).toBeNull();
    expect(outcome.failure).toBe('inconsistent_material');
    expect(outcome.requestKey).toBeTruthy();
  });

  it('19. identical content generates identically (compared by CONTENT, not by id)', async () => {
    const provider = echoProvider();
    const first = await generateListeningExercise(provider, generatedInput());
    const second = await generateListeningExercise(provider, generatedInput());
    expect(first.exercise).not.toBeNull();
    expect(second.exercise).not.toBeNull();
    if (!first.exercise || !second.exercise) return;
    // Exercise ids are random by design; the CONTENT must be identical.
    const strip = (exercise: ListeningExercise) => ({ ...exercise, id: 'x' });
    expect(strip(first.exercise)).toEqual(strip(second.exercise));
    expect(first.requestKey).toBe(second.requestKey);
  });

  it('20. an unsupported target never reaches the provider', async () => {
    const calls = { count: 0 };
    const outcome = await generateListeningExercise(
      echoProvider({ calls }),
      generatedInput({ taskType: 'listen_and_choose' as never }),
    );
    expect(outcome.failure).toBe('invalid_target');
    expect(calls.count).toBe(0);
  });

  it('21. real saved targets make the material honestly personalized', async () => {
    const outcome = await generateListeningExercise(
      echoProvider(),
      generatedInput({ targetExpressions: ['coffee'] }),
    );
    expect(outcome.exercise).not.toBeNull();
    expect(outcome.provenance).toBe('personalized');
    expect(outcome.exercise?.contentProvenance).toBe('personalized');
  });

  it('22. an unhonored requested target degrades provenance honestly', async () => {
    const outcome = await generateListeningExercise(
      echoProvider(),
      generatedInput({ targetExpressions: ['quarterly forecast'] }),
    );
    expect(outcome.exercise).not.toBeNull();
    expect(outcome.provenance).toBe('mixed');
  });
});

describe('listening-owned mappings', () => {
  it('23. difficulty bands follow the resolved difficulty profile', () => {
    expect(listeningDifficultyFor(resolveDifficultyProfile('A1', null, 'listening'))).toBe('easy');
    expect(listeningDifficultyFor(resolveDifficultyProfile('A2', null, 'listening'))).toBe('medium');
    expect(listeningDifficultyFor(resolveDifficultyProfile('B2', null, 'listening'))).toBe('hard');
    expect(listeningDifficultyFor(resolveDifficultyProfile('unknown', null, 'listening'))).toBe(
      'easy',
    );
  });

  it('24. deterministic material keeps its existing honest provenance labels', () => {
    expect(deterministicProvenanceForSource('listening_weakness')).toBe('personalized');
    expect(deterministicProvenanceForSource('due_vocabulary')).toBe('personalized');
    expect(deterministicProvenanceForSource('due_expression')).toBe('personalized');
    expect(deterministicProvenanceForSource('general')).toBe('general');
  });

  it('25. already-loaded weakness rows become resolver evidence without guessing a domain', () => {
    const evidence = listeningEvidenceFromWeaknesses([
      { type: 'listening', status: 'confirmed', resolved: false },
      { type: 'nonsense', status: 'confirmed', resolved: false },
    ]);
    expect(evidence.weaknesses).toHaveLength(1);
    expect(evidence.weaknesses[0].domain).toBe('listening');
  });
});

/* ================================================================== *
 * Planner integration
 * ================================================================== */

describe('planner integration (opt-in only)', () => {
  it('26. without the opt-in the planner makes ZERO provider calls (Adaptive Lesson path)', async () => {
    const ctx = await createContext();
    await seedListeningWeakness(ctx, 'deadline');
    await saveVocab(ctx, 'deadline', 'the latest time');
    const calls = { count: 0 };

    const planned = await planListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      { targetCount: 3, now: NOW },
    );
    expect(planned.exercises.length).toBeGreaterThan(0);
    expect(calls.count).toBe(0);
    expect(planned.exercises.every((entry) => entry.materialOrigin === 'deterministic')).toBe(true);
    expect(planned.sourceNote).not.toMatch(/generated/i);
  });

  it('27. with the opt-in the generated exercise REPLACES the general slot only', async () => {
    const ctx = await createContext();
    await seedListeningWeakness(ctx, 'deadline');
    const calls = { count: 0 };
    const planned = await planListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      {
        targetCount: 8,
        now: NOW,
        generatedContent: { provider: echoProvider({ calls }), level: 'B1', learningGoals: [] },
      },
    );
    expect(calls.count).toBe(1);
    const generated = planned.exercises.filter((entry) => entry.materialOrigin === 'ai');
    expect(generated).toHaveLength(1);
    // The personal retraining exercise is untouched.
    expect(planned.exercises.some((entry) => entry.source === 'listening_weakness')).toBe(true);
    // And the general-slot provenance is honest.
    expect(generated[0].contentProvenance).toBeDefined();
  });

  it('28. a failing provider leaves the deterministic session completely intact', async () => {
    const ctx = await createContext();
    await seedListeningWeakness(ctx, 'deadline');
    const planned = await planListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      {
        targetCount: 8,
        now: NOW,
        generatedContent: {
          provider: always(() => {
            throw new Error('down');
          }),
          level: 'B1',
          learningGoals: [],
        },
      },
    );
    expect(planned.exercises.length).toBeGreaterThan(0);
    expect(planned.exercises.every((entry) => entry.materialOrigin === 'deterministic')).toBe(true);
    expect(planned.sourceNote).toMatch(/your own words/i);
  });

  it('29. the served session is bounded and consistent even with generation on', async () => {
    const ctx = await createContext();
    await saveVocab(ctx, 'deadline', 'the latest time');
    const planned = await planListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      {
        targetCount: 10,
        now: NOW,
        generatedContent: { provider: echoProvider(), level: 'A2', learningGoals: [] },
      },
    );
    expect(planned.exercises.length).toBeLessThanOrEqual(10);
    for (const entry of planned.exercises) {
      // Every served exercise passes the SAME consistency rules.
      if (entry.materialOrigin !== 'ai') continue;
      expect(
        validateListeningMaterialConsistency({
          requestKey: entry.requestKey ?? '',
          taskType: entry.type as never,
          speakText: entry.speakText,
          ...(entry.question !== undefined ? { question: entry.question } : {}),
          ...(entry.gappedText !== undefined ? { gappedText: entry.gappedText } : {}),
          expectedAnswer: entry.expectedAnswer,
          keyItems: entry.keyItems,
          targetExpressionsUsed: [],
          newLanguageItems: 0,
        }),
      ).toBeNull();
    }
  });

  it('30. listen_and_choose and expression_in_context are NEVER generated', async () => {
    const ctx = await createContext();
    await saveVocab(ctx, 'deadline', 'the latest time');
    const planned = await planListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      {
        targetCount: 10,
        now: NOW,
        generatedContent: { provider: echoProvider(), level: 'B1', learningGoals: [] },
      },
    );
    const generatedTypes = planned.exercises
      .filter((entry) => entry.materialOrigin === 'ai')
      .map((entry) => entry.type);
    expect(generatedTypes.every((type) => type !== 'listen_and_choose')).toBe(true);
    expect(generatedTypes.every((type) => type !== 'expression_in_context')).toBe(true);
    // The deterministic choice family is still present and untouched.
    const deterministicChoices = planned.exercises.filter(
      (entry) =>
        entry.materialOrigin === 'deterministic' &&
        (entry.type === 'listen_and_choose' || entry.type === 'expression_in_context'),
    );
    expect(deterministicChoices.length).toBeGreaterThan(0);
  });

  it('31. generation adds NO repository read (bounded reads stay one each)', async () => {
    const ctx = await createContext();
    await saveVocab(ctx, 'deadline', 'the latest time');
    const listWeaknesses = vi.spyOn(ctx.weaknesses, 'listWeaknesses');
    const vocabList = vi.spyOn(ctx.vocabulary, 'list');
    const vocabListDue = vi.spyOn(ctx.vocabulary, 'listDue');
    const exprListDue = vi.spyOn(ctx.expressions, 'listDue');

    await planListeningSession(
      {
        weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
        vocabulary: ctx.vocabulary,
        expressions: ctx.expressions,
      },
      ctx.learnerId,
      {
        targetCount: 8,
        now: NOW,
        generatedContent: { provider: echoProvider(), level: 'B1', learningGoals: [] },
      },
    );

    expect(listWeaknesses).toHaveBeenCalledTimes(1);
    expect(vocabList).toHaveBeenCalledTimes(1);
    expect(vocabListDue).toHaveBeenCalledTimes(1);
    expect(exprListDue).toHaveBeenCalledTimes(1);
    expect(vocabList.mock.calls[0][1]?.limit).toBeLessThanOrEqual(20);
  });
});

/* ================================================================== *
 * Service integration
 * ================================================================== */

describe('service integration', () => {
  it('32. the serving path opts in and gets one generated exercise', async () => {
    const ctx = await createContext();
    await saveVocab(ctx, 'deadline', 'the latest time');
    const service = createService(ctx, { aiProvider: echoProvider() });
    const session = await service.startSession(ctx.learnerId, {
      now: NOW,
      allowGeneratedContent: true,
    });
    expect(session.exercises.some((entry) => entry.materialOrigin === 'ai')).toBe(true);
    expect(session.sourceNote).toMatch(/generated for this session/i);
  });

  it('33. without the opt-in the service stays fully deterministic', async () => {
    const ctx = await createContext();
    await saveVocab(ctx, 'deadline', 'the latest time');
    const calls = { count: 0 };
    const service = createService(ctx, { aiProvider: echoProvider({ calls }) });
    const session = await service.startSession(ctx.learnerId, { now: NOW });
    expect(calls.count).toBe(0);
    expect(session.exercises.every((entry) => entry.materialOrigin === 'deterministic')).toBe(true);
    expect(session.sourceNote).not.toMatch(/generated/i);
  });

  it('34. opting in without a provider changes nothing (honest general practice)', async () => {
    const ctx = await createContext();
    const service = createService(ctx);
    const session = await service.startSession(ctx.learnerId, {
      now: NOW,
      allowGeneratedContent: true,
    });
    expect(session.exercises.length).toBeGreaterThan(0);
    expect(session.exercises.every((entry) => entry.source === 'general')).toBe(true);
    expect(session.exercises.every((entry) => entry.materialOrigin === 'deterministic')).toBe(true);
  });

  it('35. a generated exercise is still evaluated by the EXISTING evaluator', async () => {
    const ctx = await createContext();
    const service = createService(ctx, { aiProvider: echoProvider() });
    const session = await service.startSession(ctx.learnerId, {
      now: NOW,
      allowGeneratedContent: true,
    });
    const generated = session.exercises.find((entry) => entry.materialOrigin === 'ai');
    expect(generated).toBeTruthy();
    if (!generated) return;
    const { evaluation } = await service.evaluateAnswer(
      ctx.learnerId,
      generated,
      generated.expectedAnswer,
      { now: NOW },
    );
    expect(evaluation.result).toBe('understood');
    expect(evaluation.evaluatedBy).toBe('local');
  });

  it('36. listen_and_answer keeps its AI-mediated qualitative contract, with honest fallback', async () => {
    const ctx = await createContext();
    const calls = { count: 0 };
    const service = createService(ctx, {
      aiProvider: always(() => {
        calls.count += 1;
        return {
          ok: false,
          error: { code: 'unavailable', message: 'down', retryable: true },
        };
      }),
    });
    const exercise: ListeningExercise = {
      id: 'e1',
      learnerId: ctx.learnerId,
      type: 'listen_and_answer',
      difficulty: 'medium',
      speakText: 'The report is due on Tuesday morning.',
      question: 'When is the report due?',
      expectedAnswer: 'Tuesday morning',
      keyItems: ['Tuesday'],
      source: 'general',
      materialOrigin: 'ai',
    };
    const { evaluation, persistenceError } = await service.evaluateAnswer(
      ctx.learnerId,
      exercise,
      '',
      { now: NOW },
    );
    // No evidence → insufficient evidence, never a fabricated weakness.
    expect(evaluation.result).toBe('insufficient_evidence');
    expect(evaluation.evaluatedBy).toBe('unavailable');
    expect(persistenceError).toBe(false);
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 50)).toHaveLength(0);
    expect(calls.count).toBe(1);
  });
});

/* ================================================================== *
 * No second engine / no new persistence
 * ================================================================== */

describe('listening WP-1 boundaries', () => {
  it('37. no new table, no content cache and no second provider client', async () => {
    const ctx = await createContext();
    const tables = await ctx.adapter.query(`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = tables.map((row) => String(row.name).toLowerCase());
    expect(names.filter((name) => /content|generat|difficulty|progression/.test(name))).toEqual([]);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const aiMaterial = await import('./ai-material');
    expect(typeof aiMaterial.generateListeningExercise).toBe('function');
    expect(Object.keys(aiMaterial)).not.toContain('createGeminiAIProvider');
  });

  it('38. the module reuses the shared contract, the shared normalizer and writes nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ai-material.ts'), 'utf8');
    // Inspect real code, not prose.
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('//'))
      .join('\n');

    expect(source).toContain("from '../content-generation'");
    expect(source).toContain('buildContentRequest');
    expect(source).toContain('generateControlledMaterial');
    // The listening layer owns the TEXT rules through the evaluator's own
    // normalization, so there is exactly one set of listening text rules.
    expect(source).toContain('normalizeAnswerText');
    // No persistence, no clock, no randomness: the transformer is pure.
    expect(source).not.toMatch(/upsertWeakness|review\.upsert|repository|\binsert\b|\bsave\b/i);
    expect(source).not.toMatch(/Date\.now\(|Math\.random\(|setTimeout\(/);
  });

  it('39. the transformer is reused rather than re-implemented for listening', async () => {
    const request = buildContentRequest({
      difficultyProfile: resolveDifficultyProfile('B1', null, 'listening'),
      targetSkill: { domain: 'listening' },
      knownVocabulary: [],
      targetExpressions: [],
      taskType: 'listen_and_type',
      context: {},
    });
    expect(request.status).toBe('ok');
    if (request.status !== 'ok') return;
    const result = await generateControlledMaterial(
      always(() => ({
        ok: true,
        response: {
          content: JSON.stringify({
            requestKey: request.request.requestKey,
            taskType: 'listen_and_type',
            speakText: 'I usually drink coffee in the morning.',
            expectedAnswer: 'I usually drink coffee in the morning',
            keyItems: ['coffee'],
          }),
        },
      })),
      request.request,
    );
    expect(result.status).toBe('generated');
  });
});
