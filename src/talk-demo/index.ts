/**
 * src/talk-demo/index.ts
 *
 * Composition factory wiring the text chat demo stack:
 * DemoLearnerModel -> ConversationEngine -> DemoAIProvider -> ConversationOrchestrator -> ConversationSession
 */

import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import {
  createConversationSession,
  type ConversationMode,
  type ConversationSession,
  type ConversationSessionConfig,
  type ConversationSessionResult,
  type ConversationTurn,
} from '../conversation-session';
import { createDemoAIProvider } from '../providers/ai/demo';
import { createDemoLearnerModel } from './demo-learner-model';

export { createDemoLearnerModel } from './demo-learner-model';
export type {
  ConversationMode,
  ConversationSession,
  ConversationSessionConfig,
  ConversationSessionResult,
  ConversationTurn,
};

/**
 * Creates an end-to-end runnable in-memory ConversationSession using the demo stack.
 */
export function createTalkDemoSession(
  config: ConversationSessionConfig
): ConversationSession {
  const learnerModel = createDemoLearnerModel();
  const engine = createConversationEngine(learnerModel);
  const provider = createDemoAIProvider();
  const orchestrator = createConversationOrchestrator(engine, provider);
  return createConversationSession(orchestrator, config);
}
