/**
 * src/engines/index.ts
 *
 * Engine layer placeholders.
 *
 * Engines orchestrate providers, the learner model, and repositories.
 * They are intentionally NOT implemented yet.
 */

import type { ConversationService } from '../services';
import type { LearningService } from '../services';
import type { AppRepositories } from '../repositories';
import type { LearnerModel } from '../learner-model';

/**
 * ConversationEngine placeholder.
 *
 * Future responsibilities:
 * - run a conversation session
 * - stream STT -> AI -> TTS
 * - apply correction mode (natural / coach / intensive)
 * - persist turns and observations
 */
export interface ConversationEngine {
  readonly services: ConversationService;
  readonly repos: AppRepositories;
  readonly learnerModel: LearnerModel;
}

/**
 * LearningEngine placeholder.
 *
 * Future responsibilities:
 * - analyze conversation turns for mistakes / weaknesses / strengths
 * - update the Learner Model
 * - recommend adaptive activities
 * - schedule spaced repetition
 */
export interface LearningEngine {
  readonly services: LearningService;
  readonly repos: AppRepositories;
  readonly learnerModel: LearnerModel;
}