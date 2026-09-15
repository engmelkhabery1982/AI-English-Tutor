/**
 * src/domain/models/conversation/index.ts
 *
 * Conversation domain interfaces.
 */

import type {
  ConversationMode,
  CefrLevel,
  IsoDate,
  SpeakerRole,
  Uuid,
} from '../../shared/types';

/** Status of a conversation session. */
export type SessionStatus = 'active' | 'completed' | 'abandoned' | 'summarized';

/** One speaker turn inside a conversation. */
export interface ConversationTurn {
  readonly id: Uuid;
  readonly sessionId: Uuid;
  readonly speaker: SpeakerRole;
  readonly text: string;
  readonly audioRef?: string; // local file path or blob ref for playback
  readonly detectedLanguage?: string; // e.g. "en", "es"
  readonly turnIndex: number;
  readonly startedAt: IsoDate;
  readonly endedAt?: IsoDate;
  readonly durationMs?: number;
  readonly confidence?: number; // STT confidence, 0..1
  /** Free-form metadata for future analysis (not raw audio). */
  readonly metadata?: Record<string, unknown>;
}

/** A single conversation session. */
export interface ConversationSession {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly mode: ConversationMode;
  readonly title?: string;
  readonly topic?: string;
  readonly topicSource?: 'learner-chosen' | 'ai-suggested' | 'free';
  readonly status: SessionStatus;
  readonly startedAt: IsoDate;
  readonly endedAt?: IsoDate;
  readonly durationSeconds?: number;
  readonly difficulty?: CefrLevel;
  readonly turnCount: number;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly createdAt: IsoDate;
  readonly updatedAt: IsoDate;
}

/** Lightweight reference to a past session (for "continue previous"). */
export interface ConversationSessionSummary {
  readonly id: Uuid;
  readonly learnerId: Uuid;
  readonly mode: ConversationMode;
  readonly title?: string;
  readonly topic?: string;
  readonly status: SessionStatus;
  readonly startedAt: IsoDate;
  readonly endedAt?: IsoDate;
  readonly turnCount: number;
}