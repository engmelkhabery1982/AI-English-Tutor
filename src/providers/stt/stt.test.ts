/**
 * src/providers/stt/stt.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDemoSTTProvider } from './demo';
import { createGeminiSTTProvider } from './gemini';

describe('SpeechToText Providers', () => {
  describe('DemoSTTProvider', () => {
    it('returns sequential deterministic transcripts for test recordings', async () => {
      const provider = createDemoSTTProvider({
        defaultTranscript: 'Hello, I am learning English.',
      });

      const res1 = await provider.transcribe({ uri: 'file:///test1.m4a', durationMs: 2000 });
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.transcript).toBe('Hello, I am learning English.');
      }

      provider.setMockTranscript('Can you help me practice?');
      const res2 = await provider.transcribe({ uri: 'file:///test2.m4a', durationMs: 1500 });
      expect(res2.ok).toBe(true);
      if (res2.ok) {
        expect(res2.transcript).toBe('Can you help me practice?');
      }
    });

    it('handles simulated error in demo STT', async () => {
      const provider = createDemoSTTProvider();
      provider.setMockFailure(true, 'Audio too short or silent');

      const res = await provider.transcribe({ uri: 'file:///short.m4a' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain('Audio too short or silent');
      }
    });
  });

  describe('GeminiSTTProvider', () => {
    const originalEnv = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

    beforeEach(() => {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.EXPO_PUBLIC_GEMINI_API_KEY = originalEnv;
      } else {
        delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
      }
      vi.restoreAllMocks();
    });

    it('throws error when API key is missing', () => {
      expect(() => {
        createGeminiSTTProvider({ apiKey: '' });
      }).toThrow('Gemini STT Provider requires a non-empty apiKey');
    });

    it('calls Gemini REST generateContent and parses transcription text', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'Good morning, how are you today?',
                  },
                ],
              },
            },
          ],
        }),
      });

      const provider = createGeminiSTTProvider({
        apiKey: 'test-gemini-key',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const res = await provider.transcribe({
        uri: 'file:///audio.m4a',
        base64: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
        mimeType: 'audio/mp4',
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.transcript).toBe('Good morning, how are you today?');
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [requestUrl, requestOptions] = mockFetch.mock.calls[0] as [string, RequestInit];

      // Blocker 3 assertions: URL does not contain API key; x-goog-api-key header contains key
      expect(requestUrl).not.toContain('key=');
      expect(requestUrl).not.toContain('test-gemini-key');
      expect(requestUrl).toContain(':generateContent');
      expect((requestOptions.headers as Record<string, string>)['x-goog-api-key']).toBe(
        'test-gemini-key'
      );
      expect((requestOptions.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json'
      );
    });

    it('redacts API key from returned error messages when HTTP response leaks key', async () => {
      const secretKey = 'super-secret-gemini-key-12345';
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () =>
          `The provided key=${secretKey} is invalid or expired for project-999.`,
      });

      const provider = createGeminiSTTProvider({
        apiKey: secretKey,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const res = await provider.transcribe({
        uri: 'file:///audio.m4a',
        base64: 'invalid',
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).not.toContain(secretKey);
        expect(res.error).toContain('[REDACTED]');
        expect(res.error).toContain('Gemini STT request failed with status 403');
      }
    });

    it('redacts API key when fetch throws network error containing the key', async () => {
      const secretKey = 'sensitive-api-key-value-abcde';
      const mockFetch = vi.fn().mockRejectedValue(
        new Error(`Connection refused to https://generativelanguage.googleapis.com with key ${secretKey}`)
      );

      const provider = createGeminiSTTProvider({
        apiKey: secretKey,
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const res = await provider.transcribe({
        uri: 'file:///audio.m4a',
        base64: 'audio-bytes',
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).not.toContain(secretKey);
        expect(res.error).toContain('[REDACTED]');
      }
    });

    it('handles non-200 HTTP response gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid audio payload',
      });

      const provider = createGeminiSTTProvider({
        apiKey: 'test-gemini-key',
        fetchImpl: mockFetch as unknown as typeof fetch,
      });

      const res = await provider.transcribe({
        uri: 'file:///audio.m4a',
        base64: 'invalid',
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain('Gemini STT request failed with status 400');
      }
    });
  });
});
