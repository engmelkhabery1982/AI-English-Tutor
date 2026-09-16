import { describe, expect, it, vi } from 'vitest';
import { createDemoAIProvider } from './demo';
import { createGeminiAIProvider } from './gemini';
import type { ConversationRequest } from '../../conversation-engine';
import { createDemoLearnerModel } from '../../talk-demo/demo-learner-model';

const SAMPLE_REQUEST: ConversationRequest = {
  mode: 'natural',
  topic: null,
  systemPrompt: 'You are an English tutor.',
  messages: [{ role: 'user', content: 'Hello there' }],
  coachingContext: createDemoLearnerModel().getCoachingContext(),
};

describe('AIProvider Streaming & Feedback', () => {
  describe('DemoAIProvider', () => {
    it('streams chunks and returns deterministic feedback', async () => {
      const provider = createDemoAIProvider();
      const chunks: string[] = [];

      expect(provider.generateStream).toBeDefined();
      const result = await provider.generateStream!(SAMPLE_REQUEST, (chunk) => {
        chunks.push(chunk);
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.join('')).toBe(result.response.content);
        expect(result.response.feedback).toBeDefined();
        expect(result.response.feedback?.coachingNote).toBeDefined();
      }
    });
  });

  describe('GeminiAIProvider streaming', () => {
    it('processes SSE stream response and filters feedback', async () => {
      const ssePayload = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello from "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"streaming Gemini!\\n[FEEDBACK]\\n{\\"coachingNote\\":\\"Fluent phrasing\\"}\\n[/FEEDBACK]"}]}}]}\n\n',
      ].join('');

      const mockResponse = {
        ok: true,
        status: 200,
        text: async () => ssePayload,
      } as unknown as Response;

      const mockFetch = vi.fn().mockResolvedValue(mockResponse);

      const provider = createGeminiAIProvider({
        apiKey: 'test-api-key',
        fetchImpl: mockFetch,
      });

      const chunks: string[] = [];
      expect(provider.generateStream).toBeDefined();
      const result = await provider.generateStream!(SAMPLE_REQUEST, (chunk) => {
        chunks.push(chunk);
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(chunks.join('').trim()).toBe('Hello from streaming Gemini!');
        expect(result.response.content.trim()).toBe('Hello from streaming Gemini!');
        expect(result.response.feedback?.coachingNote).toBe('Fluent phrasing');
      }
    });
  });
});
