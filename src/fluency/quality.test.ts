/**
 * src/fluency/quality.test.ts
 *
 * WP-3 quality-review + voice-architecture integration tests.
 *
 * - Structural scans pin the reuse contract: no second conversation engine,
 *   session, voice coordinator, learner model, mastery store or AI provider
 *   in the fluency module; no score/gamification vocabulary; no randomness
 *   or wall-clock reads in the pure modules; ordinary Talk never touches
 *   the repair policy.
 * - Integration tests run the REAL VoiceSessionCoordinator (fake recorder /
 *   STT / TTS) over the session the fluency service exposes: failed STT
 *   advances nothing, replay creates no attempt, and TTS failure preserves
 *   the committed attempt.
 */

import { describe, it, expect, vi } from 'vitest';
// @ts-ignore -- node built-ins are available in the vitest runtime; the app tsconfig targets Expo.
import { readFileSync, readdirSync } from 'node:fs';
// @ts-ignore -- see above.
import { dirname, join } from 'node:path';
// @ts-ignore -- see above.
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = dirname(__dirname);

import type {
  AIProvider,
  AIProviderResult,
  ConversationFeedback,
} from '../providers/ai/types';
import type { ConversationRequest } from '../conversation-engine';
import type { CoachingContext, LearnerModel } from '../learner-model';
import type {
  ConversationMemoryService,
  FinalizeConversationResult,
} from '../talk-demo/conversation-memory';
import { SpeakingPracticeService } from '../deep-speaking/service';
import {
  createDemoAudioRecorder,
  createDemoSTTProvider,
  createDemoTTSProvider,
  createTalkVoiceCoordinator,
} from '../talk-demo';
import type { TextToSpeechProvider } from '../providers/tts';

import { createFluencyPracticeService } from './service';

const NOW = '2026-09-18T10:00:00.000Z';
const LEARNER_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'describe-work-problem';

/* ------------------------------------------------------------------ *
 * Source-scan helpers
 * ------------------------------------------------------------------ */

function readSource(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

/** Fluency module sources under test (implementation only, never tests). */
function fluencySources(): string[] {
  const entries: string[] = readdirSync(__dirname);
  return entries
    .filter((entry: string) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry: string) => readFileSync(join(__dirname, entry), 'utf8'));
}

/**
 * Strip block comments and full-line comments so honesty documentation
 * ("no scores, no XP, ...") cannot trip the vocabulary bans — the bans
 * apply to CODE and learner-facing strings.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/* ------------------------------------------------------------------ *
 * Structural: no duplicate systems
 * ------------------------------------------------------------------ */

describe('fluency structural reuse contract', () => {
  it('creates no second conversation/voice/learner/persistence system', () => {
    const bannedConstructors = [
      'createConversationSession(',
      'createVoiceSessionCoordinator(',
      'createTalkVoiceCoordinator(',
      'createLearnerModel(',
      'new VoiceSessionCoordinator(',
      'createLearningPersistenceService(',
      'createConversationMemoryService(',
      'createConversationEngine(',
      'createConversationOrchestrator(',
      'createGeminiAIProvider(',
      'createDemoAIProvider(',
      'new SpeakingPracticeService(',
    ];
    for (const source of fluencySources()) {
      const code = stripComments(source);
      for (const banned of bannedConstructors) {
        expect(code).not.toContain(banned);
      }
    }
  });

  it('takes the owned systems only as injected dependencies (type imports excepted)', () => {
    // Value imports from the owned engines are forbidden inside src/fluency:
    // the speaking service arrives injected, the voice coordinator is built
    // by the UI layer, and persistence/memory stay behind the speaking
    // service. `import type` (interfaces only) is allowed.
    const valueImportFromOwned =
      /import(?!\s+type)[\s\S]*?from\s+['"]\.\.\/(voice|conversation-session|conversation-engine|conversation-orchestrator|learner-model|talk-demo|pronunciation|providers)\//;
    for (const source of fluencySources()) {
      const code = stripComments(source);
      expect(code).not.toMatch(valueImportFromOwned);
    }
  });

  it('contains no score, gamification or numeric-improvement vocabulary in code', () => {
    const banned: readonly RegExp[] = [
      /\d\s*%/,
      /improved\s+\d/i,
      /improvement\s+of\s+\d/i,
      /fluency\s+rating/i,
      /fluency\s+percent/i,
      /\bscore\b/i,
      /\brating\b/i,
      /\bpercent\b/i,
      /\bXP\b/,
      /\bstars?\b/i,
      /streak/i,
    ];
    const screen = stripComments(readSource('screens/FluencyPracticeScreen.tsx'));
    for (const source of [...fluencySources(), screen]) {
      const code = stripComments(source);
      for (const pattern of banned) {
        expect(code).not.toMatch(pattern);
      }
    }
  });

  it('uses no randomness, wall clock or timers in the fluency module', () => {
    const banned = [
      'Math.random',
      'Date.now(',
      'new Date(',
      'performance.now',
      'setTimeout',
      'setInterval',
    ];
    for (const source of fluencySources()) {
      const code = stripComments(source);
      for (const token of banned) {
        expect(code).not.toContain(token);
      }
    }
  });

  it('keeps ordinary Talk independent from fluency repair (Talk never fakes)', () => {
    const talkFiles = [
      'talk-demo/index.ts',
      'talk-demo/turn-controls.ts',
      'talk-demo/vocabulary-persistence.ts',
      'talk-demo/learning-persistence.ts',
      'talk-demo/conversation-memory.ts',
      'talk-demo/demo-learner-model.ts',
      'voice/coordinator.ts',
      'voice/recorder.ts',
      'voice/index.ts',
      'voice/types.ts',
      'conversation-engine/index.ts',
      'conversation-orchestrator/index.ts',
      'conversation-session/index.ts',
      'screens/TalkScreen.tsx',
    ];
    for (const file of talkFiles) {
      const source = readSource(file);
      expect(source).not.toContain('fluency/');
      expect(source).not.toContain('repair-policy');
      expect(source).not.toContain('FluencyPractice');
      expect(source).not.toContain('evaluateRepairTrigger');
    }
  });

  it('wires the screen over the existing voice stack with explicit mic lifecycle', () => {
    const screen = readSource('screens/FluencyPracticeScreen.tsx');
    // Reuse, never rebuild.
    expect(screen).toContain('createTalkVoiceCoordinator');
    expect(screen).toContain('describeVoiceTurn');
    expect(screen).toContain('resolveTalkTurnControls');
    expect(screen).toContain('FluencyPracticeService');
    // Transcribe-only stop: the turn goes through the service pipeline, so
    // one utterance can never become two turns.
    expect(screen).toContain('stopRecordingAndTranscribe');
    expect(screen).not.toContain('stopRecordingAndProcess');
    // Explicit microphone action (push-to-talk), never auto-opened.
    expect(screen).toContain('Tap to speak');
    expect(screen).not.toContain('Math.random');
  });
});

/* ------------------------------------------------------------------ *
 * Voice-architecture integration (real coordinator, fake edges)
 * ------------------------------------------------------------------ */

function makeCoaching(): CoachingContext {
  return {
    profile: {
      learnerId: LEARNER_ID,
      displayName: 'Test Learner',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: ['coach'],
    },
    activeWeaknesses: [],
    strengths: [],
    vocabularyFocus: [],
    expressionFocus: [],
    recentConversations: [],
    recentProgress: null,
    dueReviewCount: 0,
    generatedAt: NOW,
  };
}

function createLearnerModelStub(coaching: CoachingContext): LearnerModel {
  return {
    profile: {},
    strengths: [],
    weaknesses: [],
    mistakes: [],
    pronunciationWeaknesses: [],
    vocabulary: [],
    expressions: [],
    reviewQueue: [],
    progress: [],
    latestProgress: null,
    recentConversations: coaching.recentConversations ?? [],
    refresh: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    getActiveWeaknesses: vi.fn(() => []),
    getStrengths: vi.fn(() => []),
    getSavedVocabulary: vi.fn(() => []),
    getDueReview: vi.fn(() => []),
    getRecentProgress: vi.fn(() => []),
    getLatestProgress: vi.fn(() => null),
    getWeaknessSummary: vi.fn(),
    getVocabularySummary: vi.fn(),
    getExpressionSummary: vi.fn(),
    getProgressSummary: vi.fn(),
    getDashboardSnapshot: vi.fn(),
    getCoachingContext: vi.fn(() => coaching),
  } as unknown as LearnerModel;
}

function okResponse(content: string, feedback?: ConversationFeedback | null): AIProviderResult {
  return { ok: true, response: { content, feedback: feedback ?? null } };
}

function createScriptedProvider(scripts: readonly AIProviderResult[]): {
  readonly provider: AIProvider;
  readonly requests: ConversationRequest[];
} {
  const requests: ConversationRequest[] = [];
  const generate = vi.fn(async (request: ConversationRequest) => {
    const callIndex = requests.length;
    requests.push(request);
    return scripts[Math.min(callIndex, scripts.length - 1)] ?? okResponse('Hello.');
  });
  return {
    provider: { id: 'scripted-ai', generate } as unknown as AIProvider,
    requests,
  };
}

function createMemoryService(): ConversationMemoryService {
  return {
    finalizeConversation: vi.fn(
      async (): Promise<FinalizeConversationResult> => ({
        ok: true,
        reason: 'persisted',
        domainSessionId: 'domain-session-1',
        turnCount: 3,
      }),
    ),
    loadReviewEvidence: vi.fn(async () => ({ weaknesses: [], dueReviews: [] })),
    listRecentConversations: vi.fn(async () => []),
  } as unknown as ConversationMemoryService;
}

describe('fluency voice architecture', () => {
  it('failed STT advances no attempt and writes no evidence', async () => {
    const scripted = createScriptedProvider([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good.'),
    ]);
    const recordSpy = vi.fn(async () => undefined);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: scripted.provider,
      memoryService: createMemoryService(),
      learningPersistence: { recordFeedbackEvidence: recordSpy },
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    await fluency.startTask(TASK_ID);
    const session = fluency.getConversationSession();
    if (!session) throw new Error('no session exposed');

    const recorder = createDemoAudioRecorder();
    const stt = createDemoSTTProvider();
    stt.setMockFailure(true, 'Microphone heard nothing usable.');
    const coordinator = createTalkVoiceCoordinator({
      session,
      providerKind: 'demo',
      recorder,
      sttProvider: stt,
      ttsProvider: createDemoTTSProvider(),
    });

    expect(await coordinator.startRecording()).toBe(true);
    const voice = await coordinator.stopRecordingAndTranscribe();
    expect(voice.ok).toBe(false);

    // Failed STT: no attempt, no evidence, no AI call beyond the opening.
    expect(fluency.getSnapshot().attemptNumber).toBe(0);
    expect(fluency.getAttempts()).toEqual([]);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(scripted.requests).toHaveLength(1);
    expect(session.getHistory()).toHaveLength(1);
    await coordinator.dispose();
  });

  it('the microphone never completes an attempt by itself (explicit stop required)', async () => {
    const scripted = createScriptedProvider([okResponse('Welcome.')]);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: scripted.provider,
      memoryService: createMemoryService(),
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    await fluency.startTask(TASK_ID);
    const session = fluency.getConversationSession();
    if (!session) throw new Error('no session exposed');

    const coordinator = createTalkVoiceCoordinator({
      session,
      providerKind: 'demo',
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });
    // No recording was started: stopping is refused, nothing happens.
    const voice = await coordinator.stopRecordingAndTranscribe();
    expect(voice.ok).toBe(false);
    expect(fluency.getSnapshot().attemptNumber).toBe(0);
    expect(fluency.getAttempts()).toEqual([]);
    await coordinator.dispose();
  });

  it('replay creates no new attempt and no new evidence', async () => {
    const scripted = createScriptedProvider([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good answer.'),
    ]);
    const recordSpy = vi.fn(async () => undefined);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: scripted.provider,
      memoryService: createMemoryService(),
      learningPersistence: { recordFeedbackEvidence: recordSpy },
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    await fluency.startTask(TASK_ID);
    const session = fluency.getConversationSession();
    if (!session) throw new Error('no session exposed');

    const tts = createDemoTTSProvider();
    const coordinator = createTalkVoiceCoordinator({
      session,
      providerKind: 'demo',
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: tts,
    });

    const attempt = await fluency.submitAttempt({
      transcript: 'We had a problem at work with the server.',
    });
    expect(attempt.ok).toBe(true);
    expect(fluency.getSnapshot().attemptNumber).toBe(1);

    // Replay is TTS-only: the tutor reply is spoken again, nothing else moves.
    await coordinator.replayLastResponse();
    await coordinator.replayLastResponse();
    expect(fluency.getSnapshot().attemptNumber).toBe(1);
    expect(fluency.getAttempts()).toHaveLength(1);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(scripted.requests).toHaveLength(2);
    expect(session.getHistory().filter((turn) => turn.role === 'user')).toHaveLength(1);
    await coordinator.dispose();
  });

  it('TTS failure preserves the committed attempt', async () => {
    const scripted = createScriptedProvider([
      okResponse('Welcome. Please begin the task.'),
      okResponse('Good answer.'),
    ]);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: scripted.provider,
      memoryService: createMemoryService(),
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    await fluency.startTask(TASK_ID);
    const session = fluency.getConversationSession();
    if (!session) throw new Error('no session exposed');

    const failingTTS = {
      id: 'failing-tts',
      speak: vi.fn(async () => {
        throw new Error('Speaker unavailable.');
      }),
      stop: vi.fn(async () => undefined),
    } as unknown as TextToSpeechProvider;
    const coordinator = createTalkVoiceCoordinator({
      session,
      providerKind: 'demo',
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: failingTTS,
    });

    const attempt = await fluency.submitAttempt({
      transcript: 'We had a problem at work with the server.',
    });
    expect(attempt.ok).toBe(true);

    // TTS fails loudly at the voice layer — the committed attempt is intact.
    await coordinator.replayLastResponse();
    expect(failingTTS.speak).toHaveBeenCalled();
    expect(fluency.getSnapshot().attemptNumber).toBe(1);
    expect(fluency.getAttempts()).toHaveLength(1);
    expect(fluency.getAttempts()[0]?.transcript).toContain('problem');
    expect(session.getHistory().filter((turn) => turn.role === 'user')).toHaveLength(1);
    await coordinator.dispose();
  });

describe('fluency voice coordinator disposal & replacement races (Blocker 4)', () => {
  it('old recording active when Transfer is pressed', async () => {
    const scripted = createScriptedProvider([
      okResponse('Welcome task 1.'),
      okResponse('Welcome task 2.'),
    ]);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: scripted.provider,
      memoryService: createMemoryService(),
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    await fluency.startTask('explain-project-delay');
    const session1 = fluency.getConversationSession()!;

    const recorder1 = createDemoAudioRecorder();
    const coord1 = createTalkVoiceCoordinator({
      session: session1,
      providerKind: 'demo',
      recorder: recorder1,
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    await coord1.startRecording();
    expect(coord1.getStatus().state).toBe('recording');

    // Transfer sequence: dispose voice BEFORE starting replacement session
    await coord1.dispose();
    expect(coord1.getStatus().state).toBe('idle');

    await fluency.startTransfer();
    const session2 = fluency.getConversationSession()!;
    expect(session2).not.toBe(session1);

    const coord2 = createTalkVoiceCoordinator({
      session: session2,
      providerKind: 'demo',
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    expect(coord2.getStatus().state).toBe('idle');
    await coord2.dispose();
  });

  it('old STT held while Transfer starts and stale old status/error/replay cannot mutate new task', async () => {
    const scripted = createScriptedProvider([
      okResponse('Welcome task 1.'),
      okResponse('Welcome task 2.'),
      okResponse('Great answer on task 2.'),
    ]);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: scripted.provider,
      memoryService: createMemoryService(),
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    await fluency.startTask('explain-project-delay');
    const session1 = fluency.getConversationSession()!;

    const recorder1 = createDemoAudioRecorder();
    const stt1 = createDemoSTTProvider();
    const tts1 = createDemoTTSProvider();
    const coord1 = createTalkVoiceCoordinator({
      session: session1,
      providerKind: 'demo',
      recorder: recorder1,
      sttProvider: stt1,
      ttsProvider: tts1,
    });

    await coord1.startRecording();

    // Invalidate and dispose old coordinator before transfer
    await coord1.dispose();

    await fluency.startTransfer();
    const session2 = fluency.getConversationSession()!;

    const coord2 = createTalkVoiceCoordinator({
      session: session2,
      providerKind: 'demo',
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: createDemoTTSProvider(),
    });

    // 1. Stale replay on old coordinator does nothing to session 2
    await coord1.replayLastResponse();
    expect(session2.getHistory().filter((t) => t.role === 'user')).toHaveLength(0);

    // 2. No stale turns in new session
    expect(session2.getHistory()).toHaveLength(1);
    expect(session2.getHistory()[0]?.content).toBe('Welcome task 2.');

    // 3. New coordinator works normally
    const attempt = await fluency.submitAttempt({
      transcript: 'I will clarify the project delay with team members.',
    });
    expect(attempt.ok).toBe(true);
    expect(session2.getHistory().filter((t) => t.role === 'user')).toHaveLength(1);

    await coord2.dispose();
  });

  it('old TTS stop held while Transfer begins', async () => {
    const scripted = createScriptedProvider([
      okResponse('Welcome task 1.'),
      okResponse('Welcome task 2.'),
    ]);
    const speaking = new SpeakingPracticeService({
      learnerModel: createLearnerModelStub(makeCoaching()),
      aiProvider: scripted.provider,
      memoryService: createMemoryService(),
      now: () => NOW,
    });
    const fluency = createFluencyPracticeService(speaking, { now: () => NOW });
    await fluency.startTask('explain-project-delay');
    const session1 = fluency.getConversationSession()!;

    const tts1 = createDemoTTSProvider();
    const coord1 = createTalkVoiceCoordinator({
      session: session1,
      providerKind: 'demo',
      recorder: createDemoAudioRecorder(),
      sttProvider: createDemoSTTProvider(),
      ttsProvider: tts1,
    });

    const speakPromise = coord1.speakResponse('Speaking response 1');
    await coord1.dispose();
    await speakPromise;
    expect(coord1.getStatus().isSpeaking).toBe(false);

    // Dispose stops TTS cleanly before transfer starts
    await coord1.dispose();
    expect(coord1.getStatus().isSpeaking).toBe(false);

    await fluency.startTransfer();
    const session2 = fluency.getConversationSession()!;
    expect(session2.getHistory()).toHaveLength(1);
  });
});

});
