/**
 * src/conversation-engine/index.test.ts
 *
 * Unit tests for Conversation Engine foundation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createConversationEngine,
  DEFAULT_HISTORY_LIMIT,
} from './index';
import type {
  ConversationRole,
  ConversationTurn,
  ConversationRequestInput,
} from './index';
import type { CoachingContext, LearnerModel } from '../learner-model';
import type { UserProfile } from '../domain/models/learner';

function createMockCoachingContext(overrides?: Partial<CoachingContext>): CoachingContext {
  return {
    profile: {
      learnerId: 'learner-test-123',
      displayName: 'Alice Smith',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: ['fluency in everyday conversations', 'business presentation'],
      preferredModes: ['natural', 'coach'],
    },
    activeWeaknesses: [
      {
        id: 'weakness-1',
        type: 'grammar',
        referenceId: 'ref-grammar-1',
        status: 'confirmed',
        severity: 4,
        occurrenceCount: 6,
        contexts: ['past tense vs present perfect', 'irregular verbs'],
      },
    ],
    strengths: [
      {
        id: 'strength-1',
        type: 'grammar',
        referenceId: 'ref-strength-1',
        confidence: 0.9,
        contexts: ['present simple questions'],
      },
    ],
    vocabularyFocus: [
      {
        itemId: 'vocab-1',
        headword: 'meticulous',
        type: 'word',
        meaningDefinition: 'showing great attention to detail; very careful and precise',
        reviewState: 'learning',
        nextReviewAt: '2026-09-16T12:00:00.000Z',
      },
    ],
    expressionFocus: [
      {
        itemId: 'expr-1',
        expression: 'break the ice',
        type: 'idiom',
        meaningDefinition: 'do or say something to relieve tension in an unfamiliar social setting',
        reviewState: 'familiar',
        nextReviewAt: '2026-09-17T12:00:00.000Z',
      },
    ],
    recentProgress: {
      id: 'progress-1',
      learnerId: 'learner-test-123',
      recordedAt: '2026-09-15T20:00:00.000Z',
      windowStart: '2026-09-14T00:00:00.000Z',
      windowEnd: '2026-09-15T23:59:59.000Z',
      sessionsCompleted: 3,
      turnsCompleted: 24,
      newWordsLearned: 5,
      weaknessesImproved: 2,
      weaknessesWorsened: 0,
      notes: 'Strong conversational pace and good responsiveness.',
    },
    dueReviewCount: 4,
    generatedAt: '2026-09-15T22:00:00.000Z',
    ...overrides,
  };
}

function createMockLearnerModel(coachingContext: CoachingContext): {
  learnerModel: LearnerModel;
  getCoachingContextSpy: ReturnType<typeof vi.fn>;
  otherMethodSpies: ReturnType<typeof vi.fn>[];
} {
  const getCoachingContextSpy = vi.fn().mockImplementation(() => coachingContext);
  const refreshSpy = vi.fn();
  const subscribeSpy = vi.fn();
  const getActiveWeaknessesSpy = vi.fn();
  const getStrengthsSpy = vi.fn();
  const getSavedVocabularySpy = vi.fn();
  const getDueReviewSpy = vi.fn();
  const getRecentProgressSpy = vi.fn();
  const getLatestProgressSpy = vi.fn();
  const getWeaknessSummarySpy = vi.fn();
  const getVocabularySummarySpy = vi.fn();
  const getExpressionSummarySpy = vi.fn();
  const getProgressSummarySpy = vi.fn();
  const getDashboardSnapshotSpy = vi.fn();

  const otherMethodSpies = [
    refreshSpy,
    subscribeSpy,
    getActiveWeaknessesSpy,
    getStrengthsSpy,
    getSavedVocabularySpy,
    getDueReviewSpy,
    getRecentProgressSpy,
    getLatestProgressSpy,
    getWeaknessSummarySpy,
    getVocabularySummarySpy,
    getExpressionSummarySpy,
    getProgressSummarySpy,
    getDashboardSnapshotSpy,
  ];

  const learnerModel = {
    profile: {} as unknown as UserProfile,
    strengths: [],
    weaknesses: [],
    mistakes: [],
    pronunciationWeaknesses: [],
    vocabulary: [],
    expressions: [],
    reviewQueue: [],
    progress: [],
    latestProgress: null,
    refresh: refreshSpy,
    subscribe: subscribeSpy,
    getActiveWeaknesses: getActiveWeaknessesSpy,
    getStrengths: getStrengthsSpy,
    getSavedVocabulary: getSavedVocabularySpy,
    getDueReview: getDueReviewSpy,
    getRecentProgress: getRecentProgressSpy,
    getLatestProgress: getLatestProgressSpy,
    getWeaknessSummary: getWeaknessSummarySpy,
    getVocabularySummary: getVocabularySummarySpy,
    getExpressionSummary: getExpressionSummarySpy,
    getProgressSummary: getProgressSummarySpy,
    getDashboardSnapshot: getDashboardSnapshotSpy,
    getCoachingContext: getCoachingContextSpy,
  } as unknown as LearnerModel;

  return { learnerModel, getCoachingContextSpy, otherMethodSpies };
}

describe('ConversationEngine', () => {
  it('1. pre-existing valid CoachingContext produces a request', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const input: ConversationRequestInput = {
      userMessage: 'Could you give me an example of how to use "meticulous"?',
      mode: 'natural',
      topic: 'Vocabulary in context',
    };

    const request = engine.buildRequest(input);

    expect(request).toBeDefined();
    expect(request.mode).toBe('natural');
    expect(request.topic).toBe('Vocabulary in context');
    expect(request.systemPrompt).toContain('meticulous');
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toEqual({
      role: 'user',
      content: 'Could you give me an example of how to use "meticulous"?',
    });
  });

  it('2. getCoachingContext called exactly once per request', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel, getCoachingContextSpy } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    expect(getCoachingContextSpy).not.toHaveBeenCalled();

    engine.buildRequest({
      userMessage: 'Hello tutor',
      mode: 'natural',
    });

    expect(getCoachingContextSpy).toHaveBeenCalledTimes(1);

    engine.buildRequest({
      userMessage: 'How is the weather today?',
      mode: 'coach',
    });

    expect(getCoachingContextSpy).toHaveBeenCalledTimes(2);
  });

  it('3. current user message is the final user turn', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const history: ConversationTurn[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello, how can I help you today?' },
    ];

    const request = engine.buildRequest({
      userMessage: 'I would like to practice speaking about travel.',
      mode: 'natural',
      history,
    });

    expect(request.messages).toHaveLength(3);
    const finalTurn = request.messages[request.messages.length - 1];
    expect(finalTurn.role).toBe('user');
    expect(finalTurn.content).toBe('I would like to practice speaking about travel.');
  });

  it('4. history order is preserved', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const history: ConversationTurn[] = [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Turn 2' },
      { role: 'user', content: 'Turn 3' },
      { role: 'assistant', content: 'Turn 4' },
    ];

    const request = engine.buildRequest({
      userMessage: 'Turn 5',
      mode: 'natural',
      history,
    });

    expect(request.messages.map((m) => m.content)).toEqual([
      'Turn 1',
      'Turn 2',
      'Turn 3',
      'Turn 4',
      'Turn 5',
    ]);
  });

  it('5. default history limit is applied', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    // Create 15 history turns
    const history: ConversationTurn[] = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as ConversationRole,
      content: `Message ${i + 1}`,
    }));

    const request = engine.buildRequest({
      userMessage: 'New User Message',
      mode: 'natural',
      history,
    });

    // Default limit is 10 turns + 1 final user turn = 11 total turns
    expect(request.messages).toHaveLength(DEFAULT_HISTORY_LIMIT + 1);
    expect(request.messages[0].content).toBe('Message 6'); // 15 - 10 + 1 = index 5 (Message 6)
    expect(request.messages[request.messages.length - 1].content).toBe('New User Message');
  });

  it('6. explicit positive history limit is applied', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const history: ConversationTurn[] = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as ConversationRole,
      content: `Message ${i + 1}`,
    }));

    const request = engine.buildRequest({
      userMessage: 'Latest question',
      mode: 'coach',
      history,
      historyLimit: 3,
    });

    // 3 history turns + 1 current message = 4 turns
    expect(request.messages).toHaveLength(4);
    expect(request.messages[0].content).toBe('Message 8');
    expect(request.messages[1].content).toBe('Message 9');
    expect(request.messages[2].content).toBe('Message 10');
    expect(request.messages[3].content).toBe('Latest question');
  });

  it('7. invalid history limits use the default', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const history: ConversationTurn[] = Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as ConversationRole,
      content: `Turn ${i + 1}`,
    }));

    const invalidLimits = [0, -1, -100, 2.5, NaN, Infinity, -Infinity];

    for (const invalidLimit of invalidLimits) {
      const request = engine.buildRequest({
        userMessage: 'Check invalid limit',
        mode: 'natural',
        history,
        historyLimit: invalidLimit,
      });

      expect(request.messages).toHaveLength(DEFAULT_HISTORY_LIMIT + 1);
      expect(request.messages[0].content).toBe('Turn 6');
    }
  });

  it('8. blank current user message throws', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    expect(() =>
      engine.buildRequest({
        userMessage: '',
        mode: 'natural',
      }),
    ).toThrowError(/empty or whitespace only/i);

    expect(() =>
      engine.buildRequest({
        userMessage: '   \n\t  ',
        mode: 'natural',
      }),
    ).toThrowError(/empty or whitespace only/i);
  });

  it('9. whitespace-only topic becomes null', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const requestEmpty = engine.buildRequest({
      userMessage: 'Hello',
      mode: 'natural',
      topic: '',
    });
    expect(requestEmpty.topic).toBeNull();
    expect(requestEmpty.systemPrompt).toContain('Topic Focus: Open conversation');

    const requestWhitespace = engine.buildRequest({
      userMessage: 'Hello',
      mode: 'natural',
      topic: '   \t\n  ',
    });
    expect(requestWhitespace.topic).toBeNull();
    expect(requestWhitespace.systemPrompt).toContain('Topic Focus: Open conversation');
  });

  it('10. valid topic is preserved', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Tell me about London',
      mode: 'natural',
      topic: 'Travel and Culture',
    });

    expect(request.topic).toBe('Travel and Culture');
    expect(request.systemPrompt).toContain('Topic Focus: Travel and Culture');
  });

  it('11. Natural Conversation prompt behavior', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Good morning!',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Mode: Natural Conversation');
    expect(request.systemPrompt).toContain('Prioritize natural, authentic, and flowing conversational exchange');
    expect(request.systemPrompt).toContain('Correct selectively and unobtrusively');
  });

  it('12. Coach Mode prompt behavior', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Good morning!',
      mode: 'coach',
    });

    expect(request.systemPrompt).toContain('Mode: Coach Mode');
    expect(request.systemPrompt).toContain('Provide somewhat more explicit coaching');
    expect(request.systemPrompt).toContain('Maintain conversation flow');
  });

  it('13. Intensive Practice prompt behavior', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Let us practice!',
      mode: 'intensive',
    });

    expect(request.systemPrompt).toContain('Mode: Intensive Practice');
    expect(request.systemPrompt).toContain('Focus directly and deliberately on learner weaknesses');
    expect(request.systemPrompt).toContain('Offer more frequent, focused corrections');
  });

  it('14. active weaknesses appear in system coaching context without fabrication', () => {
    const mockContext = createMockCoachingContext({
      activeWeaknesses: [
        {
          id: 'w-persisted',
          type: 'grammar',
          referenceId: 'ref-w1',
          status: 'confirmed',
          severity: 5,
          occurrenceCount: 12,
          contexts: ['conditional clauses', 'hypothetical situations'],
        },
      ],
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'If I was rich, what would I do?',
      mode: 'coach',
    });

    expect(request.systemPrompt).toContain('Active Weaknesses (Persisted):');
    expect(request.systemPrompt).toContain('[grammar]');
    expect(request.systemPrompt).toContain('Severity: 5');
    expect(request.systemPrompt).toContain('Occurrences: 12');
    expect(request.systemPrompt).toContain('conditional clauses, hypothetical situations');
  });

  it('15. strengths appear in context', () => {
    const mockContext = createMockCoachingContext({
      strengths: [
        {
          id: 's-persisted',
          type: 'grammar',
          referenceId: 'ref-s1',
          confidence: 0.95,
          contexts: ['complex sentence structures'],
        },
      ],
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'I enjoy writing essays.',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Strengths (Persisted):');
    expect(request.systemPrompt).toContain('[grammar] Confidence: 0.95');
    expect(request.systemPrompt).toContain('complex sentence structures');
  });

  it('16. vocabulary focus appears', () => {
    const mockContext = createMockCoachingContext({
      vocabularyFocus: [
        {
          itemId: 'vocab-test',
          headword: 'ubiquitous',
          type: 'word',
          meaningDefinition: 'present, appearing, or found everywhere',
          reviewState: 'learning',
          nextReviewAt: null,
        },
      ],
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Smartphones are everywhere.',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Vocabulary Focus');
    expect(request.systemPrompt).toContain('"ubiquitous" (word): present, appearing, or found everywhere');
  });

  it('17. expression focus appears', () => {
    const mockContext = createMockCoachingContext({
      expressionFocus: [
        {
          itemId: 'expr-test',
          expression: 'bite the bullet',
          type: 'idiom',
          meaningDefinition: 'face a difficult situation with courage and fortitude',
          reviewState: 'familiar',
          nextReviewAt: null,
        },
      ],
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'I have to take an exam tomorrow.',
      mode: 'coach',
    });

    expect(request.systemPrompt).toContain('Expression Focus');
    expect(request.systemPrompt).toContain('"bite the bullet" (idiom): face a difficult situation');
  });

  it('18. due review count appears', () => {
    const mockContext = createMockCoachingContext({
      dueReviewCount: 9,
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Hello!',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Spaced Repetition Due Reviews: 9 item(s) due.');
  });

  it('19. latest progress is represented when present', () => {
    const mockContext = createMockCoachingContext({
      recentProgress: {
        id: 'prog-custom',
        learnerId: 'learner-test-123',
        recordedAt: '2026-09-15T10:00:00.000Z',
        windowStart: '2026-09-14T00:00:00.000Z',
        windowEnd: '2026-09-15T00:00:00.000Z',
        sessionsCompleted: 4,
        turnsCompleted: 35,
        newWordsLearned: 7,
        weaknessesImproved: 3,
        weaknessesWorsened: 1,
        notes: 'Noticeable fluency improvement.',
      },
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Hi tutor',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Recent Progress:');
    expect(request.systemPrompt).toContain('Sessions: 4, Turns: 35');
    expect(request.systemPrompt).toContain('New words learned: 7');
    expect(request.systemPrompt).toContain('Weaknesses improved: 3');
    expect(request.systemPrompt).toContain('Noticeable fluency improvement.');
  });

  it('20. null recent progress is handled safely', () => {
    const mockContext = createMockCoachingContext({
      recentProgress: null,
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Hello!',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Recent Progress:\nNone recorded.');
    expect(request.coachingContext.recentProgress).toBeNull();
  });

  it('21. empty learner arrays are handled safely', () => {
    const mockContext = createMockCoachingContext({
      profile: {
        learnerId: 'learner-empty',
        displayName: 'Empty User',
        currentLevel: 'unknown',
        targetLevel: 'B2',
        learningGoals: [],
        preferredModes: [],
      },
      activeWeaknesses: [],
      strengths: [],
      vocabularyFocus: [],
      expressionFocus: [],
      recentProgress: null,
      dueReviewCount: 0,
    });
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Hello world',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Active Weaknesses (Persisted):\nNone recorded.');
    expect(request.systemPrompt).toContain('Strengths (Persisted):\nNone recorded.');
    expect(request.systemPrompt).toContain('Vocabulary Focus (Target items to naturally incorporate):\nNone recorded.');
    expect(request.systemPrompt).toContain('Expression Focus (Target expressions to naturally incorporate):\nNone recorded.');
    expect(request.systemPrompt).toContain('Learning Goals: None specified');
    expect(request.systemPrompt).toContain('Preferred Modes: None specified');
    expect(request.systemPrompt).toContain('Spaced Repetition Due Reviews: 0 item(s) due.');
  });

  it('22. pre-refresh/default CoachingContext is handled safely', () => {
    const defaultContext: CoachingContext = {
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
      recentProgress: null,
      dueReviewCount: 0,
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { learnerModel } = createMockLearnerModel(defaultContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Hi there',
      mode: 'natural',
    });

    expect(request.systemPrompt).toContain('Learner Name: Learner');
    expect(request.systemPrompt).toContain('Current CEFR Level: unknown');
    expect(request.systemPrompt).toContain('Target CEFR Level: unknown');
    expect(request.coachingContext.dueReviewCount).toBe(0);
  });

  it('23. request does not mutate original history', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const originalHistory: ConversationTurn[] = [
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Turn 2' },
    ];

    const request = engine.buildRequest({
      userMessage: 'Turn 3',
      mode: 'natural',
      history: originalHistory,
    });

    // Mutate request messages
    (request.messages as ConversationTurn[])[0] = { role: 'assistant', content: 'Mutated!' };
    (request.messages as ConversationTurn[]).push({ role: 'user', content: 'Injected turn' });

    expect(originalHistory).toHaveLength(2);
    expect(originalHistory[0]).toEqual({ role: 'user', content: 'Turn 1' });
    expect(originalHistory[1]).toEqual({ role: 'assistant', content: 'Turn 2' });
  });

  it('24. request does not expose nested mutable learner context references', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const request = engine.buildRequest({
      userMessage: 'Test immutability',
      mode: 'coach',
    });

    // Attempt mutation of arrays on returned request
    (request.coachingContext.profile.learningGoals as string[]).push('tampered-goal');
    (request.coachingContext.activeWeaknesses[0].contexts as string[]).push('tampered-weakness-ctx');
    (request.coachingContext.strengths[0].contexts as string[]).push('tampered-strength-ctx');
    (request.coachingContext.vocabularyFocus[0] as unknown as { headword: string }).headword = 'tampered-vocab';
    (request.coachingContext.expressionFocus[0] as unknown as { expression: string }).expression = 'tampered-expr';

    // Verify mockContext was not modified
    expect(mockContext.profile.learningGoals).not.toContain('tampered-goal');
    expect(mockContext.activeWeaknesses[0].contexts).not.toContain('tampered-weakness-ctx');
    expect(mockContext.strengths[0].contexts).not.toContain('tampered-strength-ctx');
    expect(mockContext.vocabularyFocus[0].headword).toBe('meticulous');
    expect(mockContext.expressionFocus[0].expression).toBe('break the ice');
  });

  it('25. deterministic repeated calls with equivalent context produce equivalent request content except for pre-existing generatedAt supplied by LearnerModel', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const input: ConversationRequestInput = {
      userMessage: 'Could we discuss the future of AI?',
      mode: 'natural',
      topic: 'Technology',
      history: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
      ],
    };

    const requestA = engine.buildRequest(input);
    const requestB = engine.buildRequest(input);

    expect(requestA.systemPrompt).toBe(requestB.systemPrompt);
    expect(requestA.messages).toEqual(requestB.messages);
    expect(requestA.mode).toBe(requestB.mode);
    expect(requestA.topic).toBe(requestB.topic);
    expect(requestA.coachingContext).toEqual(requestB.coachingContext);
  });

  it('26. no repository/database/provider calls exist in this layer', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel, getCoachingContextSpy, otherMethodSpies } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    engine.buildRequest({
      userMessage: 'Check method calls',
      mode: 'natural',
    });

    expect(getCoachingContextSpy).toHaveBeenCalledTimes(1);

    for (const spy of otherMethodSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('handles empty content in history turns gracefully without throwing', () => {
    const mockContext = createMockCoachingContext();
    const { learnerModel } = createMockLearnerModel(mockContext);
    const engine = createConversationEngine(learnerModel);

    const history: ConversationTurn[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: ' ' },
    ];

    expect(() =>
      engine.buildRequest({
        userMessage: 'Valid user query',
        mode: 'natural',
        history,
      }),
    ).not.toThrow();

    const request = engine.buildRequest({
      userMessage: 'Valid user query',
      mode: 'natural',
      history,
    });

    expect(request.messages).toHaveLength(3);
    expect(request.messages[0].content).toBe('');
    expect(request.messages[1].content).toBe(' ');
    expect(request.messages[2].content).toBe('Valid user query');
  });
});
