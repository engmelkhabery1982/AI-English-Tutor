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
  };

  const history: ConversationTurn[] = [];

  return {
    async send(input: ConversationSessionSendInput): Promise<ConversationSessionResult> {
      const requestInput: ConversationRequestInput = {
        mode: sessionConfig.mode,
        ...(typeof sessionConfig.topic === 'string' && { topic: sessionConfig.topic }),
        ...(typeof sessionConfig.historyLimit === 'number' && {
          historyLimit: sessionConfig.historyLimit,
        }),
        history: cloneHistory(history),
        userMessage: input.userMessage,
      };

      const result = await orchestrator.execute(requestInput);

      if (result.ok) {
        history.push({
          role: 'user',
          content: input.userMessage,
        });
        history.push({
          role: 'assistant',
          content: result.response.content,
        });

        return {
          ok: true,
          response: result.response,
          history: cloneHistory(history),
        };
      }

      return {
        ok: false,
        error: result.error,
        history: cloneHistory(history),
      };
    },

    getHistory(): readonly ConversationTurn[] {
      return cloneHistory(history);
    },

    clear(): void {
      history.length = 0;
    },

    getConfig(): ConversationSessionConfig {
      return {
        mode: sessionConfig.mode,
        ...(sessionConfig.topic !== undefined && { topic: sessionConfig.topic }),
        ...(typeof sessionConfig.historyLimit === 'number' && {
          historyLimit: sessionConfig.historyLimit,
        }),
      };
    },
  };
}
