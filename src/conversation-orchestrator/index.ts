/**
 * src/conversation-orchestrator/index.ts
 *
 * Provider-neutral Conversation Orchestrator connecting ConversationEngine to AIProvider.
 */

import type {
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
import type {
  ConversationExecutionResult,
  ConversationOrchestrator,
} from './types';

export type {
  ConversationExecutionResult,
  ConversationOrchestrator,
  ConversationEngine,
  ConversationRequest,
  ConversationRequestInput,
  AIProvider,
  AIProviderError,
  AIProviderResponse,
};

/**
 * Creates a stateless ConversationOrchestrator that builds requests via ConversationEngine
 * and executes them via the supplied AIProvider.
 */
export function createConversationOrchestrator(
  conversationEngine: ConversationEngine,
  aiProvider: AIProvider
): ConversationOrchestrator {
  if (!conversationEngine || typeof conversationEngine.buildRequest !== 'function') {
    throw new Error('ConversationEngine with buildRequest method is required.');
  }

  if (!aiProvider || typeof aiProvider.generate !== 'function') {
    throw new Error('AIProvider with generate method is required.');
  }

  return {
    async execute(input: ConversationRequestInput): Promise<ConversationExecutionResult> {
      const request: ConversationRequest = conversationEngine.buildRequest(input);
      const providerResult: AIProviderResult = await aiProvider.generate(request);

      if (providerResult.ok) {
        return {
          ok: true,
          request,
          response: providerResult.response,
        };
      }

      return {
        ok: false,
        request,
        error: providerResult.error,
      };
    },
  };
}
