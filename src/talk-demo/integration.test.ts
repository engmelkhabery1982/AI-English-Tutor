import { describe, it, expect } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteUserProfileRepository,
  SQLiteMistakeRepository,
  SQLiteWeaknessRepository,
  SQLiteReviewRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLitePronunciationRepository,
  SQLiteConversationRepository,
  SQLiteProgressRepository,
} from '../data/local/sqlite/repositories';
import { createLearningPersistenceService } from './learning-persistence';
import { ReviewService } from '../review/service';
import type { AIProvider } from '../providers/ai/types';
import { createLearnerModel } from '../learner-model';
import type { ReviewItemCandidate } from '../review/types';
import type { LessonRepository, ExerciseRepository } from '../repositories';

describe('Real Integration Tests', () => {
  it('A. Talk feedback -> weakness persistence and repeated correction updates', async () => {
    const adapter = new SqlJsAdapter();
    await adapter.init();

    const profileRepo = new SQLiteUserProfileRepository(adapter);
    let profile = await profileRepo.update({
      displayName: 'Test User',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    });
    const learnerId = profile.id;

    const mistakeRepo = new SQLiteMistakeRepository(adapter);
    const weaknessRepo = new SQLiteWeaknessRepository(adapter);
    const reviewRepo = new SQLiteReviewRepository(adapter);

    const persistence = createLearningPersistenceService(adapter, learnerId);

    // First correction
    await persistence.recordFeedbackEvidence({
      correction: {
        original: 'Yesterday I go',
        improved: 'Yesterday I went',
        explanation: 'Use past tense',
        severity: 'incorrect',
      }
    });

    // Verify stored
    const mistakes1 = await mistakeRepo.listMistakes(learnerId);
    expect(mistakes1).toHaveLength(1);
    expect(mistakes1[0].occurrenceCount).toBe(1);
    
    const weaknesses1 = await weaknessRepo.listWeaknesses(learnerId);
    expect(weaknesses1).toHaveLength(1);
    expect(weaknesses1[0].status).toBe('observed');

    const reviews1 = await reviewRepo.listDue(learnerId, new Date(Date.now() + 1000000).toISOString());
    expect(reviews1).toHaveLength(1);
    expect(reviews1[0].expectedResponse).toBe('Yesterday I went');

    // Repeated correction
    await persistence.recordFeedbackEvidence({
      correction: {
        original: 'Yesterday I go',
        improved: 'Yesterday I went',
        explanation: 'Use past tense',
        severity: 'incorrect',
      }
    });

    const mistakes2 = await mistakeRepo.listMistakes(learnerId);
    expect(mistakes2).toHaveLength(1);
    expect(mistakes2[0].occurrenceCount).toBe(2);

    const weaknesses2 = await weaknessRepo.listWeaknesses(learnerId);
    expect(weaknesses2).toHaveLength(1); // No duplicate weakness
    expect(weaknesses2[0].occurrenceCount).toBe(2);
    expect(weaknesses2[0].status).toBe('repeated');
  });

  it('B. Review -> learner model loop', async () => {
    const adapter = new SqlJsAdapter();
    await adapter.init();

    const profileRepo = new SQLiteUserProfileRepository(adapter);
    let profile = await profileRepo.update({
      displayName: 'Test User 2',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    });
    const learnerId = profile.id;

    const mockAI: AIProvider = {
      id: 'mock',
      generate: async () => ({ ok: true, response: { content: '{"result":"correct"}' } })
    };

    const dummyLessonRepo: LessonRepository = { get: async () => null, list: async () => [] };
    const dummyExerciseRepo: ExerciseRepository = { get: async () => null, list: async () => [] };

    const repos = {
      profile: profileRepo,
      conversations: new SQLiteConversationRepository(adapter),
      mistakes: new SQLiteMistakeRepository(adapter),
      pronunciation: new SQLitePronunciationRepository(adapter),
      weaknesses: new SQLiteWeaknessRepository(adapter),
      vocabulary: new SQLiteVocabularyRepository(adapter),
      expressions: new SQLiteExpressionRepository(adapter),
      review: new SQLiteReviewRepository(adapter),
      lessons: dummyLessonRepo,
      exercises: dummyExerciseRepo,
      progress: new SQLiteProgressRepository(adapter),
    };

    const reviewService = new ReviewService(repos, mockAI);

    // Setup a due weakness review item
    const persistence = createLearningPersistenceService(adapter, learnerId);
    await persistence.recordFeedbackEvidence({
      correction: {
        original: 'I has a dog',
        improved: 'I have a dog',
        explanation: 'Grammar',
        severity: 'incorrect',
      }
    });

    const reviews = await repos.review.listDue(learnerId, new Date(Date.now() + 100000).toISOString());
    const targetReview = reviews[0];

    const candidate: ReviewItemCandidate = {
      id: targetReview.id,
      learnerId,
      kind: 'grammar',
      referenceId: targetReview.referenceId as string,
      exerciseType: 'sentence_correction',
      prompt: targetReview.prompt,
      expectedAnswer: targetReview.expectedResponse as string,
      dueAt: targetReview.dueAt,
      severity: 0.5,
      status: 'observed',
      consecutiveCorrect: 0,
      reviewCount: 0,
    };

    // Evaluate review successfully
    await reviewService.recordPracticeResult(learnerId, candidate, 'I have a dog', { result: 'correct', feedback: 'Good' });

    // Reload learner model using same DB
    const model = createLearnerModel(repos);
    // Refresh to load from DB
    await model.refresh();
    const coachingCtx = model.getCoachingContext();

    // Verify updated weakness status (should be 'active_training' now, not 'observed')
    const activeWeakness = coachingCtx.activeWeaknesses.find((w: any) => w.id === targetReview.referenceId);
    expect(activeWeakness).toBeDefined();
    expect(activeWeakness?.status).toBe('active_training');
  });
});
