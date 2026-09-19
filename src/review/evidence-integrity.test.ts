/**
 * src/review/evidence-integrity.test.ts
 *
 * Runtime tests for the Review evidence + lifecycle integrity guarantees:
 *
 *   1. real Review with no real STT never produces a transcript;
 *   2. real Review with no real AI never fabricates an evaluation;
 *   3. explicit Demo Mode stays isolated from real learner evidence;
 *   4. the pre-built demo cards are unreachable in real mode;
 *   5. unmount during STT discards the late transcript (nothing persists);
 *   6. an item switch during STT keeps the old transcript out of the new item;
 *   7. repeated mic/stop/submit taps perform exactly one operation;
 *   8. repeated attempts are distinct, legitimate evidence;
 *   9. a retry of the SAME attempt is not duplicated;
 *  10. evidence identity is deterministic (no randomness, valid UUIDs).
 *
 * Persistence assertions run against a real SqlJsAdapter through the REAL
 * repositories and the production composition (`createReviewService`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createReviewService } from './factory';
import type { ReviewService } from './service';
import { ReviewVoiceController } from './voice-controller';
import {
  REVIEW_VOICE_UNAVAILABLE_MESSAGE,
  resolveReviewProviders,
} from './providers';
import {
  DEMO_REVIEW_LEARNER_ID,
  selectReviewSessionCandidates,
} from './demo-items';
import {
  deriveReviewAttemptKey,
  deriveReviewEvidenceId,
} from './evidence-identity';
import { evaluateOpenEndedLocally } from './evaluator';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { isValidUuid, generateId } from '../shared/id';
import type { AudioRecorderService, SpeechToTextProvider } from '../talk-demo';
import type { EvaluationResult, ReviewItemCandidate } from './types';

function createSpyRecorder(overrides: Partial<AudioRecorderService> = {}): AudioRecorderService {
  const recorder: AudioRecorderService = {
    requestPermissions: vi.fn(async () => true),
    hasPermissions: vi.fn(async () => true),
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async () => ({
      uri: 'file:///tmp/attempt.m4a',
      base64: 'YXVkaW8=',
      mimeType: 'audio/m4a',
      durationMs: 900,
    })),
    isRecording: vi.fn(() => false),
    getElapsedSeconds: vi.fn(() => 0),
    ...overrides,
  };
  return recorder;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function buildGrammarCandidate(input: {
  learnerId: string;
  referenceId: string;
  id?: string;
  prompt?: string;
  expectedAnswer?: string;
  contextSentence?: string;
  reviewCount?: number;
}): ReviewItemCandidate {
  return {
    id: input.id ?? generateId(),
    learnerId: input.learnerId,
    kind: 'grammar',
    exerciseType: 'sentence_correction',
    referenceId: input.referenceId,
    prompt: input.prompt ?? 'Correct the grammatical error in this sentence:',
    contextSentence: input.contextSentence ?? 'She walk to school.',
    expectedAnswer: input.expectedAnswer ?? 'She walks to school.',
    alternativeAnswers: [],
    explanation: 'Third person singular adds -s.',
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    severity: 0.6,
    status: 'confirmed',
    consecutiveCorrect: 0,
    reviewCount: input.reviewCount ?? 0,
  };
}

describe('Review evidence integrity — providers stay honest', () => {
  it('1. real Review with no real STT never produces a transcript', async () => {
    const providers = resolveReviewProviders({ isDemo: false, apiKey: null });

    expect(providers.kind).toBe('unavailable');
    expect(providers.sttProvider.id).not.toBe(createDemoSTTProvider().id);
    expect(providers.voiceUnavailableMessage).toBe(REVIEW_VOICE_UNAVAILABLE_MESSAGE);

    const recorder = createSpyRecorder();
    const stt: SpeechToTextProvider = {
      id: 'must-not-run',
      transcribe: vi.fn(async () => ({ ok: true, transcript: 'fabricated transcript' })),
    };
    const controller = new ReviewVoiceController(recorder, providers.sttProvider, {
      unavailable: providers.kind === 'unavailable',
      unavailableMessage: providers.voiceUnavailableMessage ?? null,
    });

    const status = await controller.toggleRecording();

    expect(status.transcript).toBe('');
    expect(controller.userAnswer).toBe('');
    expect(status.error).toBe(REVIEW_VOICE_UNAVAILABLE_MESSAGE);
    expect(recorder.startRecording).not.toHaveBeenCalled();
    expect(stt.transcribe).not.toHaveBeenCalled();
  });

  it('2. real Review with no real AI never fabricates an evaluation', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();

    const providers = resolveReviewProviders({ isDemo: false, apiKey: null });
    expect(providers.aiProvider).toBeUndefined();

    const service = createReviewService(adapter, false);
    const candidate: ReviewItemCandidate = {
      id: generateId(),
      learnerId: '1ef907b7-6c12-4ead-8f9a-c97bd31e83f3',
      kind: 'grammar',
      exerciseType: 'sentence_correction',
      referenceId: generateId(),
      prompt: 'Correct the grammatical error in this sentence:',
      contextSentence: 'I am interested on learning English.',
      expectedAnswer: 'I am interested in learning English.',
      alternativeAnswers: [],
      dueAt: new Date().toISOString(),
      consecutiveCorrect: 0,
      reviewCount: 0,
    };

    const evaluation = await service.evaluateAnswer(candidate, 'Completely unrelated answer.');

    // The offline DEMO tutor's scripted verdicts must never stand in for real grading.
    expect(evaluation.feedback).not.toBe('Good job!');
    expect(evaluation.explanation).not.toBe('Demo explanation.');
    // The EXISTING deterministic evaluator is what actually grades here.
    expect(evaluation).toEqual(evaluateOpenEndedLocally(candidate, 'Completely unrelated answer.'));
  });
});

describe('Review evidence integrity — demo isolation and reachability', () => {
  it('3. explicit Demo Mode is isolated from real learner evidence', async () => {
    const real = buildGrammarCandidate({
      learnerId: '1ef907b7-6c12-4ead-8f9a-c97bd31e83f3',
      referenceId: generateId(),
    });

    // Real mode returns exactly the planner output — never demo cards.
    expect(selectReviewSessionCandidates({ isDemo: false, planned: [] })).toEqual([]);
    expect(selectReviewSessionCandidates({ isDemo: false, planned: [real] })).toEqual([real]);

    // Demo mode returns only demo cards, under the demo learner identity.
    const demoItems = selectReviewSessionCandidates({ isDemo: true, planned: [real] });
    expect(demoItems.length).toBeGreaterThan(0);
    for (const item of demoItems) {
      expect(item.learnerId).toBe(DEMO_REVIEW_LEARNER_ID);
      expect(item.id.startsWith('demo-')).toBe(true);
      expect(item.id).not.toBe(real.id);
    }
    // The demo learner identity can never pass real repository validation.
    expect(isValidUuid(DEMO_REVIEW_LEARNER_ID)).toBe(false);

    // And the demo path writes nothing: evaluate a demo card through the demo
    // service and assert the real tables stay empty.
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profile = await new SQLiteUserProfileRepository(adapter).update({
      displayName: 'Real Learner',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    });
    const demoService = createReviewService(adapter, true);
    const demoCard = demoItems[0];
    await demoService.evaluateAnswer(demoCard, demoCard.expectedAnswer);

    for (const table of ['review_items', 'review_history', 'weakness_evidence', 'learner_weaknesses']) {
      const rows = await adapter.query(`SELECT COUNT(*) AS total FROM ${table}`);
      expect(Number(rows[0].total)).toBe(0);
    }
    expect(profile.id).toBeTruthy();
  });

  it('4. the pre-built demo cards are unreachable in real mode', async () => {
    const adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profile = await new SQLiteUserProfileRepository(adapter).update({
      displayName: 'Real Learner',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    });

    const service = createReviewService(adapter, false);

    // Nothing in the real learner's history yet: an honest empty queue.
    expect(await service.planSession(profile.id)).toEqual([]);

    // With a real due item, only that item is planned — no demo ids.
    await new SQLiteReviewRepository(adapter).upsert({
      id: generateId(),
      learnerId: profile.id,
      kind: 'grammar',
      referenceId: generateId(),
      prompt: 'Correct the grammatical error in this sentence:',
      expectedResponse: 'She walks to school.',
      state: 'learning',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    const planned = await service.planSession(profile.id);
    expect(planned.length).toBeGreaterThan(0);
    for (const candidate of planned) {
      expect(candidate.id.startsWith('demo-')).toBe(false);
      expect(candidate.learnerId).toBe(profile.id);
      expect(candidate.learnerId).not.toBe(DEMO_REVIEW_LEARNER_ID);
    }
  });
});

describe('Review evidence integrity — voice lifecycle', () => {
  it('5. unmount during STT discards the late transcript and persists nothing', async () => {
    const sttResult = deferred<{ ok: true; transcript: string }>();
    const stt: SpeechToTextProvider = {
      id: 'deferred-stt',
      transcribe: vi.fn(() => sttResult.promise),
    };
    const recorder = createSpyRecorder();
    const controller = new ReviewVoiceController(recorder, stt);
    /** Mirrors the screen: persistence only happens for a delivered transcript. */
    const persist = vi.fn();

    await controller.toggleRecording(); // start
    const stopping = controller.toggleRecording(); // stop → STT pending
    // Let the recorder stop land so the STT request is genuinely in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.dispose(); // the learner left the screen

    sttResult.resolve({ ok: true, transcript: 'answer from the abandoned attempt' });
    const status = await stopping;

    if (status.transcript) {
      persist(status.transcript);
    }

    expect(controller.isDisposed).toBe(true);
    expect(controller.userAnswer).toBe('');
    expect(status.transcript).toBe('');
    expect(stt.transcribe).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  it('6. an item switch during STT keeps the old transcript out of the new item', async () => {
    // Each transcription is resolved explicitly, so the "late callback" order
    // is deterministic rather than a race.
    const pending: Array<(value: { ok: true; transcript: string }) => void> = [];
    const transcribe = vi.fn<SpeechToTextProvider['transcribe']>(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const stt: SpeechToTextProvider = { id: 'sequenced-stt', transcribe };
    const controller = new ReviewVoiceController(createSpyRecorder(), stt);

    await controller.toggleRecording(); // start on item A
    const stoppingOld = controller.toggleRecording(); // stop on item A → STT in flight
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transcribe).toHaveBeenCalledTimes(1);

    controller.reset(); // the learner moved to item B

    // Item B records and transcribes first…
    await controller.toggleRecording(); // start on B
    const stoppingNew = controller.toggleRecording(); // stop on B
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transcribe).toHaveBeenCalledTimes(2);
    pending[1]({ ok: true, transcript: 'answer for the new item' });
    await stoppingNew;

    // …and only THEN does the abandoned item-A transcript arrive.
    pending[0]({ ok: true, transcript: 'answer for the abandoned item A' });
    await stoppingOld;

    expect(controller.userAnswer).toBe('answer for the new item');
  });

  it('7. repeated mic / stop taps perform exactly one operation each', async () => {
    const sttResult = deferred<{ ok: true; transcript: string }>();
    const stt: SpeechToTextProvider = {
      id: 'deferred-stt',
      transcribe: vi.fn(() => sttResult.promise),
    };
    const recorder = createSpyRecorder();
    const controller = new ReviewVoiceController(recorder, stt);

    // Double mic tap: only one recording may start.
    const firstStart = controller.toggleRecording();
    const secondStart = controller.toggleRecording();
    await Promise.all([firstStart, secondStart]);
    expect(recorder.startRecording).toHaveBeenCalledTimes(1);
    expect(controller.isRecording).toBe(true);

    // Double stop tap: only one stop + one transcription.
    const firstStop = controller.toggleRecording();
    const secondStop = controller.toggleRecording();
    sttResult.resolve({ ok: true, transcript: 'single transcription' });
    await Promise.all([firstStop, secondStop]);

    expect(recorder.stopRecording).toHaveBeenCalledTimes(1);
    expect(stt.transcribe).toHaveBeenCalledTimes(1);
    expect(controller.userAnswer).toBe('single transcription');
  });
});

describe('Review evidence integrity — attempt identity', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;
  let service: ReviewService;
  let referenceId: string;
  let candidate: ReviewItemCandidate;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profile = await new SQLiteUserProfileRepository(adapter).update({
      displayName: 'Real Learner',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    });
    learnerId = profile.id;

    referenceId = generateId();
    const weakness = await new SQLiteWeaknessRepository(adapter).upsertWeakness({
      learnerId,
      type: 'grammar',
      referenceId,
      severity: 0.6,
      status: 'active_training',
      firstSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
      lastSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
      occurrenceCount: 1,
      contexts: [],
      evidence: [],
      notes: 'Third person singular',
      resolved: false,
    });

    await new SQLiteReviewRepository(adapter).upsert({
      id: generateId(),
      learnerId,
      kind: 'grammar',
      referenceId,
      prompt: 'Correct the grammatical error in this sentence:',
      expectedResponse: 'She walks to school.',
      state: 'learning',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    candidate = buildGrammarCandidate({ learnerId, referenceId });
    service = createReviewService(adapter, false);
    expect(weakness.id).toBeTruthy();
  });

  const evaluation: EvaluationResult = { result: 'correct', feedback: 'Well done.' };

  async function evidenceRows() {
    return adapter.query('SELECT id, weakness_id, summary FROM weakness_evidence ORDER BY id');
  }
  async function reviewRow() {
    const rows = await adapter.query('SELECT review_count, outcome_history FROM review_items');
    return rows[0];
  }
  async function historyCount() {
    const rows = await adapter.query('SELECT COUNT(*) AS total FROM review_history');
    return Number(rows[0].total);
  }

  it('8. repeated attempts are distinct, legitimate evidence', async () => {
    await service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId: 'attempt-one',
    });
    await service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId: 'attempt-two',
    });

    const rows = await evidenceRows();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    for (const row of rows) {
      expect(isValidUuid(String(row.id))).toBe(true);
    }
    expect(Number((await reviewRow()).review_count)).toBe(2);
    expect(await historyCount()).toBe(2);
  });

  it('9. a retry of the SAME attempt is not duplicated', async () => {
    const attemptId = 'retry-same-attempt';
    await service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId,
    });
    // A retry (double submit, retried save) delivers the SAME attempt again.
    await service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId,
    });

    const rows = await evidenceRows();
    expect(rows).toHaveLength(1);
    expect(Number((await reviewRow()).review_count)).toBe(1);
    expect(await historyCount()).toBe(1);
  });

  it('9b. concurrent double submission of one attempt writes once', async () => {
    await Promise.all([
      service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
        attemptId: 'double-tap',
      }),
      service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
        attemptId: 'double-tap',
      }),
    ]);

    expect(await evidenceRows()).toHaveLength(1);
    expect(Number((await reviewRow()).review_count)).toBe(1);
    expect(await historyCount()).toBe(1);
  });

  it('10. evidence identity is deterministic and retry-safe by construction', () => {
    const parts = [learnerId, referenceId, 'attempt-one'];
    expect(deriveReviewEvidenceId(parts)).toBe(deriveReviewEvidenceId(parts));
    expect(isValidUuid(deriveReviewEvidenceId(parts))).toBe(true);
    expect(deriveReviewEvidenceId(parts)).not.toBe(
      deriveReviewEvidenceId([learnerId, referenceId, 'attempt-two']),
    );

    const attempt = {
      learnerId,
      referenceId,
      candidateId: candidate.id,
      reviewCount: candidate.reviewCount,
      consecutiveCorrect: candidate.consecutiveCorrect,
      userAnswer: 'She walks to school.',
      result: 'correct' as const,
    };
    // Same attempt → same key (a retry collapses); different attempt id → new key.
    expect(deriveReviewAttemptKey({ ...attempt, attemptId: 'a' })).toBe(
      deriveReviewAttemptKey({ ...attempt, attemptId: 'a' }),
    );
    expect(deriveReviewAttemptKey({ ...attempt, attemptId: 'a' })).not.toBe(
      deriveReviewAttemptKey({ ...attempt, attemptId: 'b' }),
    );
  });
});

describe('Review voice lifecycle — teardown serialization', () => {
  function createRealisticRecorder(stopDelayMs = 40): {
    recorder: AudioRecorderService;
    getRecording: () => boolean;
    getStopCount: () => number;
  } {
    let recording = false;
    let stopCount = 0;
    const recorder: AudioRecorderService = {
      requestPermissions: vi.fn(async () => true),
      hasPermissions: vi.fn(async () => true),
      startRecording: vi.fn(async () => {
        if (recording) {
          throw new Error('Recording is already in progress');
        }
        recording = true;
      }),
      stopRecording: vi.fn(async () => {
        stopCount += 1;
        await new Promise((resolve) => setTimeout(resolve, stopDelayMs));
        recording = false;
        return {
          uri: 'file:///tmp/attempt.m4a',
          base64: 'YXVkaW8=',
          mimeType: 'audio/m4a',
          durationMs: 900,
        };
      }),
      isRecording: vi.fn(() => recording),
      getElapsedSeconds: vi.fn(() => 0),
    };
    return {
      recorder,
      getRecording: () => recording,
      getStopCount: () => stopCount,
    };
  }

  it('11. reset while recording → immediate new mic waits for old stop then succeeds', async () => {
    const { recorder } = createRealisticRecorder(50);
    const stt: SpeechToTextProvider = {
      id: 'fast-stt',
      transcribe: vi.fn(async () => ({ ok: true, transcript: 'new answer' })),
    };
    const controller = new ReviewVoiceController(recorder, stt);

    await controller.toggleRecording();
    expect(controller.isRecording).toBe(true);

    const beforeReset = Date.now();
    controller.reset();

    // Fast UI: synchronous invalidation
    expect(controller.isRecording).toBe(false);
    expect(controller.isBusy).toBe(false);
    expect(controller.userAnswer).toBe('');
    expect(recorder.stopRecording).toHaveBeenCalledTimes(1);

    // Immediate replacement mic must wait for pending teardown, then succeed
    const startPromise = controller.toggleRecording();
    const elapsedBeforeAwait = Date.now() - beforeReset;
    expect(elapsedBeforeAwait).toBeLessThan(20);

    const status = await startPromise;
    expect(status.isRecording).toBe(true);
    expect(status.state).toBe('recording');
    expect(status.error).toBeNull();
    expect(recorder.startRecording).toHaveBeenCalledTimes(2);
  });

  it('12. reset while recording → no "already recording" error on immediate restart', async () => {
    const { recorder } = createRealisticRecorder(60);
    const stt: SpeechToTextProvider = {
      id: 'fast-stt',
      transcribe: vi.fn(async () => ({ ok: true, transcript: 'answer' })),
    };
    const controller = new ReviewVoiceController(recorder, stt);

    await controller.toggleRecording();
    controller.reset();

    const status = await controller.toggleRecording();
    expect(status.isRecording).toBe(true);
    expect(status.error).toBeNull();
    expect(status.error?.includes('already')).toBeFalsy();
    // Even if the underlying recorder would throw when overlapping, controller serialized it
    expect(recorder.startRecording).toHaveBeenCalledTimes(2);
    expect((recorder.startRecording as ReturnType<typeof vi.fn>).mock.results.some((r) => r.type === 'throw')).toBe(false);
  });

  it('13. old transcript cannot land in new item after reset while recording', async () => {
    const pending: Array<(value: { ok: true; transcript: string }) => void> = [];
    const transcribe = vi.fn(
      () =>
        new Promise<{ ok: true; transcript: string }>((resolve) => {
          pending.push(resolve);
        }),
    );
    const stt: SpeechToTextProvider = { id: 'deferred-stt', transcribe };
    const { recorder } = createRealisticRecorder(15);
    const controller = new ReviewVoiceController(recorder, stt);

    // Attempt A: record + stop → STT pending[0]
    await controller.toggleRecording();
    const stoppingA = controller.toggleRecording();
    // Wait for stopRecording (15ms) to finish so transcribe is invoked
    await new Promise((r) => setTimeout(r, 25));
    expect(transcribe).toHaveBeenCalledTimes(1);

    // Abandon A via reset (clears busy, invalidates its transcript)
    controller.reset();
    expect(controller.isBusy).toBe(false);
    expect(controller.userAnswer).toBe('');

    // Attempt B: start and immediately reset WHILE recording
    await controller.toggleRecording();
    expect(controller.isRecording).toBe(true);
    controller.reset(); // abort B mid-recording, bump generation, track teardown
    expect(controller.isRecording).toBe(false);
    expect(controller.isBusy).toBe(false);

    // New item C: immediate new mic must wait for B's teardown, then record
    const startC = controller.toggleRecording(); // should await B's stop
    const statusC = await startC;
    expect(statusC.isRecording).toBe(true);

    const stoppingC = controller.toggleRecording(); // stop C → STT pending[1]
    await new Promise((r) => setTimeout(r, 25));
    expect(transcribe).toHaveBeenCalledTimes(2);

    // C's transcript arrives first
    pending[1]({ ok: true, transcript: 'answer for new item C' });
    await stoppingC;
    expect(controller.userAnswer).toBe('answer for new item C');

    // A's late transcript must NOT overwrite C
    pending[0]({ ok: true, transcript: 'answer for abandoned A' });
    await stoppingA;

    expect(controller.userAnswer).toBe('answer for new item C');
  });

  it('14. dispose during recording remains terminal', async () => {
    const { recorder, getStopCount } = createRealisticRecorder(30);
    const stt: SpeechToTextProvider = {
      id: 'fast-stt',
      transcribe: vi.fn(async () => ({ ok: true, transcript: 'should be discarded' })),
    };
    const controller = new ReviewVoiceController(recorder, stt);

    await controller.toggleRecording();
    expect(controller.isRecording).toBe(true);

    controller.dispose();
    expect(controller.isDisposed).toBe(true);
    expect(controller.isRecording).toBe(false);
    expect(controller.isBusy).toBe(false);
    expect(controller.userAnswer).toBe('');
    expect(recorder.stopRecording).toHaveBeenCalledTimes(1);

    // Even if stop takes time, controller stays disposed and refuses new work
    const afterDispose = await controller.toggleRecording();
    expect(afterDispose.isDisposed).toBe(true);
    expect(afterDispose.isRecording).toBe(false);
    expect(afterDispose.transcript).toBe('');
    // startRecording should not be called after dispose
    expect(recorder.startRecording).toHaveBeenCalledTimes(1);

    // Wait for teardown to finish, still terminal
    await new Promise((r) => setTimeout(r, 50));
    expect(getStopCount()).toBe(1);
    expect(controller.isDisposed).toBe(true);
    const again = await controller.toggleRecording();
    expect(again.isDisposed).toBe(true);
  });

  it('15. repeated reset/dispose is safe and idempotent', async () => {
    const { recorder } = createRealisticRecorder(20);
    const stt: SpeechToTextProvider = {
      id: 'fast-stt',
      transcribe: vi.fn(async () => ({ ok: true, transcript: 'answer' })),
    };
    const controller = new ReviewVoiceController(recorder, stt);

    await controller.toggleRecording();
    expect(controller.isRecording).toBe(true);

    // Repeated resets while recording
    controller.reset();
    controller.reset();
    controller.reset();
    expect(controller.isRecording).toBe(false);
    expect(controller.isBusy).toBe(false);
    expect(() => controller.reset()).not.toThrow();

    // New recording after repeated resets must still work
    const statusAfterResets = await controller.toggleRecording();
    expect(statusAfterResets.isRecording).toBe(true);
    expect(statusAfterResets.error).toBeNull();

    // Repeated dispose
    controller.dispose();
    expect(controller.isDisposed).toBe(true);
    expect(() => controller.dispose()).not.toThrow();
    controller.dispose();
    controller.reset(); // reset after dispose is no-op
    expect(controller.isDisposed).toBe(true);
    expect(controller.isRecording).toBe(false);

    const after = await controller.toggleRecording();
    expect(after.isDisposed).toBe(true);
    expect(after.isRecording).toBe(false);
  });
});
