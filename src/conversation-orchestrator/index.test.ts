/**
 * src/conversation-orchestrator/index.test.ts
 *
 * Comprehensive unit tests for the provider-neutral Conversation Orchestrator.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  CoachingContext,
  ConversationEngine,
  ConversationRequest,
  ConversationRequestInput,
} from '../conversation-engine';
import type {
  AIProvider,
  AIProviderError,
  AIProviderResponse,
  AIProviderResult,
} from '../providers/ai';
import { createConversationOrchestrator } from './index';

function createMockCoachingContext(): CoachingContext {
  return {
    profile: {
      learnerId: 'learner-1',
      displayName: 'Sara',
      currentLevel: 'A2',
      targetLevel: 'B2',
      learningGoals: ['travel'],
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

function createMockConversationRequest(override?: Partial<ConversationRequest>): ConversationRequest {
  return {
    systemPrompt: 'You are an English tutor.',
    messages: [
      {
        role: 'user',
        content: 'Hello, how are you?',
      },
    ],
    mode: 'natural',
    topic: 'travel',
    coachingContext: createMockCoachingContext(),
    ...override,
  };
}

function createSampleInput(): ConversationRequestInput {
  return {
    mode: 'natural',
    topic: 'travel',
    history: [],
    userMessage: 'Hello, how are you?',
  };
}

describe('ConversationOrchestrator', () => {
  it('1. factory creates a working ConversationOrchestrator', () => {
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn().mockReturnValue(createMockConversationRequest()),
    };
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: { content: 'Hi Sara!' },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    expect(orchestrator).toBeDefined();
    expect(typeof orchestrator.execute).toBe('function');
  });

  it('validates required dependencies in factory', () => {
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn(),
    };
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn(),
    };

    expect(() => createConversationOrchestrator(null as unknown as ConversationEngine, mockProvider)).toThrow(
      'ConversationEngine with buildRequest method is required.'
    );
    expect(() => createConversationOrchestrator(mockEngine, null as unknown as AIProvider)).toThrow(
      'AIProvider with generate method is required.'
    );
  });

  it('2. execute calls ConversationEngine.buildRequest exactly once', async () => {
    const mockRequest = createMockConversationRequest();
    const buildRequestMock = vi.fn().mockReturnValue(mockRequest);
    const mockEngine: ConversationEngine = { buildRequest: buildRequestMock };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: { content: 'Hello!' },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const input = createSampleInput();

    await orchestrator.execute(input);
    expect(buildRequestMock).toHaveBeenCalledTimes(1);
  });

  it('3. execute passes the original ConversationRequestInput to buildRequest', async () => {
    const mockRequest = createMockConversationRequest();
    const buildRequestMock = vi.fn().mockReturnValue(mockRequest);
    const mockEngine: ConversationEngine = { buildRequest: buildRequestMock };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: { content: 'Hello!' },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const input = createSampleInput();

    await orchestrator.execute(input);
    expect(buildRequestMock).toHaveBeenCalledWith(input);
  });

  it('4. AIProvider.generate is called exactly once on success', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const generateMock = vi.fn().mockResolvedValue({
      ok: true,
      response: { content: 'Hello there!' },
    });
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: generateMock,
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    await orchestrator.execute(createSampleInput());

    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('5. provider receives the exact ConversationRequest object returned by ConversationEngine', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const generateMock = vi.fn().mockResolvedValue({
      ok: true,
      response: { content: 'Response' },
    });
    const mockProvider: AIProvider = { id: 'fake-ai', generate: generateMock };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    await orchestrator.execute(createSampleInput());

    expect(generateMock).toHaveBeenCalledWith(mockRequest);
  });

  it('6. successful provider result maps to ok: true, request, response', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const providerResponse: AIProviderResponse = {
      content: 'I am doing well, thank you!',
      finishReason: 'completed',
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
    };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: providerResponse,
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request).toBe(mockRequest);
      expect(result.response).toEqual(providerResponse);
    }
  });

  it('7. provider failure maps to ok: false, request, error', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const providerError: AIProviderError = {
      code: 'rate_limit',
      message: 'Quota exceeded for current minute.',
      retryable: true,
    };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: false,
        error: providerError,
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.request).toBe(mockRequest);
      expect(result.error).toEqual(providerError);
    }
  });

  it('8. provider failure does NOT throw', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'unavailable',
          message: 'Server unreachable',
          retryable: true,
        },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    await expect(orchestrator.execute(createSampleInput())).resolves.not.toThrow();
  });

  it('9. ConversationEngine buildRequest error propagates', async () => {
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn().mockImplementation(() => {
        throw new Error('User input cannot be empty or whitespace only.');
      }),
    };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn(),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    await expect(orchestrator.execute(createSampleInput())).rejects.toThrow(
      'User input cannot be empty or whitespace only.'
    );
  });

  it('10. provider.generate is NOT called when buildRequest throws', async () => {
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn().mockImplementation(() => {
        throw new Error('Invalid input');
      }),
    };

    const generateMock = vi.fn();
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: generateMock,
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    await expect(orchestrator.execute(createSampleInput())).rejects.toThrow('Invalid input');

    expect(generateMock).not.toHaveBeenCalled();
  });

  it('11. successful response content is preserved exactly', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const exactContent = '  Exact response with \n multiple \t lines.  ';
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: { content: exactContent },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe(exactContent);
    }
  });

  it('12. successful finishReason is preserved', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: {
          content: 'Truncated...',
          finishReason: 'length',
        },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.finishReason).toBe('length');
    }
  });

  it('13. successful usage is preserved', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const usage = { inputTokens: 100, outputTokens: 45, totalTokens: 145 };
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: {
          content: 'Hello with usage',
          usage,
        },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.usage).toEqual(usage);
    }
  });

  it('14. provider error code is preserved', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'authentication',
          message: 'Invalid credentials provided',
          retryable: false,
        },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('authentication');
    }
  });

  it('15. provider error message is preserved', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const exactMessage = 'Rate limit reached: 60 RPM exceeded.';
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'rate_limit',
          message: exactMessage,
          retryable: true,
        },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(exactMessage);
    }
  });

  it('16. provider error retryable true is preserved', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'timeout',
          message: 'Request timed out after 30s',
          retryable: true,
        },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  it('17. provider error retryable false is preserved', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'Malformed request payload',
          retryable: false,
        },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });

  it('18. request returned in result is the same object produced by ConversationEngine', async () => {
    const mockRequest = createMockConversationRequest();
    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: { content: 'OK' },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.request).toBe(mockRequest);
  });

  it('19. orchestrator does not mutate the built request', async () => {
    const originalMessages = [{ role: 'user' as const, content: 'Hello' }];
    const mockRequest: ConversationRequest = {
      systemPrompt: 'System prompt content',
      messages: originalMessages,
      mode: 'coach',
      topic: 'grammar',
      coachingContext: createMockCoachingContext(),
    };

    const mockEngine: ConversationEngine = { buildRequest: vi.fn().mockReturnValue(mockRequest) };
    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockResolvedValue({
        ok: true,
        response: { content: 'Coach feedback' },
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.request.systemPrompt).toBe('System prompt content');
    expect(result.request.mode).toBe('coach');
    expect(result.request.topic).toBe('grammar');
    expect(result.request.messages).toBe(originalMessages);
    expect(result.request.messages.length).toBe(1);
    expect(result.request.messages[0].content).toBe('Hello');
  });

  it('20. repeated executions are independent/stateless', async () => {
    let callCount = 0;
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn().mockImplementation((input: ConversationRequestInput) => ({
        systemPrompt: 'Prompt',
        messages: [{ role: 'user', content: input.userMessage }],
        mode: input.mode,
        topic: null,
        coachingContext: createMockCoachingContext(),
      })),
    };

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockImplementation(async () => {
        callCount += 1;
        return {
          ok: true,
          response: { content: `Response #${callCount}` },
        };
      }),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);

    const input1: ConversationRequestInput = { ...createSampleInput(), userMessage: 'First turn' };
    const input2: ConversationRequestInput = { ...createSampleInput(), userMessage: 'Second turn' };

    const result1 = await orchestrator.execute(input1);
    const result2 = await orchestrator.execute(input2);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    if (result1.ok && result2.ok) {
      expect(result1.request.messages[0].content).toBe('First turn');
      expect(result1.response.content).toBe('Response #1');

      expect(result2.request.messages[0].content).toBe('Second turn');
      expect(result2.response.content).toBe('Response #2');
    }
  });

  it('21. different calls may receive different provider results without retained state', async () => {
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn().mockReturnValue(createMockConversationRequest()),
    };

    const providerResponses: AIProviderResult[] = [
      {
        ok: false,
        error: { code: 'rate_limit', message: 'Rate limit hit', retryable: true },
      },
      {
        ok: true,
        response: { content: 'Success on second attempt' },
      },
    ];

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: vi.fn().mockImplementation(async () => providerResponses.shift()!),
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);

    const res1 = await orchestrator.execute(createSampleInput());
    expect(res1.ok).toBe(false);

    const res2 = await orchestrator.execute(createSampleInput());
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.response.content).toBe('Success on second attempt');
    }
  });

  it('22. no retry happens automatically after a retryable provider error', async () => {
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn().mockReturnValue(createMockConversationRequest()),
    };

    const generateMock = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'unavailable',
        message: 'Provider down',
        retryable: true,
      },
    });

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: generateMock,
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    const result = await orchestrator.execute(createSampleInput());

    expect(result.ok).toBe(false);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('23. no second provider call occurs after any provider result', async () => {
    const mockEngine: ConversationEngine = {
      buildRequest: vi.fn().mockReturnValue(createMockConversationRequest()),
    };

    const generateMock = vi.fn().mockResolvedValue({
      ok: true,
      response: { content: 'Single generation' },
    });

    const mockProvider: AIProvider = {
      id: 'fake-ai',
      generate: generateMock,
    };

    const orchestrator = createConversationOrchestrator(mockEngine, mockProvider);
    await orchestrator.execute(createSampleInput());

    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});
