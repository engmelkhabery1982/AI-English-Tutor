/**
 * src/talk-demo/learning-persistence.ts
 *
 * Persistence bridge linking real-time assistant feedback to SQLite.
 */

import type { ConversationFeedback } from '../providers/ai/types';
import type { WeaknessStatus } from '../domain/shared/types';
import { generateId } from '../shared/id';
import { nowIso } from '../shared/time';
import {
  SQLiteMistakeRepository,
  SQLiteReviewRepository,
  SQLiteWeaknessRepository,
  SQLiteUserProfileRepository,
} from '../data/local/sqlite/repositories';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';

// Categorizer helper to assign meaningful categories
function categorizeCorrection(
  original: string,
  improved: string,
  explanation: string,
  severity: string
): 'grammar' | 'vocabulary' | 'expression' {
  const explanationLower = explanation.toLowerCase();
  if (
    severity === 'unnatural' ||
    explanationLower.includes('natural') ||
    explanationLower.includes('phrasing') ||
    explanationLower.includes('native')
  ) {
    return 'expression';
  }
  if (
    explanationLower.includes('idiom') ||
    explanationLower.includes('expression') ||
    explanationLower.includes('slang') ||
    explanationLower.includes('phrase')
  ) {
    return 'expression';
  }
  if (
    explanationLower.includes('vocabulary') ||
    explanationLower.includes('word choice') ||
    explanationLower.includes('meaning') ||
    explanationLower.includes('vocab')
  ) {
    return 'vocabulary';
  }
  return 'grammar';
}

export interface LearningPersistenceService {
  recordFeedbackEvidence(feedback: ConversationFeedback): Promise<void>;
}

export function createLearningPersistenceService(injectedAdapter?: DatabaseAdapter, injectedLearnerId?: string): LearningPersistenceService {
  async function resolveDependencies() {
    try {
      // An injected adapter is ALWAYS used as-is: no second database instance is
      // ever opened just because the learner id still has to be resolved.
      let adapter = injectedAdapter ?? null;
      if (!adapter) {
        const { ExpoSqliteAdapter } = await import('../data/local/sqlite/ExpoSqliteAdapter');
        adapter = new ExpoSqliteAdapter({ databaseName: 'ai_english_tutor.db' });
        await adapter.init();
      }

      let learnerId: string | null = injectedLearnerId ?? null;
      if (!learnerId) {
        const userProfileRepo = new SQLiteUserProfileRepository(adapter);
        try {
          const profile = await userProfileRepo.get();
          if (profile && profile.id) {
            learnerId = profile.id;
          }
        } catch {
          learnerId = null;
        }
      }

      if (!learnerId) {
        return null;
      }

      return { adapter, learnerId };
    } catch {
      return null;
    }
  }

  return {
    async recordFeedbackEvidence(feedback: ConversationFeedback): Promise<void> {
      // Conservative check: do not create weakness for every correction blindly
      if (!feedback || !feedback.correction) {
        return;
      }

      const corr = feedback.correction;
      if (!corr.original || !corr.improved) {
        return;
      }

      // Conservative check: let's ignore minor things if needed or only record if we have a valid profile
      const deps = await resolveDependencies();
      if (!deps) return; // Safeguard: if database fails or no profile is present, do NOT corrupt successful conversation history

      const { adapter, learnerId } = deps;
      const mistakeRepo = new SQLiteMistakeRepository(adapter);
      const weaknessRepo = new SQLiteWeaknessRepository(adapter);
      const reviewRepo = new SQLiteReviewRepository(adapter);
      const now = nowIso();

      try {
        const category = categorizeCorrection(
          corr.original,
          corr.improved,
          corr.explanation ?? '',
          corr.severity
        );

        // Check if a mistake with same pattern already exists in grammar_mistakes
        const normOriginal = corr.original.trim().toLowerCase();
        const existingMistakes = await mistakeRepo.listMistakes(learnerId, { limit: 100 });
        const existingMistake = existingMistakes.find(
          (m) => m.pattern.trim().toLowerCase() === normOriginal
        );

        let mistakeId = existingMistake?.id;
        let occurrenceCount = (existingMistake?.occurrenceCount ?? 0) + 1;

        if (!existingMistake) {
          // Record brand new mistake
          const mistake = await mistakeRepo.recordMistake({
            learnerId,
            category:
              category === 'grammar'
                ? 'Grammar'
                : category === 'vocabulary'
                  ? 'Vocabulary'
                  : 'Expression',
            pattern: corr.original.trim(),
            correction: corr.improved.trim(),
            explanation: corr.explanation?.trim() || 'Correction',
            severity: corr.severity === 'incorrect' ? 'major' : 'moderate',
            occurrenceCount: 1,
            lastSeenAt: now,
            firstSeenAt: now,
            contexts: ['conversation-turn'],
            exampleTurnIds: [],
            resolved: false,
          });
          mistakeId = mistake.id;
          occurrenceCount = 1;
        } else {
          // Update existing mistake
          const updatedContexts = Array.from(new Set([...(existingMistake.contexts ?? []), 'conversation-turn']));
          await mistakeRepo.updateMistake(existingMistake.id, {
            occurrenceCount,
            lastSeenAt: now,
            contexts: updatedContexts,
          });
        }

        // Determine mapped weakness type
        const weaknessType: 'grammar' | 'vocabulary' | 'natural_expression' =
          category === 'grammar'
            ? 'grammar'
            : category === 'vocabulary'
              ? 'vocabulary'
              : 'natural_expression';

        // Check if there is an existing weakness for this reference/mistake
        const existingWeaknesses = await weaknessRepo.listWeaknesses(learnerId, 100);
        const existingWeakness = existingWeaknesses.find(
          (w) =>
            w.referenceId === mistakeId ||
            (w.type === weaknessType && w.notes?.trim().toLowerCase() === normOriginal)
        );

        let nextStatus: WeaknessStatus = 'observed';
        if (existingWeakness) {
          // Repeated same issue: stable/mastered can relapse back to 'relapsed'
          if (['stable', 'mastered'].includes(existingWeakness.status)) {
            nextStatus = 'relapsed';
          } else if (existingWeakness.status === 'observed') {
            nextStatus = 'repeated';
          } else if (existingWeakness.status === 'repeated') {
            nextStatus = 'confirmed';
          } else {
            nextStatus = existingWeakness.status; // Keep existing status if it is already confirmed or training
          }
        }

        const weakness = await weaknessRepo.upsertWeakness({
          learnerId,
          type: weaknessType,
          referenceId: mistakeId ?? generateId(),
          severity: corr.severity === 'incorrect' ? 0.8 : corr.severity === 'unnatural' ? 0.5 : 0.3,
          status: nextStatus,
          lastSeenAt: now,
          firstSeenAt: existingWeakness?.firstSeenAt ?? now,
          occurrenceCount,
          contexts: ['conversation-turn'],
          notes: corr.original.trim(), // Keep original mistake as notes for matching
          evidence: [
            ...(existingWeakness?.evidence ?? []),
            {
              id: mistakeId ?? generateId(),
              kind: 'turn',
              at: now,
              summary: `Observed issue: "${corr.original}" -> "${corr.improved}"`,
            },
          ],
          resolved: false,
        });

        // 3. Schedule review item (only if not already scheduled as due)
        if (reviewRepo.upsert) {
          const dueReviews = await reviewRepo.listDue(learnerId, now);
          const alreadyScheduled = dueReviews.some((r) => r.referenceId === weakness.id);
          if (!alreadyScheduled) {
            await reviewRepo.upsert({
              learnerId,
              kind: category,
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
        }
      } catch (err) {
        console.error('Error persisting feedback evidence to SQLite:', err);
        // persistence failure must not corrupt successful conversation history
      }
    },
  };
}
