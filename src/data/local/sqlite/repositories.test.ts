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
import { SQLiteUserProfileRepository, SQLiteConversationRepository } from './repositories';
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
});