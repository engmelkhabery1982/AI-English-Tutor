/**
 * src/voice/coordinator.test.ts
 *
 * Comprehensive tests for VoiceSessionCoordinator verifying:
 * - End-to-end voice flow (Record -> STT -> Session -> TTS)
 * - State machine transitions
 * - Session history non-corruption on errors
 * - Muting and replay
 * - Streaming chunk delivery
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createVoiceSessionCoordinator } from './coordinator';
import { createDemoAudioRecorder } from './recorder';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { createTalkSession } from '../talk-demo';

describe('VoiceSessionCoordinator', () => {
  const originalEnv = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = originalEnv;
    } else {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('completes full Voice Conversation MVP loop: Record -> STT -> Session -> TTS', async () => {
    const { session } = createTalkSession({ mode: 'coach' });
    const recorder = createDemoAudioRecorder();
    const stt = createDemoSTTProvider({
      defaultTranscript: 'I would like to improve my English fluency.',
    });
    const tts = createDemoTTSProvider();

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: stt,
      ttsProvider: tts,
    });

    const statusHistory: string[] = [];
    coordinator.subscribe((status) => {
      statusHistory.push(status.state);
    });

    // 1. User taps mic to start recording
    const startResult = await coordinator.startRecording();
    expect(startResult).toBe(true);
    expect(coordinator.getStatus().state).toBe('recording');
    expect(recorder.isRecording()).toBe(true);

    // 2. User taps mic again to finish recording and process
    const streamedChunks: string[] = [];
    const processResult = await coordinator.stopRecordingAndProcess((chunk) => {
      streamedChunks.push(chunk);
    });

    expect(processResult.ok).toBe(true);
    expect(processResult.transcript).toBe('I would like to improve my English fluency.');
    expect(coordinator.getStatus().recognizedTranscript).toBe(
      'I would like to improve my English fluency.'
    );

    // 3. Verify conversation session has the new turn
    const history = session.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('I would like to improve my English fluency.');
    expect(history[1].role).toBe('assistant');

    // 4. Verify streaming callback received chunks
    expect(streamedChunks.length).toBeGreaterThan(0);

    // 5. Verify TTS spoke the assistant response
    const spokenList = tts.getSpokenTexts();
    expect(spokenList.length).toBe(1);
    expect(spokenList[0].length).toBeGreaterThan(0);

    // 6. Verify state transitions
    expect(statusHistory).toContain('recording');
    expect(statusHistory).toContain('transcribing');
    expect(statusHistory).toContain('sending');
  });

  it('handles permission denied gracefully without corrupting session history', async () => {
    const { session } = createTalkSession({ mode: 'natural' });
    const recorder = createDemoAudioRecorder();
    recorder.setPermission(false);

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    const started = await coordinator.startRecording();
    expect(started).toBe(false);
    expect(coordinator.getStatus().state).toBe('error');
    expect(coordinator.getStatus().errorMessage).toContain('Microphone permission is required');

    // Conversation history must remain empty and intact
    expect(session.getHistory().length).toBe(0);
  });

  it('handles STT error gracefully without corrupting session history', async () => {
    const { session } = createTalkSession({ mode: 'natural' });
    const recorder = createDemoAudioRecorder();
    const stt = createDemoSTTProvider();
    stt.setMockFailure(true, 'Audio was not clear');

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: stt,
      ttsProvider: createDemoTTSProvider(),
    });

    await coordinator.startRecording();
    const result = await coordinator.stopRecordingAndProcess();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Audio was not clear');
    expect(coordinator.getStatus().state).toBe('error');

    // History must NOT be touched
    expect(session.getHistory().length).toBe(0);
  });

  it('respects mute setting and suppresses TTS speech', async () => {
    const { session } = createTalkSession({ mode: 'natural' });
    const recorder = createDemoAudioRecorder();
    const stt = createDemoSTTProvider({ defaultTranscript: 'Hello there' });
    const tts = createDemoTTSProvider();

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder,
      sttProvider: stt,
      ttsProvider: tts,
      isMuted: true,
    });

    expect(coordinator.getStatus().isMuted).toBe(true);

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();

    // Session has 2 turns
    expect(session.getHistory().length).toBe(2);

    // TTS was suppressed because isMuted = true
    expect(tts.getSpokenTexts().length).toBe(0);

    // Toggle mute and replay
    coordinator.toggleMute();
    expect(coordinator.getStatus().isMuted).toBe(false);

    await coordinator.replayLastResponse();
    expect(tts.getSpokenTexts().length).toBe(1);
  });

  it('allows stopping active speech playback', async () => {
    const { session } = createTalkSession({ mode: 'natural' });
    const tts = createDemoTTSProvider();

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Hi' }),
      ttsProvider: tts,
    });

    await coordinator.startRecording();
    await coordinator.stopRecordingAndProcess();

    await coordinator.stopSpeaking();
    expect(coordinator.getStatus().isSpeaking).toBe(false);
  });
});
