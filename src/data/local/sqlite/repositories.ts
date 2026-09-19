/**
 * src/data/local/sqlite/repositories.ts
 *
 * SQLite implementations of repositories with hardened transactional integrity.
 *
 * Fixes:
 * - Atomic lexical rewrites via transaction
 * - SRS history preservation on re-save
 * - markReviewed atomic + idempotent + no lost update
 * - DB-backed uniqueness via v6 migration + race-safe upserts
 * - Profile singleton race protection
 * - Lexical orphan cleanup integrity
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
  DailyTutorRepository,
  DailyTutorSessionRecord,
  DailyTutorActivityRecord,
  CreateDailyTutorSessionInput,
  DailyTutorSessionPatch,
  DailyTutorActivityPatch,
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
import { DAILY_ACTIVITY_KINDS } from '../../../daily-tutor/types';
import type {
  DailyActivityKind,
  DailyActivityStatus,
  DailySessionStatus,
} from '../../../daily-tutor/types';
import { isValidDateKey } from '../../../daily-tutor/date';

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

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return msg.includes('unique constraint failed') || msg.includes('unique constraint') || msg.includes('duplicate') || msg.includes('unique');
}

function normalizeDef(def: string): string {
  return def.trim().toLowerCase();
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

  fields.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  const sql = `UPDATE conversation_sessions SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

function assertValidSessionId(id: string): void {
  if (!isValidUuid(id)) {
    throw new Error('Invalid session id');
  }
}

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

function sessionInsertSql(): string {
  return `INSERT INTO conversation_sessions (
        id, learner_id, mode, title, topic, topic_source, status,
        started_at, ended_at, duration_seconds, difficulty, turn_count,
        summary, tags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

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

function turnInsertSql(): string {
  return `INSERT INTO conversation_turns (
        id, session_id, speaker, text, audio_ref, detected_language,
        sequence_number, started_at, ended_at, duration_ms, confidence,
        metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

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

  fields.push('updated_at = ?');
  params.push(nowIso());
  params.push(id);

  const sql = `UPDATE learner_profile SET ${fields.join(', ')} WHERE id = ?`;
  return { sql, params };
}

/**
 * SQLiteUserProfileRepository
 * Race-safe via singleton UNIQUE constraint and INSERT handling.
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
    const existing = await this.adapter.query(
      `SELECT id FROM learner_profile LIMIT 1`,
    );
    const now = nowIso();

    if (existing.length === 0) {
      const id = generateId();
      const displayName = patch.displayName ?? 'Learner';
      const targetLanguage = patch.targetLanguage ?? 'en';
      const targetLevel = patch.targetLevel ?? 'unknown';
      const currentLevel = patch.currentLevel ?? 'unknown';
      const learningGoals = patch.learningGoals ?? [];
      const preferredModes = patch.preferredModes ?? [];
      const nativeLanguage = patch.nativeLanguage ?? null;

      try {
        // Include singleton=1 for the unique single-profile invariant.
        // If column doesn't exist yet (pre-v6 DB during migration), fallback without it.
        try {
          await this.adapter.execute(
            `INSERT INTO learner_profile (
              id, display_name, native_language, target_language,
              target_level, current_level, learning_goals, preferred_modes,
              created_at, updated_at, singleton
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
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
        } catch (e) {
          if (String((e as Error).message).toLowerCase().includes('no column') && String((e as Error).message).toLowerCase().includes('singleton')) {
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
          } else {
            throw e;
          }
        }
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Race: another instance inserted first. Load existing and apply patch.
          const raced = await this.adapter.query(`SELECT id FROM learner_profile LIMIT 1`);
          if (raced.length > 0) {
            const racedId = raced[0].id as string;
            const { sql, params } = buildProfileUpdate(racedId, patch);
            await this.adapter.execute(sql, params);
            return this.get();
          }
        }
        throw err;
      }
      return this.get();
    }

    const id = existing[0].id as string;
    const { sql, params } = buildProfileUpdate(id, patch);
    await this.adapter.execute(sql, params);
    return this.get();
  }
}

/**
 * SQLiteConversationRepository
 */
export class SQLiteConversationRepository implements ConversationRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async createSession(
    session: Omit<ConversationSession, 'id' | 'createdAt' | 'updatedAt'> & {
      readonly id?: string;
    },
  ): Promise<ConversationSession> {
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for reference, now using monotonic timestamp path
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

export class SQLiteMistakeRepository implements MistakeRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async recordMistake(
    mistake: Omit<GrammarMistake, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GrammarMistake> {
    const id = generateId();
    const now = nowIso();
    if (!mistake.learnerId || !isValidUuid(mistake.learnerId)) {
      throw new Error('Invalid learnerId');
    }
    if (!mistake.category) throw new Error('category is required');
    if (!mistake.pattern) throw new Error('pattern is required');
    if (!mistake.correction) throw new Error('correction is required');
    if (!mistake.severity) throw new Error('severity is required');
    if (!mistake.lastSeenAt) throw new Error('lastSeenAt is required');
    if (!mistake.firstSeenAt) throw new Error('firstSeenAt is required');

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
    const rows = await this.adapter.query(`SELECT * FROM grammar_mistakes WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Failed to create grammar mistake');
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
    if (!isValidUuid(id)) throw new Error('Invalid mistake id');
    const existing = await this.adapter.query(`SELECT * FROM grammar_mistakes WHERE id = ?`, [id]);
    if (existing.length === 0) throw new Error(`Grammar mistake not found: ${id}`);
    const prevUpdatedAt = existing[0].updated_at as string;
    const newUpdatedAt = generateMonotonicTimestamp(prevUpdatedAt);
    // Use monotonic timestamp to guarantee updatedAt advances, preventing flaky test where nowIso() equals previous ms
    await this.adapter.execute(
      `UPDATE grammar_mistakes SET resolved = ?, updated_at = ? WHERE id = ?`,
      [resolved ? 1 : 0, newUpdatedAt, id],
    );
    const rows = await this.adapter.query(`SELECT * FROM grammar_mistakes WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Grammar mistake disappeared after update');
    return rowToGrammarMistake(rows[0]);
  }

  async updateMistake(
    id: string,
    patch: Partial<Omit<GrammarMistake, 'id' | 'createdAt'>>,
  ): Promise<GrammarMistake> {
    if (!isValidUuid(id)) throw new Error('Invalid mistake id');
    const existing = await this.adapter.query(`SELECT * FROM grammar_mistakes WHERE id = ?`, [id]);
    if (existing.length === 0) throw new Error(`Grammar mistake not found: ${id}`);
    const prevUpdatedAt = existing[0].updated_at as string;
    const newUpdatedAt = generateMonotonicTimestamp(prevUpdatedAt);

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
      const value = (patch as any)[key];
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
    params.push(newUpdatedAt);
    params.push(id);
    const sql = `UPDATE grammar_mistakes SET ${fields.join(', ')} WHERE id = ?`;
    await this.adapter.execute(sql, params);
    const rows = await this.adapter.query(`SELECT * FROM grammar_mistakes WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Grammar mistake disappeared after update');
    return rowToGrammarMistake(rows[0]);
  }
}

export class SQLitePronunciationRepository implements PronunciationRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async recordWeakness(
    weakness: Omit<PronunciationWeakness, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PronunciationWeakness> {
    const id = generateId();
    const now = nowIso();
    if (!weakness.learnerId || !isValidUuid(weakness.learnerId)) throw new Error('Invalid learnerId');
    if (!weakness.targetSound) throw new Error('targetSound is required');
    if (!weakness.lastSeenAt) throw new Error('lastSeenAt is required');
    if (!weakness.firstSeenAt) throw new Error('firstSeenAt is required');

    try {
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
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Race: another instance inserted same logical identity. Return existing via observation path.
        const existing = await this.adapter.query(
          `SELECT * FROM pronunciation_weaknesses WHERE learner_id = ? AND target_sound = ?`,
          [weakness.learnerId, weakness.targetSound],
        );
        if (existing.length > 0) return rowToPronunciationWeakness(existing[0]);
      }
      throw err;
    }

    const rows = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Failed to create pronunciation weakness');
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
    if (!isValidUuid(id)) throw new Error('Invalid pronunciation weakness id');
    const existing = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
    if (existing.length === 0) throw new Error(`Pronunciation weakness not found: ${id}`);
    const previousUpdatedAt = existing[0].updated_at as string;
    const newUpdatedAt = generateMonotonicTimestamp(previousUpdatedAt);
    await this.adapter.execute(
      `UPDATE pronunciation_weaknesses SET resolved = ?, updated_at = ? WHERE id = ?`,
      [resolved ? 1 : 0, newUpdatedAt, id],
    );
    const rows = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Pronunciation weakness disappeared after update');
    return rowToPronunciationWeakness(rows[0]);
  }

  async recordObservation(
    input: PronunciationObservationInput,
  ): Promise<PronunciationObservationRecord> {
    if (!input.learnerId || !isValidUuid(input.learnerId)) throw new Error('Invalid learnerId');
    if (!input.identity) throw new Error('identity is required');
    if (!input.evidenceSource) throw new Error('evidenceSource is required');

    const evidenceEntry = {
      at: input.at,
      source: input.evidenceSource,
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.exampleText ? { observed: input.exampleText } : {}),
    };

    // Try fast path: check existing
    const existingRows = await this.adapter.query(
      `SELECT id FROM pronunciation_weaknesses WHERE learner_id = ? AND target_sound = ?`,
      [input.learnerId, input.identity],
    );

    if (existingRows.length > 0) {
      const id = existingRows[0].id as string;
      const currentRows = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
      if (currentRows.length === 0) {
        // Race deleted, fall through to create
      } else {
        const current = rowToPronunciationWeakness(currentRows[0]);
        const wordExamples = [
          ...(input.exampleText ? [input.exampleText] : []),
          ...current.wordExamples,
        ].slice(0, 10);
        const contexts = Array.from(
          new Set([...(input.context ? [input.context] : []), ...current.contexts]),
        ).slice(0, 10);
        const evidenceLog = [...(current.evidenceLog ?? []), evidenceEntry].slice(-20);

        try {
          await this.adapter.transaction([
            {
              sql: `UPDATE pronunciation_weaknesses SET
                occurrence_count = occurrence_count + 1,
                last_seen_at = ?,
                word_examples = ?,
                contexts = ?,
                evidence_log = ?,
                updated_at = ?
              WHERE id = ?`,
              params: [
                input.at,
                JSON.stringify(wordExamples),
                JSON.stringify(contexts),
                JSON.stringify(evidenceLog),
                input.at,
                id,
              ],
            },
          ]);
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Another writer raced, reload
            const reloaded = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
            if (reloaded.length > 0) {
              return { weakness: rowToPronunciationWeakness(reloaded[0]), created: false };
            }
          } else {
            throw err;
          }
        }

        const updatedRows = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
        return { weakness: rowToPronunciationWeakness(updatedRows[0]), created: false };
      }
    }

    // Try to create, handling race via unique constraint
    try {
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
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Race: another instance created same identity concurrently. Retry as update.
        const racedRows = await this.adapter.query(
          `SELECT id FROM pronunciation_weaknesses WHERE learner_id = ? AND target_sound = ?`,
          [input.learnerId, input.identity],
        );
        if (racedRows.length > 0) {
          const id = racedRows[0].id as string;
          const currentRows = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
          const current = rowToPronunciationWeakness(currentRows[0]);
          const wordExamples = [
            ...(input.exampleText ? [input.exampleText] : []),
            ...current.wordExamples,
          ].slice(0, 10);
          const contexts = Array.from(
            new Set([...(input.context ? [input.context] : []), ...current.contexts]),
          ).slice(0, 10);
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
          const updatedRows = await this.adapter.query(`SELECT * FROM pronunciation_weaknesses WHERE id = ?`, [id]);
          return { weakness: rowToPronunciationWeakness(updatedRows[0]), created: false };
        }
      }
      throw err;
    }
  }
}

export class SQLiteWeaknessRepository implements WeaknessRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

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
    if (!weakness.learnerId || !isValidUuid(weakness.learnerId)) throw new Error('Invalid learnerId');
    if (!weakness.type) throw new Error('type is required');
    if (!weakness.referenceId) throw new Error('referenceId is required');
    if (!weakness.status) throw new Error('status is required');
    if (weakness.severity === undefined || weakness.severity === null) throw new Error('severity is required');
    if (!weakness.lastSeenAt) throw new Error('lastSeenAt is required');
    if (!weakness.firstSeenAt) throw new Error('firstSeenAt is required');

    const existing = await this.adapter.query(
      `SELECT * FROM learner_weaknesses WHERE learner_id = ? AND type = ? AND reference_id = ?`,
      [weakness.learnerId, weakness.type, weakness.referenceId],
    );

    const now = nowIso();

    if (existing.length > 0) {
      const id = existing[0].id as string;
      const { sql, params } = buildLearnerWeaknessUpdate(id, weakness);
      try {
        await this.adapter.execute(sql, params);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Race: another instance updated concurrently, reload
          const reloaded = await this.adapter.query(`SELECT * FROM learner_weaknesses WHERE learner_id = ? AND type = ? AND reference_id = ?`, [weakness.learnerId, weakness.type, weakness.referenceId]);
          if (reloaded.length > 0) return rowToLearnerWeakness(reloaded[0]);
        }
        throw err;
      }
      const rows = await this.adapter.query(`SELECT * FROM learner_weaknesses WHERE id = ?`, [id]);
      if (rows.length === 0) throw new Error('Weakness disappeared after update');
      return rowToLearnerWeakness(rows[0]);
    }

    const id = generateId();
    try {
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
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.adapter.query(
          `SELECT * FROM learner_weaknesses WHERE learner_id = ? AND type = ? AND reference_id = ?`,
          [weakness.learnerId, weakness.type, weakness.referenceId],
        );
        if (raced.length > 0) {
          const racedId = raced[0].id as string;
          const { sql, params } = buildLearnerWeaknessUpdate(racedId, weakness);
          await this.adapter.execute(sql, params);
          const rows = await this.adapter.query(`SELECT * FROM learner_weaknesses WHERE id = ?`, [racedId]);
          return rowToLearnerWeakness(rows[0]);
        }
      }
      throw err;
    }

    const rows = await this.adapter.query(`SELECT * FROM learner_weaknesses WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Failed to create learner weakness');
    return rowToLearnerWeakness(rows[0]);
  }

  async upsertStrength(
    strength: Omit<LearnerStrength, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<LearnerStrength> {
    if (!strength.learnerId || !isValidUuid(strength.learnerId)) throw new Error('Invalid learnerId');
    if (!strength.type) throw new Error('type is required');
    if (!strength.referenceId) throw new Error('referenceId is required');
    if (strength.confidence === undefined || strength.confidence === null) throw new Error('confidence is required');
    if (!strength.lastSeenAt) throw new Error('lastSeenAt is required');
    if (!strength.firstSeenAt) throw new Error('firstSeenAt is required');

    const existing = await this.adapter.query(
      `SELECT * FROM learner_strengths WHERE learner_id = ? AND type = ? AND reference_id = ?`,
      [strength.learnerId, strength.type, strength.referenceId],
    );

    const now = nowIso();

    if (existing.length > 0) {
      const id = existing[0].id as string;
      const { sql, params } = buildLearnerStrengthUpdate(id, strength);
      try {
        await this.adapter.execute(sql, params);
      } catch (err) {
        if (isUniqueViolation(err)) {
          const reloaded = await this.adapter.query(`SELECT * FROM learner_strengths WHERE learner_id = ? AND type = ? AND reference_id = ?`, [strength.learnerId, strength.type, strength.referenceId]);
          if (reloaded.length > 0) return rowToLearnerStrength(reloaded[0]);
        }
        throw err;
      }
      const rows = await this.adapter.query(`SELECT * FROM learner_strengths WHERE id = ?`, [id]);
      if (rows.length === 0) throw new Error('Strength disappeared after update');
      return rowToLearnerStrength(rows[0]);
    }

    const id = generateId();
    try {
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
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.adapter.query(
          `SELECT * FROM learner_strengths WHERE learner_id = ? AND type = ? AND reference_id = ?`,
          [strength.learnerId, strength.type, strength.referenceId],
        );
        if (raced.length > 0) {
          const racedId = raced[0].id as string;
          const { sql, params } = buildLearnerStrengthUpdate(racedId, strength);
          await this.adapter.execute(sql, params);
          const rows = await this.adapter.query(`SELECT * FROM learner_strengths WHERE id = ?`, [racedId]);
          return rowToLearnerStrength(rows[0]);
        }
      }
      throw err;
    }

    const rows = await this.adapter.query(`SELECT * FROM learner_strengths WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Failed to create learner strength');
    return rowToLearnerStrength(rows[0]);
  }

  async addWeaknessEvidence(evidence: Omit<EvidenceRef, 'kind'> & { weaknessId: string; kind: EvidenceRef['kind'] }): Promise<void> {
    if (!isValidUuid(evidence.weaknessId)) throw new Error('Invalid weaknessId');
    if (!isValidUuid(evidence.id)) throw new Error('Invalid evidence id');
    if (!evidence.kind) throw new Error('kind is required');
    if (!evidence.at) throw new Error('at is required');

    const existing = await this.adapter.query(`SELECT id FROM learner_weaknesses WHERE id = ?`, [evidence.weaknessId]);
    if (existing.length === 0) throw new Error(`Weakness not found: ${evidence.weaknessId}`);

    await this.adapter.execute(
      `INSERT INTO weakness_evidence (id, weakness_id, kind, ref_id, at, summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        evidence.id,
        evidence.weaknessId,
        evidence.kind,
        evidence.id,
        evidence.at,
        evidence.summary ?? null,
      ],
    );
  }

  async getUnresolvedStatusCounts(learnerId: string): Promise<WeaknessStatusCounts> {
    if (!isValidUuid(learnerId)) return { unresolved: 0, byStatus: {} };
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

function dbSourceToDomain(source: string): ExampleSource {
  return source as ExampleSource;
}

function domainSourceToDb(source: ExampleSource): string {
  return source;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for potential reuse, current impl uses inline inserts
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
 * Delete a lexical item and all dependent rows atomically.
 */
async function deleteLexicalItemCompletely(
  adapter: DatabaseAdapter,
  id: string,
): Promise<boolean> {
  if (!isValidUuid(id)) return false;
  const existing = await adapter.query(`SELECT id FROM lexical_items WHERE id = ?`, [id]);
  if (existing.length === 0) return false;

  await adapter.transaction([
    { sql: `DELETE FROM lexical_examples WHERE lexical_item_id = ?`, params: [id] },
    { sql: `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`, params: [id] },
    { sql: `DELETE FROM lexical_items WHERE id = ?`, params: [id] },
  ]);
  return true;
}

/**
 * Replace all meanings of a lexical item atomically, preserving orphan integrity.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- retained for atomic rewrite reference
async function replaceLexicalMeanings(
  adapter: DatabaseAdapter,
  lexicalItemId: string,
  meanings: readonly Meaning[],
  now: string,
): Promise<void> {
  const steps: { sql: string; params: SqlParam[] }[] = [];

  // Delete examples and meanings for this item in same transaction
  steps.push({ sql: `DELETE FROM lexical_examples WHERE lexical_item_id = ?`, params: [lexicalItemId] });
  steps.push({ sql: `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`, params: [lexicalItemId] });

  for (const meaning of meanings) {
    const meaningId = generateId();
    steps.push({
      sql: `INSERT INTO lexical_meanings (
        id, lexical_item_id, definition, part_of_speech, examples,
        usage_notes, register, domain,
        review_state, review_last_review_at, review_next_review_at,
        review_review_count, review_consecutive_correct, review_ease_factor,
        review_mastered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
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
        (meaning.review as any)?.masteredAt ?? null,
        now,
        now,
      ],
    });

    if (meaning.examples && meaning.examples.length > 0) {
      for (const example of meaning.examples) {
        const exampleId = generateId();
        steps.push({
          sql: `INSERT INTO lexical_examples (
            id, lexical_item_id, meaning_id, text, translation, context,
            source, origin_conversation_id, origin_turn_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
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
        });
      }
    }
  }

  await adapter.transaction(steps);
}

async function deleteLexicalItemWithReviews(
  adapter: DatabaseAdapter,
  lexicalItemId: string,
  kind: 'vocabulary' | 'expression',
): Promise<boolean> {
  if (!isValidUuid(lexicalItemId)) return false;
  const existing = await adapter.query(`SELECT id FROM lexical_items WHERE id = ?`, [lexicalItemId]);
  if (existing.length === 0) return false;

  await adapter.transaction([
    {
      sql: `DELETE FROM review_history WHERE review_item_id IN (
        SELECT id FROM review_items WHERE reference_id = ? AND kind = ?
      )`,
      params: [lexicalItemId, kind],
    },
    {
      sql: `DELETE FROM review_items WHERE reference_id = ? AND kind = ?`,
      params: [lexicalItemId, kind],
    },
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
 * SQLiteVocabularyRepository with atomic rewrites and SRS preservation
 */
export class SQLiteVocabularyRepository implements VocabularyRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async upsert(
    item: Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<VocabularyItem> {
    if (!item.learnerId || !isValidUuid(item.learnerId)) throw new Error('Invalid learnerId');
    if (!item.headword) throw new Error('headword is required');
    if (!item.type) throw new Error('type is required');
    if (!item.source) throw new Error('source is required');

    // Exact identity lookup – never capped list
    const existing = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
      [item.learnerId, item.headword, item.type],
    );

    const now = nowIso();

    if (existing.length === 0) {
      // New item – insert atomically
      const id = generateId();
      const steps: { sql: string; params: SqlParam[] }[] = [
        {
          sql: `INSERT INTO lexical_items (
            id, learner_id, headword, type, pronunciation, synonyms,
            antonyms, related_expressions, source, tags, created_at, updated_at, singleton
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(learner_id, headword, type) DO NOTHING`,
          params: [
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
        },
      ];

      // Fallback for pre-v6 DB without singleton column or without unique index
      // We'll try with singleton, and if fails due to no column, retry without.
      // For simplicity, attempt transaction with fallback handling outside.

      try {
        // Try with singleton column
        await this.adapter.transaction(steps);
      } catch (err) {
        const msg = String((err as Error).message).toLowerCase();
        if (msg.includes('no column') && msg.includes('singleton')) {
          // Retry without singleton
          const fallbackSteps = [
            {
              sql: `INSERT INTO lexical_items (
                id, learner_id, headword, type, pronunciation, synonyms,
                antonyms, related_expressions, source, tags, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(learner_id, headword, type) DO NOTHING`,
              params: [
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
            },
          ];
          try {
            await this.adapter.transaction(fallbackSteps);
          } catch (inner) {
            if (isUniqueViolation(inner)) {
              // Race: another instance inserted same identity, fall through to existing path
              const raced = await this.adapter.query(
                `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
                [item.learnerId, item.headword, item.type],
              );
              if (raced.length > 0) {
                return this.upsertExisting(raced[0].id as string, item, now);
              }
            }
            throw inner;
          }
        } else if (isUniqueViolation(err)) {
          const raced = await this.adapter.query(
            `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
            [item.learnerId, item.headword, item.type],
          );
          if (raced.length > 0) {
            return this.upsertExisting(raced[0].id as string, item, now);
          }
          throw err;
        } else {
          throw err;
        }
      }

      // Check if insert actually happened (ON CONFLICT DO NOTHING may have done nothing)
      const check = await this.adapter.query(
        `SELECT id FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
        [item.learnerId, item.headword, item.type],
      );
      const finalId = check.length > 0 ? (check[0].id as string) : id;

      // If this was a race and we got existing id different from our generated one,
      // we need to treat as existing item preservation
      if (finalId !== id) {
        return this.upsertExisting(finalId, item, now);
      }

      // Insert meanings and examples atomically
      const meaningSteps: { sql: string; params: SqlParam[] }[] = [];
      for (const meaning of item.meanings) {
        const meaningId = generateId();
        meaningSteps.push({
          sql: `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            meaningId,
            finalId,
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
            (meaning.review as any)?.masteredAt ?? null,
            now,
            now,
          ],
        });

        if (meaning.examples && meaning.examples.length > 0) {
          for (const ex of meaning.examples) {
            const exId = generateId();
            meaningSteps.push({
              sql: `INSERT INTO lexical_examples (
                id, lexical_item_id, meaning_id, text, translation, context,
                source, origin_conversation_id, origin_turn_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              params: [
                exId,
                finalId,
                meaningId,
                ex.text,
                ex.translation ?? null,
                ex.context ?? null,
                domainSourceToDb(ex.source),
                ex.originConversationId ?? null,
                ex.originTurnId ?? null,
                ex.createdAt ?? now,
              ],
            });
          }
        }
      }

      if (meaningSteps.length > 0) {
        await this.adapter.transaction(meaningSteps);
      }

      return this.getFullItem(finalId);
    }

    // Existing item – preserve SRS history
    const id = existing[0].id as string;
    return this.upsertExisting(id, item, now);
  }

  private async upsertExisting(
    id: string,
    item: Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt'>,
    now: string,
  ): Promise<VocabularyItem> {
    // Load existing meanings to preserve SRS
    const existingMeaningRows = await this.adapter.query(
      `SELECT * FROM lexical_meanings WHERE lexical_item_id = ? ORDER BY created_at`,
      [id],
    );

    const existingByDef = new Map<string, SqlRow>();
    for (const row of existingMeaningRows) {
      const def = row.definition as string;
      existingByDef.set(normalizeDef(def), row);
    }

    const steps: { sql: string; params: SqlParam[] }[] = [];

    // Update lexical_items non-SRS fields (preserve created_at, update updated_at)
    const { sql, params } = buildLexicalItemUpdate(id, item);
    steps.push({ sql, params });

    // For each incoming meaning, if definition matches existing, preserve its review
    // Otherwise insert as new. We KEEP existing meanings that are not in incoming list
    // to avoid data loss on re-observation.
    const incomingDefs = new Set<string>();
    for (const meaning of item.meanings) {
      const norm = normalizeDef(meaning.definition);
      incomingDefs.add(norm);
      const existingRow = existingByDef.get(norm);

      if (existingRow) {
        // Preserve existing review fields
        const existingReviewState = existingRow.review_state as string;
        const existingLast = existingRow.review_last_review_at as string | null;
        const existingNext = existingRow.review_next_review_at as string | null;
        const existingCount = existingRow.review_review_count as number;
        const existingConsec = existingRow.review_consecutive_correct as number;
        const existingEase = existingRow.review_ease_factor as number | null;
        const existingMastered = existingRow.review_mastered_at as string | null;

        steps.push({
          sql: `UPDATE lexical_meanings SET
            definition = ?,
            part_of_speech = ?,
            examples = ?,
            usage_notes = ?,
            register = ?,
            domain = ?,
            review_state = ?,
            review_last_review_at = ?,
            review_next_review_at = ?,
            review_review_count = ?,
            review_consecutive_correct = ?,
            review_ease_factor = ?,
            review_mastered_at = ?,
            updated_at = ?
          WHERE id = ?`,
          params: [
            meaning.definition,
            meaning.partOfSpeech ?? (existingRow.part_of_speech as string | null),
            JSON.stringify(meaning.examples ?? safeJsonParse(existingRow.examples, [])),
            JSON.stringify(meaning.usageNotes ?? safeJsonParse(existingRow.usage_notes, [])),
            meaning.register ?? (existingRow.register as string | null),
            meaning.domain ?? (existingRow.domain as string | null),
            existingReviewState ?? meaning.review?.state ?? 'new',
            existingLast ?? meaning.review?.lastReviewAt ?? null,
            existingNext ?? meaning.review?.nextReviewAt ?? null,
            existingCount ?? meaning.review?.reviewCount ?? 0,
            existingConsec ?? meaning.review?.consecutiveCorrect ?? 0,
            existingEase ?? meaning.review?.easeFactor ?? null,
            existingMastered ?? (meaning.review as any)?.masteredAt ?? null,
            now,
            existingRow.id as string,
          ],
        });

        // Handle examples: delete old examples for this meaning and re-insert
        // We do delete + insert in same transaction to prevent orphan and ensure consistency
        steps.push({
          sql: `DELETE FROM lexical_examples WHERE meaning_id = ?`,
          params: [existingRow.id as string],
        });

        const examplesToInsert = meaning.examples && meaning.examples.length > 0 ? meaning.examples : safeJsonParse(existingRow.examples, []);
        for (const ex of examplesToInsert) {
          const exId = generateId();
          const exObj = typeof ex === 'string' ? { text: ex, source: 'manual' as ExampleSource } : ex;
          steps.push({
            sql: `INSERT INTO lexical_examples (
              id, lexical_item_id, meaning_id, text, translation, context,
              source, origin_conversation_id, origin_turn_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              exId,
              id,
              existingRow.id as string,
              (exObj as UsageExample).text,
              (exObj as UsageExample).translation ?? null,
              (exObj as UsageExample).context ?? null,
              domainSourceToDb((exObj as UsageExample).source ?? 'manual'),
              (exObj as UsageExample).originConversationId ?? null,
              (exObj as UsageExample).originTurnId ?? null,
              (exObj as UsageExample).createdAt ?? now,
            ],
          });
        }
      } else {
        // New meaning – insert with its review (new or provided)
        const meaningId = generateId();
        steps.push({
          sql: `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
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
            (meaning.review as any)?.masteredAt ?? null,
            now,
            now,
          ],
        });

        if (meaning.examples && meaning.examples.length > 0) {
          for (const ex of meaning.examples) {
            const exId = generateId();
            steps.push({
              sql: `INSERT INTO lexical_examples (
                id, lexical_item_id, meaning_id, text, translation, context,
                source, origin_conversation_id, origin_turn_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              params: [
                exId,
                id,
                meaningId,
                ex.text,
                ex.translation ?? null,
                ex.context ?? null,
                domainSourceToDb(ex.source),
                ex.originConversationId ?? null,
                ex.originTurnId ?? null,
                ex.createdAt ?? now,
              ],
            });
          }
        }
      }
    }

    // Existing meanings not in incoming list are kept as-is (no deletion) to preserve SRS

    await this.adapter.transaction(steps);
    return this.getFullItem(id);
  }

  private async getFullItem(id: string): Promise<VocabularyItem> {
    const itemRows = await this.adapter.query(`SELECT * FROM lexical_items WHERE id = ?`, [id]);
    if (itemRows.length === 0) throw new Error('Vocabulary item not found after upsert');
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
    return { ...item, meanings };
  }

  async get(id: string): Promise<VocabularyItem | null> {
    if (!isValidUuid(id)) return null;
    const itemRows = await this.adapter.query(`SELECT * FROM lexical_items WHERE id = ?`, [id]);
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
    return { ...item, meanings };
  }

  async getByHeadword(
    learnerId: string,
    headword: string,
    type: VocabularyItem['type'],
  ): Promise<VocabularyItem | null> {
    if (!isValidUuid(learnerId) || !headword || !type) return null;
    const rows = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ? LIMIT 1`,
      [learnerId, headword, type],
    );
    if (rows.length === 0) return null;
    return this.get(rows[0].id as string);
  }

  async list(
    learnerId: string,
    opts?: { state?: string; limit?: number; types?: readonly VocabularyItem['type'][] },
  ): Promise<readonly VocabularyItem[]> {
    if (!isValidUuid(learnerId)) return [];
    let sql = `SELECT * FROM lexical_items WHERE learner_id = ?`;
    const params: SqlParam[] = [learnerId];
    if (opts?.types !== undefined && opts.types.length > 0) {
      const placeholders = opts.types.map(() => '?').join(', ');
      sql += ` AND type IN (${placeholders})`;
      params.push(...opts.types);
    }
    sql += ` ORDER BY created_at DESC`;
    if (opts?.limit !== undefined && opts.limit > 0) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }
    const rows = await this.adapter.query(sql, params);
    const items: VocabularyItem[] = [];
    for (const row of rows) {
      const itemId = row.id;
      if (!itemId || typeof itemId !== 'string') throw new Error('Invalid vocabulary item row: missing id');
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
      const base = rowToVocabularyItem(row);
      items.push({ ...base, meanings });
    }
    return items;
  }

  async listDue(
    learnerId: string,
    now: string,
    limit?: number,
  ): Promise<readonly VocabularyItem[]> {
    if (!isValidUuid(learnerId)) return [];
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
      const itemId = row.id;
      if (!itemId || typeof itemId !== 'string') throw new Error('Invalid vocabulary item row: missing id');
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
      const base = rowToVocabularyItem(row);
      items.push({ ...base, meanings });
    }
    return items;
  }

  async update(
    id: string,
    patch: Partial<Omit<VocabularyItem, 'id' | 'createdAt'>>,
  ): Promise<VocabularyItem> {
    if (!isValidUuid(id)) throw new Error('Invalid vocabulary item id');
    const existing = await this.get(id);
    if (!existing) throw new Error(`Vocabulary item not found: ${id}`);

    const now = nowIso();
    const steps: { sql: string; params: SqlParam[] }[] = [];

    const { meanings, ...itemPatch } = patch;
    if (Object.keys(itemPatch).length > 0) {
      const { sql, params } = buildLexicalItemUpdate(id, itemPatch);
      steps.push({ sql, params });
    }

    if (meanings !== undefined) {
      // Atomic replacement: delete examples and meanings, then insert new
      steps.push({ sql: `DELETE FROM lexical_examples WHERE lexical_item_id = ?`, params: [id] });
      steps.push({ sql: `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`, params: [id] });

      for (const meaning of meanings) {
        const meaningId = generateId();
        steps.push({
          sql: `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
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
            (meaning.review as any)?.masteredAt ?? null,
            now,
            now,
          ],
        });

        if (meaning.examples && meaning.examples.length > 0) {
          for (const ex of meaning.examples) {
            const exId = generateId();
            steps.push({
              sql: `INSERT INTO lexical_examples (
                id, lexical_item_id, meaning_id, text, translation, context,
                source, origin_conversation_id, origin_turn_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              params: [
                exId,
                id,
                meaningId,
                ex.text,
                ex.translation ?? null,
                ex.context ?? null,
                domainSourceToDb(ex.source),
                ex.originConversationId ?? null,
                ex.originTurnId ?? null,
                ex.createdAt ?? now,
              ],
            });
          }
        }
      }
    }

    if (steps.length > 0) {
      await this.adapter.transaction(steps);
    }

    return this.getFullItem(id);
  }

  async delete(id: string): Promise<boolean> {
    return deleteLexicalItemCompletely(this.adapter, id);
  }

  async getBucketCounts(
    learnerId: string,
    opts: { now: string; types?: readonly VocabularyItem['type'][] },
  ): Promise<LexicalBucketCounts> {
    const types = opts.types && opts.types.length > 0 ? opts.types : ['word', 'phrase'];
    return lexicalBucketCounts(this.adapter, learnerId, types, opts.now);
  }

  async countCreated(
    learnerId: string,
    opts?: { createdAfter?: string; createdUntil?: string; types?: readonly VocabularyItem['type'][] },
  ): Promise<number> {
    const types = opts?.types && opts.types.length > 0 ? opts.types : ['word', 'phrase'];
    return countLexicalCreated(this.adapter, learnerId, types, opts);
  }
}

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

export class SQLiteExpressionRepository implements ExpressionRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  private async getFullItem(id: string): Promise<ExpressionItem> {
    const rows = await this.adapter.query(`SELECT * FROM lexical_items WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error(`Expression item not found: ${id}`);
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
    if (!item.learnerId || !isValidUuid(item.learnerId)) throw new Error('Invalid learnerId');
    if (!item.expression) throw new Error('expression is required');
    if (!item.type) throw new Error('type is required');

    const existing = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
      [item.learnerId, item.expression, item.type],
    );

    const now = nowIso();

    if (existing.length === 0) {
      const id = generateId();
      const steps: { sql: string; params: SqlParam[] }[] = [
        {
          sql: `INSERT INTO lexical_items (
            id, learner_id, headword, type, pronunciation,
            synonyms, antonyms, related_expressions, natural_alternatives,
            register, domain, source, tags, created_at, updated_at, singleton
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(learner_id, headword, type) DO NOTHING`,
          params: [
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
        },
      ];

      try {
        await this.adapter.transaction(steps);
      } catch (err) {
        const msg = String((err as Error).message).toLowerCase();
        if (msg.includes('no column') && msg.includes('singleton')) {
          const fallback = [
            {
              sql: `INSERT INTO lexical_items (
                id, learner_id, headword, type, pronunciation,
                synonyms, antonyms, related_expressions, natural_alternatives,
                register, domain, source, tags, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(learner_id, headword, type) DO NOTHING`,
              params: [
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
            },
          ];
          try {
            await this.adapter.transaction(fallback);
          } catch (inner) {
            if (isUniqueViolation(inner)) {
              const raced = await this.adapter.query(
                `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
                [item.learnerId, item.expression, item.type],
              );
              if (raced.length > 0) return this.upsertExisting(raced[0].id as string, item, now);
            }
            throw inner;
          }
        } else if (isUniqueViolation(err)) {
          const raced = await this.adapter.query(
            `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
            [item.learnerId, item.expression, item.type],
          );
          if (raced.length > 0) return this.upsertExisting(raced[0].id as string, item, now);
          throw err;
        } else {
          throw err;
        }
      }

      const check = await this.adapter.query(
        `SELECT id FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ?`,
        [item.learnerId, item.expression, item.type],
      );
      const finalId = check.length > 0 ? (check[0].id as string) : id;
      if (finalId !== id) {
        return this.upsertExisting(finalId, item, now);
      }

      const meaningSteps: { sql: string; params: SqlParam[] }[] = [];
      for (const meaning of item.meanings ?? []) {
        const meaningId = generateId();
        meaningSteps.push({
          sql: `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            meaningId,
            finalId,
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
            (meaning.review as any)?.masteredAt ?? null,
            now,
            now,
          ],
        });
        for (const ex of meaning.examples ?? []) {
          const exId = generateId();
          meaningSteps.push({
            sql: `INSERT INTO lexical_examples (
              id, lexical_item_id, meaning_id, text, translation, context,
              source, origin_conversation_id, origin_turn_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              exId,
              finalId,
              meaningId,
              ex.text,
              ex.translation ?? null,
              ex.context ?? null,
              domainSourceToDb(ex.source),
              ex.originConversationId ?? null,
              ex.originTurnId ?? null,
              ex.createdAt ?? now,
            ],
          });
        }
      }

      if (meaningSteps.length > 0) {
        await this.adapter.transaction(meaningSteps);
      }

      return this.getFullItem(finalId);
    }

    const id = existing[0].id as string;
    return this.upsertExisting(id, item, now);
  }

  private async upsertExisting(
    id: string,
    item: Omit<ExpressionItem, 'id' | 'createdAt' | 'updatedAt'>,
    now: string,
  ): Promise<ExpressionItem> {
    const existingMeaningRows = await this.adapter.query(
      `SELECT * FROM lexical_meanings WHERE lexical_item_id = ? ORDER BY created_at`,
      [id],
    );

    const existingByDef = new Map<string, SqlRow>();
    for (const row of existingMeaningRows) {
      existingByDef.set(normalizeDef(row.definition as string), row);
    }

    const steps: { sql: string; params: SqlParam[] }[] = [];

    steps.push({
      sql: `UPDATE lexical_items SET
        natural_alternatives = ?,
        register = ?,
        domain = ?,
        source = ?,
        tags = ?,
        updated_at = ?
      WHERE id = ?`,
      params: [
        JSON.stringify(item.naturalAlternatives ?? []),
        item.register ?? null,
        item.domain ?? null,
        JSON.stringify(item.source ?? {}),
        JSON.stringify(item.tags ?? []),
        now,
        id,
      ],
    });

    const incomingDefs = new Set<string>();
    for (const meaning of item.meanings ?? []) {
      const norm = normalizeDef(meaning.definition);
      incomingDefs.add(norm);
      const existingRow = existingByDef.get(norm);

      if (existingRow) {
        const existingReviewState = existingRow.review_state as string;
        const existingLast = existingRow.review_last_review_at as string | null;
        const existingNext = existingRow.review_next_review_at as string | null;
        const existingCount = existingRow.review_review_count as number;
        const existingConsec = existingRow.review_consecutive_correct as number;
        const existingEase = existingRow.review_ease_factor as number | null;
        const existingMastered = existingRow.review_mastered_at as string | null;

        steps.push({
          sql: `UPDATE lexical_meanings SET
            definition = ?,
            part_of_speech = ?,
            examples = ?,
            usage_notes = ?,
            register = ?,
            domain = ?,
            review_state = ?,
            review_last_review_at = ?,
            review_next_review_at = ?,
            review_review_count = ?,
            review_consecutive_correct = ?,
            review_ease_factor = ?,
            review_mastered_at = ?,
            updated_at = ?
          WHERE id = ?`,
          params: [
            meaning.definition,
            meaning.partOfSpeech ?? (existingRow.part_of_speech as string | null),
            JSON.stringify(meaning.examples ?? safeJsonParse(existingRow.examples, [])),
            JSON.stringify(meaning.usageNotes ?? safeJsonParse(existingRow.usage_notes, [])),
            meaning.register ?? (existingRow.register as string | null),
            meaning.domain ?? (existingRow.domain as string | null),
            existingReviewState ?? meaning.review?.state ?? 'new',
            existingLast ?? meaning.review?.lastReviewAt ?? null,
            existingNext ?? meaning.review?.nextReviewAt ?? null,
            existingCount ?? meaning.review?.reviewCount ?? 0,
            existingConsec ?? meaning.review?.consecutiveCorrect ?? 0,
            existingEase ?? meaning.review?.easeFactor ?? null,
            existingMastered ?? (meaning.review as any)?.masteredAt ?? null,
            now,
            existingRow.id as string,
          ],
        });

        steps.push({
          sql: `DELETE FROM lexical_examples WHERE meaning_id = ?`,
          params: [existingRow.id as string],
        });

        const examplesToInsert = meaning.examples && meaning.examples.length > 0 ? meaning.examples : safeJsonParse(existingRow.examples, []);
        for (const ex of examplesToInsert) {
          const exId = generateId();
          const exObj = typeof ex === 'string' ? { text: ex, source: 'manual' as ExampleSource } : ex;
          steps.push({
            sql: `INSERT INTO lexical_examples (
              id, lexical_item_id, meaning_id, text, translation, context,
              source, origin_conversation_id, origin_turn_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              exId,
              id,
              existingRow.id as string,
              (exObj as UsageExample).text,
              (exObj as UsageExample).translation ?? null,
              (exObj as UsageExample).context ?? null,
              domainSourceToDb((exObj as UsageExample).source ?? 'manual'),
              (exObj as UsageExample).originConversationId ?? null,
              (exObj as UsageExample).originTurnId ?? null,
              (exObj as UsageExample).createdAt ?? now,
            ],
          });
        }
      } else {
        const meaningId = generateId();
        steps.push({
          sql: `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
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
            (meaning.review as any)?.masteredAt ?? null,
            now,
            now,
          ],
        });

        for (const ex of meaning.examples ?? []) {
          const exId = generateId();
          steps.push({
            sql: `INSERT INTO lexical_examples (
              id, lexical_item_id, meaning_id, text, translation, context,
              source, origin_conversation_id, origin_turn_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              exId,
              id,
              meaningId,
              ex.text,
              ex.translation ?? null,
              ex.context ?? null,
              domainSourceToDb(ex.source),
              ex.originConversationId ?? null,
              ex.originTurnId ?? null,
              ex.createdAt ?? now,
            ],
          });
        }
      }
    }

    await this.adapter.transaction(steps);
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

  async getByExpression(
    learnerId: string,
    expression: string,
    type: ExpressionItem['type'],
  ): Promise<ExpressionItem | null> {
    if (!isValidUuid(learnerId) || !expression || !type) return null;
    const rows = await this.adapter.query(
      `SELECT * FROM lexical_items WHERE learner_id = ? AND headword = ? AND type = ? LIMIT 1`,
      [learnerId, expression, type],
    );
    if (rows.length === 0) return null;
    return this.get(rows[0].id as string);
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
    const steps: { sql: string; params: SqlParam[] }[] = [];

    steps.push({
      sql: `UPDATE lexical_items SET
        headword = COALESCE(?, headword),
        natural_alternatives = COALESCE(?, natural_alternatives),
        register = COALESCE(?, register),
        domain = COALESCE(?, domain),
        updated_at = ?
      WHERE id = ?`,
      params: [
        patch.expression ?? null,
        patch.naturalAlternatives ? JSON.stringify(patch.naturalAlternatives) : null,
        patch.register ?? null,
        patch.domain ?? null,
        now,
        id,
      ],
    });

    if (patch.meanings !== undefined) {
      steps.push({ sql: `DELETE FROM lexical_examples WHERE lexical_item_id = ?`, params: [id] });
      steps.push({ sql: `DELETE FROM lexical_meanings WHERE lexical_item_id = ?`, params: [id] });

      for (const meaning of patch.meanings) {
        const meaningId = generateId();
        steps.push({
          sql: `INSERT INTO lexical_meanings (
            id, lexical_item_id, definition, part_of_speech, examples,
            usage_notes, register, domain,
            review_state, review_last_review_at, review_next_review_at,
            review_review_count, review_consecutive_correct, review_ease_factor,
            review_mastered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
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
            (meaning.review as any)?.masteredAt ?? null,
            now,
            now,
          ],
        });

        for (const ex of meaning.examples ?? []) {
          const exId = generateId();
          steps.push({
            sql: `INSERT INTO lexical_examples (
              id, lexical_item_id, meaning_id, text, translation, context,
              source, origin_conversation_id, origin_turn_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              exId,
              id,
              meaningId,
              ex.text,
              ex.translation ?? null,
              ex.context ?? null,
              domainSourceToDb(ex.source),
              ex.originConversationId ?? null,
              ex.originTurnId ?? null,
              ex.createdAt ?? now,
            ],
          });
        }
      }
    }

    await this.adapter.transaction(steps);
    return this.getFullItem(id);
  }

  async delete(id: string): Promise<boolean> {
    return deleteLexicalItemCompletely(this.adapter, id);
  }

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
    const rows = await this.adapter.query(`SELECT * FROM review_items WHERE id = ?`, [id]);
    return rows.length > 0 ? rowToReviewItem(rows[0]) : null;
  }

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
    if (!item.learnerId || !isValidUuid(item.learnerId)) throw new Error('Invalid learnerId');
    if (!item.prompt) throw new Error('prompt is required');
    const now = nowIso();

    let existingId: string | null = null;
    if (item.id) {
      const byId = await this.adapter.query(`SELECT id FROM review_items WHERE id = ?`, [item.id]);
      if (byId.length > 0) existingId = byId[0].id as string;
    }
    if (!existingId && item.referenceId) {
      const existing = await this.adapter.query(
        `SELECT id FROM review_items WHERE learner_id = ? AND reference_id = ? AND kind = ?`,
        [item.learnerId, item.referenceId, item.kind],
      );
      if (existing.length > 0) existingId = existing[0].id as string;
    }

    if (existingId) {
      try {
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
      } catch (err) {
        if (isUniqueViolation(err)) {
          const reloaded = await this.adapter.query(`SELECT id FROM review_items WHERE learner_id = ? AND reference_id = ? AND kind = ?`, [item.learnerId, item.referenceId, item.kind]);
          if (reloaded.length > 0) existingId = reloaded[0].id as string;
        } else {
          throw err;
        }
      }
      const updated = await this.get(existingId);
      if (!updated) throw new Error('Failed to retrieve updated review item');
      return updated;
    }

    const id = item.id || generateId();
    try {
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
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.adapter.query(
          `SELECT id FROM review_items WHERE learner_id = ? AND kind = ? AND reference_id = ?`,
          [item.learnerId, item.kind, item.referenceId],
        );
        if (raced.length > 0) {
          const racedId = raced[0].id as string;
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
              racedId,
            ],
          );
          const updated = await this.get(racedId);
          if (!updated) throw new Error('Failed to retrieve raced review item');
          return updated;
        }
      }
      throw err;
    }

    const created = await this.get(id);
    if (!created) throw new Error('Failed to retrieve created review item');
    return created;
  }

  async markReviewed(
    id: string,
    result: 'correct' | 'incorrect' | 'partial',
    note?: string,
    attemptId?: string,
  ): Promise<ReviewItem> {
    if (!isValidUuid(id)) throw new Error('Invalid review item id');

    const historyId = attemptId ?? generateId();
    const now = nowIso();

    // Idempotency: if attemptId provided and already exists, return current item
    if (attemptId) {
      const existingHistory = await this.adapter.query(
        `SELECT id FROM review_history WHERE id = ?`,
        [attemptId],
      );
      if (existingHistory.length > 0) {
        const current = await this.get(id);
        if (!current) throw new Error(`Review item not found: ${id}`);
        return current;
      }
    }

    // Use explicit BEGIN IMMEDIATE to prevent lost updates between two repo instances
    await this.adapter.execute(`BEGIN IMMEDIATE`);
    try {
      const rows = await this.adapter.query(`SELECT * FROM review_items WHERE id = ?`, [id]);
      if (rows.length === 0) {
        await this.adapter.execute(`ROLLBACK`);
        throw new Error(`Review item not found: ${id}`);
      }

      const existing = rowToReviewItem(rows[0]);

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

      let newState: MasteryState = existing.state;
      if (newConsecutiveCorrect >= 3) {
        newState = 'mastered';
      } else if (result === 'incorrect') {
        newState = existing.reviewCount >= 1 ? 'struggling' : 'learning';
      } else if (result === 'correct') {
        newState = newConsecutiveCorrect >= 2 ? 'familiar' : 'learning';
      }

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

      // Atomic update + history insert
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

      await this.adapter.execute(
        `INSERT INTO review_history (id, review_item_id, at, result, note)
         VALUES (?, ?, ?, ?, ?)`,
        [historyId, id, now, result, note ?? null],
      );

      await this.adapter.execute(`COMMIT`);
    } catch (err) {
      try {
        await this.adapter.execute(`ROLLBACK`);
      } catch {
        // ignore
      }

      // If rollback due to unique violation on history id, treat as idempotent success
      if (attemptId && isUniqueViolation(err)) {
        const current = await this.get(id);
        if (current) return current;
      }

      throw err;
    }

    const updated = await this.get(id);
    if (!updated) throw new Error('Review item disappeared after update');
    return updated;
  }

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

  async countDue(learnerId: string, now: string): Promise<number> {
    if (!isValidUuid(learnerId)) return 0;
    const rows = await this.adapter.query(
      `SELECT COUNT(*) AS c FROM review_items WHERE learner_id = ? AND due_at <= ?`,
      [learnerId, now],
    );
    return Number(rows[0]?.c ?? 0);
  }

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

export class SQLiteProgressRepository implements ProgressRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async record(
    record: Omit<ProgressRecord, 'id'>,
  ): Promise<ProgressRecord> {
    if (!record.learnerId || !isValidUuid(record.learnerId)) throw new Error('Invalid learnerId');
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
    const rows = await this.adapter.query(`SELECT * FROM progress_records WHERE id = ?`, [id]);
    if (rows.length === 0) throw new Error('Failed to retrieve recorded progress');
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

const DAILY_SESSION_STATUSES: ReadonlySet<string> = new Set([
  'planned',
  'in_progress',
  'completed',
  'abandoned',
]);

const DAILY_ACTIVITY_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
  'skipped',
]);

function rowToDailySessionRecord(
  row: SqlRow,
  activities: readonly DailyTutorActivityRecord[],
): DailyTutorSessionRecord {
  return {
    id: row.id as string,
    learnerId: row.learner_id as string,
    dateKey: row.date_key as string,
    status: row.status as DailySessionStatus,
    headline: row.headline as string,
    sourceMode: row.source_mode as DailyTutorSessionRecord['sourceMode'],
    estimatedMinutes: Number(row.estimated_minutes ?? 0),
    activities,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

function rowToDailyActivityRecord(row: SqlRow): DailyTutorActivityRecord {
  return {
    id: row.id as string,
    orderIndex: Number(row.order_index ?? 0),
    kind: row.kind as DailyActivityKind,
    title: row.title as string,
    reason: row.reason as string,
    estimatedMinutes: Number(row.estimated_minutes ?? 0),
    target: safeJsonParse<Record<string, unknown>>(row.target, {}),
    status: row.status as DailyActivityStatus,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    practicedItems:
      row.practiced_items === null || row.practiced_items === undefined
        ? null
        : Number(row.practiced_items),
  };
}

function assertValidDailySessionInput(
  session: Omit<DailyTutorSessionRecord, 'activities'>,
): void {
  if (!session.learnerId || !isValidUuid(session.learnerId)) throw new Error('Invalid learnerId');
  if (!isValidDateKey(session.dateKey)) throw new Error('Invalid dateKey (expected YYYY-MM-DD)');
  if (!session.id) throw new Error('id is required');
  if (!DAILY_SESSION_STATUSES.has(session.status)) throw new Error(`Invalid daily tutor session status: ${String(session.status)}`);
  if (session.sourceMode !== 'personalized' && session.sourceMode !== 'mixed' && session.sourceMode !== 'general') {
    throw new Error(`Invalid daily tutor source mode: ${String(session.sourceMode)}`);
  }
  if (typeof session.headline !== 'string') throw new Error('headline is required');
}

function assertValidDailyActivitiesInput(
  activities: readonly Omit<DailyTutorActivityRecord, 'orderIndex'>[],
): void {
  if (!Array.isArray(activities) || activities.length === 0) {
    throw new Error('A daily tutor session requires at least one activity');
  }
  const ids = new Set<string>();
  for (const activity of activities) {
    if (!activity.id || ids.has(activity.id)) throw new Error('Activity ids must be non-empty and unique');
    ids.add(activity.id);
    if (!DAILY_ACTIVITY_KINDS.includes(activity.kind)) throw new Error(`Invalid daily tutor activity kind: ${String(activity.kind)}`);
    if (!DAILY_ACTIVITY_STATUSES.has(activity.status)) throw new Error(`Invalid daily tutor activity status: ${String(activity.status)}`);
    if (typeof activity.title !== 'string' || typeof activity.reason !== 'string') throw new Error('Activity title and reason are required');
  }
}

export class SQLiteDailyTutorRepository implements DailyTutorRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async getSessionForDate(
    learnerId: string,
    dateKey: string,
  ): Promise<DailyTutorSessionRecord | null> {
    if (!isValidUuid(learnerId) || !isValidDateKey(dateKey)) return null;
    const rows = await this.adapter.query(
      `SELECT * FROM daily_tutor_sessions WHERE learner_id = ? AND date_key = ?`,
      [learnerId, dateKey],
    );
    if (rows.length === 0) return null;
    return this.loadRecord(rows[0].id as string);
  }

  async getSession(id: string): Promise<DailyTutorSessionRecord | null> {
    if (!id) return null;
    return this.loadRecord(id);
  }

  async listRecentSessions(
    learnerId: string,
    limit?: number,
  ): Promise<readonly DailyTutorSessionRecord[]> {
    if (!isValidUuid(learnerId)) return [];
    let sql = `SELECT id, date_key FROM daily_tutor_sessions WHERE learner_id = ? ORDER BY date_key DESC`;
    const params: SqlParam[] = [learnerId];
    if (limit !== undefined && limit > 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }
    const rows = await this.adapter.query(sql, params);
    const records: DailyTutorSessionRecord[] = [];
    for (const row of rows) {
      const record = await this.loadRecord(row.id as string);
      if (record) records.push(record);
    }
    return records;
  }

  async insertSession(input: CreateDailyTutorSessionInput): Promise<DailyTutorSessionRecord | null> {
    assertValidDailySessionInput(input.session);
    assertValidDailyActivitiesInput(input.activities);

    const existing = await this.adapter.query(
      `SELECT id FROM daily_tutor_sessions WHERE learner_id = ? AND date_key = ?`,
      [input.session.learnerId, input.session.dateKey],
    );
    if (existing.length > 0) return null;

    const now = nowIso();
    const steps: { sql: string; params: SqlParam[] }[] = [
      {
        sql: `INSERT INTO daily_tutor_sessions (
          id, learner_id, date_key, status, headline, source_mode,
          estimated_minutes, created_at, started_at, completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.session.id,
          input.session.learnerId,
          input.session.dateKey,
          input.session.status,
          input.session.headline,
          input.session.sourceMode,
          input.session.estimatedMinutes ?? 0,
          now,
          input.session.startedAt ?? null,
          input.session.completedAt ?? null,
          now,
        ],
      },
    ];
    input.activities.forEach((activity, index) => {
      steps.push({
        sql: `INSERT INTO daily_tutor_activities (
          id, session_id, order_index, kind, title, reason,
          estimated_minutes, target, status, started_at, completed_at,
          practiced_items, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          activity.id,
          input.session.id,
          index,
          activity.kind,
          activity.title,
          activity.reason,
          activity.estimatedMinutes ?? 0,
          JSON.stringify(activity.target ?? {}),
          activity.status,
          activity.startedAt ?? null,
          activity.completedAt ?? null,
          activity.practicedItems ?? null,
          now,
          now,
        ],
      });
    });

    try {
      await this.adapter.transaction(steps);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.adapter.query(
          `SELECT id FROM daily_tutor_sessions WHERE learner_id = ? AND date_key = ?`,
          [input.session.learnerId, input.session.dateKey],
        );
        if (raced.length > 0) return null;
      }
      throw error;
    }

    const stored = await this.getSession(input.session.id);
    if (!stored) throw new Error('Failed to persist daily tutor session');
    return stored;
  }

  async updateSession(id: string, patch: DailyTutorSessionPatch): Promise<DailyTutorSessionRecord> {
    if (!id) throw new Error('Invalid session id');
    if (patch.status !== undefined && !DAILY_SESSION_STATUSES.has(patch.status)) {
      throw new Error(`Invalid daily tutor session status: ${String(patch.status)}`);
    }
    const existing = await this.getSession(id);
    if (!existing) throw new Error(`Daily tutor session not found: ${id}`);

    const fields: string[] = [];
    const params: SqlParam[] = [];
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.startedAt !== undefined) {
      fields.push('started_at = ?');
      params.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      fields.push('completed_at = ?');
      params.push(patch.completedAt);
    }
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      params.push(nowIso());
      params.push(id);
      await this.adapter.execute(
        `UPDATE daily_tutor_sessions SET ${fields.join(', ')} WHERE id = ?`,
        params,
      );
    }

    const updated = await this.getSession(id);
    if (!updated) throw new Error('Daily tutor session disappeared after update');
    return updated;
  }

  async updateActivity(
    sessionId: string,
    activityId: string,
    patch: DailyTutorActivityPatch,
  ): Promise<DailyTutorSessionRecord> {
    if (!sessionId || !activityId) throw new Error('Invalid session or activity id');
    if (patch.status !== undefined && !DAILY_ACTIVITY_STATUSES.has(patch.status)) {
      throw new Error(`Invalid daily tutor activity status: ${String(patch.status)}`);
    }
    const existing = await this.getSession(sessionId);
    if (!existing) throw new Error(`Daily tutor session not found: ${sessionId}`);
    if (!existing.activities.some((a) => a.id === activityId)) throw new Error(`Daily tutor activity not found: ${activityId}`);

    const fields: string[] = [];
    const params: SqlParam[] = [];
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.startedAt !== undefined) {
      fields.push('started_at = ?');
      params.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      fields.push('completed_at = ?');
      params.push(patch.completedAt);
    }
    if (patch.practicedItems !== undefined) {
      fields.push('practiced_items = ?');
      params.push(patch.practicedItems);
    }
    if (fields.length > 0) {
      fields.push('updated_at = ?');
      params.push(nowIso());
      params.push(activityId);
      await this.adapter.execute(
        `UPDATE daily_tutor_activities SET ${fields.join(', ')} WHERE id = ?`,
        params,
      );
    }

    const updated = await this.getSession(sessionId);
    if (!updated) throw new Error('Daily tutor session disappeared after activity update');
    return updated;
  }

  async deleteSession(id: string): Promise<boolean> {
    if (!id) return false;
    const existing = await this.adapter.query(`SELECT id FROM daily_tutor_sessions WHERE id = ?`, [id]);
    if (existing.length === 0) return false;
    await this.adapter.transaction([
      { sql: `DELETE FROM daily_tutor_activities WHERE session_id = ?`, params: [id] },
      { sql: `DELETE FROM daily_tutor_sessions WHERE id = ?`, params: [id] },
    ]);
    return true;
  }

  private async loadRecord(id: string): Promise<DailyTutorSessionRecord | null> {
    const rows = await this.adapter.query(`SELECT * FROM daily_tutor_sessions WHERE id = ?`, [id]);
    if (rows.length === 0) return null;
    const activityRows = await this.adapter.query(
      `SELECT * FROM daily_tutor_activities WHERE session_id = ? ORDER BY order_index ASC`,
      [id],
    );
    return rowToDailySessionRecord(
      rows[0],
      activityRows.map(rowToDailyActivityRecord),
    );
  }
}
