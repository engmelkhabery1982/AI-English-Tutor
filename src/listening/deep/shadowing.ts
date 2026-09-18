/**
 * src/listening/deep/shadowing.ts
 *
 * WP-2 — SHADOWING: listen to a short natural chunk, repeat it, get honest
 * qualitative feedback, and repeat again with less support.
 *
 * OWNERSHIP
 * - This module owns NO new engine: it drives the EXISTING recorder
 *   (`AudioRecorderService`) and the EXISTING STT provider
 *   (`SpeechToTextProvider`), and it routes a real transcript to the EXISTING
 *   pronunciation path (`PronunciationEngine.analyzeSpokenTurn` through a
 *   narrow port) whose owns all pronunciation evidence and review.
 * - Audio playback stays with the EXISTING TextToSpeechProvider in the UI.
 * - There is NO pronunciation score anywhere: feedback is qualitative
 *   ('matched' / 'close' / 'different' / 'insufficient_evidence').
 * - A failed recording, transcription or pronunciation analysis records
 *   NOTHING: no weakness, no review item, no progress count, no attempt.
 *   Repetition and replays are LOCAL practice state and never evidence.
 */

import type { SpeechToTextProvider } from '../../providers/stt';
import type { TextToSpeechProvider } from '../../providers/tts/types';
import type { PronunciationTurnOutcome } from '../../pronunciation/types';
import type { AudioRecorderService, AudioRecordingResult } from '../../voice/types';
import { internalWordOverlap, normalizeAnswerText } from '../evaluator';
import type { ShadowingQualitativeResult, ShadowingSupportLevel } from './types';

/** How many times a chunk may be repeated (bounded practice). */
export const SHADOWING_MAX_REPEATS = 3;

/** The EXISTING pronunciation surface shadowing is allowed to use. */
export interface ShadowingPronunciationPort {
  analyzeSpokenTurn(input: {
    transcript: string;
    expectedText?: string;
    context?: string;
    now?: string;
  }): Promise<PronunciationTurnOutcome | null>;
}

/* ------------------------------------------------------------------ *
 * Support progression
 * ------------------------------------------------------------------ */

/**
 * Support after `attempt` attempts. Help is removed ONE step at a time, never
 * instantly: the first attempt is the most supported, later attempts less so.
 */
export function supportForAttempt(
  base: ShadowingSupportLevel,
  attempt: number,
): ShadowingSupportLevel {
  if (base === 'full_transcript') {
    if (attempt <= 1) return 'full_transcript';
    return attempt === 2 ? 'partial_transcript' : 'audio_only';
  }
  if (base === 'partial_transcript') {
    return attempt <= 1 ? 'partial_transcript' : 'audio_only';
  }
  return 'audio_only';
}

/**
 * The visible chunk for a support level, or null when nothing is visible yet.
 * `partial_transcript` keeps the first third of the words (at least one).
 */
export function maskedChunk(
  chunk: string,
  support: ShadowingSupportLevel,
): string | null {
  const words = chunk.trim().split(/\s+/).filter(Boolean);
  if (support === 'full_transcript') return chunk.trim();
  if (support === 'audio_only') return null;
  if (words.length === 0) return null;
  const keep = Math.max(1, Math.round(words.length / 3));
  return `${words.slice(0, keep).join(' ')} …`;
}

/* ------------------------------------------------------------------ *
 * Qualitative judgement
 * ------------------------------------------------------------------ */

export interface ShadowingAttempt {
  readonly transcript: string | null;
  readonly qualitative: ShadowingQualitativeResult;
  readonly feedbackLines: readonly string[];
  /** Where the judgement came from — honest provenance, never a fake score. */
  readonly evaluatedBy: 'local' | 'pronunciation' | 'unavailable';
  /** True only when a real transcript was judged. */
  readonly judged: boolean;
}

/** Shown when no speech was captured (nothing was sent anywhere). */
export const SHADOWING_NO_SPEECH_MESSAGE =
  'No speech was captured, so nothing was sent. Try again when you are ready.';

/** Shown when the pronunciation layer is not configured (no invented detail). */
export const SHADOWING_PRONUNCIATION_UNAVAILABLE_NOTE =
  'Detailed pronunciation feedback is not available on this device, so you get a word-level comparison only.';

/**
 * Deterministic local comparison of a repeat against the chunk. Uses the
 * EXISTING listening normalization and overlap helper, so listening text rules
 * stay single-sourced.
 */
export function evaluateShadowingLocally(
  chunk: string,
  transcript: string | null,
): ShadowingAttempt {
  const trimmed = (transcript ?? '').trim();
  if (trimmed.length === 0) {
    return {
      transcript: null,
      qualitative: 'insufficient_evidence',
      feedbackLines: [SHADOWING_NO_SPEECH_MESSAGE],
      evaluatedBy: 'unavailable',
      judged: false,
    };
  }
  if (normalizeAnswerText(trimmed) === normalizeAnswerText(chunk)) {
    return {
      transcript: trimmed,
      qualitative: 'matched',
      feedbackLines: ['You repeated the chunk exactly as it was spoken.'],
      evaluatedBy: 'local',
      judged: true,
    };
  }
  const overlap = internalWordOverlap(chunk, trimmed);
  if (overlap >= 0.7) {
    return {
      transcript: trimmed,
      qualitative: 'close',
      feedbackLines: ['You caught almost the whole chunk — listen once more for the ending.'],
      evaluatedBy: 'local',
      judged: true,
    };
  }
  return {
    transcript: trimmed,
    qualitative: 'different',
    feedbackLines: [
      'What you repeated differs from the chunk. Listen again and keep the same rhythm.',
    ],
    evaluatedBy: 'local',
    judged: true,
  };
}

function qualitativeFromOutcome(outcome: PronunciationTurnOutcome): ShadowingQualitativeResult {
  if (outcome.unavailable) return 'insufficient_evidence';
  const intelligibility = outcome.analysis.overallIntelligibility;
  if (intelligibility === 'clear') return 'matched';
  if (intelligibility === 'partially_clear') return 'close';
  if (intelligibility === 'unclear') return 'different';
  // No intelligibility judgement was produced: never invent one.
  return outcome.analysis.insufficientEvidence ? 'insufficient_evidence' : 'close';
}

export interface ShadowingAttemptInput {
  readonly chunk: string;
  readonly transcript: string | null;
  /** The EXISTING pronunciation engine, when the app really has one. */
  readonly port?: ShadowingPronunciationPort;
  readonly now?: string;
}

/**
 * Judge ONE shadowing attempt.
 *
 * A real pronunciation analysis wins when it is available; otherwise the local
 * comparison is used. Neither path can produce a score, and a missing/failed
 * pronunciation layer never becomes a fabricated judgement.
 */
export async function runShadowingAttempt(
  input: ShadowingAttemptInput,
): Promise<ShadowingAttempt> {
  const local = evaluateShadowingLocally(input.chunk, input.transcript);
  const transcript = local.transcript;
  const port = input.port;
  if (!port || transcript === null) return local;

  try {
    const outcome = await port.analyzeSpokenTurn({
      transcript,
      expectedText: input.chunk,
      context: 'shadowing',
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (!outcome) return local;
    const qualitative = qualitativeFromOutcome(outcome);
    const lines = outcome.feedbackLines.filter((line) => line.trim().length > 0);
    return {
      transcript,
      qualitative,
      feedbackLines:
        lines.length > 0 ? lines : local.feedbackLines,
      evaluatedBy: outcome.unavailable ? 'local' : 'pronunciation',
      judged: !outcome.unavailable,
    };
  } catch {
    // The pronunciation layer failed: keep the honest local judgement and the
    // fact that detailed pronunciation feedback was unavailable.
    return {
      ...local,
      feedbackLines: [...local.feedbackLines, SHADOWING_PRONUNCIATION_UNAVAILABLE_NOTE],
    };
  }
}

/* ------------------------------------------------------------------ *
 * Session (local practice state only)
 * ------------------------------------------------------------------ */

export interface ShadowingSessionInput {
  readonly id: string;
  readonly chunk: string;
  readonly canonicalWrittenForm: string;
  readonly baseSupport: ShadowingSupportLevel;
  readonly maxRepeats?: number;
}

/**
 * Local shadowing state for ONE chunk. It counts replays and attempts so the
 * UI can remove support gradually — and it deliberately has no repository, no
 * service and no clock, so repetition can never create evidence on its own.
 */
export class ShadowingSession {
  readonly id: string;
  readonly chunk: string;
  readonly canonicalWrittenForm: string;
  private readonly baseSupport: ShadowingSupportLevel;
  private readonly maxRepeats: number;
  private attempts = 0;
  private replays = 0;
  private lastAttempt: ShadowingAttempt | null = null;

  constructor(input: ShadowingSessionInput) {
    this.id = input.id;
    this.chunk = input.chunk;
    this.canonicalWrittenForm = input.canonicalWrittenForm;
    this.baseSupport = input.baseSupport;
    this.maxRepeats = input.maxRepeats ?? SHADOWING_MAX_REPEATS;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  /** Real audio plays — practice, never an answer. */
  get replayCount(): number {
    return this.replays;
  }

  get maxRepeatCount(): number {
    return this.maxRepeats;
  }

  get exhausted(): boolean {
    return this.attempts >= this.maxRepeats;
  }

  get transcript(): ShadowingAttempt | null {
    return this.lastAttempt;
  }

  /** The support in effect for the NEXT attempt. */
  get support(): ShadowingSupportLevel {
    return supportForAttempt(this.baseSupport, this.attempts + 1);
  }

  /** What the learner may currently read (null when support is removed). */
  get visibleChunk(): string | null {
    return maskedChunk(this.chunk, this.support);
  }

  recordReplay(): void {
    this.replays += 1;
  }

  /**
   * Register one repeat. An empty transcript is NOT an attempt: nothing was
   * captured, so nothing is judged and no support is removed.
   */
  async submit(
    transcript: string | null,
    port?: ShadowingPronunciationPort,
    now?: string,
  ): Promise<ShadowingAttempt> {
    const outcome = await runShadowingAttempt({
      chunk: this.chunk,
      transcript,
      ...(port !== undefined ? { port } : {}),
      ...(now !== undefined ? { now } : {}),
    });
    if (outcome.judged) {
      this.attempts += 1;
      this.lastAttempt = outcome;
    }
    return outcome;
  }
}

/* ------------------------------------------------------------------ *
 * Playback (EXISTING TextToSpeechProvider)
 * ------------------------------------------------------------------ */

/** Shown when the chunk could not be played (nothing else is affected). */
export const SHADOWING_SPEECH_FAILED_MESSAGE =
  'The audio could not be played. Your practice was not affected — try playing it again.';

export interface ShadowingPlaybackFailure {
  readonly ok: false;
  readonly reason: 'speech-unavailable' | 'speech-failed';
  readonly message: string;
}

export interface ShadowingPlaybackSuccess {
  readonly ok: true;
}

/**
 * Play the chunk through the EXISTING TTS provider.
 *
 * A playback failure changes NOTHING: no replay is counted, no attempt is
 * registered and no evidence of any kind can be produced — playback is not
 * learner performance.
 */
export async function playShadowingChunk(
  tts: TextToSpeechProvider | null | undefined,
  session: ShadowingSession,
  options?: { rate?: number },
): Promise<ShadowingPlaybackSuccess | ShadowingPlaybackFailure> {
  if (!tts) {
    return {
      ok: false,
      reason: 'speech-unavailable',
      message: SHADOWING_SPEECH_FAILED_MESSAGE,
    };
  }
  try {
    await tts.speak(session.chunk, options?.rate !== undefined ? { rate: options.rate } : undefined);
  } catch {
    return { ok: false, reason: 'speech-failed', message: SHADOWING_SPEECH_FAILED_MESSAGE };
  }
  session.recordReplay();
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Voice wiring (EXISTING recorder + EXISTING STT)
 * ------------------------------------------------------------------ */

export const SHADOWING_VOICE_UNAVAILABLE_MESSAGE =
  'Voice capture needs a configured speech provider. You can still read the chunk and repeat it aloud.';
export const SHADOWING_PERMISSION_DENIED_MESSAGE =
  'Microphone permission was denied, so nothing was recorded.';
export const SHADOWING_RECORDING_FAILED_MESSAGE =
  'Recording could not start, so nothing was recorded.';
export const SHADOWING_TRANSCRIPTION_FAILED_MESSAGE =
  'Speech could not be transcribed, so nothing was sent.';

export type ShadowingVoiceFailureReason =
  | 'voice-unavailable'
  | 'permission-denied'
  | 'recording-failed'
  | 'transcription-failed'
  | 'busy';

export interface ShadowingVoiceFailure {
  readonly ok: false;
  readonly reason: ShadowingVoiceFailureReason;
  readonly message: string;
}

export interface ShadowingVoiceSuccess {
  readonly ok: true;
}

/** The EXISTING voice pieces shadowing may use — injected, never re-created. */
export interface ShadowingVoiceDeps {
  readonly recorder?: AudioRecorderService;
  readonly stt?: SpeechToTextProvider;
  readonly port?: ShadowingPronunciationPort;
  readonly now?: string;
  /**
   * Optional owner-side judge. The app passes the listening service's
   * `submitShadowingAttempt`, so the attempt is routed through the EXISTING
   * service (which owns the pronunciation port). When absent, the session
   * judges locally through `port`.
   */
  readonly submit?: (transcript: string) => Promise<ShadowingAttempt>;
}

/**
 * Drives the EXISTING recorder → EXISTING STT → EXISTING pronunciation port
 * for one shadowing session. Every failure path returns an honest message and
 * sends NOTHING: no transcript, no evidence, no attempt.
 */
export class ShadowingVoiceController {
  private readonly recorder: AudioRecorderService | null;
  private readonly stt: SpeechToTextProvider | null;
  private readonly port: ShadowingPronunciationPort | undefined;
  private readonly now: string | undefined;
  private readonly submitOverride: ((transcript: string) => Promise<ShadowingAttempt>) | undefined;
  private state: 'idle' | 'recording' | 'transcribing' = 'idle';
  private disposed = false;

  constructor(
    private readonly session: ShadowingSession,
    deps: ShadowingVoiceDeps,
  ) {
    this.recorder = deps.recorder ?? null;
    this.stt = deps.stt ?? null;
    this.port = deps.port;
    this.now = deps.now;
    this.submitOverride = deps.submit;
  }

  /** True when a real microphone path exists (no silent demo fallback). */
  get voiceAvailable(): boolean {
    return Boolean(this.recorder && this.stt);
  }

  get isBusy(): boolean {
    return this.state !== 'idle';
  }

  async startRecording(): Promise<ShadowingVoiceSuccess | ShadowingVoiceFailure> {
    if (this.disposed || this.session.exhausted) {
      return this.failure('busy', SHADOWING_RECORDING_FAILED_MESSAGE);
    }
    if (this.isBusy) return this.failure('busy', SHADOWING_RECORDING_FAILED_MESSAGE);
    const recorder = this.recorder;
    const stt = this.stt;
    if (!recorder || !stt) {
      return this.failure('voice-unavailable', SHADOWING_VOICE_UNAVAILABLE_MESSAGE);
    }
    try {
      const granted = (await recorder.hasPermissions()) || (await recorder.requestPermissions());
      if (!granted) {
        return this.failure('permission-denied', SHADOWING_PERMISSION_DENIED_MESSAGE);
      }
      this.state = 'recording';
      await recorder.startRecording();
      if (this.disposed) {
        await this.discardRecording();
        return this.failure('busy', SHADOWING_RECORDING_FAILED_MESSAGE);
      }
      return { ok: true };
    } catch {
      this.state = 'idle';
      return this.failure('recording-failed', SHADOWING_RECORDING_FAILED_MESSAGE);
    }
  }

  /**
   * Stop, transcribe with the EXISTING STT and judge through the EXISTING
   * pronunciation port. A transcription failure records nothing.
   */
  async stopAndJudge(): Promise<ShadowingAttempt | ShadowingVoiceFailure> {
    if (this.disposed) return this.failure('busy', SHADOWING_RECORDING_FAILED_MESSAGE);
    if (this.state !== 'recording') return this.failure('busy', SHADOWING_RECORDING_FAILED_MESSAGE);
    const recorder = this.recorder;
    const stt = this.stt;
    if (!recorder || !stt) {
      return this.failure('voice-unavailable', SHADOWING_VOICE_UNAVAILABLE_MESSAGE);
    }

    let audio: AudioRecordingResult;
    try {
      audio = await recorder.stopRecording();
    } catch {
      this.state = 'idle';
      return this.failure('recording-failed', SHADOWING_RECORDING_FAILED_MESSAGE);
    }

    this.state = 'transcribing';
    let transcript = '';
    try {
      const result = await stt.transcribe({
        uri: audio.uri,
        ...(audio.base64 ? { base64: audio.base64 } : {}),
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
      });
      if (result.ok) transcript = (result.transcript ?? '').trim();
    } catch {
      this.state = 'idle';
      return this.failure('transcription-failed', SHADOWING_TRANSCRIPTION_FAILED_MESSAGE);
    }
    if (!transcript) {
      this.state = 'idle';
      return this.failure('transcription-failed', SHADOWING_TRANSCRIPTION_FAILED_MESSAGE);
    }

    this.state = 'idle';
    if (this.submitOverride) return this.submitOverride(transcript);
    return this.session.submit(transcript, this.port, this.now);
  }

  /** Abandon the recording without transcribing or judging anything. */
  async cancel(): Promise<void> {
    if (this.state === 'recording') await this.discardRecording();
    this.state = 'idle';
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
  }

  private failure(
    reason: ShadowingVoiceFailureReason,
    message: string,
  ): ShadowingVoiceFailure {
    return { ok: false, reason, message };
  }

  private async discardRecording(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || !recorder.isRecording()) return;
    try {
      await recorder.stopRecording();
    } catch {
      // Discarding: a stop failure is harmless.
    }
  }
}
