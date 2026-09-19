/**
 * src/provider-config/index.ts
 *
 * Wave 2 public surface: runtime provider configuration, secure secret storage
 * and provider diagnostics.
 *
 * This module owns the ONE canonical way the app obtains a provider
 * credential. Feature factories must resolve through it rather than reading
 * `process.env` themselves, so key lookup is not duplicated and the
 * development-only environment fallback can never become a production secret
 * path.
 */

export type {
  ProviderConfigurationSnapshot,
  ProviderConfigurationStatus,
  ProviderCredentialRemoveResult,
  ProviderCredentialSaveResult,
  ProviderCredentialSource,
  ProviderDiagnosticCode,
  ProviderDiagnosticResult,
  SecureStorageFailure,
  SecureStorageReadResult,
  SecureStorageWriteResult,
} from './types';

export {
  PROVIDER_SECRET_STORAGE_KEY,
  createExpoSecureKeyStore,
  createInMemorySecureKeyStore,
  loadExpoSecureStore,
} from './secure-store';
export type { SecureKeyStore } from './secure-store';

export {
  configureProviderCredentialService,
  createProviderCredentialService,
  detectDevelopmentBuild,
  getProviderCredentialService,
  resolveGeminiApiKey,
} from './credentials';
export type {
  ProviderCredentialService,
  ProviderCredentialServiceOptions,
} from './credentials';

export { createProviderDiagnostics, diagnosticCodeLabel } from './diagnostics';
export type { ProviderDiagnostics, ProviderDiagnosticsOptions } from './diagnostics';
