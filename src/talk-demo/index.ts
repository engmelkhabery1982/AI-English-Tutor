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
import type { AIProvider } from '../providers/ai';
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
 * Internal helper to compose the session stack around a given AIProvider.
 */
function composeSessionWithProvider(
  config: ConversationSessionConfig,
  provider: AIProvider
): ConversationSession {
  const learnerModel = createDemoLearnerModel();
  const engine = createConversationEngine(learnerModel);
  const orchestrator = createConversationOrchestrator(engine, provider);
  return createConversationSession(orchestrator, config);
}

/**
 * Creates an end-to-end runnable ConversationSession bundle.
 * Uses Gemini AI Provider when an API key is available, falling back to Demo AI Provider.
 */
export function createTalkSession(
  config: ConversationSessionConfig,
  options?: { readonly apiKey?: string; readonly fetchImpl?: typeof fetch }
): TalkSessionBundle {
  const key = options?.apiKey?.trim() || getGeminiApiKey();

  if (key) {
    const provider = createGeminiAIProvider({
      apiKey: key,
      fetchImpl: options?.fetchImpl,
    });
    return {
      session: composeSessionWithProvider(config, provider),
      providerKind: 'gemini',
    };
  }

  const provider = createDemoAIProvider();
  return {
    session: composeSessionWithProvider(config, provider),
    providerKind: 'demo',
  };
}

/**
 * Creates a ConversationSession that ALWAYS uses the local DemoAIProvider,
 * completely independent of any environment variables, API keys, or network availability.
 */
export function createTalkDemoSession(
  config: ConversationSessionConfig
): ConversationSession {
  const provider = createDemoAIProvider();
  return composeSessionWithProvider(config, provider);
}
