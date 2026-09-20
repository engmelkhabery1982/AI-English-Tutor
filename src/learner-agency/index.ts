/**
 * src/learner-agency/index.ts
 *
 * Work Order 2 — the learner-agency layer: conversation help actions,
 * correction intensity, Save to Review, and assessment response coaching.
 *
 * Every capability here is reusable across surfaces by design; screens may
 * only wire these contracts, never re-implement the rules.
 */

export {
  CORRECTION_INTENSITY_OPTIONS,
  CORRECTION_INTENSITY_TO_MODE,
  MODE_TO_CORRECTION_INTENSITY,
  DEFAULT_CORRECTION_INTENSITY,
  TEMPORARY_FEWER_CORRECTIONS,
  isCorrectionIntensity,
  resolveEffectiveConversationMode,
  HELP_ACTION_IDS,
  HELP_ACTION_DESCRIPTORS,
  HELP_ACTION_PROMPT_INSTRUCTIONS,
  PROVIDER_HELP_ACTIONS,
  ASSISTANCE_INSTRUCTION_PREFIX,
  buildHelpInstruction,
  helpActionIsEvidenceSafe,
  isProviderHelpAction,
  resolveHelpControls,
  savedItemReviewPrompt,
  describeSaveSource,
  ASSESSMENT_PRE_GUIDANCE,
  ASSESSMENT_SPEAKING_GUIDANCE,
  SHORT_ANSWER_NUDGES,
  ANSWER_ANYWAY_LABEL,
  MIN_ASSESSMENT_ANSWER_WORDS,
  assessAnswerSubstance,
} from './types';

export type {
  CorrectionIntensity,
  SaveSource,
  SavedItemOrigin,
  VocabularyCategory,
  TemporaryCorrectionOverride,
  HelpActionId,
  HelpActionDescriptor,
  HelpControlInput,
  HelpControls,
  SaveLanguageItemInput,
  SaveLanguageItemResult,
  SavedItemMarker,
} from './types';

export {
  createSaveToReviewService,
  saveRouteForType,
  normalizeSavedText,
} from './save-to-review';
export type {
  SaveToReviewService,
  SaveToReviewServiceOptions,
} from './save-to-review';

export {
  createCorrectionPreferencesService,
} from './correction-preferences';
export type {
  CorrectionPreferencesService,
  CorrectionPreferencesOptions,
  CorrectionPreferenceResult,
} from './correction-preferences';

export {
  createLearnerHelpService,
  HELP_CONFIGURATION_REQUIRED_MESSAGE,
} from './help-service';
export type {
  LearnerHelpService,
  HelpServiceOptions,
  HelpRequestInput,
  HelpServiceResult,
} from './help-service';
