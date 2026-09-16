/**
 * src/conversation-engine/types.ts
 *
 * Provider-neutral types and interfaces for the Conversation Engine.
 */

import type { ConversationMode } from '../domain/shared/types';
import type { CoachingContext, LearnerModel } from '../learner-model';

export type ConversationRole = 'user' | 'assistant';

export interface ConversationTurn {
  readonly role: ConversationRole;
  readonly content: string;
}

export type ConversationEngineMode = ConversationMode;

export interface ConversationRequestInput {
  readonly userMessage: string;
  readonly mode: ConversationMode;
  readonly topic?: string;
  readonly history?: readonly ConversationTurn[];
  readonly historyLimit?: number;
}

export interface ConversationRequest {
  readonly systemPrompt: string;
  readonly messages: readonly ConversationTurn[];
  readonly mode: ConversationMode;
  readonly topic: string | null;
  readonly coachingContext: CoachingContext;
}

export interface ConversationEngine {
  buildRequest(input: ConversationRequestInput): ConversationRequest;
}

export type { ConversationMode, CoachingContext, LearnerModel };
