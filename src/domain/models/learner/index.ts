/**
 * src/domain/models/learner/index.ts
 *
 * Learner-model domain interfaces.
 *
 * A "weakness" is NOT just a report entry. It is a persistent,
 * retrainable learner signal that the Learning Engine can later
 * surface in different natural contexts.
 *
 * The data model deliberately supports the full lifecycle:
 *   observed -> repeated -> confirmed -> active_training
 *   -> improving -> stable -> mastered -> relapsed
 *
 * Transitions between states are NOT automated here. The model
 * only represents the state; future learning logic decides when
 * to move.
 */

import type {
  CefrLevelInput,
  ConversationMode,
  EvidenceRef,
  IsoDate,
  Uuid,
  WeaknessStatus,
} from '../../shared/types';

/** The learner's own profile. */
export interface UserProfile {
  readonly id: Uuid;
  readonly displayName: string;
  readonly nativeLanguage?: string;
  readonly targetLanguage: string; // BCP-47-ish, e.g. "en", "en-US"
  readonly targetLevel: CefrLevelInput;
  readonly currentLevel: CefrLevelInput;
  readonly learningGoals: readonly string[];
  readonly preferredModes: readonly ConversationMode[];
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/**
 * A recurring grammar mistake observed across conversations.
 *
 * A grammar mistake is raw evidence. It is NOT automatically a
 * learner weakness. The WeaknessRepository decides whether the
 * accumulated evidence is strong enough to promote it into a
 * LearnerWeakness. That separation lets the system distinguish
 * a one-time slip from a confirmed weakness.
 */
export interface GrammarMistake {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly category: string; // e.g. "for-vs-since", "subject-verb-agreement"
  readonly pattern: string; // e.g. "I live here since 2020"
  readonly correction: string; // e.g. "I have lived here since 2020"
  readonly explanation?: string;
  readonly severity: 'minor' | 'moderate' | 'major';
  readonly occurrenceCount: number;
  readonly lastSeenAt: IsoDate;
  readonly firstSeenAt: IsoDate;
  readonly contexts: readonly string[]; // conversation topics where seen
  readonly exampleTurnIds: readonly Uuid[];
  /** Optional session/turn provenance for the most recent occurrence. */
  readonly originSessionId?: Uuid;
  readonly originTurnId?: Uuid;
  readonly resolved: boolean;
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/**
 * A recurring pronunciation weakness.
 *
 * NOTE: This is a target sound/feature, NOT a pronunciation score.
 * No fabricated scores are produced anywhere in the app.
 */
export interface PronunciationWeakness {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly targetSound: string; // e.g. "θ", "the /ɪ/ vs /iː/ distinction"
  readonly wordExamples: readonly string[];
  readonly occurrenceCount: number;
  readonly lastSeenAt: IsoDate;
  readonly firstSeenAt: IsoDate;
  readonly contexts: readonly string[];
  readonly exampleTurnIds: readonly Uuid[];
  readonly originSessionId?: Uuid;
  readonly originTurnId?: Uuid;
  readonly resolved: boolean;
  readonly notes?: string;
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/**
 * A persistent learner weakness (generic signal).
 *
 * Carries the full lifecycle status plus explicit evidence
 * references so a future algorithm can explain the
 * classification. The `occurrenceCount` and `evidence` are
 * complementary: count is a summary, evidence is the audit trail.
 */
export interface LearnerWeakness {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly type:
    | 'grammar'
    | 'pronunciation'
    | 'vocabulary'
    | 'listening'
    | 'fluency'
    | 'natural_expression'
    | 'confidence';
  readonly referenceId: Uuid; // points to GrammarMistake / PronunciationWeakness / VocabularyItem id
  readonly status: WeaknessStatus;
  readonly severity: number; // 0..1
  readonly occurrenceCount: number;
  readonly lastSeenAt: IsoDate;
  readonly firstSeenAt: IsoDate;
  readonly contexts: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly notes?: string;
  readonly resolved: boolean;
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/** A persistent learner strength. */
export interface LearnerStrength {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly type:
    | 'grammar'
    | 'pronunciation'
    | 'vocabulary'
    | 'listening'
    | 'fluency'
    | 'natural_expression'
    | 'confidence';
  readonly referenceId: Uuid;
  readonly confidence: number; // 0..1
  readonly lastSeenAt: IsoDate;
  readonly firstSeenAt: IsoDate;
  readonly contexts: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly notes?: string;
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/** Hesitation / fluency observation for a turn. */
export interface FluencyObservation {
  readonly turnId: Uuid;
  readonly learnerId: Uuid;
  readonly fillers: number; // "um", "uh", "like", etc.
  readonly longPauses: number;
  readonly selfCorrections: number;
  readonly restarts: number;
  readonly wordsPerMinute?: number;
  readonly hesitationScore: number; // 0..1, higher = more hesitant
  readonly observedAt: IsoDate;
}

export type { CefrLevelInput as Cefr, ConversationMode };