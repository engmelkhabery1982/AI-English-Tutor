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

  /**
   * Tutor-led opening turn. Runs through the normal engine/orchestrator path but
   * commits only the tutor's reply: the instruction itself is never stored as a
   * learner turn. Optional so existing sessions/providers stay compatible.
   */
  openConversation?(
    input: ConversationSessionSendInput,
    onChunk?: AIStreamCallback
  ): Promise<ConversationSessionResult>;

  /**
   * Marks this session as replaced/closed. After that, no turn or opening may be
   * committed: late async results are discarded instead of mutating history or
   * feedback. Optional so existing sessions/providers stay compatible.
   */
  abandon?(): void;

  /**
   * True once this session was replaced/closed. A surface that still shows this
   * conversation must read it BEFORE starting a learner turn: sending into a
   * closed session can only produce a discarded turn, so the honest recovery is
   * to compose a fresh conversation instead of reporting a frightening error.
   * Optional so existing sessions/providers stay compatible.
   */
  isAbandoned?(): boolean;

  /**
   * Work Order 2 — learner-assistance request.
   *
   * Runs a hidden instruction (hint / example / explain / "I don't know" /
   * skip) through the SAME engine + orchestrator + provider path as a normal
   * turn, but commits ONLY the tutor's reply:
   * - the instruction is never stored as a learner turn;
   * - no learner evidence is created (turn counts, feedback, weakness and
   *   review persistence all stay untouched);
   * - if any learner turn committed while the request was in flight, the late
   *   assistance is DISCARDED instead of corrupting the conversation.
   * Returns the same result shape as `send` so surfaces handle it with the
   * same safe-retry rules. Optional so existing sessions stay compatible.
   */
  requestAssistance?(
    input: ConversationSessionSendInput,
    onChunk?: AIStreamCallback
  ): Promise<ConversationSessionResult>;

  /**
   * Work Order 2 — a SESSION-LOCAL temporary correction-mode override.
   *
   * Used for "fewer corrections for now": it changes ONLY the mode the
   * EXISTING engine uses to build the next request; it is never persisted,
   * never changes the composed conversation identity, and passing `null`
   * restores the session's real mode. When the session is replaced, the
   * override disappears with it — exactly what "for now" means.
   * Optional so existing sessions stay compatible.
   */
  setModeOverride?(mode: ConversationMode | null): void;

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
