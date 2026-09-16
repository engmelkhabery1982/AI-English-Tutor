/**
 * src/learner-model/index.test.ts
 *
 * Unit tests for the read-only LearnerModel facade, query API, and summary insights.
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

describe('LearnerModel query API', () => {
  function makeWeakness(id: string, status: LearnerWeakness['status'], resolved: boolean): LearnerWeakness {
    return {
      id,
      learnerId: 'learner-123',
      type: 'grammar',
      referenceId: `ref-${id}`,
      status,
      severity: 0.5,
      occurrenceCount: 2,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      contexts: ['chat'],
      evidence: [],
      resolved,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
  }

  it('1. active weaknesses excludes resolved', async () => {
    const repos = createMockRepositories();
    const wActive = makeWeakness('w-1', 'confirmed', false);
    const wResolved = makeWeakness('w-2', 'confirmed', true);
    vi.mocked(repos.weaknesses.listWeaknesses).mockResolvedValue([wActive, wResolved]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const active = model.getActiveWeaknesses();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('w-1');
  });

  it('2. active weaknesses excludes mastered', async () => {
    const repos = createMockRepositories();
    const wObserved = makeWeakness('w-1', 'observed', false);
    const wMastered = makeWeakness('w-2', 'mastered', false);
    vi.mocked(repos.weaknesses.listWeaknesses).mockResolvedValue([wObserved, wMastered]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const active = model.getActiveWeaknesses();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('w-1');
  });

  it('3. relapsed weakness remains active', async () => {
    const repos = createMockRepositories();
    const wRelapsed = makeWeakness('w-relapsed', 'relapsed', false);
    vi.mocked(repos.weaknesses.listWeaknesses).mockResolvedValue([wRelapsed]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const active = model.getActiveWeaknesses();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('w-relapsed');
    expect(active[0].status).toBe('relapsed');
  });

  it('4. getStrengths returns refreshed strengths', async () => {
    const repos = createMockRepositories();
    const strength: LearnerStrength = {
      id: 's-10',
      learnerId: 'learner-123',
      type: 'vocabulary',
      referenceId: 'ref-10',
      confidence: 0.85,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      contexts: ['reading'],
      evidence: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.weaknesses.listStrengths).mockResolvedValue([strength]);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(model.getStrengths()).toEqual([strength]);
  });

  it('5. getSavedVocabulary returns refreshed vocabulary', async () => {
    const repos = createMockRepositories();
    const vocab: VocabularyItem = {
      id: 'v-10',
      learnerId: 'learner-123',
      headword: 'resilient',
      type: 'word',
      meanings: [],
      source: {
        addedBy: 'learner-created',
        addedAt: '2026-09-01T00:00:00.000Z',
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.vocabulary.list).mockResolvedValue([vocab]);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(model.getSavedVocabulary()).toEqual([vocab]);
  });

  it('6. getDueReview returns loaded review queue without recalculation', async () => {
    const repos = createMockRepositories();
    const reviewItem: ReviewItem = {
      id: 'rev-1',
      learnerId: 'learner-123',
      kind: 'expression',
      referenceId: 'exp-1',
      prompt: 'bite the bullet',
      state: 'learning',
      dueAt: '2026-09-15T12:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      reviewCount: 2,
      consecutiveCorrect: 1,
      outcomeHistory: [],
    };
    vi.mocked(repos.review.listDue).mockResolvedValue([reviewItem]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const due = model.getDueReview();
    expect(due).toEqual([reviewItem]);
    expect(due[0].dueAt).toBe('2026-09-15T12:00:00.000Z');
  });

  it('7. recent progress is newest first', async () => {
    const repos = createMockRepositories();
    const p1: ProgressRecord = {
      id: 'p-old',
      learnerId: 'learner-123',
      recordedAt: '2026-08-01T10:00:00.000Z',
      windowStart: '2026-07-25T00:00:00.000Z',
      windowEnd: '2026-08-01T00:00:00.000Z',
      sessionsCompleted: 1,
      turnsCompleted: 10,
      newWordsLearned: 2,
      weaknessesImproved: 0,
      weaknessesWorsened: 0,
    };
    const p2: ProgressRecord = {
      id: 'p-new',
      learnerId: 'learner-123',
      recordedAt: '2026-09-01T10:00:00.000Z',
      windowStart: '2026-08-25T00:00:00.000Z',
      windowEnd: '2026-09-01T00:00:00.000Z',
      sessionsCompleted: 3,
      turnsCompleted: 30,
      newWordsLearned: 5,
      weaknessesImproved: 1,
      weaknessesWorsened: 0,
    };
    // List returns unsorted (old first)
    vi.mocked(repos.progress.list).mockResolvedValue([p1, p2]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const recent = model.getRecentProgress();
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBe('p-new');
    expect(recent[1].id).toBe('p-old');
  });

  it('8. recent progress limit works', async () => {
    const repos = createMockRepositories();
    const p1: ProgressRecord = {
      id: 'p-1',
      learnerId: 'learner-123',
      recordedAt: '2026-08-01T00:00:00.000Z',
      windowStart: '2026-07-25T00:00:00.000Z',
      windowEnd: '2026-08-01T00:00:00.000Z',
      sessionsCompleted: 1,
      turnsCompleted: 10,
      newWordsLearned: 1,
      weaknessesImproved: 0,
      weaknessesWorsened: 0,
    };
    const p2: ProgressRecord = {
      id: 'p-2',
      learnerId: 'learner-123',
      recordedAt: '2026-08-15T00:00:00.000Z',
      windowStart: '2026-08-08T00:00:00.000Z',
      windowEnd: '2026-08-15T00:00:00.000Z',
      sessionsCompleted: 2,
      turnsCompleted: 20,
      newWordsLearned: 3,
      weaknessesImproved: 0,
      weaknessesWorsened: 0,
    };
    const p3: ProgressRecord = {
      id: 'p-3',
      learnerId: 'learner-123',
      recordedAt: '2026-09-01T00:00:00.000Z',
      windowStart: '2026-08-25T00:00:00.000Z',
      windowEnd: '2026-09-01T00:00:00.000Z',
      sessionsCompleted: 3,
      turnsCompleted: 30,
      newWordsLearned: 5,
      weaknessesImproved: 1,
      weaknessesWorsened: 0,
    };
    vi.mocked(repos.progress.list).mockResolvedValue([p1, p2, p3]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const limited = model.getRecentProgress(2);
    expect(limited).toHaveLength(2);
    expect(limited[0].id).toBe('p-3');
    expect(limited[1].id).toBe('p-2');
  });

  it('9. queries before first refresh return safe empty/default results', () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);

    expect(model.getActiveWeaknesses()).toEqual([]);
    expect(model.getStrengths()).toEqual([]);
    expect(model.getSavedVocabulary()).toEqual([]);
    expect(model.getDueReview()).toEqual([]);
    expect(model.getRecentProgress()).toEqual([]);
    expect(model.getLatestProgress()).toBeNull();
    expect(model.profile.id).toBe('');
  });

  it('10. returned query collection cannot mutate internal snapshot behavior', async () => {
    const repos = createMockRepositories();
    const vocab: VocabularyItem = {
      id: 'v-1',
      learnerId: 'learner-123',
      headword: 'safe',
      type: 'word',
      meanings: [],
      source: {
        addedBy: 'system',
        addedAt: '2026-09-01T00:00:00.000Z',
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.vocabulary.list).mockResolvedValue([vocab]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const savedVocab = model.getSavedVocabulary() as VocabularyItem[];
    expect(savedVocab).toHaveLength(1);

    // Mutate the returned array
    savedVocab.push({
      ...vocab,
      id: 'v-mutated',
      headword: 'mutated',
    });

    // Internal model snapshot must remain unchanged
    expect(model.getSavedVocabulary()).toHaveLength(1);
    expect(model.vocabulary).toHaveLength(1);
  });
});

describe('LearnerModel summary insights API', () => {
  function makeWeakness(
    id: string,
    status: LearnerWeakness['status'],
    resolved: boolean,
  ): LearnerWeakness {
    return {
      id,
      learnerId: 'learner-123',
      type: 'grammar',
      referenceId: `ref-${id}`,
      status,
      severity: 0.5,
      occurrenceCount: 1,
      lastSeenAt: '2026-09-01T00:00:00.000Z',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      contexts: ['chat'],
      evidence: [],
      resolved,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
  }

  it('1. weakness summary counts total/active/mastered/resolved', async () => {
    const repos = createMockRepositories();
    const w1 = makeWeakness('w-1', 'confirmed', false); // active
    const w2 = makeWeakness('w-2', 'mastered', false); // mastered
    const w3 = makeWeakness('w-3', 'observed', true); // resolved
    const w4 = makeWeakness('w-4', 'mastered', true); // mastered AND resolved
    vi.mocked(repos.weaknesses.listWeaknesses).mockResolvedValue([w1, w2, w3, w4]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary = model.getWeaknessSummary();
    expect(summary.total).toBe(4);
    expect(summary.active).toBe(1); // w1
    expect(summary.mastered).toBe(2); // w2, w4
    expect(summary.resolved).toBe(2); // w3, w4
  });

  it('2. weakness byStatus counts are correct', async () => {
    const repos = createMockRepositories();
    const w1 = makeWeakness('w-1', 'observed', false);
    const w2 = makeWeakness('w-2', 'observed', false);
    const w3 = makeWeakness('w-3', 'relapsed', false);
    const w4 = makeWeakness('w-4', 'active_training', false);
    vi.mocked(repos.weaknesses.listWeaknesses).mockResolvedValue([w1, w2, w3, w4]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary = model.getWeaknessSummary();
    expect(summary.byStatus.observed).toBe(2);
    expect(summary.byStatus.relapsed).toBe(1);
    expect(summary.byStatus.active_training).toBe(1);
    expect(summary.byStatus.mastered).toBe(0);
    expect(summary.byStatus.confirmed).toBe(0);
    expect(summary.byStatus.improving).toBe(0);
    expect(summary.byStatus.stable).toBe(0);
    expect(summary.byStatus.repeated).toBe(0);
  });

  it('3. vocabulary summary counts meanings', async () => {
    const repos = createMockRepositories();
    const vocab1: VocabularyItem = {
      id: 'v-1',
      learnerId: 'learner-123',
      headword: 'run',
      type: 'word',
      meanings: [
        { definition: 'to move fast', examples: [] },
        { definition: 'to manage', examples: [] },
      ],
      source: { addedBy: 'system', addedAt: '2026-09-01T00:00:00.000Z' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const vocab2: VocabularyItem = {
      id: 'v-2',
      learnerId: 'learner-123',
      headword: 'jump',
      type: 'word',
      meanings: [{ definition: 'to leap', examples: [] }],
      source: { addedBy: 'system', addedAt: '2026-09-01T00:00:00.000Z' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.vocabulary.list).mockResolvedValue([vocab1, vocab2]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary = model.getVocabularySummary();
    expect(summary.totalItems).toBe(2);
    expect(summary.totalMeanings).toBe(3);
    expect(summary.reviewedMeanings).toBe(0);
    expect(summary.masteredMeanings).toBe(0);
    expect(summary.dueMeanings).toBe(0);
  });

  it('4. vocabulary masteredMeaning count uses persisted review state', async () => {
    const repos = createMockRepositories();
    const vocab: VocabularyItem = {
      id: 'v-1',
      learnerId: 'learner-123',
      headword: 'fast',
      type: 'word',
      meanings: [
        {
          definition: 'quick',
          examples: [],
          review: {
            state: 'mastered',
            reviewCount: 5,
            consecutiveCorrect: 5,
          },
        },
        {
          definition: 'firmly fixed',
          examples: [],
          review: {
            state: 'learning',
            reviewCount: 1,
            consecutiveCorrect: 1,
          },
        },
      ],
      source: { addedBy: 'system', addedAt: '2026-09-01T00:00:00.000Z' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.vocabulary.list).mockResolvedValue([vocab]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary = model.getVocabularySummary();
    expect(summary.totalMeanings).toBe(2);
    expect(summary.reviewedMeanings).toBe(2);
    expect(summary.masteredMeanings).toBe(1);
  });

  it('5. vocabulary dueMeaning count uses persisted nextReviewAt', async () => {
    const repos = createMockRepositories();
    const pastIso = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const futureIso = new Date(Date.now() + 3600000).toISOString(); // 1 hour later

    const vocab: VocabularyItem = {
      id: 'v-1',
      learnerId: 'learner-123',
      headword: 'time',
      type: 'word',
      meanings: [
        {
          definition: 'past due meaning',
          examples: [],
          review: {
            state: 'learning',
            reviewCount: 2,
            consecutiveCorrect: 1,
            nextReviewAt: pastIso,
          },
        },
        {
          definition: 'future due meaning',
          examples: [],
          review: {
            state: 'learning',
            reviewCount: 2,
            consecutiveCorrect: 2,
            nextReviewAt: futureIso,
          },
        },
      ],
      source: { addedBy: 'system', addedAt: '2026-09-01T00:00:00.000Z' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.vocabulary.list).mockResolvedValue([vocab]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary = model.getVocabularySummary();
    expect(summary.dueMeanings).toBe(1);
  });

  it('6. invalid review date is ignored safely', async () => {
    const repos = createMockRepositories();
    const vocab: VocabularyItem = {
      id: 'v-1',
      learnerId: 'learner-123',
      headword: 'broken-date',
      type: 'word',
      meanings: [
        {
          definition: 'has invalid nextReviewAt',
          examples: [],
          review: {
            state: 'learning',
            reviewCount: 1,
            consecutiveCorrect: 1,
            nextReviewAt: 'not-a-valid-date',
          },
        },
      ],
      source: { addedBy: 'system', addedAt: '2026-09-01T00:00:00.000Z' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.vocabulary.list).mockResolvedValue([vocab]);

    const model = createLearnerModel(repos);
    await model.refresh();

    expect(() => model.getVocabularySummary()).not.toThrow();
    const summary = model.getVocabularySummary();
    expect(summary.dueMeanings).toBe(0);
    expect(summary.reviewedMeanings).toBe(1);
  });

  it('7. expression summary behaves equivalently', async () => {
    const repos = createMockRepositories();
    const pastIso = new Date(Date.now() - 3600000).toISOString();
    const expr: ExpressionItem = {
      id: 'e-1',
      learnerId: 'learner-123',
      expression: 'piece of cake',
      type: 'idiom',
      meanings: [
        {
          definition: 'very easy',
          examples: [],
          review: {
            state: 'mastered',
            reviewCount: 4,
            consecutiveCorrect: 4,
            nextReviewAt: pastIso,
          },
        },
      ],
      source: { addedBy: 'system', addedAt: '2026-09-01T00:00:00.000Z' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    vi.mocked(repos.expressions.list).mockResolvedValue([expr]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary = model.getExpressionSummary();
    expect(summary.totalItems).toBe(1);
    expect(summary.totalMeanings).toBe(1);
    expect(summary.reviewedMeanings).toBe(1);
    expect(summary.masteredMeanings).toBe(1);
    expect(summary.dueMeanings).toBe(1);
  });

  it('8. progress aggregation sums persisted fields correctly', async () => {
    const repos = createMockRepositories();
    const p1: ProgressRecord = {
      id: 'p-1',
      learnerId: 'learner-123',
      recordedAt: '2026-08-01T00:00:00.000Z',
      windowStart: '2026-07-25T00:00:00.000Z',
      windowEnd: '2026-08-01T00:00:00.000Z',
      sessionsCompleted: 2,
      turnsCompleted: 20,
      newWordsLearned: 3,
      weaknessesImproved: 1,
      weaknessesWorsened: 0,
    };
    const p2: ProgressRecord = {
      id: 'p-2',
      learnerId: 'learner-123',
      recordedAt: '2026-09-01T00:00:00.000Z',
      windowStart: '2026-08-25T00:00:00.000Z',
      windowEnd: '2026-09-01T00:00:00.000Z',
      sessionsCompleted: 3,
      turnsCompleted: 35,
      newWordsLearned: 7,
      weaknessesImproved: 2,
      weaknessesWorsened: 1,
    };
    vi.mocked(repos.progress.list).mockResolvedValue([p1, p2]);
    vi.mocked(repos.progress.latest).mockResolvedValue(p2);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary = model.getProgressSummary();
    expect(summary.recordsCount).toBe(2);
    expect(summary.latest).toEqual(p2);
    expect(summary.totalSessionsCompleted).toBe(5);
    expect(summary.totalTurnsCompleted).toBe(55);
    expect(summary.totalNewWordsLearned).toBe(10);
    expect(summary.totalWeaknessesImproved).toBe(3);
    expect(summary.totalWeaknessesWorsened).toBe(1);
  });

  it('9. dashboard snapshot combines all summaries', async () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);
    await model.refresh();

    const snapshot = model.getDashboardSnapshot();
    expect(snapshot.profile.id).toBe('learner-123');
    expect(snapshot.weaknessSummary).toBeDefined();
    expect(snapshot.vocabularySummary).toBeDefined();
    expect(snapshot.expressionSummary).toBeDefined();
    expect(snapshot.progressSummary).toBeDefined();
    expect(snapshot.dueReviewCount).toBeDefined();
  });

  it('10. dashboard dueReviewCount matches loaded reviewQueue', async () => {
    const repos = createMockRepositories();
    const r1: ReviewItem = {
      id: 'r-1',
      learnerId: 'learner-123',
      kind: 'vocabulary',
      referenceId: 'v-1',
      prompt: 'word',
      state: 'learning',
      dueAt: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      reviewCount: 1,
      consecutiveCorrect: 1,
      outcomeHistory: [],
    };
    const r2: ReviewItem = {
      id: 'r-2',
      learnerId: 'learner-123',
      kind: 'expression',
      referenceId: 'e-1',
      prompt: 'phrase',
      state: 'learning',
      dueAt: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      reviewCount: 1,
      consecutiveCorrect: 1,
      outcomeHistory: [],
    };
    vi.mocked(repos.review.listDue).mockResolvedValue([r1, r2]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const snapshot = model.getDashboardSnapshot();
    expect(snapshot.dueReviewCount).toBe(2);
  });

  it('11. methods work safely before first refresh', () => {
    const repos = createMockRepositories();
    const model = createLearnerModel(repos);

    const weaknessSum = model.getWeaknessSummary();
    expect(weaknessSum.total).toBe(0);
    expect(weaknessSum.active).toBe(0);
    expect(weaknessSum.mastered).toBe(0);
    expect(weaknessSum.resolved).toBe(0);
    expect(weaknessSum.byStatus.observed).toBe(0);

    const vocabSum = model.getVocabularySummary();
    expect(vocabSum.totalItems).toBe(0);
    expect(vocabSum.totalMeanings).toBe(0);
    expect(vocabSum.reviewedMeanings).toBe(0);
    expect(vocabSum.masteredMeanings).toBe(0);
    expect(vocabSum.dueMeanings).toBe(0);

    const exprSum = model.getExpressionSummary();
    expect(exprSum.totalItems).toBe(0);

    const progSum = model.getProgressSummary();
    expect(progSum.recordsCount).toBe(0);
    expect(progSum.latest).toBeNull();
    expect(progSum.totalSessionsCompleted).toBe(0);

    const dashboard = model.getDashboardSnapshot();
    expect(dashboard.profile.id).toBe('');
    expect(dashboard.dueReviewCount).toBe(0);
  });

  it('12. mutating returned summary/dashboard object does not alter later results', async () => {
    const repos = createMockRepositories();
    const w1 = makeWeakness('w-1', 'confirmed', false);
    vi.mocked(repos.weaknesses.listWeaknesses).mockResolvedValue([w1]);

    const model = createLearnerModel(repos);
    await model.refresh();

    const summary1 = model.getWeaknessSummary();
    (summary1.byStatus as Record<string, number>).confirmed = 999;
    (summary1 as unknown as { total: number }).total = 555;

    const summary2 = model.getWeaknessSummary();
    expect(summary2.total).toBe(1);
    expect(summary2.byStatus.confirmed).toBe(1);

    const dashboard1 = model.getDashboardSnapshot();
    (dashboard1 as unknown as { dueReviewCount: number }).dueReviewCount = 888;
    const dashboard2 = model.getDashboardSnapshot();
    expect(dashboard2.dueReviewCount).toBe(0);
  });
});
