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
import type { EvidenceRef, WeaknessStatus } from '../domain/shared/types';
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

export interface ConversationRepository {
  createSession(
    session: Omit<ConversationSession, 'id' | 'createdAt' | 'updatedAt'>,
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

export interface PronunciationRepository {
  recordWeakness(
    weakness: Omit<PronunciationWeakness, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PronunciationWeakness>;
  listWeaknesses(learnerId: string, opts?: { resolved?: boolean; limit?: number }): Promise<readonly PronunciationWeakness[]>;
  markResolved(id: string, resolved: boolean): Promise<PronunciationWeakness>;
}

export interface WeaknessRepository {
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