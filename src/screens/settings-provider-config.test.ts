/**
 * src/screens/settings-provider-config.test.ts
 *
 * Wave 2 — the Settings provider-configuration surface.
 *
 * This repository has no React Native test renderer (no react-test-renderer /
 * @testing-library/react-native), so these tests are split honestly:
 *
 *  A. CONTRACT (source-level): the screen is wired to the canonical provider
 *     configuration service, the key field is masked, the stored key is never
 *     rendered, and the pre-existing onboarding entry point survives.
 *  B. BEHAVIOUR: the exact service calls the screen's handlers make, exercised
 *     against the real canonical service (save / replace / remove / verify),
 *     including the failure paths that must be shown to the learner.
 */

import { describe, expect, it, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { createProviderCredentialService } from '../provider-config';
import { createProviderDiagnostics } from '../provider-config';
import { PROVIDER_SECRET_STORAGE_KEY, createInMemorySecureKeyStore } from '../provider-config';
import type { ProviderCredentialService } from '../provider-config';

const SETTINGS_SOURCE = readFileSync(join(__dirname, 'SettingsScreen.tsx'), 'utf8');
const KEY = 'settings-screen-secret-KKK321';
const KEY_2 = 'settings-screen-secret-LLL654';

function createService(options: { readonly seeded?: string } = {}): ProviderCredentialService {
  return createProviderCredentialService({
    keyStore: createInMemorySecureKeyStore(
      options.seeded ? { initial: { [PROVIDER_SECRET_STORAGE_KEY]: options.seeded } } : {}
    ),
    isDevelopment: true,
    developmentEnvKey: () => null,
  });
}

describe('A. Settings surface contract', () => {
  it('is wired to the canonical provider configuration service', () => {
    expect(SETTINGS_SOURCE).toContain("from '../provider-config'");
    expect(SETTINGS_SOURCE).toContain('getProviderCredentialService');
    expect(SETTINGS_SOURCE).toContain('createProviderDiagnostics');
    expect(SETTINGS_SOURCE).toContain('diagnosticCodeLabel');
  });

  it('masks the key field and never renders the stored secret', () => {
    expect(SETTINGS_SOURCE).toContain('secureTextEntry');
    expect(SETTINGS_SOURCE).toContain('autoCapitalize="none"');
    expect(SETTINGS_SOURCE).toContain('autoCorrect={false}');
    // The screen must never read the credential in order to display it.
    expect(SETTINGS_SOURCE).not.toContain('resolveKeySync');
    // ...and it never renders a stored key into a field.
    expect(SETTINGS_SOURCE).not.toMatch(/value=\{snapshot/);
  });

  it('exposes configure / replace / remove / verify controls', () => {
    expect(SETTINGS_SOURCE).toContain('settings-save');
    expect(SETTINGS_SOURCE).toContain('settings-remove');
    expect(SETTINGS_SOURCE).toContain('settings-verify');
    expect(SETTINGS_SOURCE).toContain('service.saveKey');
    expect(SETTINGS_SOURCE).toContain('service.removeKey');
    expect(SETTINGS_SOURCE).toContain('verifyConnection');
  });

  it('explains that the key stays on the device and is not bundled', () => {
    expect(SETTINGS_SOURCE).toContain('stays on this device');
    expect(SETTINGS_SOURCE).toContain('secure storage');
    expect(SETTINGS_SOURCE).toContain('never shown again');
  });

  it('states the Demo policy explicitly instead of silently choosing it', () => {
    expect(SETTINGS_SOURCE).toContain('Demo mode');
    expect(SETTINGS_SOURCE).toContain('never switched on for you');
  });

  it('keeps the pre-existing diagnostic-assessment entry point', () => {
    expect(SETTINGS_SOURCE).toContain("navigation.navigate('Onboarding')");
    expect(SETTINGS_SOURCE).toContain('Assess my English');
  });

  it('tells the learner that an already-open screen keeps its provider', () => {
    // Talk holds one provider per conversation session, so the screen must not
    // imply that a key change retroactively applies to a running session.
    const normalized = SETTINGS_SOURCE.replace(/\s+/g, ' ');
    expect(normalized).toContain('keeps the provider it started with');
    expect(normalized).toContain('reopen it to use the new key');
  });

  it('only records verification of the STORED credential, never of a draft', () => {
    expect(SETTINGS_SOURCE).toContain('verifyingDraft');
    expect(SETTINGS_SOURCE).toContain('if (!verifyingDraft)');
    expect(SETTINGS_SOURCE).toContain('service.recordDiagnostic(result)');
  });
});

describe('B. The service calls the Settings handlers make', () => {
  it('save → the key is stored and the screen can clear its field', async () => {
    const service = createService();
    const result = await service.saveKey(KEY);
    expect(result.ok).toBe(true);

    // What the screen renders next: presence only, never the value.
    const snapshot = service.snapshot();
    expect(snapshot.hasRuntimeCredential).toBe(true);
    expect(snapshot.status).toBe('unverified');
    expect(JSON.stringify(snapshot)).not.toContain(KEY);
  });

  it('replace → the newer key wins over the previous one', async () => {
    const service = createService({ seeded: KEY });
    expect(service.resolveKeySync()).toBe(KEY);

    const result = await service.saveKey(KEY_2);
    expect(result.ok).toBe(true);
    expect(service.resolveKeySync()).toBe(KEY_2);
    expect(service.snapshot().status).toBe('unverified');
  });

  it('remove → the screen reports removal and the state returns to not-configured', async () => {
    const service = createService({ seeded: KEY });
    const result = await service.removeKey();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(true);

    const snapshot = service.snapshot();
    expect(snapshot.status).toBe('not-configured');
    expect(snapshot.hasRuntimeCredential).toBe(false);
  });

  it('storage failure → the learner is told, and nothing pretends to be saved', async () => {
    const service = createProviderCredentialService({
      keyStore: createInMemorySecureKeyStore({ failWrite: true }),
      isDevelopment: true,
      developmentEnvKey: () => null,
    });

    const result = await service.saveKey(KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
    expect(service.snapshot().hasRuntimeCredential).toBe(false);
  });

  it('verify → a rejection is shown without leaking the key, and is not claimed as valid', async () => {
    const service = createService({ seeded: KEY });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: `API key not valid: ${KEY}` } }), {
          status: 403,
        })
    );

    const diagnostics = createProviderDiagnostics({
      credentialService: service,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('invalid_credential');
    expect(result.message).not.toContain(KEY);

    service.recordDiagnostic(result);
    expect(service.snapshot().status).toBe('invalid-credential');
  });

  it('verify → a network problem is shown as such and never as a bad key', async () => {
    const service = createService({ seeded: KEY });
    let online = true;
    const fetchImpl = vi.fn(async () => {
      if (!online) throw new TypeError('Network request failed');
      online = false;
      throw new TypeError('Network request failed');
    });

    const diagnostics = createProviderDiagnostics({
      credentialService: service,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await diagnostics.verifyConnection();
    expect(result.code).toBe('network_unavailable');

    service.recordDiagnostic(result);
    const snapshot = service.snapshot();
    expect(snapshot.status).toBe('temporarily-unavailable');
    // The credential is still there: a network failure is not a lost key.
    expect(snapshot.hasRuntimeCredential).toBe(true);
    expect(service.resolveKeySync()).toBe(KEY);
  });

  it('verify (draft) → checking an unsaved key does not store it', async () => {
    const service = createService();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
          { status: 200 }
        )
    );

    const diagnostics = createProviderDiagnostics({
      credentialService: service,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await diagnostics.verifyConnection(KEY);
    expect(result.code).toBe('ok');

    // The screen does not record a diagnostic for a draft, and the draft is
    // not persisted by verification.
    expect(service.snapshot().hasRuntimeCredential).toBe(false);
    expect(service.snapshot().status).toBe('not-configured');
  });
});
