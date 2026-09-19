/**
 * src/talk-demo/explicit-provider-mode.test.ts
 *
 * Wave 2 hardening — Demo Mode is EXPLICIT ONLY.
 *
 * This suite proves the provider-selection contract by observing which provider
 * factory is actually constructed, so "no automatic Demo fallback" is verified
 * as a fact rather than inferred from a label:
 *
 *   1. real mode + no key does NOT instantiate the Demo AI provider
 *   2. real mode + no key cannot start fake AI tutoring (no scripted reply, no
 *      tutor history)
 *   3. explicit Demo Mode still works (AI + speech recognition)
 *   4. real mode + a runtime credential uses Gemini
 *   5. no learner evidence is generated from the unavailable provider state
 *
 * The provider factories are module-mocked precisely so the construction calls
 * can be counted; every other behaviour (session, engine, persistence) is the
 * production code path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DemoAIModule from '../providers/ai/demo';
import type * as GeminiAIModule from '../providers/ai/gemini';

const demoAI = vi.hoisted(() => ({ calls: 0 }));
const geminiAI = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../providers/ai/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof DemoAIModule>();
  return {
    ...actual,
    createDemoAIProvider: (...args: Parameters<typeof actual.createDemoAIProvider>) => {
      demoAI.calls += 1;
      return actual.createDemoAIProvider(...args);
    },
  };
});

vi.mock('../providers/ai/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof GeminiAIModule>();
  return {
    ...actual,
    createGeminiAIProvider: (...args: Parameters<typeof actual.createGeminiAIProvider>) => {
      geminiAI.calls += 1;
      return actual.createGeminiAIProvider(...args);
    },
  };
});

import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createDemoAudioRecorder } from '../voice';
import { createDemoTTSProvider } from '../providers/tts';
import {
  configureProviderCredentialService,
  createProviderCredentialService,
  createInMemorySecureKeyStore,
  PROVIDER_SECRET_STORAGE_KEY,
} from '../provider-config';
import {
  TALK_DEMO_LABEL,
  createTalkSession,
  createTalkVoiceCoordinator,
} from './index';

const RUNTIME_KEY = 'talk-explicit-mode-runtime-key-0001';

/** No credential anywhere: neither secure storage nor the environment. */
function installNoCredential(): void {
  configureProviderCredentialService(
    createProviderCredentialService({
      keyStore: createInMemorySecureKeyStore(),
      isDevelopment: false,
      developmentEnvKey: () => null,
    }),
  );
}

/** A runtime credential held in secure storage. */
function installRuntimeCredential(): void {
  configureProviderCredentialService(
    createProviderCredentialService({
      keyStore: createInMemorySecureKeyStore({
        initial: { [PROVIDER_SECRET_STORAGE_KEY]: RUNTIME_KEY },
      }),
      isDevelopment: false,
      developmentEnvKey: () => null,
    }),
  );
}

describe('Talk provider mode is explicit — Demo is never automatic', () => {
  beforeEach(() => {
    demoAI.calls = 0;
    geminiAI.calls = 0;
  });

  it('1. real mode with no key does NOT instantiate the Demo AI provider', () => {
    installNoCredential();

    const bundle = createTalkSession({ mode: 'natural' });

    expect(demoAI.calls).toBe(0);
    expect(geminiAI.calls).toBe(0);
    expect(bundle.providerKind).toBe('unavailable');
    expect(bundle.providerInfo.isRealAI).toBe(false);
    expect(bundle.providerInfo.allowsPersonalizedFeedback).toBe(false);
    expect(bundle.providerInfo.label).toContain('Configuration required');
  });

  it('2. real mode with no key cannot start fake AI tutoring', async () => {
    installNoCredential();

    const bundle = createTalkSession({ mode: 'natural' });
    const result = await bundle.session.send({ userMessage: 'Hello there!' });

    // No scripted reply is produced and nothing is recorded as a tutor turn.
    expect(result.ok).toBe(false);
    expect(bundle.session.getHistory()).toEqual([]);
    expect(bundle.session.getLastFeedback()).toBeNull();
  });

  it('2b. no scripted speech recognition either: voice input fails honestly', async () => {
    installNoCredential();

    const bundle = createTalkSession({ mode: 'natural' });
    const coordinator = createTalkVoiceCoordinator({
      session: bundle.session,
      providerKind: bundle.providerKind,
      recorder: createDemoAudioRecorder(),
      ttsProvider: createDemoTTSProvider(),
    });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(false);
    // The deterministic demo transcript is NOT substituted.
    expect(result.transcript ?? '').not.toBe(
      'Yesterday I went to a meeting with my manager.',
    );
    expect(bundle.session.getHistory()).toEqual([]);
  });

  it('3. explicit Demo Mode still works, with Demo AI and demo speech recognition', async () => {
    installNoCredential();

    const bundle = createTalkSession({ mode: 'natural' }, { isDemo: true });

    expect(demoAI.calls).toBe(1);
    expect(geminiAI.calls).toBe(0);
    expect(bundle.providerKind).toBe('demo');
    expect(bundle.providerInfo.label).toBe(TALK_DEMO_LABEL);

    // The scripted conversation really runs when it was asked for.
    const result = await bundle.session.send({ userMessage: 'Hello!' });
    expect(result.ok).toBe(true);
    expect(bundle.session.getHistory()).toHaveLength(2);

    const coordinator = createTalkVoiceCoordinator({
      session: bundle.session,
      providerKind: bundle.providerKind,
      recorder: createDemoAudioRecorder(),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const voice = await coordinator.stopRecordingAndProcess();
    expect(voice.ok).toBe(true);
  });

  it('4. real mode with a runtime credential uses Gemini, not Demo', () => {
    installRuntimeCredential();

    const bundle = createTalkSession({ mode: 'natural' });

    expect(geminiAI.calls).toBe(1);
    expect(demoAI.calls).toBe(0);
    expect(bundle.providerKind).toBe('gemini');
    expect(bundle.providerInfo.isRealAI).toBe(true);
    expect(bundle.providerInfo.allowsPersonalizedFeedback).toBe(true);
  });

  it('4b. explicit Demo Mode wins over a configured credential (the caller asked for Demo)', () => {
    installRuntimeCredential();

    const bundle = createTalkSession({ mode: 'natural' }, { isDemo: true });

    expect(demoAI.calls).toBe(1);
    expect(geminiAI.calls).toBe(0);
    expect(bundle.providerKind).toBe('demo');
  });

  it('5. the unavailable state generates no learner evidence at all', async () => {
    installNoCredential();

    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profileRepo = new SQLiteUserProfileRepository(adapter);
    const profile = await profileRepo.update({
      displayName: 'Evidence Probe',
      targetLanguage: 'en',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
    });

    const bundle = createTalkSession(
      { mode: 'coach' },
      { databaseAdapter: adapter },
    );
    expect(bundle.providerKind).toBe('unavailable');

    // Repeated attempts through the unavailable provider.
    await bundle.session.send({ userMessage: 'I go to meeting yesterday' });
    await bundle.session.send({ userMessage: 'Actually, I went to a meeting.' });

    // The failed turns produced no learner evidence of any kind: no weakness,
    // no review item, no saved vocabulary and no conversation turn.
    const weaknesses = new SQLiteWeaknessRepository(adapter);
    expect(await weaknesses.listWeaknesses(profile.id)).toHaveLength(0);

    const review = new SQLiteReviewRepository(adapter);
    expect(await review.listDue(profile.id, new Date().toISOString())).toHaveLength(0);

    const vocabulary = new SQLiteVocabularyRepository(adapter);
    expect(await vocabulary.list(profile.id)).toHaveLength(0);

    // No conversation turn was persisted either: the history stayed empty.
    expect(bundle.session.getHistory()).toEqual([]);

    await adapter.close();
  });
});
