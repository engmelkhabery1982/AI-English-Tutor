/**
 * src/voice/tts-recovery.test.ts
 *
 * Regression tests for the recoverable TTS failure state (Package 1, C):
 * - TTS failure is AUDIO-ONLY: the committed tutor text always survives,
 * - a current-turn failure exposes the Replay state (and Replay re-speaks the
 *   SAME committed response without duplicating the tutor turn or evidence),
 * - repeated Replay taps never start overlapping playback,
 * - cancellations caused by intentional stops, session replacement or disposal
 *   are never misreported as a failure for an obsolete turn.
 */

import { describe, expect, it } from 'vitest';
import { createVoiceSessionCoordinator } from './coordinator';
import { createDemoAudioRecorder } from './recorder';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { countCommittedLearnerTurns } from '../conversation-session';
import { createTalkSession } from '../talk-demo';
import type { TextToSpeechProvider, TTSOptions } from '../providers/tts';

/** TTS double that throws on speak() — the observed live failure shape. */
function createFailingTTS(error = 'fetch failed: Fetch request has been canceled') {
  const calls: string[] = [];
  const tts = {
    id: 'failing-tts',
    calls,
    async speak(text: string): Promise<void> {
      calls.push(text);
      throw new Error(error);
    },
    async stop(): Promise<void> {},
    async isSpeaking(): Promise<boolean> {
      return false;
    },
  };
  return tts;
}

/** TTS double that fails the FIRST speak() and succeeds afterwards. */
function createFailOnceTTS() {
  const calls: string[] = [];
  const tts = {
    id: 'fail-once-tts',
    calls,
    failedOnce: false,
    async speak(text: string, options?: TTSOptions): Promise<void> {
      calls.push(text);
      if (!tts.failedOnce) {
        tts.failedOnce = true;
        options?.onError?.(new Error('fetch failed: Fetch request has been canceled'));
        return;
      }
      options?.onStart?.();
      options?.onDone?.();
    },
    async stop(): Promise<void> {},
    async isSpeaking(): Promise<boolean> {
      return false;
    },
  };
  return tts;
}

/**
 * TTS double whose playback stays pending until the test fires the gate, so
 * cancellation/replacement races can be staged deterministically.
 */
function createDeferredTTS() {
  const calls: string[] = [];
  const gates: Array<(outcome: 'done' | 'error') => void> = [];
  const tts = {
    id: 'deferred-tts',
    calls,
    stopCalls: 0,
    async speak(text: string, options?: TTSOptions): Promise<void> {
      calls.push(text);
      options?.onStart?.();
      await new Promise<void>((resolve) => {
        gates.push((outcome) => {
          if (outcome === 'done') options?.onDone?.();
          else options?.onError?.(new Error('Fetch request has been canceled'));
          resolve();
        });
      });
    },
    fireAll(outcome: 'done' | 'error'): void {
      while (gates.length > 0) gates.shift()?.(outcome);
    },
    async stop(): Promise<void> {
      tts.stopCalls += 1;
    },
    async isSpeaking(): Promise<boolean> {
      return gates.length > 0;
    },
  };
  return tts;
}

async function runSpokenTurn(
  coordinator: ReturnType<typeof createVoiceSessionCoordinator>,
): Promise<void> {
  await coordinator.startRecording();
  const result = await coordinator.stopRecordingAndProcess();
  expect(result.ok).toBe(true);
}

describe('TTS failure — audio-only, tutor text committed', () => {
  it('a current-turn TTS failure keeps the tutor text and exposes Replay', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createFailingTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Tell me about your day.' }),
      ttsProvider: tts as unknown as TextToSpeechProvider,
    });

    await coordinator.startRecording();
    const turn = await coordinator.stopRecordingAndProcess();

    // The TURN succeeded: the learner message and the tutor reply are committed.
    expect(turn.ok).toBe(true);
    const history = session.getHistory();
    expect(countCommittedLearnerTurns(session)).toBe(1);
    const tutorText = history.at(-1);
    expect(tutorText?.role).toBe('assistant');
    expect((tutorText?.content ?? '').trim().length).toBeGreaterThan(0);

    // …and ONLY the audio failed, recoverably.
    const status = coordinator.getStatus();
    expect(status.audioPlaybackFailed).toBe(true);
    expect(status.canReplayAudio).toBe(true);
    expect(status.state).toBe('idle');

    await coordinator.dispose();
  });

  it('an intentional stop cancels playback without a misleading failure', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createDeferredTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Tell me about your day.' }),
      ttsProvider: tts as unknown as TextToSpeechProvider,
    });

    await coordinator.startRecording();
    // Do not await playback: stop it mid-flight like the learner's Stop tap.
    const turn = coordinator.stopRecordingAndProcess();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.getStatus().state).toBe('speaking');
    await coordinator.stopSpeaking();
    // The provider's late cancellation callback arrives after the stop…
    tts.fireAll('error');
    await turn;

    // Tutor text is intact; the intentional cancellation is NOT a failure.
    expect(countCommittedLearnerTurns(session)).toBe(1);
    expect(session.getHistory().at(-1)?.role).toBe('assistant');
    expect(coordinator.getStatus().audioPlaybackFailed).toBe(false);
    expect(coordinator.getStatus().state).toBe('idle');

    await coordinator.dispose();
  });
});

describe('TTS recovery — Replay the committed response', () => {
  it('Replay re-speaks the SAME tutor turn without duplicating it', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createFailOnceTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Tell me about your day.' }),
      ttsProvider: tts as unknown as TextToSpeechProvider,
    });

    await runSpokenTurn(coordinator);
    expect(coordinator.getStatus().audioPlaybackFailed).toBe(true);
    const historyBefore = session.getHistory();
    const feedbackBefore = session.getLastFeedback();
    const tutorText = historyBefore.at(-1)?.content ?? '';

    await coordinator.replayLastResponse();

    // The SAME already-generated response was spoken again…
    expect(tts.calls.at(-1)).toBe(tutorText);
    // …nothing was regenerated, committed or duplicated.
    expect(session.getHistory()).toEqual(historyBefore);
    expect(countCommittedLearnerTurns(session)).toBe(1);
    expect(session.getLastFeedback()).toBe(feedbackBefore);
    // The failure state is cleared after a successful replay.
    expect(coordinator.getStatus().audioPlaybackFailed).toBe(false);
    expect(coordinator.getStatus().canReplayAudio).toBe(false);

    await coordinator.dispose();
  });

  it('a failed Replay keeps the tutor text and the failure visible', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createFailingTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Tell me about your day.' }),
      ttsProvider: tts as unknown as TextToSpeechProvider,
    });

    await runSpokenTurn(coordinator);
    const historyBefore = session.getHistory();

    await coordinator.replayLastResponse();

    // Still failed, still recoverable — and the tutor text never moved.
    expect(coordinator.getStatus().audioPlaybackFailed).toBe(true);
    expect(session.getHistory()).toEqual(historyBefore);
    expect(countCommittedLearnerTurns(session)).toBe(1);

    await coordinator.dispose();
  });

  it('repeated Replay taps never start overlapping playback', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createDeferredTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Tell me about your day.' }),
      ttsProvider: tts as unknown as TextToSpeechProvider,
    });

    // Seed one committed tutor turn without playing it back.
    const muted = coordinator;
    muted.setMuted(true);
    await runSpokenTurn(muted);
    muted.setMuted(false);
    const speakCallsAfterTurn = tts.calls.length;
    expect(speakCallsAfterTurn).toBe(0);

    // Rapid taps: the single-flight guard refuses every tap after the first.
    const first = coordinator.replayLastResponse();
    const second = coordinator.replayLastResponse();
    const third = coordinator.replayLastResponse();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.getStatus().state).toBe('speaking');
    // A tap WHILE playback is running is also refused.
    const duringPlayback = coordinator.replayLastResponse();
    tts.fireAll('done');
    await Promise.all([first, second, third, duringPlayback]);

    expect(tts.calls.length).toBe(speakCallsAfterTurn + 1);
    expect(coordinator.getStatus().state).toBe('idle');

    await coordinator.dispose();
  });
});

describe('TTS failure — stale callbacks and session replacement', () => {
  it('a session replacement while playback is pending shows no failure anywhere', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const { session: replacement } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createDeferredTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Tell me about your day.' }),
      ttsProvider: tts as unknown as TextToSpeechProvider,
    });

    await coordinator.startRecording();
    const turn = coordinator.stopRecordingAndProcess();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.getStatus().state).toBe('speaking');

    // The conversation is replaced while the old reply is still playing.
    await coordinator.switchSession(replacement);
    // The old playback's cancellation callback arrives late.
    tts.fireAll('error');
    await turn;

    // The obsolete turn's cancellation is NOT reported as a failure on the
    // replacement session, and nothing was written into it.
    const status = coordinator.getStatus();
    expect(status.audioPlaybackFailed).toBe(false);
    expect(status.canReplayAudio).toBe(false);
    expect(status.state).toBe('idle');
    expect(status.errorMessage).toBeNull();
    expect(replacement.getHistory()).toEqual([]);

    await coordinator.dispose();
  });

  it('disposal during playback settles quietly (no failure, no speaking state)', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createDeferredTTS();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Tell me about your day.' }),
      ttsProvider: tts as unknown as TextToSpeechProvider,
    });

    const speaking = coordinator.speakResponse('A tutor reply to interrupt.');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await coordinator.dispose();
    tts.fireAll('error');
    await speaking;

    const status = coordinator.getStatus();
    expect(status.audioPlaybackFailed).toBe(false);
    expect(status.isSpeaking).toBe(false);
    // Replay after disposal does nothing at all.
    await coordinator.replayLastResponse();
    expect(tts.calls).toEqual(['A tutor reply to interrupt.']);
  });
});
