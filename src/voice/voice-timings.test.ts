/**
 * src/voice/voice-timings.test.ts
 *
 * Regression tests for the latency work (Package 1, D + E):
 * - stopping the recorder begins BEFORE unrelated learner-context preparation
 *   completes, while provider submission still happens AFTER it (dependent
 *   stages are never parallelized),
 * - a valid voice turn still runs record → STT → provider → tutor response →
 *   TTS end to end,
 * - the internal timing instrumentation records the pipeline milestones in
 *   order, and stays silent/disabled outside development.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSessionCoordinator } from './coordinator';
import { createDemoAudioRecorder } from './recorder';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { createTalkSession } from '../talk-demo';
import {
  getVoiceTimingLog,
  markVoiceTiming,
  resetVoiceTimings,
  setVoiceTimingsEnabled,
} from './timings';
import type { SpeechToTextProvider, STTResult } from '../providers/stt';

function createStubSTT(transcript = 'I practice English every day.'): SpeechToTextProvider {
  return {
    id: 'stub-stt',
    async transcribe(): Promise<STTResult> {
      return { ok: true, transcript };
    },
  };
}

describe('voice timings — instrumentation', () => {
  afterEach(() => {
    setVoiceTimingsEnabled(null);
    resetVoiceTimings();
  });

  it('is disabled by default outside development (no entries, no output)', () => {
    setVoiceTimingsEnabled(null);
    resetVoiceTimings();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    markVoiceTiming('mic_tap');
    expect(getVoiceTimingLog()).toEqual([]);
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('records milestones with deltas while enabled', () => {
    setVoiceTimingsEnabled(true);
    resetVoiceTimings();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    markVoiceTiming('mic_tap');
    markVoiceTiming('recorder_start_requested');
    markVoiceTiming('recorder_active');
    const log = getVoiceTimingLog();
    expect(log.map((entry) => entry.event)).toEqual([
      'mic_tap',
      'recorder_start_requested',
      'recorder_active',
    ]);
    expect(log[0]?.deltaMs).toBe(0);
    expect(log[1]?.deltaMs).toBeGreaterThanOrEqual(0);
    // Timestamps and event names only — never transcript or audio content.
    for (const entry of log) {
      expect(Object.keys(entry).sort()).toEqual(['at', 'deltaMs', 'event']);
    }
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('marks the full voice pipeline in order', async () => {
    setVoiceTimingsEnabled(true);
    resetVoiceTimings();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const tts = createDemoTTSProvider();
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createStubSTT(),
      ttsProvider: tts,
    });

    await coordinator.startRecording();
    const streamed: string[] = [];
    const result = await coordinator.stopRecordingAndProcess((chunk) => streamed.push(chunk));
    expect(result.ok).toBe(true);

    const events = getVoiceTimingLog().map((entry) => entry.event);
    const order = [
      'recorder_start_requested',
      'recorder_active',
      'stop_requested',
      'recorder_stopped',
      'stt_started',
      'stt_completed',
      'provider_request_started',
      'tutor_response_completed',
      'tts_requested',
    ] as const;
    let cursor = -1;
    for (const event of order) {
      const at = events.indexOf(event, cursor + 1);
      expect(at, `expected ${event} in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(events).toContain('first_tutor_chunk');
    expect(events.indexOf('first_tutor_chunk')).toBeGreaterThan(
      events.indexOf('provider_request_started'),
    );
    expect(tts.getSpokenTexts().length).toBe(1);

    debugSpy.mockRestore();
    await coordinator.dispose();
  });
});

describe('latency — recorder stop is never delayed by learner-context preparation', () => {
  beforeEach(() => {
    setVoiceTimingsEnabled(false);
  });
  afterEach(() => {
    setVoiceTimingsEnabled(null);
  });

  it('stops the recorder before the pre-submit preparation completes, and submits only after it', async () => {
    const events: string[] = [];
    let releaseContext: () => void = () => {};
    const contextGate = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });

    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const realSend = session.send.bind(session);
    vi.spyOn(session, 'send').mockImplementation((...args) => {
      events.push('session.send');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return realSend(...(args as [any, any?]));
    });

    const recorder = createDemoAudioRecorder();
    vi.spyOn(recorder, 'stopRecording').mockImplementation(async () => {
      events.push('recorder_stopped');
      return { uri: 'file:///mock/latency.m4a', mimeType: 'audio/m4a', durationMs: 200 };
    });

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: {
        id: 'ordering-stt',
        async transcribe(): Promise<STTResult> {
          events.push('stt');
          return { ok: true, transcript: 'I practice English every day.' };
        },
      },
      ttsProvider: createDemoTTSProvider(),
    });

    await coordinator.startRecording();
    const turn = coordinator.stopRecordingAndProcess(undefined, {
      beforeSubmit: async () => {
        events.push('context_started');
        await contextGate; // slow learner-context preparation
        events.push('context_done');
      },
    });

    // The recorder stop and STT do NOT wait for the pending preparation…
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['recorder_stopped', 'stt', 'context_started']);
    // …and nothing is submitted before the preparation finished.
    expect(events).not.toContain('session.send');

    releaseContext();
    const result = await turn;

    // Dependent order preserved: preparation → submission → committed turn.
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      'recorder_stopped',
      'stt',
      'context_started',
      'context_done',
      'session.send',
    ]);
    expect(session.getHistory().filter((turnEntry) => turnEntry.role === 'user')).toHaveLength(1);

    await coordinator.dispose();
  });

  it('a failing pre-submit preparation never fails the turn', async () => {
    const { session } = createTalkSession({ mode: 'coach' }, { isDemo: true });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createStubSTT(),
      ttsProvider: createDemoTTSProvider(),
    });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess(undefined, {
      beforeSubmit: async () => {
        throw new Error('learner context refresh failed');
      },
    });

    expect(result.ok).toBe(true);
    expect(session.getHistory().filter((turn) => turn.role === 'user')).toHaveLength(1);

    await coordinator.dispose();
  });
});
