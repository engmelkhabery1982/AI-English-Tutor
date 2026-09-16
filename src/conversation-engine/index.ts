/**
 * src/conversation-engine/index.ts
 *
 * Deterministic, provider-neutral Conversation Engine foundation.
 */

import type { CoachingContext, LearnerModel } from '../learner-model';
import type {
  ConversationEngine,
  ConversationEngineMode,
  ConversationRequest,
  ConversationRequestInput,
  ConversationRole,
  ConversationTurn,
} from './types';
import { buildSystemPrompt } from './prompt';

export type {
  ConversationEngine,
  ConversationEngineMode,
  ConversationRequest,
  ConversationRequestInput,
  ConversationRole,
  ConversationTurn,
};

export type { ConversationMode } from '../domain/shared/types';
export type { CoachingContext, LearnerModel } from '../learner-model';
export { buildSystemPrompt } from './prompt';

/**
 * Default number of recent history turns included in the conversation request.
 * Chosen as 10 turns (5 full user-assistant dialogue cycles) to preserve context
 * within compact mobile memory and token constraints.
 */
export const DEFAULT_HISTORY_LIMIT = 10;

/**
 * Validates and resolves the history limit.
 * Must be a positive integer; invalid, non-positive, NaN, infinite, or fractional limits
 * safely resolve to DEFAULT_HISTORY_LIMIT without throwing.
 */
function resolveHistoryLimit(limit?: number): number {
  if (
    typeof limit === 'number' &&
    Number.isInteger(limit) &&
    limit > 0 &&
    Number.isFinite(limit)
  ) {
    return limit;
  }
  return DEFAULT_HISTORY_LIMIT;
}

/**
 * Creates a defensive deep clone of a CoachingContext without using JSON serialization.
 */
function cloneCoachingContext(context: CoachingContext): CoachingContext {
  return {
    profile: {
      learnerId: context.profile.learnerId,
      displayName: context.profile.displayName,
      currentLevel: context.profile.currentLevel,
      targetLevel: context.profile.targetLevel,
      learningGoals: [...context.profile.learningGoals],
      preferredModes: [...context.profile.preferredModes],
    },
    activeWeaknesses: context.activeWeaknesses.map((w) => ({
      id: w.id,
      type: w.type,
      referenceId: w.referenceId,
      status: w.status,
      severity: w.severity,
      occurrenceCount: w.occurrenceCount,
      contexts: [...w.contexts],
    })),
    strengths: context.strengths.map((s) => ({
      id: s.id,
      type: s.type,
      referenceId: s.referenceId,
      confidence: s.confidence,
      contexts: [...s.contexts],
    })),
    vocabularyFocus: context.vocabularyFocus.map((v) => ({
      itemId: v.itemId,
      headword: v.headword,
      type: v.type,
      meaningDefinition: v.meaningDefinition,
      reviewState: v.reviewState,
      nextReviewAt: v.nextReviewAt,
    })),
    expressionFocus: context.expressionFocus.map((e) => ({
      itemId: e.itemId,
      expression: e.expression,
      type: e.type,
      meaningDefinition: e.meaningDefinition,
      reviewState: e.reviewState,
      nextReviewAt: e.nextReviewAt,
    })),
    recentProgress: context.recentProgress ? { ...context.recentProgress } : null,
    dueReviewCount: context.dueReviewCount,
    generatedAt: context.generatedAt,
  };
}

/**
 * Creates a defensive copy of a single conversation turn.
 */
function cloneTurn(turn: ConversationTurn): ConversationTurn {
  return {
    role: turn.role,
    content: turn.content,
  };
}

/**
 * Concrete ConversationEngine implementation.
 */
class DefaultConversationEngine implements ConversationEngine {
  constructor(private readonly learnerModel: LearnerModel) {}

  buildRequest(input: ConversationRequestInput): ConversationRequest {
    // 1. Validate user message
    if (!input.userMessage || input.userMessage.trim().length === 0) {
      throw new Error('User message cannot be empty or whitespace only.');
    }

    // 2. Normalize optional topic (whitespace-only treated as null)
    const topic =
      typeof input.topic === 'string' && input.topic.trim().length > 0
        ? input.topic.trim()
        : null;

    // 3. Resolve history limit and slice recent turns
    const effectiveLimit = resolveHistoryLimit(input.historyLimit);
    const rawHistory = input.history ?? [];
    const slicedHistory =
      rawHistory.length > effectiveLimit
        ? rawHistory.slice(-effectiveLimit)
        : rawHistory;

    // 4. Build messages array: safe copy of history turns followed by current user message
    const messages: ConversationTurn[] = [
      ...slicedHistory.map(cloneTurn),
      { role: 'user', content: input.userMessage },
    ];

    // 5. Query learner model coaching context exactly once
    const rawCoachingContext = this.learnerModel.getCoachingContext();
    const coachingContext = cloneCoachingContext(rawCoachingContext);

    // 6. Build deterministic system prompt
    const systemPrompt = buildSystemPrompt(coachingContext, input.mode, topic);

    return {
      systemPrompt,
      messages,
      mode: input.mode,
      topic,
      coachingContext,
    };
  }
}

/**
 * Factory for creating a ConversationEngine backed by a LearnerModel.
 */
export function createConversationEngine(learnerModel: LearnerModel): ConversationEngine {
  return new DefaultConversationEngine(learnerModel);
}
