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
import type { EvidenceRef } from '../domain/shared/types';
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
}

export interface VocabularyRepository {
  upsert(item: Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<VocabularyItem>;
  get(id: string): Promise<VocabularyItem | null>;
  list(learnerId: string, opts?: { state?: string; limit?: number }): Promise<readonly VocabularyItem[]>;
  listDue(learnerId: string, now: string, limit?: number): Promise<readonly VocabularyItem[]>;
  update(id: string, patch: Partial<Omit<VocabularyItem, 'id' | 'createdAt'>>): Promise<VocabularyItem>;
  /**
   * Permanently remove a vocabulary item and all of its meanings/examples.
   * Optional: backends that do not support deletion may omit it.
   * Returns true when a row was deleted, false when the item did not exist.
   */
  delete?(id: string): Promise<boolean>;
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