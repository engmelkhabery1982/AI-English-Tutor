/**
 * src/voice/recorder.test.ts
 *
 * Unit tests verifying:
 * - ExpoAudioRecorder prepares before recording (Expo SDK 57 lifecycle)
 * - Preparation failure leaves recorder in reusable, non-active state
 * - Recording start failure leaves recorder reusable
 * - DemoAudioRecorder behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createExpoAudioRecorder, createDemoAudioRecorder } from './recorder';

const mockPrepareToRecordAsync = vi.fn();
const mockRecord = vi.fn();
const mockStop = vi.fn();

class MockAudioRecorderInstance {
  uri = 'file:///test-audio.m4a';
  prepareToRecordAsync = mockPrepareToRecordAsync;
  record = mockRecord;
  stop = mockStop;
}

vi.mock('expo-audio', () => ({
  AudioModule: {
    AudioRecorder: MockAudioRecorderInstance,
  },
  RecordingPresets: {
    HIGH_QUALITY: { sampleRate: 44100 },
  },
  setAudioModeAsync: vi.fn().mockResolvedValue(undefined),
  requestRecordingPermissionsAsync: vi.fn().mockResolvedValue({ granted: true, status: 'granted' }),
  getRecordingPermissionsAsync: vi.fn().mockResolvedValue({ granted: true, status: 'granted' }),
}));

vi.mock('expo-file-system', () => ({
  readAsStringAsync: vi.fn().mockResolvedValue('ZHVtbXktYmFzZTY0'),
  EncodingType: { Base64: 'base64' },
}));

describe('ExpoAudioRecorder Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrepareToRecordAsync.mockResolvedValue(undefined);
    mockRecord.mockReturnValue(undefined);
    mockStop.mockResolvedValue(undefined);
  });

  it('calls prepareToRecordAsync() before record() during startRecording()', async () => {
    let prepareOrder = 0;
    let recordOrder = 0;
    let counter = 0;

    mockPrepareToRecordAsync.mockImplementation(async () => {
      prepareOrder = ++counter;
    });
    mockRecord.mockImplementation(() => {
      recordOrder = ++counter;
    });

    const recorder = createExpoAudioRecorder();
    expect(recorder.isRecording()).toBe(false);

    await recorder.startRecording();

    expect(mockPrepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(prepareOrder).toBeGreaterThan(0);
    expect(recordOrder).toBeGreaterThan(prepareOrder);
    expect(recorder.isRecording()).toBe(true);

    const result = await recorder.stopRecording();
    expect(result.uri).toBe('file:///test-audio.m4a');
    expect(recorder.isRecording()).toBe(false);
  });

  it('leaves recorder in non-recording, reusable state when prepareToRecordAsync fails', async () => {
    mockPrepareToRecordAsync.mockRejectedValueOnce(
      new Error('Native audio preparation failure')
    );

    const recorder = createExpoAudioRecorder();
    expect(recorder.isRecording()).toBe(false);

    // Initial attempt fails
    await expect(recorder.startRecording()).rejects.toThrow(
      'Native audio preparation failure'
    );

    // State must remain inactive
    expect(recorder.isRecording()).toBe(false);

    // Next attempt succeeds cleanly
    mockPrepareToRecordAsync.mockResolvedValueOnce(undefined);
    await recorder.startRecording();
    expect(recorder.isRecording()).toBe(true);

    await recorder.stopRecording();
    expect(recorder.isRecording()).toBe(false);
  });

  it('leaves recorder in non-recording state when record() throws', async () => {
    mockPrepareToRecordAsync.mockResolvedValueOnce(undefined);
    mockRecord.mockImplementationOnce(() => {
      throw new Error('Hardware audio session unavailable');
    });

    const recorder = createExpoAudioRecorder();
    await expect(recorder.startRecording()).rejects.toThrow(
      'Hardware audio session unavailable'
    );

    expect(recorder.isRecording()).toBe(false);

    // Recovery attempt
    mockPrepareToRecordAsync.mockResolvedValueOnce(undefined);
    mockRecord.mockReturnValueOnce(undefined);
    await recorder.startRecording();
    expect(recorder.isRecording()).toBe(true);
    await recorder.stopRecording();
  });

  it('checks and requests microphone permissions through expo-audio', async () => {
    const recorder = createExpoAudioRecorder();
    const hasPerm = await recorder.hasPermissions();
    expect(hasPerm).toBe(true);

    const requested = await recorder.requestPermissions();
    expect(requested).toBe(true);
  });
});

describe('DemoAudioRecorder', () => {
  it('controls permission states and tracks elapsed time', async () => {
    const recorder = createDemoAudioRecorder({ permissionGranted: false });
    expect(await recorder.hasPermissions()).toBe(false);

    recorder.setPermission(true);
    expect(await recorder.hasPermissions()).toBe(true);

    await recorder.startRecording();
    expect(recorder.isRecording()).toBe(true);
    expect(recorder.getElapsedSeconds()).toBeGreaterThanOrEqual(0);

    const result = await recorder.stopRecording();
    expect(recorder.isRecording()).toBe(false);
    expect(result.uri).toContain('mock');
  });
});
