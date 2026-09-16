/**
 * src/voice/coordinator.ts
 *
 * Coordinates Voice Conversation MVP lifecycle:
 * Audio Recording -> Speech-to-Text -> ConversationSession (streaming) -> Text-to-Speech.
 * Enforces interruption rules, single-turn guarantees, and conversation history integrity.
 */

import type { ConversationSession, ConversationTurn } from '../conversation-session';
import type { SpeechToTextProvider } from '../providers/stt';
import type { TextToSpeechProvider } from '../providers/tts';
import type {
  AudioRecorderService,
  VoiceState,
  VoiceStatus,
  VoiceStatusListener,
} from './types';

export interface VoiceSessionCoordinatorConfig {
  readonly recorder: AudioRecorderService;
  readonly sttProvider: SpeechToTextProvider;
  readonly ttsProvider: TextToSpeechProvider;
  readonly session: ConversationSession;
  readonly isMuted?: boolean;
}

export class VoiceSessionCoordinator {
  private readonly recorder: AudioRecorderService;
  private readonly sttProvider: SpeechToTextProvider;
  private readonly ttsProvider: TextToSpeechProvider;
  private session: ConversationSession;

  private state: VoiceState = 'idle';
  private elapsedSeconds: number = 0;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private recognizedTranscript: string | null = null;
  private errorMessage: string | null = null;
  private isMuted: boolean = false;
  private listeners: Set<VoiceStatusListener> = new Set();

  constructor(config: VoiceSessionCoordinatorConfig) {
    this.recorder = config.recorder;
    this.sttProvider = config.sttProvider;
    this.ttsProvider = config.ttsProvider;
    this.session = config.session;
    this.isMuted = config.isMuted ?? false;
  }

  /**
   * Updates the active ConversationSession (e.g. on new chat or mode switch).
   */
  setSession(newSession: ConversationSession): void {
    this.stopSpeaking();
    if (this.state === 'recording') {
      this.cancelRecording();
    }
    this.session = newSession;
    this.recognizedTranscript = null;
    this.errorMessage = null;
    this.state = 'idle';
    this.notifyListeners();
  }

  /**
   * Subscribes a listener to voice status updates.
   */
  subscribe(listener: VoiceStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const status = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  getStatus(): VoiceStatus {
    const isSpeaking = this.state === 'speaking';
    const canRecord =
      this.state === 'idle' || this.state === 'speaking' || this.state === 'error';
    const canStopRecording = this.state === 'recording';
    const canSendText = this.state !== 'recording' && this.state !== 'transcribing';

    return {
      state: this.state,
      elapsedSeconds: this.elapsedSeconds,
      recognizedTranscript: this.recognizedTranscript,
      errorMessage: this.errorMessage,
      isMuted: this.isMuted,
      isSpeaking,
      canRecord,
      canStopRecording,
      canSendText,
    };
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted && this.state === 'speaking') {
      this.stopSpeaking();
    } else {
      this.notifyListeners();
    }
  }

  toggleMute(): void {
    this.setMuted(!this.isMuted);
  }

  /**
   * Starts push-to-talk audio recording.
   */
  async startRecording(): Promise<boolean> {
    // Prevent starting if already recording, transcribing, or sending
    if (
      this.state === 'recording' ||
      this.state === 'transcribing' ||
      this.state === 'sending' ||
      this.state === 'requesting_permission'
    ) {
      return false;
    }

    // Stop TTS if speaking before recording
    if (this.state === 'speaking') {
      await this.stopSpeaking();
    }

    this.errorMessage = null;
    this.recognizedTranscript = null;
    this.state = 'requesting_permission';
    this.notifyListeners();

    try {
      const hasPermission = await this.recorder.hasPermissions();
      if (!hasPermission) {
        const granted = await this.recorder.requestPermissions();
        if (!granted) {
          this.state = 'error';
          this.errorMessage =
            'Microphone permission is required for voice conversation.';
          this.notifyListeners();
          return false;
        }
      }

      await this.recorder.startRecording();
      this.state = 'recording';
      this.elapsedSeconds = 0;

      if (this.timerHandle) {
        clearInterval(this.timerHandle);
      }
      this.timerHandle = setInterval(() => {
        this.elapsedSeconds = this.recorder.getElapsedSeconds();
        this.notifyListeners();
      }, 500);

      this.notifyListeners();
      return true;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to start microphone recording.';
      this.state = 'error';
      this.errorMessage = message;
      this.notifyListeners();
      return false;
    }
  }

  /**
   * Cancels active recording without processing speech.
   */
  cancelRecording(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.recorder.isRecording()) {
      this.recorder.stopRecording().catch(() => {});
    }
    this.state = 'idle';
    this.elapsedSeconds = 0;
    this.notifyListeners();
  }

  /**
   * Stops recording, transcribes audio with STT, and automatically submits transcript to ConversationSession.
   */
  async stopRecordingAndProcess(
    onStreamChunk?: (chunk: string) => void
  ): Promise<{ ok: boolean; transcript?: string; error?: string }> {
    if (this.state !== 'recording') {
      return { ok: false, error: 'Not currently recording.' };
    }

    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }

    let audio;
    try {
      audio = await this.recorder.stopRecording();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to stop audio recording.';
      this.state = 'error';
      this.errorMessage = message;
      this.notifyListeners();
      return { ok: false, error: message };
    }

    this.state = 'transcribing';
    this.notifyListeners();

    // 1. Speech to Text
    const sttResult = await this.sttProvider.transcribe(audio);

    if (!sttResult.ok || !sttResult.transcript || sttResult.transcript.trim().length === 0) {
      const errorMsg =
        sttResult.error || 'Could not recognize speech. Please try speaking again.';
      this.state = 'error';
      this.errorMessage = errorMsg;
      // CRITICAL: ConversationSession history remains unchanged!
      this.notifyListeners();
      return { ok: false, error: errorMsg };
    }

    const transcript = sttResult.transcript.trim();
    this.recognizedTranscript = transcript;
    this.state = 'sending';
    this.notifyListeners();

    // 2. Submit transcript to active ConversationSession
    try {
      const sessionResult = await this.session.send(
        { userMessage: transcript },
        onStreamChunk
      );

      if (!sessionResult.ok) {
        this.errorMessage = sessionResult.error?.message || 'Tutor response failed.';
        this.state = 'idle';
        this.notifyListeners();
        return { ok: true, transcript, error: this.errorMessage };
      }

      // 3. Play assistant response via TTS if not muted
      if (!this.isMuted) {
        const history = this.session.getHistory();
        const lastAssistantTurn = this.findLastAssistantTurn(history);
        if (lastAssistantTurn && lastAssistantTurn.content.trim().length > 0) {
          await this.speakResponse(lastAssistantTurn.content);
          return { ok: true, transcript };
        }
      }

      this.state = 'idle';
      this.notifyListeners();
      return { ok: true, transcript };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Error processing tutor response.';
      this.errorMessage = message;
      this.state = 'idle';
      this.notifyListeners();
      return { ok: true, transcript, error: message };
    }
  }

  /**
   * Helper to find the latest assistant response in history.
   */
  private findLastAssistantTurn(
    history: readonly ConversationTurn[]
  ): ConversationTurn | null {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        return history[i];
      }
    }
    return null;
  }

  /**
   * Speaks the assistant response text aloud.
   */
  async speakResponse(text: string): Promise<void> {
    if (this.isMuted || !text || text.trim().length === 0) {
      this.state = 'idle';
      this.notifyListeners();
      return;
    }

    this.state = 'speaking';
    this.notifyListeners();

    try {
      await this.ttsProvider.speak(text, {
        onStart: () => {
          this.state = 'speaking';
          this.notifyListeners();
        },
        onDone: () => {
          if (this.state === 'speaking') {
            this.state = 'idle';
            this.notifyListeners();
          }
        },
        onError: () => {
          if (this.state === 'speaking') {
            this.state = 'idle';
            this.notifyListeners();
          }
        },
      });
    } catch {
      // TTS failure must NOT roll back the conversation
      if (this.state === 'speaking') {
        this.state = 'idle';
        this.notifyListeners();
      }
    }
  }

  /**
   * Stops any currently active text-to-speech playback.
   */
  async stopSpeaking(): Promise<void> {
    try {
      await this.ttsProvider.stop();
    } catch {
      // Ignore stop errors
    } finally {
      if (this.state === 'speaking') {
        this.state = 'idle';
        this.notifyListeners();
      }
    }
  }

  /**
   * Replays the last tutor response aloud.
   */
  async replayLastResponse(): Promise<void> {
    const history = this.session.getHistory();
    const lastAssistantTurn = this.findLastAssistantTurn(history);
    if (!lastAssistantTurn || lastAssistantTurn.content.trim().length === 0) {
      return;
    }

    await this.stopSpeaking();
    await this.speakResponse(lastAssistantTurn.content);
  }

  /**
   * Full reset (e.g. when New Chat or mode change is pressed).
   */
  async reset(): Promise<void> {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.recorder.isRecording()) {
      try {
        await this.recorder.stopRecording();
      } catch {
        // Ignore
      }
    }
    await this.stopSpeaking();
    this.state = 'idle';
    this.elapsedSeconds = 0;
    this.recognizedTranscript = null;
    this.errorMessage = null;
    this.notifyListeners();
  }
}

export function createVoiceSessionCoordinator(
  config: VoiceSessionCoordinatorConfig
): VoiceSessionCoordinator {
  return new VoiceSessionCoordinator(config);
}
