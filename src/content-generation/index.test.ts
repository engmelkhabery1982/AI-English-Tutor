/**
 * src/content-generation/index.test.ts
 *
 * WP-1 — Phases 3 & 4 tests.
 *
 * Covers the shared ContentRequest contract (normalization, bounds, requestKey
 * stability, validation) and the controlled content transformer (strict
 * validation, honest provenance, deterministic fallback on every failure
 * mode). No network, no real provider: a fake AIProvider is injected through
 * the EXISTING abstraction.
 */

import { describe, it, expect } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import type { AIProvider, AIProviderResult } from '../providers/ai/types';
import { resolveDifficultyProfile } from '../learning-progression';
import type { DifficultyProfile } from '../learning-progression/types';
import {
  CONTENT_REQUEST_BOUNDS,
  CONTENT_REQUEST_KEY_VERSION,
  buildContentRequest,
  buildMaterialPrompt,
  canonicalContentRequestIdentity,
  extractJsonObject,
  generateControlledMaterial,
  hasSupportedProfessionalContext,
  normalizeTermList,
  resolveMaterialProvenance,
  validateGeneratedMaterial,
} from './index';
import type { ContentRequest, ContentRequestInput } from './index';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function profileFor(level: Parameters<typeof resolveDifficultyProfile>[0]): DifficultyProfile {
  return resolveDifficultyProfile(level, null, 'listening');
}

function requestInput(overrides: Partial<ContentRequestInput> = {}): ContentRequestInput {
  return {
    difficultyProfile: profileFor('B1'),
    targetSkill: { domain: 'listening' },
    knownVocabulary: [],
    targetExpressions: [],
    taskType: 'listen_and_type',
    context: {},
    ...overrides,
  };
}

function request(overrides: Partial<ContentRequestInput> = {}): ContentRequest {
  const built = buildContentRequest(requestInput(overrides));
  if (built.status !== 'ok') {
    throw new Error(`expected a valid request, got ${built.reason}`);
  }
  return built.request;
}

function materialFor(
  target: ContentRequest,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    requestKey: target.requestKey,
    taskType: target.taskType,
    speakText: 'I usually drink coffee in the morning.',
    expectedAnswer: 'I usually drink coffee in the morning',
    keyItems: ['coffee', 'morning'],
    // Honest default: a topic is only claimed when the request established
    // one (see the topic-honesty tests below).
    ...(target.context.topic !== undefined
      ? { contextTopic: target.context.topic }
      : { contextTopic: undefined }),
    explanation: 'Tip: listen for the stressed content words.',
    ...overrides,
  });
}

function fakeProvider(
  impl: (request: unknown) => AIProviderResult | Promise<AIProviderResult>,
  calls?: { count: number },
): AIProvider {
  return {
    id: 'fake-content-ai',
    generate: async (input) => {
      if (calls) calls.count += 1;
      return impl(input);
    },
  };
}

function ok(content: string): AIProviderResult {
  return { ok: true, response: { content } };
}

/** Strip comments so purity scans inspect real code, not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line: string) => !line.trim().startsWith('//'))
    .join('\n');
}

/* ================================================================== *
 * PART B / PHASE 3 — ContentRequest
 * ================================================================== */

describe('ContentRequest — normalization and requestKey', () => {
  it('1. an identical normalized request produces an identical requestKey', () => {
    const a = request({ knownVocabulary: ['Coffee', 'morning'] });
    const b = request({ knownVocabulary: ['morning', 'Coffee'] });
    expect(a.requestKey).toBe(b.requestKey);
    expect(a.requestKey).toBe(request({ knownVocabulary: ['coffee', 'morning'] }).requestKey);
  });

  it('2. array ORDER is normalized away for every list', () => {
    const forward = request({
      knownVocabulary: ['b', 'a', 'c'],
      targetExpressions: ['second', 'first'],
      context: { learningGoals: ['work', 'travel'] },
    });
    const reversed = request({
      knownVocabulary: ['c', 'a', 'b'],
      targetExpressions: ['first', 'second'],
      context: { learningGoals: ['travel', 'work'] },
    });
    expect(forward.requestKey).toBe(reversed.requestKey);
    expect(forward.knownVocabulary).toEqual(['a', 'b', 'c']);
    expect(forward.targetExpressions).toEqual(['first', 'second']);
  });

  it('3. duplicate entries never change the key (deduplicated deterministically)', () => {
    const once = request({ knownVocabulary: ['coffee'] });
    const twice = request({ knownVocabulary: ['Coffee', ' coffee ', 'coffee'] });
    expect(twice.knownVocabulary).toEqual(['coffee']);
    expect(twice.requestKey).toBe(once.requestKey);
  });

  it('4. a REAL content difference changes the key', () => {
    const base = request();
    const keys = new Set([
      base.requestKey,
      request({ knownVocabulary: ['coffee'] }).requestKey,
      request({ difficultyProfile: profileFor('A2') }).requestKey,
      request({ taskType: 'missing_word' }).requestKey,
      request({ context: { topic: 'travel' } }).requestKey,
      request({ targetSkill: { domain: 'listening', skillId: 'gist_listening' } }).requestKey,
      requestInput({ knownVocabulary: [] }).taskType === undefined
        ? base.requestKey
        : request({ listeningObjective: 'deadline' }).requestKey,
    ]);
    expect(keys.size).toBe(7);
    expect(base.requestKey).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{4,12}$/);
  });

  it('5. whitespace and case normalize deterministically', () => {
    expect(normalizeTermList(['  Make   a  Decision ', 'MAKE A DECISION'], 5)).toEqual([
      'make a decision',
    ]);
    expect(normalizeTermList(undefined, 5)).toEqual([]);
    expect(normalizeTermList(['', '   '], 5)).toEqual([]);
  });

  it('5a. learning goals are lowercased like every other list', () => {
    // Semantically identical goals written in different casing must normalize
    // to the same request and the same requestKey.
    const lower = request({ context: { learningGoals: ['prepare for meetings'] } });
    const mixed = request({ context: { learningGoals: ['  Prepare   For MEETINGS '] } });
    expect(mixed.context.learningGoals).toEqual(['prepare for meetings']);
    expect(mixed.requestKey).toBe(lower.requestKey);

    // Goal-array ORDER still never changes the key.
    const reordered = request({
      context: { learningGoals: ['travel', 'Work With Clients'] },
    });
    const canonical = request({
      context: { learningGoals: ['work with clients', 'TRAVEL'] },
    });
    expect(reordered.requestKey).toBe(canonical.requestKey);
    expect(canonical.context.learningGoals).toEqual(['travel', 'work with clients']);
  });

  it('6. the canonical identity is stable and version-prefixed', () => {
    const target = request({ context: { topic: 'daily routine' } });
    const identity = canonicalContentRequestIdentity({
      level: target.level,
      taskType: target.taskType,
      targetSkill: target.targetSkill,
      knownVocabulary: target.knownVocabulary,
      targetExpressions: target.targetExpressions,
      newLanguageBudget: target.newLanguageBudget,
      grammarComplexity: target.grammarComplexity,
      discourseLength: target.discourseLength,
      supportLevel: target.supportLevel,
      speechStyle: target.speechStyle,
      context: target.context,
      evidenceAdjusted: target.difficultyProfile.evidenceAdjusted,
      ...(target.listeningObjective ? { listeningObjective: target.listeningObjective } : {}),
    });
    expect(identity.startsWith(`${CONTENT_REQUEST_KEY_VERSION}|`)).toBe(true);
    expect(identity).toContain('topic=daily routine');
  });
});

describe('ContentRequest — bounds and honesty', () => {
  it('7. known vocabulary is bounded', () => {
    const many = Array.from({ length: 40 }, (_v, index) => `word-${index}`);
    const target = request({ knownVocabulary: many });
    expect(target.knownVocabulary).toHaveLength(CONTENT_REQUEST_BOUNDS.knownVocabulary);
    expect(target.knownVocabulary[0] < target.knownVocabulary[1]).toBe(true);
  });

  it('8. target expressions are bounded to a small set', () => {
    const target = request({
      targetExpressions: ['one', 'two', 'three', 'four', 'five'],
    });
    expect(target.targetExpressions).toHaveLength(CONTENT_REQUEST_BOUNDS.targetExpressions);
  });

  it('9. term length is bounded so no unbounded text reaches a prompt', () => {
    const long = 'x'.repeat(500);
    const target = request({ knownVocabulary: [long] });
    expect(target.knownVocabulary[0].length).toBeLessThanOrEqual(
      CONTENT_REQUEST_BOUNDS.termLength,
    );
  });

  it('10. the request copies its difficulty fields from the profile (no disagreement possible)', () => {
    const target = request({ difficultyProfile: profileFor('C1') });
    expect(target.level).toBe('C1');
    expect(target.newLanguageBudget).toBe(target.difficultyProfile.newLanguageBudget);
    expect(target.grammarComplexity).toBe(target.difficultyProfile.grammarComplexity);
    expect(target.discourseLength).toBe(target.difficultyProfile.discourseLength);
    expect(target.supportLevel).toBe(target.difficultyProfile.supportLevel);
    expect(target.speechStyle).toEqual(target.difficultyProfile.speechStyle);
  });

  it('11. an unsupported task type is REJECTED (not coerced)', () => {
    const built = buildContentRequest(
      requestInput({ taskType: 'listen_and_choose' as never }),
    );
    expect(built.status).toBe('rejected');
    if (built.status !== 'rejected') return;
    expect(built.reason).toBe('invalid_task_type');
    expect(built.message).toContain('listen_and_choose');
  });

  it('12. A1..C2 all carry an honest empty target skill by default, and a real skill when mapped', () => {
    const bare = request();
    expect(bare.targetSkill).toEqual({ domain: 'listening' });
    const mapped = request({ targetSkill: { domain: 'expressions', skillId: 'common_expressions' } });
    expect(mapped.targetSkill.skillId).toBe('common_expressions');
  });

  it('13. a non-existent skillId is REJECTED (never guessed)', () => {
    const built = buildContentRequest(
      requestInput({ targetSkill: { domain: 'listening', skillId: 'made_up_skill' } }),
    );
    expect(built.status).toBe('rejected');
    if (built.status !== 'rejected') return;
    expect(built.reason).toBe('invalid_skill');
  });

  it('13a. only evidenceAdjusted false→true produces a DIFFERENT requestKey', () => {
    // The prompt changes materially with evidenceAdjusted, so the identity
    // must distinguish it — while an identical normalized request stays
    // identical.
    const plain = request();
    const adjusted = request({
      difficultyProfile: { ...profileFor('B1'), evidenceAdjusted: true },
    });
    expect(adjusted.difficultyProfile.evidenceAdjusted).toBe(true);
    expect(plain.difficultyProfile.evidenceAdjusted).toBe(false);
    expect(adjusted.requestKey).not.toBe(plain.requestKey);

    // Same normalized request => same key (evidenceAdjusted false both times).
    expect(request().requestKey).toBe(plain.requestKey);
    // And the identity itself carries the distinction explicitly.
    const identity = canonicalContentRequestIdentity({
      level: plain.level,
      taskType: plain.taskType,
      targetSkill: plain.targetSkill,
      knownVocabulary: plain.knownVocabulary,
      targetExpressions: plain.targetExpressions,
      newLanguageBudget: plain.newLanguageBudget,
      grammarComplexity: plain.grammarComplexity,
      discourseLength: plain.discourseLength,
      supportLevel: plain.supportLevel,
      speechStyle: plain.speechStyle,
      context: plain.context,
      evidenceAdjusted: true,
    });
    expect(identity).toContain('evidenceAdjusted=true');
  });

  it('14. a skillId from another domain is REJECTED', () => {
    const built = buildContentRequest(
      requestInput({ targetSkill: { domain: 'listening', skillId: 'core_vocabulary' } }),
    );
    expect(built.status).toBe('rejected');
    if (built.status !== 'rejected') return;
    expect(built.reason).toBe('invalid_skill');
    expect(built.message).toContain('vocabulary');
  });

  it('15. an unknown domain is REJECTED', () => {
    const built = buildContentRequest(
      requestInput({ targetSkill: { domain: 'astrology' as never } }),
    );
    expect(built.status).toBe('rejected');
    if (built.status !== 'rejected') return;
    expect(built.reason).toBe('invalid_skill');
  });

  it('16. a negative or fractional budget is REJECTED', () => {
    const negative = buildContentRequest(
      requestInput({
        difficultyProfile: { ...profileFor('B1'), newLanguageBudget: -1 },
      }),
    );
    expect(negative.status).toBe('rejected');
    if (negative.status === 'rejected') expect(negative.reason).toBe('invalid_difficulty_profile');

    const fractional = buildContentRequest(
      requestInput({ difficultyProfile: { ...profileFor('B1'), newLanguageBudget: 1.5 } }),
    );
    expect(fractional.status).toBe('rejected');
    if (fractional.status === 'rejected') {
      expect(fractional.reason).toBe('invalid_difficulty_profile');
    }
  });

  it('17. an oversized budget is REJECTED rather than clamped', () => {
    const built = buildContentRequest(
      requestInput({
        difficultyProfile: {
          ...profileFor('B1'),
          newLanguageBudget: CONTENT_REQUEST_BOUNDS.newLanguageBudget + 1,
        },
      }),
    );
    expect(built.status).toBe('rejected');
    if (built.status !== 'rejected') return;
    expect(built.reason).toBe('invalid_budget');
  });

  it('18. an invalid difficulty profile is REJECTED', () => {
    const noStyle = buildContentRequest(
      requestInput({
        difficultyProfile: { ...profileFor('B1'), speechStyle: undefined as never },
      }),
    );
    expect(noStyle.status).toBe('rejected');
    if (noStyle.status === 'rejected') {
      expect(noStyle.reason).toBe('invalid_difficulty_profile');
    }

    const badEnum = buildContentRequest(
      requestInput({
        difficultyProfile: { ...profileFor('B1'), grammarComplexity: 'wizard' as never },
      }),
    );
    expect(badEnum.status).toBe('rejected');
    if (badEnum.status === 'rejected') {
      expect(badEnum.reason).toBe('invalid_difficulty_profile');
    }

    const badLevel = buildContentRequest(
      requestInput({ difficultyProfile: { ...profileFor('B1'), level: 'Z9' as never } }),
    );
    expect(badLevel.status).toBe('rejected');
    if (badLevel.status === 'rejected') {
      expect(badLevel.reason).toBe('invalid_difficulty_profile');
    }
  });

  it('19. a professional context without supported goals is REJECTED', () => {
    const built = buildContentRequest(
      requestInput({ context: { professionalContext: 'aerospace engineering' } }),
    );
    expect(built.status).toBe('rejected');
    if (built.status !== 'rejected') return;
    expect(built.reason).toBe('unsupported_professional_context');

    const unrelatedGoals = buildContentRequest(
      requestInput({
        context: { learningGoals: ['watch more films'], professionalContext: 'aerospace' },
      }),
    );
    expect(unrelatedGoals.status).toBe('rejected');
    if (unrelatedGoals.status === 'rejected') {
      expect(unrelatedGoals.reason).toBe('unsupported_professional_context');
    }
  });

  it('20. supported professional goals make the professional context honest', () => {
    expect(hasSupportedProfessionalContext(['prepare for client presentations'])).toBe(true);
    expect(hasSupportedProfessionalContext(['everyday conversation'])).toBe(false);
    expect(hasSupportedProfessionalContext([])).toBe(false);
    const built = buildContentRequest(
      requestInput({
        context: {
          learningGoals: ['prepare for client presentations'],
          professionalContext: 'client presentations',
        },
      }),
    );
    expect(built.status).toBe('ok');
    if (built.status !== 'ok') return;
    expect(built.request.context.professionalContext).toBe('client presentations');
    expect(built.request.context.learningGoals).toEqual(['prepare for client presentations']);
  });

  it('21. a request with only a level carries NO learner evidence (general mode)', () => {
    const target = request();
    expect(target.knownVocabulary).toEqual([]);
    expect(target.targetExpressions).toEqual([]);
    expect(target.context.learningGoals).toEqual([]);
    expect(target.context.professionalContext).toBeUndefined();
    expect(target.listeningObjective).toBeUndefined();
  });

  it('22. goals and topic are bounded', () => {
    const target = request({
      context: {
        topic: 't'.repeat(500),
        learningGoals: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'],
      },
    });
    expect(target.context.topic?.length).toBeLessThanOrEqual(CONTENT_REQUEST_BOUNDS.topicLength);
    expect(target.context.learningGoals).toHaveLength(CONTENT_REQUEST_BOUNDS.learningGoals);
  });

  it('23. a request input is never mutated', () => {
    const input = requestInput({ knownVocabulary: ['B', 'a'] });
    const before = JSON.stringify(input);
    buildContentRequest(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

/* ================================================================== *
 * PART C / PHASE 4 — Validation
 * ================================================================== */

describe('generated material validation', () => {
  it('24. a valid listen_and_type material is accepted', () => {
    const target = request({ context: { topic: 'daily routine' } });
    const result = validateGeneratedMaterial(target, materialFor(target));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.material.speakText).toBe('I usually drink coffee in the morning.');
    expect(result.material.keyItems).toEqual(['coffee', 'morning']);
  });

  it('25. unparseable output is rejected', () => {
    const target = request();
    expect(validateGeneratedMaterial(target, 'Sounds great to me!')).toEqual({
      ok: false,
      issue: 'unparseable_output',
    });
    expect(validateGeneratedMaterial(target, '{}')).toEqual({
      ok: false,
      issue: 'request_key_mismatch',
    });
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('prefix {"a":1} suffix')).toBe('{"a":1}');
  });

  it('26. a mismatched requestKey is rejected (material is not re-served as another request)', () => {
    const target = request();
    const result = validateGeneratedMaterial(
      target,
      materialFor(target, { requestKey: 'other-key' }),
    );
    expect(result).toEqual({ ok: false, issue: 'request_key_mismatch' });
  });

  it('27. a task type the request did not ask for is rejected', () => {
    const target = request();
    const result = validateGeneratedMaterial(
      target,
      materialFor(target, { taskType: 'listen_and_choose' }),
    );
    expect(result).toEqual({ ok: false, issue: 'unsupported_task_type' });
  });

  it('28. empty required text is rejected', () => {
    const target = request();
    for (const field of ['speakText', 'expectedAnswer']) {
      const result = validateGeneratedMaterial(target, materialFor(target, { [field]: '   ' }));
      expect(result, field).toEqual({ ok: false, issue: 'missing_text' });
    }
  });

  it('29. listen_and_answer requires a non-empty question', () => {
    const target = request({ taskType: 'listen_and_answer' });
    const valid = validateGeneratedMaterial(
      target,
      materialFor(target, { question: 'Why did the meeting move?' }),
    );
    expect(valid.ok).toBe(true);
    const missing = validateGeneratedMaterial(target, materialFor(target));
    expect(missing).toEqual({ ok: false, issue: 'missing_text' });
    const empty = validateGeneratedMaterial(target, materialFor(target, { question: '' }));
    expect(empty).toEqual({ ok: false, issue: 'missing_text' });
  });

  it('30. missing_word requires gapped text, and the gap is not allowed elsewhere', () => {
    const missingWord = request({ taskType: 'missing_word' });
    expect(
      validateGeneratedMaterial(
        missingWord,
        materialFor(missingWord, { gappedText: 'I usually drink ___ in the morning.' }),
      ).ok,
    ).toBe(true);
    expect(validateGeneratedMaterial(missingWord, materialFor(missingWord))).toEqual({
      ok: false,
      issue: 'missing_text',
    });
    // listen_and_type must not carry a gap.
    const listenAndType = request();
    expect(
      validateGeneratedMaterial(
        listenAndType,
        materialFor(listenAndType, { gappedText: 'I usually drink ___ in the morning.' }),
      ),
    ).toEqual({ ok: false, issue: 'unexpected_field' });
  });

  it('31. key items are bounded and non-empty', () => {
    const target = request();
    expect(validateGeneratedMaterial(target, materialFor(target, { keyItems: [] }))).toEqual({
      ok: false,
      issue: 'vocabulary_out_of_bounds',
    });
    expect(
      validateGeneratedMaterial(
        target,
        materialFor(target, { keyItems: ['a', 'b', 'c', 'd', 'e'] }),
      ),
    ).toEqual({ ok: false, issue: 'vocabulary_out_of_bounds' });
    expect(validateGeneratedMaterial(target, materialFor(target, { keyItems: ['  '] }))).toEqual({
      ok: false,
      issue: 'vocabulary_out_of_bounds',
    });
    expect(validateGeneratedMaterial(target, materialFor(target, { keyItems: [1] }))).toEqual({
      ok: false,
      issue: 'vocabulary_out_of_bounds',
    });
  });

  it('32. the passage size is bounded (words and sentences)', () => {
    const target = request();
    const longWords = Array.from({ length: 90 }, (_v, index) => `w${index}`).join(' ');
    expect(
      validateGeneratedMaterial(target, materialFor(target, { speakText: longWords })),
    ).toEqual({ ok: false, issue: 'vocabulary_out_of_bounds' });
    const manySentences = 'One. Two. Three. Four. Five. Six.';
    expect(
      validateGeneratedMaterial(target, materialFor(target, { speakText: manySentences })),
    ).toEqual({ ok: false, issue: 'vocabulary_out_of_bounds' });
  });

  it('33. an expression the request never asked for is rejected (bounded expressions)', () => {
    const target = request({ targetExpressions: ['in the loop'] });
    expect(
      validateGeneratedMaterial(
        target,
        materialFor(target, { targetExpressionsUsed: ['in the loop'] }),
      ).ok,
    ).toBe(true);
    expect(
      validateGeneratedMaterial(
        target,
        materialFor(target, { targetExpressionsUsed: ['a different phrase'] }),
      ),
    ).toEqual({ ok: false, issue: 'expressions_out_of_bounds' });
    expect(
      validateGeneratedMaterial(target, materialFor(target, { targetExpressionsUsed: 'nope' })),
    ).toEqual({ ok: false, issue: 'expressions_out_of_bounds' });
    expect(
      validateGeneratedMaterial(
        target,
        materialFor(target, { targetExpressionsUsed: ['a', 'b', 'c', 'd'] }),
      ),
    ).toEqual({ ok: false, issue: 'expressions_out_of_bounds' });
  });

  it('34. the introduced-new-language count must be a non-negative integer within the budget', () => {
    const target = request({ difficultyProfile: profileFor('A2') });
    expect(
      validateGeneratedMaterial(target, materialFor(target, { newLanguageItems: 1 })).ok,
    ).toBe(true);
    for (const bad of [-1, 1.5, 'two', target.newLanguageBudget + 1]) {
      expect(
        validateGeneratedMaterial(target, materialFor(target, { newLanguageItems: bad })),
      ).toEqual({ ok: false, issue: 'budget_out_of_bounds' });
    }
  });

  it('35. an invented context topic is rejected', () => {
    const target = request({ context: { topic: 'daily routine' } });
    expect(
      validateGeneratedMaterial(target, materialFor(target, { contextTopic: 'scuba diving' })),
    ).toEqual({ ok: false, issue: 'context_dishonest' });
    expect(
      validateGeneratedMaterial(target, materialFor(target, { contextTopic: 'Daily Routine' })).ok,
    ).toBe(true);
  });

  it('35a. a topic claimed WITHOUT an established topic is rejected', () => {
    // The prompt says "never invent a topic the context above did not
    // establish"; validation enforces it in BOTH directions. However
    // plausible the label, a topicless request may not carry one.
    const topicless = request();
    expect(topicless.context.topic).toBeUndefined();
    for (const invented of ['daily routine', 'travel', 'the office']) {
      expect(
        validateGeneratedMaterial(topicless, materialFor(topicless, { contextTopic: invented })),
      ).toEqual({ ok: false, issue: 'context_dishonest' });
    }
    // Omitting the field is the honest form for general material.
    const honest = materialFor(topicless);
    expect(JSON.parse(honest).contextTopic).toBeUndefined();
    expect(validateGeneratedMaterial(topicless, honest).ok).toBe(true);
  });

  it('35b. the schema demands a topic only when one was established', () => {
    const topicless = request();
    const withTopic = request({ context: { topic: 'daily routine' } });
    const topiclessPrompt = buildMaterialPrompt(topicless)
      .messages.map((message) => message.content)
      .join('\n');
    const topicPrompt = buildMaterialPrompt(withTopic)
      .messages.map((message) => message.content)
      .join('\n');
    // Topicless: the model is told (in prose) to omit the field, never to
    // invent one — while the JSON example itself carries NO contextTopic.
    expect(topiclessPrompt).toContain('No topic was established for this material');
    expect(topiclessPrompt).toContain('omit "contextTopic" unless a topic label was given');
    // With a topic: the label travels and must be echoed exactly.
    expect(topicPrompt).toContain('Topic: daily routine');
    expect(topicPrompt).toContain('the exact topic label given in the request');
  });

  /**
   * The prompt's final block is the JSON example the model must echo.
   * Its schema-ish descriptions are not valid JSON, so substitute normal
   * example values for every value placeholder before parsing — exactly what
   * a well-behaved model does when it fills the template in.
   */
  function jsonExampleFromPrompt(promptText: string): Record<string, unknown> {
    const start = promptText.indexOf('{');
    const end = promptText.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON example found in prompt');
    const template = promptText.slice(start, end + 1);
    const filled = template
      // String placeholders inside quotes become a normal example string.
      .replace(/"(?:[^"]*)"(?=,?\s*\n)/g, '"example"')
      // Array placeholders become a one-element example array.
      .replace(/\[[^\]]*\]/g, '["example"]')
      // Numbers stay as-is (already valid JSON literals).
      ;
    return JSON.parse(filled) as Record<string, unknown>;
  }

  it('35c. the topicless JSON example is VALID JSON and carries NO contextTopic', () => {
    const topicless = request();
    const promptText = buildMaterialPrompt(topicless)
      .messages.map((message) => message.content)
      .join('\n');
    // The template must not contain pseudo-JSON prose (the old defect).
    expect(promptText).not.toContain('"contextTopic": omit');
    // After substituting normal example values the template parses as JSON.
    const parsed = jsonExampleFromPrompt(promptText);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'contextTopic')).toBe(false);
  });

  it('35d. the topic-present JSON example is valid JSON and includes contextTopic', () => {
    const withTopic = request({ context: { topic: 'daily routine' } });
    const promptText = buildMaterialPrompt(withTopic)
      .messages.map((message) => message.content)
      .join('\n');
    const parsed = jsonExampleFromPrompt(promptText);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'contextTopic')).toBe(true);
  });

  it('36. level, score and percentage claims are rejected', () => {
    const target = request();
    for (const claim of [
      'Your level is B2 and that is a real improvement.',
      'You scored 80% on this exercise.',
      'Your score is high on this exercise.',
    ]) {
      expect(
        validateGeneratedMaterial(target, materialFor(target, { speakText: claim })),
        claim,
      ).toEqual({ ok: false, issue: 'context_dishonest' });
    }
  });

  it('37. a material may not claim a skill the request did not map', () => {
    const target = request();
    expect(
      validateGeneratedMaterial(target, materialFor(target, { skillId: 'gist_listening' })),
    ).toEqual({ ok: false, issue: 'invalid_skill' });
    const mapped = request({ targetSkill: { domain: 'listening', skillId: 'gist_listening' } });
    expect(
      validateGeneratedMaterial(mapped, materialFor(mapped, { skillId: 'gist_listening' })).ok,
    ).toBe(true);
  });

  it('38. provenance claims may not be MORE personalized than the request supports', () => {
    const bare = request();
    expect(
      validateGeneratedMaterial(bare, materialFor(bare, { provenance: 'personalized' })),
    ).toEqual({ ok: false, issue: 'provenance_dishonest' });
    expect(
      validateGeneratedMaterial(bare, materialFor(bare, { provenance: 'general' })).ok,
    ).toBe(true);
    expect(
      validateGeneratedMaterial(bare, materialFor(bare, { provenance: 'wizard' })),
    ).toEqual({ ok: false, issue: 'provenance_dishonest' });

    const evidenced = request({ targetExpressions: ['coffee'] });
    expect(
      validateGeneratedMaterial(
        evidenced,
        materialFor(evidenced, { provenance: 'personalized' }),
      ).ok,
    ).toBe(true);
  });
});

describe('material provenance', () => {
  it('39. a learner merely having a profile is NOT personalization', () => {
    expect(resolveMaterialProvenance(request(), 'I usually drink coffee in the morning.')).toBe(
      'general',
    );
  });

  it('40. honored target expressions make the material personalized', () => {
    const target = request({ targetExpressions: ['coffee', 'morning'] });
    expect(resolveMaterialProvenance(target, 'I usually drink coffee in the morning.')).toBe(
      'personalized',
    );
  });

  it('41. a requested target that was NOT honored degrades the provenance honestly', () => {
    const target = request({ targetExpressions: ['deadline'] });
    expect(resolveMaterialProvenance(target, 'I usually drink coffee in the morning.')).toBe(
      'mixed',
    );
  });

  it('42. bounded known vocabulary alone is mixed, never personalized', () => {
    const target = request({ knownVocabulary: ['coffee'] });
    expect(resolveMaterialProvenance(target, 'I usually drink coffee in the morning.')).toBe(
      'mixed',
    );
  });

  it('43. an honored listening objective is personalized', () => {
    const target = request({ listeningObjective: 'deadline' });
    expect(resolveMaterialProvenance(target, 'We must meet the deadline on Friday.')).toBe(
      'personalized',
    );
    expect(resolveMaterialProvenance(target, 'We must meet the target on Friday.')).toBe('mixed');
  });
});

/* ================================================================== *
 * PHASE 4 — Transformer
 * ================================================================== */

describe('controlled content transformer', () => {
  it('44. valid output becomes validated material with its requestKey echoed', async () => {
    const target = request({ context: { topic: 'daily routine' } });
    const provider = fakeProvider(() => ok(materialFor(target)));
    const result = await generateControlledMaterial(provider, target);
    expect(result.status).toBe('generated');
    if (result.status !== 'generated') return;
    expect(result.requestKey).toBe(target.requestKey);
    expect(result.material.requestKey).toBe(target.requestKey);
    expect(result.provenance).toBe('general');
  });

  it('45. identical input generates identical material (determinism of CONTENT, not ids)', async () => {
    const target = request();
    const provider = fakeProvider(() => ok(materialFor(target)));
    const first = await generateControlledMaterial(provider, target);
    const second = await generateControlledMaterial(provider, target);
    expect(first.status).toBe('generated');
    expect(second.status).toBe('generated');
    if (first.status !== 'generated' || second.status !== 'generated') return;
    expect(first.material).toEqual(second.material);
    expect(first.provenance).toBe(second.provenance);
  });

  it('46. malformed output is discarded and reported as an honest unavailability', async () => {
    const target = request();
    const provider = fakeProvider(() => ok('I could not think of anything!'));
    const result = await generateControlledMaterial(provider, target);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('invalid_output');
    expect(result.detail).toContain('unparseable_output');
    expect(result.requestKey).toBe(target.requestKey);
  });

  it('47. internally inconsistent material is discarded, not repaired', async () => {
    const target = request();
    const provider = fakeProvider(() =>
      ok(materialFor(target, { keyItems: ['a', 'b', 'c', 'd', 'e', 'f'] })),
    );
    const result = await generateControlledMaterial(provider, target);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.detail).toContain('vocabulary_out_of_bounds');
  });

  it('48. a provider timeout degrades to deterministic fallback, not an error', async () => {
    const target = request();
    const provider = fakeProvider(() => ({
      ok: false,
      error: { code: 'timeout', message: 'timed out', retryable: true },
    }));
    const result = await generateControlledMaterial(provider, target);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('provider_timeout');
  });

  it('49. provider unavailability and provider errors are classified', async () => {
    const target = request();
    const unavailableProvider = fakeProvider(() => ({
      ok: false,
      error: { code: 'unavailable', message: 'down', retryable: true },
    }));
    const down = await generateControlledMaterial(unavailableProvider, target);
    expect(down.status === 'unavailable' && down.reason).toBe('provider_unavailable');

    const rateLimited = fakeProvider(() => ({
      ok: false,
      error: { code: 'rate_limit', message: 'slow down', retryable: true },
    }));
    const limited = await generateControlledMaterial(rateLimited, target);
    expect(limited.status === 'unavailable' && limited.reason).toBe('provider_error');
    expect(limited.status === 'unavailable' && limited.detail).toContain('rate_limit');
  });

  it('50. a provider that THROWS is caught (never blocks or crashes the caller)', async () => {
    const target = request();
    const provider = fakeProvider(() => {
      throw new Error('boom');
    });
    const result = await generateControlledMaterial(provider, target);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('provider_error');
  });

  it('51. no provider means no generation and no invented personalization', async () => {
    const target = request({ knownVocabulary: ['coffee'] });
    const result = await generateControlledMaterial(undefined, target);
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reason).toBe('no_provider');
    // The unavailable result deliberately makes NO provenance claim at all.
    expect('provenance' in result).toBe(false);
  });

  it('52. provenance is computed from real evidence, never taken from the model claim', async () => {
    const target = request({ targetExpressions: ['coffee'] });
    const claiming = fakeProvider(() => ok(materialFor(target, { provenance: 'general' })));
    const result = await generateControlledMaterial(claiming, target);
    expect(result.status).toBe('generated');
    if (result.status !== 'generated') return;
    // The material really used the requested expression → personalized,
    // regardless of the model's own (more conservative) claim.
    expect(result.provenance).toBe('personalized');
  });

  it('53. the prompt carries the difficulty guidance, the budget and the honesty rules', () => {
    const target = request({
      difficultyProfile: profileFor('A2'),
      knownVocabulary: ['coffee'],
      targetExpressions: ['in the loop'],
      listeningObjective: 'deadline',
      context: { topic: 'work', learningGoals: ['prepare for meetings'] },
      taskType: 'missing_word',
    });
    const prompt = buildMaterialPrompt(target);
    const text = prompt.messages.map((message) => message.content).join('\n');
    expect(text).toContain('Discourse length: short paragraph');
    expect(text).toContain('Grammar complexity: basic');
    expect(text).toContain('Support level: moderate');
    expect(text).toContain('Register: everyday');
    expect(text).toContain(`Introduce at most ${target.newLanguageBudget}`);
    expect(text).toContain('coffee');
    expect(text).toContain('in the loop');
    expect(text).toContain('deadline');
    expect(text).toContain('Topic: work');
    expect(text).toContain('"gappedText"');
    expect(text).toContain(target.requestKey);
    expect(text).toContain('NOT their whole vocabulary');
    expect(prompt.systemPrompt).toMatch(/never output scores/i);
    // The transformer never claims the learner's level back to the model.
    expect(text).not.toMatch(/\b(A1|A2|B1|B2|C1|C2)\b/);
  });

  it('54. the transformer is a pure request → material transform (ownership boundary)', () => {
    const sources = ['transformer.ts', 'validation.ts', 'request.ts', 'types.ts']
      .map((file) => readFileSync(join(__dirname, file), 'utf8'))
      .join('\n');
    // VALUE imports only: type-only imports cannot create runtime coupling.
    const valueImports = sources
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line.startsWith('import ') && !line.startsWith('import type '))
      .join('\n');
    expect(valueImports).not.toMatch(/sqlite|repositories|talk-demo|daily-tutor|listening/i);
    const code = stripComments(sources);
    expect(code).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(/);
    expect(code).not.toMatch(/upsert|persist|caching/i);
    // It never reads the learner model, a coaching context or a repository:
    // the request it is handed is its ONLY contextual input.
    expect(code).not.toMatch(/getCoachingContext|LearnerModel|listWeaknesses|getDueReview/);
    // It reuses the EXISTING provider abstraction and adds no second client.
    const transformer = readFileSync(join(__dirname, 'transformer.ts'), 'utf8');
    expect(transformer).toContain("from '../providers/ai/types'");
    expect(transformer).not.toMatch(/createGeminiAIProvider|fetch\(|google|@google/i);
  });
});
