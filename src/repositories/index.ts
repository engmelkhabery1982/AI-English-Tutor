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
}

export interface VocabularyRepository {
  upsert(item: Omit<VocabularyItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<VocabularyItem>;
  get(id: string): Promise<VocabularyItem | null>;
  list(learnerId: string, opts?: { state?: string; limit?: number }): Promise<readonly VocabularyItem[]>;
  listDue(learnerId: string, now: string, limit?: number): Promise<readonly VocabularyItem[]>;
  update(id: string, patch: Partial<Omit<VocabularyItem, 'id' | 'createdAt'>>): Promise<VocabularyItem>;
}

export interface ExpressionRepository {
  upsert(item: Omit<ExpressionItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<ExpressionItem>;
  get(id: string): Promise<ExpressionItem | null>;
  list(learnerId: string, opts?: { limit?: number }): Promise<readonly ExpressionItem[]>;
  listDue(learnerId: string, now: string, limit?: number): Promise<readonly ExpressionItem[]>;
  update(id: string, patch: Partial<Omit<ExpressionItem, 'id' | 'createdAt'>>): Promise<ExpressionItem>;
}

export interface ReviewRepository {
  listDue(learnerId: string, now: string, limit?: number): Promise<readonly ReviewItem[]>;
  markReviewed(id: string, result: 'correct' | 'incorrect' | 'partial'): Promise<ReviewItem>;
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