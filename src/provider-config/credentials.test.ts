/**
 * src/provider-config/credentials.test.ts
 *
 * Wave 2 — runtime provider configuration + secret storage.
 *
 *   1.  save runtime key
 *   2.  load runtime key (read on demand, not at construction)
 *   3.  replace runtime key
 *   4.  delete runtime key
 *   5.  secure storage failure (unavailable / read / write / delete)
 *   6.  no key => unavailable, NOT Demo
 *   7.  explicit Demo stays explicit (never produced by this layer)
 *   8.  runtime key wins over the development fallback
 *   9.  the development fallback is DEVELOPMENT-ONLY (release builds ignore it)
 *  10.  verification honesty: unverified → verified / rejected
 *  11.  the key never appears in provider state
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderCredentialService, detectDevelopmentBuild } from './credentials';
import type { ProviderCredentialService } from './credentials';
import {
  PROVIDER_SECRET_STORAGE_KEY,
  createInMemorySecureKeyStore,
} from './secure-store';
import type { SecureKeyStore } from './secure-store';

const RUNTIME_KEY = 'runtime-secret-key-AAA111';
const REPLACEMENT_KEY = 'runtime-secret-key-BBB222';
const DEV_ENV_KEY = 'development-env-key-CCC333';

/** Wraps a store so reads/writes can be observed. */
function createSpyStore(
  inner: SecureKeyStore
): { readonly store: SecureKeyStore; readonly reads: () => number; readonly writes: () => number } {
  let reads = 0;
  let writes = 0;
  return {
    store: {
      id: `${inner.id}-spy`,
      getSync: (key: string) => {
        reads += 1;
        return inner.getSync(key);
      },
      set: (key: string, value: string) => {
        writes += 1;
        return inner.set(key, value);
      },
      remove: (key: string) => {
        writes += 1;
        return inner.remove(key);
      },
      isAvailable: () => inner.isAvailable(),
    },
    reads: () => reads,
    writes: () => writes,
  };
}

function createService(
  options: {
    readonly store?: SecureKeyStore;
    readonly isDevelopment?: boolean;
    readonly injectedKey?: () => string | null | undefined;
    readonly envKey?: string | null;
  } = {}
): ProviderCredentialService {
  return createProviderCredentialService({
    keyStore: options.store ?? createInMemorySecureKeyStore(),
    isDevelopment: options.isDevelopment ?? true,
    ...(options.injectedKey ? { injectedKey: options.injectedKey } : {}),
    developmentEnvKey: () => options.envKey ?? null,
  });
}

describe('provider credential service — runtime secret storage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. saves a runtime key into secure storage and reports it as stored', async () => {
    const store = createInMemorySecureKeyStore();
    const service = createService({ store });

    const before = service.snapshot();
    expect(before.status).toBe('not-configured');
    expect(before.hasRuntimeCredential).toBe(false);

    const saved = await service.saveKey(RUNTIME_KEY);
    expect(saved.ok).toBe(true);

    const after = service.snapshot();
    expect(after.hasRuntimeCredential).toBe(true);
    expect(after.source).toBe('runtime');
    // A freshly saved key is NOT claimed to be valid.
    expect(after.status).toBe('unverified');

    // The value really reached the store (not just memory).
    const raw = store.getSync(PROVIDER_SECRET_STORAGE_KEY);
    expect(raw.ok).toBe(true);
    if (raw.ok) expect(raw.value).toBe(RUNTIME_KEY);

    // Whitespace is normalized.
    const padded = await service.saveKey(`  ${REPLACEMENT_KEY}  `);
    expect(padded.ok).toBe(true);
    expect(service.resolveKeySync()).toBe(REPLACEMENT_KEY);
  });

  it('2. loads an existing key lazily — secure storage is read only when required', () => {
    const inner = createInMemorySecureKeyStore({ initial: { [PROVIDER_SECRET_STORAGE_KEY]: RUNTIME_KEY } });
    const spy = createSpyStore(inner);
    const service = createService({ store: spy.store });

    // Construction alone must not touch the device keystore.
    expect(spy.reads()).toBe(0);

    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);
    expect(spy.reads()).toBe(1);

    // Subsequent resolutions reuse the loaded view (no repeated native reads).
    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);
    expect(spy.reads()).toBe(1);
  });

  it('3. replaces the stored key and the new value wins', async () => {
    const store = createInMemorySecureKeyStore({ initial: { [PROVIDER_SECRET_STORAGE_KEY]: RUNTIME_KEY } });
    const service = createService({ store });
    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);

    const replaced = await service.saveKey(REPLACEMENT_KEY);
    expect(replaced.ok).toBe(true);
    expect(service.resolveKeySync()).toBe(REPLACEMENT_KEY);

    const raw = store.getSync(PROVIDER_SECRET_STORAGE_KEY);
    if (raw.ok) expect(raw.value).toBe(REPLACEMENT_KEY);
  });

  it('4. removes the stored key and does not fall back to Demo', async () => {
    const store = createInMemorySecureKeyStore({ initial: { [PROVIDER_SECRET_STORAGE_KEY]: RUNTIME_KEY } });
    const service = createService({ store });
    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);

    const removed = await service.removeKey();
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.removed).toBe(true);

    expect(service.resolveKeySync()).toBeNull();
    expect(service.snapshot().status).toBe('not-configured');
    expect(store.getSync(PROVIDER_SECRET_STORAGE_KEY)).toEqual({ ok: true, value: null });

    // Removing again is honest: nothing was removed.
    const again = await service.removeKey();
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.removed).toBe(false);
  });

  it('5a. an unreachable secure store is reported as unknown — never as "no key"', async () => {
    const service = createService({ store: createInMemorySecureKeyStore({ unavailable: true }) });

    const snapshot = service.snapshot();
    expect(snapshot.status).toBe('storage-unavailable');
    expect(snapshot.secureStorageAvailable).toBe(false);
    expect(snapshot.status).not.toBe('not-configured');
    expect(snapshot.summary).toContain('Secure storage is unavailable');

    // Saving cannot succeed, and must not pretend it did.
    const saved = await service.saveKey(RUNTIME_KEY);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.failure).toBe('unavailable');
    expect(service.snapshot().hasRuntimeCredential).toBe(false);
  });

  it('5b. a read failure is surfaced instead of being treated as an empty store', () => {
    const service = createService({ store: createInMemorySecureKeyStore({ failRead: true }) });
    const snapshot = service.snapshot();
    expect(snapshot.status).toBe('storage-unavailable');
    expect(snapshot.summary).toContain('could not be read');
  });

  it('5c. a write failure leaves the previous credential intact and says so', async () => {
    const inner = createInMemorySecureKeyStore({ initial: { [PROVIDER_SECRET_STORAGE_KEY]: RUNTIME_KEY } });
    const service = createService({ store: inner });
    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);

    // Swap in a failing store for the write, simulating a keystore failure.
    const failing = createService({
      store: createInMemorySecureKeyStore({
        initial: { [PROVIDER_SECRET_STORAGE_KEY]: RUNTIME_KEY },
        failWrite: true,
      }),
    });
    const saved = await failing.saveKey(REPLACEMENT_KEY);
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.failure).toBe('write_failed');
    // The in-memory view did not adopt a key that was never persisted.
    expect(failing.snapshot().hasRuntimeCredential).toBe(true);
    expect(failing.resolveKeySync()).toBe(RUNTIME_KEY);
  });

  it('5d. a delete failure keeps the credential and reports the failure', async () => {
    const service = createService({
      store: createInMemorySecureKeyStore({
        initial: { [PROVIDER_SECRET_STORAGE_KEY]: RUNTIME_KEY },
        failWrite: true,
      }),
    });
    const removed = await service.removeKey();
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.failure).toBe('delete_failed');
    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);
  });

  it('5e. an empty key is refused instead of being stored', async () => {
    const store = createInMemorySecureKeyStore();
    const service = createService({ store });
    for (const candidate of ['', '   ']) {
      const saved = await service.saveKey(candidate);
      expect(saved.ok).toBe(false);
      if (!saved.ok) expect(saved.failure).toBe('empty_key');
    }
    expect(store.getSync(PROVIDER_SECRET_STORAGE_KEY)).toEqual({ ok: true, value: null });
  });

  it('6. no key means "unavailable", never Demo', () => {
    const service = createService({ envKey: null });
    const snapshot = service.snapshot();

    expect(service.resolveKeySync()).toBeNull();
    expect(snapshot.status).toBe('not-configured');
    expect(snapshot.source).toBe('none');

    // The canonical configuration layer has no Demo state at all: a missing
    // credential can never be *reported* as a demo provider. (The summary may
    // say that Demo is NOT substituted — that is the honesty guarantee.)
    expect(snapshot.status).not.toBe('demo');
    expect(snapshot.source).not.toBe('demo');
    expect(Object.values(snapshot)).not.toContain('demo');
    expect(Object.values(snapshot)).not.toContain('demo-mode');
    expect(Object.values(snapshot)).not.toContain('demoMode');
    expect(snapshot.summary).toContain('will not substitute a demo provider');
  });

  it('7. explicit Demo is a separate, caller-owned decision this layer never makes', () => {
    const service = createService({ envKey: null });
    // Without a credential the layer reports "not-configured"; whether a
    // surface offers Demo Mode is that surface's explicit choice.
    expect(service.snapshot().status).toBe('not-configured');
    expect(
      Object.keys(service.snapshot()).some((key) => key.toLowerCase().includes('demo')),
    ).toBe(false);
  });

  it('8. the runtime key wins over the development environment fallback', async () => {
    const store = createInMemorySecureKeyStore();
    const service = createService({ store, envKey: DEV_ENV_KEY, isDevelopment: true });

    // With no runtime key, the development fallback is in effect and labelled.
    expect(service.resolveKeySync()).toBe(DEV_ENV_KEY);
    expect(service.describeSourceSync()).toBe('development-env');
    expect(service.snapshot().status).toBe('development-fallback');
    expect(service.snapshot().usingDevelopmentFallback).toBe(true);

    // Once a runtime key exists, it wins.
    await service.saveKey(RUNTIME_KEY);
    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);
    expect(service.describeSourceSync()).toBe('runtime');
    expect(service.snapshot().usingDevelopmentFallback).toBe(false);

    // Removing it falls back to the labelled development key again — and never
    // silently to Demo.
    await service.removeKey();
    expect(service.resolveKeySync()).toBe(DEV_ENV_KEY);
    expect(service.describeSourceSync()).toBe('development-env');
  });

  it('9. a release build ignores EXPO_PUBLIC_* as a secret source', async () => {
    const store = createInMemorySecureKeyStore();
    const service = createService({ store, envKey: DEV_ENV_KEY, isDevelopment: false });

    // The environment key is bundled in plain text; it is not a production
    // secret path, so a release build must not use it.
    expect(service.resolveKeySync()).toBeNull();
    expect(service.describeSourceSync()).toBe('none');
    expect(service.snapshot().status).toBe('not-configured');
    expect(service.snapshot().usingDevelopmentFallback).toBe(false);

    // A runtime credential still works in a release build.
    await service.saveKey(RUNTIME_KEY);
    expect(service.resolveKeySync()).toBe(RUNTIME_KEY);
    expect(service.snapshot().status).toBe('unverified');
  });

  it('10. verification is only claimed after a real attempt', async () => {
    const service = createService({ store: createInMemorySecureKeyStore() });
    await service.saveKey(RUNTIME_KEY);

    expect(service.snapshot().status).toBe('unverified');

    service.recordDiagnostic({ code: 'ok', message: 'ok' });
    expect(service.snapshot().status).toBe('configured');

    // A rejection is reported as a rejected credential, not as "missing key".
    service.recordDiagnostic({ code: 'invalid_credential', message: 'rejected' });
    expect(service.snapshot().status).toBe('invalid-credential');

    // A network/service problem says nothing about the credential.
    service.recordDiagnostic({ code: 'network_unavailable', message: 'offline' });
    expect(service.snapshot().status).toBe('temporarily-unavailable');
    service.recordDiagnostic({ code: 'timeout', message: 'slow' });
    expect(service.snapshot().status).toBe('temporarily-unavailable');
    service.recordDiagnostic({ code: 'service_error', message: '500' });
    expect(service.snapshot().status).toBe('temporarily-unavailable');

    // Replacing the key resets the verdict: a new secret is unverified again.
    service.recordDiagnostic({ code: 'ok', message: 'ok' });
    await service.saveKey(REPLACEMENT_KEY);
    expect(service.snapshot().status).toBe('unverified');
  });

  it('11a. the credential never appears in any snapshot, summary or status', async () => {
    const service = createService({ store: createInMemorySecureKeyStore() });
    await service.saveKey(RUNTIME_KEY);
    service.recordDiagnostic({ code: 'ok', message: 'ok' });

    const snapshot = service.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(RUNTIME_KEY);
    expect(snapshot.summary).not.toContain(RUNTIME_KEY);
    for (const value of Object.values(snapshot)) {
      expect(String(value)).not.toContain(RUNTIME_KEY);
    }
    // No field even hints at the secret material.
    expect(Object.keys(snapshot)).not.toContain('key');
    expect(Object.keys(snapshot)).not.toContain('apiKey');
    expect(Object.keys(snapshot)).not.toContain('credential');
  });

  it('11b. subscribers receive notifications that carry no secret', async () => {
    const service = createService({ store: createInMemorySecureKeyStore() });
    const seen: string[] = [];
    const unsubscribe = service.subscribe(() => {
      seen.push(JSON.stringify(service.snapshot()));
    });

    await service.saveKey(RUNTIME_KEY);
    service.recordDiagnostic({ code: 'invalid_credential', message: 'rejected' });
    await service.removeKey();
    unsubscribe();

    expect(seen).toHaveLength(3);
    for (const entry of seen) expect(entry).not.toContain(RUNTIME_KEY);
  });

  it('detects the build kind the way the release policy requires', () => {
    // React Native release builds define __DEV__ = false.
    const globalWithDev = globalThis as { __DEV__?: unknown };
    const original = globalWithDev.__DEV__;
    try {
      globalWithDev.__DEV__ = false;
      expect(detectDevelopmentBuild()).toBe(false);
      globalWithDev.__DEV__ = true;
      expect(detectDevelopmentBuild()).toBe(true);
    } finally {
      if (original === undefined) delete globalWithDev.__DEV__;
      else globalWithDev.__DEV__ = original;
    }

    // Without __DEV__ (Node/vitest) anything but a production NODE_ENV counts
    // as development, which is what keeps the documented dev workflow working.
    delete globalWithDev.__DEV__;
    const env = process.env as Record<string, string | undefined>;
    const originalNodeEnv = env.NODE_ENV;
    try {
      env.NODE_ENV = 'production';
      expect(detectDevelopmentBuild()).toBe(false);
      env.NODE_ENV = 'development';
      expect(detectDevelopmentBuild()).toBe(true);
    } finally {
      if (originalNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = originalNodeEnv;
    }
  });
});
