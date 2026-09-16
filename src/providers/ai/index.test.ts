/**
 * src/providers/ai/index.test.ts
 *
 * Unit tests for the provider-neutral AI Provider abstraction layer.
 */

import { describe, expect, it } from 'vitest';
import type {
  AIFinishReason,
  AIProvider,
  AIProviderError,
  AIProviderErrorCode,
  AIProviderResponse,
  AIProviderResult,
  AIUsage,
  ConversationRequest,
} from './index';
import {
  createAIProviderError,
  createAIProviderFailure,
  createAIProviderResponse,
  createAIProviderSuccess,
} from './index';

function createMockConversationRequest(
  overrides?: Partial<ConversationRequest>
): ConversationRequest {
  return {
    systemPrompt: 'You are a warm, supportive ESL tutor.',
    messages: [
      { role: 'user', content: 'Hello teacher!' },
      { role: 'assistant', content: 'Hello! How are you today?' },
      { role: 'user', content: 'I am doing well, thank you.' },
    ],
    mode: 'natural',
    topic: 'Daily Greetings',
    coachingContext: {
      profile: {
        learnerId: 'learner-1',
        displayName: 'Sam',
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
    },
    ...overrides,
  };
}

describe('AIProvider Abstraction Layer', () => {
  it('1. AIProvider interface can be implemented by a simple in-memory fake', async () => {
    class InMemoryFakeProvider implements AIProvider {
      readonly id = 'in-memory-fake';

      async generate(request: ConversationRequest): Promise<AIProviderResult> {
        return createAIProviderSuccess(
          createAIProviderResponse(`Echo: ${request.messages[request.messages.length - 1].content}`)
        );
      }
    }

    const provider: AIProvider = new InMemoryFakeProvider();
    expect(provider.id).toBe('in-memory-fake');

    const request = createMockConversationRequest();
    const result = await provider.generate(request);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe('Echo: I am doing well, thank you.');
    }
  });

  it('2. provider receives the existing ConversationRequest unchanged', async () => {
    let capturedRequest: ConversationRequest | null = null;

    const provider: AIProvider = {
      id: 'capturing-provider',
      async generate(request: ConversationRequest): Promise<AIProviderResult> {
        capturedRequest = request;
        return {
          ok: true,
          response: {
            content: 'Great conversation so far.',
          },
        };
      },
    };

    const originalRequest = createMockConversationRequest({
      topic: 'Workplace presentations',
      mode: 'coach',
    });

    const result = await provider.generate(originalRequest);

    expect(result.ok).toBe(true);
    expect(capturedRequest).not.toBeNull();
    const captured = capturedRequest as unknown as ConversationRequest;
    expect(captured).toBe(originalRequest);
    expect(captured.topic).toBe('Workplace presentations');
    expect(captured.mode).toBe('coach');
    expect(captured.systemPrompt).toBe('You are a warm, supportive ESL tutor.');
    expect(captured.messages).toHaveLength(3);
  });

  it('3. successful AIProviderResult structure', () => {
    const response: AIProviderResponse = {
      content: 'That sounds like a great plan for tomorrow.',
      finishReason: 'completed',
      usage: {
        inputTokens: 42,
        outputTokens: 12,
        totalTokens: 54,
      },
    };

    const result = createAIProviderSuccess(response);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe('That sounds like a great plan for tomorrow.');
      expect(result.response.finishReason).toBe('completed');
      expect(result.response.usage).toEqual({
        inputTokens: 42,
        outputTokens: 12,
        totalTokens: 54,
      });
    }
  });

  it('4. failed AIProviderResult structure', () => {
    const error: AIProviderError = createAIProviderError(
      'rate_limit',
      'Rate limit exceeded. Please wait.',
      true
    );
    const result = createAIProviderFailure(error);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate_limit');
      expect(result.error.message).toBe('Rate limit exceeded. Please wait.');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('5. successful content is preserved exactly', () => {
    const sampleText = 'Line 1\nLine 2 with special characters: € & "quotes" \'single\'';
    const response = createAIProviderResponse(sampleText);

    expect(response.content).toBe(sampleText);
  });

  it('6. blank response content is rejected if using response helper', () => {
    expect(() => createAIProviderResponse('')).toThrow(
      'AI response content cannot be empty or whitespace only.'
    );
    expect(() => createAIProviderResponse('   ')).toThrow(
      'AI response content cannot be empty or whitespace only.'
    );
    expect(() => createAIProviderResponse('\t\n  \r\n')).toThrow(
      'AI response content cannot be empty or whitespace only.'
    );
    expect(() => createAIProviderResponse(null as unknown as string)).toThrow(
      'AI response content cannot be empty or whitespace only.'
    );
    expect(() => createAIProviderResponse(undefined as unknown as string)).toThrow(
      'AI response content cannot be empty or whitespace only.'
    );
  });

  it('7. valid content with leading/trailing whitespace is preserved exactly', () => {
    const contentWithWhitespace = '  Hello, let us practice English today!  \n';
    const response = createAIProviderResponse(contentWithWhitespace);

    expect(response.content).toBe('  Hello, let us practice English today!  \n');
    expect(response.content).not.toBe('Hello, let us practice English today!');
  });

  it('8. finishReason accepts only neutral contract values at type level/runtime', () => {
    const validFinishReasons: AIFinishReason[] = [
      'completed',
      'length',
      'blocked',
      'cancelled',
      'unknown',
    ];

    for (const reason of validFinishReasons) {
      const response = createAIProviderResponse('Valid output', { finishReason: reason });
      expect(response.finishReason).toBe(reason);
    }
  });

  it('9. usage values are not fabricated', () => {
    const responseWithoutUsage = createAIProviderResponse('Just content');
    expect(responseWithoutUsage.usage).toBeUndefined();

    const partialUsage: AIUsage = { inputTokens: 10 };
    const responseWithPartial = createAIProviderResponse('Just content', { usage: partialUsage });
    expect(responseWithPartial.usage?.inputTokens).toBe(10);
    expect(responseWithPartial.usage?.outputTokens).toBeUndefined();
    expect(responseWithPartial.usage?.totalTokens).toBeUndefined();
  });

  it('10. usage metadata is defensively copied if helper accepts it', () => {
    const mutableUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };

    const response = createAIProviderResponse('Content with usage', { usage: mutableUsage });

    // Mutate caller object
    mutableUsage.inputTokens = 999;
    mutableUsage.outputTokens = 999;
    mutableUsage.totalTokens = 1998;

    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it('11. retryable error true is preserved', () => {
    const error = createAIProviderError('unavailable', 'Service temporarily unavailable', true);
    expect(error.code).toBe('unavailable');
    expect(error.message).toBe('Service temporarily unavailable');
    expect(error.retryable).toBe(true);

    const result = createAIProviderFailure(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  it('12. retryable error false is preserved', () => {
    const error = createAIProviderError('authentication', 'Invalid credentials provided', false);
    expect(error.code).toBe('authentication');
    expect(error.message).toBe('Invalid credentials provided');
    expect(error.retryable).toBe(false);

    const result = createAIProviderFailure(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });

  it('13. provider errors expose neutral code/message/retryable only', () => {
    const codes: AIProviderErrorCode[] = [
      'invalid_request',
      'authentication',
      'rate_limit',
      'unavailable',
      'timeout',
      'cancelled',
      'unknown',
    ];

    for (const code of codes) {
      const err = createAIProviderError(code, `Sample message for ${code}`, false);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`Sample message for ${code}`);
      expect(err.retryable).toBe(false);
      expect(Object.keys(err).sort()).toEqual(['code', 'message', 'retryable'].sort());
    }
  });

  it('14. no vendor-specific fields appear in the public types or helper outputs', () => {
    const response = createAIProviderResponse('Standard response', {
      finishReason: 'completed',
      usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
    });

    const responseKeys = Object.keys(response);
    expect(responseKeys).not.toContain('model');
    expect(responseKeys).not.toContain('candidates');
    expect(responseKeys).not.toContain('promptFeedback');
    expect(responseKeys).not.toContain('choices');
    expect(responseKeys).not.toContain('gemini');
    expect(responseKeys).not.toContain('openai');
    expect(responseKeys).not.toContain('claude');

    const err = createAIProviderError('unknown', 'Unexpected issue', false);
    const errKeys = Object.keys(err);
    expect(errKeys).not.toContain('httpStatus');
    expect(errKeys).not.toContain('endpoint');
    expect(errKeys).not.toContain('headers');
    expect(errKeys).not.toContain('apiKey');
  });

  it('15. no network call is required to implement/use AIProvider', async () => {
    const mockProvider: AIProvider = {
      id: 'local-test-provider',
      async generate(): Promise<AIProviderResult> {
        return createAIProviderSuccess(
          createAIProviderResponse('Pure in-memory synchronous response')
        );
      },
    };

    const result = await mockProvider.generate(createMockConversationRequest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe('Pure in-memory synchronous response');
    }
  });

  it('16. repeated equivalent helper calls are deterministic', () => {
    const res1 = createAIProviderResponse('Exact match', {
      finishReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    const res2 = createAIProviderResponse('Exact match', {
      finishReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });

    expect(res1).toEqual(res2);

    const err1 = createAIProviderError('timeout', 'Request timed out after 5000ms', true);
    const err2 = createAIProviderError('timeout', 'Request timed out after 5000ms', true);

    expect(err1).toEqual(err2);
  });

  it('17. createAIProviderError rejects blank/whitespace error messages', () => {
    expect(() => createAIProviderError('invalid_request', '', false)).toThrow(
      'AI provider error message cannot be empty or whitespace only.'
    );
    expect(() => createAIProviderError('invalid_request', '   ', false)).toThrow(
      'AI provider error message cannot be empty or whitespace only.'
    );
    expect(() => createAIProviderError('invalid_request', null as unknown as string, false)).toThrow(
      'AI provider error message cannot be empty or whitespace only.'
    );
  });

  it('18. error provider simulation returning discriminated union error result', async () => {
    const failingProvider: AIProvider = {
      id: 'failing-provider',
      async generate(): Promise<AIProviderResult> {
        return createAIProviderFailure(
          createAIProviderError('unavailable', 'AI service is currently down for maintenance.', true)
        );
      },
    };

    const request = createMockConversationRequest();
    const result = await failingProvider.generate(request);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unavailable');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain('down for maintenance');
    }
  });
});
