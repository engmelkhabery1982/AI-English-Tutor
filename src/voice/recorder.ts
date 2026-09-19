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
 * Hardened for mobile lifecycle:
 * - maximum one active recording (single-flight start)
 * - double mic tap cannot create two recordings
 * - stop/start cannot overlap native teardown (pendingStop chaining)
 * - teardown idempotent
 * - terminally disposed recorder cannot be reused
 * - task switch invalidates previous callback via generation
 */
export class ExpoAudioRecorder implements AudioRecorderService {
  private recordingInstance: { stop: () => Promise<void>; uri: string | null } | null = null;
  private recordingStartTime: number | null = null;
  private active: boolean = false;
  private disposed: boolean = false;
  private startInProgress: boolean = false;
  private pendingTeardown: Promise<void> | null = null;
  private generation: number = 0;
  private lastResult: AudioRecordingResult | null = null;

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

  private trackTeardown(promise: Promise<unknown>): void {
    const safe = promise.then(() => undefined).catch(() => undefined);
    if (this.pendingTeardown) {
      const prev = this.pendingTeardown;
      this.pendingTeardown = prev.then(() => safe).catch(() => undefined);
    } else {
      this.pendingTeardown = safe;
    }
    const cur = this.pendingTeardown;
    cur.finally(() => {
      if (this.pendingTeardown === cur) {
        this.pendingTeardown = null;
      }
    });
  }

  private async restoreAudioMode(): Promise<void> {
    try {
      const { setAudioModeAsync } = await import('expo-audio');
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
    } catch {
      // Best-effort restoration – failure must not crash or create learner evidence
    }
  }

  async startRecording(): Promise<void> {
    if (this.disposed) {
      throw new Error('Recorder is disposed and cannot be reused.');
    }
    if (this.active || this.startInProgress) {
      throw new Error('Recording is already in progress.');
    }

    // Prevent overlap with native teardown: wait for any pending stop/restoration
    if (this.pendingTeardown) {
      await this.pendingTeardown;
      if (this.disposed) {
        throw new Error('Recorder is disposed and cannot be reused.');
      }
      if (this.active) {
        throw new Error('Recording is already in progress.');
      }
    }

    this.startInProgress = true;
    const gen = this.generation;
    let audioModeEnabled = false;
    let recorderInstance: { stop: () => Promise<void>; uri: string | null } | null = null;

    try {
      // ALL work after setting startInProgress is protected by try/finally
      const { AudioModule, RecordingPresets, setAudioModeAsync } = await import('expo-audio');

      // Ensure audio mode allows recording
      try {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        audioModeEnabled = true;
      } catch {
        // Best-effort audio mode configuration
      }

      const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      recorderInstance = recorder;
      await recorder.prepareToRecordAsync();
      if (this.disposed || this.generation !== gen) {
        // Invalidated while preparing: clean up and abort, restore mode
        try {
          await recorder.stop();
        } catch {}
        try {
          await setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
          });
        } catch {}
        throw new Error('Recording was cancelled.');
      }
      recorder.record();

      this.recordingInstance = recorder;
      this.recordingStartTime = Date.now();
      this.active = true;
      this.lastResult = null;
    } catch (err) {
      // No active recorder, no orphan native resource
      this.active = false;
      if (recorderInstance) {
        try {
          await recorderInstance.stop();
        } catch {}
      }
      this.recordingInstance = null;
      this.recordingStartTime = null;
      // Restore recording mode if we enabled it and start failed
      if (audioModeEnabled) {
        try {
          const { setAudioModeAsync } = await import('expo-audio');
          await setAudioModeAsync({
            allowsRecording: false,
            playsInSilentMode: true,
          });
        } catch {
          // Restoration failure must not crash or create learner evidence
        }
      }
      throw err;
    } finally {
      // Any start failure, including module import failure, must leave startInProgress false and retry possible
      this.startInProgress = false;
    }
  }

  async stopRecording(): Promise<AudioRecordingResult> {
    if (this.disposed) {
      throw new Error('Recorder is disposed and cannot be reused.');
    }
    if (!this.active || !this.recordingInstance) {
      // Idempotent teardown: if a stop is already in flight, await it
      // For strict API compatibility, throw when no active recording and no pending
      // but we make repeated Stop safe by returning last result if available
      if (this.lastResult) {
        return this.lastResult;
      }
      throw new Error('No active recording to stop.');
    }

    const startTime = this.recordingStartTime ?? Date.now();
    const durationMs = Math.max(0, Date.now() - startTime);

    const recorder = this.recordingInstance;
    this.active = false;
    this.recordingInstance = null;
    this.recordingStartTime = null;

    const teardownPromise = (async () => {
      try {
        await recorder.stop();
      } catch {
        // Best-effort stop
      }
      // Once recording ownership ends, recording mode is returned to non-recording state
      try {
        const { setAudioModeAsync } = await import('expo-audio');
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
        });
      } catch {
        // Restoration failure must not crash or create learner evidence
      }
    })();
    // Restoration is serialized with teardown where necessary
    this.trackTeardown(teardownPromise);
    await teardownPromise;

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

    const result: AudioRecordingResult = {
      uri,
      base64,
      mimeType,
      durationMs,
    };
    this.lastResult = result;
    return result;
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

  /** Synchronous invalidation for task switch / background */
  invalidate(): void {
    this.generation += 1;
    if (this.active && this.recordingInstance) {
      const rec = this.recordingInstance;
      this.active = false;
      this.recordingInstance = null;
      this.recordingStartTime = null;
      this.trackTeardown(
        (async () => {
          try {
            await rec.stop();
          } catch {}
          // Restore recording mode after ownership ends – background/invalidate path
          try {
            const { setAudioModeAsync } = await import('expo-audio');
            await setAudioModeAsync({
              allowsRecording: false,
              playsInSilentMode: true,
            });
          } catch {}
        })(),
      );
    } else {
      // No active recorder, but ensure recording mode is restored if left enabled
      // (e.g., failed start after audio mode enabled, or background without active recording)
      this.trackTeardown(
        (async () => {
          try {
            const { setAudioModeAsync } = await import('expo-audio');
            await setAudioModeAsync({
              allowsRecording: false,
              playsInSilentMode: true,
            });
          } catch {}
        })(),
      );
    }
  }

  /** Terminal disposal – idempotent, restores audio mode */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.startInProgress = false;
    if (this.active && this.recordingInstance) {
      const rec = this.recordingInstance;
      this.active = false;
      this.recordingInstance = null;
      this.recordingStartTime = null;
      try {
        await rec.stop();
      } catch {}
    }
    if (this.pendingTeardown) {
      try {
        await this.pendingTeardown;
      } catch {}
    }
    // Dispose remains terminal – restore recording mode best-effort
    try {
      const { setAudioModeAsync } = await import('expo-audio');
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
    } catch {
      // Restoration failure must not crash
    }
  }
}

/**
 * Deterministic in-memory recorder for tests and demo mode.
 * Hardened with same invariants as ExpoAudioRecorder for test fidelity,
 * including audio mode restoration.
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
  private disposed: boolean = false;
  private startInProgress: boolean = false;
  private pendingTeardown: Promise<void> | null = null;
  private generation: number = 0;
  private lastResult: AudioRecordingResult | null = null;
  private recordingModeEnabled: boolean = false;
  // For testing hooks – simulate failures
  private failNextPrepare: boolean = false;
  private failNextAudioMode: boolean = false;

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

  /** Test hook: force next prepare to fail */
  setFailNextPrepare(fail: boolean): void {
    this.failNextPrepare = fail;
  }

  setFailNextAudioMode(fail: boolean): void {
    this.failNextAudioMode = fail;
  }

  isAudioModeEnabled(): boolean {
    return this.recordingModeEnabled;
  }

  async requestPermissions(): Promise<boolean> {
    return this.permissionGranted;
  }

  async hasPermissions(): Promise<boolean> {
    return this.permissionGranted;
  }

  private trackTeardown(promise: Promise<unknown>): void {
    const safe = promise.then(() => undefined).catch(() => undefined);
    if (this.pendingTeardown) {
      const prev = this.pendingTeardown;
      this.pendingTeardown = prev.then(() => safe).catch(() => undefined);
    } else {
      this.pendingTeardown = safe;
    }
    const cur = this.pendingTeardown;
    cur.finally(() => {
      if (this.pendingTeardown === cur) {
        this.pendingTeardown = null;
      }
    });
  }

  private async restoreAudioMode(): Promise<void> {
    try {
      if (this.failNextAudioMode) {
        this.failNextAudioMode = false;
        throw new Error('audio mode restore failed');
      }
    } catch {
      // Restoration failure must not crash – but we still clear the flag best-effort
    } finally {
      // Even on failure, we consider ownership ended and mode returned to non-recording
      this.recordingModeEnabled = false;
    }
  }

  async startRecording(): Promise<void> {
    if (this.disposed) {
      throw new Error('Recorder is disposed and cannot be reused.');
    }
    if (this.active || this.startInProgress) {
      throw new Error('Recording is already in progress.');
    }
    if (this.pendingTeardown) {
      await this.pendingTeardown;
      if (this.disposed) throw new Error('Recorder is disposed and cannot be reused.');
      if (this.active) throw new Error('Recording is already in progress.');
    }
    if (!this.permissionGranted) {
      throw new Error('Microphone permission not granted.');
    }
    this.startInProgress = true;
    let audioModeEnabled = false;
    try {
      // Simulate audio mode enable – failure here must also leave startInProgress false
      if (this.failNextAudioMode) {
        this.failNextAudioMode = false;
        throw new Error('audio mode setup failed');
      }
      this.recordingModeEnabled = true;
      audioModeEnabled = true;

      if (this.failNextPrepare) {
        this.failNextPrepare = false;
        throw new Error('prepare failed');
      }

      this.active = true;
      this.recordingStartTime = Date.now();
      this.lastResult = null;
    } catch (err) {
      this.active = false;
      this.recordingStartTime = null;
      if (audioModeEnabled) {
        await this.restoreAudioMode();
      }
      throw err;
    } finally {
      this.startInProgress = false;
    }
  }

  async stopRecording(): Promise<AudioRecordingResult> {
    if (this.disposed) {
      throw new Error('Recorder is disposed and cannot be reused.');
    }
    if (!this.active) {
      if (this.lastResult) return this.lastResult;
      throw new Error('No active recording to stop.');
    }
    const elapsed = this.recordingStartTime
      ? Date.now() - this.recordingStartTime
      : this.mockDurationMs;
    this.active = false;
    this.recordingStartTime = null;
    const result = {
      ...this.mockResult,
      durationMs: Math.max(elapsed, this.mockDurationMs),
    };
    this.lastResult = result;
    // Simulate async teardown including audio mode restoration, serialized
    const teardown = (async () => {
      await this.restoreAudioMode();
    })();
    this.trackTeardown(teardown);
    await teardown;
    return result;
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

  invalidate(): void {
    this.generation += 1;
    if (this.active) {
      this.active = false;
      this.recordingStartTime = null;
      this.trackTeardown(
        (async () => {
          await this.restoreAudioMode();
        })(),
      );
    } else {
      // Ensure mode restored even if no active recorder (background path)
      this.trackTeardown(
        (async () => {
          await this.restoreAudioMode();
        })(),
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.startInProgress = false;
    this.active = false;
    this.recordingStartTime = null;
    if (this.pendingTeardown) {
      try {
        await this.pendingTeardown;
      } catch {}
    }
    await this.restoreAudioMode();
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
