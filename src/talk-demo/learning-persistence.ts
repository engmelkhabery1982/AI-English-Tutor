/**
 * src/talk-demo/learning-persistence.ts
 *
 * Persistence bridge linking real-time assistant feedback to SQLite.
 */

import type { ConversationFeedback } from '../providers/ai/types';
import { generateId } from '../shared/id';
import { nowIso } from '../shared/time';
import {
  SQLiteMistakeRepository,
  SQLiteReviewRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';

export interface LearningPersistenceService {
  recordFeedbackEvidence(feedback: ConversationFeedback): Promise<void>;
}

export function createLearningPersistenceService(): LearningPersistenceService {
  async function resolveDependencies() {
    try {
      const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
      const adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
      await adapter.init();

      // Simple learner profile lookup or default fallback uuid
      const learnerId = '00000000-0000-0000-0000-000000000001';
      return { adapter, learnerId };
    } catch {
      return null;
    }
  }

  return {
    async recordFeedbackEvidence(feedback: ConversationFeedback): Promise<void> {
      if (!feedback || !feedback.correction) {
        return;
      }

      const corr = feedback.correction;
      if (!corr.original || !corr.improved) {
        return;
      }

      const deps = await resolveDependencies();
      if (!deps) return;

      const { adapter, learnerId } = deps;
      const mistakeRepo = new SQLiteMistakeRepository(adapter);
      const weaknessRepo = new SQLiteWeaknessRepository(adapter);
      const reviewRepo = new SQLiteReviewRepository(adapter);
      const now = nowIso();

      try {
        // 1. Record grammar mistake
        const mistake = await mistakeRepo.recordMistake({
          learnerId,
          category: 'Grammar',
          pattern: corr.original.trim(),
          correction: corr.improved.trim(),
          explanation: corr.explanation?.trim() || 'Grammar correction',
          severity: 'moderate',
          occurrenceCount: 1,
          lastSeenAt: now,
          firstSeenAt: now,
          contexts: ['conversation-turn'],
          exampleTurnIds: [],
          resolved: false,
        });

        // 2. Record or update weakness
        const weakness = await weaknessRepo.upsertWeakness({
          learnerId,
          type: 'grammar',
          referenceId: mistake.id,
          severity: corr.severity === 'incorrect' ? 0.8 : corr.severity === 'unnatural' ? 0.5 : 0.3,
          status: 'observed',
          lastSeenAt: now,
          firstSeenAt: now,
          occurrenceCount: 1,
          contexts: ['conversation-turn'],
          evidence: [
            {
              id: mistake.id,
              kind: 'turn',
              at: now,
              summary: `Observed error: "${corr.original}" -> "${corr.improved}"`,
            },
          ],
          resolved: false,
        });

        // 3. Schedule review item
        if (reviewRepo.upsert) {
          await reviewRepo.upsert({
            id: generateId(),
            learnerId,
            kind: 'grammar',
            referenceId: weakness.id,
            prompt: `Correct the mistake in this sentence: "${corr.original.trim()}"`,
            expectedResponse: corr.improved.trim(),
            state: 'learning',
            dueAt: now,
            reviewCount: 0,
            consecutiveCorrect: 0,
            outcomeHistory: [],
          });
        }
      } catch (err) {
        console.error('Error persisting feedback evidence to SQLite:', err);
      }
    },
  };
}
