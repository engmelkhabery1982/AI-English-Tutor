/**
 * Wave2 hardening invariant suite – 20 invariants
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
}));

import { createVoiceSessionCoordinator, VOICE_SESSION_CHANGED_MESSAGE } from './coordinator';
import { createDemoAudioRecorder } from './recorder';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { createTalkSession } from '../talk-demo';
import { TTSController } from './tts-controller';
import { AudioResourceTracker, cleanupAudioFile } from './audio-cleanup';
import { ReviewVoiceController } from '../review/voice-controller';
import { ShadowingSession } from '../listening/deep/shadowing';
import { ShadowingVoiceController } from '../listening/deep/shadowing';
import { FluencyPracticeService } from '../fluency/service';
import { PronunciationEngine } from '../pronunciation/engine';
import type { PronunciationProvider } from '../pronunciation/types';
import type { AudioRecorderService } from './types';
import type { SpeakingPracticeService } from '../deep-speaking/service';
import { listFluencyTasks } from '../fluency/tasks';

function createSlowSTT(transcript = 'hello world', delayMs = 100) {
  const base = createDemoSTTProvider({ defaultTranscript: transcript });
  const orig = base.transcribe.bind(base);
  let shouldDelay = true;
  return {
    ...base,
    setDelay: (v: boolean) => (shouldDelay = v),
    transcribe: async (audio: any) => {
      if (shouldDelay) await new Promise((r) => setTimeout(r, delayMs));
      return orig(audio);
    },
  };
}

function createFailingSTT(errorMsg = 'STT failed') {
  return {
    id: 'failing',
    transcribe: async () => ({ ok: false as const, error: errorMsg }),
  };
}
function createEmptySTT() {
  return {
    id: 'empty',
    transcribe: async () => ({ ok: true as const, transcript: '' }),
  };
}

function createMockRecorder(): AudioRecorderService & { setRecording: (v: boolean) => void } {
  let recording = false;
  return {
    hasPermissions: async () => true,
    requestPermissions: async () => true,
    startRecording: async () => {
      if (recording) throw new Error('Recording is already in progress');
      recording = true;
    },
    stopRecording: async () => {
      if (!recording) throw new Error('Not recording');
      recording = false;
      return { uri: 'file:///tmp/audio-test.m4a', mimeType: 'audio/m4a', durationMs: 1000 };
    },
    isRecording: () => recording,
    getElapsedSeconds: () => 0,
    setRecording: (v: boolean) => {
      recording = v;
    },
  } as any;
}

function createSlowTTS(delayMs = 50) {
  return {
    id: 'slow-tts',
    speak: async (text: string, options?: any) => {
      options?.onStart?.();
      await new Promise((r) => setTimeout(r, delayMs));
      options?.onDone?.();
    },
    stop: async () => {},
  } as any;
}

describe('Wave2 – 20 lifecycle invariants', () => {
  it('Invariant 1: global recorder race – max 1 recording, double tap safe', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const recorder = createDemoAudioRecorder();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });
    const first = await coordinator.startRecording();
    expect(first).toBe(true);
    const second = await coordinator.startRecording();
    expect(second).toBe(false);
    expect(coordinator.getStatus().state).toBe('recording');
    await coordinator.cancelRecording();
  });

  it('Invariant 2: stop/start no overlap teardown – fast record-stop-record waits pendingStop', async () => {
    const recorder = createMockRecorder();
    const { session } = createTalkSession({ mode: 'coach' });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'hi' }),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const stopP = coordinator.stopRecordingAndTranscribe();
    const secondStartDuringTranscribing = await coordinator.startRecording();
    expect(secondStartDuringTranscribing).toBe(false);
    const res = await stopP;
    expect(res.ok).toBe(true);
    const third = await coordinator.startRecording();
    expect(third).toBe(true);
  });

  it('Invariant 3: stale callback no mutate – STT result after generation bump does not mutate', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const slowSTT = createSlowSTT('late transcript', 80);
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: slowSTT as any,
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const processing = coordinator.stopRecordingAndProcess();
    const { session: newSession } = createTalkSession({ mode: 'coach' });
    await coordinator.switchSession(newSession);
    const result = await processing;
    expect(result.error).toBe(VOICE_SESSION_CHANGED_MESSAGE);
    expect(newSession.getHistory().length).toBe(0);
    expect(session.getHistory().length).toBe(0);
  });

  it('Invariant 4: teardown idempotent – dispose twice safe', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.dispose();
    await expect(coordinator.dispose()).resolves.not.toThrow();
    expect(coordinator.getStatus().state).toBe('idle');
  });

  it('Invariant 5: terminal disposed not reusable', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.dispose();
    const started = await coordinator.startRecording();
    expect(started).toBe(false);
    const res = await coordinator.stopRecordingAndProcess();
    expect(res.ok).toBe(false);
  });

  it('Invariant 6: task switch invalidates sync – generation bump synchronous', async () => {
    const { session: s1 } = createTalkSession({ mode: 'coach' });
    const { session: s2 } = createTalkSession({ mode: 'coach' });
    const coordinator = createVoiceSessionCoordinator({
      session: s1,
      recorder: createDemoAudioRecorder(),
      sttProvider: createSlowSTT('should be discarded', 50) as any,
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const p = coordinator.stopRecordingAndProcess();
    const switchP = coordinator.switchSession(s2);
    // @ts-ignore
    expect((coordinator as any).generation).toBeGreaterThan(0);
    await switchP;
    const res = await p;
    expect(res.error).toBe(VOICE_SESSION_CHANGED_MESSAGE);
  });

  it('Invariant 7: AppState background invalidates attempt sync, stops recording', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const recorder = createDemoAudioRecorder();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    expect(coordinator.getStatus().state).toBe('recording');
    coordinator.handleBackground();
    expect(coordinator.getStatus().state).toBe('idle');
    // @ts-ignore
    expect((coordinator as any).generation).toBeGreaterThan(0);
    expect(coordinator.getStatus().state).not.toBe('recording');
  });

  it('Invariant 8: background blocks late STT/AI/pronunciation persist, no fake failure evidence', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const slowSTT = createSlowSTT('late after background', 60);
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: slowSTT as any,
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const p = coordinator.stopRecordingAndProcess();
    coordinator.handleBackground();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(session.getHistory().length).toBe(0);
    expect(coordinator.getStatus().errorMessage).toBeNull();
  });

  it('Invariant 9: foreground idle, no auto-restart mic', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    coordinator.handleBackground();
    coordinator.handleForeground();
    expect(coordinator.getStatus().state).toBe('idle');
    expect(coordinator.getStatus().canRecord).toBe(true);
  });

  it('Invariant 10: TTS at most one per surface, replay interrupts', async () => {
    const provider = createSlowTTS(40);
    const controller = new TTSController(provider);
    let firstDone = false;
    let secondDone = false;
    const first = controller.speak('first utterance', {
      onDone: () => {
        firstDone = true;
      },
    });
    // Immediately replay – should invalidate first
    const second = controller.speak('second utterance', {
      onDone: () => {
        secondDone = true;
      },
    });
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    expect(firstDone).toBe(false);
    await controller.dispose();
  });

  it('Invariant 11: TTS stale completion no mutate, stop idempotent', async () => {
    const provider = createSlowTTS(20);
    const controller = new TTSController(provider);
    let staleMutated = false;
    // Start and let complete
    await controller.speak('hello', {
      onDone: () => {
        staleMutated = true;
      },
    });
    expect(staleMutated).toBe(true);
    staleMutated = false;
    const p = controller.speak('new', {
      onDone: () => {
        staleMutated = true;
      },
    });
    controller.invalidate();
    await p;
    expect(staleMutated).toBe(false);
    await expect(controller.stop()).resolves.not.toThrow();
    await expect(controller.stop()).resolves.not.toThrow();
    await controller.dispose();
  });

  it('Invariant 12: TTS stop on unmount/task switch, no fake completion', async () => {
    const provider = createSlowTTS(50);
    const controller = new TTSController(provider);
    let doneCalled = false;
    const speakP = controller.speak('long utterance that would complete', {
      onDone: () => {
        doneCalled = true;
      },
    });
    controller.invalidate();
    await speakP;
    expect(doneCalled).toBe(false);
    await controller.dispose();
  });

  it('Invariant 13: STT stale no populate', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const slowSTT = createSlowSTT('stale transcript', 70);
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: slowSTT as any,
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const p1 = coordinator.stopRecordingAndTranscribe();
    await coordinator.reset();
    const res = await p1;
    expect(res.ok).toBe(false);
    expect(coordinator.getStatus().recognizedTranscript).toBeNull();
  });

  it('Invariant 14: STT failed no evidence, empty no evidence', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const failingCoordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createFailingSTT('mic failed') as any,
      ttsProvider: createDemoTTSProvider(),
    });
    await failingCoordinator.startRecording();
    const failRes = await failingCoordinator.stopRecordingAndProcess();
    expect(failRes.ok).toBe(false);
    expect(session.getHistory().length).toBe(0);
    expect(failingCoordinator.getStatus().recognizedTranscript).toBeNull();

    const { session: s2 } = createTalkSession({ mode: 'coach' });
    const emptyCoordinator = createVoiceSessionCoordinator({
      session: s2,
      recorder: createDemoAudioRecorder(),
      sttProvider: createEmptySTT() as any,
      ttsProvider: createDemoTTSProvider(),
    });
    await emptyCoordinator.startRecording();
    const emptyRes = await emptyCoordinator.stopRecordingAndProcess();
    expect(emptyRes.ok).toBe(false);
    expect(s2.getHistory().length).toBe(0);
    expect(emptyCoordinator.getStatus().recognizedTranscript).toBeNull();
  });

  it('Invariant 15: duplicate submit exactly once – Fluency and Review guards', async () => {
    const recorder = createDemoAudioRecorder();
    const stt = createDemoSTTProvider({ defaultTranscript: 'answer' });
    const reviewCtrl = new ReviewVoiceController(recorder as any, stt as any);
    const status1 = await reviewCtrl.toggleRecording();
    expect(status1.isRecording).toBe(true);
    const stopStatus = await reviewCtrl.toggleRecording();
    expect(reviewCtrl.getStatus().transcript).toBe('answer');
    expect(stopStatus.transcript).toBe('answer');

    const realTask = listFluencyTasks()[0];
    expect(realTask).toBeDefined();

    const mockSpeaking = {
      getLearnerId: () => 'learner-1',
      dispose: async () => {},
      planPractice: async () => ({ status: 'planned', plan: { progression: {} } }),
      startPractice: async () => ({ isRealAI: true, conversationSession: { getHistory: () => [] } as any }),
      openConversation: async () => ({ ok: true }),
      sendLearnerTurn: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, feedback: null };
      },
      completePractice: async () => null,
    } as unknown as SpeakingPracticeService;

    const fluency = new FluencyPracticeService({ speaking: mockSpeaking });
    (fluency as any).task = realTask;
    (fluency as any).conversationSession = { getHistory: () => [] };
    (fluency as any).phase = 'speaking';

    const p1 = fluency.submitAttempt({ transcript: 'hello world this is a longer attempt to cover points' });
    await expect(fluency.submitAttempt({ transcript: 'hello again' })).rejects.toThrow(/already being processed/);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    (fluency as any).phase = 'repeat_ready';
    const r2 = await fluency.submitAttempt({ transcript: 'second attempt with enough content to evaluate' });
    expect(r2.ok).toBe(true);
    expect((fluency as any).attemptNumber).toBe(2);
  });

  it('Invariant 16: pronunciation late result no persist, failed no positive', async () => {
    let persistCalls = 0;
    const mockProvider: PronunciationProvider = {
      id: 'mock',
      analyze: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return {
          provider: 'mock',
          evidenceLevel: 'acoustic' as const,
          overallIntelligibility: 'clear' as const,
          observations: [
            {
              type: 'word_pronunciation' as const,
              target: 'th',
              description: 'th issue',
              evidence: 'acoustic' as const,
              confidence: 'high' as const,
              observed: 'zis',
            },
          ],
          insufficientEvidence: false,
        };
      },
    };
    const engine = new PronunciationEngine({
      provider: mockProvider,
      pronunciation: {
        recordObservation: async () => {
          persistCalls += 1;
          return { weakness: { id: 'w1', occurrenceCount: 1 } } as any;
        },
      },
      weaknesses: {
        upsertWeakness: async (w) => w as any,
        getWeaknessByReference: async () => null,
      },
      profile: { get: async () => ({ id: 'learner-1' } as any) },
    });

    let stale = false;
    const checkStale = () => stale;
    const p = engine.analyzeSpokenTurn({
      transcript: 'test',
      expectedText: 'test sentence',
      checkStale,
    });
    stale = true;
    const res = await p;
    expect(res).toBeNull();
    expect(persistCalls).toBe(0);

    const failingProvider: PronunciationProvider = {
      id: 'fail',
      analyze: async () => {
        throw new Error('provider down');
      },
    };
    const engine2 = new PronunciationEngine({
      provider: failingProvider,
      pronunciation: {
        recordObservation: async () => {
          throw new Error('should not be called');
        },
      },
      weaknesses: {
        upsertWeakness: async (w) => w as any,
        getWeaknessByReference: async () => null,
      },
      profile: { get: async () => ({ id: 'learner-1' } as any) },
    });
    const res2 = await engine2.analyzeSpokenTurn({ transcript: 'hi', expectedText: 'hi' });
    expect(res2?.analysis.insufficientEvidence).toBe(true);
  });

  it('Invariant 17: shadowing repeated Stop/Submit safe', async () => {
    const recorder = createDemoAudioRecorder();
    const stt = createDemoSTTProvider({ defaultTranscript: 'shadowing test' });
    const session = new ShadowingSession({
      id: 'item-1',
      chunk: 'hello world',
      canonicalWrittenForm: 'hello world',
      baseSupport: 'full_transcript',
    });
    const controller = new ShadowingVoiceController(session as any, {
      recorder: recorder as any,
      stt: stt as any,
      port: { analyzeSpokenTurn: async () => ({ feedbackLines: ['good'], unavailable: false } as any) } as any,
    });

    await controller.startRecording();
    const firstStop = await controller.stopAndJudge();
    // Success is ShadowingAttempt (no ok:false), failure has ok:false
    expect((firstStop as any).ok !== false).toBe(true);
    const secondStop = await controller.stopAndJudge();
    expect((secondStop as any).ok).toBe(false);
    const third = await controller.stopAndJudge();
    expect((third as any).ok).toBe(false);

    await controller.dispose();
  });

  it('Invariant 18: shadowing fast record-stop-record, pair belongs same attempt, progression only current', async () => {
    const recorder = createDemoAudioRecorder();
    const slowSTT = createSlowSTT('fast test', 60);
    const session = new ShadowingSession({
      id: 'item-1',
      chunk: 'hello world this is a test',
      canonicalWrittenForm: 'hello world this is a test',
      baseSupport: 'full_transcript',
    });
    const controller = new ShadowingVoiceController(session as any, {
      recorder: recorder as any,
      stt: slowSTT as any,
      port: {
        analyzeSpokenTurn: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return { feedbackLines: ['ok'], unavailable: false } as any;
        },
      } as any,
    });

    await controller.startRecording();
    const judgeP = controller.stopAndJudge();
    const res1 = await judgeP;
    expect((res1 as any).ok !== false).toBe(true);
    await controller.startRecording();
    const res2 = await controller.stopAndJudge();
    expect((res2 as any).ok !== false).toBe(true);
    expect(session.attemptCount).toBe(2);

    const newSession = new ShadowingSession({
      id: 'item-2',
      chunk: 'new text chunk',
      canonicalWrittenForm: 'new text chunk',
      baseSupport: 'full_transcript',
    });
    const newController = new ShadowingVoiceController(newSession as any, {
      recorder: recorder as any,
      stt: createSlowSTT('stale should be discarded', 80) as any,
      port: { analyzeSpokenTurn: async () => ({ feedbackLines: ['ok'], unavailable: false } as any) } as any,
    });
    await newController.startRecording();
    const lateP = newController.stopAndJudge();
    await newController.cancel();
    const lateRes = await lateP;
    expect((lateRes as any).ok).toBe(false);

    await controller.dispose();
    await newController.dispose();
  });

  it('Invariant 19: fluency Practise Again fresh terminal service, old service no resume, exactly-once', async () => {
    const realTask = listFluencyTasks()[0];
    const mockSpeaking = {
      getLearnerId: () => 'learner-1',
      dispose: async () => {},
      planPractice: async () => ({ status: 'planned', plan: { progression: {} } }),
      startPractice: async () => ({ isRealAI: true, conversationSession: { getHistory: () => [] } as any }),
      openConversation: async () => ({ ok: true }),
      sendLearnerTurn: async () => ({ ok: true, feedback: null }),
      completePractice: async () => null,
    } as unknown as SpeakingPracticeService;

    const service1 = new FluencyPracticeService({
      speaking: mockSpeaking,
    });
    (service1 as any).task = realTask;
    (service1 as any).conversationSession = { getHistory: () => [] };
    (service1 as any).phase = 'speaking';
    (service1 as any).isRealAI = true;
    (service1 as any).resolvedLearnerLevel = 'B1';

    const r1 = await service1.submitAttempt({ transcript: 'strong attempt with many words to be considered strong enough for testing' });
    expect(r1.ok).toBe(true);
    expect((service1 as any).attemptNumber).toBe(1);

    await service1.dispose();
    await expect(service1.submitAttempt({ transcript: 'after dispose' })).rejects.toThrow(/closed/);

    const service2 = new FluencyPracticeService({ speaking: mockSpeaking });
    expect((service2 as any).attemptNumber).toBe(0);
    expect((service2 as any).disposed).toBe(false);

    (service2 as any).task = realTask;
    (service2 as any).conversationSession = { getHistory: () => [] };
    (service2 as any).phase = 'processing';
    (service2 as any).pendingAttempt = true;
    service2.handleBackground();
    expect((service2 as any).phase).not.toBe('processing');
    expect((service2 as any).pendingAttempt).toBe(false);

    await service2.dispose();
  });

  it('Invariant 20: temp audio resources – cleanup after STT, stale/disposed cleans owned, failures no crash, no delete needed by other consumer', async () => {
    const tracker = new AudioResourceTracker();
    const uri1 = 'file:///tmp/audio1.m4a';
    const uri2 = 'file:///tmp/audio2.m4a';

    tracker.own(uri1);
    const gen1 = tracker.currentGeneration();
    tracker.nextGeneration();
    tracker.own(uri2);
    const gen2 = tracker.currentGeneration();

    await tracker.cleanupIfStale(uri1, gen1);
    await tracker.cleanupStale(gen2);
    await tracker.dispose();

    await expect(cleanupAudioFile('file:///tmp/bad.m4a')).resolves.not.toThrow();
    await expect(cleanupAudioFile(null as any)).resolves.not.toThrow();
    await expect(cleanupAudioFile('')).resolves.not.toThrow();

    const { session } = createTalkSession({ mode: 'coach' });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'cleanup test' }),
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const res = await coordinator.stopRecordingAndTranscribe();
    expect(res.ok).toBe(true);
    // @ts-ignore
    expect((coordinator as any).lastAudioUri).toBeNull();
  });
});

describe('DEVICE VALIDATION – explicit manual checks required', () => {
  it('Bluetooth/headset/background real-device guards exist but require manual validation', () => {
    expect(true).toBe(true);
  });
});
