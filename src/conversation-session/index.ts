/**
 * src/conversation-session/index.ts
 *
 * In-memory Conversation Session foundation for provider-neutral multi-turn conversation.
 */

import type {
  ConversationMode,
  ConversationRequestInput,
  ConversationTurn,
} from '../conversation-engine';
import type {
  ConversationExecutionResult,
  ConversationOrchestrator,
} from '../conversation-orchestrator';
import type {
  AIProviderError,
  AIProviderResponse,
  AIStreamCallback,
  ConversationFeedback,
  ConversationFeedbackVocabulary,
} from '../providers/ai';
import type {
  ConversationSession,
  ConversationSessionConfig,
  ConversationSessionResult,
  ConversationSessionSendInput,
} from './types';

export type {
  ConversationMode,
  ConversationTurn,
  ConversationRequestInput,
  ConversationOrchestrator,
  ConversationExecutionResult,
  AIProviderResponse,
  AIProviderError,
  AIStreamCallback,
  ConversationFeedback,
  ConversationFeedbackVocabulary,
  ConversationSessionConfig,
  ConversationSessionSendInput,
  ConversationSessionResult,
  ConversationSession,
};

/**
 * Creates a defensive copy of a conversation history array and its turns.
 */
function cloneHistory(turns: readonly ConversationTurn[]): ConversationTurn[] {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
}

/**
 * Creates an in-memory ConversationSession that maintains conversation history
 * and coordinates multi-turn text exchanges via the supplied ConversationOrchestrator.
 */
export function createConversationSession(
  orchestrator: ConversationOrchestrator,
  config: ConversationSessionConfig
): ConversationSession {
  if (!orchestrator || typeof orchestrator.execute !== 'function') {
    throw new Error('ConversationOrchestrator with execute method is required.');
  }

  if (!config || typeof config.mode !== 'string') {
    throw new Error('ConversationSessionConfig with valid mode is required.');
  }

  // Defensively capture initial configuration
  const sessionConfig: ConversationSessionConfig = {
    mode: config.mode,
    ...(config.topic !== undefined && { topic: config.topic }),
    ...(typeof config.historyLimit === 'number' && { historyLimit: config.historyLimit }),
    ...(typeof config.onSaveVocabulary === 'function' && {
      onSaveVocabulary: config.onSaveVocabulary,
    }),
  };

  const history: ConversationTurn[] = [];
  const savedVocabularyMap = new Map<string, ConversationFeedbackVocabulary>();
  let lastFeedback: ConversationFeedback | null = null;

  async function executeTurn(
    input: ConversationSessionSendInput,
    onChunk?: AIStreamCallback
  ): Promise<ConversationSessionResult> {
    const requestInput: ConversationRequestInput = {
      mode: sessionConfig.mode,
      ...(typeof sessionConfig.topic === 'string' && { topic: sessionConfig.topic }),
      ...(typeof sessionConfig.historyLimit === 'number' && {
        historyLimit: sessionConfig.historyLimit,
      }),
      history: cloneHistory(history),
      userMessage: input.userMessage,
    };

    let result: ConversationExecutionResult;
    if (onChunk && typeof orchestrator.executeStream === 'function') {
      result = await orchestrator.executeStream(requestInput, onChunk);
    } else {
      result = await orchestrator.execute(requestInput);
      if (result.ok && onChunk) {
        onChunk(result.response.content);
      }
    }

    if (result.ok) {
      history.push({
        role: 'user',
        content: input.userMessage,
      });
      history.push({
        role: 'assistant',
        content: result.response.content,
      });

      lastFeedback = result.response.feedback || null;

      // If feedback contains vocabulary and an onSaveVocabulary handler is present, auto-persist
      if (lastFeedback?.vocabulary && sessionConfig.onSaveVocabulary) {
        try {
          await sessionConfig.onSaveVocabulary(lastFeedback.vocabulary);
          savedVocabularyMap.set(
            lastFeedback.vocabulary.headword.toLowerCase(),
            lastFeedback.vocabulary
          );
        } catch {
          // Non-blocking auto-save failure: do not mark saved in memory if persistence failed
        }
      }

      return {
        ok: true,
        response: result.response,
        history: cloneHistory(history),
        feedback: lastFeedback,
      };
    }

    return {
      ok: false,
      error: result.error,
      history: cloneHistory(history),
      feedback: null,
    };
  }

  return {
    async send(
      input: ConversationSessionSendInput,
      onChunk?: AIStreamCallback
    ): Promise<ConversationSessionResult> {
      return executeTurn(input, onChunk);
    },

    async sendStream(
      input: ConversationSessionSendInput,
      onChunk: AIStreamCallback
    ): Promise<ConversationSessionResult> {
      return executeTurn(input, onChunk);
    },

    getHistory(): readonly ConversationTurn[] {
      return cloneHistory(history);
    },

    getLastFeedback(): ConversationFeedback | null {
      return lastFeedback;
    },

    async saveVocabularyItem(vocab: ConversationFeedbackVocabulary): Promise<boolean> {
      if (!vocab || !vocab.headword) return false;

      if (sessionConfig.onSaveVocabulary) {
        try {
          const result = await sessionConfig.onSaveVocabulary(vocab);
          if (result === false || result === null) {
            return false;
          }
          savedVocabularyMap.set(vocab.headword.toLowerCase(), {
            headword: vocab.headword,
            type: vocab.type,
            meaning: vocab.meaning,
            example: vocab.example,
          });
          return true;
        } catch {
          return false;
        }
      }

      savedVocabularyMap.set(vocab.headword.toLowerCase(), {
        headword: vocab.headword,
        type: vocab.type,
        meaning: vocab.meaning,
        example: vocab.example,
      });
      return true;
    },

    isVocabularySaved(headword: string): boolean {
      if (!headword) return false;
      return savedVocabularyMap.has(headword.toLowerCase());
    },

    getSavedVocabulary(): readonly ConversationFeedbackVocabulary[] {
      return Array.from(savedVocabularyMap.values());
    },

    clear(): void {
      history.length = 0;
      lastFeedback = null;
    },

    getConfig(): ConversationSessionConfig {
      return {
        mode: sessionConfig.mode,
        ...(sessionConfig.topic !== undefined && { topic: sessionConfig.topic }),
        ...(typeof sessionConfig.historyLimit === 'number' && {
          historyLimit: sessionConfig.historyLimit,
        }),
        ...(sessionConfig.onSaveVocabulary !== undefined && {
          onSaveVocabulary: sessionConfig.onSaveVocabulary,
        }),
      };
    },
  };
}
