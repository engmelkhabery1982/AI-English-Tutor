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
  resolveVoiceInput,
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
    // Lexical match CHUNK owns qualitative category (matched)
    expect(attempt.qualitative).toBe('matched');
    // Repetition itself never creates a listening weakness.
    expect(await ctx.weaknesses.listWeaknesses(ctx.learnerId, 20)).toHaveLength(0);
  });

  it('15c. wrong words + clear pronunciation => different', async () => {
    const port = fakePort(outcome({
      analysis: {
        provider: 'fake-pronunciation',
        evidenceLevel: 'acoustic',
        observations: [],
        overallIntelligibility: 'clear',
      },
      feedbackLines: ['The rhythm and the ending sounded natural.'],
    }));
    const attempt = await runShadowingAttempt({
      chunk: CHUNK,
      transcript: 'Completely different phrase here',
      port,
      now: NOW,
    });
    expect(attempt.qualitative).toBe('different');
    expect(attempt.evaluatedBy).toBe('pronunciation');
    expect(attempt.feedbackLines).toContain('The rhythm and the ending sounded natural.');
  });

  it('15d. close words + clear pronunciation => close', async () => {
    const port = fakePort(outcome({
      analysis: {
        provider: 'fake-pronunciation',
        evidenceLevel: 'acoustic',
        observations: [],
        overallIntelligibility: 'clear',
      },
      feedbackLines: ['Clear and natural speech.'],
    }));
    // Slight variation in one word
    const attempt = await runShadowingAttempt({
      chunk: CHUNK,
      transcript: 'Could you take a look at that when you have a minute?',
      port,
      now: NOW,
    });
    expect(attempt.qualitative).toBe('close');
    expect(attempt.evaluatedBy).toBe('pronunciation');
    expect(attempt.feedbackLines).toContain('Clear and natural speech.');
  });

  it('15e. exact words + unclear pronunciation => content matched, plus pronunciation warning', async () => {
    const port = fakePort(outcome({
      analysis: {
        provider: 'fake-pronunciation',
        evidenceLevel: 'acoustic',
        observations: [],
        overallIntelligibility: 'unclear',
      },
      feedbackLines: [],
    }));
    const attempt = await runShadowingAttempt({
      chunk: CHUNK,
      transcript: CHUNK,
      port,
      now: NOW,
    });
    expect(attempt.qualitative).toBe('matched');
    expect(attempt.evaluatedBy).toBe('pronunciation');
    expect(attempt.feedbackLines.some((l) => /unclear|clarity|articulate/i.test(l))).toBe(true);
  });

  it('15f. pronunciation unavailable => local match remains', async () => {
    const port = fakePort(outcome({
      unavailable: true,
      analysis: {
        provider: 'fake-pronunciation',
        evidenceLevel: 'transcript_comparison',
        observations: [],
        insufficientEvidence: true,
      },
    }));
    const matchedAttempt = await runShadowingAttempt({
      chunk: CHUNK,
      transcript: CHUNK,
      port,
    });
    expect(matchedAttempt.qualitative).toBe('matched');
    expect(matchedAttempt.evaluatedBy).toBe('local');

    const diffAttempt = await runShadowingAttempt({
      chunk: CHUNK,
      transcript: 'random nonsense',
      port,
    });
    expect(diffAttempt.qualitative).toBe('different');
    expect(diffAttempt.evaluatedBy).toBe('local');
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

    // A port that reports "unavailable" leaves the local qualitative match intact.
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
    expect(insufficient.qualitative).toBe('different');
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
    // Support reduction is earned: 'different' retains current support level
    expect(session.support).toBe('partial_transcript');
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

/* ================================================================== *
 * 19. Support progression policy (Blocker 4)
 * ================================================================== */

describe('shadowing support progression policy', () => {
  it('19a. attempt with different retains support', async () => {
    const session = sessionWith({ baseSupport: 'full_transcript' });
    expect(session.support).toBe('full_transcript');

    await session.submit('completely wrong text');
    expect(session.attemptCount).toBe(1);
    expect(session.support).toBe('full_transcript');

    await session.submit('still wrong text');
    expect(session.attemptCount).toBe(2);
    expect(session.support).toBe('full_transcript');
  });

  it('19b. attempt with matched steps down support by one level', async () => {
    const session = sessionWith({ baseSupport: 'full_transcript' });
    expect(session.support).toBe('full_transcript');

    await session.submit(CHUNK);
    expect(session.attemptCount).toBe(1);
    expect(session.support).toBe('partial_transcript');

    await session.submit(CHUNK);
    expect(session.attemptCount).toBe(2);
    expect(session.support).toBe('audio_only');
  });

  it('19c. multiple close attempts progress conservatively', async () => {
    const session = sessionWith({ baseSupport: 'full_transcript' });
    // Single close attempt does not step down support
    await session.submit('Could you take a look at that when you have a minute?');
    expect(session.transcript?.qualitative).toBe('close');
    expect(session.support).toBe('full_transcript');

    // Second consecutive close attempt earns one level step down
    await session.submit('Could you take a look at this when you got a minute?');
    expect(session.transcript?.qualitative).toBe('close');
    expect(session.support).toBe('partial_transcript');
  });

  it('19d. support never skips levels', async () => {
    const session = sessionWith({ baseSupport: 'full_transcript' });
    expect(session.support).toBe('full_transcript');

    // Matched steps down only to partial_transcript, never straight to audio_only
    await session.submit(CHUNK);
    expect(session.support).toBe('partial_transcript');

    // Next matched steps down to audio_only
    await session.submit(CHUNK);
    expect(session.support).toBe('audio_only');

    // Further matched remains at audio_only
    await session.submit(CHUNK);
    expect(session.support).toBe('audio_only');
  });

  it('19e. replays and insufficient evidence do not reduce support', async () => {
    const session = sessionWith({ baseSupport: 'full_transcript' });
    session.recordReplay();
    session.recordReplay();
    expect(session.replayCount).toBe(2);
    expect(session.support).toBe('full_transcript');

    await session.submit(null);
    await session.submit('');
    expect(session.support).toBe('full_transcript');
  });
});

/* ================================================================== *
 * 20. Shadowing voice controller lifecycle & race safety (Blocker 3)
 * ================================================================== */

describe('shadowing voice controller lifecycle', () => {
  it('20a. switching away / disposing cancels active recording', async () => {
    const recorder = fakeRecorder();
    const stt = fakeStt(async () => ({ ok: true, transcript: CHUNK }));
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, { recorder, stt });

    await controller.startRecording();
    expect(recorder.isRecording()).toBe(true);

    await controller.dispose();
    expect(recorder.isRecording()).toBe(false);
    expect(session.attemptCount).toBe(0);
  });

  it('20b. late STT/transcription does not land after dispose', async () => {
    let finishTranscription: ((value: { ok: true; transcript: string }) => void) | null = null;
    let transcriptionStartedResolve!: () => void;
    const transcriptionStarted = new Promise<void>((resolve) => {
      transcriptionStartedResolve = resolve;
    });

    const recorder = fakeRecorder();
    const stt: SpeechToTextProvider = {
      id: 'fake-stt',
      transcribe: () =>
        new Promise((resolve) => {
          finishTranscription = resolve;
          transcriptionStartedResolve();
        }),
    };
    const session = sessionWith();
    let submitted = false;
    const controller = new ShadowingVoiceController(session, {
      recorder,
      stt,
      submit: async (text) => {
        submitted = true;
        return session.submit(text);
      },
    });

    await controller.startRecording();
    const judgingPromise = controller.stopAndJudge();

    // Wait until STT transcribe has actually started
    await transcriptionStarted;

    // User switches activity or unmounts while STT is pending
    await controller.dispose();

    // Now STT resolves late
    finishTranscription!({ ok: true, transcript: CHUNK });
    const result = await judgingPromise;

    expect(submitted).toBe(false);
    expect(session.attemptCount).toBe(0);
    expect('ok' in result && result.ok === false).toBe(true);
  });

  it('20c. disposing controller prevents subsequent startRecording', async () => {
    const recorder = fakeRecorder();
    const stt = fakeStt(async () => ({ ok: true, transcript: CHUNK }));
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, { recorder, stt });

    await controller.dispose();
    const started = await controller.startRecording();
    expect(started.ok).toBe(false);
    expect(recorder.isRecording()).toBe(false);
  });
});

/* ================================================================== *
 * 21. Shadowing voice composition & provider resolution (Blocker 1)
 * ================================================================== */

describe('shadowing voice composition (Blocker 1)', () => {
  it('21a. injected recorder/STT win', async () => {
    const injectedRecorder = fakeRecorder();
    const injectedStt = fakeStt(async () => ({ ok: true, transcript: CHUNK }));
    const resolved = await resolveVoiceInput(injectedRecorder, injectedStt);
    expect(resolved).not.toBeNull();
    expect(resolved?.recorder).toBe(injectedRecorder);
    expect(resolved?.stt).toBe(injectedStt);
  });

  it('21b. missing Gemini key => honest unavailable state', async () => {
    const prevKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    const prevApiKey = process.env.GEMINI_API_KEY;
    try {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      const resolved = await resolveVoiceInput(undefined, undefined);
      expect(resolved).toBeNull();

      const session = sessionWith();
      const controller = new ShadowingVoiceController(session, {});
      expect(controller.voiceAvailable).toBe(false);

      const started = await controller.startRecording();
      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.reason).toBe('voice-unavailable');
        expect(started.message).toBe(SHADOWING_VOICE_UNAVAILABLE_MESSAGE);
      }
    } finally {
      if (prevKey !== undefined) process.env.EXPO_PUBLIC_GEMINI_API_KEY = prevKey;
      if (prevApiKey !== undefined) process.env.GEMINI_API_KEY = prevApiKey;
    }
  });

  it('21c. available real composition => controller becomes voiceAvailable', async () => {
    const prevKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    try {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = 'test-gemini-key';
      const resolved = await resolveVoiceInput(undefined, undefined);
      expect(resolved).not.toBeNull();
      expect(resolved?.recorder).toBeDefined();
      expect(resolved?.stt).toBeDefined();

      const session = sessionWith();
      const controller = new ShadowingVoiceController(session, {
        recorder: resolved!.recorder,
        stt: resolved!.stt,
      });
      expect(controller.voiceAvailable).toBe(true);
    } finally {
      if (prevKey !== undefined) process.env.EXPO_PUBLIC_GEMINI_API_KEY = prevKey;
      else delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    }
  });

  it('21d. Record tap actually begins recording', async () => {
    const recorder = fakeRecorder();
    const stt = fakeStt(async () => ({ ok: true, transcript: CHUNK }));
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, { recorder, stt });

    expect(recorder.isRecording()).toBe(false);
    const started = await controller.startRecording();
    expect(started.ok).toBe(true);
    expect(recorder.isRecording()).toBe(true);
    expect(recorder.startCalls).toBe(1);
  });

  it('21e. no fake/demo transcript is produced on failure', async () => {
    const recorder = fakeRecorder();
    const stt = fakeStt(async () => ({ ok: false, error: 'Network error' }));
    const session = sessionWith();
    const controller = new ShadowingVoiceController(session, { recorder, stt });

    await controller.startRecording();
    const result = await controller.stopAndJudge();
    expect('ok' in result && result.ok === false).toBe(true);
    if ('ok' in result && !result.ok) {
      expect(result.reason).toBe('transcription-failed');
    }
    // No attempt was logged, no fake transcript was invented
    expect(session.attemptCount).toBe(0);
    expect(session.transcript).toBeNull();
  });
});
