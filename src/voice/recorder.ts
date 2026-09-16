/**
 * src/voice/recorder.ts
 *
 * Audio recorder implementations:
 * - ExpoAudioRecorder: uses official expo-audio and expo-file-system
 * - DemoAudioRecorder: deterministic mock recorder for tests and demo mode
 */

import type { AudioRecorderService, AudioRecordingResult } from './types';

/**
 * Reads a local audio file URI into a base64 encoded string.
 */
export async function readAudioUriAsBase64(uri: string): Promise<string | null> {
  if (!uri || uri.trim().length === 0) return null;
  const trimmed = uri.trim();

  if (trimmed.startsWith('data:') && trimmed.includes('base64,')) {
    return trimmed.split('base64,')[1].trim();
  }

  // 1. Try expo-file-system legacy readAsStringAsync
  try {
    const FileSystem = await import('expo-file-system/legacy');
    if (FileSystem && typeof FileSystem.readAsStringAsync === 'function') {
      const data = await FileSystem.readAsStringAsync(trimmed, {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (data && data.trim().length > 0) {
        return data.trim();
      }
    }
  } catch {
    // Fallback below
  }

  // 2. Try fetch blob
  try {
    const res = await fetch(trimmed);
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    if (typeof btoa === 'function') {
      return btoa(binary);
    }
    const maybeBuffer = (globalThis as Record<string, unknown>).Buffer as
      | { from: (b: ArrayBuffer) => { toString: (enc: string) => string } }
      | undefined;
    if (maybeBuffer && typeof maybeBuffer.from === 'function') {
      return maybeBuffer.from(buffer).toString('base64');
    }
  } catch {
    // Return null below
  }

  return null;
}

/**
 * Real device audio recorder using Expo SDK 57 expo-audio.
 */
export class ExpoAudioRecorder implements AudioRecorderService {
  private recordingInstance: { stop: () => Promise<void>; uri: string | null } | null = null;
  private recordingStartTime: number | null = null;
  private active: boolean = false;

  async requestPermissions(): Promise<boolean> {
    try {
      const { requestRecordingPermissionsAsync } = await import('expo-audio');
      const response = await requestRecordingPermissionsAsync();
      return response.granted === true || response.status === 'granted';
    } catch {
      return false;
    }
  }

  async hasPermissions(): Promise<boolean> {
    try {
      const { getRecordingPermissionsAsync } = await import('expo-audio');
      const response = await getRecordingPermissionsAsync();
      return response.granted === true || response.status === 'granted';
    } catch {
      return false;
    }
  }

  async startRecording(): Promise<void> {
    if (this.active) {
      throw new Error('Recording is already in progress.');
    }

    const { AudioModule, RecordingPresets, setAudioModeAsync } = await import('expo-audio');

    // Ensure audio mode allows recording
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
    } catch {
      // Best-effort audio mode configuration
    }

    const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
    recorder.record();

    this.recordingInstance = recorder;
    this.recordingStartTime = Date.now();
    this.active = true;
  }

  async stopRecording(): Promise<AudioRecordingResult> {
    if (!this.active || !this.recordingInstance) {
      throw new Error('No active recording to stop.');
    }

    const startTime = this.recordingStartTime ?? Date.now();
    const durationMs = Math.max(0, Date.now() - startTime);

    const recorder = this.recordingInstance;
    this.active = false;
    this.recordingInstance = null;
    this.recordingStartTime = null;

    await recorder.stop();

    const uri = recorder.uri || '';
    let base64: string | undefined;

    if (uri.length > 0) {
      const encoded = await readAudioUriAsBase64(uri);
      if (encoded) {
        base64 = encoded;
      }
    }

    // Determine MIME type based on file extension
    let mimeType = 'audio/m4a';
    if (uri.endsWith('.webm')) {
      mimeType = 'audio/webm';
    } else if (uri.endsWith('.mp4')) {
      mimeType = 'audio/mp4';
    } else if (uri.endsWith('.wav')) {
      mimeType = 'audio/wav';
    }

    return {
      uri,
      base64,
      mimeType,
      durationMs,
    };
  }

  isRecording(): boolean {
    return this.active;
  }

  getElapsedSeconds(): number {
    if (!this.active || !this.recordingStartTime) {
      return 0;
    }
    return Math.floor((Date.now() - this.recordingStartTime) / 1000);
  }
}

/**
 * Deterministic in-memory recorder for tests and demo mode.
 */
export class DemoAudioRecorder implements AudioRecorderService {
  private permissionGranted: boolean = true;
  private active: boolean = false;
  private recordingStartTime: number | null = null;
  private mockDurationMs: number = 2500;
  private mockResult: AudioRecordingResult = {
    uri: 'file:///mock/demo-audio.m4a',
    base64: 'ZGVtby1hdWRpby1ieXRlcw==',
    mimeType: 'audio/m4a',
    durationMs: 2500,
  };

  constructor(options?: { permissionGranted?: boolean; mockDurationMs?: number }) {
    if (options?.permissionGranted !== undefined) {
      this.permissionGranted = options.permissionGranted;
    }
    if (options?.mockDurationMs !== undefined) {
      this.mockDurationMs = options.mockDurationMs;
      this.mockResult = {
        ...this.mockResult,
        durationMs: options.mockDurationMs,
      };
    }
  }

  setPermission(granted: boolean): void {
    this.permissionGranted = granted;
  }

  setMockResult(result: Partial<AudioRecordingResult>): void {
    this.mockResult = {
      ...this.mockResult,
      ...result,
    };
  }

  async requestPermissions(): Promise<boolean> {
    return this.permissionGranted;
  }

  async hasPermissions(): Promise<boolean> {
    return this.permissionGranted;
  }

  async startRecording(): Promise<void> {
    if (this.active) {
      throw new Error('Recording is already in progress.');
    }
    if (!this.permissionGranted) {
      throw new Error('Microphone permission not granted.');
    }
    this.active = true;
    this.recordingStartTime = Date.now();
  }

  async stopRecording(): Promise<AudioRecordingResult> {
    if (!this.active) {
      throw new Error('No active recording to stop.');
    }
    const elapsed = this.recordingStartTime
      ? Date.now() - this.recordingStartTime
      : this.mockDurationMs;
    this.active = false;
    this.recordingStartTime = null;

    return {
      ...this.mockResult,
      durationMs: Math.max(elapsed, this.mockDurationMs),
    };
  }

  isRecording(): boolean {
    return this.active;
  }

  getElapsedSeconds(): number {
    if (!this.active || !this.recordingStartTime) {
      return 0;
    }
    return Math.floor((Date.now() - this.recordingStartTime) / 1000);
  }
}

export function createExpoAudioRecorder(): AudioRecorderService {
  return new ExpoAudioRecorder();
}

export function createDemoAudioRecorder(options?: {
  permissionGranted?: boolean;
  mockDurationMs?: number;
}): DemoAudioRecorder {
  return new DemoAudioRecorder(options);
}
