/**
 * src/review/service.ts
 *
 * ReviewService orchestrates planning, evaluation, and persistent
 * learning evidence updating across the application repositories.
 */

import type { AppRepositories } from '../repositories';
import type { AIProvider } from '../providers/ai/types';
import type { LearnerWeakness } from '../domain/models/learner';
import type {
  EvaluationResult,
  ReviewDashboardSummary,
  ReviewItemCandidate,
  ReviewPlannerOptions,
  ReviewSessionSummary,
} from './types';
import { ReviewPlanner } from './planner';
import { ReviewEvaluator } from './evaluator';
import {
  calculateNextIntervalDays,
  calculateNextReviewDate,
  transitionWeaknessLifecycle,
} from './weakness-lifecycle';
import { nowIso } from '../shared/time';

export class ReviewService {
  private readonly planner: ReviewPlanner;
  private readonly evaluator: ReviewEvaluator;

  constructor(
    private readonly repos: AppRepositories,
    aiProvider?: AIProvider,
  ) {
    this.planner = new ReviewPlanner(repos);
    this.evaluator = new ReviewEvaluator(aiProvider);
  }

  /**
   * Retrieves dashboard summary metrics for due items and active weaknesses.
   */
  async getDashboardSummary(learnerId: string): Promise<ReviewDashboardSummary> {
    const now = nowIso();
    const [dueReviews, weaknesses, vocabList, exprList] = await Promise.all([
      this.repos.review.listDue(learnerId, now),
      this.repos.weaknesses.listWeaknesses(learnerId, 100),
      this.repos.vocabulary.list(learnerId),
      this.repos.expressions.list(learnerId),
    ]);

    const dueVocab = dueReviews.filter((r) => r.kind === 'vocabulary').length +
      vocabList.filter((v) => v.meanings.some((m) => m.review?.nextReviewAt && m.review.nextReviewAt <= now)).length;

    const dueExpr = dueReviews.filter((r) => r.kind === 'expression').length +
      exprList.filter((e) => e.meanings.some((m) => m.review?.nextReviewAt && m.review.nextReviewAt <= now)).length;

    const activeWeaknesses = weaknesses.filter(
      (w) => !w.resolved && ['observed', 'repeated', 'confirmed', 'active_training', 'relapsed'].includes(w.status),
    );

    const dueGrammar = dueReviews.filter((r) => r.kind === 'grammar').length + activeWeaknesses.length;
    const totalDue = dueVocab + dueExpr + dueGrammar;

    return {
      totalDue,
      dueVocabularyCount: dueVocab,
      dueExpressionCount: dueExpr,
      activeWeaknessCount: activeWeaknesses.length,
      categories: [
        { key: 'grammar', label: 'Grammar & Phrasing', dueCount: dueGrammar },
        { key: 'vocabulary', label: 'Vocabulary Recall', dueCount: dueVocab },
        { key: 'expression', label: 'Expressions & Idioms', dueCount: dueExpr },
      ],
    };
  }

  /**
   * Plan a bounded review session (8-12 items).
   */
  async planSession(
    learnerId: string,
    options?: ReviewPlannerOptions,
  ): Promise<readonly ReviewItemCandidate[]> {
    return this.planner.planSession(learnerId, options);
  }

  /**
   * Evaluate a user's answer.
   */
  async evaluateAnswer(
    candidate: ReviewItemCandidate,
    userAnswer: string,
  ): Promise<EvaluationResult> {
    return this.evaluator.evaluate(candidate, userAnswer);
  }

  /**
   * Records the practice result, advancing the weakness lifecycle,
   * spaced repetition schedules, and learning evidence.
   */
  async recordPracticeResult(
    learnerId: string,
    candidate: ReviewItemCandidate,
    userAnswer: string,
    evaluation: EvaluationResult,
    _latencyMs?: number,
  ): Promise<void> {
    const now = nowIso();

    // 1. Ensure review_items is updated
    let reviewItem = await this.repos.review.listDue(learnerId, now).then(
      (items) => items.find((i) => i.id === candidate.id || i.referenceId === candidate.referenceId),
    );

    if (!reviewItem && this.repos.review.upsert) {
      // Upsert into review_items if needed
      reviewItem = await this.repos.review.upsert({
        id: candidate.id,
        learnerId,
        kind: candidate.kind,
        referenceId: candidate.referenceId,
        prompt: candidate.prompt,
        expectedResponse: candidate.expectedAnswer,
        contextTopic: candidate.contextTopic,
        state: 'learning',
        dueAt: candidate.dueAt,
        reviewCount: candidate.reviewCount,
        consecutiveCorrect: candidate.consecutiveCorrect,
        outcomeHistory: [],
      });
    }

    if (reviewItem) {
      await this.repos.review.markReviewed(
        reviewItem.id,
        evaluation.result,
        evaluation.feedback,
      );
    }

    // 2. Weakness Lifecycle Transition
    if (candidate.kind === 'grammar' || candidate.status) {
      const currentStatus = candidate.status ?? 'active_training';
      const transition = transitionWeaknessLifecycle(
        currentStatus,
        evaluation.result,
        candidate.consecutiveCorrect,
        candidate.severity ?? 0.5,
      );

      // Check if weakness exists
      const existingWeaknesses = await this.repos.weaknesses.listWeaknesses(learnerId, 100);
      const weakness = existingWeaknesses.find(
        (w) => w.id === candidate.referenceId || w.referenceId === candidate.referenceId,
      );

      if (weakness) {
        await this.repos.weaknesses.upsertWeakness({
          ...weakness,
          status: transition.nextStatus,
          severity: transition.nextSeverity,
        });

        await this.repos.weaknesses.addWeaknessEvidence({
          weaknessId: weakness.id,
          id: reviewItem?.id ?? candidate.id,
          kind: 'turn',
          at: now,
          summary: `Review practice result: ${evaluation.result}. Answer: "${userAnswer}". Feedback: ${evaluation.feedback}`,
        });
      }
    }

    // 3. Spaced Repetition for Vocabulary / Expressions
    const nextIntervalDays = calculateNextIntervalDays(
      candidate.consecutiveCorrect + (evaluation.result === 'correct' ? 1 : 0),
      evaluation.result,
    );
    const nextReviewAt = calculateNextReviewDate(now, nextIntervalDays);

    if (candidate.kind === 'vocabulary') {
      const vocabItem = await this.repos.vocabulary.get(candidate.referenceId);
      if (vocabItem && vocabItem.meanings.length > 0) {
        const updatedMeanings = vocabItem.meanings.map((m) => ({
          ...m,
          review: {
            state: evaluation.result === 'correct' ? ('familiar' as const) : ('learning' as const),
            lastReviewAt: now,
            nextReviewAt,
            reviewCount: (m.review?.reviewCount ?? 0) + 1,
            consecutiveCorrect: evaluation.result === 'correct' ? (m.review?.consecutiveCorrect ?? 0) + 1 : 0,
          },
        }));

        await this.repos.vocabulary.update(vocabItem.id, {
          meanings: updatedMeanings,
        });
      }
    } else if (candidate.kind === 'expression') {
      const exprItem = await this.repos.expressions.get(candidate.referenceId);
      if (exprItem && exprItem.meanings && exprItem.meanings.length > 0) {
        const updatedMeanings = exprItem.meanings.map((m) => ({
          ...m,
          review: {
            state: evaluation.result === 'correct' ? ('familiar' as const) : ('learning' as const),
            lastReviewAt: now,
            nextReviewAt,
            reviewCount: (m.review?.reviewCount ?? 0) + 1,
            consecutiveCorrect: evaluation.result === 'correct' ? (m.review?.consecutiveCorrect ?? 0) + 1 : 0,
          },
        }));

        await this.repos.expressions.update(exprItem.id, {
          meanings: updatedMeanings,
        });
      }
    }
  }

  /**
   * Finalizes a completed review session and updates progress tracking.
   */
  async completeSession(
    learnerId: string,
    summary: ReviewSessionSummary,
  ): Promise<void> {
    await this.repos.progress.record({
      learnerId,
      recordedAt: summary.completedAt,
      windowStart: summary.startedAt,
      windowEnd: summary.completedAt,
      sessionsCompleted: 1,
      turnsCompleted: summary.totalItems,
      newWordsLearned: summary.masteredCount,
      weaknessesImproved: summary.improvedWeaknessCount,
      weaknessesWorsened: summary.incorrectCount > 0 ? 1 : 0,
      notes: `Adaptive review session: ${summary.correctCount} correct, ${summary.partialCount} partial, ${summary.incorrectCount} needs work.`,
    });
  }

  /**
   * Expose legitimate method to list active weaknesses.
   */
  async getActiveWeaknesses(learnerId: string): Promise<readonly LearnerWeakness[]> {
    const weaknesses = await this.repos.weaknesses.listWeaknesses(learnerId, 100);
    return weaknesses.filter((w) => !w.resolved);
  }
}
