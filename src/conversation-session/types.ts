/**
 * src/conversation-session/types.ts
 *
 * Types for the in-memory Conversation Session foundation.
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
};

/**
 * Configuration options for initializing a ConversationSession.
 */
export interface ConversationSessionConfig {
  readonly mode: ConversationMode;
  readonly topic?: string | null;
  readonly historyLimit?: number;
  readonly onSaveVocabulary?: (
    vocab: ConversationFeedbackVocabulary
  ) => Promise<unknown> | unknown;
}

/**
 * Input for sending a user message into the session.
 */
export interface ConversationSessionSendInput {
  readonly userMessage: string;
}

/**
 * Result of sending a message in a ConversationSession.
 * Discriminated union returning the AIProviderResponse or AIProviderError
 * along with a defensive snapshot of current accumulated history.
 */
export type ConversationSessionResult =
  | {
      readonly ok: true;
      readonly response: AIProviderResponse;
      readonly history: readonly ConversationTurn[];
      readonly feedback?: ConversationFeedback | null;
    }
  | {
      readonly ok: false;
      readonly error: AIProviderError;
      readonly history: readonly ConversationTurn[];
      readonly feedback?: null;
    };

/**
 * In-memory Conversation Session managing multi-turn conversation state and session feedback.
 */
export interface ConversationSession {
  send(
    input: ConversationSessionSendInput,
    onChunk?: AIStreamCallback
  ): Promise<ConversationSessionResult>;

  sendStream?(
    input: ConversationSessionSendInput,
    onChunk: AIStreamCallback
  ): Promise<ConversationSessionResult>;

  getHistory(): readonly ConversationTurn[];

  getLastFeedback(): ConversationFeedback | null;

  saveVocabularyItem(vocab: ConversationFeedbackVocabulary): Promise<boolean>;

  isVocabularySaved(headword: string): boolean;

  getSavedVocabulary(): readonly ConversationFeedbackVocabulary[];

  clear(): void;

  getConfig(): ConversationSessionConfig;
}
