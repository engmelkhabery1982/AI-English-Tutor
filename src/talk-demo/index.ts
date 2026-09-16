/**
 * src/talk-demo/index.ts
 *
 * Composition factory wiring the conversation stack:
 * DemoLearnerModel -> ConversationEngine -> (GeminiAIProvider | DemoAIProvider) -> ConversationOrchestrator -> ConversationSession
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
import { createGeminiAIProvider } from '../providers/ai/gemini';
import { createDemoLearnerModel } from './demo-learner-model';

export { createDemoLearnerModel } from './demo-learner-model';
export type {
  ConversationMode,
  ConversationSession,
  ConversationSessionConfig,
  ConversationSessionResult,
  ConversationTurn,
};

export type TalkProviderKind = 'gemini' | 'demo';

export interface TalkSessionBundle {
  readonly session: ConversationSession;
  readonly providerKind: TalkProviderKind;
}

/**
 * Resolves the active Gemini API key from environment or explicit parameter.
 */
export function getGeminiApiKey(): string | null {
  const envKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  if (typeof envKey === 'string' && envKey.trim().length > 0) {
    return envKey.trim();
  }
  return null;
}

/**
 * Creates an end-to-end runnable ConversationSession bundle.
 * Uses Gemini AI Provider when an API key is available, falling back to Demo AI Provider.
 */
export function createTalkSession(
  config: ConversationSessionConfig,
  options?: { readonly apiKey?: string; readonly fetchImpl?: typeof fetch }
): TalkSessionBundle {
  const learnerModel = createDemoLearnerModel();
  const engine = createConversationEngine(learnerModel);

  const key = options?.apiKey?.trim() || getGeminiApiKey();

  if (key) {
    const provider = createGeminiAIProvider({
      apiKey: key,
      fetchImpl: options?.fetchImpl,
    });
    const orchestrator = createConversationOrchestrator(engine, provider);
    const session = createConversationSession(orchestrator, config);
    return {
      session,
      providerKind: 'gemini',
    };
  }

  const provider = createDemoAIProvider();
  const orchestrator = createConversationOrchestrator(engine, provider);
  const session = createConversationSession(orchestrator, config);
  return {
    session,
    providerKind: 'demo',
  };
}

/**
 * Backwards-compatible factory creating a demo session.
 */
export function createTalkDemoSession(
  config: ConversationSessionConfig
): ConversationSession {
  return createTalkSession(config).session;
}
