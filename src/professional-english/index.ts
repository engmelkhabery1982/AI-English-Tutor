/**
 * Professional English Core — public surface (Step 1).
 *
 * Domain model + deterministic scenario planner. Deliberately no UI, no
 * navigation, no persistence, and no AI/network dependency.
 */

export type {
  ChallengeEvent,
  CategoryDifficultyDescriptor,
  CoachingMode,
  DifficultyBand,
  LanguageGoal,
  LearnerProfile,
  LearningGoal,
  PlannerInput,
  PracticeType,
  ProfessionalLevel,
  ScenarioCategory,
  ScenarioDefinition,
  ScenarioPlan,
  SpeakingGoal,
} from './types';

export { DIFFICULTY_ORDER, PROFESSIONAL_LEVELS, SCENARIO_CATEGORIES } from './types';

export {
  BASELINE_CHALLENGE,
  DIFFICULTY_RANK,
  GENERAL_SCENARIO,
  SCENARIOS,
  getScenario,
} from './scenarios';

export {
  DEFAULT_MAX_TARGET_EXPRESSIONS,
  difficultyBandRank,
  levelRank,
  planScenario,
  resolveCoachingMode,
  resolveDifficulty,
  selectChallenges,
  selectTargetExpressions,
} from './planner';
