/**
 * Skill Map + Curriculum Core — public surface (Phase 1).
 *
 * Deterministic domain model + skill catalog + prerequisite graph + planner.
 * Deliberately: no UI, no navigation, no AI, no network, no persistence, no
 * SQLite, no repositories, no numeric mastery score.
 */

export type {
  CurriculumPlan,
  CurriculumPlannerInput,
  CurriculumReason,
  CurriculumReasonCode,
  CurriculumRecommendation,
  LearningGoalHint,
  PlannerSkillStatus,
  PracticeMode,
  SkillDomain,
  SkillEvidenceSnapshot,
  SkillEvidenceSource,
  SkillFragment,
  SkillGraphIssue,
  SkillGraphIssueKind,
  SkillGraphValidation,
  SkillLifecycleState,
  SkillNode,
} from './types';

export {
  CURRICULUM_DOMAINS,
  LEARNING_GOAL_HINTS,
  SKILL_LIFECYCLE_STATES,
} from './types';

export { SKILL_CATALOG, getSkill } from './catalog';

export {
  findPrerequisiteCycle,
  toFragment,
  unresolvedPrerequisites,
  validateSkillGraph,
} from './graph';

export {
  DEFAULT_MAX_ITEMS,
  GOAL_DOMAIN_WEIGHTS,
  isSupportedDomain,
  planCurriculum,
} from './planner';
