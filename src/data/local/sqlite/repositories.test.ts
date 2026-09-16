/**
 * src/data/local/sqlite/repositories.test.ts
 *
 * Focused sql.js repository tests for UserProfile and Conversation repositories.
 *
 * Tests cover:
 * 1. profile can be updated
 * 2. profile survives repository re-instantiation on the same DB adapter
 * 3. conversation session can be created and retrieved
 * 4. session update preserves unspecified fields
 * 5. multiple sessions can be listed for learner
 * 6. conversation turns persist
 * 7. turns are returned in sequence_number order even if inserted out of order
 * 8. getSession returns null for unknown id
 * 9. foreign-key enforcement still works
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqlJsAdapter } from './SqlJsAdapter';
import { SQLiteUserProfileRepository, SQLiteConversationRepository, SQLiteMistakeRepository, SQLitePronunciationRepository, SQLiteWeaknessRepository } from './repositories';
import type { CefrLevelInput, ConversationMode } from '../../../domain/shared/types';
import type { ConversationTurn } from '../../../domain/models/conversation';

describe('SQLite repositories (sql.js)', () => {
  let adapter: SqlJsAdapter;
  let profileRepo: SQLiteUserProfileRepository;
  let conversationRepo: SQLiteConversationRepository;

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    profileRepo = new SQLiteUserProfileRepository(adapter);
    conversationRepo = new SQLiteConversationRepository(adapter);
  });

  // Helper to create a learner profile
  async function createProfile(overrides: Partial<{
    displayName: string;
    nativeLanguage: string;
    targetLanguage: string;
    targetLevel: CefrLevelInput;
    currentLevel: CefrLevelInput;
    learningGoals: string[];
    preferredModes: readonly ConversationMode[];
  }> = {}): Promise<void> {
    await profileRepo.update({
      displayName: overrides.displayName ?? 'Test Learner',
      nativeLanguage: overrides.nativeLanguage ?? 'es',
      targetLanguage: overrides.targetLanguage ?? 'en',
      targetLevel: overrides.targetLevel ?? 'B1',
      currentLevel: overrides.currentLevel ?? 'A2',
      learningGoals: overrides.learningGoals ?? ['fluency', 'business'],
      preferredModes: overrides.preferredModes ?? ['natural', 'coach'],
    });
  }

  // Helper to get the learner ID from the profile
  async function getLearnerId(): Promise<string> {
    const profile = await profileRepo.get();
    return profile.id;
  }

  describe('UserProfileRepository', () => {
    it('1. profile can be updated', async () => {
      // Initial creation
      await profileRepo.update({
        displayName: 'Alice',
        targetLanguage: 'en',
        targetLevel: 'B1',
        currentLevel: 'A2',
        learningGoals: ['conversation'],
        preferredModes: ['natural'],
      });

      let profile = await profileRepo.get();
      expect(profile.displayName).toBe('Alice');
      expect(profile.targetLanguage).toBe('en');
      expect(profile.targetLevel).toBe('B1');
      expect(profile.currentLevel).toBe('A2');
      expect(profile.learningGoals).toEqual(['conversation']);
      expect(profile.preferredModes).toEqual(['natural']);
      expect(profile.id).toBeDefined();
      expect(profile.createdAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();

      // Update some fields
      const originalId = profile.id;
      const originalCreatedAt = profile.createdAt;

      await profileRepo.update({
        displayName: 'Alice Updated',
        currentLevel: 'B1',
        learningGoals: ['conversation', 'business'],
      });

      profile = await profileRepo.get();
      expect(profile.displayName).toBe('Alice Updated');
      expect(profile.currentLevel).toBe('B1');
      expect(profile.learningGoals).toEqual(['conversation', 'business']);
      // Preserved fields
      expect(profile.id).toBe(originalId);
      expect(profile.createdAt).toBe(originalCreatedAt);
      // updatedAt should have changed
      expect(profile.updatedAt).not.toBe(originalCreatedAt);
    });

    it('2. profile survives repository re-instantiation on the same DB adapter', async () => {
      await profileRepo.update({
        displayName: 'Persistent User',
        targetLanguage: 'en',
        targetLevel: 'B2',
        currentLevel: 'B1',
        learningGoals: ['reading'],
        preferredModes: ['coach'],
      });

      const profile1 = await profileRepo.get();
      const originalId = profile1.id;
      const originalCreatedAt = profile1.createdAt;

      // Create a NEW repository instance with the SAME adapter
      const newProfileRepo = new SQLiteUserProfileRepository(adapter);
      const profile2 = await newProfileRepo.get();

      expect(profile2.id).toBe(originalId);
      expect(profile2.displayName).toBe('Persistent User');
      expect(profile2.targetLanguage).toBe('en');
      expect(profile2.targetLevel).toBe('B2');
      expect(profile2.currentLevel).toBe('B1');
      expect(profile2.learningGoals).toEqual(['reading']);
      expect(profile2.preferredModes).toEqual(['coach']);
      expect(profile2.createdAt).toBe(originalCreatedAt);
    });

    it('handles optional nativeLanguage correctly', async () => {
      await profileRepo.update({
        displayName: 'No Native Lang',
        targetLanguage: 'en',
        targetLevel: 'A1',
        currentLevel: 'A1',
        learningGoals: [],
        preferredModes: ['natural'],
        // nativeLanguage intentionally omitted
      });

      const profile = await profileRepo.get();
      expect(profile.nativeLanguage).toBeUndefined();
    });

    it('throws on get() when no profile exists', async () => {
      // Fresh adapter, no profile created yet
      const freshAdapter = new SqlJsAdapter(':memory:');
      await freshAdapter.init();
      const freshRepo = new SQLiteUserProfileRepository(freshAdapter);

      await expect(freshRepo.get()).rejects.toThrow('No user profile found');
    });
  });

  describe('ConversationRepository', () => {
    let learnerId: string;

    beforeEach(async () => {
      await createProfile();
      learnerId = await getLearnerId();
    });

    it('3. conversation session can be created and retrieved', async () => {
      const session = await conversationRepo.createSession({
        learnerId,
        mode: 'natural',
        title: 'First Chat',
        topic: 'Introductions',
        topicSource: 'learner-chosen',
        status: 'active',
        startedAt: new Date().toISOString(),
        turnCount: 0,
        tags: ['greeting'],
      });

      expect(session.id).toBeDefined();
      expect(session.learnerId).toBe(learnerId);
      expect(session.mode).toBe('natural');
      expect(session.title).toBe('First Chat');
      expect(session.topic).toBe('Introductions');
      expect(session.topicSource).toBe('learner-chosen');
      expect(session.status).toBe('active');
      expect(session.turnCount).toBe(0);
      expect(session.tags).toEqual(['greeting']);
      expect(session.createdAt).toBeDefined();
      expect(session.updatedAt).toBeDefined();

      // Retrieve by ID
      const retrieved = await conversationRepo.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(session.id);
      expect(retrieved!.title).toBe('First Chat');
    });

    it('4. session update preserves unspecified fields', async () => {
      const session = await conversationRepo.createSession({
        learnerId,
        mode: 'coach',
        title: 'Original Title',
        topic: 'Original Topic',
        topicSource: 'ai-suggested',
        status: 'active',
        startedAt: new Date().toISOString(),
        difficulty: 'B1',
        turnCount: 5,
        summary: 'Original summary',
        tags: ['tag1', 'tag2'],
      });

      const originalId = session.id;
      const originalCreatedAt = session.createdAt;
      const originalLearnerId = session.learnerId;
      const originalMode = session.mode;
      const originalTopic = session.topic;
      const originalTopicSource = session.topicSource;
      const originalDifficulty = session.difficulty;
      const originalTurnCount = session.turnCount;
      const originalSummary = session.summary;
      const originalTags = session.tags;

      // Update only title and status
      const updated = await conversationRepo.updateSession(session.id, {
        title: 'Updated Title',
        status: 'completed',
        endedAt: new Date().toISOString(),
        durationSeconds: 300,
      });

      expect(updated.id).toBe(originalId);
      expect(updated.createdAt).toBe(originalCreatedAt);
      expect(updated.learnerId).toBe(originalLearnerId);
      expect(updated.mode).toBe(originalMode);
      expect(updated.topic).toBe(originalTopic);
      expect(updated.topicSource).toBe(originalTopicSource);
      expect(updated.difficulty).toBe(originalDifficulty);
      expect(updated.turnCount).toBe(originalTurnCount);
      expect(updated.summary).toBe(originalSummary);
      expect(updated.tags).toEqual(originalTags);
      // Updated fields
      expect(updated.title).toBe('Updated Title');
      expect(updated.status).toBe('completed');
      expect(updated.endedAt).toBeDefined();
      expect(updated.durationSeconds).toBe(300);
      // updatedAt should have changed
      expect(updated.updatedAt).not.toBe(originalCreatedAt);
    });

    it('5. multiple sessions can be listed for learner', async () => {
      const now = new Date();

      // Create 3 sessions with different start times
      const session1 = await conversationRepo.createSession({
        learnerId,
        mode: 'natural',
        title: 'Session 1',
        status: 'completed',
        startedAt: new Date(now.getTime() - 3600000).toISOString(), // 1 hour ago
        turnCount: 10,
      });

      const session2 = await conversationRepo.createSession({
        learnerId,
        mode: 'coach',
        title: 'Session 2',
        status: 'active',
        startedAt: new Date(now.getTime() - 1800000).toISOString(), // 30 min ago
        turnCount: 5,
      });

      const session3 = await conversationRepo.createSession({
        learnerId,
        mode: 'intensive',
        title: 'Session 3',
        status: 'abandoned',
        startedAt: new Date(now.getTime() - 600000).toISOString(), // 10 min ago
        turnCount: 2,
      });

      // List all sessions - should be ordered newest first (by started_at DESC)
      const sessions = await conversationRepo.listSessions(learnerId);
      expect(sessions).toHaveLength(3);
      expect(sessions[0].id).toBe(session3.id); // newest first
      expect(sessions[1].id).toBe(session2.id);
      expect(sessions[2].id).toBe(session1.id);

      // Test limit
      const limited = await conversationRepo.listSessions(learnerId, 2);
      expect(limited).toHaveLength(2);
      expect(limited[0].id).toBe(session3.id);
      expect(limited[1].id).toBe(session2.id);
    });

    it('6. conversation turns persist', async () => {
      const session = await conversationRepo.createSession({
        learnerId,
        mode: 'natural',
        status: 'active',
        startedAt: new Date().toISOString(),
        turnCount: 0,
      });

      const turn1 = await conversationRepo.addTurn({
        sessionId: session.id,
        speaker: 'learner',
        text: 'Hello, how are you?',
        turnIndex: 0,
        startedAt: new Date().toISOString(),
        metadata: { intent: 'greeting' },
      });

      expect(turn1.id).toBeDefined();
      expect(turn1.sessionId).toBe(session.id);
      expect(turn1.speaker).toBe('learner');
      expect(turn1.text).toBe('Hello, how are you?');
      expect(turn1.turnIndex).toBe(0);
      expect(turn1.metadata).toEqual({ intent: 'greeting' });

      const turn2 = await conversationRepo.addTurn({
        sessionId: session.id,
        speaker: 'tutor',
        text: 'I am doing well, thank you!',
        turnIndex: 1,
        startedAt: new Date().toISOString(),
        audioRef: 'audio/tutor-1.mp3',
        detectedLanguage: 'en',
        confidence: 0.95,
      });

      expect(turn2.speaker).toBe('tutor');
      expect(turn2.audioRef).toBe('audio/tutor-1.mp3');
      expect(turn2.detectedLanguage).toBe('en');
      expect(turn2.confidence).toBe(0.95);
    });

    it('7. turns are returned in sequence_number order even if inserted out of order', async () => {
      const session = await conversationRepo.createSession({
        learnerId,
        mode: 'natural',
        status: 'active',
        startedAt: new Date().toISOString(),
        turnCount: 0,
      });

      // Insert turns OUT OF ORDER (sequence_number: 2, 0, 1)
      await conversationRepo.addTurn({
        sessionId: session.id,
        speaker: 'learner',
        text: 'Third turn',
        turnIndex: 2,
        startedAt: new Date().toISOString(),
      });

      await conversationRepo.addTurn({
        sessionId: session.id,
        speaker: 'learner',
        text: 'First turn',
        turnIndex: 0,
        startedAt: new Date().toISOString(),
      });

      await conversationRepo.addTurn({
        sessionId: session.id,
        speaker: 'tutor',
        text: 'Second turn',
        turnIndex: 1,
        startedAt: new Date().toISOString(),
      });

      // listTurns MUST return in sequence_number ASC order
      const turns = await conversationRepo.listTurns(session.id);
      expect(turns).toHaveLength(3);
      expect(turns[0].turnIndex).toBe(0);
      expect(turns[0].text).toBe('First turn');
      expect(turns[1].turnIndex).toBe(1);
      expect(turns[1].text).toBe('Second turn');
      expect(turns[2].turnIndex).toBe(2);
      expect(turns[2].text).toBe('Third turn');
    });

    it('8. getSession returns null for unknown id', async () => {
      const result = await conversationRepo.getSession('non-existent-id');
      expect(result).toBeNull();

      // Also test with valid UUID format but non-existent
      const validButMissing = '550e8400-e29b-41d4-a716-446655440000';
      const result2 = await conversationRepo.getSession(validButMissing);
      expect(result2).toBeNull();
    });

    it('9. foreign-key enforcement still works', async () => {
      // Try to create a session with non-existent learner_id
      await expect(
        conversationRepo.createSession({
          learnerId: 'non-existent-learner',
          mode: 'natural',
          status: 'active',
          startedAt: new Date().toISOString(),
          turnCount: 0,
        }),
      ).rejects.toThrow();

      // Try to add a turn to non-existent session
      await expect(
        conversationRepo.addTurn({
          sessionId: 'non-existent-session',
          speaker: 'learner',
          text: 'Test',
          turnIndex: 0,
          startedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow();
    });

    it('listSessions filters by learnerId', async () => {
      // Create another learner
      const otherAdapter = new SqlJsAdapter(':memory:');
      await otherAdapter.init();
      const otherProfileRepo = new SQLiteUserProfileRepository(otherAdapter);
      await otherProfileRepo.update({
        displayName: 'Other Learner',
        targetLanguage: 'en',
        targetLevel: 'A1',
        currentLevel: 'A1',
        learningGoals: [],
        preferredModes: ['natural'],
      });
      const otherLearnerId = (await otherProfileRepo.get()).id;
      const otherConversationRepo = new SQLiteConversationRepository(otherAdapter);

      // Create sessions for both learners
      await conversationRepo.createSession({
        learnerId,
        mode: 'natural',
        status: 'active',
        startedAt: new Date().toISOString(),
        turnCount: 0,
      });

      await otherConversationRepo.createSession({
        learnerId: otherLearnerId,
        mode: 'coach',
        status: 'active',
        startedAt: new Date().toISOString(),
        turnCount: 0,
      });

      // Each learner should only see their own sessions
      const mySessions = await conversationRepo.listSessions(learnerId);
      expect(mySessions).toHaveLength(1);

      const otherSessions = await otherConversationRepo.listSessions(otherLearnerId);
      expect(otherSessions).toHaveLength(1);
    });

    it('listTurns returns empty array for unknown session', async () => {
      const turns = await conversationRepo.listTurns('non-existent-session');
      expect(turns).toEqual([]);
    });

    it('updateSession throws for non-existent session', async () => {
      // Use a valid UUID format that doesn't exist
      const validButMissing = '550e8400-e29b-41d4-a716-446655440000';
      await expect(
        conversationRepo.updateSession(validButMissing, { title: 'New Title' }),
      ).rejects.toThrow('Session not found');
    });

    it('addTurn validates required fields', async () => {
      const session = await conversationRepo.createSession({
        learnerId,
        mode: 'natural',
        status: 'active',
        startedAt: new Date().toISOString(),
        turnCount: 0,
      });

      // Missing speaker
      await expect(
        conversationRepo.addTurn({
          sessionId: session.id,
          text: 'Test',
          turnIndex: 0,
          startedAt: new Date().toISOString(),
        } as Omit<ConversationTurn, 'id'>),
      ).rejects.toThrow('speaker is required');

      // Missing text
      await expect(
        conversationRepo.addTurn({
          sessionId: session.id,
          speaker: 'learner',
          turnIndex: 0,
          startedAt: new Date().toISOString(),
        } as Omit<ConversationTurn, 'id'>),
      ).rejects.toThrow('text is required');

      // Missing turnIndex
      await expect(
        conversationRepo.addTurn({
          sessionId: session.id,
          speaker: 'learner',
          text: 'Test',
          startedAt: new Date().toISOString(),
        } as Omit<ConversationTurn, 'id'>),
      ).rejects.toThrow('turnIndex is required');

      // Missing startedAt
      await expect(
        conversationRepo.addTurn({
          sessionId: session.id,
          speaker: 'learner',
          text: 'Test',
          turnIndex: 0,
        } as Omit<ConversationTurn, 'id'>),
      ).rejects.toThrow('startedAt is required');
    });
  });

  describe('MistakeRepository (GrammarMistake)', () => {
    let learnerId: string;
    let mistakeRepo: SQLiteMistakeRepository;

    beforeEach(async () => {
      await createProfile();
      learnerId = await getLearnerId();
      mistakeRepo = new SQLiteMistakeRepository(adapter);
    });

    it('mistake persists and round-trips correctly', async () => {
      const now = new Date().toISOString();
      const mistake = await mistakeRepo.recordMistake({
        learnerId,
        category: 'for-vs-since',
        pattern: 'I live here since 2020',
        correction: 'I have lived here since 2020',
        explanation: 'Use present perfect with since',
        severity: 'moderate',
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: ['daily life'],
        exampleTurnIds: ['turn-1'],
        originSessionId: 'session-1',
        originTurnId: 'turn-1',
        resolved: false,
      });

      expect(mistake.id).toBeDefined();
      expect(mistake.learnerId).toBe(learnerId);
      expect(mistake.category).toBe('for-vs-since');
      expect(mistake.pattern).toBe('I live here since 2020');
      expect(mistake.correction).toBe('I have lived here since 2020');
      expect(mistake.explanation).toBe('Use present perfect with since');
      expect(mistake.severity).toBe('moderate');
      expect(mistake.occurrenceCount).toBe(1);
      expect(mistake.contexts).toEqual(['daily life']);
      expect(mistake.exampleTurnIds).toEqual(['turn-1']);
      expect(mistake.originSessionId).toBe('session-1');
      expect(mistake.originTurnId).toBe('turn-1');
      expect(mistake.resolved).toBe(false);
      expect(mistake.createdAt).toBeDefined();
      expect(mistake.updatedAt).toBeDefined();

      // Round-trip via listMistakes
      const mistakes = await mistakeRepo.listMistakes(learnerId);
      expect(mistakes).toHaveLength(1);
      expect(mistakes[0].id).toBe(mistake.id);
      expect(mistakes[0].category).toBe('for-vs-since');
    });

    it('resolved filter works', async () => {
      const now = new Date().toISOString();

      // Create resolved mistake
      await mistakeRepo.recordMistake({
        learnerId,
        category: 'resolved-mistake',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: now,
        firstSeenAt: now,
        resolved: true,
      });

      // Create unresolved mistake
      await mistakeRepo.recordMistake({
        learnerId,
        category: 'unresolved-mistake',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: now,
        firstSeenAt: now,
        resolved: false,
      });

      const resolved = await mistakeRepo.listMistakes(learnerId, { resolved: true });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].category).toBe('resolved-mistake');
      expect(resolved[0].resolved).toBe(true);

      const unresolved = await mistakeRepo.listMistakes(learnerId, { resolved: false });
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].category).toBe('unresolved-mistake');
      expect(unresolved[0].resolved).toBe(false);
    });

    it('unresolved filter works', async () => {
      const now = new Date().toISOString();

      await mistakeRepo.recordMistake({
        learnerId,
        category: 'test',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: now,
        firstSeenAt: now,
        resolved: false,
      });

      const unresolved = await mistakeRepo.listMistakes(learnerId, { resolved: false });
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].resolved).toBe(false);
    });

    it('markResolved updates target record', async () => {
      const now = new Date().toISOString();
      const mistake = await mistakeRepo.recordMistake({
        learnerId,
        category: 'test',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: now,
        firstSeenAt: now,
        resolved: false,
      });

      expect(mistake.resolved).toBe(false);

      const updated = await mistakeRepo.markResolved(mistake.id, true);
      expect(updated.id).toBe(mistake.id);
      expect(updated.resolved).toBe(true);
      expect(updated.updatedAt).not.toBe(mistake.updatedAt);

      // Verify persistence
      const mistakes = await mistakeRepo.listMistakes(learnerId, { resolved: true });
      expect(mistakes).toHaveLength(1);
      expect(mistakes[0].resolved).toBe(true);
    });

    it('unknown id fails clearly', async () => {
      const validButMissing = '550e8400-e29b-41d4-a716-446655440000';
      await expect(
        mistakeRepo.markResolved(validButMissing, true),
      ).rejects.toThrow('Grammar mistake not found');
    });

    it('learner filtering prevents cross-learner leakage', async () => {
      // Create another learner
      const otherAdapter = new SqlJsAdapter(':memory:');
      await otherAdapter.init();
      const otherProfileRepo = new SQLiteUserProfileRepository(otherAdapter);
      await otherProfileRepo.update({
        displayName: 'Other Learner',
        targetLanguage: 'en',
        targetLevel: 'A1',
        currentLevel: 'A1',
        learningGoals: [],
        preferredModes: ['natural'],
      });
      const otherLearnerId = (await otherProfileRepo.get()).id;
      const otherMistakeRepo = new SQLiteMistakeRepository(otherAdapter);

      const now = new Date().toISOString();

      // Create mistakes for both learners
      await mistakeRepo.recordMistake({
        learnerId,
        category: 'my-mistake',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: now,
        firstSeenAt: now,
        resolved: false,
      });

      await otherMistakeRepo.recordMistake({
        learnerId: otherLearnerId,
        category: 'other-mistake',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: now,
        firstSeenAt: now,
        resolved: false,
      });

      // Each learner should only see their own mistakes
      const myMistakes = await mistakeRepo.listMistakes(learnerId);
      expect(myMistakes).toHaveLength(1);
      expect(myMistakes[0].category).toBe('my-mistake');

      const otherMistakes = await otherMistakeRepo.listMistakes(otherLearnerId);
      expect(otherMistakes).toHaveLength(1);
      expect(otherMistakes[0].category).toBe('other-mistake');
    });

    it('limit option works', async () => {
      const now = new Date().toISOString();

      for (let i = 0; i < 5; i++) {
        await mistakeRepo.recordMistake({
          learnerId,
          category: `mistake-${i}`,
          pattern: 'wrong',
          correction: 'right',
          severity: 'minor',
          occurrenceCount: 1,
          contexts: [],
          exampleTurnIds: [],
          lastSeenAt: now,
          firstSeenAt: now,
          resolved: false,
        });
      }

      const limited = await mistakeRepo.listMistakes(learnerId, { limit: 3 });
      expect(limited).toHaveLength(3);
    });

    it('ordering is newest first by last_seen_at', async () => {
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();

      await mistakeRepo.recordMistake({
        learnerId,
        category: 'oldest',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: new Date(baseTime).toISOString(),
        firstSeenAt: new Date(baseTime).toISOString(),
        resolved: false,
      });

      await mistakeRepo.recordMistake({
        learnerId,
        category: 'middle',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: new Date(baseTime + 1000).toISOString(),
        firstSeenAt: new Date(baseTime + 1000).toISOString(),
        resolved: false,
      });

      await mistakeRepo.recordMistake({
        learnerId,
        category: 'newest',
        pattern: 'wrong',
        correction: 'right',
        severity: 'minor',
        occurrenceCount: 1,
        contexts: [],
        exampleTurnIds: [],
        lastSeenAt: new Date(baseTime + 2000).toISOString(),
        firstSeenAt: new Date(baseTime + 2000).toISOString(),
        resolved: false,
      });

      const mistakes = await mistakeRepo.listMistakes(learnerId);
      expect(mistakes).toHaveLength(3);
      expect(mistakes[0].category).toBe('newest');
      expect(mistakes[1].category).toBe('middle');
      expect(mistakes[2].category).toBe('oldest');
    });
  });

  describe('PronunciationRepository (PronunciationWeakness)', () => {
    let learnerId: string;
    let pronunciationRepo: SQLitePronunciationRepository;

    beforeEach(async () => {
      await createProfile();
      learnerId = await getLearnerId();
      pronunciationRepo = new SQLitePronunciationRepository(adapter);
    });

    it('pronunciation weakness persists and round-trips', async () => {
      const now = new Date().toISOString();
      const weakness = await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'θ',
        wordExamples: ['think', 'thought', 'through'],
        occurrenceCount: 3,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: ['reading', 'conversation'],
        exampleTurnIds: ['turn-1', 'turn-2'],
        originSessionId: 'session-1',
        originTurnId: 'turn-1',
        resolved: false,
        notes: 'Voiceless dental fricative',
      });

      expect(weakness.id).toBeDefined();
      expect(weakness.learnerId).toBe(learnerId);
      expect(weakness.targetSound).toBe('θ');
      expect(weakness.wordExamples).toEqual(['think', 'thought', 'through']);
      expect(weakness.occurrenceCount).toBe(3);
      expect(weakness.contexts).toEqual(['reading', 'conversation']);
      expect(weakness.exampleTurnIds).toEqual(['turn-1', 'turn-2']);
      expect(weakness.originSessionId).toBe('session-1');
      expect(weakness.originTurnId).toBe('turn-1');
      expect(weakness.resolved).toBe(false);
      expect(weakness.notes).toBe('Voiceless dental fricative');
      expect(weakness.createdAt).toBeDefined();
      expect(weakness.updatedAt).toBeDefined();

      // Round-trip via listWeaknesses
      const weaknesses = await pronunciationRepo.listWeaknesses(learnerId);
      expect(weaknesses).toHaveLength(1);
      expect(weaknesses[0].id).toBe(weakness.id);
      expect(weaknesses[0].targetSound).toBe('θ');
    });

    it('no fabricated score field is produced', async () => {
      const now = new Date().toISOString();
      const weakness = await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: '/ɪ/ vs /iː/',
        wordExamples: ['ship', 'sheep'],
        occurrenceCount: 2,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: ['minimal pairs'],
        exampleTurnIds: [],
        resolved: false,
      });

      // Verify no score/accuracy/confidence fields exist on domain object
      const weaknessKeys = Object.keys(weakness);
      expect(weaknessKeys).not.toContain('score');
      expect(weaknessKeys).not.toContain('accuracy');
      expect(weaknessKeys).not.toContain('pronunciationScore');
      expect(weaknessKeys).not.toContain('confidenceScore');

      // Verify only actual observation fields exist
      expect(weakness.targetSound).toBe('/ɪ/ vs /iː/');
      expect(weakness.wordExamples).toEqual(['ship', 'sheep']);
      expect(weakness.occurrenceCount).toBe(2);
      expect(weakness.contexts).toEqual(['minimal pairs']);
    });

    it('resolved filter works', async () => {
      const now = new Date().toISOString();

      // Create resolved weakness
      await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'resolved-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        exampleTurnIds: [],
        resolved: true,
      });

      // Create unresolved weakness
      await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'unresolved-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      const resolved = await pronunciationRepo.listWeaknesses(learnerId, { resolved: true });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].targetSound).toBe('resolved-sound');
      expect(resolved[0].resolved).toBe(true);

      const unresolved = await pronunciationRepo.listWeaknesses(learnerId, { resolved: false });
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].targetSound).toBe('unresolved-sound');
      expect(unresolved[0].resolved).toBe(false);
    });

    it('unresolved filter works', async () => {
      const now = new Date().toISOString();

      await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'test-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      const unresolved = await pronunciationRepo.listWeaknesses(learnerId, { resolved: false });
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].resolved).toBe(false);
    });

    it('markResolved updates correct record', async () => {
      const now = new Date().toISOString();
      const weakness = await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'test-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      expect(weakness.resolved).toBe(false);

      const updated = await pronunciationRepo.markResolved(weakness.id, true);
      expect(updated.id).toBe(weakness.id);
      expect(updated.resolved).toBe(true);
      expect(updated.updatedAt).not.toBe(weakness.updatedAt);

      // Verify persistence
      const weaknesses = await pronunciationRepo.listWeaknesses(learnerId, { resolved: true });
      expect(weaknesses).toHaveLength(1);
      expect(weaknesses[0].resolved).toBe(true);
    });

    it('unknown id fails clearly', async () => {
      const validButMissing = '550e8400-e29b-41d4-a716-446655440000';
      await expect(
        pronunciationRepo.markResolved(validButMissing, true),
      ).rejects.toThrow('Pronunciation weakness not found');
    });

    it('learner filtering prevents cross-learner leakage', async () => {
      // Create another learner
      const otherAdapter = new SqlJsAdapter(':memory:');
      await otherAdapter.init();
      const otherProfileRepo = new SQLiteUserProfileRepository(otherAdapter);
      await otherProfileRepo.update({
        displayName: 'Other Learner',
        targetLanguage: 'en',
        targetLevel: 'A1',
        currentLevel: 'A1',
        learningGoals: [],
        preferredModes: ['natural'],
      });
      const otherLearnerId = (await otherProfileRepo.get()).id;
      const otherPronunciationRepo = new SQLitePronunciationRepository(otherAdapter);

      const now = new Date().toISOString();

      // Create weaknesses for both learners
      await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'my-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      await otherPronunciationRepo.recordWeakness({
        learnerId: otherLearnerId,
        targetSound: 'other-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      // Each learner should only see their own weaknesses
      const myWeaknesses = await pronunciationRepo.listWeaknesses(learnerId);
      expect(myWeaknesses).toHaveLength(1);
      expect(myWeaknesses[0].targetSound).toBe('my-sound');

      const otherWeaknesses = await otherPronunciationRepo.listWeaknesses(otherLearnerId);
      expect(otherWeaknesses).toHaveLength(1);
      expect(otherWeaknesses[0].targetSound).toBe('other-sound');
    });

    it('limit option works', async () => {
      const now = new Date().toISOString();

      for (let i = 0; i < 5; i++) {
        await pronunciationRepo.recordWeakness({
          learnerId,
          targetSound: `sound-${i}`,
          wordExamples: ['test'],
          occurrenceCount: 1,
          lastSeenAt: now,
          firstSeenAt: now,
          contexts: [],
          exampleTurnIds: [],
          resolved: false,
        });
      }

      const limited = await pronunciationRepo.listWeaknesses(learnerId, { limit: 3 });
      expect(limited).toHaveLength(3);
    });

    it('ordering is newest first by last_seen_at', async () => {
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();

      await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'oldest-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: new Date(baseTime).toISOString(),
        firstSeenAt: new Date(baseTime).toISOString(),
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'middle-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: new Date(baseTime + 1000).toISOString(),
        firstSeenAt: new Date(baseTime + 1000).toISOString(),
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      await pronunciationRepo.recordWeakness({
        learnerId,
        targetSound: 'newest-sound',
        wordExamples: ['test'],
        occurrenceCount: 1,
        lastSeenAt: new Date(baseTime + 2000).toISOString(),
        firstSeenAt: new Date(baseTime + 2000).toISOString(),
        contexts: [],
        exampleTurnIds: [],
        resolved: false,
      });

      const weaknesses = await pronunciationRepo.listWeaknesses(learnerId);
      expect(weaknesses).toHaveLength(3);
      expect(weaknesses[0].targetSound).toBe('newest-sound');
      expect(weaknesses[1].targetSound).toBe('middle-sound');
      expect(weaknesses[2].targetSound).toBe('oldest-sound');
    });
  });

  describe('WeaknessRepository (LearnerWeakness + LearnerStrength + Evidence)', () => {
    let learnerId: string;
    let weaknessRepo: SQLiteWeaknessRepository;

    beforeEach(async () => {
      await createProfile();
      learnerId = await getLearnerId();
      weaknessRepo = new SQLiteWeaknessRepository(adapter);
    });

    it('weakness persists and round-trips', async () => {
      const now = new Date().toISOString();
      const weakness = await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'grammar',
        referenceId: 'grammar-mistake-1',
        status: 'confirmed',
        severity: 0.7,
        occurrenceCount: 3,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: ['conversation', 'writing'],
        evidence: [
          { kind: 'turn', id: 'turn-1', at: now, summary: 'First occurrence' },
          { kind: 'turn', id: 'turn-2', at: now, summary: 'Second occurrence' },
        ],
        notes: 'Consistent error with prepositions',
        resolved: false,
      });

      expect(weakness.id).toBeDefined();
      expect(weakness.learnerId).toBe(learnerId);
      expect(weakness.type).toBe('grammar');
      expect(weakness.referenceId).toBe('grammar-mistake-1');
      expect(weakness.status).toBe('confirmed');
      expect(weakness.severity).toBe(0.7);
      expect(weakness.occurrenceCount).toBe(3);
      expect(weakness.contexts).toEqual(['conversation', 'writing']);
      expect(weakness.evidence).toHaveLength(2);
      expect(weakness.notes).toBe('Consistent error with prepositions');
      expect(weakness.resolved).toBe(false);
      expect(weakness.createdAt).toBeDefined();
      expect(weakness.updatedAt).toBeDefined();

      // Round-trip via listWeaknesses
      const weaknesses = await weaknessRepo.listWeaknesses(learnerId);
      expect(weaknesses).toHaveLength(1);
      expect(weaknesses[0].id).toBe(weakness.id);
      expect(weaknesses[0].status).toBe('confirmed');
    });

    it('lifecycle status survives round-trip', async () => {
      const now = new Date().toISOString();
      const statuses = [
        'observed',
        'repeated',
        'confirmed',
        'active_training',
        'improving',
        'stable',
        'mastered',
        'relapsed',
      ] as const;

      for (const status of statuses) {
        await weaknessRepo.upsertWeakness({
          learnerId,
          type: 'grammar',
          referenceId: `ref-${status}`,
          status,
          severity: 0.5,
          occurrenceCount: 1,
          lastSeenAt: now,
          firstSeenAt: now,
          contexts: [],
          evidence: [],
          resolved: false,
        });
      }

      const weaknesses = await weaknessRepo.listWeaknesses(learnerId);
      expect(weaknesses).toHaveLength(statuses.length);

      const retrievedStatuses = weaknesses.map(w => w.status).sort();
      expect(retrievedStatuses).toEqual([...statuses].sort());
    });

    it('evidence attaches to correct weakness', async () => {
      const now = new Date().toISOString();
      const weakness = await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'pronunciation',
        referenceId: 'pronunciation-weakness-1',
        status: 'confirmed',
        severity: 0.6,
        occurrenceCount: 2,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: ['speaking'],
        evidence: [],
        resolved: false,
      });

      const evidenceId = '550e8400-e29b-41d4-a716-446655440001';
      await weaknessRepo.addWeaknessEvidence({
        id: evidenceId,
        weaknessId: weakness.id,
        kind: 'turn',
        at: now,
        summary: 'Pronunciation error in turn 5',
      });

      // Verify evidence was added by checking the weakness_evidence table directly
      const evidenceRows = await adapter.query(
        `SELECT * FROM weakness_evidence WHERE weakness_id = ?`,
        [weakness.id],
      );
      expect(evidenceRows).toHaveLength(1);
      expect(evidenceRows[0].id).toBe(evidenceId);
      expect(evidenceRows[0].weakness_id).toBe(weakness.id);
      expect(evidenceRows[0].kind).toBe('turn');
      expect(evidenceRows[0].summary).toBe('Pronunciation error in turn 5');
    });

    it('multiple evidence records stay associated correctly', async () => {
      const now = new Date().toISOString();
      const weakness = await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'vocabulary',
        referenceId: 'vocab-item-1',
        status: 'active_training',
        severity: 0.4,
        occurrenceCount: 5,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: ['reading', 'listening'],
        evidence: [],
        resolved: false,
      });

      const evidenceEntries = [
        { id: '550e8400-e29b-41d4-a716-446655440002', kind: 'turn' as const, at: now, summary: 'Turn 1' },
        { id: '550e8400-e29b-41d4-a716-446655440003', kind: 'session' as const, at: now, summary: 'Session 1' },
        { id: '550e8400-e29b-41d4-a716-446655440004', kind: 'observation' as const, at: now, summary: 'Observation 1' },
      ];

      for (const ev of evidenceEntries) {
        await weaknessRepo.addWeaknessEvidence({
          id: ev.id,
          weaknessId: weakness.id,
          kind: ev.kind,
          at: ev.at,
          summary: ev.summary,
        });
      }

      const evidenceRows = await adapter.query(
        `SELECT * FROM weakness_evidence WHERE weakness_id = ? ORDER BY at`,
        [weakness.id],
      );
      expect(evidenceRows).toHaveLength(3);
      expect(evidenceRows[0].id).toBe('550e8400-e29b-41d4-a716-446655440002');
      expect(evidenceRows[1].id).toBe('550e8400-e29b-41d4-a716-446655440003');
      expect(evidenceRows[2].id).toBe('550e8400-e29b-41d4-a716-446655440004');
      expect(evidenceRows[0].kind).toBe('turn');
      expect(evidenceRows[1].kind).toBe('session');
      expect(evidenceRows[2].kind).toBe('observation');
    });

    it('learner filtering prevents cross-learner leakage', async () => {
      // Create another learner
      const otherAdapter = new SqlJsAdapter(':memory:');
      await otherAdapter.init();
      const otherProfileRepo = new SQLiteUserProfileRepository(otherAdapter);
      await otherProfileRepo.update({
        displayName: 'Other Learner',
        targetLanguage: 'en',
        targetLevel: 'A1',
        currentLevel: 'A1',
        learningGoals: [],
        preferredModes: ['natural'],
      });
      const otherLearnerId = (await otherProfileRepo.get()).id;
      const otherWeaknessRepo = new SQLiteWeaknessRepository(otherAdapter);

      const now = new Date().toISOString();

      // Create weaknesses for both learners
      await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'grammar',
        referenceId: 'my-ref',
        status: 'confirmed',
        severity: 0.5,
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        evidence: [],
        resolved: false,
      });

      await otherWeaknessRepo.upsertWeakness({
        learnerId: otherLearnerId,
        type: 'pronunciation',
        referenceId: 'other-ref',
        status: 'observed',
        severity: 0.3,
        occurrenceCount: 1,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        evidence: [],
        resolved: false,
      });

      // Each learner should only see their own weaknesses
      const myWeaknesses = await weaknessRepo.listWeaknesses(learnerId);
      expect(myWeaknesses).toHaveLength(1);
      expect(myWeaknesses[0].type).toBe('grammar');

      const otherWeaknesses = await otherWeaknessRepo.listWeaknesses(otherLearnerId);
      expect(otherWeaknesses).toHaveLength(1);
      expect(otherWeaknesses[0].type).toBe('pronunciation');
    });

    it('strength persists and round-trips', async () => {
      const now = new Date().toISOString();
      const strength = await weaknessRepo.upsertStrength({
        learnerId,
        type: 'grammar',
        referenceId: 'grammar-rule-1',
        confidence: 0.9,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: ['writing', 'formal'],
        evidence: [
          { kind: 'turn', id: 'turn-1', at: now, summary: 'Correct usage' },
        ],
        notes: 'Strong command of conditionals',
      });

      expect(strength.id).toBeDefined();
      expect(strength.learnerId).toBe(learnerId);
      expect(strength.type).toBe('grammar');
      expect(strength.referenceId).toBe('grammar-rule-1');
      expect(strength.confidence).toBe(0.9);
      expect(strength.contexts).toEqual(['writing', 'formal']);
      expect(strength.evidence).toHaveLength(1);
      expect(strength.notes).toBe('Strong command of conditionals');
      expect(strength.createdAt).toBeDefined();
      expect(strength.updatedAt).toBeDefined();

      // Round-trip via listStrengths
      const strengths = await weaknessRepo.listStrengths(learnerId);
      expect(strengths).toHaveLength(1);
      expect(strengths[0].id).toBe(strength.id);
      expect(strengths[0].confidence).toBe(0.9);
    });

    it('strength learner filtering works', async () => {
      // Create another learner
      const otherAdapter = new SqlJsAdapter(':memory:');
      await otherAdapter.init();
      const otherProfileRepo = new SQLiteUserProfileRepository(otherAdapter);
      await otherProfileRepo.update({
        displayName: 'Other Learner',
        targetLanguage: 'en',
        targetLevel: 'A1',
        currentLevel: 'A1',
        learningGoals: [],
        preferredModes: ['natural'],
      });
      const otherLearnerId = (await otherProfileRepo.get()).id;
      const otherWeaknessRepo = new SQLiteWeaknessRepository(otherAdapter);

      const now = new Date().toISOString();

      // Create strengths for both learners
      await weaknessRepo.upsertStrength({
        learnerId,
        type: 'vocabulary',
        referenceId: 'my-vocab',
        confidence: 0.8,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        evidence: [],
      });

      await otherWeaknessRepo.upsertStrength({
        learnerId: otherLearnerId,
        type: 'fluency',
        referenceId: 'other-fluency',
        confidence: 0.7,
        lastSeenAt: now,
        firstSeenAt: now,
        contexts: [],
        evidence: [],
      });

      // Each learner should only see their own strengths
      const myStrengths = await weaknessRepo.listStrengths(learnerId);
      expect(myStrengths).toHaveLength(1);
      expect(myStrengths[0].type).toBe('vocabulary');

      const otherStrengths = await otherWeaknessRepo.listStrengths(otherLearnerId);
      expect(otherStrengths).toHaveLength(1);
      expect(otherStrengths[0].type).toBe('fluency');
    });

    it('unknown weakness evidence target fails via FK', async () => {
      const now = new Date().toISOString();
      const validButMissing = '550e8400-e29b-41d4-a716-446655440000';

      await expect(
        weaknessRepo.addWeaknessEvidence({
          id: '550e8400-e29b-41d4-a716-446655440005',
          weaknessId: validButMissing,
          kind: 'turn',
          at: now,
        }),
      ).rejects.toThrow('Weakness not found');
    });

    it('deterministic list ordering', async () => {
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();

      await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'grammar',
        referenceId: 'ref-oldest',
        status: 'observed',
        severity: 0.3,
        occurrenceCount: 1,
        lastSeenAt: new Date(baseTime).toISOString(),
        firstSeenAt: new Date(baseTime).toISOString(),
        contexts: [],
        evidence: [],
        resolved: false,
      });

      await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'pronunciation',
        referenceId: 'ref-middle',
        status: 'confirmed',
        severity: 0.6,
        occurrenceCount: 2,
        lastSeenAt: new Date(baseTime + 1000).toISOString(),
        firstSeenAt: new Date(baseTime + 1000).toISOString(),
        contexts: [],
        evidence: [],
        resolved: false,
      });

      await weaknessRepo.upsertWeakness({
        learnerId,
        type: 'vocabulary',
        referenceId: 'ref-newest',
        status: 'mastered',
        severity: 0.1,
        occurrenceCount: 1,
        lastSeenAt: new Date(baseTime + 2000).toISOString(),
        firstSeenAt: new Date(baseTime + 2000).toISOString(),
        contexts: [],
        evidence: [],
        resolved: true,
      });

      const weaknesses = await weaknessRepo.listWeaknesses(learnerId);
      expect(weaknesses).toHaveLength(3);
      // Ordered by last_seen_at DESC (newest first)
      expect(weaknesses[0].referenceId).toBe('ref-newest');
      expect(weaknesses[1].referenceId).toBe('ref-middle');
      expect(weaknesses[2].referenceId).toBe('ref-oldest');
    });
  });
});