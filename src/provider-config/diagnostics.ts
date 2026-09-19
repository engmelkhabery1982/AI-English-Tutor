/**
 * src/provider-config/diagnostics.ts
 *
 * Provider diagnostics for the runtime credential.
 *
 * PRINCIPLES:
 * - Validity is only ever claimed after a REAL provider round-trip. Nothing
 *   here inspects the key's shape and guesses.
 * - Failures are classified as far as the provider response genuinely permits:
 *   no key / rejected credential / network unavailable / service error /
 *   timeout. When the evidence does not distinguish two causes, the result
 *   does not pretend to.
 * - Diagnostics are read-only with respect to the learner: this module never
 *   touches repositories and produces no weakness or evidence of any kind. A
 *   provider/network failure is not learner failure.
 * - The credential never appears in a result, message or log. The EXISTING
 *   provider redacts it; this layer adds a defensive redaction on top.
 */

import type { ConversationRequest } from '../conversation-engine';
import type { CoachingContext } from '../learner-model';
import type { AIProvider } from '../providers/ai/types';
import { createGeminiAIProvider } from '../providers/ai/gemini';
import { getProviderCredentialService } from './credentials';
import type { ProviderCredentialService } from './credentials';
import type { ProviderDiagnosticCode, ProviderDiagnosticResult } from './types';

/** The smallest honest prompt that proves the credential works. */
const VERIFICATION_PROMPT = 'Reply with the single word: ok';

/**
 * A learner-free request used ONLY to prove the credential works.
 *
 * It carries no learner evidence, no weaknesses and no personalization: a
 * connectivity check must never look like a tutoring turn.
 */
function buildVerificationRequest(): ConversationRequest {
  const coachingContext: CoachingContext = {
    profile: {
      learnerId: '00000000-0000-4000-8000-000000000000',
      displayName: 'Connectivity check',
      currentLevel: 'A1',
      targetLevel: 'A1',
      learningGoals: [],
      preferredModes: ['natural'],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: new Date().toISOString(),
  };

  return {
    systemPrompt:
      'You are a connectivity check. Answer with the single word: ok. Do not ask questions.',
    messages: [{ role: 'user', content: VERIFICATION_PROMPT }],
    mode: 'natural',
    topic: null,
    coachingContext,
  };
}

export interface ProviderDiagnosticsOptions {
  /**
   * Builds the provider under test from a real key and the observing fetch.
   * Defaults to the EXISTING Gemini provider.
   */
  readonly createProvider?: (apiKey: string, fetchImpl: typeof fetch) => AIProvider;
  /** Injectable transport (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Credential source. Defaults to the canonical service. */
  readonly credentialService?: ProviderCredentialService;
}

export interface ProviderDiagnostics {
  /**
   * Runs a real verification attempt.
   *
   * @param candidateKey verifies an as-yet-unsaved key (the Settings field);
   *   when omitted the configured credential is verified.
   */
  verifyConnection(candidateKey?: string | null): Promise<ProviderDiagnosticResult>;
}

function redact(message: string, key: string): string {
  if (!message) return 'The provider reported an unknown error.';
  const trimmedKey = key.trim();
  if (trimmedKey.length === 0) return message;
  return message.split(trimmedKey).join('[REDACTED]');
}

function normalize(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True when an error message is the EXISTING provider's HTTP-status failure
 * form (i.e. the service was definitely reached and answered with an error).
 */
function isHttpServiceFailure(message: string): boolean {
  return /HTTP status\s+[45]\d\d/i.test(message);
}

/**
 * Creates the provider diagnostics used by the Settings surface.
 */
export function createProviderDiagnostics(
  options: ProviderDiagnosticsOptions = {}
): ProviderDiagnostics {
  const credentialService = options.credentialService ?? getProviderCredentialService();
  const usingDefaultFactory = options.createProvider === undefined;
  const createProvider =
    options.createProvider ??
    ((apiKey: string, fetchImpl: typeof fetch) =>
      createGeminiAIProvider({ apiKey, fetchImpl }));

  async function verifyConnection(
    candidateKey?: string | null
  ): Promise<ProviderDiagnosticResult> {
    const key = normalize(candidateKey) ?? credentialService.resolveKeySync();

    if (!key) {
      return {
        code: 'no_key',
        message:
          'No API key is configured, so there is nothing to verify. Add a key to enable the online provider.',
      };
    }

    const baseFetch: typeof fetch =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

    /**
     * Observes whether the request actually reached the service. This is what
     * lets the result distinguish "the network is unavailable" from "the
     * service answered with an error" without guessing from wording.
     */
    let reachedService = false;
    const observingFetch: typeof fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      reachedService = true;
      return response;
    };

    let provider: AIProvider;
    try {
      provider = createProvider(key, observingFetch);
    } catch (error: unknown) {
      return {
        code: 'invalid_credential',
        message: redact(
          error instanceof Error ? error.message : 'The provider rejected the key.',
          key
        ),
      };
    }

    const result = await provider.generate(buildVerificationRequest());

    if (result.ok) {
      return {
        code: 'ok',
        message: 'The provider accepted this key and answered a real request.',
      };
    }

    const errorCode = result.error.code;
    const message = redact(result.error.message, key);

    if (errorCode === 'authentication') {
      return {
        code: 'invalid_credential',
        message: `The provider rejected this key. ${message}`,
      };
    }

    if (errorCode === 'timeout') {
      return {
        code: 'timeout',
        message: `The provider did not answer in time. ${message}`,
      };
    }

    if (errorCode === 'unavailable') {
      // The default factory uses our observing fetch, so reachability is
      // measured. An injected factory may not, in which case the EXISTING
      // provider's HTTP-status error form is the honest evidence available.
      const serviceAnswered = usingDefaultFactory
        ? reachedService
        : isHttpServiceFailure(result.error.message);
      if (serviceAnswered) {
        return {
          code: 'service_error',
          message: `The provider was reached but could not complete the check. ${message}`,
        };
      }
      return {
        code: 'network_unavailable',
        message: `The provider could not be reached from this device. ${message}`,
      };
    }

    // rate_limit / invalid_request / unknown: the service answered, and the
    // failure is not about the credential's validity.
    return {
      code: 'service_error',
      message: `The provider was reached but could not complete the check. ${message}`,
    };
  }

  return { verifyConnection };
}

/** Human label for a diagnostic code (secret-free). */
export function diagnosticCodeLabel(code: ProviderDiagnosticCode): string {
  switch (code) {
    case 'ok':
      return 'Verified';
    case 'no_key':
      return 'Not configured';
    case 'invalid_credential':
      return 'Rejected by the provider';
    case 'network_unavailable':
      return 'Network unavailable';
    case 'service_error':
      return 'Provider error';
    case 'timeout':
      return 'Timed out';
    default:
      return 'Unknown';
  }
}
