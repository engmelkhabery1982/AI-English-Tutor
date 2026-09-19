/**
 * src/provider-config/types.ts
 *
 * Wave 2 — runtime provider configuration, secret storage and provider
 * diagnostics. Domain types only; no I/O.
 *
 * HONESTY RULES BAKED INTO THESE TYPES:
 * - A stored key is NOT a verified key. `unverified` is a real state and is
 *   never reported as `configured-and-working`.
 * - "not configured" is a real state and is NEVER silently reported as Demo.
 *   Demo is only ever reported when the learner explicitly selected it.
 * - No type here carries the secret itself. Snapshots and diagnostics are
 *   key-free by construction, so no log, error or UI binding can leak it.
 */

/** Where the credential currently in effect came from. */
export type ProviderCredentialSource =
  /** Test/embedding injection — wins over everything. */
  | 'injected'
  /** Runtime key stored on the device (secure storage). */
  | 'runtime'
  /** Development-only `EXPO_PUBLIC_GEMINI_API_KEY` convenience fallback. */
  | 'development-env'
  /** Nothing is configured. */
  | 'none';

/**
 * Honest configuration state of the provider stack.
 *
 * - `configured` — a runtime credential is present and was verified by a real
 *   provider round-trip.
 * - `unverified` — a credential is present but was never verified.
 * - `development-fallback` — no runtime credential; a development-only
 *   environment key is in effect. Never a production configuration.
 * - `not-configured` — nothing is configured. Features that genuinely require
 *   a provider must report "configuration required".
 * - `invalid-credential` — the provider rejected the credential.
 * - `temporarily-unavailable` — network/service failure; says nothing about
 *   the credential.
 * - `storage-unavailable` — secure storage could not be read/written, so the
 *   configuration state itself is unknown. Never treated as "no key".
 */
export type ProviderConfigurationStatus =
  | 'configured'
  | 'unverified'
  | 'development-fallback'
  | 'not-configured'
  | 'invalid-credential'
  | 'temporarily-unavailable'
  | 'storage-unavailable';

/** What a real verification attempt found. */
export type ProviderDiagnosticCode =
  | 'ok'
  | 'no_key'
  | 'invalid_credential'
  | 'network_unavailable'
  | 'service_error'
  | 'timeout';

/** Secure-storage failure classes. All of them are surfaced, none are faked. */
export type SecureStorageFailure =
  | 'unavailable'
  | 'read_failed'
  | 'write_failed'
  | 'delete_failed';

/** Result of a secure-storage write/delete. */
export type SecureStorageWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: SecureStorageFailure; readonly message: string };

/** Result of a secure-storage read. */
export type SecureStorageReadResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly failure: SecureStorageFailure; readonly message: string };

/**
 * Key-free view of the provider configuration. Safe to log, render, snapshot
 * into state or pass to any surface. By construction it cannot contain the
 * credential.
 */
export interface ProviderConfigurationSnapshot {
  readonly status: ProviderConfigurationStatus;
  readonly source: ProviderCredentialSource;
  /** True when a runtime credential is held on this device. */
  readonly hasRuntimeCredential: boolean;
  /** True when a development-only environment key is in effect. */
  readonly usingDevelopmentFallback: boolean;
  /** True when this build is a development/test build. */
  readonly isDevelopmentBuild: boolean;
  /** False when secure storage could not be reached. */
  readonly secureStorageAvailable: boolean;
  /** Learner-facing, secret-free explanation of the current state. */
  readonly summary: string;
}

/** Outcome of saving or replacing the runtime credential. */
export type ProviderCredentialSaveResult =
  | { readonly ok: true; readonly status: ProviderConfigurationStatus }
  | {
      readonly ok: false;
      readonly failure: SecureStorageFailure | 'empty_key';
      readonly message: string;
    };

/** Outcome of removing the runtime credential. */
export type ProviderCredentialRemoveResult =
  | { readonly ok: true; readonly removed: boolean; readonly status: ProviderConfigurationStatus }
  | { readonly ok: false; readonly failure: SecureStorageFailure; readonly message: string };

/** Result of a real (user-initiated) provider verification attempt. */
export interface ProviderDiagnosticResult {
  readonly code: ProviderDiagnosticCode;
  /**
   * Secret-free, learner-readable explanation. Never contains the credential:
   * the EXISTING provider error paths redact it and this layer adds a
   * defensive redaction of its own.
   */
  readonly message: string;
}
