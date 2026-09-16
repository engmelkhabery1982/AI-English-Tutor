/**
 * src/conversation-orchestrator/types.ts
 *
 * Types for the Conversation Orchestrator connecting ConversationEngine to AIProvider.
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
} from '../providers/ai';

export type {
  ConversationEngine,
  ConversationRequest,
  ConversationRequestInput,
  AIProvider,
  AIProviderError,
  AIProviderResponse,
};

/**
 * Result of orchestrating a conversation turn.
 * Discriminated union returning the exact ConversationRequest along with
 * either a successful AIProviderResponse or a provider AIProviderError.
 */
export type ConversationExecutionResult =
  | {
      readonly ok: true;
      readonly request: ConversationRequest;
      readonly response: AIProviderResponse;
    }
  | {
      readonly ok: false;
      readonly request: ConversationRequest;
      readonly error: AIProviderError;
    };

/**
 * Interface for orchestrating conversation requests through an AIProvider.
 */
export interface ConversationOrchestrator {
  execute(
    input: ConversationRequestInput
  ): Promise<ConversationExecutionResult>;
}
