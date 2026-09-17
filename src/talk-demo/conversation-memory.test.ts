/**
 * src/talk-demo/conversation-memory.test.ts
 *
 * Conversation Learning Memory (Phase 1): persistent sessions + the qualitative
 * post-conversation review.
 *
 * These tests exercise the REAL existing systems: ConversationSession,
 * ConversationEngine, ConversationOrchestrator, SQLiteConversationRepository,
 * SQLiteWeaknessRepository / SQLiteReviewRepository, the existing
 * LearningPersistenceService and the existing LearnerModel — all on a real
 * SqlJsAdapter database. Nothing here is a second memory engine.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';
import { createConversationEngine } from '../conversation-engine';
import { createConversationOrchestrator } from '../conversation-orchestrator';
import { createConversationSession } from '../conversation-session';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteConversationRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { createDemoLearnerModel } from './demo-learner-model';
import { createLearningPersistenceService } from './learning-persistence';
import type { AIProvider, AIProviderResult, ConversationFeedback } from '../providers/ai';
import { createDemoSTTProvider } from '../providers/stt';
import { createDemoTTSProvider } from '../providers/tts/demo';
import { createDemoAudioRecorder } from '../voice/recorder';
import { createVoiceSessionCoordinator } from '../voice';
import {
  buildConversationReview,
  CONVERSATION_MEMORY_DEMO_NOTICE,
  CONVERSATION_MEMORY_FAILED_NOTICE,
  createConversationMemoryRecorder,
  createConversationMemoryService,
  finalizeConversationWithReview,
  stripHiddenFeedback,
  type ConversationMemoryRecorder,
} from './conversation-memory';
import { createTalkLearnerModel } from '.';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NOW = '2026-02-01T09:00:00.000Z';
const LATER = '2026-02-01T09:12:00.000Z';

/** Stub AI provider that answers with the given replies in order. */
function createStubProvider(
  replies: readonly string[],
): AIProvider & { readonly requests: readonly { userMessage?: string }[]; calls: number } {
  const state = { calls: 0 };
  const requests: { userMessage?: string }[] = [];
  return {
    id: 'stub-ai',
    requests,
    get calls() {
      return state.calls;
    },
    async generate(request): Promise<AIProviderResult> {
      const reply = replies[Math.min(state.calls, replies.length - 1)];
      state.calls += 1;
      requests.push({ userMessage: request.messages.at(-1)?.content });
      return { ok: true, response: { content: reply } };
    },
  };
}

/** Deferred provider: every reply is released manually. */
function createDeferredProvider(): AIProvider & { resolveNext: (content: string, feedback?: ConversationFeedback | null) => void } {
  const pending: ((result: AIProviderResult) => void)[] = [];
  return {
    id: 'deferred-ai',
    resolveNext: (content: string, feedback: ConversationFeedback | null = null) => {
      const resolve = pending.shift();
      resolve?.({ ok: true, response: { content, feedback } });
    },
    async generate(): Promise<AIProviderResult> {
      return new Promise<AIProviderResult>((resolve) => {
        pending.push(resolve);
      });
    },
  };
}

function buildSession(
  provider: AIProvider,
  options: { mode?: 'natural' | 'coach' | 'intensive'; topic?: string; onSaveVocabulary?: AIProvider extends never ? never : ((vocab: unknown) => Promise<void>) | undefined; learnerModel?: ReturnType<typeof createDemoLearnerModel> } = {},
) {
  const engine = createConversationEngine(options.learnerModel ?? createDemoLearnerModel());
  const orchestrator = createConversationOrchestrator(engine, provider);
  return createConversationSession(orchestrator, {
    mode: options.mode ?? 'natural',
    ...(options.topic ? { topic: options.topic } : {}),
    ...(options.onSaveVocabulary
      ? { onSaveVocabulary: options.onSaveVocabulary as never }
      : {}),
  });
}

async function seedLearner(adapter: SqlJsAdapter) {
  const profileRepo = new SQLiteUserProfileRepository(adapter);
  const profile = await profileRepo.update({
    displayName: 'Memory Learner',
    targetLanguage: 'en',
    currentLevel: 'B1',
    targetLevel: 'B2',
    learningGoals: ['Speak naturally at work'],
  });
  return profile.id;
}

const CORRECTION_FEEDBACK: ConversationFeedback = {
  correction: {
    original: 'Yesterday I go to the office',
    improved: 'Yesterday I went to the office',
    explanation: 'Use the past tense for finished actions.',
    severity: 'incorrect',
  },
  vocabulary: {
    headword: 'commute',
    type: 'word',
    meaning: 'to travel regularly between home and work',
    example: 'I commute by train every day.',
  },
  coachingNote: 'Watch past-tense endings.',
};

describe('Conversation learning memory — persistence', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    learnerId = await seedLearner(adapter);
  });

  it('1. a real committed Talk turn is persisted exactly once', async () => {
    const provider = createStubProvider(['Nice! What happened at the office?']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    const result = await session.send({ userMessage: 'Today I went to the office.' });
    expect(result.ok).toBe(true);

    const first = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(first.ok).toBe(true);
    expect(first.reason).toBe('persisted');
    expect(first.turnCount).toBe(2);

    // Repeated finalization (rerender, second press, unmount) never duplicates.
    const second = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(second.reason).toBe('already-finalized');

    const repo = new SQLiteConversationRepository(adapter);
    const sessions = await repo.listSessions(learnerId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('completed');
    expect(sessions[0].turnCount).toBe(2);
    const turns = await repo.listTurns(sessions[0].id);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.speaker)).toEqual(['learner', 'tutor']);
    expect(turns.map((turn) => turn.turnIndex)).toEqual([0, 1]);
  });

  it('2. multiple committed turns preserve conversation order', async () => {
    const provider = createStubProvider(['Reply one.', 'Reply two.', 'Reply three.']);
    const session = buildSession(provider, { topic: 'Office life' });
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    await session.send({ userMessage: 'First learner turn.' });
    await session.send({ userMessage: 'Second learner turn.' });
    await session.send({ userMessage: 'Third learner turn.' });

    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(true);
    expect(result.turnCount).toBe(6);

    const repo = new SQLiteConversationRepository(adapter);
    const sessions = await repo.listSessions(learnerId);
    expect(sessions[0].topic).toBe('Office life');
    const turns = await repo.listTurns(sessions[0].id);
    expect(turns.map((turn) => turn.speaker)).toEqual([
      'learner',
      'tutor',
      'learner',
      'tutor',
      'learner',
      'tutor',
    ]);
    expect(turns.map((turn) => turn.text)).toEqual([
      'First learner turn.',
      'Reply one.',
      'Second learner turn.',
      'Reply two.',
      'Third learner turn.',
      'Reply three.',
    ]);
  });

  it('3. the tutor opening instruction is never persisted as learner speech', async () => {
    const provider = createStubProvider([
      'Hello! What would you like to talk about?',
      'Reply one.',
    ]);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    const opening = await session.openConversation!({
      userMessage: 'Begin the conversation now: greet me briefly and ask one natural question.',
    });
    expect(opening.ok).toBe(true);

    // An opening-only conversation is not a learner conversation at all.
    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');

    const repo = new SQLiteConversationRepository(adapter);
    expect(await repo.listSessions(learnerId)).toHaveLength(0);
    expect(await repo.listTurns('00000000-0000-0000-0000-000000000000')).toEqual([]);
    // The learner turn that follows IS persisted as real learner speech.
    await session.send({ userMessage: 'I would like to talk about my job.' });
    const after = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(after.ok).toBe(true);
    const sessions = await repo.listSessions(learnerId);
    const turns = await repo.listTurns(sessions[0].id);
    expect(turns.map((turn) => turn.text)).toEqual([
      'Hello! What would you like to talk about?',
      'I would like to talk about my job.',
      'Reply one.',
    ]);
    expect(turns.some((turn) => turn.text.includes('Begin the conversation now'))).toBe(false);
  });

  it('4. a committed tutor opening is persisted only as a real assistant turn', async () => {
    const provider = createStubProvider([
      'Good evening! Tell me about your day.\n\n[FEEDBACK]\n{"correction":null,"vocabulary":null,"coachingNote":"greeting"}\n[/FEEDBACK]',
      'That sounds productive — what was the best part?',
    ]);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    await session.openConversation!({ userMessage: 'Begin the conversation now.' });
    await session.send({ userMessage: 'I finished a big report.' });
    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(true);

    const repo = new SQLiteConversationRepository(adapter);
    const sessions = await repo.listSessions(learnerId);
    const turns = await repo.listTurns(sessions[0].id);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ speaker: 'tutor', text: 'Good evening! Tell me about your day.' });
    expect(turns[1]).toMatchObject({ speaker: 'learner', text: 'I finished a big report.' });
    // Hidden structured feedback is never persisted as learner-facing text.
    for (const turn of turns) {
      expect(turn.text).not.toContain('[FEEDBACK]');
      expect(turn.text).not.toContain('coachingNote');
    }
  });

  it('5. a failed STT attempt persists nothing', async () => {
    const provider = createStubProvider(['Should never be reached.']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: {
        id: 'failing-stt',
        async transcribe() {
          return { ok: false, error: 'No speech detected.' };
        },
      },
      ttsProvider: createDemoTTSProvider(),
    });
    await coordinator.startRecording();
    const turn = await coordinator.stopRecordingAndProcess();
    expect(turn.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);

    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
    const repo = new SQLiteConversationRepository(adapter);
    expect(await repo.listSessions(learnerId)).toHaveLength(0);
  });

  it('6. a failed AI response persists nothing', async () => {
    const failing: AIProvider = {
      id: 'failing-ai',
      async generate() {
        return {
          ok: false,
          error: { code: 'unavailable', message: 'The tutor is unavailable.', retryable: true },
        };
      },
    };
    const session = buildSession(failing);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    const turn = await session.send({ userMessage: 'Hello there.' });
    expect(turn.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);

    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
    const repo = new SQLiteConversationRepository(adapter);
    expect(await repo.listSessions(learnerId)).toHaveLength(0);
  });

  it('7. a late AI result from an abandoned session persists nothing', async () => {
    const provider = createDeferredProvider();
    const session = buildSession(provider);
    const outgoing = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    const pending = session.send({ userMessage: 'This turn belongs to the old chat.' });
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    // The replacement begins: the old session is abandoned before teardown.
    const replacement = buildSession(createStubProvider(['Fresh.']));
    const installed = await coordinator.switchSession(replacement);
    expect(installed).toBe(replacement);

    provider.resolveNext('Late tutor reply from the replaced conversation.');
    const late = await pending;
    expect(late.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);

    // Finalizing the abandoned conversation stores nothing and claims nothing.
    const result = await service.finalizeConversation({
      session,
      recorder: outgoing,
      isRealAI: true,
      endedAt: LATER,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
    const repo = new SQLiteConversationRepository(adapter);
    expect(await repo.listSessions(learnerId)).toHaveLength(0);
  });

  it('8. a late STT result from an abandoned session persists nothing', async () => {
    const session = buildSession(createStubProvider(['Unused reply.']));
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    let releaseSTT: (() => void) | null = null;
    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: {
        id: 'gated-stt',
        async transcribe() {
          await new Promise<void>((resolve) => {
            releaseSTT = resolve;
          });
          return { ok: true, transcript: 'Late words from the old chat.' };
        },
      },
      ttsProvider: createDemoTTSProvider(),
    });

    await coordinator.startRecording();
    const pending = coordinator.stopRecordingAndProcess();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const replacement = buildSession(createStubProvider(['Fresh reply.']));
    await coordinator.switchSession(replacement);
    // The gate is set by the in-flight transcribe() above.
    (releaseSTT as unknown as (() => void) | null)?.();
    const late = await pending;

    expect(late.ok).toBe(false);
    expect(session.getHistory()).toEqual([]);
    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty');
  });

  it('9. replaying tutor audio creates no persistence and no duplicate turns', async () => {
    const provider = createStubProvider(['A reply worth replaying.']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
    const tts = createDemoTTSProvider();

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Please remember this.' }),
      ttsProvider: tts,
    });

    await coordinator.startRecording();
    const turn = await coordinator.stopRecordingAndProcess();
    expect(turn.ok).toBe(true);
    const historyBefore = session.getHistory();

    await coordinator.replayLastResponse();
    await coordinator.replayLastResponse();

    expect(session.getHistory()).toEqual(historyBefore);
    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.turnCount).toBe(2);

    const repo = new SQLiteConversationRepository(adapter);
    const sessions = await repo.listSessions(learnerId);
    const turns = await repo.listTurns(sessions[0].id);
    expect(turns).toHaveLength(2);
    // Replay produced extra speech, never extra memory.
    expect(tts.getSpokenTexts().length).toBeGreaterThanOrEqual(2);
  });

  it('10. repeated finalization and rerender create no duplicate session or turns', async () => {
    const provider = createStubProvider(['One reply.']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    await session.send({ userMessage: 'Only once, please.' });

    const results = await Promise.all([
      service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER }),
      service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER }),
      service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(3); // all report the SAME stored conversation
    const ids = new Set(results.map((result) => result.domainSessionId));
    expect(ids.size).toBe(1);

    // A brand-new service instance must not re-persist either (identity lives in
    // the recorder, not in React state).
    const fresh = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
    const again = await fresh.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(again.reason).toBe('already-finalized');

    const repo = new SQLiteConversationRepository(adapter);
    const sessions = await repo.listSessions(learnerId);
    expect(sessions).toHaveLength(1);
    expect(await repo.listTurns(sessions[0].id)).toHaveLength(2);
  });

  it('11. New Chat semantics finalize the previous meaningful conversation exactly once', async () => {
    const provider = createStubProvider(['First reply.', 'Second conversation reply.']);
    const conversationOne = buildSession(provider, { mode: 'natural' });
    const recorderOne = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    await conversationOne.send({ userMessage: 'Conversation one.' });
    // New Chat: finalize the outgoing conversation, then start the replacement.
    const finalized = await Promise.resolve().then(async () => {
      const result = await service.finalizeConversation({
        session: conversationOne,
        recorder: recorderOne,
        isRealAI: true,
        endedAt: LATER,
      });
      const conversationTwo = buildSession(provider, { mode: 'natural' });
      return { result, conversationTwo };
    });

    expect(finalized.result.reason).toBe('persisted');
    // A second New Chat on the SAME (now replaced) conversation cannot duplicate.
    const repeated = await service.finalizeConversation({
      session: conversationOne,
      recorder: recorderOne,
      isRealAI: true,
      endedAt: LATER,
    });
    expect(repeated.reason).toBe('already-finalized');

    await finalized.conversationTwo.send({ userMessage: 'Conversation two.' });
    const recorderTwo = createConversationMemoryRecorder({ startedAt: LATER });
    const second = await service.finalizeConversation({
      session: finalized.conversationTwo,
      recorder: recorderTwo,
      isRealAI: true,
      endedAt: LATER,
    });
    expect(second.reason).toBe('persisted');

    const repo = new SQLiteConversationRepository(adapter);
    const sessions = await repo.listSessions(learnerId);
    expect(sessions).toHaveLength(2);
    expect(await repo.listTurns(sessions[0].id)).toHaveLength(2);
    expect(await repo.listTurns(sessions[1].id)).toHaveLength(2);
  });

  it('12. a mode change finalizes the previous conversation once, in its own mode', async () => {
    const provider = createStubProvider(['Natural reply.', 'Coach reply.']);
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    const natural = buildSession(provider, { mode: 'natural' });
    const naturalRecorder = createConversationMemoryRecorder({ startedAt: NOW });
    await natural.send({ userMessage: 'I like talking freely.' });

    // Mode change = finalize the outgoing conversation, then compose the new mode.
    const naturalResult = await service.finalizeConversation({
      session: natural,
      recorder: naturalRecorder,
      isRealAI: true,
      endedAt: LATER,
    });
    expect(naturalResult.reason).toBe('persisted');

    const coach = buildSession(provider, { mode: 'coach' });
    const coachRecorder = createConversationMemoryRecorder({ startedAt: LATER });
    await coach.send({ userMessage: 'Now correct me properly.' });
    const coachResult = await service.finalizeConversation({
      session: coach,
      recorder: coachRecorder,
      isRealAI: true,
      endedAt: LATER,
    });
    expect(coachResult.reason).toBe('persisted');

    const repo = new SQLiteConversationRepository(adapter);
    const sessions = await repo.listSessions(learnerId);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.mode))).toEqual(new Set(['natural', 'coach']));
    // Each conversation keeps only its own turns.
    for (const session of sessions) {
      expect(await repo.listTurns(session.id)).toHaveLength(2);
    }
  });

  it('13/14. empty and tutor-opening-only sessions produce no learner conversation record', async () => {
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
    const repo = new SQLiteConversationRepository(adapter);

    // No turns at all.
    const empty = buildSession(createStubProvider(['Unused.']));
    const emptyResult = await service.finalizeConversation({
      session: empty,
      recorder: createConversationMemoryRecorder({ startedAt: NOW }),
      isRealAI: true,
      endedAt: LATER,
    });
    expect(emptyResult).toMatchObject({ ok: false, reason: 'empty' });

    // Tutor opening only (a greeting is not a learner conversation).
    const openingOnly = buildSession(createStubProvider(['Hello there!']));
    await openingOnly.openConversation!({ userMessage: 'Begin the conversation now.' });
    expect(openingOnly.getHistory()).toHaveLength(1);
    const openingResult = await service.finalizeConversation({
      session: openingOnly,
      recorder: createConversationMemoryRecorder({ startedAt: NOW }),
      isRealAI: true,
      endedAt: LATER,
    });
    expect(openingResult).toMatchObject({ ok: false, reason: 'empty' });

    expect(await repo.listSessions(learnerId)).toHaveLength(0);
  });

  it('15. a TTS failure does not remove an already committed/persisted turn', async () => {
    const provider = createStubProvider(['A reply whose audio fails.']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    const coordinator = createVoiceSessionCoordinator({
      session,
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider({ defaultTranscript: 'Keep my turn even if TTS dies.' }),
      ttsProvider: {
        id: 'failing-tts',
        async speak() {
          throw new Error('TTS device unavailable');
        },
        async stop() {
          // no-op
        },
        async isSpeaking() {
          return false;
        },
      },
    });

    await coordinator.startRecording();
    const turn = await coordinator.stopRecordingAndProcess();
    expect(turn.ok).toBe(true);
    expect(session.getHistory()).toHaveLength(2);

    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(true);
    expect(result.turnCount).toBe(2);
  });

  it('16. existing weakness feedback is NOT counted twice by conversation memory', async () => {
    const provider = createStubProvider(['Thanks for the update.']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    // The EXISTING pipeline owns weakness/review mutation…
    const persistence = createLearningPersistenceService(adapter, learnerId);
    await persistence.recordFeedbackEvidence(CORRECTION_FEEDBACK);
    recorder.noteFeedback(CORRECTION_FEEDBACK);
    await session.send({ userMessage: 'Yesterday I go to the office.' });

    const weaknessRepo = new SQLiteWeaknessRepository(adapter);
    const reviewRepo = new SQLiteReviewRepository(adapter);
    const weaknessesBefore = await weaknessRepo.listWeaknesses(learnerId);
    const reviewsBefore = await reviewRepo.listDue(learnerId, LATER, 50);
    expect(weaknessesBefore).toHaveLength(1);
    expect(weaknessesBefore[0].occurrenceCount).toBe(1);

    // …and memory + review only READ them.
    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(result.ok).toBe(true);
    const evidence = await service.loadReviewEvidence();
    const review = buildConversationReview({
      snapshot: recorder.snapshot({ session, isRealAI: true, endedAt: LATER }),
      ...evidence,
      persistence: result,
    });
    expect(review.sections.some((section) => section.id === 'corrections')).toBe(true);

    const weaknessesAfter = await weaknessRepo.listWeaknesses(learnerId);
    expect(weaknessesAfter).toHaveLength(1);
    expect(weaknessesAfter[0].occurrenceCount).toBe(1);
    const reviewsAfter = await reviewRepo.listDue(learnerId, LATER, 50);
    expect(reviewsAfter).toHaveLength(reviewsBefore.length);
    expect(weaknessesAfter[0].notes).toBe('Yesterday I go to the office');
  });

  describe('17-19. post-conversation review from real evidence only', () => {
    it('17. the review renders the existing structured evidence', async () => {
      const provider = createStubProvider(['Well done! What happened next?']);
      const session = buildSession(provider, { topic: 'Office life' });
      const recorder = createConversationMemoryRecorder({ startedAt: NOW });
      const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

      await session.send({ userMessage: 'Today I went to the office.' });
      recorder.noteFeedback(CORRECTION_FEEDBACK);
      recorder.notePronunciationLines([
        'The ending of "commute" lost its final sound. Try it once more slowly.',
      ]);
      // Real vocabulary saved through the EXISTING session path.
      await session.saveVocabularyItem({ ...CORRECTION_FEEDBACK.vocabulary! });

      const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
      const evidence = await service.loadReviewEvidence();
      const review = buildConversationReview({
        snapshot: recorder.snapshot({ session, isRealAI: true, endedAt: LATER }),
        ...evidence,
        persistence: result,
      });

      expect(review.sections.map((section) => section.id)).toEqual([
        'corrections',
        'words',
        'pronunciation',
      ]);
      const corrections = review.sections.find((section) => section.id === 'corrections')!;
      expect(corrections.items[0]).toContain('Yesterday I go to the office');
      expect(corrections.items[0]).toContain('Yesterday I went to the office');
      const words = review.sections.find((section) => section.id === 'words')!;
      expect(words.items.join(' ')).toContain('commute');
      const pronunciation = review.sections.find((section) => section.id === 'pronunciation')!;
      expect(pronunciation.items[0]).toContain('"commute"');
      expect(review.notice).toBe('Saved to your learning memory.');
    });

    it('18. the review fabricates no score, mastery, XP or level movement', async () => {
      const provider = createStubProvider(['Nice work!']);
      const session = buildSession(provider);
      const recorder = createConversationMemoryRecorder({ startedAt: NOW });
      const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
      await session.send({ userMessage: 'I talked about my weekend.' });
      recorder.noteFeedback(CORRECTION_FEEDBACK);
      const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });

      const review = buildConversationReview({
        snapshot: recorder.snapshot({ session, isRealAI: true, endedAt: LATER }),
        ...(await service.loadReviewEvidence()),
        persistence: result,
      });

      const rendered = JSON.stringify(review).toLowerCase();
      for (const banned of ['score', 'mastery', 'badge', 'stars', '%', 'level up']) {
        expect(rendered).not.toContain(banned);
      }
      // No gamification/metric tokens as whole words either.
      for (const bannedWord of ['xp', 'points', 'streak']) {
        expect(rendered).not.toMatch(new RegExp(`\\b${bannedWord}\\b`));
      }
      // No numeric rating field exists on the review type at all. `topic` is
      // only present when the learner actually chose one.
      expect(Object.keys(review).sort()).toEqual(
        [
          'generatedAt',
          'hasEvidence',
          'isDemo',
          'learnerTurnCount',
          'mode',
          'notice',
          'persistence',
          'sections',
          'tutorTurnCount',
        ].sort(),
      );
    });

    it('19. unsupported review sections are omitted entirely', async () => {
      const provider = createStubProvider(['Great, and then?']);
      const session = buildSession(provider);
      const recorder = createConversationMemoryRecorder({ startedAt: NOW });
      const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
      await session.send({ userMessage: 'Nothing needed correcting today.' });
      const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });

      const review = buildConversationReview({
        snapshot: recorder.snapshot({ session, isRealAI: true, endedAt: LATER }),
        ...(await service.loadReviewEvidence()),
        persistence: result,
      });

      // Only the section with real evidence is present.
      expect(review.sections.map((section) => section.id)).toEqual(['went-well']);
      expect(review.sections[0].items[0]).toContain('1 of your 1 turns');
      expect(review.sections.some((section) => section.id === 'corrections')).toBe(false);
      expect(review.sections.some((section) => section.id === 'words')).toBe(false);
      expect(review.sections.some((section) => section.id === 'practice-next')).toBe(false);
    });

    it('19b. tutor replies persist and render without any hidden [FEEDBACK] block', () => {
      const raw =
        'That sounds great — tell me more!\n\n[FEEDBACK]\n{"correction":null,"vocabulary":null,"coachingNote":"praise"}\n[/FEEDBACK]';
      expect(stripHiddenFeedback(raw)).toBe('That sounds great — tell me more!');
      expect(stripHiddenFeedback(raw)).not.toContain('[FEEDBACK]');
    });
  });

  it('20. saved vocabulary integrity remains unchanged (the review saves nothing)', async () => {
    const provider = createStubProvider(['Keep going!']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
    await session.send({ userMessage: 'I used a new word today.' });
    recorder.noteFeedback(CORRECTION_FEEDBACK);
    const result = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });

    const vocabRepo = (await import('../data/local/sqlite/repositories')).SQLiteVocabularyRepository;
    const repo = new vocabRepo(adapter);
    const before = await repo.list(learnerId);
    expect(before).toHaveLength(0);

    const review = buildConversationReview({
      snapshot: recorder.snapshot({ session, isRealAI: true, endedAt: LATER }),
      ...(await service.loadReviewEvidence()),
      persistence: result,
    });
    // The suggestion is shown, clearly marked, and NOT written to the database.
    const words = review.sections.find((section) => section.id === 'words')!;
    expect(words.items[0]).toContain('Suggested: "commute"');
    expect(words.items[0]).toContain('to travel regularly between home and work');
    expect(await repo.list(learnerId)).toHaveLength(0);
  });

  it('21. Demo conversations never pollute real learner memory or coaching evidence', async () => {
    const provider = createStubProvider(['Demo reply.']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    await session.send({ userMessage: 'Offline demo learner turn.' });
    recorder.noteFeedback(CORRECTION_FEEDBACK);
    const result = await service.finalizeConversation({ session, recorder, isRealAI: false, endedAt: LATER });

    expect(result).toMatchObject({ ok: false, reason: 'demo' });
    const repo = new SQLiteConversationRepository(adapter);
    expect(await repo.listSessions(learnerId)).toHaveLength(0);

    // The demo review is honest and never claims personalization.
    const review = buildConversationReview({
      snapshot: recorder.snapshot({ session, isRealAI: false, endedAt: LATER }),
      persistence: result,
    });
    expect(review.isDemo).toBe(true);
    expect(review.notice).toBe(CONVERSATION_MEMORY_DEMO_NOTICE);
    expect(review.notice).toContain('nothing from this chat is saved');

    // The demo learner model itself exposes no conversation memory…
    expect(createDemoLearnerModel().getCoachingContext().recentConversations ?? []).toEqual([]);
    // Real learner coaching context stays untouched by demo content.
    const model = createTalkLearnerModel(adapter)!;
    await model.refresh();
    expect(model.getCoachingContext().recentConversations ?? []).toEqual([]);
    // …and demo persistence is gated off in the Talk screen itself.
    const screenSource = readFileSync(join(__dirname, '..', 'screens', 'TalkScreen.tsx'), 'utf8');
    expect(screenSource).toContain('if (!(providerInfoRef.current?.isRealAI ?? false)) return;');
  });

  it('22. a persisted conversation becomes visible through the existing LearnerModel', async () => {
    const provider = createStubProvider(['Tell me more about that commute.']);
    const session = buildSession(provider, { topic: 'Commuting' });
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
    await session.send({ userMessage: 'I commute by train.' });
    const stored = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    expect(stored.ok).toBe(true);

    // The EXISTING learner model reads conversations through its repositories.
    const model = createTalkLearnerModel(adapter)!;
    await model.refresh();
    const context = model.getCoachingContext();
    expect(context.recentConversations).toHaveLength(1);
    expect(context.recentConversations![0]).toMatchObject({
      mode: 'natural',
      topic: 'Commuting',
      turnCount: 2,
    });

    // …and only the bounded summaries reach the prompt (no transcripts).
    const engine = createConversationEngine(model);
    const request = engine.buildRequest({ userMessage: 'Hello again.', mode: 'natural' });
    expect(request.systemPrompt).toContain('Recent Conversations (Persisted):');
    expect(request.systemPrompt).toContain('natural on "Commuting", 2 turn(s)');
    expect(request.systemPrompt).not.toContain('I commute by train.');

    // The listRecentConversations reader sees the same stored conversation.
    const recent = await service.listRecentConversations(5);
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe(stored.domainSessionId);
  });

  it('23. coaching context never comes from a raw transcript injected by the screen', async () => {
    const screenSource = readFileSync(join(__dirname, '..', 'screens', 'TalkScreen.tsx'), 'utf8');
    const talkSource = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const engineSource = readFileSync(
      join(__dirname, '..', 'conversation-engine', 'index.ts'),
      'utf8',
    );

    // TalkScreen composes sessions with the REAL learner model (existing path)…
    expect(screenSource).toContain('resolveTalkCoaching');
    expect(screenSource).toContain('createTalkSession(');
    // …and never builds a prompt or injects conversation history itself.
    expect(screenSource).not.toContain('systemPrompt');
    expect(screenSource).not.toContain('buildSystemPrompt');
    // The engine remains the single owner of prompt composition.
    expect(engineSource).toContain('buildSystemPrompt(coachingContext');
    expect(talkSource).toContain("from '../conversation-engine'");
  });

  it('24. a stale finalization cannot overwrite or duplicate a replacement conversation', async () => {
    const provider = createStubProvider(['First reply.', 'Second reply.']);
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });
    const repo = new SQLiteConversationRepository(adapter);

    const first = buildSession(provider, { mode: 'natural' });
    const firstRecorder = createConversationMemoryRecorder({ startedAt: NOW });
    await first.send({ userMessage: 'Conversation one turn.' });

    const second = buildSession(provider, { mode: 'coach', topic: 'Second topic' });
    const secondRecorder = createConversationMemoryRecorder({ startedAt: LATER });
    await second.send({ userMessage: 'Conversation two turn.' });

    // Both are finalized (the second replaces the first in the UI).
    const firstStored = await service.finalizeConversation({
      session: first,
      recorder: firstRecorder,
      isRealAI: true,
      endedAt: LATER,
    });
    const secondStored = await service.finalizeConversation({
      session: second,
      recorder: secondRecorder,
      isRealAI: true,
      endedAt: LATER,
    });
    expect(firstStored.domainSessionId).not.toBe(secondStored.domainSessionId);

    // A late/"stale" finalization of the FIRST conversation is a no-op.
    const stale = await service.finalizeConversation({
      session: first,
      recorder: firstRecorder,
      isRealAI: true,
      endedAt: LATER,
    });
    expect(stale.reason).toBe('already-finalized');
    expect(stale.domainSessionId).toBe(firstStored.domainSessionId);

    const sessions = await repo.listSessions(learnerId);
    expect(sessions).toHaveLength(2);
    const secondTurns = await repo.listTurns(secondStored.domainSessionId!);
    expect(secondTurns.map((turn) => turn.text)).toEqual([
      'Conversation two turn.',
      'Second reply.',
    ]);
  });

  it('25. the review never fabricates evidence when persistence itself failed', async () => {
    const provider = createStubProvider(['A real reply.']);
    const session = buildSession(provider);
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });

    // A repository that fails exactly like a full/broken local database.
    const failing = createConversationMemoryService({
      conversationRepository: {
        createSession: vi.fn().mockRejectedValue(new Error('database is locked')),
        getSession: vi.fn(),
        listSessions: vi.fn().mockResolvedValue([]),
        addTurn: vi.fn(),
        listTurns: vi.fn().mockResolvedValue([]),
        updateSession: vi.fn(),
      },
      learnerId,
    });

    await session.send({ userMessage: 'The chat must survive a write failure.' });
    const result = await failing.finalizeConversation({
      session,
      recorder,
      isRealAI: true,
      endedAt: LATER,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('persistence-failed');
    // The conversation itself is untouched and the review says so honestly.
    expect(session.getHistory()).toHaveLength(2);
    const review = buildConversationReview({
      snapshot: recorder.snapshot({ session, isRealAI: true, endedAt: LATER }),
      persistence: result,
    });
    expect(review.notice).toContain('could not be saved');
    expect(review.notice).not.toContain('Saved to your learning memory');
  });

  it('26. memory evidence identity is stable per conversation, not per rerender', async () => {
    const provider = createStubProvider(['Reply one.', 'Reply two.']);
    const session = buildSession(provider);
    const recorder: ConversationMemoryRecorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    await session.send({ userMessage: 'Turn one.' });
    // The SAME committed feedback object is reported again (rerender).
    recorder.noteFeedback(CORRECTION_FEEDBACK);
    recorder.noteFeedback(CORRECTION_FEEDBACK);
    await session.send({ userMessage: 'Turn two.' });

    const stored = await service.finalizeConversation({ session, recorder, isRealAI: true, endedAt: LATER });
    const review = buildConversationReview({
      snapshot: recorder.snapshot({ session, isRealAI: true, endedAt: LATER }),
      ...(await service.loadReviewEvidence()),
      persistence: stored,
    });
    // One correction, rendered once — never doubled by rerenders.
    expect(review.learnerTurnCount).toBe(2);
    const corrections = review.sections.find((section) => section.id === 'corrections')!;
    expect(corrections.items).toHaveLength(1);
  });

  it('28. the Talk screen wires finalization and the review into New Chat / mode change', () => {
    const screenSource = readFileSync(join(__dirname, '..', 'screens', 'TalkScreen.tsx'), 'utf8');

    // Finalization happens inside the conversation lifecycle (startConversation),
    // not in ad-hoc click handlers, and BEFORE the atomic switch.
    const finalizeIndex = screenSource.indexOf('await endConversation(outgoingSession, outgoingRecorder)');
    const switchIndex = screenSource.indexOf('await coordinator.switchSession(bundle.session)');
    expect(finalizeIndex).toBeGreaterThan(-1);
    expect(switchIndex).toBeGreaterThan(-1);
    expect(finalizeIndex).toBeLessThan(switchIndex);

    // A fresh recorder per conversation identity (exactly-once identity).
    expect(screenSource).toContain('memoryRecorderRef.current = createConversationMemoryRecorder()');
    // Leaving Talk with a meaningful conversation still stores it.
    expect(screenSource).toContain('recorder.hasCommittedLearnerTurn(session)');
    // The review is presented as a compact qualitative panel, produced by the
    // single tested end-of-conversation pipeline.
    expect(screenSource).toContain('finalizeConversationWithReview');
    expect(screenSource).toContain('CONVERSATION_REVIEW_TITLE');
    expect(screenSource).toContain('Start new conversation');
    // …and the tutor never speaks over it.
    expect(screenSource).toContain('!reviewOpenRef.current');
    // A mode change re-composes through the SAME startConversation lifecycle, so
    // the previous conversation is finalized there too.
    expect(screenSource).toContain('void startConversation(mode, topic)');
    expect(screenSource).toContain('handleSelectMode');
    // No gamification anywhere in the rendered review panel.
    const reviewJsx = screenSource.slice(
      screenSource.indexOf('<Modal'),
      screenSource.indexOf('</Modal>'),
    );
    expect(reviewJsx.length).toBeGreaterThan(0);
    for (const banned of ['score', 'streak', 'points', 'badge', 'XP']) {
      expect(reviewJsx).not.toContain(banned);
    }
  });

  it('29. the end-of-conversation pipeline stores once and always returns an honest review', async () => {
    const provider = createStubProvider(['A solid first reply.']);
    const session = buildSession(provider, { topic: 'Weekend plans' });
    const recorder = createConversationMemoryRecorder({ startedAt: NOW });
    const service = createConversationMemoryService({ databaseAdapter: adapter, learnerId });

    await session.send({ userMessage: 'I went hiking last weekend.' });
    recorder.noteFeedback(CORRECTION_FEEDBACK);

    const review = await finalizeConversationWithReview({
      session,
      recorder,
      isRealAI: true,
      service,
      endedAt: LATER,
    });
    expect(review.notice).toBe('Saved to your learning memory.');
    expect(review.sections.map((section) => section.id)).toContain('corrections');
    expect(review.learnerTurnCount).toBe(1);

    // Running the same pipeline again (second New Chat press) stores nothing new.
    const again = await finalizeConversationWithReview({
      session,
      recorder,
      isRealAI: true,
      service,
      endedAt: LATER,
    });
    expect(again.notice).toBe('Saved to your learning memory.');
    const repo = new SQLiteConversationRepository(adapter);
    expect(await repo.listSessions(learnerId)).toHaveLength(1);

    // A failing store is reported honestly and never as success.
    const brokenSession = buildSession(provider);
    const brokenRecorder = createConversationMemoryRecorder({ startedAt: NOW });
    await brokenSession.send({ userMessage: 'This will not be stored.' });
    const broken = await finalizeConversationWithReview({
      session: brokenSession,
      recorder: brokenRecorder,
      isRealAI: true,
      service: createConversationMemoryService({
        conversationRepository: {
          createSession: vi.fn().mockRejectedValue(new Error('disk full')),
          getSession: vi.fn(),
          listSessions: vi.fn().mockResolvedValue([]),
          addTurn: vi.fn(),
          listTurns: vi.fn().mockResolvedValue([]),
          updateSession: vi.fn(),
        },
        learnerId,
      }),
      endedAt: LATER,
    });
    expect(broken.notice).toBe(CONVERSATION_MEMORY_FAILED_NOTICE);
    expect(broken.notice).not.toContain('Saved to your learning memory');
    expect(brokenSession.getHistory()).toHaveLength(2);
  });

  it('27. the memory module introduces no second memory store or AI summarizer', () => {
    const source = readFileSync(join(__dirname, 'conversation-memory.ts'), 'utf8');
    const talkSource = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const screenSource = readFileSync(join(__dirname, '..', 'screens', 'TalkScreen.tsx'), 'utf8');

    // Reuses the EXISTING repositories/session/engine only.
    expect(source).toContain("from '../data/local/sqlite/repositories'");
    expect(source).toContain('SQLiteConversationRepository');
    expect(source).toContain('SQLiteWeaknessRepository');
    expect(source).toContain('SQLiteReviewRepository');
    // No new storage/network/AI machinery.
    expect(source).not.toContain('CREATE TABLE');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('fetch(');
    // No audio storage: the recorder only ever touches text turns.
    expect(source).not.toContain('audioRef');
    expect(source).not.toContain('audio_ref');
    expect(source).not.toContain('base64');
    // The review is deterministic — no extra AI call.
    expect(screenSource).not.toContain('summarizeConversation');
    expect(talkSource).toContain("from './conversation-memory'");
    expect(screenSource).toContain('finalizeConversationWithReview');
  });
});
