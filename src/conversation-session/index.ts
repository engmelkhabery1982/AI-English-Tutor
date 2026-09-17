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

/**
 * Honest message returned when a tutor opening is discarded because the
 * conversation started (or was cleared) while the opening request was in flight.
 * Nothing was added to the conversation.
 */
export const CONVERSATION_OPENING_DISCARDED_MESSAGE =
  'The learner started the conversation before the tutor opening arrived, so the opening was discarded.';

/**
 * Returned when a turn or opening tries to commit into a session that was
 * already replaced/closed: nothing is written to history or feedback.
 */
export const CONVERSATION_ABANDONED_MESSAGE =
  'This conversation was replaced before the turn finished, so the turn was discarded.';

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
  /**
   * Conversation generation. Bumped by every committed turn and by clear().
   * An async opening captures it before the AI request and commits ONLY when it
   * is still unchanged — so a learner turn (or a reset) that arrives while the
   * opening is in flight always wins and the stale opening is discarded.
   */
  let historyVersion = 0;
  /** True once the session was replaced/closed (late work must be discarded). */
  let abandoned = false;

  /** Discriminated refusal used for every abandoned-session case. */
  function abandonedResult(): ConversationSessionResult {
    return {
      ok: false,
      error: {
        code: 'cancelled',
        message: CONVERSATION_ABANDONED_MESSAGE,
        retryable: false,
      },
      history: cloneHistory(history),
      feedback: null,
    };
  }

  async function executeTurn(
    input: ConversationSessionSendInput,
    onChunk?: AIStreamCallback
  ): Promise<ConversationSessionResult> {
    if (abandoned) return abandonedResult();

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

    if (abandoned) {
      // The session was replaced while the AI was answering: never commit.
      return abandonedResult();
    }

    if (result.ok) {
      historyVersion += 1;
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

  /**
   * Produces the tutor's opening turn through the SAME engine/orchestrator path
   * as a normal turn, but commits only the tutor's reply.
   *
   * The instruction handed to the engine is not learner speech, so it is never
   * appended to the conversation history, never persisted as a learner turn and
   * never attributed to the learner. If the AI call fails, history stays empty
   * and the caller must surface the failure honestly instead of inventing an
   * opening.
   */
  async function executeOpening(
    input: ConversationSessionSendInput,
    onChunk?: AIStreamCallback
  ): Promise<ConversationSessionResult> {
    if (abandoned) return abandonedResult();

    if (history.length > 0) {
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'A conversation is already in progress.',
          retryable: false,
        },
        history: cloneHistory(history),
      };
    }

    // Capture the pristine state this opening started from.
    const startedVersion = historyVersion;

    const requestInput: ConversationRequestInput = {
      mode: sessionConfig.mode,
      ...(typeof sessionConfig.topic === 'string' && { topic: sessionConfig.topic }),
      ...(typeof sessionConfig.historyLimit === 'number' && {
        historyLimit: sessionConfig.historyLimit,
      }),
      history: [],
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

    if (!result.ok) {
      // No fabricated assistant history: the learner sees an honest error.
      return {
        ok: false,
        error: result.error,
        history: cloneHistory(history),
        feedback: null,
      };
    }

    if (abandoned) {
      // The session was replaced while the opening was in flight.
      return abandonedResult();
    }

    // Commit ONLY if this session is still in the pristine state the opening
    // started from. A learner turn (or a clear) that landed while the opening
    // was in flight always wins: the opening is discarded, never appended to an
    // already-started conversation and never allowed to touch feedback/history.
    if (historyVersion !== startedVersion || history.length > 0) {
      return {
        ok: false,
        error: {
          code: 'cancelled',
          message: CONVERSATION_OPENING_DISCARDED_MESSAGE,
          retryable: true,
        },
        history: cloneHistory(history),
        feedback: null,
      };
    }

    historyVersion += 1;
    history.push({ role: 'assistant', content: result.response.content });

    return {
      ok: true,
      response: result.response,
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

    async openConversation(
      input: ConversationSessionSendInput,
      onChunk?: AIStreamCallback
    ): Promise<ConversationSessionResult> {
      return executeOpening(input, onChunk);
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
      historyVersion += 1;
      history.length = 0;
      lastFeedback = null;
    },

    abandon(): void {
      if (abandoned) return;
      abandoned = true;
      // Invalidate every in-flight turn/opening of this session.
      historyVersion += 1;
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
