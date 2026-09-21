/**
 * src/providers/stt/gemini.ts
 *
 * Real Gemini audio transcription provider via direct REST fetch.
 * Sends recorded audio to Gemini generateContent with verbatim transcription instructions.
 */

import { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_TIMEOUT_MS } from '../ai/gemini/types';
import type { SpeechToTextProvider, STTAudioInput, STTResult } from './types';
import { classifyProviderFailure } from '../failures';
import {
  beginRequestDiagnostics,
  finishRequestDiagnostics,
  type RequestDiagnosticsOutcome,
} from '../request-diagnostics';

/** Maps an STT result onto the INTERNAL diagnostics outcome. */
function sttResultOutcome(result: STTResult): RequestDiagnosticsOutcome {
  if (result.ok) return { ok: true };
  const failure = classifyProviderFailure(result.error ?? 'Transcription failed.');
  return {
    ok: false,
    failureKind: failure.kind,
    rateLimited: failure.kind === 'rate_limited',
  };
}

export interface GeminiSTTProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpointBaseUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * Sanitizes an error message ensuring the API key is never leaked.
 */
function sanitizeErrorMessage(message: string, apiKey?: string): string {
  if (!message) return 'Unknown error occurred';
  let sanitized = message;
  if (apiKey && apiKey.trim().length > 0) {
    sanitized = sanitized.split(apiKey.trim()).join('[REDACTED]');
  }
  return sanitized;
}

/**
 * Normalizes and cleans the raw model transcription output.
 */
function cleanTranscript(raw: string): string {
  let text = raw.trim();
  // Strip enclosing quotes if model returned "..."
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1).trim();
  } else if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * Resolves base64 audio from STTAudioInput.
 */
async function resolveAudioBase64(input: STTAudioInput): Promise<string | null> {
  if (input.base64 && input.base64.trim().length > 0) {
    return input.base64.trim();
  }

  if (input.uri && input.uri.trim().length > 0) {
    const uri = input.uri.trim();
    if (uri.startsWith('data:') && uri.includes('base64,')) {
      return uri.split('base64,')[1].trim();
    }

    // Try expo-file-system legacy readAsStringAsync
    try {
      const FileSystem = await import('expo-file-system/legacy');
      if (FileSystem && typeof FileSystem.readAsStringAsync === 'function') {
        const data = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        if (data && data.trim().length > 0) {
          return data.trim();
        }
      }
    } catch {
      // Fallback to fetch blob
    }

    try {
      const response = await fetch(uri);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      if (typeof btoa === 'function') {
        return btoa(binary);
      }
      const maybeBuffer = (globalThis as Record<string, unknown>).Buffer as
        | { from: (b: ArrayBuffer) => { toString: (enc: string) => string } }
        | undefined;
      if (maybeBuffer && typeof maybeBuffer.from === 'function') {
        return maybeBuffer.from(buffer).toString('base64');
      }
    } catch {
      // Return null below
    }
  }

  return null;
}

export class GeminiSTTProvider implements SpeechToTextProvider {
  readonly id = 'gemini-stt';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpointBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: GeminiSTTProviderConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new Error('Gemini STT Provider requires a non-empty apiKey.');
    }
    this.apiKey = config.apiKey.trim();
    this.model = config.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.fetchImpl = config.fetchImpl || globalThis.fetch;
    this.endpointBaseUrl =
      config.endpointBaseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    this.timeoutMs =
      typeof config.timeoutMs === 'number' && config.timeoutMs > 0
        ? config.timeoutMs
        : DEFAULT_GEMINI_TIMEOUT_MS;
  }

  async transcribe(input: STTAudioInput): Promise<STTResult> {
    if (!input || (!input.base64 && !input.uri)) {
      return {
        ok: false,
        error: 'No audio data was provided for transcription.',
      };
    }

    const base64Audio = await resolveAudioBase64(input);
    if (!base64Audio || base64Audio.length === 0) {
      return {
        ok: false,
        error: 'Audio content could not be read or is empty.',
      };
    }

    // INTERNAL dev/debug counters — counted only for the real provider
    // request (local audio validation failures are not provider requests).
    const diagnostics = beginRequestDiagnostics({
      type: 'stt',
      providerId: this.id,
      model: this.model,
    });
    const result = await this.performTranscribe(base64Audio, input.mimeType || 'audio/m4a');
    finishRequestDiagnostics(diagnostics, sttResultOutcome(result));
    return result;
  }

  /** The actual network transcription. Never throws; maps errors to results. */
  private async performTranscribe(base64Audio: string, mimeType: string): Promise<STTResult> {
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Audio,
              },
            },
            {
              text:
                'Transcribe the speech in this audio clip verbatim into plain English text. ' +
                'Output ONLY the exact transcribed text. ' +
                'Do not add explanations, conversational responses, notes, markdown formatting, or quotes.',
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.0,
      },
    };

    const url = `${this.endpointBaseUrl}/models/${encodeURIComponent(
      this.model
    )}:generateContent`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {
          errorBody = response.statusText || 'Request failed';
        }

        const sanitized = sanitizeErrorMessage(errorBody, this.apiKey);
        return {
          ok: false,
          error: `Gemini STT request failed with status ${response.status}: ${sanitized}`,
        };
      }

      const responseJson = (await response.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
          finishReason?: string;
        }>;
      };

      const candidate = responseJson.candidates?.[0];
      const rawTranscript = candidate?.content?.parts?.[0]?.text;

      if (!rawTranscript || rawTranscript.trim().length === 0) {
        return {
          ok: false,
          error: 'No speech could be recognized. Please try speaking again.',
        };
      }

      const cleaned = cleanTranscript(rawTranscript);
      if (cleaned.length === 0) {
        return {
          ok: false,
          error: 'No speech could be recognized. Please try speaking again.',
        };
      }

      return {
        ok: true,
        transcript: cleaned,
      };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          ok: false,
          error: `Transcription request timed out after ${this.timeoutMs / 1000} seconds.`,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: sanitizeErrorMessage(message, this.apiKey),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export function createGeminiSTTProvider(
  config: GeminiSTTProviderConfig
): SpeechToTextProvider {
  return new GeminiSTTProvider(config);
}
