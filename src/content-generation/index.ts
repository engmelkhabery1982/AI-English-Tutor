/**
 * src/content-generation/index.ts
 *
 * WP-1 public surface of the shared content contract + the controlled
 * content transformer.
 *
 * Owned responsibilities: request normalization/validation, strict material
 * validation, honest provenance and the request → material transform through
 * the EXISTING AIProvider abstraction.
 *
 * Deliberately NOT owned here: evidence assembly, skill/weakness selection,
 * persistence, scheduling and text evaluation (all stay with the owning
 * engine, e.g. the listening engine).
 */

export type {
  ContentContext,
  ContentGenerationFailure,
  ContentRequest,
  ContentRequestBuildResult,
  ContentRequestInput,
  ContentRequestRejection,
  ContentTargetSkill,
  ContentTaskType,
  ControlledMaterialResult,
  GeneratedMaterial,
  GenerationValidationIssue,
  GenerationValidationResult,
  MaterialProvenance,
} from './types';

export { CONTENT_REQUEST_BOUNDS, CONTENT_TASK_TYPES } from './types';

export {
  CONTENT_REQUEST_KEY_VERSION,
  buildContentRequest,
  canonicalContentRequestIdentity,
  compareStrings,
  hasSupportedProfessionalContext,
  normalizeTermList,
} from './request';

export {
  extractJsonObject,
  resolveMaterialProvenance,
  validateGeneratedMaterial,
} from './validation';

export { buildMaterialPrompt, generateControlledMaterial } from './transformer';
