import { describe, expect, it, vi } from 'vitest';
import {
  createDemoLearnerModel,
  createTalkDemoSession,
  createTalkSession,
} from './index';

describe('Talk Demo & Composition Stack', () => {
  describe('DemoLearnerModel', () => {
    it('provides deterministic profile and coaching context', async () => {
      const model = createDemoLearnerModel();
      expect(model.profile.displayName).toBe('Learner');
      expect(model.profile.currentLevel).toBe('B1');
      expect(model.profile.targetLevel).toBe('B2');

      const ctx = model.getCoachingContext();
      expect(ctx.profile.displayName).toBe('Learner');
      expect(ctx.profile.currentLevel).toBe('B1');
      expect(ctx.profile.targetLevel).toBe('B2');
      expect(ctx.profile.learningGoals).toEqual(['fluency', 'natural conversation']);
      expect(ctx.dueReviewCount).toBe(0);
      expect(ctx.generatedAt).toBe('2026-01-01T00:00:00.000Z');

      // No-op methods execute safely
      await model.refresh();
      const unsub = model.subscribe(() => {});
      unsub();

      expect(model.getActiveWeaknesses()).toEqual([]);
      expect(model.getStrengths()).toEqual([]);
      expect(model.getSavedVocabulary()).toEqual([]);
      expect(model.getDueReview()).toEqual([]);
      expect(model.getRecentProgress()).toEqual([]);
      expect(model.getLatestProgress()).toBeNull();
      expect(model.getWeaknessSummary().total).toBe(0);
      expect(model.getVocabularySummary().totalItems).toBe(0);
      expect(model.getExpressionSummary().totalItems).toBe(0);
      expect(model.getProgressSummary().recordsCount).toBe(0);
      expect(model.getDashboardSnapshot().dueReviewCount).toBe(0);
    });
  });

  describe('createTalkSession provider selection', () => {
    it('selects Demo provider when no API key is provided', () => {
      const originalEnv = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;

      const bundle = createTalkSession({ mode: 'natural' });
      expect(bundle.providerKind).toBe('demo');
      expect(typeof bundle.session.send).toBe('function');

      if (originalEnv !== undefined) {
        process.env.EXPO_PUBLIC_GEMINI_API_KEY = originalEnv;
      }
    });

    it('selects Gemini provider when API key is provided', () => {
      const bundle = createTalkSession(
        { mode: 'coach', topic: 'Travel' },
        { apiKey: 'explicit-test-api-key' }
      );
      expect(bundle.providerKind).toBe('gemini');
      expect(typeof bundle.session.send).toBe('function');
      expect(bundle.session.getConfig().mode).toBe('coach');
      expect(bundle.session.getConfig().topic).toBe('Travel');
    });

    it('executes end-to-end multi-turn session with mocked Gemini provider', async () => {
      const mockCalls: { url: string; body: Record<string, unknown> }[] = [];

      const mockFetch: typeof fetch = vi.fn(async (input, init) => {
        const body = JSON.parse((init?.body as string) || '{}');
        mockCalls.push({ url: input.toString(), body });

        const isSecondTurn = mockCalls.length === 2;
        const textReply = isSecondTurn
          ? 'Traveling is wonderful! Where did you go on your last trip?'
          : 'Hello! I am ready to help you with English.';

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: textReply }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 15,
              totalTokenCount: 35,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const bundle = createTalkSession(
        { mode: 'natural', topic: 'Vacation' },
        { apiKey: 'mock-gemini-key', fetchImpl: mockFetch }
      );

      expect(bundle.providerKind).toBe('gemini');

      // Turn 1
      const turn1Result = await bundle.session.send({ userMessage: 'Hello Gemini!' });
      expect(turn1Result.ok).toBe(true);
      if (turn1Result.ok) {
        expect(turn1Result.response.content).toBe(
          'Hello! I am ready to help you with English.'
        );
        expect(turn1Result.history).toHaveLength(2);
      }

      expect(mockCalls).toHaveLength(1);
      const firstCallContents = mockCalls[0].body.contents as {
        role: string;
        parts: { text: string }[];
      }[];
      expect(firstCallContents).toEqual([
        { role: 'user', parts: [{ text: 'Hello Gemini!' }] },
      ]);

      // Turn 2
      const turn2Result = await bundle.session.send({
        userMessage: 'I love traveling in summer.',
      });
      expect(turn2Result.ok).toBe(true);
      if (turn2Result.ok) {
        expect(turn2Result.response.content).toContain('Where did you go on your last trip?');
        expect(turn2Result.history).toHaveLength(4);
      }

      expect(mockCalls).toHaveLength(2);
      const secondCallContents = mockCalls[1].body.contents as {
        role: string;
        parts: { text: string }[];
      }[];
      expect(secondCallContents).toEqual([
        { role: 'user', parts: [{ text: 'Hello Gemini!' }] },
        {
          role: 'model',
          parts: [{ text: 'Hello! I am ready to help you with English.' }],
        },
        { role: 'user', parts: [{ text: 'I love traveling in summer.' }] },
      ]);
    });
  });

  describe('createTalkDemoSession', () => {
    it('creates an end-to-end working ConversationSession with demo provider', async () => {
      const session = createTalkDemoSession({
        mode: 'natural',
        topic: 'Travel',
      });

      expect(session.getConfig().mode).toBe('natural');
      expect(session.getConfig().topic).toBe('Travel');
      expect(session.getHistory()).toEqual([]);

      // 1. First send
      const firstResult = await session.send({ userMessage: 'Hello!' });
      expect(firstResult.ok).toBe(true);
      if (firstResult.ok) {
        expect(firstResult.history).toHaveLength(2);
        expect(firstResult.history[0]).toEqual({ role: 'user', content: 'Hello!' });
        expect(firstResult.history[1].role).toBe('assistant');
        expect(firstResult.history[1].content).toContain("Let's talk about Travel!");
      }

      // 2. Second send includes previous completed exchange
      const secondResult = await session.send({
        userMessage: 'I went to meeting yesterday',
      });
      expect(secondResult.ok).toBe(true);
      if (secondResult.ok) {
        expect(secondResult.history).toHaveLength(4);
        expect(secondResult.history[0].content).toBe('Hello!');
        expect(secondResult.history[2].content).toBe('I went to meeting yesterday');
        expect(secondResult.history[3].content).toContain('I went to a meeting');
      }

      // Session history matches result history
      expect(session.getHistory()).toHaveLength(4);

      // 3. Clear resets conversation history
      session.clear();
      expect(session.getHistory()).toEqual([]);
    });

    it('works across coach and intensive modes', async () => {
      const coachSession = createTalkDemoSession({
        mode: 'coach',
      });
      const coachResult = await coachSession.send({ userMessage: 'I like dogs' });
      expect(coachResult.ok).toBe(true);
      if (coachResult.ok) {
        expect(coachResult.response.content).toContain('coach mode');
      }

      const intensiveSession = createTalkDemoSession({
        mode: 'intensive',
      });
      const intensiveResult = await intensiveSession.send({
        userMessage: 'I like dogs',
      });
      expect(intensiveResult.ok).toBe(true);
      if (intensiveResult.ok) {
        expect(intensiveResult.response.content).toContain('intensive mode');
      }
    });

    it('rejects empty user message without mutating history', async () => {
      const session = createTalkDemoSession({
        mode: 'natural',
      });

      await expect(session.send({ userMessage: '   ' })).rejects.toThrow(
        'User message cannot be empty or whitespace only.'
      );
      expect(session.getHistory()).toEqual([]);
    });
  });
});
