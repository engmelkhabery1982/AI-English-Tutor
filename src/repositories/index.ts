/**
 * src/repositories/index.ts
 *
 * Repository interfaces.
 *
 * Repositories abstract persistence. The MVP will use SQLite;
 * the interfaces are persistence-agnostic so the app can later
 * swap in an in-memory store, a different DB, or a remote source.
 */

import type {
  ConversationSession,
  ConversationTurn,
} from '../domain/models/conversation';
import type {
  GrammarMistake,
  LearnerStrength,
  LearnerWeakness,
  PronunciationWeakness,
  UserProfile,
} from '../domain/models/learner';
import type { EvidenceRef, IsoDate, Uuid, WeaknessStatus } from '../domain/shared/types';
import type {
  ExpressionItem,
  VocabularyItem,
} from '../domain/models/vocabulary';
import type {
  Exercise,
  Lesson,
  ProgressRecord,
  ReviewItem,
} from '../domain/models/learning';
import type { PronunciationEvidenceSource, QualitativeConfidence } from '../pronunciation/types';
import type {
  DailyActivityKind,
  DailyActivityStatus,
  DailySessionStatus,
  DailyTutorActivityTarget,
  DailyTutorDateKey,
  DailyTutorSourceMode,
} from '../daily-tutor/types';

/** Exact activity aggregates over a learner's persisted conversation sessions. */
export interface ConversationActivityStats {
  readonly sessionsTotal: number;
  readonly sessionsCompleted: number;
  readonly turnsTotal: number;
}

/** Exact lexical review-bucket counts (authoritative meaning.review semantics). */
export interface LexicalBucketCounts {
  readonly total: number;
  readonly due: number;
  readonly learning: number;
  readonly familiar: number;
  readonly mastered: number;
}

/** Exact unresolved-weakness status distribution. */
export interface WeaknessStatusCounts {
  readonly unresolved: number;
  readonly byStatus: Readonly<Partial<Record<WeaknessStatus, number>>>;
}

export interface UserProfileRepository {
  get(): Promise<UserProfile>;
  update(profile: Partial<Omit<UserProfile, 'id' | 'createdAt'>>): Promise<UserProfile>;
}

/**
 * One turn of a conversation being persisted atomically (Conversation Memory).
 * Turn identity stays the existing (session_id, sequence_number) pair.
 */
export interface PersistConversationTurnInput {
  readonly speaker: ConversationTurn['speaker'];
  readonly text: string;
  readonly turnIndex: number;
  readonly startedAt: IsoDate;
  readonly endedAt?: IsoDate;
  readonly confidence?: number;
  readonly detectedLanguage?: string;
  readonly metadata?: Record<string, unknown>;
}

/** A complete conversation written in ONE atomic step. */
export interface PersistConversationInput {
  /**
   * Session to write. When `id` is provided it is used as the domain identity
   * (callers derive it deterministically so a retry can never create a second
   * session for the same conversation).
   */
  readonly session: Omit<ConversationSession, 'createdAt' | 'updatedAt'>;
  readonly turns: readonly PersistConversationTurnInput[];
}

export interface ConversationRepository {
  /**
   * Create a conversation session. An explicit `id` may be supplied so the
   * caller can use a deterministic domain identity (retry-safe persistence).
   */
  createSession(
    session: Omit<ConversationSession, 'id' | 'createdAt' | 'updatedAt'> & {
      readonly id?: string;
    },
  ): Promise<ConversationSession>;
  getSession(id: string): Promise<ConversationSession | null>;
  listSessions(learnerId: string, limit?: number): Promise<readonly ConversationSession[]>;
  addTurn(turn: Omit<ConversationTurn, 'id'>): Promise<ConversationTurn>;
  listTurns(sessionId: string): Promise<readonly ConversationTurn[]>;
  updateSession(
    id: string,
    patch: Partial<Omit<ConversationSession, 'id' | 'createdAt'>>,
  ): Promise<ConversationSession>;
  /**
   * Persist a COMPLETE conversation (session + all turns) atomically: either
   * everything is stored or nothing is. Optional — backends that cannot offer
   * atomicity may omit it, and callers fall back to their retry-safe sequential
   * path.
   */
  persistConversation?(input: PersistConversationInput): Promise<ConversationSession>;
  /**
   * Exact aggregate counts over persisted sessions (optionally bounded to a
   * start-time range). Read-only; optional — backends may omit it.
   */
  getActivityStats?(
    learnerId: string,
    opts?: { startedAfter?: string; startedUntil?: string },
  ): Promise<ConversationActivityStats>;
}

export interface MistakeRepository {
  recordMistake(mistake: Omit<GrammarMistake, 'id' | 'createdAt' | 'updatedAt'>): Promise<GrammarMistake>;
  listMistakes(learnerId: string, opts?: { resolved?: boolean; limit?: number }): Promise<readonly GrammarMistake[]>;
  markResolved(id: string, resolved: boolean): Promise<GrammarMistake>;
  updateMistake(id: string, patch: Partial<Omit<GrammarMistake, 'id' | 'createdAt'>>): Promise<GrammarMistake>;
}

/** Input for recording one deduplicated pronunciation observation. */
export interface PronunciationObservationInput {
  readonly learnerId: Uuid;
  /**
   * Stable issue identity used for deduplication, e.g.
   * "word_pronunciation:comfortable" or "ending:worked-ed".
   * Repeated observations increase occurrence data instead of
   * creating duplicate rows.
   */
  readonly identity: string;
  /** Human-readable practice target, e.g. the word itself. */
  readonly target: string;
  /** Observed transcript snippet for this occurrence, when available. */
  readonly exampleText?: string;
  /** Extra context tags for this occurrence (e.g. "lexical:<id>"). */
  readonly context?: string;
  /** Evidence source of this observation (persisted with the row). */
  readonly evidenceSource: PronunciationEvidenceSource;
  /** Qualitative confidence of this observation, when the provider gives one. */
  readonly confidence?: QualitativeConfidence;
  readonly at: IsoDate;
}

/** Result of recording one pronunciation observation. */
export interface PronunciationObservationRecord {
  readonly weakness: PronunciationWeakness;
  /** True when this call created the weakness row (first observation). */
  readonly created: boolean;
}

export interface PronunciationRepository {
  recordWeakness(
    weakness: Omit<PronunciationWeakness, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PronunciationWeakness>;
  listWeaknesses(learnerId: string, opts?: { resolved?: boolean; limit?: number }): Promise<readonly PronunciationWeakness[]>;
  markResolved(id: string, resolved: boolean): Promise<PronunciationWeakness>;
  /**
   * Record one pronunciation observation under a stable identity
   * (issue type + normalized target). First call creates the row;
   * repeated calls increment occurrence data instead of duplicating it.
   * Read/write helper over the same pronunciation_weaknesses table;
   * optional — backends may omit it.
   */
  recordObservation?(input: PronunciationObservationInput): Promise<PronunciationObservationRecord>;
}

export interface WeaknessRepository {
  /**
   * Exact lookup by (learnerId, type, referenceId) — never a capped scan.
   * Optional: backends may omit it, but the pronunciation engine requires
   * an exact implementation to preserve lifecycle state safely.
   */
  getWeaknessByReference?(
    learnerId: string,
    type: LearnerWeakness['type'],
    referenceId: string,
  ): Promise<LearnerWeakness | null>;

  listWeaknesses(learnerId: string, limit?: number): Promise<readonly LearnerWeakness[]>;
  listStrengths(learnerId: string, limit?: number): Promise<readonly LearnerStrength[]>;
  upsertWeakness(weakness: Omit<LearnerWeakness, 'id' | 'createdAt' | 'updatedAt'>): Promise<LearnerWeakness>;
  upsertStrength(strength: Omit<LearnerStrength, 'id' | 'createdAt' | 'updatedAt'>): Promise<LearnerStrength>;
  addWeaknessEvidence(evidence: Omit<EvidenceRef, 'kind'> & { weaknessId: string; kind: EvidenceRef['kind'] }): Promise<void>;
  /**
   * Exact unresolved-weakness counts grouped by persisted lifecycle state.
   * Read-only; optional — backends may omit it.
   */
  getUnresolvedStatusCounts?(learnerId: string): Promise<WeaknessStatusCounts>;
  /** Exact count of unresolved weaknesses first seen in an optional range. */
  countUnresolved?(
    learnerId: string,
    opts?: { firstSeenAfter?: string; firstSeenUntil?: string },
  ): Promise<number>;
  /** Exact count of persisted weakness-evidence rows in an optional range. */
  countEvidence?(
    learnerId: string,
    opts?: { atAfter?: string; atUntil?: string },
  ): Promise<number>;
}

export interface VocabularyRepository {
  upsert(item: Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<VocabularyItem>;
  get(id: string): Promise<VocabularyItem | null>;
  list(learnerId: string, opts?: { state?: string; limit?: number; types?: readonly VocabularyItem['type'][] }): Promise<readonly VocabularyItem[]>;
  listDue(learnerId: string, now: string, limit?: number): Promise<readonly VocabularyItem[]>;
  update(id: string, patch: Partial<Omit<VocabularyItem, 'id' | 'createdAt'>>): Promise<VocabularyItem>;
  /**
   * Permanently remove a vocabulary item and all of its meanings/examples.
   * Optional: backends that do not support deletion may omit it.
   * Returns true when a row was deleted, false when the item did not exist.
   */
  delete?(id: string): Promise<boolean>;
  /**
   * Exact review-bucket counts (authoritative meaning.review semantics)
   * without loading items. Read-only; optional — backends may omit it.
   */
  getBucketCounts?(
    learnerId: string,
    opts: { now: string; types?: readonly VocabularyItem['type'][] },
  ): Promise<LexicalBucketCounts>;
  /** Exact count of items created in an optional range (optionally by type). */
  countCreated?(
    learnerId: string,
    opts?: { createdAfter?: string; createdUntil?: string; types?: readonly VocabularyItem['type'][] },
  ): Promise<number>;
}

export interface ExpressionRepository {
  upsert(item: Omit<ExpressionItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<ExpressionItem>;
  get(id: string): Promise<ExpressionItem | null>;
  list(learnerId: string, opts?: { limit?: number }): Promise<readonly ExpressionItem[]>;
  listDue(learnerId: string, now: string, limit?: number): Promise<readonly ExpressionItem[]>;
  update(id: string, patch: Partial<Omit<ExpressionItem, 'id' | 'createdAt'>>): Promise<ExpressionItem>;
  /**
   * Permanently remove an expression item and all of its meanings/examples.
   * Optional: backends that do not support deletion may omit it.
   * Returns true when a row was deleted, false when the item did not exist.
   */
  delete?(id: string): Promise<boolean>;
  /**
   * Exact review-bucket counts for expression rows (authoritative
   * meaning.review semantics) without loading items. Read-only; optional.
   */
  getBucketCounts?(learnerId: string, opts: { now: string }): Promise<LexicalBucketCounts>;
  /** Exact count of expression items created in an optional range. */
  countCreated?(
    learnerId: string,
    opts?: { createdAfter?: string; createdUntil?: string },
  ): Promise<number>;
}

export interface ReviewRepository {
  listDue(learnerId: string, now: string, limit?: number): Promise<readonly ReviewItem[]>;
  /**
   * Exact existence lookup by (learnerId, kind, referenceId) — including
   * items scheduled for the FUTURE (which listDue cannot see) and items
   * already RETIRED (whose review history must never be silently reset by
   * a "create initial item" path). Optional: backends may omit it.
   */
  getByReference?(
    learnerId: string,
    kind: ReviewItem['kind'],
    referenceId: string,
  ): Promise<ReviewItem | null>;
  markReviewed(
    id: string,
    result: 'correct' | 'incorrect' | 'partial',
    feedback?: string,
  ): Promise<ReviewItem>;
  upsert?(
    item: Omit<ReviewItem, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ReviewItem>;
  /**
   * List review items for a learner, due-first. Read helper for
   * dashboards; optional — backends may omit it.
   */
  list?(learnerId: string, limit?: number): Promise<readonly ReviewItem[]>;
  /** Exact count of reviews due at `now`. Read-only; optional. */
  countDue?(learnerId: string, now: string): Promise<number>;
  /** Exact count of reviews completed in an optional last-review range. */
  countReviewed?(
    learnerId: string,
    opts?: { lastReviewAfter?: string; lastReviewUntil?: string },
  ): Promise<number>;
  /**
   * Delete review rows that point at a given domain object, restricted to
   * one item kind. Used e.g. when removing a vocabulary item: its pending
   * 'vocabulary' review rows must not linger and resurface in Review,
   * while 'grammar'/'expression'/other reviews remain untouched.
   * Optional: backends that do not support deletion may omit it.
   * Returns the number of review rows removed.
   */
  deleteByReference?(referenceId: string, kind: ReviewItem['kind']): Promise<number>;
}

export interface LessonRepository {
  get(id: string): Promise<Lesson | null>;
  list(opts?: { targetLevel?: string }): Promise<readonly Lesson[]>;
}

export interface ExerciseRepository {
  get(id: string): Promise<Exercise | null>;
  list(opts?: { type?: Exercise['type'] }): Promise<readonly Exercise[]>;
}

export interface ProgressRepository {
  record(record: Omit<ProgressRecord, 'id'>): Promise<ProgressRecord>;
  list(learnerId: string, limit?: number): Promise<readonly ProgressRecord[]>;
  latest(learnerId: string): Promise<ProgressRecord | null>;
  /** Exact count of persisted progress records in an optional range. */
  countRecords?(
    learnerId: string,
    opts?: { recordedAfter?: string; recordedUntil?: string },
  ): Promise<number>;
}

/* ------------------------------------------------------------------ *
 * Daily Tutor (additive persistence for the Daily Tutor Loop)
 *
 * Deliberately a STANDALONE repository interface (not part of the
 * AppRepositories facade): existing composition factories stay unchanged,
 * and the Daily Tutor owns the only write path to these tables.
 * ------------------------------------------------------------------ */

/** ONE persisted daily-tutor activity row (order via `orderIndex`). */
export interface DailyTutorActivityRecord {
  readonly id: string;
  readonly orderIndex: number;
  readonly kind: DailyActivityKind;
  readonly title: string;
  readonly reason: string;
  readonly estimatedMinutes: number;
  /** Serializable routing context (see daily-tutor/types). */
  readonly target: DailyTutorActivityTarget;
  readonly status: DailyActivityStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Real item count reported by the child workflow at completion, if any. */
  readonly practicedItems: number | null;
}

/** ONE persisted daily-tutor session with its ordered activities. */
export interface DailyTutorSessionRecord {
  readonly id: string;
  readonly learnerId: string;
  readonly dateKey: DailyTutorDateKey;
  readonly status: DailySessionStatus;
  readonly headline: string;
  readonly sourceMode: DailyTutorSourceMode;
  readonly estimatedMinutes: number;
  readonly activities: readonly DailyTutorActivityRecord[];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** A session to persist: the session row plus activities in plan order. */
export interface CreateDailyTutorSessionInput {
  readonly session: Omit<DailyTutorSessionRecord, 'activities'>;
  readonly activities: readonly Omit<DailyTutorActivityRecord, 'orderIndex'>[];
}

/** Patchable session execution fields. */
export interface DailyTutorSessionPatch {
  readonly status?: DailySessionStatus;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

/** Patchable activity execution fields. */
export interface DailyTutorActivityPatch {
  readonly status?: DailyActivityStatus;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly practicedItems?: number | null;
}

export interface DailyTutorRepository {
  /** Today's (or any date's) session for a learner, or null. */
  getSessionForDate(
    learnerId: string,
    dateKey: DailyTutorDateKey,
  ): Promise<DailyTutorSessionRecord | null>;
  getSession(id: string): Promise<DailyTutorSessionRecord | null>;
  /** Recent sessions, newest dateKey first (bounded). */
  listRecentSessions(learnerId: string, limit?: number): Promise<readonly DailyTutorSessionRecord[]>;
  /**
   * Insert a new session for (learnerId, dateKey). Returns null when a
   * session already exists for that learner/date — the caller then loads the
   * existing one. This is the unique-learner/date invariant that makes
   * concurrent "create today" calls safe.
   */
  insertSession(input: CreateDailyTutorSessionInput): Promise<DailyTutorSessionRecord | null>;
  /** Update execution fields; returns the updated session. */
  updateSession(id: string, patch: DailyTutorSessionPatch): Promise<DailyTutorSessionRecord>;
  /** Update ONE activity's execution fields; returns the updated session. */
  updateActivity(
    sessionId: string,
    activityId: string,
    patch: DailyTutorActivityPatch,
  ): Promise<DailyTutorSessionRecord>;
  /** Delete a session and its activities (corrupt-state recovery). */
  deleteSession(id: string): Promise<boolean>;
}

/** Aggregated repository facade used by engines/UI. */
export interface AppRepositories {
  readonly profile: UserProfileRepository;
  readonly conversations: ConversationRepository;
  readonly mistakes: MistakeRepository;
  readonly pronunciation: PronunciationRepository;
  readonly weaknesses: WeaknessRepository;
  readonly vocabulary: VocabularyRepository;
  readonly expressions: ExpressionRepository;
  readonly review: ReviewRepository;
  readonly lessons: LessonRepository;
  readonly exercises: ExerciseRepository;
  readonly progress: ProgressRepository;
}