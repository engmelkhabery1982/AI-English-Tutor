/**
 * src/providers/ai/gemini/types.ts
 *
 * Types and configuration interfaces for the Gemini AI Provider.
 */

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
export const GEMINI_PROVIDER_ID = 'gemini';
export const DEFAULT_GEMINI_TIMEOUT_MS = 20000;

export interface GeminiAIProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpointBaseUrl?: string;
  readonly timeoutMs?: number;
}
