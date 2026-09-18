/**
 * src/review/providers.ts
 *
 * Honest provider resolution for the Review surface.
 *
 * Review must never silently substitute an offline demo for the learner's own
 * speech or for a real evaluation. The rules mirror the EXISTING Talk
 * composition (the same architecture, not a second stack):
 *
 *   explicit Demo Mode      → offline demo AI + demo STT        ('demo')
 *   real mode + real key    → Gemini AI + Gemini STT            ('real')
 *   real mode + no key      → NO AI (the existing deterministic local
 *                             evaluators grade the item) and an STT provider
 *                             that fails honestly instead of inventing a
 *                             transcript                          ('unavailable')
 *
 * Nothing here produces learner evidence on its own; it only decides which
 * EXISTING providers a real attempt may run on.
 */

import type { AIProvider } from '../providers/ai/types';
import { createDemoAIProvider } from '../providers/ai/demo';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import type { SpeechToTextProvider } from '../providers/stt/types';
import { createGeminiSTTProvider } from '../providers/stt/gemini';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { createUnavailableSTTProvider, getGeminiApiKey } from '../talk-demo';

/**
 * What the voice state of a REAL (non-demo) review means: no speech
 * recognition is configured, so no spoken answer can be transcribed. The
 * learner is told exactly that instead of being handed a scripted transcript.
 */
export const REVIEW_VOICE_UNAVAILABLE_MESSAGE =
  'Voice answers are unavailable because speech recognition is not configured on this device. Type your answer instead.';

export type ReviewProviderKind = 'real' | 'demo' | 'unavailable';

export interface ReviewProviderOptions {
  /** Explicit, learner-visible Demo Mode. Demo providers are reachable ONLY here. */
  readonly isDemo: boolean;
  /** Override for the configured key (tests / embedding); defaults to the app key. */
  readonly apiKey?: string | null;
  /** Injected STT (tests / embedding). Never used to fake a real resolution. */
  readonly sttProvider?: SpeechToTextProvider;
  /** Injected AI (tests / embedding). */
  readonly aiProvider?: AIProvider;
}

export interface ReviewProviders {
  readonly kind: ReviewProviderKind;
  /**
   * Absent in real mode without a key: the EXISTING deterministic local
   * evaluators grade the item — no demo/scripted grading is ever injected.
   */
  readonly aiProvider?: AIProvider;
  readonly sttProvider: SpeechToTextProvider;
  /** Present only when voice answers are genuinely unavailable. */
  readonly voiceUnavailableMessage?: string;
}

/**
 * Resolves the providers a review attempt may run on.
 *
 * `resolveProviders` is pure apart from the default key lookup, so both the
 * service factory and the screen resolve the SAME providers.
 */
export function resolveReviewProviders(options: ReviewProviderOptions): ReviewProviders {
  if (options.isDemo) {
    // Explicit demo: clearly advertised by the surface, and the demo learner
    // identity keeps every result out of real learner evidence.
    return {
      kind: 'demo',
      aiProvider: options.aiProvider ?? createDemoAIProvider(),
      sttProvider: options.sttProvider ?? createDemoSTTProvider(),
    };
  }

  const key = (options.apiKey ?? getGeminiApiKey() ?? '').trim();
  const aiProvider =
    options.aiProvider ?? (key ? createGeminiAIProvider({ apiKey: key }) : undefined);

  if (options.sttProvider) {
    return {
      kind: 'real',
      ...(aiProvider ? { aiProvider } : {}),
      sttProvider: options.sttProvider,
    };
  }

  if (key) {
    return {
      kind: 'real',
      ...(aiProvider ? { aiProvider } : {}),
      sttProvider: createGeminiSTTProvider({ apiKey: key }),
    };
  }

  return {
    kind: 'unavailable',
    ...(aiProvider ? { aiProvider } : {}),
    sttProvider: createUnavailableSTTProvider(REVIEW_VOICE_UNAVAILABLE_MESSAGE),
    voiceUnavailableMessage: REVIEW_VOICE_UNAVAILABLE_MESSAGE,
  };
}

/**
 * The AI provider a ReviewService may grade with, or `undefined` when only the
 * existing deterministic local evaluators are genuinely supported.
 */
export function resolveReviewAIProvider(options: ReviewProviderOptions): AIProvider | undefined {
  return resolveReviewProviders(options).aiProvider;
}
