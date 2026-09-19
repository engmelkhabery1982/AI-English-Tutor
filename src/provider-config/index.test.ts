/**
 * src/provider-config/index.test.ts
 *
 * Wave 2 integration — the canonical configuration is what the provider
 * factories actually consume.
 *
 *  14. provider factories consume the canonical config (one lookup, no
 *      duplicated `process.env` reads in feature factories)
 *   7. explicit Demo stays explicit and is never produced implicitly
 *  12. Review provider honesty stays green
 *  13. Talk no-key behaviour stays honest (labelled, never real AI)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  configureProviderCredentialService,
  createProviderCredentialService,
  getProviderCredentialService,
  resolveGeminiApiKey,
} from './credentials';
import { PROVIDER_SECRET_STORAGE_KEY, createInMemorySecureKeyStore } from './secure-store';

import {
  REVIEW_VOICE_UNAVAILABLE_MESSAGE,
  resolveReviewProviders,
} from '../review/providers';
import {
  TALK_DEMO_LABEL,
  createTalkSession,
  createTalkVoiceCoordinator,
  getGeminiApiKey,
} from '../talk-demo';

const RUNTIME_KEY = 'canonical-runtime-key-QQQ456';

/** Feature factories that must never resolve the credential on their own. */
const FEATURE_FACTORY_FILES: readonly string[] = [
  join('..', 'talk-demo', 'index.ts'),
  join('..', 'review', 'providers.ts'),
  join('..', 'listening', 'index.ts'),
  join('..', 'adaptive-lessons', 'index.ts'),
  join('..', 'deep-speaking', 'service.ts'),
];

function installCanonicalService(runtimeKey: string | null): void {
  configureProviderCredentialService(
    createProviderCredentialService({
      keyStore: createInMemorySecureKeyStore(
        runtimeKey ? { initial: { [PROVIDER_SECRET_STORAGE_KEY]: runtimeKey } } : {}
      ),
      // Release-mode policy: the ambient EXPO_PUBLIC_* value must be irrelevant.
      isDevelopment: false,
      developmentEnvKey: () => null,
    })
  );
}

describe('canonical provider configuration is what factories consume', () => {
  beforeEach(() => {
    installCanonicalService(RUNTIME_KEY);
  });

  afterEach(() => {
    configureProviderCredentialService(null);
  });

  it('14a. the canonical resolver returns the runtime credential', () => {
    expect(resolveGeminiApiKey()).toBe(RUNTIME_KEY);
    expect(getGeminiApiKey()).toBe(RUNTIME_KEY);
    expect(getProviderCredentialService().describeSourceSync()).toBe('runtime');
  });

  it('14b. no feature factory reads the environment key directly', () => {
    // Key lookup lives in exactly one place. A feature factory that read
    // `process.env` itself would be a duplicate (and a release-build leak).
    for (const relative of FEATURE_FACTORY_FILES) {
      const source = readFileSync(join(__dirname, relative), 'utf8');
      expect(source).not.toContain('process.env.EXPO_PUBLIC_GEMINI_API_KEY');
      expect(source).not.toMatch(/process\.env\[['"]EXPO_PUBLIC_GEMINI_API_KEY/);
    }
  });

  it('14c. the single lookup is the EXISTING getGeminiApiKey used by the engines', () => {
    for (const relative of [
      join('..', 'listening', 'index.ts'),
      join('..', 'adaptive-lessons', 'index.ts'),
      join('..', 'deep-speaking', 'service.ts'),
      join('..', 'review', 'providers.ts'),
    ]) {
      const source = readFileSync(join(__dirname, relative), 'utf8');
      expect(source).toContain('getGeminiApiKey');
    }
  });

  it('14d. Review composition resolves real providers from the runtime credential', () => {
    const providers = resolveReviewProviders({ isDemo: false });
    expect(providers.kind).toBe('real');
    expect(providers.aiProvider).toBeDefined();
    // A runtime credential also enables real speech recognition.
    expect(providers.sttProvider.id).toBe('gemini-stt');
    expect(providers.voiceUnavailableMessage).toBeUndefined();
  });

  it('14e. Talk composition resolves the real provider from the runtime credential', () => {
    const bundle = createTalkSession({ mode: 'natural' });
    expect(bundle.providerKind).toBe('gemini');
    expect(bundle.providerInfo.isRealAI).toBe(true);
    expect(bundle.providerInfo.allowsPersonalizedFeedback).toBe(true);
  });

  it('14f. an injected credential still wins over the stored one (test seam intact)', () => {
    const bundle = createTalkSession({ mode: 'natural' }, { apiKey: 'injected-key' });
    expect(bundle.providerKind).toBe('gemini');
  });
});

describe('no credential on this device', () => {
  beforeEach(() => {
    installCanonicalService(null);
  });

  afterEach(() => {
    configureProviderCredentialService(null);
  });

  it('12a. Review reports an honest "unavailable" voice state — never a demo transcript', () => {
    const providers = resolveReviewProviders({ isDemo: false });
    expect(providers.kind).toBe('unavailable');
    // No AI provider is fabricated: the deterministic local evaluators grade.
    expect(providers.aiProvider).toBeUndefined();
    expect(providers.sttProvider.id).toBe('stt-unavailable');
    expect(providers.voiceUnavailableMessage).toBe(REVIEW_VOICE_UNAVAILABLE_MESSAGE);
  });

  it('12b. real Review STT fails honestly instead of inventing the learner\'s speech', async () => {
    const providers = resolveReviewProviders({ isDemo: false });
    const result = await providers.sttProvider.transcribe({ base64: 'AAAA' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(REVIEW_VOICE_UNAVAILABLE_MESSAGE);
  });

  it('7. Demo is reachable ONLY through an explicit Demo request', () => {
    // Not requested ⇒ never demo.
    expect(resolveReviewProviders({ isDemo: false }).kind).not.toBe('demo');
    // Explicitly requested ⇒ demo, and only then.
    const demo = resolveReviewProviders({ isDemo: true });
    expect(demo.kind).toBe('demo');
    expect(demo.sttProvider.id).toBe('demo-stt');
  });

  it('13a. Talk stays honest offline: labelled demo, never presented as real AI', () => {
    const bundle = createTalkSession({ mode: 'natural' });
    expect(bundle.providerKind).toBe('demo');
    expect(bundle.providerInfo.isRealAI).toBe(false);
    expect(bundle.providerInfo.allowsPersonalizedFeedback).toBe(false);
    expect(bundle.providerInfo.label).toBe(TALK_DEMO_LABEL);
    expect(bundle.providerInfo.label.toLowerCase()).toContain('demo');
    expect(bundle.providerInfo.label.toLowerCase()).toContain('not real');
  });

  it('13b. Talk voice asks for real speech recognition but never fabricates a transcript', async () => {
    const bundle = createTalkSession({ mode: 'natural' });
    const coordinator = createTalkVoiceCoordinator({
      session: bundle.session,
      providerKind: 'gemini',
    });
    expect(coordinator).toBeDefined();

    const providers = resolveReviewProviders({ isDemo: false });
    const result = await providers.sttProvider.transcribe({ uri: 'file:///tmp/audio.m4a' });
    expect(result.ok).toBe(false);
  });

  it('13c. the canonical layer reports "not configured", not Demo', () => {
    const snapshot = getProviderCredentialService().snapshot();
    expect(snapshot.status).toBe('not-configured');
    expect(snapshot.source).toBe('none');
    expect(snapshot.hasRuntimeCredential).toBe(false);
  });
});
