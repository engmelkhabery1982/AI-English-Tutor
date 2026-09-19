/**
 * src/review/attempt-idempotency.integration.test.ts
 *
 * Integration regression for durable attempt idempotency across branches:
 * - Core Persistence Integrity: `markReviewed(id,result,feedback?,attemptId?)`
 *   is DB-idempotent via `review_history.id = attemptId`.
 * - Review evidence integrity: `ReviewService` must pass the SAME logical
 *   attempt identity (attemptKey derived via deriveReviewAttemptKey) to
 *   `markReviewed`, so a retry after a later failure does not advance
 *   the schedule twice.
 *
 * Scenario under test (real SQLite):
 * 1. markReviewed succeeds, later persistence (weakness evidence) fails,
 *    recordPracticeResult rejects.
 * 2. Retry SAME attemptId → markReviewed must NOT increment reviewCount
 *    again, no duplicate review_history, remaining persistence completes,
 *    final state exactly once.
 * 3. Two different attemptIds create two distinct reviews, reviewCount
 *    per attempt, outcomeHistory consistent.
 * 4. Restart-safe DB idempotency independent of in-memory Map (new service
 *    instance with same DB).
 * 5. Weakness evidence one row per attempt, separate attempts separately
 *    persisted.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../data/local/sqlite/SqlJsAdapter';
import {
  SQLiteReviewRepository,
  SQLiteWeaknessRepository,
  SQLiteUserProfileRepository,
  SQLiteMistakeRepository,
  SQLitePronunciationRepository,
  SQLiteVocabularyRepository,
  SQLiteExpressionRepository,
  SQLiteProgressRepository,
  SQLiteConversationRepository,
} from '../data/local/sqlite/repositories';
import { ReviewService } from './service';
import { generateId } from '../shared/id';
import type { ReviewItemCandidate, EvaluationResult } from './types';
import type { WeaknessRepository } from '../repositories';

function buildGrammarCandidate(input: {
  learnerId: string;
  referenceId: string;
  id?: string;
  reviewCount?: number;
}): ReviewItemCandidate {
  return {
    id: input.id ?? generateId(),
    learnerId: input.learnerId,
    kind: 'grammar',
    exerciseType: 'sentence_correction',
    referenceId: input.referenceId,
    prompt: 'Correct the grammatical error in this sentence:',
    contextSentence: 'She walk to school.',
    expectedAnswer: 'She walks to school.',
    alternativeAnswers: [],
    explanation: 'Third person singular adds -s.',
    dueAt: new Date(Date.now() - 60_000).toISOString(),
    severity: 0.6,
    status: 'confirmed',
    consecutiveCorrect: 0,
    reviewCount: input.reviewCount ?? 0,
  };
}

describe('Review attempt idempotency — cross-branch integration', () => {
  let adapter: SqlJsAdapter;
  let learnerId: string;
  let referenceId: string;
  let reviewItemId: string;
  let candidate: ReviewItemCandidate;
  const evaluation: EvaluationResult = { result: 'correct', feedback: 'Well done.' };

  beforeEach(async () => {
    adapter = new SqlJsAdapter(':memory:');
    await adapter.init();
    const profile = await new SQLiteUserProfileRepository(adapter).update({
      displayName: 'Real Learner',
      currentLevel: 'B1',
      targetLevel: 'B2',
      learningGoals: [],
      preferredModes: [],
    });
    learnerId = profile.id;
    referenceId = generateId();
    reviewItemId = generateId();

    await new SQLiteWeaknessRepository(adapter).upsertWeakness({
      learnerId,
      type: 'grammar',
      referenceId,
      severity: 0.6,
      status: 'active_training',
      firstSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
      lastSeenAt: new Date(Date.now() - 86_400_000).toISOString(),
      occurrenceCount: 1,
      contexts: [],
      evidence: [],
      notes: 'Third person singular',
      resolved: false,
    });

    await new SQLiteReviewRepository(adapter).upsert({
      id: reviewItemId,
      learnerId,
      kind: 'grammar',
      referenceId,
      prompt: 'Correct the grammatical error in this sentence:',
      expectedResponse: 'She walks to school.',
      state: 'learning',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      reviewCount: 0,
      consecutiveCorrect: 0,
      outcomeHistory: [],
    });

    candidate = buildGrammarCandidate({ learnerId, referenceId, reviewCount: 0 });
  });

  async function reviewRow() {
    const rows = await adapter.query(
      'SELECT id, review_count, outcome_history FROM review_items WHERE id = ?',
      [reviewItemId],
    );
    return rows[0] as { id: string; review_count: number; outcome_history: string };
  }

  async function historyRows() {
    return adapter.query('SELECT id, review_item_id, result FROM review_history ORDER BY at');
  }

  async function evidenceRows() {
    return adapter.query('SELECT id, weakness_id, summary FROM weakness_evidence ORDER BY id');
  }

  function createServiceWithWeakness(weaknessRepo: WeaknessRepository): ReviewService {
    const reviewRepo = new SQLiteReviewRepository(adapter);
    const repos = {
      profile: new SQLiteUserProfileRepository(adapter),
      conversations: new SQLiteConversationRepository(adapter),
      mistakes: new SQLiteMistakeRepository(adapter),
      pronunciation: new SQLitePronunciationRepository(adapter),
      weaknesses: weaknessRepo,
      vocabulary: new SQLiteVocabularyRepository(adapter),
      expressions: new SQLiteExpressionRepository(adapter),
      review: reviewRepo,
      lessons: { get: async () => null, list: async () => [] },
      exercises: { get: async () => null, list: async () => [] },
      progress: new SQLiteProgressRepository(adapter),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ReviewService(repos as any, undefined);
  }

  it('markReviewed succeeds then later persistence fails → retry same attemptId does NOT double count (durable idempotency)', async () => {
    const realWeaknessRepo = new SQLiteWeaknessRepository(adapter);

    // Wrapper that fails exactly once on addWeaknessEvidence to simulate
    // "markReviewed succeeds, later op fails, recordPracticeResult rejects".
    let failNextEvidence = true;
    const failingWeaknessRepo = {
      ...realWeaknessRepo,
      getWeaknessByReference: realWeaknessRepo.getWeaknessByReference.bind(realWeaknessRepo),
      listWeaknesses: realWeaknessRepo.listWeaknesses.bind(realWeaknessRepo),
      listStrengths: realWeaknessRepo.listStrengths.bind(realWeaknessRepo),
      upsertWeakness: realWeaknessRepo.upsertWeakness.bind(realWeaknessRepo),
      upsertStrength: realWeaknessRepo.upsertStrength.bind(realWeaknessRepo),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      addWeaknessEvidence: async (evidence: any) => {
        if (failNextEvidence) {
          failNextEvidence = false;
          throw new Error('Simulated failure after markReviewed');
        }
        return realWeaknessRepo.addWeaknessEvidence(evidence);
      },
    } as unknown as WeaknessRepository;

    const service = createServiceWithWeakness(failingWeaknessRepo);
    const attemptId = generateId(); // stable attempt identity

    // First attempt: should fail after markReviewed
    await expect(
      service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
        attemptId,
      }),
    ).rejects.toThrow('Simulated failure after markReviewed');

    // After failure, markReviewed has already succeeded once
    const afterFailureReview = await reviewRow();
    expect(afterFailureReview.review_count).toBe(1);
    const afterFailureHistory = await historyRows();
    expect(afterFailureHistory).toHaveLength(1);
    // The critical guarantee is reviewCount = 1 and history = 1 at this point.
    expect((afterFailureHistory[0] as { id: string }).id).toBeTruthy();

    // Retry SAME attemptId with a healthy repo (simulating retry after crash)
    const healthyService = createServiceWithWeakness(realWeaknessRepo);
    await healthyService.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId,
    });

    // Final state must be exactly once: no duplicate increment
    const finalReview = await reviewRow();
    expect(finalReview.review_count).toBe(1);
    const finalHistory = await historyRows();
    expect(finalHistory).toHaveLength(1);
    const finalEvidence = await evidenceRows();
    expect(finalEvidence).toHaveLength(1);

    // Outcome history consistent with exactly one review
    const outcomeHistory = JSON.parse(finalReview.outcome_history);
    expect(outcomeHistory).toHaveLength(1);
    // outcome_history entries are objects { at, result, note } in current schema
    expect(outcomeHistory[0].result).toBe('correct');

    // Weakness evidence one row per attempt, deterministic
    expect(finalEvidence[0].id).toBeTruthy();
  });

  it('two different attemptIds create two reviews, reviewCount per attempt, outcomeHistory consistent', async () => {
    const realWeaknessRepo = new SQLiteWeaknessRepository(adapter);
    const service = createServiceWithWeakness(realWeaknessRepo);

    const attemptA = generateId();
    const attemptB = generateId();

    await service.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId: attemptA,
    });

    // Candidate reviewCount in memory is stale, but DB should have incremented.
    // For second attempt, pass updated candidate reflecting DB state (as screen would after reload)
    const updatedCandidate = { ...candidate, reviewCount: 1, consecutiveCorrect: 1 };
    await service.recordPracticeResult(learnerId, updatedCandidate, 'She walks to school.', evaluation, undefined, {
      attemptId: attemptB,
    });

    const finalReview = await reviewRow();
    expect(finalReview.review_count).toBe(2);

    const finalHistory = await historyRows();
    expect(finalHistory).toHaveLength(2);
    const historyIds = finalHistory.map((r) => (r as { id: string }).id);
    expect(new Set(historyIds).size).toBe(2); // distinct

    const outcomeHistory = JSON.parse(finalReview.outcome_history);
    expect(outcomeHistory).toHaveLength(2);
    expect(outcomeHistory[0].result).toBe('correct');
    expect(outcomeHistory[1].result).toBe('correct');

    const finalEvidence = await evidenceRows();
    expect(finalEvidence).toHaveLength(2);
    const evidenceIds = finalEvidence.map((r) => (r as { id: string }).id);
    expect(new Set(evidenceIds).size).toBe(2);
  });

  it('restart-safe DB idempotency: new service instance reusing same DB does not double count same attemptId', async () => {
    const realWeaknessRepo = new SQLiteWeaknessRepository(adapter);
    const service1 = createServiceWithWeakness(realWeaknessRepo);
    const attemptId = generateId();

    await service1.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId,
    });

    expect((await reviewRow()).review_count).toBe(1);
    expect((await historyRows()).length).toBe(1);

    // Simulate app restart: new adapter? No, same DB file but new service instance.
    // In-memory Map is gone, but DB idempotency must protect.
    const service2 = createServiceWithWeakness(new SQLiteWeaknessRepository(adapter));
    await service2.recordPracticeResult(learnerId, candidate, 'She walks to school.', evaluation, undefined, {
      attemptId,
    });

    // Still exactly once
    expect((await reviewRow()).review_count).toBe(1);
    expect((await historyRows()).length).toBe(1);
    expect((await evidenceRows()).length).toBe(1);
  });

  it('weakness evidence one row per attempt, separate attempts separately persisted', async () => {
    const realWeaknessRepo = new SQLiteWeaknessRepository(adapter);
    const service = createServiceWithWeakness(realWeaknessRepo);

    const attempts = [generateId(), generateId(), generateId()];
    let rc = 0;
    for (const attemptId of attempts) {
      const cand = { ...candidate, reviewCount: rc, consecutiveCorrect: rc };
      await service.recordPracticeResult(learnerId, cand, 'She walks to school.', evaluation, undefined, {
        attemptId,
      });
      rc += 1;
    }

    const finalReview = await reviewRow();
    expect(finalReview.review_count).toBe(3);
    expect((await historyRows()).length).toBe(3);
    expect((await evidenceRows()).length).toBe(3);
  });
});
