/**
 * src/learner-model/index.test.ts
 *
 * Unit tests for the read-only LearnerModel facade using mock AppRepositories.
 */

import { describe, it, expect, vi } from 'vitest';
import { createLearnerModel } from './index';
import type { AppRepositories } from '../repositories';
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
  ProgressRecord,
  ReviewItem,
} from '../domain/models/learning';

function createMockRepositories(overrides: Partial<AppRepositories> = {}): AppRepositories {
  const dummyProfile: UserProfile = {
    id: 'learner-123',
    displayName: 'Test Learner',
    targetLanguage: 'en',
    targetLevel: 'B2',
    currentLevel: 'B1',
    learningGoals: ['fluency'],
    preferredModes: ['natural'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const defaultRepos: AppRepositories = {
    profile: {
      get: vi.fn().mockResolvedValue(dummyProfile),
      update: vi.fn(),
    },
    conversations: {
      createSession: vi.fn(),
      getSession: vi.fn(),
      listSessions: vi.fn(),
      addTurn: vi.fn(),
      listTurns: vi.fn(),
      updateSession: vi.fn(),
    },
    mistakes: {
      recordMistake: vi.fn(),
      listMistakes: vi.fn().mockResolvedValue([]),
      markResolved: vi.fn(),
    },
    pronunciation: {
      recordWeakness: vi.fn(),
      listWeaknesses: vi.fn().mockResolvedValue([]),
      markResolved: vi.fn(),
    },
    weaknesses: {
      listWeaknesses: vi.fn().mockResolvedValue([]),
      listStrengths: vi.fn().mockResolvedValue([]),
      upsertWeakness: vi.fn(),
      upsertStrength: vi.fn(),
      addWeaknessEvidence: vi.fn(),
    },
    vocabulary: {
      upsert: vi.fn(),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listDue: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    expressions: {
      upsert: vi.fn(),
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      listDue: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    review: {
      listDue: vi.fn().mockResolvedValue([]),
      markReviewed: vi.fn(),
    },
    lessons: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    },
    exercises: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
    },
    progress: {
      record: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      latest: vi.fn().mockResolvedValue(null),
    },
  };

  return {
    ...defaultRepos,
    ...overrides,
  };
}

describe('LearnerModel facade', () => {
  it('1. refresh loads profile', async () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);

    expect(model.profile.id).toBe('');
    await model.refresh();
    expect(model.profile.id).toBe('learner-123');
    expect(model.profile.displayName).toBe('Test Learner');
    expect(repos.profile.get).toHaveBeenCalledTimes(1);
  });

  it('2. profile learner ID is used for learner-scoped calls', async () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);

    await model.refresh();

    expect(repos.weaknesses.listStrengths).toHaveBeenCalledWith('learner-123');
    expect(repos.weaknesses.listWeaknesses).toHaveBeenCalledWith('learner-123');
    expect(repos.mistakes.listMistakes).toHaveBeenCalledWith('learner-123');
    expect(repos.pronunciation.listWeaknesses).toHaveBeenCalledWith('learner-123');
    expect(repos.vocabulary.list).toHaveBeenCalledWith('learner-123');
    expect(repos.expressions.list).toHaveBeenCalledWith('learner-123');
    expect(repos.review.listDue).toHaveBeenCalledWith('learner-123', expect.any(String));
    expect(repos.progress.list).toHaveBeenCalledWith('learner-123');
    expect(repos.progress.latest).toHaveBeenCalledWith('learner-123');
  });

  it('3. strengths and weaknesses load', async () => {
    const mockStrength: LearnerStrength = {
      id: 's-1',
      learnerId: 'learner-123',
      type: 'grammar',
      referenceId: 'ref-s1',
      confidence: 0.9,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      contexts: ['chat'],
      evidence: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const mockWeakness: LearnerWeakness = {
      id: 'w-1',
      learnerId: 'learner-123',
      type: 'pronunciation',
      referenceId: 'ref-w1',
      status: 'confirmed',
      severity: 0.7,
      occurrenceCount: 3,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      contexts: ['call'],
      evidence: [],
      resolved: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    const repos = createMockRepositories();
    vi.mocked(repos.weaknesses.listStrengths).mockResolvedValue([mockStrength]);
    vi.mocked(repos.weaknesses.listWeaknesses).mockResolvedValue([mockWeakness]);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(model.strengths).toEqual([mockStrength]);
    expect(model.weaknesses).toEqual([mockWeakness]);
  });

  it('4. mistakes and pronunciation weaknesses load', async () => {
    const mockMistake: GrammarMistake = {
      id: 'm-1',
      learnerId: 'learner-123',
      category: 'tense',
      pattern: 'he go',
      correction: 'he goes',
      severity: 'moderate',
      occurrenceCount: 2,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      contexts: ['general'],
      exampleTurnIds: [],
      resolved: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const mockPron: PronunciationWeakness = {
      id: 'p-1',
      learnerId: 'learner-123',
      targetSound: 'th',
      wordExamples: ['think', 'thought'],
      occurrenceCount: 5,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      contexts: ['reading'],
      exampleTurnIds: [],
      resolved: false,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    const repos = createMockRepositories();
    vi.mocked(repos.mistakes.listMistakes).mockResolvedValue([mockMistake]);
    vi.mocked(repos.pronunciation.listWeaknesses).mockResolvedValue([mockPron]);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(model.mistakes).toEqual([mockMistake]);
    expect(model.pronunciationWeaknesses).toEqual([mockPron]);
  });

  it('5. vocabulary and expressions load', async () => {
    const mockVocab: VocabularyItem = {
      id: 'v-1',
      learnerId: 'learner-123',
      headword: 'persistent',
      type: 'word',
      meanings: [],
      source: {
        addedBy: 'learner-created',
        addedAt: '2026-09-01T00:00:00.000Z',
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const mockExpr: ExpressionItem = {
      id: 'e-1',
      learnerId: 'learner-123',
      expression: 'break a leg',
      type: 'idiom',
      meanings: [],
      source: {
        addedBy: 'system',
        addedAt: '2026-09-01T00:00:00.000Z',
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    const repos = createMockRepositories();
    vi.mocked(repos.vocabulary.list).mockResolvedValue([mockVocab]);
    vi.mocked(repos.expressions.list).mockResolvedValue([mockExpr]);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(model.vocabulary).toEqual([mockVocab]);
    expect(model.expressions).toEqual([mockExpr]);
  });

  it('6. due review queue loads', async () => {
    const mockReview: ReviewItem = {
      id: 'r-1',
      learnerId: 'learner-123',
      kind: 'vocabulary',
      referenceId: 'v-1',
      prompt: 'persistent',
      state: 'learning',
      dueAt: '2026-09-10T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      reviewCount: 1,
      consecutiveCorrect: 1,
      outcomeHistory: [],
    };

    const repos = createMockRepositories();
    vi.mocked(repos.review.listDue).mockResolvedValue([mockReview]);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(model.reviewQueue).toEqual([mockReview]);
  });

  it('7. progress and latestProgress load', async () => {
    const mockProgress: ProgressRecord = {
      id: 'pr-1',
      learnerId: 'learner-123',
      recordedAt: '2026-09-01T00:00:00.000Z',
      windowStart: '2026-08-25T00:00:00.000Z',
      windowEnd: '2026-09-01T00:00:00.000Z',
      sessionsCompleted: 4,
      turnsCompleted: 40,
      newWordsLearned: 5,
      weaknessesImproved: 1,
      weaknessesWorsened: 0,
    };

    const repos = createMockRepositories();
    vi.mocked(repos.progress.list).mockResolvedValue([mockProgress]);
    vi.mocked(repos.progress.latest).mockResolvedValue(mockProgress);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(model.progress).toEqual([mockProgress]);
    expect(model.latestProgress).toEqual(mockProgress);
  });

  it('8. successful refresh notifies subscriber', async () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);
    const listener = vi.fn();

    model.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();

    await model.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('9. unsubscribe prevents notification', async () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);
    const listener = vi.fn();

    const unsubscribe = model.subscribe(listener);
    unsubscribe();

    await model.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it('10. failed refresh does not notify', async () => {
    const repos = createMockRepositories();
    vi.mocked(repos.profile.get).mockRejectedValue(new Error('Profile fetch failed'));
    const model = createLearnerModel(repos);
    const listener = vi.fn();

    model.subscribe(listener);

    await expect(model.refresh()).rejects.toThrow('Profile fetch failed');
    expect(listener).not.toHaveBeenCalled();
  });

  it('11. failed refresh preserves previous snapshot', async () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);

    await model.refresh();
    expect(model.profile.id).toBe('learner-123');

    vi.mocked(repos.vocabulary.list).mockRejectedValueOnce(new Error('Network error'));

    await expect(model.refresh()).rejects.toThrow('Network error');
    expect(model.profile.id).toBe('learner-123');
  });

  it('12. one throwing subscriber does not prevent another subscriber', async () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);

    const failingListener = vi.fn().mockImplementation(() => {
      throw new Error('Listener crash');
    });
    const succeedingListener = vi.fn();

    model.subscribe(failingListener);
    model.subscribe(succeedingListener);

    await expect(model.refresh()).resolves.toBeUndefined();
    expect(failingListener).toHaveBeenCalledTimes(1);
    expect(succeedingListener).toHaveBeenCalledTimes(1);
  });
});
