/**
 * src/learner-agency/help-service.ts
 *
 * Work Order 2 — provider-backed learner help for surfaces WITHOUT a live
 * ConversationSession (shadowing meaning, listening explanation, standalone
 * practice prompts).
 *
 * This is NOT a second conversation engine: it composes the EXISTING
 * ConversationEngine + ConversationOrchestrator + the SAME explicit provider
 * rules as Talk (Gemini when configured, Demo only when explicitly requested,
 * an honest failure otherwise — never a scripted substitution). Nothing here
 * can write learner evidence: the service is stateless, holds no history, and
 * returns text only.
 *
 * Failure handling reuses Work Order 1's central classification
 * (`learnerMessageForFailure`): the learner sees one friendly, safe sentence,
 * raw provider text never reaches a UI, and a failed help request never
 * disturbs the surrounding practice flow.
 */

import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import type { ConversationTurn } from '../conversation-engine';
import type { LearnerModel } from '../learner-model';
import { createDemoLearnerModel } from '../talk-demo/demo-learner-model';
import { learnerMessageForFailure } from '../providers/failures';
import type { AIProvider } from '../providers/ai';
import { createDemoAIProvider } from '../providers/ai/demo';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import { resolveGeminiApiKey } from '../provider-config';
import type { CorrectionIntensity } from '../domain/shared/types';
import {
  CORRECTION_INTENSITY_TO_MODE,
  type HelpActionId,
} from './types';
import { HELP_ACTION_PROMPT_INSTRUCTIONS } from './types';

/** Shown when help is requested but no provider exists (never a fake reply). */
export const HELP_CONFIGURATION_REQUIRED_MESSAGE =
  'Help needs the AI tutor, which is not configured on this device. Add a key in Settings to use it — nothing scripted is invented in its place.';

export interface HelpServiceOptions {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  /** Explicit Demo Mode — mirrors Talk's rule: never chosen automatically. */
  readonly isDemo?: boolean;
  readonly learnerModel?: LearnerModel;
  readonly provider?: AIProvider;
}

export interface HelpRequestInput {
  readonly action: HelpActionId;
  readonly mode?: CorrectionIntensity;
  readonly topic?: string | null;
  readonly history?: readonly ConversationTurn[];
  /** Extra context (e.g. the shadowing chunk being explained). */
  readonly contextText?: string;
  readonly onChunk?: (chunk: string) => void;
  /** Staleness probe: when true, the LATE result must be dropped. */
  readonly checkStale?: () => boolean;
}

export interface HelpServiceResult {
  readonly ok: boolean;
  readonly text: string;
  /** One learner-safe sentence when not ok. Raw provider detail is never here. */
  readonly errorMessage: string | null;
  readonly retryable: boolean;
  readonly discardedStale: boolean;
}

export interface LearnerHelpService {
  readonly providerAvailable: boolean;
  requestHelp(input: HelpRequestInput): Promise<HelpServiceResult>;
}

/**
 * The 'explain' meaning request must never fabricate: if the provider fails,
 * the caller keeps its own stored explanation (or says it is unavailable).
 */
export function createLearnerHelpService(options?: HelpServiceOptions): LearnerHelpService {
  const configuredKey = options?.apiKey?.trim() || resolveGeminiApiKey();
  const explicitDemo = options?.isDemo === true;

  let provider: AIProvider | null = options?.provider ?? null;
  if (!provider) {
    if (explicitDemo) {
      provider = createDemoAIProvider();
    } else if (configuredKey) {
      provider = createGeminiAIProvider({
        apiKey: configuredKey,
        ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    }
  }

  const learnerModel = options?.learnerModel ?? createDemoLearnerModel();
  const engine = createConversationEngine(learnerModel);
  const orchestrator = provider ? createConversationOrchestrator(engine, provider) : null;

  return {
    providerAvailable: orchestrator !== null,

    async requestHelp(input: HelpRequestInput): Promise<HelpServiceResult> {
      if (!orchestrator) {
        return {
          ok: false,
          text: '',
          errorMessage: HELP_CONFIGURATION_REQUIRED_MESSAGE,
          retryable: false,
          discardedStale: false,
        };
      }

      const action = input.action;
      const instruction = HELP_ACTION_PROMPT_INSTRUCTIONS[action];
      const context = (input.contextText ?? '').trim();
      const topic = (input.topic ?? '').trim();
      const userMessage = [
        instruction,
        topic ? `Current topic: ${topic}.` : '',
        context ? `The language being asked about: "${context}"` : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n');

      try {
        const result = await orchestrator.execute({
          userMessage,
          mode: CORRECTION_INTENSITY_TO_MODE[input.mode ?? 'balanced'],
          ...(topic ? { topic } : {}),
          history: input.history ?? [],
          // Help is a short scaffold: keep it bounded, never a lecture.
          historyLimit: 8,
        });

        if (input.checkStale?.() === true) {
          // Stale by the owner's rules: the late help is dropped silently and
          // the owning surface keeps exactly what the learner already has.
          return { ok: false, text: '', errorMessage: null, retryable: false, discardedStale: true };
        }

        if (!result.ok) {
          const message = learnerMessageForFailure(result.error, 'practice');
          return {
            ok: false,
            text: '',
            errorMessage: message,
            retryable: result.error.retryable === true,
            discardedStale: false,
          };
        }

        const text = (result.response.content ?? '').trim();
        if (text.length === 0) {
          return {
            ok: false,
            text: '',
            errorMessage: 'The tutor could not help this time. Please try again.',
            retryable: true,
            discardedStale: false,
          };
        }
        return { ok: true, text, errorMessage: null, retryable: false, discardedStale: false };
      } catch (error: unknown) {
        if (input.checkStale?.() === true) {
          return { ok: false, text: '', errorMessage: null, retryable: false, discardedStale: true };
        }
        const message = learnerMessageForFailure(
          error instanceof Error ? { message: error.message } : null,
          'practice',
        );
        return { ok: false, text: '', errorMessage: message, retryable: true, discardedStale: false };
      }
    },
  };
}
