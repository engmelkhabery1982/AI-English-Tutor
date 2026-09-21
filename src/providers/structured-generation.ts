/** Shared, read-only generation boundary. No persistence, demo fallback or raw errors. */
import type { AIProvider } from './ai/types';
import type { ConversationRequest } from '../conversation-engine';
import { classifyProviderFailure, type ProviderFailure } from './failures';
import { runWithSafeRetry } from '../shared/safe-retry';

export type GenerationResult<T> =
  | { readonly ok: true; readonly value: T; readonly providerId: string }
  | { readonly ok: false; readonly failure: ProviderFailure };

export async function generateStructured<T>(
  provider: AIProvider | undefined,
  request: ConversationRequest,
  parse: (value: unknown) => T,
  stale: () => boolean = () => false,
): Promise<GenerationResult<T>> {
  const outcome = await runWithSafeRetry<GenerationResult<T>>({
    committed: stale,
    // INTERNAL dev/debug: attribute the (at most one) automatic retry.
    ...(request.diagnosticsType ? { diagnosticsType: request.diagnosticsType } : {}),
    run: async () => {
      if (stale()) return { ok: false, failure: classifyProviderFailure({ code: 'cancelled', message: 'Request was replaced.' }) };
      if (!provider) return { ok: false, failure: classifyProviderFailure({ code: 'not_configured', message: 'Configure the AI provider in Settings. Your input is kept.', retryable: false }) };
      try {
        const result = await provider.generate(request);
        if (stale()) return { ok: false, failure: classifyProviderFailure({ code: 'cancelled', message: 'Request was replaced.' }) };
        if (!result.ok) {
          const failure = classifyProviderFailure(result.error);
          return { ok: false, failure: failure.kind === 'unknown' ? classifyProviderFailure({ code: 'unknown', retryable: result.error.retryable }) : failure };
        }
        try {
          const text = result.response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
          return { ok: true, value: parse(JSON.parse(text)), providerId: provider.id };
        } catch {
          return { ok: false, failure: classifyProviderFailure({ code: 'malformed_response' }) };
        }
      } catch (error) {
        const classified = classifyProviderFailure(error instanceof Error ? error.message : 'Provider request failed.');
        // Unknown provider wording is not trusted just because it is short.
        return { ok: false, failure: classified.kind === 'unknown' ? classifyProviderFailure({ code: 'unknown' }) : classified };
      }
    },
    failureOf: result => result.ok ? null : { code: result.failure.kind, retryable: result.failure.retryable },
  });
  return outcome.result;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid text');
  return value.trim();
}
export function array(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error('Invalid array');
  return value;
}
