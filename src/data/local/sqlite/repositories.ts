/**
 * src/data/local/sqlite/repositories.ts
 *
 * SQLite implementations of UserProfileRepository and ConversationRepository.
 *
 * These implementations:
 * - Use parameterized SQL only
 * - Map DB rows (snake_case) to domain objects (camelCase)
 * - Handle optional fields safely
 * - Preserve id/createdAt on updates
 * - Update updatedAt on modifications
 * - Do not leak raw SQL outside this layer
 */

import type {
  DatabaseAdapter,
  SqlParam,
  SqlRow,
} from './DatabaseAdapter';
import type {
  UserProfileRepository,
  ConversationRepository,
} from '../../../repositories';
import type {
  UserProfile,
} from '../../../domain/models/learner';
import type {
  ConversationSession,
  ConversationTurn,
} from '../../../domain/models/conversation';
import { generateId, isValidUuid } from '../../../shared/id';

/** Current ISO timestamp helper. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Safely parse JSON, returning default on failure. */
function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Map learner_profile row to UserProfile domain object. */
function rowToUserProfile(row: SqlRow): UserProfile {
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    nativeLanguage: (row.native_language as string) ?? undefined,
    targetLanguage: row.target_language as string,
    targetLevel: row.target_level as UserProfile['targetLevel'],
    currentLevel: row.current_level as UserProfile['currentLevel'],
    learningGoals: safeJsonParse(row.learning_goals, []),
    preferredModes: safeJsonParse(row.preferred_modes, []),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Map conversation_sessions row to ConversationSession domain object. */
function rowToConversationSession(row: SqlRow): ConversationSession {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    mode: row.mode as ConversationSession['mode'],
    title: (row.title as string) ?? undefined,
    topic: (row.topic as string) ?? undefined,
    topicSource: (row.topic_source as ConversationSession['topicSource']) ?? undefined,
    status: row.status as ConversationSession['status'],
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? undefined,
    durationSeconds: (row.duration_seconds as number) ?? undefined,
    difficulty: (row.difficulty as ConversationSession['difficulty']) ?? undefined,
    turnCount: row.turn_count as number,
    summary: (row.summary as string) ?? undefined,
    tags: safeJsonParse(row.tags, []),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Map conversation_turns row to ConversationTurn domain object. */
function rowToConversationTurn(row: SqlRow): ConversationTurn {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    speaker: row.speaker as ConversationTurn['speaker'],
    text: row.text as string,
    audioRef: (row.audio_ref as string) ?? undefined,
    detectedLanguage: (row.detected_language as string) ?? undefined,
    turnIndex: row.sequence_number as number,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? undefined,
    durationMs: (row.duration_ms as number) ?? undefined,
    confidence: (row.confidence as number) ?? undefined,
    metadata: safeJsonParse(row.metadata, {}),
  };
}

/** Build partial UPDATE SQL and params for a session. */
function buildSessionUpdate(
  id: string,
  patch: Partial<Omit<ConversationSession, 'id' | 'createdAt'>>,
): { sql: string; params: SqlParam[] } {
  const fields: string[] = [];
  const params: SqlParam[] = [];

  const fieldMap: Record<string, string> = {
    learnerId: 'learner_id',
    mode: 'mode',
    title: 'title',
    topic: 'topic',
    topicSource: 'topic_source',
    status: 'status',
    startedAt: 'started_at',
    endedAt: 'ended_at',
    durationSeconds: 'duration_seconds',
    difficulty: 'difficulty',
    turnCount: 'turn_count',
    summary: 'summary',
    tags: 'tags',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      if (key === 'tags') {
        params.push(JSON.stringify(value));
      } else {
        params.push(value as SqlParam);
      }
    }
  }

  // Always update updatedAt
  fields.push('updated_at = ?');
  params.push(nowIso());

  // WHERE clause
  params.push(id);

  const sql = `UPDATE conversation_sessions SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/** Build partial UPDATE SQL and params for a profile. */
function buildProfileUpdate(
  id: string,
  patch: Partial<Omit<UserProfile, 'id' | 'createdAt'>>,
): { sql: string; params: SqlParam[] } {
  const fields: string[] = [];
  const params: SqlParam[] = [];

  const fieldMap: Record<string, string> = {
    displayName: 'display_name',
    nativeLanguage: 'native_language',
    targetLanguage: 'target_language',
    targetLevel: 'target_level',
    currentLevel: 'current_level',
    learningGoals: 'learning_goals',
    preferredModes: 'preferred_modes',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      if (key === 'learningGoals' || key === 'preferredModes') {
        params.push(JSON.stringify(value));
      } else {
        params.push(value as SqlParam);
      }
    }
  }

  // Always update updatedAt
  fields.push('updated_at = ?');
  params.push(nowIso());

  // WHERE clause
  params.push(id);

  const sql = `UPDATE learner_profile SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/**
 * SQLiteUserProfileRepository
 *
 * Single-profile implementation for a personal app.
 * Does not add authentication, accounts, or cloud sync.
 */
export class SQLiteUserProfileRepository implements UserProfileRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async get(): Promise<UserProfile> {
    const rows = await this.adapter.query(
      `SELECT * FROM learner_profile LIMIT 1`,
    );

    if (rows.length === 0) {
      throw new Error('No user profile found. Call update() first to create one.');
    }

    return rowToUserProfile(rows[0]);
  }

  async update(
    patch: Partial<Omit<UserProfile, 'id' | 'createdAt'>>,
  ): Promise<UserProfile> {
    // Check if profile exists
    const existing = await this.adapter.query(
      `SELECT id FROM learner_profile LIMIT 1`,
    );

    const now = nowIso();

    if (existing.length === 0) {
      // Create new profile - require minimal fields
      const id = generateId();
      const displayName = patch.displayName ?? 'Learner';
      const targetLanguage = patch.targetLanguage ?? 'en';
      const targetLevel = patch.targetLevel ?? 'unknown';
      const currentLevel = patch.currentLevel ?? 'unknown';
      const learningGoals = patch.learningGoals ?? [];
      const preferredModes = patch.preferredModes ?? [];
      const nativeLanguage = patch.nativeLanguage ?? null;

      await this.adapter.execute(
        `INSERT INTO learner_profile (
          id, display_name, native_language, target_language,
          target_level, current_level, learning_goals, preferred_modes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          displayName,
          nativeLanguage,
          targetLanguage,
          targetLevel,
          currentLevel,
          JSON.stringify(learningGoals),
          JSON.stringify(preferredModes),
          now,
          now,
        ],
      );

      return this.get();
    }

    // Update existing profile
    const id = existing[0].id as string;
    const { sql, params } = buildProfileUpdate(id, patch);
    await this.adapter.execute(sql, params);

    return this.get();
  }
}

/**
 * SQLiteConversationRepository
 *
 * Implements ConversationRepository contract using SQLite.
 * All methods use parameterized queries and explicit row mapping.
 */
export class SQLiteConversationRepository implements ConversationRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async createSession(
    session: Omit<ConversationSession, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ConversationSession> {
    const id = generateId();
    const now = nowIso();

    // Validate required fields
    if (!session.learnerId || !isValidUuid(session.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!session.mode) {
      throw new Error('mode is required');
    }
    if (!session.status) {
      throw new Error('status is required');
    }
    if (!session.startedAt) {
      throw new Error('startedAt is required');
    }

    await this.adapter.execute(
      `INSERT INTO conversation_sessions (
        id, learner_id, mode, title, topic, topic_source, status,
        started_at, ended_at, duration_seconds, difficulty, turn_count,
        summary, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        session.learnerId,
        session.mode,
        session.title ?? null,
        session.topic ?? null,
        session.topicSource ?? null,
        session.status,
        session.startedAt,
        session.endedAt ?? null,
        session.durationSeconds ?? null,
        session.difficulty ?? null,
        session.turnCount ?? 0,
        session.summary ?? null,
        JSON.stringify(session.tags ?? []),
        now,
        now,
      ],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM conversation_sessions WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Failed to create session');
    }

    return rowToConversationSession(rows[0]);
  }

  async getSession(id: string): Promise<ConversationSession | null> {
    if (!isValidUuid(id)) return null;

    const rows = await this.adapter.query(
      `SELECT * FROM conversation_sessions WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) return null;

    return rowToConversationSession(rows[0]);
  }

  async listSessions(
    learnerId: string,
    limit?: number,
  ): Promise<readonly ConversationSession[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM conversation_sessions WHERE learner_id = ? ORDER BY started_at DESC`;
    const params: SqlParam[] = [learnerId];

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToConversationSession);
  }

  async updateSession(
    id: string,
    patch: Partial<Omit<ConversationSession, 'id' | 'createdAt'>>,
  ): Promise<ConversationSession> {
    if (!isValidUuid(id)) {
      throw new Error('Invalid session id');
    }

    // Verify session exists
    const existing = await this.getSession(id);
    if (!existing) {
      throw new Error(`Session not found: ${id}`);
    }

    const { sql, params } = buildSessionUpdate(id, patch);
    await this.adapter.execute(sql, params);

    const updated = await this.getSession(id);
    if (!updated) {
      throw new Error('Session disappeared after update');
    }

    return updated;
  }

  async addTurn(
    turn: Omit<ConversationTurn, 'id'>,
  ): Promise<ConversationTurn> {
    const id = generateId();
    const now = nowIso();

    // Validate required fields
    if (!turn.sessionId || !isValidUuid(turn.sessionId)) {
      throw new Error('Invalid sessionId');
    }
    if (!turn.speaker) {
      throw new Error('speaker is required');
    }
    if (turn.text === undefined || turn.text === null) {
      throw new Error('text is required');
    }
    if (turn.turnIndex === undefined || turn.turnIndex === null) {
      throw new Error('turnIndex is required');
    }
    if (!turn.startedAt) {
      throw new Error('startedAt is required');
    }

    await this.adapter.execute(
      `INSERT INTO conversation_turns (
        id, session_id, speaker, text, audio_ref, detected_language,
        sequence_number, started_at, ended_at, duration_ms, confidence,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        turn.sessionId,
        turn.speaker,
        turn.text,
        turn.audioRef ?? null,
        turn.detectedLanguage ?? null,
        turn.turnIndex,
        turn.startedAt,
        turn.endedAt ?? null,
        turn.durationMs ?? null,
        turn.confidence ?? null,
        JSON.stringify(turn.metadata ?? {}),
        now,
        now,
      ],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM conversation_turns WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Failed to create turn');
    }

    return rowToConversationTurn(rows[0]);
  }

  async listTurns(sessionId: string): Promise<readonly ConversationTurn[]> {
    if (!isValidUuid(sessionId)) return [];

    const rows = await this.adapter.query(
      `SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY sequence_number ASC`,
      [sessionId],
    );

    return rows.map(rowToConversationTurn);
  }
}