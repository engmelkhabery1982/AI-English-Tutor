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
  MistakeRepository,
  PronunciationRepository,
  WeaknessRepository,
  VocabularyRepository,
} from '../../../repositories';
import type {
  UserProfile,
  GrammarMistake,
  PronunciationWeakness,
  LearnerWeakness,
  LearnerStrength,
} from '../../../domain/models/learner';
import type { EvidenceRef } from '../../../domain/shared/types';
import type {
  ConversationSession,
  ConversationTurn,
} from '../../../domain/models/conversation';
import type {
  VocabularyItem,
  Meaning,
} from '../../../domain/models/vocabulary';
import type {
  ReviewSchedule,
  MasteryState,
  UsageExample,
  ExampleSource,
} from '../../../domain/shared/types';
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

/** Map grammar_mistakes row to GrammarMistake domain object. */
function rowToGrammarMistake(row: SqlRow): GrammarMistake {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    category: row.category as string,
    pattern: row.pattern as string,
    correction: row.correction as string,
    explanation: (row.explanation as string) ?? undefined,
    severity: row.severity as GrammarMistake['severity'],
    occurrenceCount: row.occurrence_count as number,
    lastSeenAt: row.last_seen_at as string,
    firstSeenAt: row.first_seen_at as string,
    contexts: safeJsonParse(row.contexts, []),
    exampleTurnIds: safeJsonParse(row.example_turn_ids, []),
    originSessionId: (row.origin_session_id as string) ?? undefined,
    originTurnId: (row.origin_turn_id as string) ?? undefined,
    resolved: (row.resolved as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Map pronunciation_weaknesses row to PronunciationWeakness domain object. */
function rowToPronunciationWeakness(row: SqlRow): PronunciationWeakness {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    targetSound: row.target_sound as string,
    wordExamples: safeJsonParse(row.word_examples, []),
    occurrenceCount: row.occurrence_count as number,
    lastSeenAt: row.last_seen_at as string,
    firstSeenAt: row.first_seen_at as string,
    contexts: safeJsonParse(row.contexts, []),
    exampleTurnIds: safeJsonParse(row.example_turn_ids, []),
    originSessionId: (row.origin_session_id as string) ?? undefined,
    originTurnId: (row.origin_turn_id as string) ?? undefined,
    resolved: (row.resolved as number) === 1,
    notes: (row.notes as string) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Map learner_weaknesses row to LearnerWeakness domain object. */
function rowToLearnerWeakness(row: SqlRow): LearnerWeakness {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    type: row.type as LearnerWeakness['type'],
    referenceId: row.reference_id as string,
    status: row.status as LearnerWeakness['status'],
    severity: row.severity as number,
    occurrenceCount: row.occurrence_count as number,
    lastSeenAt: row.last_seen_at as string,
    firstSeenAt: row.first_seen_at as string,
    contexts: safeJsonParse(row.contexts, []),
    evidence: safeJsonParse(row.evidence, []),
    notes: (row.notes as string) ?? undefined,
    resolved: (row.resolved as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Map learner_strengths row to LearnerStrength domain object. */
function rowToLearnerStrength(row: SqlRow): LearnerStrength {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    type: row.type as LearnerStrength['type'],
    referenceId: row.reference_id as string,
    confidence: row.confidence as number,
    lastSeenAt: row.last_seen_at as string,
    firstSeenAt: row.first_seen_at as string,
    contexts: safeJsonParse(row.contexts, []),
    evidence: safeJsonParse(row.evidence, []),
    notes: (row.notes as string) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Build partial UPDATE SQL and params for a grammar mistake. */
function buildGrammarMistakeUpdate(
  id: string,
  patch: Partial<Omit<GrammarMistake, 'id' | 'createdAt'>>,
): { sql: string; params: SqlParam[] } {
  const fields: string[] = [];
  const params: SqlParam[] = [];

  const fieldMap: Record<string, string> = {
    learnerId: 'learner_id',
    category: 'category',
    pattern: 'pattern',
    correction: 'correction',
    explanation: 'explanation',
    severity: 'severity',
    occurrenceCount: 'occurrence_count',
    lastSeenAt: 'last_seen_at',
    firstSeenAt: 'first_seen_at',
    contexts: 'contexts',
    exampleTurnIds: 'example_turn_ids',
    originSessionId: 'origin_session_id',
    originTurnId: 'origin_turn_id',
    resolved: 'resolved',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      if (key === 'contexts' || key === 'exampleTurnIds') {
        params.push(JSON.stringify(value));
      } else if (key === 'resolved') {
        params.push(value ? 1 : 0);
      } else {
        params.push(value as SqlParam);
      }
    }
  }

  fields.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  const sql = `UPDATE grammar_mistakes SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/** Build partial UPDATE SQL and params for a pronunciation weakness. */
function buildPronunciationWeaknessUpdate(
  id: string,
  patch: Partial<Omit<PronunciationWeakness, 'id' | 'createdAt'>>,
): { sql: string; params: SqlParam[] } {
  const fields: string[] = [];
  const params: SqlParam[] = [];

  const fieldMap: Record<string, string> = {
    learnerId: 'learner_id',
    targetSound: 'target_sound',
    wordExamples: 'word_examples',
    occurrenceCount: 'occurrence_count',
    lastSeenAt: 'last_seen_at',
    firstSeenAt: 'first_seen_at',
    contexts: 'contexts',
    exampleTurnIds: 'example_turn_ids',
    originSessionId: 'origin_session_id',
    originTurnId: 'origin_turn_id',
    resolved: 'resolved',
    notes: 'notes',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      if (key === 'wordExamples' || key === 'contexts' || key === 'exampleTurnIds') {
        params.push(JSON.stringify(value));
      } else if (key === 'resolved') {
        params.push(value ? 1 : 0);
      } else {
        params.push(value as SqlParam);
      }
    }
  }

  fields.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  const sql = `UPDATE pronunciation_weaknesses SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/** Build partial UPDATE SQL and params for a learner weakness. */
function buildLearnerWeaknessUpdate(
  id: string,
  patch: Partial<Omit<LearnerWeakness, 'id' | 'createdAt'>>,
): { sql: string; params: SqlParam[] } {
  const fields: string[] = [];
  const params: SqlParam[] = [];

  const fieldMap: Record<string, string> = {
    learnerId: 'learner_id',
    type: 'type',
    referenceId: 'reference_id',
    status: 'status',
    severity: 'severity',
    occurrenceCount: 'occurrence_count',
    lastSeenAt: 'last_seen_at',
    firstSeenAt: 'first_seen_at',
    contexts: 'contexts',
    evidence: 'evidence',
    notes: 'notes',
    resolved: 'resolved',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      if (key === 'contexts' || key === 'evidence') {
        params.push(JSON.stringify(value));
      } else if (key === 'resolved') {
        params.push(value ? 1 : 0);
      } else {
        params.push(value as SqlParam);
      }
    }
  }

  fields.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  const sql = `UPDATE learner_weaknesses SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/** Build partial UPDATE SQL and params for a learner strength. */
function buildLearnerStrengthUpdate(
  id: string,
  patch: Partial<Omit<LearnerStrength, 'id' | 'createdAt'>>,
): { sql: string; params: SqlParam[] } {
  const fields: string[] = [];
  const params: SqlParam[] = [];

  const fieldMap: Record<string, string> = {
    learnerId: 'learner_id',
    type: 'type',
    referenceId: 'reference_id',
    confidence: 'confidence',
    lastSeenAt: 'last_seen_at',
    firstSeenAt: 'first_seen_at',
    contexts: 'contexts',
    evidence: 'evidence',
    notes: 'notes',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      if (key === 'contexts' || key === 'evidence') {
        params.push(JSON.stringify(value));
      } else {
        params.push(value as SqlParam);
      }
    }
  }

  fields.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  const sql = `UPDATE learner_strengths SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/**
 * SQLiteMistakeRepository
 *
 * Implements MistakeRepository for grammar mistakes.
 */
export class SQLiteMistakeRepository implements MistakeRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async recordMistake(
    mistake: Omit<GrammarMistake, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GrammarMistake> {
    const id = generateId();
    const now = nowIso();

    // Validate required fields
    if (!mistake.learnerId || !isValidUuid(mistake.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!mistake.category) {
      throw new Error('category is required');
    }
    if (!mistake.pattern) {
      throw new Error('pattern is required');
    }
    if (!mistake.correction) {
      throw new Error('correction is required');
    }
    if (!mistake.severity) {
      throw new Error('severity is required');
    }
    if (!mistake.lastSeenAt) {
      throw new Error('lastSeenAt is required');
    }
    if (!mistake.firstSeenAt) {
      throw new Error('firstSeenAt is required');
    }

    await this.adapter.execute(
      `INSERT INTO grammar_mistakes (
        id, learner_id, category, pattern, correction, explanation,
        severity, occurrence_count, last_seen_at, first_seen_at,
        contexts, example_turn_ids, origin_session_id, origin_turn_id,
        resolved, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        mistake.learnerId,
        mistake.category,
        mistake.pattern,
        mistake.correction,
        mistake.explanation ?? null,
        mistake.severity,
        mistake.occurrenceCount ?? 1,
        mistake.lastSeenAt,
        mistake.firstSeenAt,
        JSON.stringify(mistake.contexts ?? []),
        JSON.stringify(mistake.exampleTurnIds ?? []),
        mistake.originSessionId ?? null,
        mistake.originTurnId ?? null,
        mistake.resolved ? 1 : 0,
        now,
        now,
      ],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM grammar_mistakes WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Failed to create grammar mistake');
    }

    return rowToGrammarMistake(rows[0]);
  }

  async listMistakes(
    learnerId: string,
    opts?: { resolved?: boolean; limit?: number },
  ): Promise<readonly GrammarMistake[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM grammar_mistakes WHERE learner_id = ?`;
    const params: SqlParam[] = [learnerId];

    if (opts?.resolved !== undefined) {
      sql += ` AND resolved = ?`;
      params.push(opts.resolved ? 1 : 0);
    }

    sql += ` ORDER BY last_seen_at DESC`;

    if (opts?.limit !== undefined && opts.limit > 0) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToGrammarMistake);
  }

  async markResolved(id: string, resolved: boolean): Promise<GrammarMistake> {
    if (!isValidUuid(id)) {
      throw new Error('Invalid mistake id');
    }

    const existing = await this.adapter.query(
      `SELECT * FROM grammar_mistakes WHERE id = ?`,
      [id],
    );

    if (existing.length === 0) {
      throw new Error(`Grammar mistake not found: ${id}`);
    }

    const { sql, params } = buildGrammarMistakeUpdate(id, { resolved });
    await this.adapter.execute(sql, params);

    const rows = await this.adapter.query(
      `SELECT * FROM grammar_mistakes WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Grammar mistake disappeared after update');
    }

    return rowToGrammarMistake(rows[0]);
  }
}

/**
 * SQLitePronunciationRepository
 *
 * Implements PronunciationRepository for pronunciation weaknesses.
 * NO fabricated pronunciation scores - only evidence/observations.
 */
export class SQLitePronunciationRepository implements PronunciationRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async recordWeakness(
    weakness: Omit<PronunciationWeakness, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PronunciationWeakness> {
    const id = generateId();
    const now = nowIso();

    // Validate required fields
    if (!weakness.learnerId || !isValidUuid(weakness.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!weakness.targetSound) {
      throw new Error('targetSound is required');
    }
    if (!weakness.lastSeenAt) {
      throw new Error('lastSeenAt is required');
    }
    if (!weakness.firstSeenAt) {
      throw new Error('firstSeenAt is required');
    }

    await this.adapter.execute(
      `INSERT INTO pronunciation_weaknesses (
        id, learner_id, target_sound, word_examples, occurrence_count,
        last_seen_at, first_seen_at, contexts, example_turn_ids,
        origin_session_id, origin_turn_id, resolved, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        weakness.learnerId,
        weakness.targetSound,
        JSON.stringify(weakness.wordExamples ?? []),
        weakness.occurrenceCount ?? 1,
        weakness.lastSeenAt,
        weakness.firstSeenAt,
        JSON.stringify(weakness.contexts ?? []),
        JSON.stringify(weakness.exampleTurnIds ?? []),
        weakness.originSessionId ?? null,
        weakness.originTurnId ?? null,
        weakness.resolved ? 1 : 0,
        weakness.notes ?? null,
        now,
        now,
      ],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM pronunciation_weaknesses WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Failed to create pronunciation weakness');
    }

    return rowToPronunciationWeakness(rows[0]);
  }

  async listWeaknesses(
    learnerId: string,
    opts?: { resolved?: boolean; limit?: number },
  ): Promise<readonly PronunciationWeakness[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM pronunciation_weaknesses WHERE learner_id = ?`;
    const params: SqlParam[] = [learnerId];

    if (opts?.resolved !== undefined) {
      sql += ` AND resolved = ?`;
      params.push(opts.resolved ? 1 : 0);
    }

    sql += ` ORDER BY last_seen_at DESC`;

    if (opts?.limit !== undefined && opts.limit > 0) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToPronunciationWeakness);
  }

  async markResolved(id: string, resolved: boolean): Promise<PronunciationWeakness> {
    if (!isValidUuid(id)) {
      throw new Error('Invalid pronunciation weakness id');
    }

    const existing = await this.adapter.query(
      `SELECT * FROM pronunciation_weaknesses WHERE id = ?`,
      [id],
    );

    if (existing.length === 0) {
      throw new Error(`Pronunciation weakness not found: ${id}`);
    }

    const { sql, params } = buildPronunciationWeaknessUpdate(id, { resolved });
    await this.adapter.execute(sql, params);

    const rows = await this.adapter.query(
      `SELECT * FROM pronunciation_weaknesses WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Pronunciation weakness disappeared after update');
    }

    return rowToPronunciationWeakness(rows[0]);
  }
}

/**
 * SQLiteWeaknessRepository
 *
 * Implements WeaknessRepository for learner weaknesses and strengths.
 * Includes persistence methods for upserting weaknesses/strengths and adding evidence.
 */
export class SQLiteWeaknessRepository implements WeaknessRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async listWeaknesses(learnerId: string, limit?: number): Promise<readonly LearnerWeakness[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM learner_weaknesses WHERE learner_id = ? ORDER BY last_seen_at DESC`;
    const params: SqlParam[] = [learnerId];

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToLearnerWeakness);
  }

  async listStrengths(learnerId: string, limit?: number): Promise<readonly LearnerStrength[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM learner_strengths WHERE learner_id = ? ORDER BY last_seen_at DESC`;
    const params: SqlParam[] = [learnerId];

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToLearnerStrength);
  }

  async upsertWeakness(
    weakness: Omit<LearnerWeakness, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<LearnerWeakness> {
    // Check if a weakness with same learner_id, type, reference_id exists
    const existing = await this.adapter.query(
      `SELECT * FROM learner_weaknesses WHERE learner_id = ? AND type = ? AND reference_id = ?`,
      [weakness.learnerId, weakness.type, weakness.referenceId],
    );

    const now = nowIso();

    if (existing.length > 0) {
      // Update existing
      const id = existing[0].id as string;
      const { sql, params } = buildLearnerWeaknessUpdate(id, weakness);
      await this.adapter.execute(sql, params);

      const rows = await this.adapter.query(
        `SELECT * FROM learner_weaknesses WHERE id = ?`,
        [id],
      );

      if (rows.length === 0) {
        throw new Error('Weakness disappeared after update');
      }

      return rowToLearnerWeakness(rows[0]);
    }

    // Create new
    const id = generateId();

    // Validate required fields
    if (!weakness.learnerId || !isValidUuid(weakness.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!weakness.type) {
      throw new Error('type is required');
    }
    if (!weakness.referenceId) {
      throw new Error('referenceId is required');
    }
    if (!weakness.status) {
      throw new Error('status is required');
    }
    if (weakness.severity === undefined || weakness.severity === null) {
      throw new Error('severity is required');
    }
    if (!weakness.lastSeenAt) {
      throw new Error('lastSeenAt is required');
    }
    if (!weakness.firstSeenAt) {
      throw new Error('firstSeenAt is required');
    }

    await this.adapter.execute(
      `INSERT INTO learner_weaknesses (
        id, learner_id, type, reference_id, status, severity,
        occurrence_count, last_seen_at, first_seen_at, contexts,
        evidence, notes, resolved, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        weakness.learnerId,
        weakness.type,
        weakness.referenceId,
        weakness.status,
        weakness.severity,
        weakness.occurrenceCount ?? 1,
        weakness.lastSeenAt,
        weakness.firstSeenAt,
        JSON.stringify(weakness.contexts ?? []),
        JSON.stringify(weakness.evidence ?? []),
        weakness.notes ?? null,
        weakness.resolved ? 1 : 0,
        now,
        now,
      ],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM learner_weaknesses WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Failed to create learner weakness');
    }

    return rowToLearnerWeakness(rows[0]);
  }

  async upsertStrength(
    strength: Omit<LearnerStrength, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<LearnerStrength> {
    // Check if a strength with same learner_id, type, reference_id exists
    const existing = await this.adapter.query(
      `SELECT * FROM learner_strengths WHERE learner_id = ? AND type = ? AND reference_id = ?`,
      [strength.learnerId, strength.type, strength.referenceId],
    );

    const now = nowIso();

    if (existing.length > 0) {
      // Update existing
      const id = existing[0].id as string;
      const { sql, params } = buildLearnerStrengthUpdate(id, strength);
      await this.adapter.execute(sql, params);

      const rows = await this.adapter.query(
        `SELECT * FROM learner_strengths WHERE id = ?`,
        [id],
      );

      if (rows.length === 0) {
        throw new Error('Strength disappeared after update');
      }

      return rowToLearnerStrength(rows[0]);
    }

    // Create new
    const id = generateId();

    // Validate required fields
    if (!strength.learnerId || !isValidUuid(strength.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!strength.type) {
      throw new Error('type is required');
    }
    if (!strength.referenceId) {
      throw new Error('referenceId is required');
    }
    if (strength.confidence === undefined || strength.confidence === null) {
      throw new Error('confidence is required');
    }
    if (!strength.lastSeenAt) {
      throw new Error('lastSeenAt is required');
    }
    if (!strength.firstSeenAt) {
      throw new Error('firstSeenAt is required');
    }

    await this.adapter.execute(
      `INSERT INTO learner_strengths (
        id, learner_id, type, reference_id, confidence,
        last_seen_at, first_seen_at, contexts, evidence, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        strength.learnerId,
        strength.type,
        strength.referenceId,
        strength.confidence,
        strength.lastSeenAt,
        strength.firstSeenAt,
        JSON.stringify(strength.contexts ?? []),
        JSON.stringify(strength.evidence ?? []),
        strength.notes ?? null,
        now,
        now,
      ],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM learner_strengths WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Failed to create learner strength');
    }

    return rowToLearnerStrength(rows[0]);
  }

  async addWeaknessEvidence(evidence: Omit<EvidenceRef, 'kind'> & { weaknessId: string; kind: EvidenceRef['kind'] }): Promise<void> {
    if (!isValidUuid(evidence.weaknessId)) {
      throw new Error('Invalid weaknessId');
    }
    if (!isValidUuid(evidence.id)) {
      throw new Error('Invalid evidence id');
    }
    if (!evidence.kind) {
      throw new Error('kind is required');
    }
    if (!evidence.at) {
      throw new Error('at is required');
    }

    // Verify weakness exists
    const existing = await this.adapter.query(
      `SELECT id FROM learner_weaknesses WHERE id = ?`,
      [evidence.weaknessId],
    );

    if (existing.length === 0) {
      throw new Error(`Weakness not found: ${evidence.weaknessId}`);
    }

    await this.adapter.execute(
      `INSERT INTO weakness_evidence (id, weakness_id, kind, ref_id, at, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        evidence.id,
        evidence.weaknessId,
        evidence.kind,
        evidence.id, // ref_id uses the same id as evidence id
        evidence.at,
        evidence.summary ?? null,
      ],
    );
  }
}

/** Map lexical_items row to VocabularyItem domain object (without meanings). */
function rowToVocabularyItem(row: SqlRow): Omit<VocabularyItem, 'meanings'> {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    headword: row.headword as string,
    type: row.type as VocabularyItem['type'],
    pronunciation: safeJsonParse(row.pronunciation, {}),
    synonyms: safeJsonParse(row.synonyms, []),
    antonyms: safeJsonParse(row.antonyms, []),
    relatedExpressions: safeJsonParse(row.related_expressions, []),
    source: safeJsonParse(row.source, {
      originConversationId: undefined,
      originTurnId: undefined,
      addedBy: 'system',
      addedAt: row.created_at as string,
    }),
    tags: safeJsonParse(row.tags, []),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Map lexical_meanings row to Meaning domain object. */
function rowToMeaning(row: SqlRow): Meaning {
  const reviewState = row.review_state as MasteryState | undefined;
  const review: ReviewSchedule | undefined = reviewState
    ? {
        state: reviewState,
        lastReviewAt: (row.review_last_review_at as string) ?? undefined,
        nextReviewAt: (row.review_next_review_at as string) ?? undefined,
        reviewCount: (row.review_review_count as number) ?? 0,
        consecutiveCorrect: (row.review_consecutive_correct as number) ?? 0,
        easeFactor: (row.review_ease_factor as number) ?? undefined,
      }
    : undefined;

  return {
    definition: row.definition as string,
    partOfSpeech: (row.part_of_speech as Meaning['partOfSpeech']) ?? undefined,
    examples: safeJsonParse(row.examples, []),
    usageNotes: safeJsonParse(row.usage_notes, []),
    register: (row.register as Meaning['register']) ?? undefined,
    domain: (row.domain as string) ?? undefined,
    review,
  };
}

/** Map DB source to domain ExampleSource. */
function dbSourceToDomain(source: string): ExampleSource {
  // DB stores the same canonical values as domain
  return source as ExampleSource;
}

/** Map domain ExampleSource to DB source. */
function domainSourceToDb(source: ExampleSource): string {
  return source;
}

/** Insert examples for a meaning into lexical_examples table. */
async function insertExamplesForMeaning(
  adapter: DatabaseAdapter,
  lexicalItemId: string,
  meaningId: string,
  examples: readonly UsageExample[],
  now: string,
): Promise<void> {
  for (const example of examples) {
    const exampleId = generateId();
    await adapter.execute(
      `INSERT INTO lexical_examples (
        id, lexical_item_id, meaning_id, text, translation, context,
        source, origin_conversation_id, origin_turn_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        exampleId,
        lexicalItemId,
        meaningId,
        example.text,
        example.translation ?? null,
        example.context ?? null,
        domainSourceToDb(example.source),
        example.originConversationId ?? null,
        example.originTurnId ?? null,
        example.createdAt ?? now,
      ],
    );
  }
}

/** Fetch examples for a meaning from lexical_examples table. */
async function fetchExamplesForMeaning(
  adapter: DatabaseAdapter,
  meaningId: string,
): Promise<UsageExample[]> {
  const rows = await adapter.query(
    `SELECT * FROM lexical_examples WHERE meaning_id = ? ORDER BY created_at`,
    [meaningId],
  );

  return rows.map((row) => ({
    text: row.text as string,
    translation: (row.translation as string) ?? undefined,
    context: (row.context as string) ?? undefined,
    source: dbSourceToDomain(row.source as string),
    originConversationId: (row.origin_conversation_id as string) ?? undefined,
    originTurnId: (row.origin_turn_id as string) ?? undefined,
    createdAt: (row.created_at as string) ?? undefined,
  }));
}

/** Build partial UPDATE SQL and params for a lexical item. */
function buildLexicalItemUpdate(
  id: string,
  patch: Partial<Omit<VocabularyItem, 'id' | 'createdAt' | 'meanings'>>,
): { sql: string; params: SqlParam[] } {
  const fields: string[] = [];
  const params: SqlParam[] = [];

  const fieldMap: Record<string, string> = {
    learnerId: 'learner_id',
    headword: 'headword',
    type: 'type',
    pronunciation: 'pronunciation',
    synonyms: 'synonyms',
    antonyms: 'antonyms',
    relatedExpressions: 'related_expressions',
    source: 'source',
    tags: 'tags',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      if (['pronunciation', 'synonyms', 'antonyms', 'relatedExpressions', 'source', 'tags'].includes(key)) {
        params.push(JSON.stringify(value));
      } else {
        params.push(value as SqlParam);
      }
    }
  }

  fields.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  const sql = `UPDATE lexical_items SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/**
 * SQLiteVocabularyRepository
 *
 * Implements VocabularyRepository for lexical_items + lexical_meanings.
 * Uses transactions for atomic upsert across both tables.
 */
export class SQLiteVocabularyRepository implements VocabularyRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async upsert(
    item: Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<VocabularyItem> {
    // Check if an item with same learner_id, headword, type exists
    const existing = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
      [item.learnerId, item.headword, item.type],
    );

    const now = nowIso();

    if (existing.length > 0) {
      // Update existing item
      const id = existing[0].id as string;
      const { sql, params } = buildLexicalItemUpdate(id, item);
      await this.adapter.execute(sql, params);

      // Update meanings: delete existing and insert new ones
      await this.adapter.execute(
        `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`,
        [id],
      );

      // Insert new meanings
      for (const meaning of item.meanings) {
        const meaningId = generateId();
        await this.adapter.execute(
          `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meaningId,
            id,
            meaning.definition,
            meaning.partOfSpeech ?? null,
            JSON.stringify(meaning.examples ?? []),
            JSON.stringify(meaning.usageNotes ?? []),
            meaning.register ?? null,
            meaning.domain ?? null,
            meaning.review?.state ?? 'new',
            meaning.review?.lastReviewAt ?? null,
            meaning.review?.nextReviewAt ?? null,
            meaning.review?.reviewCount ?? 0,
            meaning.review?.consecutiveCorrect ?? 0,
            meaning.review?.easeFactor ?? null,
            meaning.review?.masteredAt ?? null,
            now,
            now,
          ],
        );

        // Insert examples for this meaning
        if (meaning.examples && meaning.examples.length > 0) {
          await insertExamplesForMeaning(this.adapter, id, meaningId, meaning.examples, now);
        }
      }

      const rows = await this.adapter.query(
        `SELECT * FROM lexical_items WHERE id = ?`,
        [id],
      );

      if (rows.length === 0) {
        throw new Error('Vocabulary item disappeared after update');
      }

      return this.getFullItem(id);
    }

    // Create new item
    const id = generateId();

    // Validate required fields
    if (!item.learnerId || !isValidUuid(item.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!item.headword) {
      throw new Error('headword is required');
    }
    if (!item.type) {
      throw new Error('type is required');
    }
    if (!item.source) {
      throw new Error('source is required');
    }

    await this.adapter.execute(
      `INSERT INTO lexical_items (
        id, learner_id, headword, type, pronunciation, synonyms,
        antonyms, related_expressions, source, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.learnerId,
        item.headword,
        item.type,
        JSON.stringify(item.pronunciation ?? {}),
        JSON.stringify(item.synonyms ?? []),
        JSON.stringify(item.antonyms ?? []),
        JSON.stringify(item.relatedExpressions ?? []),
        JSON.stringify(item.source),
        JSON.stringify(item.tags ?? []),
        now,
        now,
      ],
    );

    // Insert meanings
    for (const meaning of item.meanings) {
      const meaningId = generateId();
      await this.adapter.execute(
        `INSERT INTO lexical_meanings (
          id, lexical_item_id, definition, part_of_speech, examples,
          usage_notes, register, domain,
          review_state, review_last_review_at, review_next_review_at,
          review_review_count, review_consecutive_correct, review_ease_factor,
          review_mastered_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meaningId,
          id,
          meaning.definition,
          meaning.partOfSpeech ?? null,
          JSON.stringify(meaning.examples ?? []),
          JSON.stringify(meaning.usageNotes ?? []),
          meaning.register ?? null,
          meaning.domain ?? null,
          meaning.review?.state ?? 'new',
          meaning.review?.lastReviewAt ?? null,
          meaning.review?.nextReviewAt ?? null,
          meaning.review?.reviewCount ?? 0,
          meaning.review?.consecutiveCorrect ?? 0,
          meaning.review?.easeFactor ?? null,
          meaning.review?.masteredAt ?? null,
          now,
          now,
        ],
      );

      // Insert examples for this meaning
      if (meaning.examples && meaning.examples.length > 0) {
        await insertExamplesForMeaning(this.adapter, id, meaningId, meaning.examples, now);
      }
    }

    return this.getFullItem(id);
  }

  private async getFullItem(id: string): Promise<VocabularyItem> {
    const itemRows = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE id = ?`,
      [id],
    );

    if (itemRows.length === 0) {
      throw new Error('Vocabulary item not found after upsert');
    }

    const item = rowToVocabularyItem(itemRows[0]);

    const meaningRows = await this.adapter.query(
      `SELECT * FROM lexical_meanings WHERE lexical_item_id = ? ORDER BY created_at`,
      [id],
    );

    const meanings: Meaning[] = [];
    for (const meaningRow of meaningRows) {
      const meaning = rowToMeaning(meaningRow);
      const meaningId = meaningRow.id as string;
      if (meaningId) {
        const examples = await fetchExamplesForMeaning(this.adapter, meaningId);
        meanings.push({ ...meaning, examples });
      } else {
        meanings.push(meaning);
      }
    }

    return {
      ...item,
      meanings,
    };
  }

  async get(id: string): Promise<VocabularyItem | null> {
    if (!isValidUuid(id)) return null;

    const itemRows = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE id = ?`,
      [id],
    );

    if (itemRows.length === 0) return null;

    const item = rowToVocabularyItem(itemRows[0]);

    const meaningRows = await this.adapter.query(
      `SELECT * FROM lexical_meanings WHERE lexical_item_id = ? ORDER BY created_at`,
      [id],
    );

    const meanings: Meaning[] = [];
    for (const meaningRow of meaningRows) {
      const meaning = rowToMeaning(meaningRow);
      const meaningId = meaningRow.id as string;
      if (meaningId) {
        const examples = await fetchExamplesForMeaning(this.adapter, meaningId);
        meanings.push({ ...meaning, examples });
      } else {
        meanings.push(meaning);
      }
    }

    return {
      ...item,
      meanings,
    };
  }

  async list(
    learnerId: string,
    opts?: { state?: string; limit?: number },
  ): Promise<readonly VocabularyItem[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM lexical_items WHERE learner_id = ?`;
    const params: SqlParam[] = [learnerId];

    // Note: state filter would require joining with lexical_meanings
    // For now, we don't implement state filter as it requires item-level review aggregate
    // which we don't fabricate. Per-meaning review is authoritative.

    sql += ` ORDER BY created_at DESC`;

    if (opts?.limit !== undefined && opts.limit > 0) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = await this.adapter.query(sql, params);

    const items: VocabularyItem[] = [];
    for (const row of rows) {
      const item = rowToVocabularyItem(row);
      const itemId = row.id;
      if (!itemId || typeof itemId !== 'string') {
        throw new Error('Invalid vocabulary item row: missing id');
      }
      const meaningRows = await this.adapter.query(
        `SELECT * FROM lexical_meanings WHERE lexical_item_id = ? ORDER BY created_at`,
        [itemId],
      );

      const meanings: Meaning[] = [];
      for (const meaningRow of meaningRows) {
        const meaning = rowToMeaning(meaningRow);
        const meaningId = meaningRow.id as string;
        if (meaningId) {
          const examples = await fetchExamplesForMeaning(this.adapter, meaningId);
          meanings.push({ ...meaning, examples });
        } else {
          meanings.push(meaning);
        }
      }
      items.push({ ...item, meanings });
    }

    return items;
  }

  async listDue(
    learnerId: string,
    now: string,
    limit?: number,
  ): Promise<readonly VocabularyItem[]> {
    if (!isValidUuid(learnerId)) return [];

    // Find lexical items that have at least one meaning with review_next_review_at <= now
    // Use a subquery to get distinct lexical_item_ids with due meanings
    let sql = `
      SELECT DISTINCT li.* FROM lexical_items li
      INNER JOIN lexical_meanings lm ON lm.lexical_item_id = li.id
      WHERE li.learner_id = ?
        AND lm.review_next_review_at IS NOT NULL
        AND lm.review_next_review_at <= ?
      ORDER BY lm.review_next_review_at ASC
    `;
    const params: SqlParam[] = [learnerId, now];

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.adapter.query(sql, params);

    const items: VocabularyItem[] = [];
    for (const row of rows) {
      const item = rowToVocabularyItem(row);
      const itemId = row.id;
      if (!itemId || typeof itemId !== 'string') {
        throw new Error('Invalid vocabulary item row: missing id');
      }
      const meaningRows = await this.adapter.query(
        `SELECT * FROM lexical_meanings WHERE lexical_item_id = ? ORDER BY created_at`,
        [itemId],
      );

      const meanings: Meaning[] = [];
      for (const meaningRow of meaningRows) {
        const meaning = rowToMeaning(meaningRow);
        const meaningId = meaningRow.id as string;
        if (meaningId) {
          const examples = await fetchExamplesForMeaning(this.adapter, meaningId);
          meanings.push({ ...meaning, examples });
        } else {
          meanings.push(meaning);
        }
      }
      items.push({ ...item, meanings });
    }

    return items;
  }

  async update(
    id: string,
    patch: Partial<Omit<VocabularyItem, 'id' | 'createdAt'>>,
  ): Promise<VocabularyItem> {
    if (!isValidUuid(id)) {
      throw new Error('Invalid vocabulary item id');
    }

    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Vocabulary item not found: ${id}`);
    }

    // Update lexical_item fields if provided
    const { meanings, ...itemPatch } = patch;
    if (Object.keys(itemPatch).length > 0) {
      const { sql, params } = buildLexicalItemUpdate(id, itemPatch);
      await this.adapter.execute(sql, params);
    }

    // Update meanings if explicitly provided
    if (meanings !== undefined) {
      await this.adapter.execute(
        `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`,
        [id],
      );

      const now = nowIso();
      for (const meaning of meanings) {
        const meaningId = generateId();
        await this.adapter.execute(
          `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            meaningId,
            id,
            meaning.definition,
            meaning.partOfSpeech ?? null,
            JSON.stringify(meaning.examples ?? []),
            JSON.stringify(meaning.usageNotes ?? []),
            meaning.register ?? null,
            meaning.domain ?? null,
            meaning.review?.state ?? 'new',
            meaning.review?.lastReviewAt ?? null,
            meaning.review?.nextReviewAt ?? null,
            meaning.review?.reviewCount ?? 0,
            meaning.review?.consecutiveCorrect ?? 0,
            meaning.review?.easeFactor ?? null,
            meaning.review?.masteredAt ?? null,
            now,
            now,
          ],
        );

        // Insert examples for this meaning
        if (meaning.examples && meaning.examples.length > 0) {
          await insertExamplesForMeaning(this.adapter, id, meaningId, meaning.examples, now);
        }
      }
    }

    return this.getFullItem(id);
  }
}