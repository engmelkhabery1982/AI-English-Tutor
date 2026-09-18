/**
 * src/learning-progression/index.ts
 *
 * WP-1 foundation: deterministic learning progression.
 *
 * Public surface:
 * - the DifficultyProfile types + the pure domain-aware resolver,
 * - the shared, deterministic curriculum evidence projection,
 * - the stable-key digest shared by generated content.
 *
 * Everything here is pure. Nothing in this module reads repositories, calls
 * AI, reads the clock, mutates learner evidence or persists anything.
 */

export type {
  DifficultyProfile,
  DiscourseLength,
  GrammarComplexity,
  LearnerProgressionEvidence,
  ProgressionLevel,
  ProgressionWeaknessEvidence,
  SpeechStyle,
  SupportLevel,
  TextRegister,
  SentenceShape,
  ContractionDensity,
  LexicalStyle,
} from './types';

export {
  isUrgentNegativeStatus,
  toProgressionEvidence,
  urgentNegativeEvidenceCount,
  hasUrgentNegativeEvidence,
  weaknessTypeToDomain,
  URGENT_NEGATIVE_STATUSES,
} from './evidence';

export {
  CONSERVATIVE_DIFFICULTY_PROFILE,
  DISCOURSE_LENGTH_ORDER,
  GRAMMAR_COMPLEXITY_ORDER,
  SUPPORT_LEVEL_ORDER,
  isKnownLevel,
  resolveDifficultyProfile,
} from './difficulty';

export {
  CURRICULUM_EVIDENCE_MAPPINGS,
  NEVER_PROJECTED_SKILL_IDS,
  PROJECTED_SKILL_IDS,
  PROJECTION_ACTIVE_STATES,
  LIFECYCLE_URGENCY,
  activeDifficultySkillIds,
  lifecycleFromMasteryState,
  lifecycleUrgency,
  projectCurriculumEvidence,
  pronunciationMappingFor,
} from './curriculum-projection';

export type {
  CurriculumEvidenceInput,
  CurriculumEvidenceMapping,
  EvidenceMappingSource,
  EvidenceMappingStatus,
} from './curriculum-projection';

export { stableKey } from './stable-key';
