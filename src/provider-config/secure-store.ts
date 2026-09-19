/**
 * src/provider-config/secure-store.ts
 *
 * Secure device storage port for the runtime provider credential.
 *
 * The port is deliberately tiny and asynchronous-OR-remembered:
 * - writes / deletes are async (the platform API is async),
 * - reads have a SYNCHRONOUS form, because the EXISTING provider factories are
 *   synchronous and must not be rewritten (and must not duplicate key lookup).
 *
 * Every failure mode is returned, never swallowed: a storage failure is
 * `{ ok: false }`, never "no value stored". A caller can therefore always tell
 * "there is no key" apart from "I could not find out".
 *
 * The default implementation uses `expo-secure-store` (Android: SharedPreferences
 * encrypted with the Android Keystore; iOS: Keychain). It is loaded through a
 * guarded synchronous require so the module stays importable in Node/vitest,
 * where the native module does not exist — in that case it honestly reports
 * `unavailable` instead of pretending.
 */

import type {
  SecureStorageReadResult,
  SecureStorageWriteResult,
} from './types';

/** Secure storage key holding the runtime Gemini credential. */
export const PROVIDER_SECRET_STORAGE_KEY = 'ai-english-tutor.gemini.api-key';

export interface SecureKeyStore {
  /** Stable identifier used in tests/diagnostics (never secret). */
  readonly id: string;
  /**
   * Synchronously reads the stored value.
   *
   * Returns `{ ok: true, value: null }` only when the store is reachable AND
   * has no entry. A reachability problem is `{ ok: false }` — never `null`.
   */
  getSync(key: string): SecureStorageReadResult;
  set(key: string, value: string): Promise<SecureStorageWriteResult>;
  remove(key: string): Promise<SecureStorageWriteResult>;
  /** Best-effort reachability probe for diagnostics/UI. */
  isAvailable(): Promise<boolean>;
}

/* ------------------------------------------------------------------ *
 * expo-secure-store adapter
 * ------------------------------------------------------------------ */

interface ExpoSecureStoreModule {
  getItem?: (key: string) => string | null;
  setItemAsync?: (key: string, value: string) => Promise<void>;
  deleteItemAsync?: (key: string) => Promise<void>;
  isAvailableAsync?: () => Promise<boolean>;
}

/** The bundler-provided CommonJS require, or null when it does not exist. */
type RequireFn = ((id: string) => unknown) | undefined;

function resolveRequire(): RequireFn {
  // `typeof` on an undeclared identifier is safe even when it does not exist.
  return typeof require === 'function' ? (require as RequireFn) : undefined;
}

/**
 * Loads `expo-secure-store` synchronously.
 *
 * Metro resolves the literal specifier at build time. In Node/vitest the call
 * throws and we return null — the caller then reports storage as unavailable
 * rather than fabricating a successful save.
 */
export function loadExpoSecureStore(): ExpoSecureStoreModule | null {
  const loader = resolveRequire();
  if (!loader) return null;
  try {
    const mod = loader('expo-secure-store') as ExpoSecureStoreModule | null;
    if (mod && typeof mod.getItem === 'function' && typeof mod.setItemAsync === 'function') {
      return mod;
    }
    return null;
  } catch {
    return null;
  }
}

const STORAGE_UNAVAILABLE_MESSAGE =
  'Secure storage is not available on this device, so the API key cannot be kept securely.';

/** Secure storage backed by the platform keystore via `expo-secure-store`. */
export function createExpoSecureKeyStore(): SecureKeyStore {
  return {
    id: 'expo-secure-store',

    getSync(key: string): SecureStorageReadResult {
      const mod = loadExpoSecureStore();
      if (!mod || typeof mod.getItem !== 'function') {
        return { ok: false, failure: 'unavailable', message: STORAGE_UNAVAILABLE_MESSAGE };
      }
      try {
        const value = mod.getItem(key);
        if (typeof value !== 'string' || value.trim().length === 0) {
          return { ok: true, value: null };
        }
        return { ok: true, value };
      } catch {
        return {
          ok: false,
          failure: 'read_failed',
          message: 'Secure storage could not be read, so the saved key is unknown.',
        };
      }
    },

    async set(key: string, value: string): Promise<SecureStorageWriteResult> {
      const mod = loadExpoSecureStore();
      if (!mod || typeof mod.setItemAsync !== 'function') {
        return { ok: false, failure: 'unavailable', message: STORAGE_UNAVAILABLE_MESSAGE };
      }
      try {
        await mod.setItemAsync(key, value);
        return { ok: true };
      } catch {
        return {
          ok: false,
          failure: 'write_failed',
          message: 'The key could not be written to secure storage on this device.',
        };
      }
    },

    async remove(key: string): Promise<SecureStorageWriteResult> {
      const mod = loadExpoSecureStore();
      if (!mod || typeof mod.deleteItemAsync !== 'function') {
        return { ok: false, failure: 'unavailable', message: STORAGE_UNAVAILABLE_MESSAGE };
      }
      try {
        await mod.deleteItemAsync(key);
        return { ok: true };
      } catch {
        return {
          ok: false,
          failure: 'delete_failed',
          message: 'The saved key could not be removed from secure storage.',
        };
      }
    },

    async isAvailable(): Promise<boolean> {
      const mod = loadExpoSecureStore();
      if (!mod || typeof mod.isAvailableAsync !== 'function') return false;
      try {
        return await mod.isAvailableAsync();
      } catch {
        return false;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * In-memory store (tests / embedding — never a silent production fallback)
 * ------------------------------------------------------------------ */

interface InMemoryKeyStoreOptions {
  /** Pre-seeded entries. */
  readonly initial?: Readonly<Record<string, string>>;
  /** Simulate an unavailable device. */
  readonly unavailable?: boolean;
  /** Simulate a read failure. */
  readonly failRead?: boolean;
  /** Simulate a write/delete failure. */
  readonly failWrite?: boolean;
}

/**
 * In-memory secure store for tests and explicit embedding.
 *
 * It is NEVER selected automatically: a device without usable secure storage
 * must report that honestly rather than accept a key into volatile memory and
 * pretend it was saved.
 */
export function createInMemorySecureKeyStore(
  options: InMemoryKeyStoreOptions = {}
): SecureKeyStore {
  const entries = new Map<string, string>(Object.entries(options.initial ?? {}));

  return {
    id: 'in-memory-secure-store',

    getSync(key: string): SecureStorageReadResult {
      if (options.unavailable) {
        return { ok: false, failure: 'unavailable', message: STORAGE_UNAVAILABLE_MESSAGE };
      }
      if (options.failRead) {
        return {
          ok: false,
          failure: 'read_failed',
          message: 'Secure storage could not be read, so the saved key is unknown.',
        };
      }
      const value = entries.get(key);
      return { ok: true, value: value && value.length > 0 ? value : null };
    },

    async set(key: string, value: string): Promise<SecureStorageWriteResult> {
      if (options.unavailable) {
        return { ok: false, failure: 'unavailable', message: STORAGE_UNAVAILABLE_MESSAGE };
      }
      if (options.failWrite) {
        return {
          ok: false,
          failure: 'write_failed',
          message: 'The key could not be written to secure storage on this device.',
        };
      }
      entries.set(key, value);
      return { ok: true };
    },

    async remove(key: string): Promise<SecureStorageWriteResult> {
      if (options.unavailable) {
        return { ok: false, failure: 'unavailable', message: STORAGE_UNAVAILABLE_MESSAGE };
      }
      if (options.failWrite) {
        return {
          ok: false,
          failure: 'delete_failed',
          message: 'The saved key could not be removed from secure storage.',
        };
      }
      entries.delete(key);
      return { ok: true };
    },

    async isAvailable(): Promise<boolean> {
      return !options.unavailable;
    },
  };
}
