/**
 * src/voice/mic-race.test.ts
 *
 * Regression tests for the session-transition / mic race (Package 1, A) at the
 * coordinator level:
 * - rapid repeated mic taps start AT MOST ONE recorder,
 * - no recorder starts while the session is switching (synchronous refusal),
 * - an active recorder is never opened against a session being replaced.
 */

import { describe, expect, it } from 'vitest';
import { createVoiceSessionCoordinator } from './coordinator';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { createTalkSession } from '../talk-demo';
import type { AudioRecorderService, AudioRecordingResult } from './types';

/** Recorder double whose start/stop calls are counted and slightly delayed. */
function createCountingRecorder(): AudioRecorderService & {
  startCalls: number;
  stopCalls: number;
} {
  let recording = false;
  const recorder = {
    startCalls: 0,
    stopCalls: 0,
    async requestPermissions(): Promise<boolean> {
      return true;
    },
    async hasPermissions(): Promise<boolean> {
      return true;
    },
    async startRecording(): Promise<void> {
      recorder.startCalls += 1;
      // The real microphone takes time to open: this is the window in which a
      // second tap used to slip past the state-machine guards.
      await new Promise((resolve) => setTimeout(resolve, 5));
      recording = true;
    },
    async stopRecording(): Promise<AudioRecordingResult> {
      recorder.stopCalls += 1;
      recording = false;
      return { uri: 'file:///mock/race.m4a', mimeType: 'audio/m4a', durationMs: 120 };
    },
    isRecording(): boolean {
      return recording;
    },
    getElapsedSeconds(): number {
      return 0;
    },
  };
  return recorder;
}

describe('VoiceSessionCoordinator — mic race protection', () => {
  it('rapid repeated start taps open at most ONE recorder', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const recorder = createCountingRecorder();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    // Two taps in the same tick — before the state machine visibly moved.
    const first = coordinator.startRecording();
    const second = coordinator.startRecording();
    const third = coordinator.startRecording();

    const results = await Promise.all([first, second, third]);
    expect(results).toEqual([true, false, false]);
    expect(recorder.startCalls).toBe(1);
    expect(coordinator.getStatus().state).toBe('recording');

    await coordinator.dispose();
  });

  it('refuses to start a recorder synchronously while the session is switching', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const { session: next } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const recorder = createCountingRecorder();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    const switching = coordinator.switchSession(next);
    expect(coordinator.getStatus().isSwitching).toBe(true);
    // A mic tap during the transition is refused by the synchronous guard.
    await expect(coordinator.startRecording()).resolves.toBe(false);
    expect(recorder.startCalls).toBe(0);

    const installed = await switching;
    expect(installed).toBe(next);
    // After the switch settled, the microphone opens normally again.
    await expect(coordinator.startRecording()).resolves.toBe(true);
    expect(recorder.startCalls).toBe(1);

    await coordinator.dispose();
  });

  it('a superseded switch installs nothing and the mic keeps working on the winner', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const { session: next1 } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const { session: next2 } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const recorder = createCountingRecorder();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    const first = coordinator.switchSession(next1);
    const second = coordinator.switchSession(next2);

    // The superseded switch reports that it installed nothing.
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBe(next2);

    // The recorder was never opened for either transition; the microphone
    // still starts exactly once against the surviving session.
    expect(recorder.startCalls).toBe(0);
    await expect(coordinator.startRecording()).resolves.toBe(true);
    expect(recorder.startCalls).toBe(1);

    await coordinator.dispose();
  });
});
