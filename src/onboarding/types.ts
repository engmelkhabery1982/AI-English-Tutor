/**
 * src/onboarding/types.ts
 *
 * Personalized Onboarding & Diagnostic Assessment (Phase 1) — provider-neutral
 * types.
 *
 * CORE PRINCIPLES
 * - No second assessment engine: the diagnostic drives the EXISTING
 *   ConversationEngine / ListeningService / PronunciationEngine, and every piece
 *   of persisted evidence goes through the EXISTING owners (profile repository,
 *   LearningPersistenceService, listening/pronunciation persistence).
 * - No numeric judgement wording anywhere: no fluency or pronunciation figure,
 *   no fake precision attached to a level, no XP, stars or streaks.
 * - The level estimate is an ESTIMATED WORKING LEVEL for personalization — never
 *   an official CEFR result, and never fabricated when evidence is thin.
 */

import type { CefrLevelInput, ConversationMode, IsoDate, Uuid } from '../domain/shared/types';

// ─────────────────────────────────────────────────────────── onboarding profile

/**
 * Stable ids for the learning-goal choices. They are persisted as the SAME plain
 * `learningGoals` strings the existing UserProfile already stores — no new
 * profile field, no new table.
 */
export type LearningGoalId =
  | 'everyday-conversation'
  | 'work-professional'
  | 'meetings'
  | 'presentations'
  | 'interviews'
  | 'travel'
  | 'listening-comprehension'
  | 'pronunciation'
  | 'vocabulary-expressions'
  | 'confidence-fluency';

export interface LearningGoalOption {
  readonly id: LearningGoalId;
  /** Learner-facing label (also the persisted goal string). */
  readonly label: string;
}

/** The bounded, curated goal set shown during onboarding. */
export const LEARNING_GOAL_OPTIONS: readonly LearningGoalOption[] = [
  { id: 'everyday-conversation', label: 'Everyday conversation' },
  { id: 'work-professional', label: 'Work / professional communication' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'presentations', label: 'Presentations' },
  { id: 'interviews', label: 'Interviews' },
  { id: 'travel', label: 'Travel' },
  { id: 'listening-comprehension', label: 'Listening comprehension' },
  { id: 'pronunciation', label: 'Pronunciation' },
  { id: 'vocabulary-expressions', label: 'Vocabulary / expressions' },
  { id: 'confidence-fluency', label: 'Confidence / fluency' },
];

/** Native languages the app explicitly supports in the picker (BCP-47-ish). */
export interface NativeLanguageOption {
  readonly code: string;
  readonly label: string;
}

export const NATIVE_LANGUAGE_OPTIONS: readonly NativeLanguageOption[] = [
  { code: 'ar', label: 'Arabic' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'hi', label: 'Hindi' },
  { code: 'id', label: 'Indonesian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'tl', label: 'Filipino' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ur', label: 'Urdu' },
  { code: 'zh', label: 'Chinese' },
];

/**
 * ONE fixed, bounded pronunciation diagnostic task.
 *
 * The learner hears this exact English sentence and repeats it. Pronunciation is
 * transcript/evidence based: the EXISTING PronunciationEngine compares the
 * learner's real transcript with this known target (`expectedText`). There is no
 * acoustic or phoneme analysis here, and no numeric score of any kind.
 */
export interface PronunciationTask {
  readonly id: string;
  /** The exact sentence the learner hears and repeats (the engine's target). */
  readonly sentence: string;
}

/** The learner's own report collected during onboarding. */
export interface OnboardingProfileDraft {
  readonly displayName?: string;
  readonly nativeLanguage?: string;
  readonly targetLevel: CefrLevelInput;
  readonly learningGoals: readonly string[];
  readonly preferredModes: readonly ConversationMode[];
}

/**
 * Current persisted profile + what is still missing. Existing values are ALWAYS
 * prefilled from here; nothing is overwritten silently.
 */
export interface OnboardingPrefill {
  /** Null when no profile row exists yet (a brand-new install). */
  readonly profileId: Uuid | null;
  readonly displayName: string;
  readonly nativeLanguage: string | null;
  readonly targetLevel: CefrLevelInput;
  readonly currentLevel: CefrLevelInput;
  readonly learningGoals: readonly string[];
  readonly preferredModes: readonly ConversationMode[];
  /** True when a usable learning profile already exists. */
  readonly isComplete: boolean;
  /** Learner-facing labels of the still-missing profile pieces (empty when complete). */
  readonly missingFields: readonly string[];
  /** True when any meaningful profile data already existed (no silent overwrite). */
  readonly hasExistingData: boolean;
}

// ────────────────────────────────────────────────────────────── diagnostic flow

/**
 * The bounded diagnostic sequence. Deterministic: the state machine in
 * session.ts owns the transitions — screens never decide them.
 */
export type DiagnosticStepId =
  | 'profile'
  | 'speaking'
  | 'listening'
  | 'language_use'
  | 'pronunciation'
  | 'summary';

export type DiagnosticStepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'unavailable';

export interface DiagnosticStepSnapshot {
  readonly id: DiagnosticStepId;
  readonly status: DiagnosticStepStatus;
  /** Honest reason when a step could not run (never presented as a failure). */
  readonly unavailableReason?: string;
}

export type DiagnosticStatus = 'in_progress' | 'completed' | 'abandoned';

/** Provenance of one piece of diagnostic evidence. */
export type DiagnosticProvenance = 'real' | 'demo';

// ────────────────────────────────────────────────────────────────── evidence

/** Structured outcome of the speaking part (existing feedback semantics only). */
export interface DiagnosticSpeakingEvidence {
  readonly provenance: DiagnosticProvenance;
  /** Learner turns that were actually committed by the existing session. */
  readonly committedLearnerTurns: number;
  /** Tutor turns that were actually committed. */
  readonly committedTutorTurns: number;
  /** Corrections the EXISTING engine reported, by its own severity values. */
  readonly incorrectCorrections: number;
  readonly unnaturalCorrections: number;
  /** Turns the learner produced with no correction at all. */
  readonly naturalTurns: number;
  /** Short, real notes derived from the engine's correction explanations (bounded). */
  readonly correctionNotes: readonly string[];
}

/** Structured outcome of one listening task (existing ListeningResultCategory). */
export interface DiagnosticListeningEvidence {
  readonly answered: number;
  readonly understood: number;
  readonly mostlyUnderstood: number;
  readonly partial: number;
  readonly missedKeyMeaning: number;
  /** How the existing listening evaluator judged the answers. */
  readonly evaluatedBy: 'local' | 'ai' | 'unavailable';
  readonly unavailableReason?: string;
}

/** Structured outcome of the grammar / naturalness task. */
export type LanguageUseOutcome = 'natural' | 'unnatural' | 'incorrect';

export interface DiagnosticLanguageUseEvidence {
  readonly provenance: DiagnosticProvenance;
  readonly answered: number;
  readonly natural: number;
  readonly unnatural: number;
  readonly incorrect: number;
  /** Real correction notes from the EXISTING engine (bounded). */
  readonly notes: readonly string[];
}

/** Real, qualitative pronunciation observations (never invented numbers). */
export interface DiagnosticPronunciationEvidence {
  readonly observed: boolean;
  readonly noteLines: readonly string[];
  readonly unavailableReason?: string;
}

export interface DiagnosticEvidence {
  readonly speaking: DiagnosticSpeakingEvidence | null;
  readonly listening: DiagnosticListeningEvidence | null;
  readonly languageUse: DiagnosticLanguageUseEvidence | null;
  readonly pronunciation: DiagnosticPronunciationEvidence | null;
}

// ──────────────────────────────────────────────────────────────── assessment

/**
 * Confidence is derived DETERMINISTICALLY from evidence coverage (how many real
 * dimensions were actually observed) — never from AI self-confidence.
 */
export type DiagnosticConfidence = 'limited' | 'moderate' | 'strong';

/**
 * The provisional working level.
 * - `status: 'estimated'` → `level` is a real CEFR level.
 * - `status: 'insufficient'` → `level` stays `'unknown'`: nothing is invented.
 */
export interface DiagnosticLevelEstimate {
  readonly status: 'estimated' | 'insufficient';
  readonly level: CefrLevelInput;
  readonly confidence: DiagnosticConfidence;
  /** Learner-facing, evidence-only reasons for the estimate (no numbers-as-scores). */
  readonly basis: readonly string[];
}

export interface DiagnosticResult {
  readonly learnerId: Uuid;
  readonly generatedAt: IsoDate;
  readonly estimate: DiagnosticLevelEstimate;
  /** Descriptive positive observations from successful real evidence. */
  readonly strengths: readonly string[];
  /** Areas to practice, derived only from real recorded corrections. */
  readonly focusAreas: readonly string[];
  readonly speakingLine: string;
  readonly listeningLine: string;
  /** Only when real pronunciation analysis actually produced observations. */
  readonly pronunciationLines: readonly string[] | null;
  readonly recommendedFocus: string;
  /** Honest notes (demo-only evidence, unavailable parts, incomplete steps). */
  readonly notices: readonly string[];
  readonly profile: {
    readonly displayName: string;
    readonly targetLevel: CefrLevelInput;
    /** The level the learner already had — never silently replaced. */
    readonly currentLevel: CefrLevelInput;
    readonly learningGoals: readonly string[];
    readonly preferredModes: readonly ConversationMode[];
  };
}

/** Outcome of an explicit profile level change (accept / keep). */
export interface DiagnosticLevelDecision {
  readonly updated: boolean;
  readonly currentLevel: CefrLevelInput;
  readonly reason: 'accepted' | 'already-accepted' | 'kept' | 'not-estimated' | 'persistence-failed';
}
