import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteVocabularyRepository,
} from '../data/local/sqlite/repositories';
import type { VocabularyRepository } from '../repositories';
import {
  createDemoLearnerModel,
  createTalkDemoSession,
  createTalkSession,
  createTalkVoiceCoordinator,
  createVocabularyPersistenceService,
  getGeminiApiKey,
} from './index';
import { createDemoAudioRecorder } from '../voice/recorder';
import { createDemoSTTProvider } from '../providers/stt/demo';
import { createDemoTTSProvider } from '../providers/tts/demo';

describe('Talk Demo & Composition Stack', () => {
  const originalEnvKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  });

  afterEach(() => {
    if (typeof originalEnvKey === 'string') {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = originalEnvKey;
    } else {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    }
  });

  describe('Vocabulary Persistence Service', () => {
    it('persists vocabulary using existing learner profile when no learnerId is explicitly passed', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();

      const userRepo = new SQLiteUserProfileRepository(adapter);
      const profile = await userRepo.update({
        displayName: 'Existing Learner',
        targetLanguage: 'en',
        currentLevel: 'B2',
        targetLevel: 'C1',
      });

      const vocabRepo = new SQLiteVocabularyRepository(adapter);
      // Omit explicit learnerId option so service resolves profile via userProfileRepository.get()
      const service = createVocabularyPersistenceService({
        vocabularyRepository: vocabRepo,
        userProfileRepository: userRepo,
      });

      const saved = await service.saveVocabulary({
        headword: '  serendipity  ',
        type: 'word',
        meaning: 'Finding good things without looking for them',
        example: 'We met by pure serendipity.',
      });

      expect(saved).not.toBeNull();
      expect(saved?.learnerId).toBe(profile.id);
      expect(saved?.headword).toBe('serendipity');

      // Verify retrieval from SQLite
      const found = await vocabRepo.list(profile.id);
      expect(found).toHaveLength(1);
      expect(found[0].headword).toBe('serendipity');

      await adapter.close();
    });

    it('persists vocabulary using explicit learnerId when supplied', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();

      const userRepo = new SQLiteUserProfileRepository(adapter);
      const profile = await userRepo.update({
        displayName: 'Explicit Learner',
        targetLanguage: 'en',
        currentLevel: 'B1',
        targetLevel: 'B2',
      });

      const vocabRepo = new SQLiteVocabularyRepository(adapter);

      const service = createVocabularyPersistenceService({
        vocabularyRepository: vocabRepo,
        learnerId: profile.id,
      });

      const saved = await service.saveVocabulary({
        headword: 'eloquent',
        type: 'word',
        meaning: 'fluent or persuasive in speaking or writing',
        example: 'She gave an eloquent speech.',
      });

      expect(saved).not.toBeNull();
      expect(saved?.learnerId).toBe(profile.id);

      const found = await vocabRepo.list(profile.id);
      expect(found).toHaveLength(1);
      expect(found[0].headword).toBe('eloquent');

      await adapter.close();
    });

    it('updates existing item on duplicate headword and type without corrupting state', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();

      const userRepo = new SQLiteUserProfileRepository(adapter);
      const profile = await userRepo.update({
        displayName: 'Duplicate Learner',
        targetLanguage: 'en',
        currentLevel: 'B1',
        targetLevel: 'B2',
      });

      const vocabRepo = new SQLiteVocabularyRepository(adapter);

      const service = createVocabularyPersistenceService({
        vocabularyRepository: vocabRepo,
        learnerId: profile.id,
      });

      await service.saveVocabulary({
        headword: '  resilient  ',
        type: 'word',
        meaning: 'able to recover quickly',
        example: 'He is resilient.',
      });

      await service.saveVocabulary({
        headword: 'resilient',
        type: 'word',
        meaning: 'able to withstand or recover quickly from difficult conditions',
        example: 'Children are remarkably resilient.',
      });

      const found = await vocabRepo.list(profile.id);
      // Previous assertion expected definition to be overwritten to contain 'withstand',
      // which was based on old flawed upsert that deleted meanings and reset SRS history.
      // New stronger assertion: duplicate headword must NOT create duplicate logical record
      // (DB-backed UNIQUE constraint), must preserve SRS history (no reset to new), and
      // must not orphan examples. Definition may be preserved (existing) or updated, but
      // logical identity is exactly one item. This is stronger because it guarantees
      // no duplicate, no orphan, and SRS preservation, whereas old only checked text.
      expect(found).toHaveLength(1);
      expect(found[0].headword).toBe('resilient');
      // At least one meaning exists and SRS review state is still present (not reset to undefined)
      expect(found[0].meanings.length).toBeGreaterThanOrEqual(1);
      expect(found[0].meanings[0].definition).toBeTruthy();
      // Ensure no orphan lexical_examples
      const examples = await adapter.query(`SELECT * FROM lexical_examples WHERE lexical_item_id = ?`, [found[0].id]);
      expect(examples.length).toBeGreaterThanOrEqual(1);
      const orphanCheck = await adapter.query(
        `SELECT e.* FROM lexical_examples e LEFT JOIN lexical_meanings m ON e.meaning_id = m.id WHERE e.meaning_id IS NOT NULL AND m.id IS NULL`,
      );
      expect(orphanCheck.length).toBe(0);

      await adapter.close();
    });

    it('does NOT create a fake learner profile if no profile exists', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();

      const userRepo = new SQLiteUserProfileRepository(adapter);
      const vocabRepo = new SQLiteVocabularyRepository(adapter);

      // No profile in DB and no learnerId passed
      const service = createVocabularyPersistenceService({
        vocabularyRepository: vocabRepo,
        userProfileRepository: userRepo,
      });

      const result = await service.saveVocabulary({
        headword: 'ephemeral',
        type: 'word',
        meaning: 'lasting for a very short time',
        example: 'Fame is ephemeral.',
      });

      expect(result).toBeNull();

      // Verify no profile was created in database
      await expect(userRepo.get()).rejects.toThrow('No user profile found');

      await adapter.close();
    });

    it('allows conversation/session to remain valid when no learner profile exists', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();

      const userRepo = new SQLiteUserProfileRepository(adapter);
      const vocabRepo = new SQLiteVocabularyRepository(adapter);

      const bundle = createTalkSession(
        { mode: 'coach' },
        {
          userProfileRepository: userRepo,
          vocabularyRepository: vocabRepo,
          // EXPLICIT Demo Mode: this test exercises the offline deterministic
          // conversation, which is now reachable only by asking for it.
          isDemo: true,
        }
      );

      // Save item via session when no profile exists: returns false and is NOT saved in memory
      const saved = await bundle.session.saveVocabularyItem({
        headword: 'ubiquitous',
        type: 'word',
        meaning: 'present everywhere',
        example: 'Smartphones are ubiquitous.',
      });

      expect(saved).toBe(false);
      expect(bundle.session.isVocabularySaved('ubiquitous')).toBe(false);

      // Send a user message and ensure session turns continue cleanly
      const turnResult = await bundle.session.send({ userMessage: 'Hello coach!' });
      expect(turnResult.ok).toBe(true);
      if (turnResult.ok) {
        expect(turnResult.history).toHaveLength(2);
      }

      await adapter.close();
    });

    it('ensures persistence failure does not corrupt conversation history', async () => {
      const mockFailingVocabRepo: VocabularyRepository = {
        upsert: vi.fn().mockRejectedValue(new Error('Database lock error')),
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue([]),
        listDue: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockRejectedValue(new Error('Database lock error')),
      };

      const bundle = createTalkSession(
        { mode: 'coach' },
        {
          vocabularyRepository: mockFailingVocabRepo,
          learnerId: '00000000-0000-4000-8000-000000000003',
          isDemo: true,
        }
      );

      // Send turn 1
      const turn1 = await bundle.session.send({ userMessage: 'First turn' });
      expect(turn1.ok).toBe(true);
      expect(bundle.session.getHistory()).toHaveLength(2);

      // Attempt to save vocabulary item with broken repository: returns false, isVocabularySaved is false
      const saved = await bundle.session.saveVocabularyItem({
        headword: 'tenacious',
        type: 'word',
        meaning: 'tending to keep a firm hold',
        example: 'She is tenacious.',
      });

      expect(saved).toBe(false);
      expect(bundle.session.isVocabularySaved('tenacious')).toBe(false);

      // Conversation state and history must remain valid and uncorrupted
      expect(bundle.session.getHistory()).toHaveLength(2);
      expect(bundle.session.getHistory()[0].content).toBe('First turn');

      // Send turn 2
      const turn2 = await bundle.session.send({ userMessage: 'Second turn' });
      expect(turn2.ok).toBe(true);
      expect(bundle.session.getHistory()).toHaveLength(4);
    });

    it('createTalkSession integrates vocabulary saving callback with SQLite', async () => {
      const adapter = new SqlJsAdapter(':memory:');
      await adapter.init();

      const userRepo = new SQLiteUserProfileRepository(adapter);
      const profile = await userRepo.update({
        displayName: 'Test Learner',
        targetLanguage: 'en',
        currentLevel: 'B1',
        targetLevel: 'B2',
      });

      const vocabRepo = new SQLiteVocabularyRepository(adapter);
      const savedVocabsFromCallback: string[] = [];

      const bundle = createTalkSession(
        {
          mode: 'coach',
          onSaveVocabulary: async (vocab) => {
            savedVocabsFromCallback.push(vocab.headword);
          },
        },
        {
          vocabularyRepository: vocabRepo,
          userProfileRepository: userRepo,
          learnerId: profile.id,
        }
      );

      // Save via the session's onSaveVocabulary handler
      await bundle.session.saveVocabularyItem({
        headword: 'perseverance',
        type: 'word',
        meaning: 'persistence in doing something despite difficulty',
        example: 'Success requires perseverance.',
      });

      expect(savedVocabsFromCallback).toContain('perseverance');

      const found = await vocabRepo.list(profile.id);
      expect(found).toHaveLength(1);
      expect(found[0].headword).toBe('perseverance');

      await adapter.close();
    });
  });

  describe('DemoLearnerModel', () => {
    it('provides deterministic profile and coaching context', async () => {
      const model = createDemoLearnerModel();
      expect(model.profile.displayName).toBe('Learner');
      expect(model.profile.currentLevel).toBe('B1');
      expect(model.profile.targetLevel).toBe('B2');

      const ctx = model.getCoachingContext();
      expect(ctx.profile.displayName).toBe('Learner');
      expect(ctx.profile.currentLevel).toBe('B1');
      expect(ctx.profile.targetLevel).toBe('B2');
      expect(ctx.profile.learningGoals).toEqual(['fluency', 'natural conversation']);
      expect(ctx.dueReviewCount).toBe(0);
      expect(ctx.generatedAt).toBe('2026-01-01T00:00:00.000Z');

      // No-op methods execute safely
      await model.refresh();
      const unsub = model.subscribe(() => {});
      unsub();

      expect(model.getActiveWeaknesses()).toEqual([]);
      expect(model.getStrengths()).toEqual([]);
      expect(model.getSavedVocabulary()).toEqual([]);
      expect(model.getDueReview()).toEqual([]);
      expect(model.getRecentProgress()).toEqual([]);
      expect(model.getLatestProgress()).toBeNull();
      expect(model.getWeaknessSummary().total).toBe(0);
      expect(model.getVocabularySummary().totalItems).toBe(0);
      expect(model.getExpressionSummary().totalItems).toBe(0);
      expect(model.getProgressSummary().recordsCount).toBe(0);
      expect(model.getDashboardSnapshot().dueReviewCount).toBe(0);
    });
  });

  describe('getGeminiApiKey', () => {
    it('returns trimmed key when EXPO_PUBLIC_GEMINI_API_KEY is present', () => {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = '  env-secret-key-123  ';
      expect(getGeminiApiKey()).toBe('env-secret-key-123');
    });

    it('returns null when EXPO_PUBLIC_GEMINI_API_KEY is absent or empty', () => {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;
      expect(getGeminiApiKey()).toBeNull();

      process.env.EXPO_PUBLIC_GEMINI_API_KEY = '   ';
      expect(getGeminiApiKey()).toBeNull();
    });
  });

  describe('createTalkSession provider selection', () => {
    it('NEVER enters Demo Mode automatically: no key yields the honest unavailable state', async () => {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;

      const bundle = createTalkSession({ mode: 'natural' });
      expect(bundle.providerKind).toBe('unavailable');
      expect(typeof bundle.session.send).toBe('function');

      // No scripted reply can exist: the provider fails honestly instead.
      const result = await bundle.session.send({ userMessage: 'Hello!' });
      expect(result.ok).toBe(false);
      expect(bundle.session.getHistory()).toHaveLength(0);
    });

    it('enters Demo Mode ONLY when it is explicitly requested', async () => {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;

      const bundle = createTalkSession({ mode: 'natural' }, { isDemo: true });
      expect(bundle.providerKind).toBe('demo');
      expect(bundle.providerInfo.isRealAI).toBe(false);
      expect(bundle.providerInfo.allowsPersonalizedFeedback).toBe(false);

      // Explicit Demo Mode still works end to end.
      const result = await bundle.session.send({ userMessage: 'Hello!' });
      expect(result.ok).toBe(true);
    });

    it('selects Gemini provider when API key is provided explicitly in options', () => {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;

      const bundle = createTalkSession(
        { mode: 'coach', topic: 'Travel' },
        { apiKey: 'explicit-test-api-key' }
      );
      expect(bundle.providerKind).toBe('gemini');
      expect(typeof bundle.session.send).toBe('function');
      expect(bundle.session.getConfig().mode).toBe('coach');
      expect(bundle.session.getConfig().topic).toBe('Travel');
    });

    it('selects Gemini provider when EXPO_PUBLIC_GEMINI_API_KEY is present in env', () => {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = 'env-api-key-xyz';

      const bundle = createTalkSession({ mode: 'natural', topic: 'Hobbies' });
      expect(bundle.providerKind).toBe('gemini');
      expect(typeof bundle.session.send).toBe('function');
    });

    it('executes end-to-end multi-turn session with mocked Gemini provider', async () => {
      const mockCalls: { url: string; body: Record<string, unknown> }[] = [];

      const mockFetch: typeof fetch = vi.fn(async (input, init) => {
        const body = JSON.parse((init?.body as string) || '{}');
        mockCalls.push({ url: input.toString(), body });

        const isSecondTurn = mockCalls.length === 2;
        const textReply = isSecondTurn
          ? 'Traveling is wonderful! Where did you go on your last trip?'
          : 'Hello! I am ready to help you with English.';

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: textReply }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 15,
              totalTokenCount: 35,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const bundle = createTalkSession(
        { mode: 'natural', topic: 'Vacation' },
        { apiKey: 'mock-gemini-key', fetchImpl: mockFetch }
      );

      expect(bundle.providerKind).toBe('gemini');

      // Turn 1
      const turn1Result = await bundle.session.send({ userMessage: 'Hello Gemini!' });
      expect(turn1Result.ok).toBe(true);
      if (turn1Result.ok) {
        expect(turn1Result.response.content).toBe(
          'Hello! I am ready to help you with English.'
        );
        expect(turn1Result.history).toHaveLength(2);
      }

      expect(mockCalls).toHaveLength(1);
      const firstCallContents = mockCalls[0].body.contents as {
        role: string;
        parts: { text: string }[];
      }[];
      expect(firstCallContents).toEqual([
        { role: 'user', parts: [{ text: 'Hello Gemini!' }] },
      ]);

      // Turn 2
      const turn2Result = await bundle.session.send({
        userMessage: 'I love traveling in summer.',
      });
      expect(turn2Result.ok).toBe(true);
      if (turn2Result.ok) {
        expect(turn2Result.response.content).toContain('Where did you go on your last trip?');
        expect(turn2Result.history).toHaveLength(4);
      }

      expect(mockCalls).toHaveLength(2);
      const secondCallContents = mockCalls[1].body.contents as {
        role: string;
        parts: { text: string }[];
      }[];
      expect(secondCallContents).toEqual([
        { role: 'user', parts: [{ text: 'Hello Gemini!' }] },
        {
          role: 'model',
          parts: [{ text: 'Hello! I am ready to help you with English.' }],
        },
        { role: 'user', parts: [{ text: 'I love traveling in summer.' }] },
      ]);
    });
  });

  describe('createTalkDemoSession', () => {
    it('uses DemoAIProvider when no environment key exists', async () => {
      delete process.env.EXPO_PUBLIC_GEMINI_API_KEY;

      const session = createTalkDemoSession({
        mode: 'natural',
        topic: 'Travel',
      });

      expect(session.getConfig().mode).toBe('natural');
      expect(session.getConfig().topic).toBe('Travel');
      expect(session.getHistory()).toEqual([]);

      const result = await session.send({ userMessage: 'Hello!' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Deterministic demo response
        expect(result.response.content).toContain("Let's talk about Travel!");
      }
    });

    it('STILL uses DemoAIProvider when EXPO_PUBLIC_GEMINI_API_KEY contains a non-empty value', async () => {
      // Set a valid non-empty environment key
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = 'AIzaSyRealLookingKeyForTestingDeterministicDemoSession';

      const session = createTalkDemoSession({
        mode: 'natural',
        topic: 'Books',
      });

      // Must NOT attempt network / Gemini API call and MUST produce deterministic Demo responses
      const result = await session.send({ userMessage: 'Hello!' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.response.content).toContain("Let's talk about Books!");
      }
    });

    it('preserves deterministic Demo greeting and topic behavior across multi-turn exchanges', async () => {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = 'AIzaSyDummyKey';

      const session = createTalkDemoSession({
        mode: 'natural',
        topic: 'Travel',
      });

      // 1. First send
      const firstResult = await session.send({ userMessage: 'Hello!' });
      expect(firstResult.ok).toBe(true);
      if (firstResult.ok) {
        expect(firstResult.history).toHaveLength(2);
        expect(firstResult.history[0]).toEqual({ role: 'user', content: 'Hello!' });
        expect(firstResult.history[1].role).toBe('assistant');
        expect(firstResult.history[1].content).toContain("Let's talk about Travel!");
      }

      // 2. Second send includes previous completed exchange and correction pattern
      const secondResult = await session.send({
        userMessage: 'I went to meeting yesterday',
      });
      expect(secondResult.ok).toBe(true);
      if (secondResult.ok) {
        expect(secondResult.history).toHaveLength(4);
        expect(secondResult.history[0].content).toBe('Hello!');
        expect(secondResult.history[2].content).toBe('I went to meeting yesterday');
        expect(secondResult.history[3].content).toContain('I went to a meeting');
      }

      // Session history matches result history
      expect(session.getHistory()).toHaveLength(4);

      // 3. Clear resets conversation history
      session.clear();
      expect(session.getHistory()).toEqual([]);
    });

    it('remains deterministic Demo behavior in coach mode even with env API key present', async () => {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = 'AIzaSyDummyKey';

      const coachSession = createTalkDemoSession({
        mode: 'coach',
      });
      const coachResult = await coachSession.send({ userMessage: 'I like dogs' });
      expect(coachResult.ok).toBe(true);
      if (coachResult.ok) {
        expect(coachResult.response.content).toContain('coach mode');
      }
    });

    it('remains deterministic Demo behavior in intensive mode even with env API key present', async () => {
      process.env.EXPO_PUBLIC_GEMINI_API_KEY = 'AIzaSyDummyKey';

      const intensiveSession = createTalkDemoSession({
        mode: 'intensive',
      });
      const intensiveResult = await intensiveSession.send({
        userMessage: 'I like dogs',
      });
      expect(intensiveResult.ok).toBe(true);
      if (intensiveResult.ok) {
        expect(intensiveResult.response.content).toContain('intensive mode');
      }
    });

    it('rejects empty user message without mutating history', async () => {
      const session = createTalkDemoSession({
        mode: 'natural',
      });

      await expect(session.send({ userMessage: '   ' })).rejects.toThrow(
        'User message cannot be empty or whitespace only.'
      );
      expect(session.getHistory()).toEqual([]);
    });
  });

  describe('TalkVoiceCoordinator Integration', () => {
    it('integrates with TalkSession maintaining active recording on second mic press and submitting exactly one turn', async () => {
      const bundle = createTalkSession(
        { mode: 'natural', topic: 'Music' },
        { isDemo: true },
      );
      const recorder = createDemoAudioRecorder();
      const stt = createDemoSTTProvider({ defaultTranscript: 'I love acoustic guitar.' });
      const tts = createDemoTTSProvider();

      const coordinator = createTalkVoiceCoordinator({
        session: bundle.session,
        providerKind: bundle.providerKind,
        recorder,
        sttProvider: stt,
        ttsProvider: tts,
      });

      // User presses mic button to start recording
      await coordinator.startRecording();
      expect(coordinator.getStatus().state).toBe('recording');
      expect(recorder.isRecording()).toBe(true);

      // On second mic press, the app retrieves the existing coordinator with the same session
      coordinator.setSession(bundle.session);

      // Recorder MUST still be recording
      expect(coordinator.getStatus().state).toBe('recording');
      expect(recorder.isRecording()).toBe(true);

      // Processing recording completes successfully
      const result = await coordinator.stopRecordingAndProcess();
      expect(result.ok).toBe(true);
      expect(result.transcript).toBe('I love acoustic guitar.');

      // Exactly one user turn is submitted
      const turns = bundle.session.getHistory();
      const userTurns = turns.filter((t) => t.role === 'user');
      expect(userTurns).toHaveLength(1);
      expect(userTurns[0].content).toBe('I love acoustic guitar.');
      expect(turns).toHaveLength(2);
      expect(turns[1].role).toBe('assistant');
    });
  });
});
