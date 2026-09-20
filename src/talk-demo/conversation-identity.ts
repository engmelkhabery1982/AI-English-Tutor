/**
 * src/talk-demo/conversation-identity.ts
 *
 * ONE decision function for "does the Talk surface need a NEW conversation?"
 *
 * WHY THIS EXISTS (real-device bug: "This conversation was replaced before the
 * turn finished")
 * The Talk screen used to compose a fresh conversation from an effect that
 * depended on the topic TEXT FIELD. While the conversation was still empty — that
 * is, exactly while the tutor's opening turn was in flight — every keystroke
 * produced a new "identity" and therefore a new session switch, which abandoned
 * the session the in-flight turn belonged to. The learner then read that the
 * conversation was replaced, and their turn was discarded.
 *
 * THE RULES ENCODED HERE
 * 1. A typed topic is a DRAFT. It never replaces a conversation by itself; the
 *    learner applies it explicitly (Start with this topic) or starts a New Chat.
 * 2. Identity is stable while a turn is in flight: nothing is replaced while the
 *    learner is sending, the tutor is opening, a switch is running, or voice work
 *    is active. The decision simply defers; it re-runs once the turn settles.
 * 3. A LIVE conversation (any committed history) is never replaced implicitly.
 * 4. A fresh identity is composed only when nothing else owns the surface yet.
 *
 * This module is pure (no React, no I/O) so the lifecycle rules are testable
 * without a renderer, and the screen keeps exactly one composition path.
 */

import type { ConversationMode } from '../conversation-session';

/** Separator of the composed identity (`mode::topic`). */
export const CONVERSATION_IDENTITY_SEPARATOR = '::';

/**
 * Calm, learner-safe notice used when a conversation that was already closed had
 * to be replaced before a learner turn could run. It never blames the learner and
 * never claims work was lost when it was not.
 */
export const TALK_CONVERSATION_RESTARTED_MESSAGE =
  'That conversation had already ended, so I opened a fresh one.';

/** Same notice for the microphone path, where the learner must speak again. */
export const TALK_CONVERSATION_RESTARTED_MIC_MESSAGE =
  'That conversation had already ended, so I opened a fresh one. Tap the microphone when you are ready.';

/**
 * Normalizes a topic draft so that whitespace-only edits cannot look like a new
 * conversation identity (and therefore cannot trigger a replacement).
 */
export function normalizeTopicDraft(topic: string | null | undefined): string {
  return (typeof topic === 'string' ? topic : '').trim().replace(/\s+/g, ' ');
}

/** The stable identity of a composed conversation. */
export function conversationIdentity(mode: ConversationMode, topic: string): string {
  return `${mode}${CONVERSATION_IDENTITY_SEPARATOR}${normalizeTopicDraft(topic)}`;
}

/** True when the typed draft differs from the topic the conversation was built with. */
export function hasUnappliedTopicDraft(draft: string, appliedTopic: string): boolean {
  return normalizeTopicDraft(draft) !== normalizeTopicDraft(appliedTopic);
}

/** Why no new conversation is composed right now. */
export type ConversationIdentityReason =
  /** The real coaching context has not resolved yet: composing now would guess. */
  | 'coaching-unresolved'
  /** The active conversation already has this exact identity. */
  | 'already-composed'
  /** The conversation is live (committed history): only an explicit action replaces it. */
  | 'live-conversation'
  /** A learner/tutor turn is in flight: identity stays stable until it settles. */
  | 'turn-in-flight';

export type ConversationIdentityDecision =
  | { readonly action: 'none'; readonly reason: ConversationIdentityReason }
  | { readonly action: 'compose'; readonly identity: string };

export interface ConversationIdentityInput {
  readonly mode: ConversationMode;
  /** The topic the ACTIVE conversation was composed with (never the raw draft). */
  readonly appliedTopic: string;
  /** Identity currently composed by the surface, or null before the first one. */
  readonly composedIdentity: string | null;
  /** Committed turns of the live conversation. */
  readonly historyLength: number;
  /**
   * True while ANY turn work is unresolved: sending, the tutor opening, a session
   * switch, recording, transcription or playback of a learner turn.
   */
  readonly turnInFlight: boolean;
  /** True once the real persisted coaching context has resolved. */
  readonly coachingResolved: boolean;
}

/**
 * Decides whether a NEW conversation must be composed. Pure and side-effect free:
 * the caller performs the (existing) atomic switch when — and only when — this
 * returns `compose`.
 */
export function resolveConversationIdentity(
  input: ConversationIdentityInput,
): ConversationIdentityDecision {
  if (!input.coachingResolved) {
    return { action: 'none', reason: 'coaching-unresolved' };
  }

  const identity = conversationIdentity(input.mode, input.appliedTopic);
  if (input.composedIdentity !== null && input.composedIdentity === identity) {
    return { action: 'none', reason: 'already-composed' };
  }

  // A conversation with committed history is LIVE: it is replaced only by an
  // explicit learner action (New Chat, mode change, Apply topic), never by an
  // implicit re-run of this decision.
  if (input.historyLength > 0) {
    return { action: 'none', reason: 'live-conversation' };
  }

  // Identity stays stable while a turn is unresolved. Replacing now would abandon
  // the session the in-flight turn belongs to and discard the learner's work.
  if (input.turnInFlight) {
    return { action: 'none', reason: 'turn-in-flight' };
  }

  return { action: 'compose', identity };
}

/**
 * Whether an explicit learner turn may start on the conversation this surface
 * shows. A session that was closed (for example by the background policy) can
 * only discard a turn, so the honest action is to compose a fresh conversation
 * with the SAME identity first and keep the learner's input.
 */
export function isConversationReusable(session: {
  isAbandoned?(): boolean;
} | null): boolean {
  if (!session) return false;
  return session.isAbandoned?.() !== true;
}
