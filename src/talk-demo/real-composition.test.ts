/**
 * src/talk-demo/real-composition.test.ts
 *
 * Regression tests for the REAL Talk composition path:
 *
 * - The routed Talk screen (mounted by RootNavigator with no props) must resolve
 *   the canonical application database composition, so real Gemini conversation
 *   adapts to the learner's PERSISTED profile, weaknesses, vocabulary and
 *   progress through the EXISTING ConversationEngine.
 * - The deterministic DemoLearnerModel is only an explicit fallback when no
 *   persisted app data can be composed, and that is surfaced honestly.
 * - The learner-facing control rules keep an in-flight tutor opening from racing
 *   a learner turn (typed or spoken).
 */

import { describe, expect, it } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { fileURLToPath } from 'node:url';
import { createConversationEngine } from '../conversation-engine';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import type { VoiceStatus } from '../voice';
import {
  createDefaultTalkComposition,
  createTalkComposition,
  createTalkSession,
  resolveTalkCoaching,
  resolveTalkTurnControls,
  TALK_DEMO_LABEL,
} from '.';
import { createDemoLearnerModel } from './demo-learner-model';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = '2026-01-15T10:00:00.000Z';
const DEMO_LEARNER_ID = '00000000-0000-0000-0000-000000000001';

async function seedPersistedLearner(): Promise<{
  adapter: SqlJsAdapter;
  learnerId: string;
}> {
  const adapter = new SqlJsAdapter(':memory:');
  await adapter.init();

  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Persisted Talk Learner',
    targetLanguage: 'en',
    currentLevel: 'B2',
    targetLevel: 'C1',
    learningGoals: ['Lead meetings in English'],
  });

  const weaknesses = new SQLiteWeaknessRepository(adapter);
  await weaknesses.upsertWeakness({
    learnerId: profile.id,
    type: 'grammar',
    referenceId: 'ref-articles',
    status: 'confirmed',
    severity: 0.8,
    occurrenceCount: 6,
    contexts: ['weekly status updates'],
    evidence: [],
    resolved: false,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  });

  return { adapter, learnerId: profile.id };
}

function baseVoiceStatus(patch: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    state: 'idle',
    elapsedSeconds: 0,
    recognizedTranscript: null,
    errorMessage: null,
    isMuted: false,
    isSpeaking: false,
    canRecord: true,
    canStopRecording: false,
    canSendText: true,
    isProcessing: false,
    isSwitching: false,
    ...patch,
  };
}

describe('Talk — real persisted-learner composition', () => {
  it('1. the default Talk composition consumes persisted profile and weakness context', async () => {
    const { adapter, learnerId } = await seedPersistedLearner();

    // The routed screen passes no adapter, so it resolves the canonical app
    // composition (here: the same composition factory on a real database).
    const resolution = await resolveTalkCoaching({
      loadDefaultComposition: async () => createTalkComposition(adapter),
    });

    expect(resolution.source).toBe('persisted');
    expect(resolution.learnerModel).toBeDefined();
    expect(resolution.databaseAdapter).toBe(adapter);

    await resolution.learnerModel!.refresh();
    const context = resolution.learnerModel!.getCoachingContext();

    // Real persisted evidence — not the demo learner.
    expect(context.profile.learnerId).toBe(learnerId);
    expect(context.profile.learnerId).not.toBe(DEMO_LEARNER_ID);
    expect(context.profile.displayName).toBe('Persisted Talk Learner');
    expect(context.profile.currentLevel).toBe('B2');
    expect(context.profile.learningGoals).toContain('Lead meetings in English');
    expect(context.activeWeaknesses.length).toBeGreaterThan(0);
    expect(
      context.activeWeaknesses.some((weakness) => weakness.referenceId === 'ref-articles'),
    ).toBe(true);

    await adapter.close();
  });

  it('2. real Talk conversation does not silently use the DemoLearnerModel when persisted data is available', async () => {
    const { adapter } = await seedPersistedLearner();
    const resolution = await resolveTalkCoaching({
      loadDefaultComposition: async () => createTalkComposition(adapter),
    });
    await resolution.learnerModel!.refresh();

    // The demo learner model is a different learner with different evidence.
    const demoContext = createDemoLearnerModel().getCoachingContext();
    expect(demoContext.profile.learnerId).toBe(DEMO_LEARNER_ID);
    expect(demoContext.activeWeaknesses).toHaveLength(0);

    // What Talk actually feeds the EXISTING engine for the first real turn.
    const engine = createConversationEngine(resolution.learnerModel!);
    const prompt = engine.buildRequest({ userMessage: 'Hello!', mode: 'natural' })
      .systemPrompt;

    expect(prompt).toContain('Learner Name: Persisted Talk Learner');
    expect(prompt).toContain('Current CEFR Level: B2');
    expect(prompt).toContain('Lead meetings in English');
    expect(prompt).toContain('Active Weaknesses (Persisted):');
    expect(prompt).toContain('[grammar]');
    expect(prompt).toContain('Occurrences: 6');
    expect(prompt).toContain('weekly status updates');
    // Nothing about the demo learner leaked into the real turn.
    expect(prompt).not.toContain('Learner Name: Learner');
    expect(prompt).not.toContain('fluency, natural conversation');
    // The persisted weakness section is genuinely populated (not "None recorded.").
    expect(prompt).toContain('Active Weaknesses (Persisted):\n- [grammar] Severity: 0.8, Occurrences: 6');
    expect(prompt).toContain('Contexts: weekly status updates');

    // A Talk session composed from that resolution is a real AI conversation
    // when a credential is present (the provider is never assumed to be demo).
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello!' }] } }] }),
        { status: 200 },
      );
    const bundle = createTalkSession(
      { mode: 'natural' },
      {
        databaseAdapter: resolution.databaseAdapter,
        learnerModel: resolution.learnerModel!,
        apiKey: 'mock-key',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(bundle.providerKind).toBe('gemini');
    expect(bundle.providerInfo.isRealAI).toBe(true);
    expect(bundle.session.getConfig().mode).toBe('natural');

    await adapter.close();
  });

  it('3. the demo learner model is used ONLY as an explicit fallback when no persisted data can be composed', async () => {
    // Default bootstrap unavailable (e.g. the local database cannot be opened).
    const failed = await resolveTalkCoaching({
      loadDefaultComposition: async () => {
        throw new Error('local database unavailable');
      },
    });
    expect(failed.source).toBe('demo-fallback');
    expect(failed.learnerModel).toBeUndefined();
    expect(failed.databaseAdapter).toBeUndefined();

    // No coaching context is claimed for that session.
    const bundle = createTalkSession({ mode: 'natural' }, {
      databaseAdapter: failed.databaseAdapter,
      learnerModel: failed.learnerModel,
    });
    expect(bundle.session.getHistory()).toEqual([]);

    // An explicitly injected real learner model always wins.
    const { adapter } = await seedPersistedLearner();
    const injected = await resolveTalkCoaching({
      databaseAdapter: adapter,
      loadDefaultComposition: async () => {
        throw new Error('must not be called when an adapter is injected');
      },
    });
    expect(injected.source).toBe('persisted');
    expect(injected.learnerModel).toBeDefined();

    await adapter.close();
  });

  it('3b. without a persisted database the default bootstrap degrades honestly to the demo fallback', async () => {
    // In this test environment the native Expo SQLite module cannot be loaded,
    // which is exactly the "no persisted data available" case. The default
    // composition must report it honestly instead of pretending to personalize.
    const resolution = await resolveTalkCoaching({
      loadDefaultComposition: createDefaultTalkComposition,
    });

    expect(resolution.source).toBe('demo-fallback');
    expect(resolution.learnerModel).toBeUndefined();
    expect(resolution.databaseAdapter).toBeUndefined();

    // …and with no provider configured Talk reports configuration-required
    // rather than silently substituting the offline script.
    const bundle = createTalkSession(
      { mode: 'natural' },
      { learnerModel: resolution.learnerModel },
    );
    expect(bundle.providerKind).toBe('unavailable');
    expect(bundle.providerInfo.isRealAI).toBe(false);
    expect(bundle.providerInfo.allowsPersonalizedFeedback).toBe(false);
    expect(bundle.providerInfo.label).toContain('Configuration required');

    // Explicit Demo Mode is a separate, clearly-labelled choice.
    const demoBundle = createTalkSession(
      { mode: 'natural' },
      { learnerModel: resolution.learnerModel, isDemo: true },
    );
    expect(demoBundle.providerKind).toBe('demo');
    expect(demoBundle.providerInfo.label).toBe(TALK_DEMO_LABEL);

    // …and the shared bootstrap promise is retryable rather than latched broken.
    await expect(createDefaultTalkComposition()).rejects.toThrow();
  });

  it('4. the routed Talk screen resolves the canonical application database composition', () => {
    const navigatorSource = readFileSync(
      join(__dirname, '..', 'navigation', 'RootNavigator.tsx'),
      'utf8',
    );
    const screenSource = readFileSync(join(__dirname, '..', 'screens', 'TalkScreen.tsx'), 'utf8');
    const talkSource = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const adaptiveSource = readFileSync(join(__dirname, '..', 'adaptive-lessons', 'index.ts'), 'utf8');

    // The real route mounts Talk with no props, so the DEFAULT composition path
    // is the one that runs in the app. Since the Daily Tutor navigation
    // repair the tabs are rendered from the single-source route registry in
    // RootNavigator — still with no props.
    expect(navigatorSource).toContain('Talk: TalkScreen');
    expect(navigatorSource).not.toContain('databaseAdapter');

    // TalkScreen resolves the real coaching context instead of defaulting to demo.
    expect(screenSource).toContain('resolveTalkCoaching');
    expect(screenSource).toContain('loadDefaultComposition');
    expect(screenSource).not.toContain('createDemoLearnerModel');

    // …and Talk composes through the ONE canonical application database owner
    // (no second database, no second learner-model architecture, no
    // feature-local adapter bootstrap).
    expect(talkSource).toContain('createDefaultTalkComposition');
    expect(talkSource).toContain('getAppDatabase');
    expect(talkSource).toContain('app-database');
    expect(talkSource).toContain("from '../learner-model'");
    expect(adaptiveSource).toContain('getAppDatabase');
    expect(adaptiveSource).toContain('app-database');

    // The database FILE is named in exactly one module — the canonical owner —
    // so no feature can silently open a second connection to it.
    const ownerSource = readFileSync(
      join(__dirname, '..', 'data', 'local', 'sqlite', 'app-database.ts'),
      'utf8',
    );
    expect(ownerSource).toContain("ai_english_tutor.db");
    expect(talkSource).not.toContain('ai_english_tutor.db');
    expect(adaptiveSource).not.toContain('ai_english_tutor.db');

    // The demo learner model remains reachable only as the explicit fallback
    // inside the composition module, never from the screen.
    expect(talkSource).toContain("from './demo-learner-model'");

    // The routed screen also gates BOTH learner inputs on the tutor opening and
    // on the session switch, and says plainly that the tutor is starting.
    expect(screenSource).toContain('resolveTalkTurnControls({');
    expect(screenSource).toContain('isOpening,');
    // Both learner inputs stay blocked while there is no provider at all, so a
    // conversation cannot be started into nothing.
    expect(screenSource).toContain(
      'disabled={turnControls.micDisabled || isProviderUnavailable}',
    );
    expect(screenSource).toContain('isProviderUnavailable');
    expect(screenSource).toContain('TALK_CONFIGURATION_REQUIRED_MESSAGE');
    expect(screenSource).toContain('disabled={isSendDisabled}');
    expect(screenSource).toContain('turnControls.microphoneIsPrimary');
    expect(screenSource).toContain('Your tutor is starting…');
    // The opening goes through the EXISTING session pathway (the session builds
    // the tutor turn itself; the screen never fabricates a learner turn for it).
    expect(screenSource).toContain('openConversation(');
    expect(screenSource).toContain('buildTutorOpeningMessage');
    expect(screenSource).toContain('allowsPersonalizedFeedback');
  });
});

describe('Talk — learner turn control rules', () => {
  it('5. an in-flight tutor opening blocks BOTH the typed send and the microphone', () => {
    const opening = resolveTalkTurnControls({
      voiceStatus: baseVoiceStatus(),
      inputText: 'I wanted to say something',
      isOpening: true,
      isSending: false,
      isSwitching: false,
      isPreparing: false,
    });

    expect(opening.sendDisabled).toBe(true);
    expect(opening.micDisabled).toBe(true);
    expect(opening.microphoneIsPrimary).toBe(false);
  });

  it('6. the typed fallback works normally once the opening has completed', () => {
    const ready = resolveTalkTurnControls({
      voiceStatus: baseVoiceStatus(),
      inputText: 'I typed this instead',
      isOpening: false,
      isSending: false,
      isSwitching: false,
      isPreparing: false,
    });

    expect(ready.sendDisabled).toBe(false);
    expect(ready.micDisabled).toBe(false);
    expect(ready.microphoneIsPrimary).toBe(true);

    // Empty composer still cannot send.
    const empty = resolveTalkTurnControls({
      voiceStatus: baseVoiceStatus(),
      inputText: '   ',
      isOpening: false,
      isSending: false,
      isSwitching: false,
      isPreparing: false,
    });
    expect(empty.sendDisabled).toBe(true);
  });

  it('7. recording blocks the composer, and tutor playback keeps barge-in available', () => {
    const recording = resolveTalkTurnControls({
      voiceStatus: baseVoiceStatus({
        state: 'recording',
        canRecord: false,
        canStopRecording: true,
        // The coordinator reports this while the microphone owns the turn.
        canSendText: false,
      }),
      inputText: 'text',
      isOpening: false,
      isSending: false,
      isSwitching: false,
      isPreparing: false,
    });
    expect(recording.micDisabled).toBe(false); // tap again to finish & send
    expect(recording.sendDisabled).toBe(true);

    const speaking = resolveTalkTurnControls({
      voiceStatus: baseVoiceStatus({ state: 'speaking', isSpeaking: true }),
      inputText: '',
      isOpening: false,
      isSending: false,
      isSwitching: false,
      isPreparing: false,
    });
    expect(speaking.micDisabled).toBe(false); // interrupt the tutor
    expect(speaking.microphoneIsPrimary).toBe(true);
  });

  it('8. while the session is switching or preparing, no learner turn can start', () => {
    for (const flags of [
      { isSwitching: true, isPreparing: false },
      { isSwitching: false, isPreparing: true },
    ]) {
      const controls = resolveTalkTurnControls({
        voiceStatus: baseVoiceStatus(),
        inputText: 'I want to speak',
        isOpening: false,
        isSending: false,
        ...flags,
      });
      expect(controls.sendDisabled).toBe(true);
      expect(controls.micDisabled).toBe(true);
    }

    // A coordinator-level switch is honoured even without the screen flag.
    const coordinatorSwitching = resolveTalkTurnControls({
      voiceStatus: baseVoiceStatus({ isSwitching: true, canRecord: false, canSendText: false }),
      inputText: 'text',
      isOpening: false,
      isSending: false,
      isSwitching: false,
      isPreparing: false,
    });
    expect(coordinatorSwitching.micDisabled).toBe(true);
    expect(coordinatorSwitching.sendDisabled).toBe(true);
  });
});
