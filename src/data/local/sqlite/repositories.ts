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
  ConversationActivityStats,
  PersistConversationInput,
  LexicalBucketCounts,
  WeaknessStatusCounts,
  PronunciationObservationInput,
  PronunciationObservationRecord,
  MistakeRepository,
  PronunciationRepository,
  WeaknessRepository,
  VocabularyRepository,
  ExpressionRepository,
  ReviewRepository,
  ProgressRepository,
} from '../../../repositories';
import type {
  UserProfile,
  GrammarMistake,
  PronunciationWeakness,
  LearnerWeakness,
  LearnerStrength,
} from '../../../domain/models/learner';
import type { EvidenceRef, WeaknessStatus } from '../../../domain/shared/types';
import type {
  ConversationSession,
  ConversationTurn,
} from '../../../domain/models/conversation';
import type {
  VocabularyItem,
  ExpressionItem,
  Meaning,
} from '../../../domain/models/vocabulary';
import type {
  ReviewItem,
  ReviewOutcome,
  ProgressRecord,
} from '../../../domain/models/learning';
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

/** Generate a timestamp strictly greater than the given previous timestamp. */
function generateMonotonicTimestamp(previous: string): string {
  const prev = new Date(previous).getTime();
  const now = Date.now();
  if (now <= prev) {
    return new Date(prev + 1).toISOString();
  }
  return new Date(now).toISOString();
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

function assertValidSessionId(id: string): void {
  if (!isValidUuid(id)) {
    throw new Error('Invalid session id');
  }
}

/** Validates the required fields of a conversation session row. */
function assertValidSessionInput(
  session: Pick<ConversationSession, 'learnerId' | 'mode' | 'status' | 'startedAt'>,
): void {
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
}

/** Validates the required fields of a conversation turn row. */
function assertValidTurnInput(turn: {
  sessionId: string;
  speaker?: ConversationTurn['speaker'];
  text?: string;
  turnIndex?: number;
  startedAt?: string;
}): void {
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
}

/** INSERT SQL for conversation_sessions (single source of truth). */
function sessionInsertSql(): string {
  return `INSERT INTO conversation_sessions (
        id, learner_id, mode, title, topic, topic_source, status,
        started_at, ended_at, duration_seconds, difficulty, turn_count,
        summary, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

/** INSERT params for conversation_sessions (single source of truth). */
function sessionInsertParams(
  id: string,
  session: Omit<ConversationSession, 'id' | 'createdAt' | 'updatedAt'>,
  now: string,
): SqlParam[] {
  return [
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
  ];
}

/** INSERT SQL for conversation_turns (single source of truth). */
function turnInsertSql(): string {
  return `INSERT INTO conversation_turns (
        id, session_id, speaker, text, audio_ref, detected_language,
        sequence_number, started_at, ended_at, duration_ms, confidence,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

/** INSERT params for conversation_turns (id first, single source of truth). */
function turnInsertParams(
  sessionId: string,
  turn: {
    speaker: ConversationTurn['speaker'];
    text: string;
    turnIndex: number;
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    confidence?: number;
    audioRef?: string;
    detectedLanguage?: string;
    metadata?: Record<string, unknown>;
  },
  now: string,
): SqlParam[] {
  return [
    generateId(),
    sessionId,
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
  ];
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
    session: Omit<ConversationSession, 'id' | 'createdAt' | 'updatedAt'> & {
      readonly id?: string;
    },
  ): Promise<ConversationSession> {
    // An explicit id lets callers persist with a deterministic domain identity
    // (retry-safe conversation memory); otherwise a fresh id is generated.
    const id = session.id ?? generateId();
    const now = nowIso();
    assertValidSessionId(id);
    assertValidSessionInput(session);

    await this.adapter.execute(
      sessionInsertSql(),
      sessionInsertParams(id, session, now),
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

  /**
   * Persist a COMPLETE conversation atomically (session + every turn) using the
   * adapter transaction contract: if any step fails the whole write rolls back,
   * so a partial conversation record can never be left behind. Combined with a
   * caller-provided deterministic id this makes persistence retry-safe.
   */
  async persistConversation(input: PersistConversationInput): Promise<ConversationSession> {
    const session = input.session;
    const id = session.id ?? generateId();
    const now = nowIso();
    assertValidSessionId(id);
    assertValidSessionInput(session);

    const steps: { sql: string; params: SqlParam[] }[] = [];
    steps.push({ sql: sessionInsertSql(), params: sessionInsertParams(id, session, now) });

    for (const turn of input.turns) {
      assertValidTurnInput({ ...turn, sessionId: id });
      steps.push({ sql: turnInsertSql(), params: turnInsertParams(id, turn, now) });
    }

    // The completed status/endedAt/turnCount are written in the SAME transaction.
    const completion = buildSessionUpdate(id, {
      status: session.status,
      turnCount: session.turnCount ?? input.turns.length,
      ...(session.endedAt !== undefined && { endedAt: session.endedAt }),
      ...(session.durationSeconds !== undefined && {
        durationSeconds: session.durationSeconds,
      }),
    });
    steps.push({ sql: completion.sql, params: completion.params });

    await this.adapter.transaction(steps);

    const stored = await this.getSession(id);
    if (!stored) {
      throw new Error('Failed to persist conversation session');
    }
    return stored;
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
      turnInsertSql(),
      [
        id,
        ...turnInsertParams(turn.sessionId, turn, now).slice(1),
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

  /**
   * Exact aggregate counts over persisted sessions (optionally bounded to a
   * started-at range). Single GROUP-free aggregate query — never loads rows.
   */
  async getActivityStats(
    learnerId: string,
    opts?: { startedAfter?: string; startedUntil?: string },
  ): Promise<ConversationActivityStats> {
    if (!isValidUuid(learnerId)) {
      return { sessionsTotal: 0, sessionsCompleted: 0, turnsTotal: 0 };
    }

    let sql = `SELECT
        COUNT(*) AS sessions_total,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'summarized') THEN 1 ELSE 0 END), 0) AS sessions_completed,
        COALESCE(SUM(turn_count), 0) AS turns_total
      FROM conversation_sessions WHERE learner_id = ?`;
    const params: SqlParam[] = [learnerId];
    if (opts?.startedAfter !== undefined) {
      sql += ` AND started_at >= ?`;
      params.push(opts.startedAfter);
    }
    if (opts?.startedUntil !== undefined) {
      sql += ` AND started_at < ?`;
      params.push(opts.startedUntil);
    }

    const rows = await this.adapter.query(sql, params);
    const row = rows[0] ?? {};
    return {
      sessionsTotal: Number(row.sessions_total ?? 0),
      sessionsCompleted: Number(row.sessions_completed ?? 0),
      turnsTotal: Number(row.turns_total ?? 0),
    };
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
    evidenceLog: safeJsonParse(row.evidence_log, []),
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

  async updateMistake(
    id: string,
    patch: Partial<Omit<GrammarMistake, 'id' | 'createdAt'>>,
  ): Promise<GrammarMistake> {
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

    const { sql, params } = buildGrammarMistakeUpdate(id, patch);
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
        origin_session_id, origin_turn_id, resolved, notes, evidence_log,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(weakness.evidenceLog ?? []),
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

    const previousUpdatedAt = existing[0].updated_at as string;
    const newUpdatedAt = generateMonotonicTimestamp(previousUpdatedAt);

    await this.adapter.execute(
      `UPDATE pronunciation_weaknesses SET resolved = ?, updated_at = ? WHERE id = ?`,
      [resolved ? 1 : 0, newUpdatedAt, id],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM pronunciation_weaknesses WHERE id = ?`,
      [id],
    );

    if (rows.length === 0) {
      throw new Error('Pronunciation weakness disappeared after update');
    }

    return rowToPronunciationWeakness(rows[0]);
  }

  /**
   * Record one pronunciation observation under a stable identity.
   * First observation creates the row; repeated observations increment
   * occurrence data (dedup by learner + target_sound identity).
   */
  async recordObservation(
    input: PronunciationObservationInput,
  ): Promise<PronunciationObservationRecord> {
    if (!input.learnerId || !isValidUuid(input.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!input.identity) {
      throw new Error('identity is required');
    }

    const existingRows = await this.adapter.query(
      `SELECT id FROM pronunciation_weaknesses WHERE learner_id = ? AND target_sound = ?`,
      [input.learnerId, input.identity],
    );

    if (!input.evidenceSource) {
      throw new Error('evidenceSource is required');
    }

    // Evidence entry for THIS occurrence (what/when/source — no scores).
    const evidenceEntry = {
      at: input.at,
      source: input.evidenceSource,
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.exampleText ? { observed: input.exampleText } : {}),
    };

    if (existingRows.length > 0) {
      const id = existingRows[0].id as string;
      const current = rowToPronunciationWeakness(
        (await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]))[0],
      );

      // Keep the most recent examples/contexts, bounded.
      const wordExamples = [
        ...(input.exampleText ? [input.exampleText] : []),
        ...current.wordExamples,
     ].slice(0, 10);
      const contexts = Array.from(
        new Set([...(input.context ? [input.context] : []), ...current.contexts]),
      ).slice(0, 10);
      // Append (never reset) the evidence log, bounded to the most recent 20.
      const evidenceLog = [...(current.evidenceLog ?? []), evidenceEntry].slice(-20);

      await this.adapter.execute(
        `UPDATE pronunciation_weaknesses SET
          occurrence_count = occurrence_count + 1,
          last_seen_at = ?,
          word_examples = ?,
          contexts = ?,
          evidence_log = ?,
          updated_at = ?
        WHERE id = ?`,
        [
          input.at,
          JSON.stringify(wordExamples),
          JSON.stringify(contexts),
          JSON.stringify(evidenceLog),
          input.at,
          id,
        ],
      );

      const updatedRows = await this.adapter.query(
        `SELECT * FROM pronunciation_weaknesses WHERE id = ?`,
        [id],
      );
      return { weakness: rowToPronunciationWeakness(updatedRows[0]), created: false };
    }

    const created = await this.recordWeakness({
      learnerId: input.learnerId,
      targetSound: input.identity,
      wordExamples: input.exampleText ? [input.exampleText] : [],
      occurrenceCount: 1,
      lastSeenAt: input.at,
      firstSeenAt: input.at,
      contexts: input.context ? [input.context] : [],
      exampleTurnIds: [],
      resolved: false,
      notes: input.target,
      evidenceLog: [evidenceEntry],
    });
    return { weakness: created, created: true };
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

  /**
   * Exact lookup by (learnerId, type, referenceId). A single-row SELECT —
   * immune to any list cap, so lifecycle identity can never be lost just
   * because a learner has many weaknesses.
   */
  async getWeaknessByReference(
    learnerId: string,
    type: LearnerWeakness['type'],
    referenceId: string,
  ): Promise<LearnerWeakness | null> {
    if (!isValidUuid(learnerId) || !type || !referenceId) return null;
    const rows = await this.adapter.query(
      `SELECT * FROM learner_weaknesses
       WHERE learner_id = ? AND type = ? AND reference_id = ?
       ORDER BY created_at ASC
       LIMIT 1`,
      [learnerId, type, referenceId],
    );
    return rows.length > 0 ? rowToLearnerWeakness(rows[0]) : null;
  }

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

  /** Exact unresolved-weakness counts grouped by persisted lifecycle state. */
  async getUnresolvedStatusCounts(learnerId: string): Promise<WeaknessStatusCounts> {
    if (!isValidUuid(learnerId)) {
      return { unresolved: 0, byStatus: {} };
    }

    const rows = await this.adapter.query(
      `SELECT status, COUNT(*) AS c FROM learner_weaknesses
       WHERE learner_id = ? AND resolved = 0 GROUP BY status`,
      [learnerId],
    );

    const byStatus: Partial<Record<WeaknessStatus, number>> = {};
    let unresolved = 0;
    for (const row of rows) {
      const status = row.status as WeaknessStatus;
      const count = Number(row.c ?? 0);
      byStatus[status] = count;
      unresolved += count;
    }
    return { unresolved, byStatus };
  }

  /** Exact count of unresolved weaknesses first seen in an optional range. */
  async countUnresolved(
    learnerId: string,
    opts?: { firstSeenAfter?: string; firstSeenUntil?: string },
  ): Promise<number> {
    if (!isValidUuid(learnerId)) return 0;

    let sql = `SELECT COUNT(*) AS c FROM learner_weaknesses WHERE learner_id = ? AND resolved = 0`;
    const params: SqlParam[] = [learnerId];
    if (opts?.firstSeenAfter !== undefined) {
      sql += ` AND first_seen_at >= ?`;
      params.push(opts.firstSeenAfter);
    }
    if (opts?.firstSeenUntil !== undefined) {
      sql += ` AND first_seen_at < ?`;
      params.push(opts.firstSeenUntil);
    }
    const rows = await this.adapter.query(sql, params);
    return Number(rows[0]?.c ?? 0);
  }

  /** Exact count of persisted weakness-evidence rows in an optional range. */
  async countEvidence(
    learnerId: string,
    opts?: { atAfter?: string; atUntil?: string },
  ): Promise<number> {
    if (!isValidUuid(learnerId)) return 0;

    let sql = `SELECT COUNT(*) AS c
      FROM weakness_evidence e
      INNER JOIN learner_weaknesses w ON e.weakness_id = w.id
      WHERE w.learner_id = ?`;
    const params: SqlParam[] = [learnerId];
    if (opts?.atAfter !== undefined) {
      sql += ` AND e.at >= ?`;
      params.push(opts.atAfter);
    }
    if (opts?.atUntil !== undefined) {
      sql += ` AND e.at < ?`;
      params.push(opts.atUntil);
    }
    const rows = await this.adapter.query(sql, params);
    return Number(rows[0]?.c ?? 0);
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

/**
 * Delete a lexical item (vocabulary word or expression) and all dependent
 * rows. Children are deleted explicitly so correctness does not depend on
 * PRAGMA foreign_keys being enabled. Existence is checked up front so the
 * boolean result is reliable across backends regardless of how each
 * adapter reports rowsAffected for DELETE. Returns true when the item
 * row existed.
 */
async function deleteLexicalItemCompletely(
  adapter: DatabaseAdapter,
  id: string,
): Promise<boolean> {
  if (!isValidUuid(id)) return false;

  const existing = await adapter.query(
    `SELECT id FROM lexical_items WHERE id = ?`,
    [id],
  );
  if (existing.length === 0) return false;

  await adapter.execute(
    `DELETE FROM lexical_examples WHERE lexical_item_id = ?`,
    [id],
  );
  await adapter.execute(
    `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`,
    [id],
  );
  await adapter.execute(
    `DELETE FROM lexical_items WHERE id = ?`,
    [id],
  );
  return true;
}

/**
 * Replace all meanings of a lexical item with the provided list.
 * Per-meaning review data is whatever the caller supplies; callers that
 * loaded the item first naturally preserve review history.
 */
async function replaceLexicalMeanings(
  adapter: DatabaseAdapter,
  lexicalItemId: string,
  meanings: readonly Meaning[],
  now: string,
): Promise<void> {
  await adapter.execute(
    `DELETE FROM lexical_examples WHERE lexical_item_id = ?`,
    [lexicalItemId],
  );
  await adapter.execute(
    `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`,
    [lexicalItemId],
  );

  for (const meaning of meanings) {
    const meaningId = generateId();
    await adapter.execute(
      `INSERT INTO lexical_meanings (
        id, lexical_item_id, definition, part_of_speech, examples,
        usage_notes, register, domain,
        review_state, review_last_review_at, review_next_review_at,
        review_review_count, review_consecutive_correct, review_ease_factor,
        review_mastered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        meaningId,
        lexicalItemId,
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

    if (meaning.examples && meaning.examples.length > 0) {
      await insertExamplesForMeaning(adapter, lexicalItemId, meaningId, meaning.examples, now);
    }
  }
}

/**
 * Atomically delete a lexical item together with every review row that
 * points at it (same referenceId + same kind only), including the dependent
 * review_history rows. All deletes run in ONE adapter transaction: if any
 * step fails, the adapter rolls everything back and the lexical item, its
 * review items, and their history all remain exactly as before.
 *
 * Unrelated reviews (other referenceIds or other kinds — grammar,
 * weakness, pronunciation, other lexical items) are never touched.
 *
 * Returns true when the lexical item existed and was deleted; returns
 * false (without touching anything) when it did not exist.
 */
async function deleteLexicalItemWithReviews(
  adapter: DatabaseAdapter,
  lexicalItemId: string,
  kind: 'vocabulary' | 'expression',
): Promise<boolean> {
  if (!isValidUuid(lexicalItemId)) return false;

  const existing = await adapter.query(
    `SELECT id FROM lexical_items WHERE id = ?`,
    [lexicalItemId],
  );
  if (existing.length === 0) return false;

  await adapter.transaction([
    // Review history of the matching review rows first.
    {
      sql: `DELETE FROM review_history WHERE review_item_id IN (
        SELECT id FROM review_items WHERE reference_id = ? AND kind = ?
      )`,
      params: [lexicalItemId, kind],
    },
    // The review rows themselves — same referenceId AND same kind only.
    {
      sql: `DELETE FROM review_items WHERE reference_id = ? AND kind = ?`,
      params: [lexicalItemId, kind],
    },
    // Then the lexical item and its children.
    {
      sql: `DELETE FROM lexical_examples WHERE lexical_item_id = ?`,
      params: [lexicalItemId],
    },
    {
      sql: `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`,
      params: [lexicalItemId],
    },
    {
      sql: `DELETE FROM lexical_items WHERE id = ?`,
      params: [lexicalItemId],
    },
  ]);

  return true;
}

/**
 * Exact review-bucket counts for lexical rows of the given types (or all
 * types when null), computed fully in SQL from the authoritative
 * per-meaning review columns. Bucket semantics match the shared
 * deriveReviewBucket helper in vocabulary-workspace:
 *   due      — any meaning with nextReviewAt <= now
 *   mastered — not due, >=1 reviewed meaning, all reviewed mastered/retired
 *   familiar — not due, >=1 reviewed meaning, all reviewed familiar or better
 *   learning — everything else (includes never-reviewed items)
 */
async function lexicalBucketCounts(
  adapter: DatabaseAdapter,
  learnerId: string,
  types: readonly string[] | null,
  now: string,
): Promise<LexicalBucketCounts> {
  if (!isValidUuid(learnerId)) {
    return { total: 0, due: 0, learning: 0, familiar: 0, mastered: 0 };
  }

  const typeFilter = types && types.length > 0
    ? ` AND li.type IN (${types.map(() => '?').join(', ')})`
    : '';
  const params: SqlParam[] = [now, learnerId, ...(types && types.length > 0 ? types : [])];

  const rows = await adapter.query(
    `SELECT
      COUNT(*) AS total,
      COALESCE(SUM(q.has_due), 0) AS due,
      COALESCE(SUM(CASE WHEN q.has_due = 0 AND q.reviewed_count = 0 THEN 1 ELSE 0 END), 0) AS learning_new,
      COALESCE(SUM(CASE WHEN q.has_due = 0 AND q.reviewed_count > 0 AND q.mastered_count >= q.reviewed_count THEN 1 ELSE 0 END), 0) AS mastered,
      COALESCE(SUM(CASE WHEN q.has_due = 0 AND q.reviewed_count > 0 AND q.mastered_count < q.reviewed_count AND q.familiar_or_better >= q.reviewed_count THEN 1 ELSE 0 END), 0) AS familiar,
      COALESCE(SUM(CASE WHEN q.has_due = 0 AND (q.reviewed_count = 0 OR q.familiar_or_better < q.reviewed_count) THEN 1 ELSE 0 END), 0) AS learning_rest
    FROM (
      SELECT li.id AS id,
        MAX(CASE WHEN lm.review_next_review_at IS NOT NULL AND lm.review_next_review_at <= ? THEN 1 ELSE 0 END) AS has_due,
        COUNT(lm.review_state) AS reviewed_count,
        COALESCE(SUM(CASE WHEN lm.review_state IN ('mastered', 'retired') THEN 1 ELSE 0 END), 0) AS mastered_count,
        COALESCE(SUM(CASE WHEN lm.review_state IN ('familiar', 'mastered', 'retired') THEN 1 ELSE 0 END), 0) AS familiar_or_better
      FROM lexical_items li
      LEFT JOIN lexical_meanings lm ON lm.lexical_item_id = li.id
      WHERE li.learner_id = ?${typeFilter}
      GROUP BY li.id
    ) q`,
    params,
  );

  const row = rows[0] ?? {};
  const learning = Number(row.learning_new ?? 0) + Number(row.learning_rest ?? 0);
  return {
    total: Number(row.total ?? 0),
    due: Number(row.due ?? 0),
    learning,
    familiar: Number(row.familiar ?? 0),
    mastered: Number(row.mastered ?? 0),
  };
}

/** Exact count of lexical rows created in an optional range (optionally by type). */
async function countLexicalCreated(
  adapter: DatabaseAdapter,
  learnerId: string,
  types: readonly string[] | null,
  opts?: { createdAfter?: string; createdUntil?: string },
): Promise<number> {
  if (!isValidUuid(learnerId)) return 0;

  let sql = `SELECT COUNT(*) AS c FROM lexical_items WHERE learner_id = ?`;
  const params: SqlParam[] = [learnerId];
  if (opts?.createdAfter !== undefined) {
    sql += ` AND created_at >= ?`;
    params.push(opts.createdAfter);
  }
  if (opts?.createdUntil !== undefined) {
    sql += ` AND created_at < ?`;
    params.push(opts.createdUntil);
  }
  if (types && types.length > 0) {
    sql += ` AND type IN (${types.map(() => '?').join(', ')})`;
    params.push(...types);
  }

  const rows = await adapter.query(sql, params);
  return Number(rows[0]?.c ?? 0);
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
    opts?: { state?: string; limit?: number; types?: readonly VocabularyItem['type'][] },
  ): Promise<readonly VocabularyItem[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM lexical_items WHERE learner_id = ?`;
    const params: SqlParam[] = [learnerId];

    // Optional type filter (e.g. vocabulary dashboard reads only word/phrase
    // rows; expression rows live in the same table under different types).
    if (opts?.types !== undefined && opts.types.length > 0) {
      const placeholders = opts.types.map(() => '?').join(', ');
      sql += ` AND type IN (${placeholders})`;
      params.push(...opts.types);
    }

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

  /**
   * Delete a vocabulary item and all of its meanings/examples.
   * Returns true when the item existed and was removed.
   */
  async delete(id: string): Promise<boolean> {
    return deleteLexicalItemCompletely(this.adapter, id);
  }

  /**
   * Exact review-bucket counts over word/phrase rows, computed in SQL.
   * Defaults to the vocabulary-type rows when no type filter is given.
   */
  async getBucketCounts(
    learnerId: string,
    opts: { now: string; types?: readonly VocabularyItem['type'][] },
  ): Promise<LexicalBucketCounts> {
    const types = opts.types && opts.types.length > 0 ? opts.types : ['word', 'phrase'];
    return lexicalBucketCounts(this.adapter, learnerId, types, opts.now);
  }

  /** Exact count of vocabulary rows created in an optional range. */
  async countCreated(
    learnerId: string,
    opts?: { createdAfter?: string; createdUntil?: string; types?: readonly VocabularyItem['type'][] },
  ): Promise<number> {
    const types = opts?.types && opts.types.length > 0 ? opts.types : ['word', 'phrase'];
    return countLexicalCreated(this.adapter, learnerId, types, opts);
  }
}

/** Map lexical_items row to ExpressionItem domain object. */
function rowToExpressionItem(row: SqlRow): Omit<ExpressionItem, 'meanings'> {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    expression: row.headword as string,
    type: row.type as ExpressionItem['type'],
    pronunciation: safeJsonParse(row.pronunciation, {}),
    naturalAlternatives: safeJsonParse(row.natural_alternatives, []),
    register: (row.register as ExpressionItem['register']) ?? undefined,
    domain: (row.domain as string) ?? undefined,
    source: safeJsonParse(row.source, {
      addedBy: 'system',
      addedAt: row.created_at as string,
    }),
    tags: safeJsonParse(row.tags, []),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * SQLiteExpressionRepository
 *
 * Implements ExpressionRepository for expressions stored in lexical_items + lexical_meanings.
 */
export class SQLiteExpressionRepository implements ExpressionRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  private async getFullItem(id: string): Promise<ExpressionItem> {
    const rows = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) {
      throw new Error(`Expression item not found: ${id}`);
    }

    const base = rowToExpressionItem(rows[0]);
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

    return { ...base, meanings };
  }

  async upsert(
    item: Omit<ExpressionItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ExpressionItem> {
    if (!item.learnerId || !isValidUuid(item.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!item.expression) {
      throw new Error('expression is required');
    }
    if (!item.type) {
      throw new Error('type is required');
    }

    const existing = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
      [item.learnerId, item.expression, item.type],
    );

    const now = nowIso();

    if (existing.length > 0) {
      const id = existing[0].id as string;
      await this.adapter.execute(
        `UPDATE lexical_items SET
          natural_alternatives = ?,
          register = ?,
          domain = ?,
          source = ?,
          tags = ?,
          updated_at = ?
        WHERE id = ?`,
        [
          JSON.stringify(item.naturalAlternatives ?? []),
          item.register ?? null,
          item.domain ?? null,
          JSON.stringify(item.source ?? {}),
          JSON.stringify(item.tags ?? []),
          now,
          id,
        ],
      );

      // Replace meanings
      await this.adapter.execute(
        `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`,
        [id],
      );

      for (const meaning of item.meanings ?? []) {
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
        // Persist examples in the lexical_examples table as well, so the
        // read path (fetchExamplesForMeaning) returns them.
        await insertExamplesForMeaning(this.adapter, id, meaningId, meaning.examples ?? [], now);
      }

      return this.getFullItem(id);
    }

    const id = generateId();
    await this.adapter.execute(
      `INSERT INTO lexical_items (
        id, learner_id, headword, type, pronunciation,
        synonyms, antonyms, related_expressions, natural_alternatives,
        register, domain, source, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.learnerId,
        item.expression,
        item.type,
        JSON.stringify(item.pronunciation ?? {}),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify(item.naturalAlternatives ?? []),
        item.register ?? null,
        item.domain ?? null,
        JSON.stringify(item.source ?? {}),
        JSON.stringify(item.tags ?? []),
        now,
        now,
      ],
    );

    for (const meaning of item.meanings ?? []) {
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
      // Persist examples in the lexical_examples table as well, so the
      // read path (fetchExamplesForMeaning) returns them.
      await insertExamplesForMeaning(this.adapter, id, meaningId, meaning.examples ?? [], now);
    }

    return this.getFullItem(id);
  }

  async get(id: string): Promise<ExpressionItem | null> {
    if (!isValidUuid(id)) return null;
    try {
      return await this.getFullItem(id);
    } catch {
      return null;
    }
  }

  async list(
    learnerId: string,
    opts?: { limit?: number },
  ): Promise<readonly ExpressionItem[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `
      SELECT * FROM lexical_items
      WHERE learner_id = ?
        AND type IN ('idiom', 'collocation', 'common_expression', 'professional_expression', 'linking_expression', 'phrasal_verb')
      ORDER BY created_at DESC
    `;
    const params: SqlParam[] = [learnerId];

    if (opts?.limit !== undefined && opts.limit > 0) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = await this.adapter.query(sql, params);
    const items: ExpressionItem[] = [];
    for (const row of rows) {
      const item = await this.getFullItem(row.id as string);
      items.push(item);
    }
    return items;
  }

  async listDue(
    learnerId: string,
    now: string,
    limit?: number,
  ): Promise<readonly ExpressionItem[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `
      SELECT DISTINCT li.* FROM lexical_items li
      INNER JOIN lexical_meanings lm ON lm.lexical_item_id = li.id
      WHERE li.learner_id = ?
        AND li.type IN ('idiom', 'collocation', 'common_expression', 'professional_expression', 'linking_expression', 'phrasal_verb')
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
    const items: ExpressionItem[] = [];
    for (const row of rows) {
      const item = await this.getFullItem(row.id as string);
      items.push(item);
    }
    return items;
  }

  async update(
    id: string,
    patch: Partial<Omit<ExpressionItem, 'id' | 'createdAt'>>,
  ): Promise<ExpressionItem> {
    if (!isValidUuid(id)) throw new Error('Invalid expression item id');
    const existing = await this.get(id);
    if (!existing) throw new Error(`Expression item not found: ${id}`);

    const now = nowIso();
    await this.adapter.execute(
      `UPDATE lexical_items SET
        headword = COALESCE(?, headword),
        natural_alternatives = COALESCE(?, natural_alternatives),
        register = COALESCE(?, register),
        domain = COALESCE(?, domain),
        updated_at = ?
      WHERE id = ?`,
      [
        patch.expression ?? null,
        patch.naturalAlternatives ? JSON.stringify(patch.naturalAlternatives) : null,
        patch.register ?? null,
        patch.domain ?? null,
        now,
        id,
      ],
    );

    // Replace meanings when explicitly provided. Callers that loaded the
    // item first supply the existing per-meaning review data unchanged,
    // so review history is preserved.
    if (patch.meanings !== undefined) {
      await replaceLexicalMeanings(this.adapter, id, patch.meanings, now);
    }

    return this.getFullItem(id);
  }

  /**
   * Delete an expression item and all of its meanings/examples.
   * Returns true when the item existed and was removed.
   */
  async delete(id: string): Promise<boolean> {
    return deleteLexicalItemCompletely(this.adapter, id);
  }

  /** Exact review-bucket counts over expression-type rows, computed in SQL. */
  async getBucketCounts(
    learnerId: string,
    opts: { now: string },
  ): Promise<LexicalBucketCounts> {
    const types: readonly string[] = [
      'idiom',
      'collocation',
      'common_expression',
      'professional_expression',
      'linking_expression',
      'phrasal_verb',
    ];
    return lexicalBucketCounts(this.adapter, learnerId, types, opts.now);
  }

  /** Exact count of expression rows created in an optional range. */
  async countCreated(
    learnerId: string,
    opts?: { createdAfter?: string; createdUntil?: string },
  ): Promise<number> {
    const types: readonly string[] = [
      'idiom',
      'collocation',
      'common_expression',
      'professional_expression',
      'linking_expression',
      'phrasal_verb',
    ];
    return countLexicalCreated(this.adapter, learnerId, types, opts);
  }
}

/** Map review_items row to ReviewItem domain object. */
function rowToReviewItem(row: SqlRow): ReviewItem {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    kind: row.kind as ReviewItem['kind'],
    referenceId: row.reference_id as string,
    prompt: row.prompt as string,
    expectedResponse: (row.expected_response as string) ?? undefined,
    contextTopic: (row.context_topic as string) ?? undefined,
    state: row.state as MasteryState,
    dueAt: row.due_at as string,
    createdAt: row.created_at as string,
    lastReviewAt: (row.last_review_at as string) ?? undefined,
    reviewCount: Number(row.review_count ?? 0),
    consecutiveCorrect: Number(row.consecutive_correct ?? 0),
    easeFactor: row.ease_factor != null ? Number(row.ease_factor) : undefined,
    outcomeHistory: safeJsonParse<ReviewOutcome[]>(row.outcome_history, []),
  };
}

/**
 * SQLiteReviewRepository
 *
 * Implements ReviewRepository for review_items + review_history.
 */
export class SQLiteReviewRepository implements ReviewRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async listDue(
    learnerId: string,
    now: string,
    limit?: number,
  ): Promise<readonly ReviewItem[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `
      SELECT * FROM review_items
      WHERE learner_id = ?
        AND due_at <= ?
        AND state != 'retired'
      ORDER BY due_at ASC
    `;
    const params: SqlParam[] = [learnerId, now];

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToReviewItem);
  }

  async get(id: string): Promise<ReviewItem | null> {
    if (!isValidUuid(id)) return null;
    const rows = await this.adapter.query(
      `SELECT * FROM review_items WHERE id = ?`,
      [id],
    );
    return rows.length > 0 ? rowToReviewItem(rows[0]) : null;
  }

  /**
   * Exact existence lookup by (learnerId, kind, referenceId). Unlike
   * listDue, this also finds items scheduled for the FUTURE, so callers
   * can avoid resetting already-practiced reviews. Retired items DO count
   * as existing: this matches upsert's own (learnerId, kind, referenceId)
   * lookup, so a caller that treats "not found" as "create initial item"
   * can never overwrite a retired row's review history. Reactivating a
   * retired item must be an explicit, history-preserving operation.
   */
  async getByReference(
    learnerId: string,
    kind: ReviewItem['kind'],
    referenceId: string,
  ): Promise<ReviewItem | null> {
    if (!isValidUuid(learnerId) || !kind || !referenceId) return null;
    const rows = await this.adapter.query(
      `SELECT * FROM review_items
       WHERE learner_id = ? AND kind = ? AND reference_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [learnerId, kind, referenceId],
    );
    return rows.length > 0 ? rowToReviewItem(rows[0]) : null;
  }

  async list(
    learnerId: string,
    limit?: number,
  ): Promise<readonly ReviewItem[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM review_items WHERE learner_id = ? ORDER BY due_at ASC`;
    const params: SqlParam[] = [learnerId];

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToReviewItem);
  }

  async upsert(
    item: Omit<ReviewItem, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ReviewItem> {
    if (!item.learnerId || !isValidUuid(item.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!item.prompt) {
      throw new Error('prompt is required');
    }

    const now = nowIso();

    // Check if exists by explicit id, or by learnerId + referenceId + kind.
    // An explicit id that is not persisted yet must fall through to INSERT,
    // not take the UPDATE branch (planner candidates carry fresh ids).
    let existingId: string | null = null;
    if (item.id) {
      const byId = await this.adapter.query(
        `SELECT id FROM review_items WHERE id = ?`,
        [item.id],
      );
      if (byId.length > 0) {
        existingId = byId[0].id as string;
      }
    }
    if (!existingId && item.referenceId) {
      const existing = await this.adapter.query(
        `SELECT id FROM review_items WHERE learner_id = ? AND reference_id = ? AND kind = ?`,
        [item.learnerId, item.referenceId, item.kind],
      );
      if (existing.length > 0) {
        existingId = existing[0].id as string;
      }
    }

    if (existingId) {
      await this.adapter.execute(
        `UPDATE review_items SET
          prompt = ?,
          expected_response = ?,
          context_topic = ?,
          state = ?,
          due_at = ?,
          last_review_at = ?,
          review_count = ?,
          consecutive_correct = ?,
          ease_factor = ?,
          outcome_history = ?
        WHERE id = ?`,
        [
          item.prompt,
          item.expectedResponse ?? null,
          item.contextTopic ?? null,
          item.state,
          item.dueAt,
          item.lastReviewAt ?? null,
          item.reviewCount,
          item.consecutiveCorrect,
          item.easeFactor ?? null,
          JSON.stringify(item.outcomeHistory ?? []),
          existingId,
        ],
      );

      const updated = await this.get(existingId);
      if (!updated) throw new Error('Failed to retrieve updated review item');
      return updated;
    }

    const id = item.id || generateId();
    await this.adapter.execute(
      `INSERT INTO review_items (
        id, learner_id, kind, reference_id, prompt,
        expected_response, context_topic, state, due_at,
        created_at, last_review_at, review_count, consecutive_correct,
        ease_factor, outcome_history
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        item.learnerId,
        item.kind,
        item.referenceId,
        item.prompt,
        item.expectedResponse ?? null,
        item.contextTopic ?? null,
        item.state,
        item.dueAt,
        now,
        item.lastReviewAt ?? null,
        item.reviewCount ?? 0,
        item.consecutiveCorrect ?? 0,
        item.easeFactor ?? null,
        JSON.stringify(item.outcomeHistory ?? []),
      ],
    );

    const created = await this.get(id);
    if (!created) throw new Error('Failed to retrieve created review item');
    return created;
  }

  async markReviewed(
    id: string,
    result: 'correct' | 'incorrect' | 'partial',
    note?: string,
  ): Promise<ReviewItem> {
    if (!isValidUuid(id)) throw new Error('Invalid review item id');

    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Review item not found: ${id}`);
    }

    const now = nowIso();
    const newOutcome: ReviewOutcome = {
      at: now,
      result,
      note,
    };

    let newConsecutiveCorrect = existing.consecutiveCorrect;
    if (result === 'correct') {
      newConsecutiveCorrect += 1;
    } else if (result === 'incorrect') {
      newConsecutiveCorrect = 0;
    }

    // Determine state
    let newState: MasteryState = existing.state;
    if (newConsecutiveCorrect >= 3) {
      newState = 'mastered';
    } else if (result === 'incorrect') {
      newState = existing.reviewCount >= 1 ? 'struggling' : 'learning';
    } else if (result === 'correct') {
      newState = newConsecutiveCorrect >= 2 ? 'familiar' : 'learning';
    }

    // Determine next interval (days)
    let intervalDays = 1;
    if (result === 'correct') {
      if (newConsecutiveCorrect === 1) intervalDays = 1;
      else if (newConsecutiveCorrect === 2) intervalDays = 3;
      else if (newConsecutiveCorrect === 3) intervalDays = 7;
      else if (newConsecutiveCorrect === 4) intervalDays = 14;
      else intervalDays = 30;
    } else if (result === 'partial') {
      intervalDays = 1;
    } else {
      intervalDays = 1;
    }

    const nextDueDate = new Date(Date.now() + intervalDays * 86400000).toISOString();
    const updatedHistory = [...existing.outcomeHistory, newOutcome];

    await this.adapter.execute(
      `UPDATE review_items SET
        last_review_at = ?,
        review_count = review_count + 1,
        consecutive_correct = ?,
        state = ?,
        due_at = ?,
        outcome_history = ?
      WHERE id = ?`,
      [
        now,
        newConsecutiveCorrect,
        newState,
        nextDueDate,
        JSON.stringify(updatedHistory),
        id,
      ],
    );

    // Also record in review_history table
    const historyId = generateId();
    await this.adapter.execute(
      `INSERT INTO review_history (id, review_item_id, at, result, note)
       VALUES (?, ?, ?, ?, ?)`,
      [historyId, id, now, result, note ?? null],
    );

    const updated = await this.get(id);
    if (!updated) throw new Error('Review item disappeared after update');
    return updated;
  }

  /**
   * Delete review rows pointing at a domain object, restricted to one kind,
   * together with their review_history rows. Kind-restricted by design so
   * unrelated grammar/weakness/expression reviews are never touched.
   * Returns the number of review_items rows removed.
   */
  async deleteByReference(referenceId: string, kind: ReviewItem['kind']): Promise<number> {
    if (!isValidUuid(referenceId)) return 0;

    await this.adapter.execute(
      `DELETE FROM review_history WHERE review_item_id IN (
        SELECT id FROM review_items WHERE reference_id = ? AND kind = ?
      )`,
      [referenceId, kind],
    );

    const result = await this.adapter.execute(
      `DELETE FROM review_items WHERE reference_id = ? AND kind = ?`,
      [referenceId, kind],
    );
    return result.rowsAffected;
  }

  /** Exact count of reviews due at `now` — single aggregate query. */
  async countDue(learnerId: string, now: string): Promise<number> {
    if (!isValidUuid(learnerId)) return 0;

    const rows = await this.adapter.query(
      `SELECT COUNT(*) AS c FROM review_items WHERE learner_id = ? AND due_at <= ?`,
      [learnerId, now],
    );
    return Number(rows[0]?.c ?? 0);
  }

  /** Exact count of reviews completed in an optional last-review range. */
  async countReviewed(
    learnerId: string,
    opts?: { lastReviewAfter?: string; lastReviewUntil?: string },
  ): Promise<number> {
    if (!isValidUuid(learnerId)) return 0;

    let sql = `SELECT COUNT(*) AS c FROM review_items
       WHERE learner_id = ? AND last_review_at IS NOT NULL`;
    const params: SqlParam[] = [learnerId];
    if (opts?.lastReviewAfter !== undefined) {
      sql += ` AND last_review_at >= ?`;
      params.push(opts.lastReviewAfter);
    }
    if (opts?.lastReviewUntil !== undefined) {
      sql += ` AND last_review_at < ?`;
      params.push(opts.lastReviewUntil);
    }
    const rows = await this.adapter.query(sql, params);
    return Number(rows[0]?.c ?? 0);
  }
}

/** Map progress_records row to ProgressRecord domain object. */
function rowToProgressRecord(row: SqlRow): ProgressRecord {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    recordedAt: row.recorded_at as string,
    windowStart: row.window_start as string,
    windowEnd: row.window_end as string,
    sessionsCompleted: Number(row.sessions_completed ?? 0),
    turnsCompleted: Number(row.turns_completed ?? 0),
    listeningScore: row.listening_score != null ? Number(row.listening_score) : undefined,
    speakingScore: row.speaking_score != null ? Number(row.speaking_score) : undefined,
    fluencyScore: row.fluency_score != null ? Number(row.fluency_score) : undefined,
    confidenceScore: row.confidence_score != null ? Number(row.confidence_score) : undefined,
    pronunciationScore: row.pronunciation_score != null ? Number(row.pronunciation_score) : undefined,
    grammarScore: row.grammar_score != null ? Number(row.grammar_score) : undefined,
    vocabularyScore: row.vocabulary_score != null ? Number(row.vocabulary_score) : undefined,
    newWordsLearned: Number(row.new_words_learned ?? 0),
    weaknessesImproved: Number(row.weaknesses_improved ?? 0),
    weaknessesWorsened: Number(row.weaknesses_worsened ?? 0),
    notes: (row.notes as string) ?? undefined,
  };
}

/**
 * SQLiteProgressRepository
 *
 * Implements ProgressRepository for progress_records.
 */
export class SQLiteProgressRepository implements ProgressRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async record(
    record: Omit<ProgressRecord, 'id'>,
  ): Promise<ProgressRecord> {
    if (!record.learnerId || !isValidUuid(record.learnerId)) {
      throw new Error('Invalid learnerId');
    }

    const id = generateId();
    await this.adapter.execute(
      `INSERT INTO progress_records (
        id, learner_id, recorded_at, window_start, window_end,
        sessions_completed, turns_completed,
        listening_score, speaking_score, fluency_score, confidence_score,
        pronunciation_score, grammar_score, vocabulary_score,
        new_words_learned, weaknesses_improved, weaknesses_worsened, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        record.learnerId,
        record.recordedAt,
        record.windowStart,
        record.windowEnd,
        record.sessionsCompleted ?? 0,
        record.turnsCompleted ?? 0,
        record.listeningScore ?? null,
        record.speakingScore ?? null,
        record.fluencyScore ?? null,
        record.confidenceScore ?? null,
        record.pronunciationScore ?? null,
        record.grammarScore ?? null,
        record.vocabularyScore ?? null,
        record.newWordsLearned ?? 0,
        record.weaknessesImproved ?? 0,
        record.weaknessesWorsened ?? 0,
        record.notes ?? null,
      ],
    );

    const rows = await this.adapter.query(
      `SELECT * FROM progress_records WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) {
      throw new Error('Failed to retrieve recorded progress');
    }
    return rowToProgressRecord(rows[0]);
  }

  async list(
    learnerId: string,
    limit?: number,
  ): Promise<readonly ProgressRecord[]> {
    if (!isValidUuid(learnerId)) return [];

    let sql = `SELECT * FROM progress_records WHERE learner_id = ? ORDER BY recorded_at DESC`;
    const params: SqlParam[] = [learnerId];

    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = await this.adapter.query(sql, params);
    return rows.map(rowToProgressRecord);
  }

  async latest(learnerId: string): Promise<ProgressRecord | null> {
    if (!isValidUuid(learnerId)) return null;

    const rows = await this.adapter.query(
      `SELECT * FROM progress_records WHERE learner_id = ? ORDER BY recorded_at DESC LIMIT 1`,
      [learnerId],
    );
    return rows.length > 0 ? rowToProgressRecord(rows[0]) : null;
  }

  /** Exact count of persisted progress records in an optional range. */
  async countRecords(
    learnerId: string,
    opts?: { recordedAfter?: string; recordedUntil?: string },
  ): Promise<number> {
    if (!isValidUuid(learnerId)) return 0;

    let sql = `SELECT COUNT(*) AS c FROM progress_records WHERE learner_id = ?`;
    const params: SqlParam[] = [learnerId];
    if (opts?.recordedAfter !== undefined) {
      sql += ` AND recorded_at >= ?`;
      params.push(opts.recordedAfter);
    }
    if (opts?.recordedUntil !== undefined) {
      sql += ` AND recorded_at < ?`;
      params.push(opts.recordedUntil);
    }
    const rows = await this.adapter.query(sql, params);
    return Number(rows[0]?.c ?? 0);
  }
}

export { deleteLexicalItemWithReviews };
