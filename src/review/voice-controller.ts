import type { AudioRecorderService } from '../voice/types';
import type { SpeechToTextProvider } from '../providers/stt/types';

export class ReviewVoiceController {
  private _isRecording = false;
  private _userAnswer = '';
  private _error: string | null = null;

  constructor(
    private readonly recorder: AudioRecorderService,
    private readonly stt: SpeechToTextProvider,
  ) {}

  get isRecording(): boolean {
    return this._isRecording;
  }

  get userAnswer(): string {
    return this._userAnswer;
  }

  get error(): string | null {
    return this._error;
  }

  async toggleRecording(): Promise<void> {
    if (this._isRecording) {
      try {
        const result = await this.recorder.stopRecording();
        this._isRecording = false;
        this._error = null;

        const sttRes = await this.stt.transcribe({
          uri: result.uri,
          base64: result.base64,
          mimeType: result.mimeType,
          durationMs: result.durationMs,
        });

        if (sttRes.ok && sttRes.transcript) {
          this._userAnswer = sttRes.transcript;
        } else {
          this._error = 'Failed to transcribe audio. Please try again or type your answer.';
        }
      } catch (err) {
        this._isRecording = false;
        this._error = err instanceof Error ? err.message : 'Unknown recording error';
      }
    } else {
      try {
        const hasPermission = await this.recorder.requestPermissions();
        if (!hasPermission) {
          this._error = 'Microphone permission denied';
          return;
        }
        await this.recorder.startRecording();
        this._isRecording = true;
        this._error = null;
      } catch (err) {
        this._isRecording = false;
        this._error = err instanceof Error ? err.message : 'Failed to start recording';
      }
    }
  }
}
