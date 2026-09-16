import { describe, expect, it, vi } from 'vitest';
import { createConversationSession } from './index';
import type { ConversationOrchestrator } from '../conversation-orchestrator';
import type { AIStreamCallback, ConversationFeedbackVocabulary } from '../providers/ai';

describe('ConversationSession Streaming & Vocabulary Persistence', () => {
  it('supports send with streaming callback and retains feedback', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn(),
      executeStream: vi.fn(async (_req, onChunk: AIStreamCallback) => {
        onChunk('Hello ');
        onChunk('learner!');
        return {
          ok: true as const,
          request: {
            mode: 'coach' as const,
            topic: null,
            systemPrompt: '',
            messages: [],
            coachingContext: {} as any,
          },
          response: {
            content: 'Hello learner!',
            model: 'demo',
            feedback: {
              correction: null,
              vocabulary: {
                headword: 'flourish',
                type: 'word' as const,
                meaning: 'to grow or develop in a healthy way',
                example: 'Plants flourish in sunlight.',
              },
              coachingNote: 'Keep up the good work!',
            },
          },
        };
      }),
    };

    const savedVocabList: ConversationFeedbackVocabulary[] = [];
    const session = createConversationSession(mockOrchestrator, {
      mode: 'coach',
      onSaveVocabulary: (vocab) => {
        savedVocabList.push(vocab);
      },
    });

    const streamedChunks: string[] = [];
    const result = await session.send(
      { userMessage: 'Hi tutor' },
      (chunk) => streamedChunks.push(chunk)
    );

    expect(result.ok).toBe(true);
    expect(streamedChunks.join('')).toBe('Hello learner!');
    expect(session.getLastFeedback()?.vocabulary?.headword).toBe('flourish');
    expect(session.isVocabularySaved('flourish')).toBe(true);
    expect(savedVocabList).toHaveLength(1);
    expect(savedVocabList[0].headword).toBe('flourish');
  });

  it('allows manual saveVocabularyItem and tracks saved status', async () => {
    const mockOrchestrator: ConversationOrchestrator = {
      execute: vi.fn().mockResolvedValue({
        ok: true,
        request: { systemPrompt: '', messages: [] },
        response: { content: 'Answer', model: 'demo' },
      }),
    };

    const session = createConversationSession(mockOrchestrator, { mode: 'natural' });

    expect(session.isVocabularySaved('resilient')).toBe(false);

    await session.saveVocabularyItem({
      headword: 'resilient',
      type: 'word',
      meaning: 'able to withstand or recover quickly from difficult conditions',
      example: 'She is a resilient student.',
    });

    expect(session.isVocabularySaved('resilient')).toBe(true);
    expect(session.isVocabularySaved('RESILIENT')).toBe(true);
    expect(session.getSavedVocabulary()).toHaveLength(1);
  });
});
