/**
 * src/onboarding/evidence-integrity.test.ts
 *
 * Runtime test for the onboarding provenance guarantee:
 *
 *   Demo (offline) speech recognition returns a SCRIPTED transcript, so it can
 *   never create trusted pronunciation evidence — no fabricated strength, no
 *   fabricated weakness, no level influence. The diagnostic UX is preserved:
 *   the step is honestly marked unavailable (an OPTIONAL step), the learner is
 *   told why, and the level-acceptance semantics are untouched.
 *
 * The test drives the REAL composition: the production voice coordinator with
 * the demo providers (exactly the offline path a device without a configured
 * key runs), the real diagnostic state machine, and a real SqlJsAdapter.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLitePronunciationRepository,
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import { createConversationSession } from '../conversation-session';
import {
  createTalkLearnerModel,
  createTalkVoiceCoordinator,
  type TalkProviderInfo,
} from '../talk-demo';
import { createDemoAudioRecorder } from '../voice/recorder';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { createDemoSTTProvider } from '../providers/stt';
import type { AIProvider } from '../providers/ai';
import { createOnboardingService, type OnboardingServiceDeps } from './service';

const NOW = '2026-09-16T12:00:00.000Z';
const CANNED_TRANSCRIPT = 'I usually walk to work.';

const DEMO_PROVIDER_INFO: TalkProviderInfo = {
  kind: 'demo',
  label: 'Offline demo • Not real AI',
  isRealAI: false,
  allowsPersonalizedFeedback: false,
};

const REAL_PROVIDER_INFO: TalkProviderInfo = {
  kind: 'gemini',
  label: 'Gemini • Real AI tutor',
  isRealAI: true,
  allowsPersonalizedFeedback: true,
};

const stubProvider: AIProvider = {
  id: 'onboarding-integrity-ai',
  async generate() {
    return { ok: true, response: { content: 'Go on.' } };
  },
};

describe('Onboarding — demo speech never becomes pronunciation evidence', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profile = await new SQLiteUserProfileRepository(adapter).update({
      displayName: 'Integrity Learner',
      currentLevel: 'unknown',
      targetLevel: 'B1',
      learningGoals: ['Meetings'],
      preferredModes: ['coach'],
    });
    learnerId = profile.id;
  });

  type PronunciationPort = NonNullable<OnboardingServiceDeps['pronunciation']>;
  type PronunciationOutcome = Awaited<ReturnType<PronunciationPort['analyzeSpokenTurn']>>;

  function composeService(input: { providerKind: 'demo' | 'gemini'; outcome: PronunciationOutcome }) {
    const learnerModel = createTalkLearnerModel(adapter)!;
    const engine = createConversationEngine(learnerModel);
    const session = createConversationSession(createConversationOrchestrator(engine, stubProvider), {
      mode: 'coach',
    });
    const providerInfo = input.providerKind === 'demo' ? DEMO_PROVIDER_INFO : REAL_PROVIDER_INFO;

    const calls: string[] = [];
    const pronunciation: PronunciationPort = {
      analyzeSpokenTurn: vi.fn(async (args) => {
        calls.push(args.transcript);
        return input.outcome;
      }),
    };

    const service = createOnboardingService({
      adapter,
      learnerModel,
      profileRepository: new SQLiteUserProfileRepository(adapter),
      pronunciation,
      createSpeakingBundle: () => ({
        session,
        providerKind: input.providerKind,
        providerInfo,
      }),
      now: () => NOW,
    });

    return { service, pronunciation, calls };
  }

  async function advanceToPronunciation(service: ReturnType<typeof composeService>['service']) {
    const handle = await service.beginDiagnostic();
    handle.session.markProfileStepDone(handle.session.getCurrentStepToken());
    handle.session.advance();
    handle.session.advance();
    handle.session.advance();
    handle.session.advance();
    expect(handle.session.getCurrentStepId()).toBe('pronunciation');
    return handle;
  }

  it('10. a demo-STT transcript can never create trusted pronunciation evidence', async () => {
    // The REAL production voice path for an offline device: providerKind 'demo'
    // makes the coordinator use the demo STT provider.
    const { service, pronunciation, calls } = composeService({
      providerKind: 'demo',
      outcome: {
        analysis: {
          learnerId,
          observations: [],
          weakPoints: [],
          strengths: [],
          analyzedAt: NOW,
        },
        feedbackLines: ['The final consonant was clear.'],
        unavailable: false,
      } as unknown as PronunciationOutcome,
    });

    const handle = await advanceToPronunciation(service);

    // Drive the REAL coordinator: the offline path really does produce a
    // scripted transcript from the learner's recording.
    const coordinator = createTalkVoiceCoordinator({
      session: handle.conversation,
      providerKind: 'demo',
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: CANNED_TRANSCRIPT }),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const captured = await coordinator.stopRecordingAndTranscribe();
    expect(captured.ok).toBe(true);
    expect(captured.transcript).toBe(CANNED_TRANSCRIPT);

    // Feeding that scripted transcript back through the voice path is refused.
    const outcome = await service.recordPronunciation(
      handle,
      captured.transcript!,
      handle.pronunciationTask.sentence,
      { transcriptFromVoice: true },
    );

    expect(outcome.observed).toBe(false);
    expect(pronunciation.analyzeSpokenTurn).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    const snapshot = handle.session.snapshot();
    expect(snapshot.evidence.pronunciation).toBeNull();
    const pronunciationStep = snapshot.steps.find((step) => step.id === 'pronunciation');
    expect(pronunciationStep?.status).toBe('unavailable');

    // Nothing was persisted as pronunciation evidence either.
    expect(await new SQLitePronunciationRepository(adapter).listWeaknesses(learnerId)).toEqual([]);
    expect(await new SQLiteWeaknessRepository(adapter).listWeaknesses(learnerId)).toEqual([]);
  });

  it('10b. the SAME transcript is analysed when it came from REAL recognition', async () => {
    const { service, pronunciation } = composeService({
      providerKind: 'gemini',
      outcome: {
        analysis: {
          learnerId,
          observations: [],
          weakPoints: [],
          strengths: [],
          analyzedAt: NOW,
        },
        feedbackLines: ['The final consonant was clear.'],
        unavailable: false,
      } as unknown as PronunciationOutcome,
    });

    const handle = await advanceToPronunciation(service);

    const outcome = await service.recordPronunciation(
      handle,
      CANNED_TRANSCRIPT,
      handle.pronunciationTask.sentence,
      { transcriptFromVoice: true },
    );

    expect(outcome.observed).toBe(true);
    expect(pronunciation.analyzeSpokenTurn).toHaveBeenCalledTimes(1);
    expect(handle.session.snapshot().evidence.pronunciation?.observed).toBe(true);
  });
});
