/**
 * src/conversation-session/index.test.ts
 *
 * Comprehensive unit tests for the in-memory Conversation Session foundation.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  CoachingContext,
  ConversationRequest,
  ConversationRequestInput,
  ConversationTurn,
} from '../conversation-engine';
import type { ConversationOrchestrator } from '../conversation-orchestrator';
import type { AIProviderError, AIProviderResponse } from '../providers/ai';
import { createConversationSession } from './index';
import type { ConversationSessionConfig } from './types';

function createMockCoachingContext(): CoachingContext {
  return {
    profile: {
      learnerId: 'learner-1',
      displayName: 'Alex',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: ['fluency'],
      preferredModes: ['natural'],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: '2026-09-16T00:00:00.000Z',
  };
}

function createMockConversationRequest(
  override?: Partial<ConversationRequest>
): ConversationRequest {
  return {
    systemPrompt: 'System prompt',
    messages: [{ role: 'user', content: 'hello' }],
    mode: 'natural',
    topic: 'travel',
    coachingContext: createMockCoachingContext(),
    ...override,
  };
}

describe('ConversationSession', () => {
  it('1. factory creates a working ConversationSession', () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn(),
    };
    const session = createConversationSession(mockOrchestrator, {
      mode: 'natural',
      topic: 'travel',
    });

    expect(session).toBeDefined();
    expect(typeof session.send).toBe('function');
    expect(typeof session.getHistory).toBe('function');
    expect(typeof session.clear).toBe('function');
    expect(typeof session.getConfig).toBe('function');
  });

  it('validates required dependencies in factory', () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn(),
    };

    expect(() =>
      createConversationSession(null as unknown as ConversationOrchestrator, {
        mode: 'natural',
      })
    ).toThrow('ConversationOrchestrator with execute method is required.');

    expect(() =>
      createConversationSession(
        mockOrchestrator,
        null as unknown as ConversationSessionConfig
      )
    ).toThrow('ConversationSessionConfig with valid mode is required.');

    expect(() =>
      createConversationSession(
        mockOrchestrator,
        {} as unknown as ConversationSessionConfig
      )
    ).toThrow('ConversationSessionConfig with valid mode is required.');
  });

  it('2. initial getHistory() returns []', () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn(),
    };
    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });

    expect(session.getHistory()).toEqual([]);
  });

  it('3. first send calls orchestrator exactly once', async () => {
    const executeMock = vi.fn().mockResolvedValue({
      ok: true,
      request: createMockConversationRequest(),
      response: { content: 'Hello!' },
    });
    const mockOrchestrator: ConversationOrchestrator = { execute: executeMock };
    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });

    await session.send({ userMessage: 'Hi there' });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('4. first send passes empty history', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'Welcome!' },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Hi' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.history).toEqual([]);
  });

  it('5. send passes configured mode', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'Response' },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'coach' });
    await session.send({ userMessage: 'Explain this word' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.mode).toBe('coach');
  });

  it('6. send passes configured topic', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'Topic response' },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, {
      mode: 'natural',
      topic: 'ordering_food',
    });
    await session.send({ userMessage: 'I would like a menu' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.topic).toBe('ordering_food');
  });

  it('7. meaningful topic with leading/trailing whitespace is preserved exactly in request input', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'OK' },
        };
      }),
    };

    const whitespaceTopic = '  job interview  ';
    const session = createConversationSession(mockOrchestrator, {
      mode: 'intensive',
      topic: whitespaceTopic,
    });
    await session.send({ userMessage: 'Tell me about yourself.' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.topic).toBe(whitespaceTopic);
  });

  it('8. send passes configured historyLimit', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'OK' },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, {
      mode: 'natural',
      historyLimit: 10,
    });
    await session.send({ userMessage: 'Hello' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.historyLimit).toBe(10);
  });

  it('9. current userMessage is passed exactly', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'OK' },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const exactMessage = '  Spaces, \n tabs \t and exact punctuation!  ';
    await session.send({ userMessage: exactMessage });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.userMessage).toBe(exactMessage);
  });

  it('10. current userMessage is NOT already inserted into history passed to orchestrator', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'Hi' },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Turn 1 user message' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.history?.length).toBe(0);
  });

  it('11. successful send appends user turn', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'Nice to meet you' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const result = await session.send({ userMessage: 'Hi, I am Alex' });

    expect(result.ok).toBe(true);
    expect(session.getHistory()).toEqual([
      { role: 'user', content: 'Hi, I am Alex' },
      { role: 'assistant', content: 'Nice to meet you' },
    ]);
  });

  it('12. successful send appends assistant turn', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'Assistant answer' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Question' });

    const history = session.getHistory();
    expect(history[1]).toEqual({ role: 'assistant', content: 'Assistant answer' });
  });

  it('13. successful turns are chronological user → assistant', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'Response turn' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'User turn' });

    const history = session.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.content).toBe('User turn');
    expect(history[1]?.role).toBe('assistant');
    expect(history[1]?.content).toBe('Response turn');
  });

  it('14. second send receives first completed exchange as history', async () => {
    let secondCallInput: ConversationRequestInput | undefined;
    let callIndex = 0;

    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        callIndex += 1;
        if (callIndex === 2) {
          secondCallInput = input;
        }
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: `Assistant reply ${callIndex}` },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'First message' });
    await session.send({ userMessage: 'Second message' });

    expect(secondCallInput).toBeDefined();
    expect(secondCallInput!.history).toEqual([
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'Assistant reply 1' },
    ]);
  });

  it('15. multiple successful sends accumulate correctly', async () => {
    let callIndex = 0;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async () => {
        callIndex += 1;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: `Reply ${callIndex}` },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Message 1' });
    await session.send({ userMessage: 'Message 2' });
    await session.send({ userMessage: 'Message 3' });

    const history = session.getHistory();
    expect(history).toEqual([
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Reply 2' },
      { role: 'user', content: 'Message 3' },
      { role: 'assistant', content: 'Reply 3' },
    ]);
  });

  it('16. successful assistant content is preserved exactly', async () => {
    const rawContent = '  Exact formatted \n\n assistant answer with emoji 🌟  ';
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: rawContent },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const result = await session.send({ userMessage: 'Formatting test' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe(rawContent);
      expect(result.history[1]?.content).toBe(rawContent);
    }
  });

  it('17. provider failure does not append user turn', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: false,
        request: createMockConversationRequest(),
        error: { code: 'rate_limit', message: 'Quota exceeded', retryable: true },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const result = await session.send({ userMessage: 'Failed message' });

    expect(result.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);
  });

  it('18. provider failure does not append assistant turn', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: false,
        request: createMockConversationRequest(),
        error: { code: 'unavailable', message: 'Service down', retryable: true },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Failed message' });

    expect(session.getHistory().length).toBe(0);
  });

  it('19. provider failure leaves previous history unchanged', async () => {
    let callCount = 0;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: true,
            request: createMockConversationRequest(),
            response: { content: 'First reply' },
          };
        }
        return {
          ok: false,
          request: createMockConversationRequest(),
          error: { code: 'rate_limit', message: 'Rate limit', retryable: true },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'First successful' });

    const beforeFailureHistory = session.getHistory();
    expect(beforeFailureHistory).toEqual([
      { role: 'user', content: 'First successful' },
      { role: 'assistant', content: 'First reply' },
    ]);

    const failResult = await session.send({ userMessage: 'Second failed' });
    expect(failResult.ok).toBe(false);

    expect(session.getHistory()).toEqual(beforeFailureHistory);
    expect(failResult.history).toEqual(beforeFailureHistory);
  });

  it('20. retrying after provider failure does not duplicate failed user message', async () => {
    let callCount = 0;
    let thirdCallInput: ConversationRequestInput | undefined;

    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: true,
            request: createMockConversationRequest(),
            response: { content: 'Answer 1' },
          };
        }
        if (callCount === 2) {
          return {
            ok: false,
            request: createMockConversationRequest(),
            error: { code: 'unavailable', message: 'Down', retryable: true },
          };
        }
        thirdCallInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'Answer 2 (after retry)' },
        };
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Message 1' });

    // Fails on call 2
    const failResult = await session.send({ userMessage: 'Message 2' });
    expect(failResult.ok).toBe(false);

    // Retries on call 3
    const successResult = await session.send({ userMessage: 'Message 2' });
    expect(successResult.ok).toBe(true);

    expect(thirdCallInput).toBeDefined();
    expect(thirdCallInput!.history).toEqual([
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Answer 1' },
    ]);

    expect(session.getHistory()).toEqual([
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Answer 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Answer 2 (after retry)' },
    ]);
  });

  it('21. orchestrator thrown error propagates', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockRejectedValue(new Error('Conversation engine build error')),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await expect(session.send({ userMessage: '' })).rejects.toThrow(
      'Conversation engine build error'
    );
  });

  it('22. orchestrator thrown error leaves history unchanged', async () => {
    let callCount = 0;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            ok: true,
            request: createMockConversationRequest(),
            response: { content: 'Answer 1' },
          };
        }
        throw new Error('Local engine failure');
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Message 1' });

    await expect(session.send({ userMessage: 'Message 2' })).rejects.toThrow(
      'Local engine failure'
    );

    expect(session.getHistory()).toEqual([
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Answer 1' },
    ]);
  });

  it('23. getHistory returns a defensive copy of array', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'Answer' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Message' });

    const history1 = session.getHistory() as ConversationTurn[];
    const history2 = session.getHistory();

    expect(history1).not.toBe(history2);
    history1.push({ role: 'user', content: 'Injected turn' });

    expect(session.getHistory().length).toBe(2);
  });

  it('24. getHistory returns defensive copies of ConversationTurn objects', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'Original answer' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Original user message' });

    const history = session.getHistory() as Array<{ role: 'user' | 'assistant'; content: string }>;
    history[0]!.content = 'Tampered user message';
    history[1]!.content = 'Tampered assistant message';

    const freshHistory = session.getHistory();
    expect(freshHistory[0]?.content).toBe('Original user message');
    expect(freshHistory[1]?.content).toBe('Original answer');
  });

  it('25. mutating result.history does not mutate internal history', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'Answer' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const result = await session.send({ userMessage: 'User prompt' });

    if (result.ok) {
      const mutableHistory = result.history as Array<{ role: 'user' | 'assistant'; content: string }>;
      mutableHistory.push({ role: 'user', content: 'Extra turn' });
      mutableHistory[0]!.content = 'Changed content';
    }

    const currentHistory = session.getHistory();
    expect(currentHistory.length).toBe(2);
    expect(currentHistory[0]?.content).toBe('User prompt');
  });

  it('26. clear removes all history', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'Answer' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    await session.send({ userMessage: 'Message' });
    expect(session.getHistory().length).toBe(2);

    session.clear();
    expect(session.getHistory()).toEqual([]);
  });

  it('27. clear does not call orchestrator', () => {
    const executeMock = vi.fn();
    const mockOrchestrator: ConversationOrchestrator = { execute: executeMock };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    session.clear();

    expect(executeMock).not.toHaveBeenCalled();
  });

  it('28. clear does not change configured mode', () => {
    const session = createConversationSession(
      { execute: vi.fn() },
      { mode: 'coach', topic: 'grammar' }
    );
    session.clear();
    expect(session.getConfig().mode).toBe('coach');
  });

  it('29. clear does not change configured topic', () => {
    const session = createConversationSession(
      { execute: vi.fn() },
      { mode: 'intensive', topic: 'interview' }
    );
    session.clear();
    expect(session.getConfig().topic).toBe('interview');
  });

  it('30. clear does not change configured historyLimit', () => {
    const session = createConversationSession(
      { execute: vi.fn() },
      { mode: 'natural', historyLimit: 12 }
    );
    session.clear();
    expect(session.getConfig().historyLimit).toBe(12);
  });

  it('31. original config mutation after factory creation does not affect session', async () => {
    let capturedInput: ConversationRequestInput | undefined;
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockImplementation(async (input: ConversationRequestInput) => {
        capturedInput = input;
        return {
          ok: true,
          request: createMockConversationRequest(),
          response: { content: 'OK' },
        };
      }),
    };

    const mutableConfig: {
      mode: 'natural' | 'coach' | 'intensive';
      topic?: string | null;
      historyLimit?: number;
    } = {
      mode: 'natural',
      topic: 'Original topic',
      historyLimit: 5,
    };

    const session = createConversationSession(mockOrchestrator, mutableConfig);

    // Mutate caller config object
    mutableConfig.mode = 'coach';
    mutableConfig.topic = 'Mutated topic';
    mutableConfig.historyLimit = 999;

    await session.send({ userMessage: 'Test' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.mode).toBe('natural');
    expect(capturedInput!.topic).toBe('Original topic');
    expect(capturedInput!.historyLimit).toBe(5);
  });

  it('32. successful AIProviderResponse metadata is preserved', async () => {
    const fullResponse: AIProviderResponse = {
      content: 'Detailed answer',
      finishReason: 'completed',
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
    };

    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: fullResponse,
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const result = await session.send({ userMessage: 'Hi' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toEqual(fullResponse);
      expect(result.response.finishReason).toBe('completed');
      expect(result.response.usage).toEqual({
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
      });
    }
  });

  it('33. provider AIProviderError values are preserved', async () => {
    const providerError: AIProviderError = {
      code: 'rate_limit',
      message: 'Rate limit exceeded: 60 RPM',
      retryable: true,
    };

    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: false,
        request: createMockConversationRequest(),
        error: providerError,
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const result = await session.send({ userMessage: 'Hi' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(providerError);
      expect(result.error.code).toBe('rate_limit');
      expect(result.error.message).toBe('Rate limit exceeded: 60 RPM');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('34. no automatic retry occurs on retryable provider error', async () => {
    const executeMock = vi.fn().mockResolvedValue({
      ok: false,
      request: createMockConversationRequest(),
      error: { code: 'unavailable', message: 'Service unavailable', retryable: true },
    });

    const mockOrchestrator: ConversationOrchestrator = { execute: executeMock };
    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });

    const result = await session.send({ userMessage: 'Hello' });
    expect(result.ok).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('35. one send causes at most one orchestrator.execute call', async () => {
    const executeMock = vi.fn().mockResolvedValue({
      ok: true,
      request: createMockConversationRequest(),
      response: { content: 'Single call' },
    });

    const mockOrchestrator: ConversationOrchestrator = { execute: executeMock };
    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });

    await session.send({ userMessage: 'Single test' });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('36. session contains no generated timestamps/IDs', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: createMockConversationRequest(),
        response: { content: 'No metadata' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });
    const result = await session.send({ userMessage: 'Check turns' });

    if (result.ok) {
      for (const turn of result.history) {
        expect(Object.keys(turn).sort()).toEqual(['content', 'role']);
        const turnRecord = turn as unknown as Record<string, unknown>;
        expect(turnRecord.id).toBeUndefined();
        expect(turnRecord.timestamp).toBeUndefined();
        expect(turnRecord.createdAt).toBeUndefined();
      }
    }
  });

  describe('saveVocabularyItem and persistence error handling', () => {
    it('returns true and marks in-memory state when onSaveVocabulary callback succeeds', async () => {
      const mockOrchestrator: ConversationOrchestrator = { execute: vi.fn() };
      const onSaveMock = vi.fn().mockResolvedValue(true);
      const session = createConversationSession(mockOrchestrator, {
        mode: 'natural',
        onSaveVocabulary: onSaveMock,
      });

      const vocab = {
        headword: 'resilient',
        type: 'word' as const,
        meaning: 'able to withstand recovery',
        example: 'They are resilient.',
      };

      const result = await session.saveVocabularyItem(vocab);
      expect(result).toBe(true);
      expect(session.isVocabularySaved('resilient')).toBe(true);
      expect(session.isVocabularySaved('RESILIENT')).toBe(true);
      expect(onSaveMock).toHaveBeenCalledWith(vocab);
    });

    it('returns false and does NOT mark in-memory state when onSaveVocabulary callback throws an error', async () => {
      const mockOrchestrator: ConversationOrchestrator = { execute: vi.fn() };
      const onSaveMock = vi.fn().mockRejectedValue(new Error('SQLite write error'));
      const session = createConversationSession(mockOrchestrator, {
        mode: 'natural',
        onSaveVocabulary: onSaveMock,
      });

      const vocab = {
        headword: 'ephemeral',
        type: 'word' as const,
        meaning: 'short-lived',
        example: 'Beauty is ephemeral.',
      };

      const result = await session.saveVocabularyItem(vocab);
      expect(result).toBe(false);
      expect(session.isVocabularySaved('ephemeral')).toBe(false);
      expect(session.getSavedVocabulary()).toEqual([]);
    });

    it('returns false and does NOT mark in-memory state when onSaveVocabulary callback returns false or null', async () => {
      const mockOrchestrator: ConversationOrchestrator = { execute: vi.fn() };
      const onSaveMock = vi.fn().mockResolvedValue(null);
      const session = createConversationSession(mockOrchestrator, {
        mode: 'natural',
        onSaveVocabulary: onSaveMock,
      });

      const vocab = {
        headword: 'fleeting',
        type: 'word' as const,
        meaning: 'lasting for a very short time',
        example: 'A fleeting moment.',
      };

      const result = await session.saveVocabularyItem(vocab);
      expect(result).toBe(false);
      expect(session.isVocabularySaved('fleeting')).toBe(false);
    });

    it('saves in-memory and returns true when no onSaveVocabulary callback is configured (Demo mode)', async () => {
      const mockOrchestrator: ConversationOrchestrator = { execute: vi.fn() };
      const session = createConversationSession(mockOrchestrator, { mode: 'natural' });

      const vocab = {
        headword: 'ubiquitous',
        type: 'word' as const,
        meaning: 'found everywhere',
        example: 'Wi-Fi is ubiquitous.',
      };

      const result = await session.saveVocabularyItem(vocab);
      expect(result).toBe(true);
      expect(session.isVocabularySaved('ubiquitous')).toBe(true);
    });

    it('auto-saves feedback vocabulary in memory when callback succeeds on assistant turn', async () => {
      const mockOrchestrator: ConversationOrchestrator = {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          request: createMockConversationRequest(),
          response: {
            content: 'That is a great word!',
            feedback: {
              vocabulary: {
                headword: 'serendipity',
                type: 'word',
                meaning: 'chance discovery',
                example: 'By serendipity.',
              },
            },
          },
        }),
      };
      const onSaveMock = vi.fn().mockResolvedValue(true);

      const session = createConversationSession(mockOrchestrator, {
        mode: 'natural',
        onSaveVocabulary: onSaveMock,
      });

      const result = await session.send({ userMessage: 'What does serendipity mean?' });
      expect(result.ok).toBe(true);
      expect(session.isVocabularySaved('serendipity')).toBe(true);
      expect(onSaveMock).toHaveBeenCalled();
    });

    it('auto-save failure on assistant turn is non-blocking and does not mark in-memory saved status', async () => {
      const mockOrchestrator: ConversationOrchestrator = {
        execute: vi.fn().mockResolvedValue({
          ok: true,
          request: createMockConversationRequest(),
          response: {
            content: 'Great turn!',
            feedback: {
              vocabulary: {
                headword: 'ephemeral',
                type: 'word',
                meaning: 'short-lived',
                example: 'Ephemeral joy.',
              },
            },
          },
        }),
      };
      const onSaveMock = vi.fn().mockRejectedValue(new Error('Database write error'));

      const session = createConversationSession(mockOrchestrator, {
        mode: 'natural',
        onSaveVocabulary: onSaveMock,
      });

      const result = await session.send({ userMessage: 'Hello' });
      expect(result.ok).toBe(true);
      expect(result.history).toHaveLength(2);
      expect(session.isVocabularySaved('ephemeral')).toBe(false);
    });
  });
});
