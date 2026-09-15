/**
 * src/config/index.ts
 *
 * Application configuration constants.
 *
 * Vendor-neutral. No provider SDKs are referenced here.
 */

/** Default conversation modes supported by the app. */
export const CONVERSATION_MODES = ['natural', 'coach', 'intensive'] as const;

/** Default CEFR levels. */
export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

/** Default vocabulary mastery states. */
export const MASTERY_STATES = [
  'new',
  'learning',
  'familiar',
  'mastered',
  'struggling',
  'retired',
] as const;

/** App metadata. */
export const APP_CONFIG = {
  name: 'AI English Tutor',
  version: '1.0.0',
  defaultTargetLevel: 'B1',
  defaultConversationMode: 'natural',
} as const;