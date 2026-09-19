/**
 * src/provider-config/diagnostics.test.ts
 *
 * Wave 2 — provider diagnostics.
 *
 *   9.  invalid-key diagnostic (only after a real attempt)
 *  10.  network-failure diagnostic (distinct from a rejected key)
 *  ...  service error, timeout, no-key (no request is attempted)
 *  11.  the credential never appears in a diagnostic result
 *  ...  diagnostics never touch learner evidence (structural)
 *  ...  deterministic: the same payload yields the same verdict
 */

import { describe, expect, it, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { createProviderDiagnostics, diagnosticCodeLabel } from './diagnostics';
import { createProviderCredentialService } from './credentials';
import { PROVIDER_SECRET_STORAGE_KEY, createInMemorySecureKeyStore } from './secure-store';
import type { ProviderDiagnosticResult } from './types';

const API_KEY = 'diagnostics-secret-key-XYZ789';

function credentialServiceWithKey(): ReturnType<typeof createProviderCredentialService> {
  return createProviderCredentialService({
    keyStore: createInMemorySecureKeyStore({ initial: { [PROVIDER_SECRET_STORAGE_KEY]: API_KEY } }),
    isDevelopment: false,
  });
}

function credentialServiceWithoutKey(): ReturnType<typeof createProviderCredentialService> {
  return createProviderCredentialService({
    keyStore: createInMemorySecureKeyStore(),
    isDevelopment: false,
  });
}

/** A successful Gemini-shaped response. */
function okResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    }),
    { status: 200 },
  );
}

/** An error response in the shape the provider parses. */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

describe('provider diagnostics', () => {
  it('reports "not configured" without making a request when there is no key', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithoutKey(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('no_key');
    // Nothing to verify ⇒ no evidence may be gathered, and no request is made.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('9. reports a rejected credential only after a real attempt', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(403, 'API key not valid. Please pass a valid API key.'));
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithKey(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('invalid_credential');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.message).toContain('rejected');
  });

  it('10. reports a network failure distinctly from a rejected key', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithKey(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('network_unavailable');
    // A network problem must never be reported as an invalid credential.
    expect(result.code).not.toBe('invalid_credential');
  });

  it('distinguishes a reachable provider that fails from an unreachable one', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(503, 'The service is temporarily unavailable.'));
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithKey(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('service_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout as a timeout, not as a bad key', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    });
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithKey(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('timeout');
  });

  it('reports success only when the provider really answered', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithKey(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('verifies an as-yet-unsaved candidate key without reading storage', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const service = credentialServiceWithoutKey();
    const diagnostics = createProviderDiagnostics({
      credentialService: service,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection('candidate-key-pending');
    expect(result.code).toBe('ok');
    // Verifying a draft must not silently store it.
    expect(service.resolveKeySync()).toBeNull();
    expect(service.snapshot().hasRuntimeCredential).toBe(false);
  });

  it('11. a diagnostic result never contains the credential', async () => {
    // A hostile provider error body that echoes the key back at us.
    const echoing = vi.fn(async () =>
      errorResponse(403, `API key not valid: ${API_KEY} rejected for project`)
    );
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithKey(),
      fetchImpl: echoing as unknown as typeof fetch,
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('invalid_credential');
    expect(result.message).not.toContain(API_KEY);
    expect(result.message).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('propagates a construction failure as a rejected credential without leaking the key', async () => {
    const diagnostics = createProviderDiagnostics({
      credentialService: credentialServiceWithKey(),
      createProvider: () => {
        throw new Error(`Provider refused key ${API_KEY}`);
      },
    });

    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('invalid_credential');
    expect(result.message).not.toContain(API_KEY);
  });

  it('is deterministic: the same payload always yields the same verdict', async () => {
    const run = async (): Promise<ProviderDiagnosticResult> => {
      const fetchImpl = vi.fn(async () => errorResponse(401, 'Unauthorized'));
      const diagnostics = createProviderDiagnostics({
        credentialService: credentialServiceWithKey(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      return diagnostics.verifyConnection();
    };

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
  });

  it('produces no learner evidence: the diagnostics module is storage-free', () => {
    // Structural proof that a provider/network failure cannot become learner
    // weakness: this module has no access to persistence at all.
    const source = readFileSync(join(__dirname, 'diagnostics.ts'), 'utf8');

    const importSpecifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of importSpecifiers) {
      expect(specifier).not.toContain('repositories');
      expect(specifier).not.toContain('data/local');
      expect(specifier).not.toContain('review/');
      expect(specifier).not.toContain('reassessment');
      expect(specifier).not.toContain('daily-tutor');
    }

    // No database handle, no repository class, no persistence call.
    expect(source).not.toContain('DatabaseAdapter');
    expect(source).not.toContain('SQLiteWeaknessRepository');
    expect(source).not.toContain('SuccessObservationRecorder');
    expect(source).not.toContain('openDatabaseSync');
  });

  it('labels every diagnostic code without exposing secrets', () => {
    const codes = [
      'ok',
      'no_key',
      'invalid_credential',
      'network_unavailable',
      'service_error',
      'timeout',
    ] as const;
    for (const code of codes) {
      const label = diagnosticCodeLabel(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain(API_KEY);
    }
  });
});
