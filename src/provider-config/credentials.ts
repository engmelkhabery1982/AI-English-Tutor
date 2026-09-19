/**
 * src/provider-config/credentials.ts
 *
 * The ONE canonical runtime provider-credential service.
 *
 * Every provider factory in the app resolves its credential through this layer
 * (see `getGeminiApiKey`). Key lookup is therefore NOT duplicated per feature,
 * and the precedence is explicit and testable:
 *
 *   1. injected credential (tests / embedding — wins over everything)
 *   2. runtime credential held in secure device storage
 *   3. development-only `EXPO_PUBLIC_GEMINI_API_KEY` (development builds only)
 *   4. unavailable
 *
 * SECURITY PROPERTIES (enforced by construction, tested):
 * - The secret is only ever held in this module's private field. It is never
 *   returned by any snapshot, status, summary or diagnostic.
 * - `EXPO_PUBLIC_*` is NEVER used as the production runtime secret path: the
 *   environment fallback is disabled in a release (non-development) build.
 * - A new/changed key is reported `unverified` until a real verification
 *   attempt succeeds. Level of truth is never upgraded by assumption.
 * - "not configured" is a distinct state and is never reported as Demo Mode.
 * - Storage failures are surfaced, and never leave the in-memory view
 *   claiming a save/delete that did not happen.
 */

import { PROVIDER_SECRET_STORAGE_KEY, createExpoSecureKeyStore } from './secure-store';
import type { SecureKeyStore } from './secure-store';
import type {
  ProviderConfigurationSnapshot,
  ProviderConfigurationStatus,
  ProviderCredentialRemoveResult,
  ProviderCredentialSaveResult,
  ProviderCredentialSource,
  ProviderDiagnosticResult,
  SecureStorageFailure,
} from './types';

/** Learning-surface state of a credential that was never verified. */
type VerificationState = 'unknown' | 'ok' | 'invalid' | 'unavailable';

interface StorageFailureState {
  readonly failure: SecureStorageFailure;
  readonly message: string;
}

export interface ProviderCredentialServiceOptions {
  /** Secure storage implementation. Defaults to `expo-secure-store`. */
  readonly keyStore?: SecureKeyStore;
  /** Storage key. Defaults to the canonical app key. */
  readonly storageKey?: string;
  /**
   * True for development/test builds. In a release build this MUST be false so
   * the `EXPO_PUBLIC_*` fallback is not used as production secret storage.
   * Defaults to the bundle's `__DEV__` / NODE_ENV.
   */
  readonly isDevelopment?: boolean;
  /** Injected credential (tests / embedding). Highest precedence. */
  readonly injectedKey?: () => string | null | undefined;
  /** Development environment key source. */
  readonly developmentEnvKey?: () => string | null | undefined;
}

export interface ProviderCredentialService {
  /** True when this process is a development/test build. */
  readonly isDevelopmentBuild: boolean;
  /**
   * Resolves the credential to use, or null when nothing is available.
   *
   * Reading secure storage is deferred to the first call — i.e. the credential
   * is read only when provider composition actually requires it.
   */
  resolveKeySync(): string | null;
  /** Where the resolved credential came from (secret-free). */
  describeSourceSync(): ProviderCredentialSource;
  /** Key-free configuration view for the UI/diagnostics. */
  snapshot(): ProviderConfigurationSnapshot;
  /** Saves (or replaces) the runtime credential. */
  saveKey(candidate: string): Promise<ProviderCredentialSaveResult>;
  /** Removes the runtime credential. */
  removeKey(): Promise<ProviderCredentialRemoveResult>;
  /** Re-reads secure storage (e.g. after returning to the foreground). */
  refresh(): void;
  /** Records the outcome of a REAL verification attempt honestly. */
  recordDiagnostic(result: ProviderDiagnosticResult): void;
  /** Subscribes to configuration changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/* ------------------------------------------------------------------ *
 * Environment policy
 * ------------------------------------------------------------------ */

/**
 * Is this a development/test build?
 *
 * `__DEV__` is the React Native release switch: it is `false` in every release
 * build (EAS `preview` and `production`), so the environment fallback is
 * genuinely unavailable in a shipped app. Node/vitest has no `__DEV__`, where
 * anything other than NODE_ENV=production counts as development.
 */
export function detectDevelopmentBuild(): boolean {
  const bundled = (globalThis as Record<string, unknown>).__DEV__;
  if (typeof bundled === 'boolean') return bundled;
  return process.env.NODE_ENV !== 'production';
}

function defaultDevelopmentEnvKey(): string | null {
  const value = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return null;
}

function normalizeKey(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ------------------------------------------------------------------ *
 * Summaries (learner-facing, secret-free)
 * ------------------------------------------------------------------ */

function summarize(
  status: ProviderConfigurationStatus,
  storageMessage: string | null
): string {
  switch (status) {
    case 'configured':
      return 'Your API key is stored securely on this device and has been verified.';
    case 'unverified':
      return 'An API key is stored securely on this device. It has not been verified yet — use “Test connection” to check it.';
    case 'development-fallback':
      return 'No key is stored on this device. A development-only environment key is being used — this is not a release configuration.';
    case 'invalid-credential':
      return 'The provider rejected the stored key. Update it in Settings to restore online features.';
    case 'temporarily-unavailable':
      return 'The provider could not be reached. This does not mean the stored key is wrong — try again later.';
    case 'storage-unavailable':
      return storageMessage
        ? `Secure storage is unavailable on this device, so the key state is unknown: ${storageMessage}`
        : 'Secure storage is unavailable on this device, so the key state is unknown.';
    case 'not-configured':
    default:
      return 'No API key is configured. Features that need the online provider stay unavailable until you add one — the app will not substitute a demo provider for it.';
  }
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

export function createProviderCredentialService(
  options: ProviderCredentialServiceOptions = {}
): ProviderCredentialService {
  const keyStore = options.keyStore ?? createExpoSecureKeyStore();
  const storageKey = options.storageKey ?? PROVIDER_SECRET_STORAGE_KEY;
  const isDevelopmentBuild = options.isDevelopment ?? detectDevelopmentBuild();
  const readInjectedKey = options.injectedKey;
  const readDevelopmentEnvKey = options.developmentEnvKey ?? defaultDevelopmentEnvKey;

  /**
   * PRIVATE. The only place the credential lives. Never exposed by any
   * accessor other than `resolveKeySync`, which is consumed by provider
   * construction and never rendered or logged.
   */
  let runtimeKey: string | null = null;

  let loaded = false;
  let storageFailure: StorageFailureState | null = null;
  let verification: VerificationState = 'unknown';
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken listener must never corrupt configuration state.
      }
    }
  }

  /** Reads secure storage once, recording any failure honestly. */
  function loadOnce(): void {
    if (loaded) return;
    loaded = true;
    const read = keyStore.getSync(storageKey);
    if (!read.ok) {
      storageFailure = { failure: read.failure, message: read.message };
      runtimeKey = null;
      return;
    }
    storageFailure = null;
    runtimeKey = normalizeKey(read.value);
  }

  function resolveInjected(): string | null {
    if (!readInjectedKey) return null;
    try {
      return normalizeKey(readInjectedKey());
    } catch {
      return null;
    }
  }

  function resolveDevelopmentEnv(): string | null {
    if (!isDevelopmentBuild) return null;
    try {
      return normalizeKey(readDevelopmentEnvKey());
    } catch {
      return null;
    }
  }

  function resolveKeySync(): string | null {
    const injected = resolveInjected();
    if (injected) return injected;

    loadOnce();
    if (runtimeKey) return runtimeKey;

    return resolveDevelopmentEnv();
  }

  function describeSourceSync(): ProviderCredentialSource {
    if (resolveInjected()) return 'injected';
    loadOnce();
    if (runtimeKey) return 'runtime';
    if (resolveDevelopmentEnv()) return 'development-env';
    return 'none';
  }

  function computeStatus(keyPresent: boolean, source: ProviderCredentialSource): ProviderConfigurationStatus {
    if (!keyPresent) {
      // A storage failure is NOT "no key": the state is genuinely unknown.
      return storageFailure ? 'storage-unavailable' : 'not-configured';
    }
    if (verification === 'invalid') return 'invalid-credential';
    if (verification === 'unavailable') return 'temporarily-unavailable';
    if (verification === 'ok') return 'configured';
    return source === 'development-env' ? 'development-fallback' : 'unverified';
  }

  function snapshot(): ProviderConfigurationSnapshot {
    const key = resolveKeySync();
    const source = describeSourceSync();
    const status = computeStatus(key !== null, source);
    return {
      status,
      source,
      hasRuntimeCredential: (() => {
        loadOnce();
        return runtimeKey !== null;
      })(),
      usingDevelopmentFallback: source === 'development-env',
      isDevelopmentBuild,
      secureStorageAvailable: storageFailure === null,
      summary: summarize(status, storageFailure ? storageFailure.message : null),
    };
  }

  async function saveKey(candidate: string): Promise<ProviderCredentialSaveResult> {
    const normalized = normalizeKey(candidate);
    if (!normalized) {
      return {
        ok: false,
        failure: 'empty_key',
        message: 'Enter a non-empty API key before saving.',
      };
    }

    const written = await keyStore.set(storageKey, normalized);
    if (!written.ok) {
      // The in-memory state is deliberately NOT updated: we never pretend a
      // key was saved when secure storage refused it.
      return { ok: false, failure: written.failure, message: written.message };
    }

    runtimeKey = normalized;
    loaded = true;
    storageFailure = null;
    // A newly supplied key is unverified until a real attempt succeeds.
    verification = 'unknown';
    notify();
    return { ok: true, status: computeStatus(true, describeSourceSync()) };
  }

  async function removeKey(): Promise<ProviderCredentialRemoveResult> {
    loadOnce();
    const wasPresent = runtimeKey !== null;

    const deleted = await keyStore.remove(storageKey);
    if (!deleted.ok) {
      return { ok: false, failure: deleted.failure, message: deleted.message };
    }

    runtimeKey = null;
    loaded = true;
    storageFailure = null;
    verification = 'unknown';
    notify();
    return { ok: true, removed: wasPresent, status: computeStatus(resolveKeySync() !== null, describeSourceSync()) };
  }

  return {
    isDevelopmentBuild,
    resolveKeySync,
    describeSourceSync,
    snapshot,
    saveKey,
    removeKey,
    refresh(): void {
      loaded = false;
      storageFailure = null;
      loadOnce();
      notify();
    },
    recordDiagnostic(result: ProviderDiagnosticResult): void {
      switch (result.code) {
        case 'ok':
          verification = 'ok';
          break;
        case 'invalid_credential':
          verification = 'invalid';
          break;
        case 'network_unavailable':
        case 'service_error':
        case 'timeout':
          verification = 'unavailable';
          break;
        case 'no_key':
        default:
          // Nothing to record: there is no credential to have an opinion about.
          verification = 'unknown';
          break;
      }
      notify();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Canonical default instance (single source of truth)
 * ------------------------------------------------------------------ */

let defaultService: ProviderCredentialService | null = null;

/**
 * The process-wide credential service used by every provider factory.
 *
 * Created lazily so importing this module never touches native storage.
 */
export function getProviderCredentialService(): ProviderCredentialService {
  if (!defaultService) {
    defaultService = createProviderCredentialService();
  }
  return defaultService;
}

/**
 * Replaces (or resets) the canonical service. Used by tests and embedding to
 * inject a credential service; production never calls this.
 */
export function configureProviderCredentialService(
  service: ProviderCredentialService | null
): void {
  defaultService = service;
}

/**
 * The canonical credential resolution used by provider composition.
 *
 * Runtime secure credential first, development environment key only in a
 * development build, otherwise null (unavailable).
 */
export function resolveGeminiApiKey(): string | null {
  return getProviderCredentialService().resolveKeySync();
}
