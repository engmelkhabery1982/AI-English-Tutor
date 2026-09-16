import { describe, expect, it } from 'vitest';
import type { ConversationRequest } from '../types';
import { createDemoAIProvider, DEMO_AI_PROVIDER_ID } from './index';
import type { CoachingContext } from '../../../learner-model';

const DUMMY_COACHING_CONTEXT: CoachingContext = {
  profile: {
    learnerId: '00000000-0000-0000-0000-000000000001',
    displayName: 'Learner',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: ['fluency'],
    preferredModes: ['natural', 'coach', 'intensive'],
  },
  activeWeaknesses: [],
  strengths: [],
  vocabularyFocus: [],
  expressionFocus: [],
  recentProgress: null,
  dueReviewCount: 0,
  generatedAt: '2026-01-01T00:00:00.000Z',
};

function createMockRequest(
  userMessage: string,
  mode: 'natural' | 'coach' | 'intensive' = 'natural',
  topic: string | null = null
): ConversationRequest {
  return {
    systemPrompt: 'System prompt',
    messages: [{ role: 'user', content: userMessage }],
    mode,
    topic,
    coachingContext: DUMMY_COACHING_CONTEXT,
  };
}

describe('DemoAIProvider', () => {
  it('implements AIProvider with demo-local id', () => {
    const provider = createDemoAIProvider();
    expect(provider.id).toBe(DEMO_AI_PROVIDER_ID);
    expect(typeof provider.generate).toBe('function');
  });

  it('produces deterministic greeting response', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('Hello there');
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe(
        'Hi! Nice to meet you. What would you like to talk about today?'
      );
      expect(result.response.finishReason).toBe('completed');
    }
  });

  it('produces deterministic greeting response with topic', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('Hi', 'natural', 'Travel');
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toContain("Let's talk about Travel!");
    }
  });

  it('detects common grammar / article omission pattern "went to meeting"', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('I went to meeting yesterday');
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe(
        'That sounds interesting. You could say, "I went to a meeting yesterday." What was the meeting about?'
      );
    }
  });

  it('detects common grammar tip "am agree"', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('I am agree with that point');
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toContain('Quick tip: in English we say "I agree"');
    }
  });

  it('answers common questions with deterministic reply', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('How are you doing today?');
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe(
        "I'm doing well, thank you for asking! How are your English studies going today?"
      );
    }
  });

  it('adapts fallback response according to coach mode', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('I like reading books', 'coach', null);
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toContain('In coach mode');
    }
  });

  it('adapts fallback response according to intensive mode', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('I like reading books', 'intensive', null);
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toContain('In intensive mode');
    }
  });

  it('produces conversational fallback in natural mode', async () => {
    const provider = createDemoAIProvider();
    const req = createMockRequest('I walked in the park', 'natural', null);
    const result = await provider.generate(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response.content).toBe(
        'That sounds interesting! Could you tell me a little more about that?'
      );
    }
  });

  it('rejects invalid request with empty messages', async () => {
    const provider = createDemoAIProvider();
    const req = {
      systemPrompt: 'System',
      messages: [],
      mode: 'natural' as const,
      topic: null,
      coachingContext: DUMMY_COACHING_CONTEXT,
    };

    await expect(provider.generate(req)).rejects.toThrow(
      'Demo AI Provider requires a valid ConversationRequest with non-empty messages.'
    );
  });
});
