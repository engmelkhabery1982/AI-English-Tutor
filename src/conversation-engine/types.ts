/**
 * src/conversation-engine/types.ts
 *
 * Provider-neutral types and interfaces for the Conversation Engine.
 */

import type { ConversationMode } from '../domain/shared/types';
import type { CoachingContext, LearnerModel } from '../learner-model';
import type { RequestDiagnosticsType } from '../providers/request-diagnostics';

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
  /**
   * Optional INTERNAL diagnostics label (dev/debug counters only — see
   * src/providers/request-diagnostics). Never affects the request itself;
   * providers that do not know it simply ignore it. Defaults to
   * 'tutor_text' at the provider boundary.
   */
  readonly diagnosticsType?: RequestDiagnosticsType;
}

export interface ConversationEngine {
  buildRequest(input: ConversationRequestInput): ConversationRequest;
}

export type { ConversationMode, CoachingContext, LearnerModel };
