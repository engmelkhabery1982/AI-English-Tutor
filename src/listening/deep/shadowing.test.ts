/**
 * src/listening/deep/shadowing.test.ts
 *
 * WP-2 — SHADOWING tests (requirements 13–18).
 *
 * Strategy: drive the REAL shadowing session/controller with the EXISTING
 * abstractions injected as test doubles (recorder, STT, TTS, pronunciation
 * port) and the REAL listening service over REAL SQLite repositories. Nothing
 * here fabricates a pronunciation score, and every provider failure is checked
 * to produce exactly ZERO learner evidence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SqlJsAdapter } from '../../data/local/sqlite/SqlJsAdapter';
import type { DatabaseAdapter } from '../../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteExpressionRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
  SQLiteWeaknessRepository,
} from '../../data/local/sqlite/repositories';
import type { SpeechToTextProvider, STTResult } from '../../providers/stt';
import type { TextToSpeechProvider } from '../../providers/tts/types';
import type { PronunciationTurnOutcome } from '../../pronunciation/types';
import type { AudioRecorderService, AudioRecordingResult } from '../../voice/types';
import { ListeningService } from '../service';
import {
  SHADOWING_PRONUNCIATION_UNAVAILABLE_NOTE,
  SHADOWING_VOICE_UNAVAILABLE_MESSAGE,
  ShadowingSession,
  ShadowingVoiceController,
  evaluateShadowingLocally,
  maskedChunk,
  playShadowingChunk,
  runShadowingAttempt,
  supportForAttempt,
} from './shadowing';
import type { ShadowingPronunciationPort } from './shadowing';
import { resolveSpeechRateCapability } from './speech-rate';
import { planDeepListeningSession } from './planner';
import type { ShadowingListeningActivity } from './types';

const NOW = '2026-09-18T12:00:00.000Z';
const CHUNK = 'Could you take a look at this when you have a minute?';

interface TestContext {
  adapter: DatabaseAdapter;
  learnerId: string;
  weaknesses: SQLiteWeaknessRepository;
  vocabulary: SQLiteVocabularyRepository;
  expressions: SQLiteExpressionRepository;
  review: SQLiteReviewRepository;
  profileRepo: SQLiteUserProfileRepository;
}

async function createContext(): Promise<TestContext> {
  const adapter = new SqlJsAdapter();
  await adapter.init();
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Shadowing Tester',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: [],
    preferredModes: [],
  });
  return {
    adapter,
    learnerId: profile.id,
    weaknesses: new SQLiteWeaknessRepository(adapter),
    vocabulary: new SQLiteVocabularyRepository(adapter),
    expressions: new SQLiteExpressionRepository(adapter),
    review: new SQLiteReviewRepository(adapter),
    profileRepo,
  };
}

function createService(
  ctx: TestContext,
  options?: { pronunciation?: ShadowingPronunciationPort; onWeakness?: () => void },
): ListeningService {
  return new ListeningService({
    weaknesses: {
      listWeaknesses: (learnerId, limit) => ctx.weaknesses.listWeaknesses(learnerId, limit),
      upsertWeakness: (weakness) => {
        options?.onWeakness?.();
        return ctx.weaknesses.upsertWeakness(weakness);
      },
      getWeaknessByReference: (learnerId, type, referenceId) =>
        ctx.weaknesses.getWeaknessByReference(learnerId, type, referenceId),
    },
    review: {
      upsert: (item) => ctx.review.upsert(item),
      getByReference: (learnerId, kind, referenceId) =>
        ctx.review.getByReference(learnerId, kind, referenceId),
    },
    vocabulary: ctx.vocabulary,
    expressions: ctx.expressions,
    profile: ctx.profileRepo,
    ...(options?.pronunciation ? { pronunciation: options.pronunciation } : {}),
  });
}

function recordingResult(): AudioRecordingResult {
  return { uri: 'file://recording.m4a', mimeType: 'audio/m4a', durationMs: 2200 };
}

function fakeRecorder(overrides?: Partial<AudioRecorderService>): AudioRecorderService & {
  startCalls: number;
  stopCalls: number;
} {
  let recording = false;
  const recorder = {
    startCalls: 0,
    stopCalls: 0,
    requestPermissions: async () => true,
    hasPermissions: async () => true,
    startRecording: async () => {
      recorder.startCalls += 1;
      recording = true;
    },
    stopRecording: async () => {
      recorder.stopCalls += 1;
      recording = false;
      return recordingResult();
    },
    isRecording: () => recording,
    getElapsedSeconds: () => 2,
    ...overrides,
  };
  return recorder;
}

function fakeStt(transcribe: (input: unknown) => Promise<STTResult>): SpeechToTextProvider & { calls: number } {
  const provider = {
    id: 'fake-stt',
    calls: 0,
    transcribe: async (input: unknown) => {
      provider.calls += 1;
      return transcribe(input);
    },
  };
  return provider;
}

function fakeTts(speak: (text: string, options?: { rate?: number }) => Promise<void>): TextToSpeechProvider & {
  spoken: string[];
  rates: (number | undefined)[];
} {
  const provider = {
    id: 'fake-tts',
    spoken: [] as string[],
    rates: [] as (number | undefined)[],
    speak: async (text: string, options?: { rate?: number }) => {
      provider.spoken.push(text);
      provider.rates.push(options?.rate);
      return speak(text, options);
    },
    stop: async () => undefined,
    isSpeaking: async () => false,
  };
  return provider;
}

function outcome(overrides?: Partial<PronunciationTurnOutcome>): PronunciationTurnOutcome {
  return {
    analysis: {
      provider: 'fake-pronunciation',
      evidenceLevel: 'transcript_comparison',
      observations: [],
      overallIntelligibility: 'clear',
    },
    feedbackLines: ['The rhythm and the ending sounded natural.'],
    unavailable: false,
    ...overrides,
  };
}

function fakePort(result: PronunciationTurnOutcome | null): ShadowingPronunciationPort & { calls: number } {
  const port = {
    calls: 0,
    analyzeSpokenTurn: async () => {
      port.calls += 1;
      return result;
    },
  };
  return port;
}

function sessionWith(overrides?: Partial<{ baseSupport: 'full_transcript' | 'partial_transcript' | 'audio_only'; maxRepeats: number }>) {
  return new ShadowingSession({
    id: 'shadow-1',
    chunk: CHUNK,
    canonicalWrittenForm: 'Could you look at this when you have a moment?',
    baseSupport: overrides?.baseSupport ?? 'full_transcript',
    ...(overrides?.maxRepeats !== undefined ? { maxRepeats: overrides.maxRepeats } : {}),
  });
}

async function shadowingActivity(ctx: TestContext): Promise<ShadowingListeningActivity> {
  const session = await planDeepListeningSession(
    {
      weaknesses: { listWeaknesses: (id, limit) => ctx.weaknesses.listWeaknesses(id, limit) },
      vocabulary: ctx.vocabulary,
      expressions: ctx.expressions,
    },
    ctx.learnerId,
    {
      level: 'B1',
      learningGoals: [],
      speechRateCapability: resolveSpeechRateCapability(null),
      taskTypes: ['shadowing'],
      targetCount: 1,
      now: NOW,
    },
  );
  const activity = session.activities[0];
  if (!activity || activity.taskType !== 'shadowing') throw new Error('no shadowing activity');
  return activity;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

/* ================================================================== *
 * 13. invalid reduction mapping (shadowing source integrity)
 * ================================================================== */

describe('shadowing source integrity', () => {
  it('13. a shadowing chunk is never empty and never invented', async () => {
    const ctx = await createContext();
    const activity = await shadowingActivity(ctx);
    expect(activity.chunk.trim().length).toBeGreaterThan(0);
    expect(activity.canonicalWrittenForm.trim().length).toBeGreaterThan(0);
    expect(activity.maxRepeats).toBeGreaterThan(0);
    // Support is removed one step at a time, never instantly.
    expect(supportForAttempt('full_transcript', 1)).toBe('full_transcript');
    expect(supportForAttempt('full_transcript', 2)).toBe('partial_transcript');
    expect(supportForAttempt('full_transcript', 3)).toBe('audio_only');
    expect(maskedChunk(CHUNK, 'audio_only')).toBeNull();
    expect(maskedChunk(CHUNK, 'full_transcript')).toBe(CHUNK);
    expect(maskedChunk(CHUNK, 'partial_transcript')).toContain('…');
  });
});

/* ================================================================== *
 * 14. EXISTING recorder + STT path
 * ================================================================== */

describe('shadowing voice path', () => {
  it('14. shadowing uses the EXISTING recorder and STT provider', async () => {
    const recorder = fakeRecorder();
    let received: unknown = null;
    const stt = fakeStt(async (input) => {
      received = input;
      return { ok: true, transcript: CHUNK };
    });
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, { recorder, stt, now: NOW });

    expect(controller.voiceAvailable).toBe(true);
    const started = await controller.startRecording();
    expect(started.ok).toBe(true);
    expect(recorder.startCalls).toBe(1);

    const judged = await controller.stopAndJudge();
    expect('ok' in judged).toBe(false);
    if ('ok' in judged) throw new Error('expected an attempt');
    expect(judged.qualitative).toBe('matched');
    expect(judged.transcript).toBe(CHUNK);
    // The EXISTING recorder produced the audio the EXISTING STT consumed.
    expect(recorder.stopCalls).toBe(1);
    expect(stt.calls).toBe(1);
    expect(received).toMatchObject({ uri: 'file://recording.m4a', mimeType: 'audio/m4a' });
    expect(session.attemptCount).toBe(1);
    expect(session.replayCount).toBe(0);
  });

  it('14b. without a real voice path nothing is captured (no silent fallback)', async () => {
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, {});
    expect(controller.voiceAvailable).toBe(false);
    const started = await controller.startRecording();
    expect(started.ok).toBe(false);
    if (started.ok) throw new Error('expected a failure');
    expect(started.reason).toBe('voice-unavailable');
    expect(started.message).toBe(SHADOWING_VOICE_UNAVAILABLE_MESSAGE);
    expect(session.attemptCount).toBe(0);
  });
});

/* ================================================================== *
 * 15. EXISTING pronunciation path
 * ================================================================== */

describe('shadowing pronunciation integration', () => {
  it('15. an available pronunciation path judges the repeat qualitatively', async () => {
    const port = fakePort(outcome());
    const attempt = await runShadowingAttempt({
      chunk: CHUNK,
      transcript: 'Could you take a look at this when you have a minute?',
      port,
      now: NOW,
    });
    expect(port.calls).toBe(1);
    expect(attempt.evaluatedBy).toBe('pronunciation');
    expect(attempt.qualitative).toBe('matched');
    expect(attempt.feedbackLines).toContain('The rhythm and the ending sounded natural.');
    expect(attempt.judged).toBe(true);
  });

  it('15b. the service routes the port through the EXISTING pronunciation ownership', async () => {
    const ctx = await createContext();
    const port = fakePort(outcome({ analysis: {
      provider: 'fake-pronunciation',
      evidenceLevel: 'transcript_comparison',
      observations: [],
      overallIntelligibility: 'partially_clear',
    } }));
    const service = createService(ctx, { pronunciation: port });
    const session = sessionWith();
    const attempt = await service.submitShadowingAttempt(session, CHUNK, { now: NOW });
    expect(port.calls).toBe(1);
    expect(attempt.evaluatedBy).toBe('pronunciation');
    expect(attempt.qualitative).toBe('close');
    // Repetition itself never creates a listening weakness.
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
  });
});

/* ================================================================== *
 * 16–18. Provider failures never become learner evidence
 * ================================================================== */

describe('shadowing failure honesty', () => {
  it('16. a failed STT during shadowing creates no weakness', async () => {
    const ctx = await createContext();
    let weaknessesWritten = 0;
    const service = createService(ctx, { onWeakness: () => { weaknessesWritten += 1; } });
    const recorder = fakeRecorder();
    const stt = fakeStt(async () => ({ ok: false, error: 'No speech detected.' }));
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, {
      recorder,
      stt,
      // Even with a pronunciation port available, a failed transcription must
      // never reach it.
      port: fakePort(outcome()),
      now: NOW,
    });

    await controller.startRecording();
    const result = await controller.stopAndJudge();
    if (!('ok' in result) || result.ok) throw new Error('expected a failure');
    expect(result.reason).toBe('transcription-failed');
    expect(session.attemptCount).toBe(0);
    expect(weaknessesWritten).toBe(0);
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
    // Nothing was submitted to the existing service either.
    expect(await service.submitShadowingAttempt(session, null, { now: NOW })).toMatchObject({
      qualitative: 'insufficient_evidence',
      judged: false,
    });
    expect(weaknessesWritten).toBe(0);
  });

  it('16b. a throwing STT provider still creates nothing', async () => {
    const ctx = await createContext();
    const recorder = fakeRecorder();
    const stt = fakeStt(async () => {
      throw new Error('network down');
    });
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, { recorder, stt, now: NOW });
    await controller.startRecording();
    const result = await controller.stopAndJudge();
    if (!('ok' in result) || result.ok) throw new Error('expected a failure');
    expect(result.reason).toBe('transcription-failed');
    expect(session.attemptCount).toBe(0);
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
  });

  it('17. a failed TTS creates no learner weakness', async () => {
    const ctx = await createContext();
    let weaknessesWritten = 0;
    const service = createService(ctx, { onWeakness: () => { weaknessesWritten += 1; } });
    const tts = fakeTts(async () => {
      throw new Error('audio device busy');
    });
    const session = sessionWith();

    const played = await playShadowingChunk(tts, session, { rate: 1 });
    expect(played.ok).toBe(false);
    if (played.ok) throw new Error('expected a failure');
    expect(played.reason).toBe('speech-failed');
    // A failed play is not even a replay, and certainly not evidence.
    expect(session.replayCount).toBe(0);
    expect(session.attemptCount).toBe(0);
    expect(weaknessesWritten).toBe(0);
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);

    // No TTS at all is reported honestly instead of pretending it played.
    const missing = await playShadowingChunk(undefined, session);
    expect(missing.ok).toBe(false);
    expect(session.replayCount).toBe(0);

    // A successful play counts a replay only (practice, not performance).
    const working = fakeTts(async () => undefined);
    const play = await playShadowingChunk(working, session, { rate: 0.75 });
    expect(play.ok).toBe(true);
    expect(session.replayCount).toBe(1);
    expect(working.rates).toEqual([0.75]);
    expect(session.attemptCount).toBe(0);
    expect(weaknessesWritten).toBe(0);
    expect(service).toBeDefined();
  });

  it('18. an unavailable pronunciation layer never fabricates a score', async () => {
    // No port at all: the judgement stays local and qualitative.
    const local = await runShadowingAttempt({ chunk: CHUNK, transcript: 'completely different words', now: NOW });
    expect(local.evaluatedBy).toBe('local');
    expect(local.qualitative).toBe('different');
    expect(Object.keys(local).sort()).toEqual(
      ['evaluatedBy', 'feedbackLines', 'judged', 'qualitative', 'transcript'].sort(),
    );

    // A THROWING port falls back with an honest note, not an invented result.
    const failing: ShadowingPronunciationPort = {
      analyzeSpokenTurn: async () => {
        throw new Error('pronunciation engine offline');
      },
    };
    const fallback = await runShadowingAttempt({ chunk: CHUNK, transcript: CHUNK, port: failing });
    expect(fallback.evaluatedBy).toBe('local');
    expect(fallback.qualitative).toBe('matched');
    expect(fallback.feedbackLines).toContain(SHADOWING_PRONUNCIATION_UNAVAILABLE_NOTE);

    // A port that reports "insufficient evidence" is never upgraded to a score.
    const insufficient = await runShadowingAttempt({
      chunk: CHUNK,
      transcript: 'half a sentence',
      port: fakePort(
        outcome({
          analysis: {
            provider: 'fake-pronunciation',
            evidenceLevel: 'transcript_comparison',
            observations: [],
            insufficientEvidence: true,
          },
          feedbackLines: [],
          unavailable: true,
        }),
      ),
    });
    expect(insufficient.qualitative).toBe('insufficient_evidence');
    expect(insufficient.evaluatedBy).toBe('local');

    // No feedback line ever carries a number-as-score claim.
    for (const line of [...local.feedbackLines, ...fallback.feedbackLines, ...insufficient.feedbackLines]) {
      expect(line).not.toMatch(/\d+\s*%|\b\d+\s*\/\s*10\b|\bscore\b|\brating\b/i);
    }
  });

  it('18b. repetition is bounded and an empty repeat is not an attempt', async () => {
    const session = sessionWith({ maxRepeats: 2 });
    expect(session.exhausted).toBe(false);
    const empty = await session.submit(null);
    expect(empty.qualitative).toBe('insufficient_evidence');
    expect(session.attemptCount).toBe(0);
    expect(session.support).toBe('full_transcript');

    await session.submit(CHUNK);
    expect(session.attemptCount).toBe(1);
    expect(session.support).toBe('partial_transcript');
    await session.submit('something else entirely');
    expect(session.attemptCount).toBe(2);
    expect(session.exhausted).toBe(true);
    expect(session.support).toBe('audio_only');
    expect(session.visibleChunk).toBeNull();
  });

  it('18c. the shadowing controller never records anything on its own', async () => {
    const ctx = await createContext();
    const recorder = fakeRecorder();
    const stt = fakeStt(async () => ({ ok: true, transcript: CHUNK }));
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, { recorder, stt, now: NOW });
    await controller.startRecording();
    await controller.cancel();
    expect(session.attemptCount).toBe(0);
    expect(session.replayCount).toBe(0);
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
    expect(evaluateShadowingLocally(CHUNK, '').judged).toBe(false);
  });
});
