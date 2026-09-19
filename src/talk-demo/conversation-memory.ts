/**
 * src/talk-demo/conversation-memory.ts
 *
 * Conversation Learning Memory (Phase 1): persistent Talk sessions and the
 * qualitative post-conversation review.
 *
 * Design rules (see the feature requirements):
 * - EXISTING persistence only: SQLiteConversationRepository (conversation_sessions
 *   + conversation_turns), SQLiteUserProfileRepository, SQLiteWeaknessRepository
 *   and SQLiteReviewRepository. No new table, no new memory store, no audio.
 * - This module only READS structured evidence for the review. Weakness / review
 *   / vocabulary mutation stays owned by the existing LearningPersistenceService
 *   and the existing vocabulary persistence bridge: a correction is never counted
 *   twice.
 * - Demo (offline) conversations are NOT persisted as real learner memory.
 * - Persistence is exactly-once per conversation identity, independent of React
 *   state: the recorder carries a stable memoryId and marks itself finalized, and
 *   the service additionally collapses concurrent finalizations of the same id.
 */

import { getAppDatabase } from '../data/local/sqlite/app-database';
import type { DatabaseAdapter } from '../data/local/sqlite/DatabaseAdapter';
import {
  SQLiteConversationRepository,
  SQLiteReviewRepository,
  SQLiteUserProfileRepository,
  SQLiteWeaknessRepository,
} from '../data/local/sqlite/repositories';
import { parseFeedbackAndContent } from '../providers/ai/feedback';
import type { ConversationFeedback, ConversationFeedbackVocabulary } from '../providers/ai';
import type { ConversationSession } from '../conversation-session';
import type {
  ConversationMode,
  IsoDate,
  SpeakerRole,
} from '../domain/shared/types';
import type { LearnerWeakness } from '../domain/models/learner';
import type { ReviewItem } from '../domain/models/learning';
import type {
  ConversationRepository,
  ReviewRepository,
  UserProfileRepository,
  WeaknessRepository,
} from '../repositories';
import { generateId } from '../shared/id';
import { nowIso } from '../shared/time';

/** Human-facing notice shown while an offline demo conversation is reviewed. */
export const CONVERSATION_MEMORY_DEMO_NOTICE =
  'Offline demo conversation — nothing from this chat is saved to your learning memory.';

/** Non-blocking notice shown when a real conversation could not be saved. */
export const CONVERSATION_MEMORY_FAILED_NOTICE =
  'This conversation could not be saved. Nothing was lost from the chat itself.';

/** Short message used when an empty conversation produces no memory. */
export const CONVERSATION_MEMORY_EMPTY_NOTICE =
  'Nothing to save from this conversation yet.';

/** Review panel title (learner-facing). */
export const CONVERSATION_REVIEW_TITLE = 'Conversation review';

/** Maximum number of suggestions surfaced per review section. */
const MAX_SECTION_ITEMS = 4;

/** Maximum number of persisted weaknesses surfaced as practice items. */
const MAX_PRACTICE_WEAKNESSES = 3;

/** Maximum number of persisted review items surfaced as practice items. */
const MAX_PRACTICE_REVIEWS = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Recorder: per-conversation identity + structured evidence of committed turns
// ─────────────────────────────────────────────────────────────────────────────

/** One learner-visible turn of the conversation, ready to be persisted. */
export interface ConversationMemoryTurn {
  readonly role: SpeakerRole;
  readonly text: string;
}

/** Structured, already-collected evidence of ONE conversation. */
export interface ConversationMemorySnapshot {
  /** Stable identity of this conversation (exactly-once persistence). */
  readonly memoryId: string;
  readonly mode: ConversationMode;
  readonly topic?: string;
  readonly startedAt: IsoDate;
  readonly endedAt: IsoDate;
  /** Committed turns only — learner instruction/opening text is never included. */
  readonly turns: readonly ConversationMemoryTurn[];
  readonly learnerTurnCount: number;
  readonly feedback: readonly ConversationFeedback[];
  readonly savedVocabulary: readonly ConversationFeedbackVocabulary[];
  /** Real qualitative pronunciation lines, when the existing engine produced any. */
  readonly pronunciationLines: readonly string[];
  /**
   * True only for a real (Gemini) conversation. Offline demo conversations are
   * never persisted as real learner memory.
   */
  readonly isRealAI: boolean;
}

export interface ConversationMemoryRecorder {
  /** Stable identity of the conversation being recorded. */
  readonly memoryId: string;
  readonly startedAt: IsoDate;
  /** Accumulates structured feedback that the EXISTING pipeline committed. */
  noteFeedback(feedback: ConversationFeedback | null | undefined): void;
  /** Real qualitative pronunciation evidence for this conversation. */
  notePronunciationLines(lines: readonly string[] | null | undefined): void;
  /** True when at least one learner turn was committed to the session. */
  hasCommittedLearnerTurn(session: ConversationSession): boolean;
  /** Immutable snapshot of the committed conversation (reads the session). */
  snapshot(input: {
    readonly session: ConversationSession;
    readonly isRealAI: boolean;
    readonly endedAt?: IsoDate;
  }): ConversationMemorySnapshot;
  /** Marks the conversation as persisted for the given domain session id. */
  markFinalized(domainSessionId: string | null): void;
  /** The domain session id once persisted, otherwise null. */
  finalizedSessionId(): string | null;
  /** True once a finalization attempt fully persisted this conversation. */
  isFinalized(): boolean;
}

/** Creates the recorder for ONE new conversation identity (one per session). */
export function createConversationMemoryRecorder(options?: {
  readonly memoryId?: string;
  readonly startedAt?: IsoDate;
}): ConversationMemoryRecorder {
  const memoryId = options?.memoryId ?? generateId();
  const startedAt = options?.startedAt ?? nowIso();
  const feedback: ConversationFeedback[] = [];
  let lastNotedFeedback: ConversationFeedback | null = null;
  let pronunciationLines: readonly string[] = [];
  let persistedSessionId: string | null = null;
  let persisted = false;

  return {
    memoryId,
    startedAt,

    noteFeedback(next: ConversationFeedback | null | undefined): void {
      if (!next) return;
      // Idempotent for the SAME feedback object: a UI rerender can re-run the
      // effect that reports committed feedback, but evidence is never doubled.
      if (next === lastNotedFeedback) return;
      lastNotedFeedback = next;
      feedback.push(next);
    },

    notePronunciationLines(lines: readonly string[] | null | undefined): void {
      if (!lines || lines.length === 0) return;
      pronunciationLines = [...lines];
    },

    hasCommittedLearnerTurn(session: ConversationSession): boolean {
      return session.getHistory().some((turn) => turn.role === 'user');
    },

    snapshot(input): ConversationMemorySnapshot {
      const config = input.session.getConfig();
      const topic =
        typeof config.topic === 'string' && config.topic.trim().length > 0
          ? config.topic.trim()
          : null;
      const turns: ConversationMemoryTurn[] = input.session.getHistory().map((turn) => ({
        role: turn.role === 'user' ? 'learner' : 'tutor',
        // Tutor replies are persisted learner-facing only: any hidden
        // [FEEDBACK]/JSON block is stripped through the EXISTING parser.
        text: turn.role === 'assistant' ? stripHiddenFeedback(turn.content) : turn.content,
      }));

      const savedVocabulary: ConversationFeedbackVocabulary[] = [];
      for (const item of input.session.getSavedVocabulary()) {
        if (!item?.headword) continue;
        savedVocabulary.push(item);
      }

      return {
        memoryId,
        mode: config.mode,
        ...(topic ? { topic } : {}),
        startedAt,
        endedAt: input.endedAt ?? nowIso(),
        turns,
        learnerTurnCount: turns.filter((turn) => turn.role === 'learner').length,
        feedback: [...feedback],
        savedVocabulary,
        pronunciationLines: [...pronunciationLines],
        isRealAI: input.isRealAI,
      };
    },

    markFinalized(domainSessionId: string | null): void {
      persisted = true;
      persistedSessionId = domainSessionId;
    },

    finalizedSessionId(): string | null {
      return persistedSessionId;
    },

    isFinalized(): boolean {
      return persisted;
    },
  };
}

/** Removes any hidden structured-feedback block from learner-facing text. */
export function stripHiddenFeedback(text: string): string {
  if (!text) return '';
  return parseFeedbackAndContent(text).content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalization: persist the committed conversation through the EXISTING repo
// ─────────────────────────────────────────────────────────────────────────────

export type ConversationFinalizeReason =
  | 'persisted'
  | 'empty'
  | 'demo'
  | 'already-finalized'
  | 'persistence-failed'
  | 'no-profile';

export interface FinalizeConversationResult {
  /** True when the conversation is durably stored as real learner memory. */
  readonly ok: boolean;
  readonly reason: ConversationFinalizeReason;
  readonly domainSessionId?: string;
  readonly turnCount?: number;
  readonly errorMessage?: string;
}

export interface ConversationMemoryService {
  /** Persists ONE conversation exactly once; safe to call repeatedly. */
  finalizeConversation(input: {
    readonly session: ConversationSession;
    readonly recorder: ConversationMemoryRecorder;
    readonly isRealAI: boolean;
    readonly endedAt?: IsoDate;
  }): Promise<FinalizeConversationResult>;
  /** Persisted real conversations for the learner (existing repository read). */
  listRecentConversations(limit?: number): Promise<readonly {
    readonly id: string;
    readonly mode: ConversationMode;
    readonly topic?: string;
    readonly startedAt: IsoDate;
    readonly turnCount: number;
  }[]>;
  /**
   * READ-ONLY evidence for the post-conversation review: weaknesses and review
   * items the EXISTING pipeline already persisted. Nothing is mutated here, so a
   * correction is never counted twice.
   */
  loadReviewEvidence(): Promise<{
    readonly weaknesses: readonly LearnerWeakness[];
    readonly dueReviews: readonly ReviewItem[];
  }>;
}

export interface ConversationMemoryServiceOptions {
  readonly databaseAdapter?: DatabaseAdapter;
  readonly conversationRepository?: ConversationRepository;
  readonly userProfileRepository?: UserProfileRepository;
  readonly weaknessRepository?: WeaknessRepository;
  readonly reviewRepository?: ReviewRepository;
  readonly learnerId?: string;
}

interface ResolvedMemoryDependencies {
  readonly conversationRepo: ConversationRepository;
  readonly weaknessRepo?: WeaknessRepository;
  readonly reviewRepo?: ReviewRepository;
  readonly learnerId: string;
}

/**
 * Deterministic UUID (v4-shaped) derived from the conversation memory identity.
 * The same conversation always maps to the same domain session id, which is what
 * makes retry-safe/idempotent persistence possible without any new table.
 */
export function deriveConversationSessionId(memoryId: string): string {
  const a = fnv1aHex(memoryId, 0x811c9dc5);
  const b = fnv1aHex(memoryId, 0x9e3779b9);
  const c = fnv1aHex(`${memoryId}#2`, 0x85ebca6b);
  const d = fnv1aHex(`${memoryId}#3`, 0xc2b2ae35);
  return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-a${c.slice(0, 3)}-${c.slice(3, 7)}${d}`;
}

/** 32-bit FNV-1a hash rendered as 8 lowercase hex chars (deterministic). */
function fnv1aHex(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Reads a session without throwing (a broken/absent row simply means "none"). */
async function readSession(
  repo: ConversationRepository,
  id: string,
): Promise<{ id: string; status: string } | null> {
  try {
    const session = await repo.getSession(id);
    return session ? { id: session.id, status: session.status } : null;
  } catch {
    return null;
  }
}

function createConversationMemoryService(
  options?: ConversationMemoryServiceOptions,
): ConversationMemoryService {
  let cachedDeps: ResolvedMemoryDependencies | null = null;
  /** In-flight/complete finalizations keyed by conversation memory identity. */
  const finalizations = new Map<string, Promise<FinalizeConversationResult>>();
  let resolvedLearnerId: string | null = options?.learnerId ?? null;

  async function resolveDependencies(): Promise<ResolvedMemoryDependencies | null> {
    if (cachedDeps) return cachedDeps;
    try {
      // Precedence: an explicitly injected adapter/repository first, then the
      // canonical application database owner (never a feature-local second
      // connection to the same file).
      let adapter = options?.databaseAdapter;
      if (!adapter && !options?.conversationRepository) {
        adapter = (await getAppDatabase()).adapter;
      }

      const conversationRepo =
        options?.conversationRepository ?? new SQLiteConversationRepository(adapter!);

      if (!resolvedLearnerId) {
        const profileRepo = options?.userProfileRepository ?? new SQLiteUserProfileRepository(adapter!);
        try {
          const profile = await profileRepo.get();
          resolvedLearnerId = profile?.id ?? null;
        } catch {
          resolvedLearnerId = null;
        }
      }
      if (!resolvedLearnerId) return null;

      cachedDeps = {
        conversationRepo,
        ...(options?.weaknessRepository
          ? { weaknessRepo: options.weaknessRepository }
          : adapter
            ? { weaknessRepo: new SQLiteWeaknessRepository(adapter) }
            : {}),
        ...(options?.reviewRepository
          ? { reviewRepo: options.reviewRepository }
          : adapter
            ? { reviewRepo: new SQLiteReviewRepository(adapter) }
            : {}),
        learnerId: resolvedLearnerId,
      };
      return cachedDeps;
    } catch {
      return null;
    }
  }

  async function persist(
    input: {
      readonly session: ConversationSession;
      readonly recorder: ConversationMemoryRecorder;
      readonly isRealAI: boolean;
      readonly endedAt?: IsoDate;
    },
  ): Promise<FinalizeConversationResult> {
    const snapshot = input.recorder.snapshot({
      session: input.session,
      isRealAI: input.isRealAI,
      ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    });

    // Offline demo tutoring is never stored as real learner memory.
    if (!input.isRealAI) {
      return { ok: false, reason: 'demo' };
    }

    // A meaningful learner conversation needs at least one committed learner
    // turn: a tutor opening alone, a failed STT attempt or a failed AI call is
    // not conversation memory.
    if (snapshot.learnerTurnCount === 0) {
      return { ok: false, reason: 'empty' };
    }

    const deps = await resolveDependencies();
    if (!deps) {
      return {
        ok: false,
        reason: 'no-profile',
        errorMessage: CONVERSATION_MEMORY_FAILED_NOTICE,
      };
    }

    const sessionInput = {
      // Deterministic domain identity: the SAME conversation identity always maps
      // to the SAME session id, so a retry can never create a second session.
      id: deriveConversationSessionId(snapshot.memoryId),
      learnerId: deps.learnerId,
      mode: snapshot.mode,
      ...(snapshot.topic ? { topic: snapshot.topic } : {}),
      ...(snapshot.topic ? { topicSource: 'learner-chosen' as const } : {}),
      status: 'active' as const,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      durationSeconds: Math.max(
        0,
        Math.round(
          (Date.parse(snapshot.endedAt) - Date.parse(snapshot.startedAt)) / 1000,
        ) || 0,
      ),
      turnCount: snapshot.turns.length,
      tags: ['talk'],
    };
    const turnInputs = snapshot.turns.map((turn, index) => ({
      speaker: (turn.role === 'learner' ? 'learner' : 'tutor') as 'learner' | 'tutor',
      text: turn.text,
      turnIndex: index,
      startedAt: snapshot.startedAt as string,
    }));

    try {
      // RESUME FIRST: a previous attempt may have died after committing part (or
      // all) of this conversation. The identity is deterministic, so the existing
      // record is always found instead of creating a duplicate.
      const existing = await readSession(deps.conversationRepo, sessionInput.id);
      if (existing) {
        const existingTurns = (await deps.conversationRepo
          .listTurns(sessionInput.id)
          .catch(() => [])) ?? [];
        const persistedIndexes = new Set(existingTurns.map((turn) => turn.turnIndex));
        const missing = turnInputs.filter((turn) => !persistedIndexes.has(turn.turnIndex));

        if (existing.status === 'completed' && missing.length === 0) {
          // The conversation is already durably complete: claim it, never rewrite.
          input.recorder.markFinalized(existing.id);
          return {
            ok: true,
            reason: 'persisted',
            domainSessionId: existing.id,
            turnCount: existingTurns.length,
          };
        }

        for (const turn of missing) {
          await deps.conversationRepo.addTurn({ sessionId: sessionInput.id, ...turn });
        }
        const completed = await deps.conversationRepo.updateSession(sessionInput.id, {
          status: 'completed',
          endedAt: snapshot.endedAt,
          turnCount: snapshot.turns.length,
        });
        input.recorder.markFinalized(completed.id);
        return {
          ok: true,
          reason: 'persisted',
          domainSessionId: completed.id,
          turnCount: snapshot.turns.length,
        };
      }

      // ATOMIC WRITE when the backend supports it: session + all turns + the
      // completed status land together, or nothing does.
      if (typeof deps.conversationRepo.persistConversation === 'function') {
        const stored = await deps.conversationRepo.persistConversation({
          session: { ...sessionInput, status: 'completed' },
          turns: turnInputs,
        });
        input.recorder.markFinalized(stored.id);
        return {
          ok: true,
          reason: 'persisted',
          domainSessionId: stored.id,
          turnCount: snapshot.turns.length,
        };
      }

      // Retry-safe sequential fallback (backends without atomic writes): the same
      // deterministic id is reused, so a retry resumes instead of duplicating.
      const created = await deps.conversationRepo.createSession(sessionInput);
      for (const turn of turnInputs) {
        await deps.conversationRepo.addTurn({ sessionId: created.id, ...turn });
      }

      const updated = await deps.conversationRepo.updateSession(created.id, {
        status: 'completed',
        endedAt: snapshot.endedAt,
        turnCount: snapshot.turns.length,
      });

      input.recorder.markFinalized(updated.id);
      return {
        ok: true,
        reason: 'persisted',
        domainSessionId: updated.id,
        turnCount: snapshot.turns.length,
      };
    } catch (error: unknown) {
      // Persistence failure must never fabricate success, and never break the
      // live conversation: the caller keeps the chat and surfaces nothing scary.
      return {
        ok: false,
        reason: 'persistence-failed',
        errorMessage:
          error instanceof Error && error.message
            ? error.message
            : CONVERSATION_MEMORY_FAILED_NOTICE,
      };
    }
  }

  return {
    async finalizeConversation(input): Promise<FinalizeConversationResult> {
      // Exactly-once: a conversation that is already stored is never stored again
      // (rerender, second New Chat press, unmount after an explicit end).
      if (input.recorder.isFinalized()) {
        return {
          ok: true,
          reason: 'already-finalized',
          ...(input.recorder.finalizedSessionId()
            ? { domainSessionId: input.recorder.finalizedSessionId()! }
            : {}),
        };
      }

      const key = input.recorder.memoryId;
      const inFlight = finalizations.get(key);
      if (inFlight) return inFlight;

      const pending = persist(input).then((result) => {
        if (!result.ok) {
          // Failed/empty/demo attempts are not latched: a later legitimate
          // finalization of the same conversation may still succeed.
          finalizations.delete(key);
        }
        return result;
      });
      finalizations.set(key, pending);
      return pending;
    },

    async loadReviewEvidence() {
      const deps = await resolveDependencies();
      if (!deps) return { weaknesses: [], dueReviews: [] };
      try {
        const [weaknesses, dueReviews] = await Promise.all([
          deps.weaknessRepo
            ? deps.weaknessRepo.listWeaknesses(deps.learnerId, 20)
            : Promise.resolve([] as readonly LearnerWeakness[]),
          deps.reviewRepo
            ? deps.reviewRepo.listDue(deps.learnerId, nowIso(), 5)
            : Promise.resolve([] as readonly ReviewItem[]),
        ]);
        return { weaknesses, dueReviews };
      } catch {
        return { weaknesses: [], dueReviews: [] };
      }
    },

    async listRecentConversations(limit = 5) {
      const deps = await resolveDependencies();
      if (!deps) return [];
      try {
        const sessions = await deps.conversationRepo.listSessions(deps.learnerId, limit);
        return sessions.map((session) => ({
          id: session.id,
          mode: session.mode,
          ...(session.topic ? { topic: session.topic } : {}),
          startedAt: session.startedAt,
          turnCount: session.turnCount,
        }));
      } catch {
        return [];
      }
    },
  };
}

export { createConversationMemoryService };

// ─────────────────────────────────────────────────────────────────────────────
// Post-conversation review (derived from REAL evidence only, never a score)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE pipeline used by the Talk screen when a conversation ends (New Chat, mode
 * change, leaving Talk):
 *   1. persist the committed conversation exactly once (real AI only),
 *   2. load the persisted evidence the review may show (read-only),
 *   3. build the qualitative review.
 *
 * It never throws: conversation memory must never make the Talk lifecycle fail,
 * and a persistence failure is reported honestly inside the review notice.
 */
export async function finalizeConversationWithReview(input: {
  readonly session: ConversationSession;
  readonly recorder: ConversationMemoryRecorder;
  readonly isRealAI: boolean;
  readonly service: ConversationMemoryService;
  readonly endedAt?: IsoDate;
}): Promise<ConversationReview> {
  const snapshot = input.recorder.snapshot({
    session: input.session,
    isRealAI: input.isRealAI,
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
  });

  try {
    const persistence = await input.service.finalizeConversation({
      session: input.session,
      recorder: input.recorder,
      isRealAI: input.isRealAI,
      ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    });

    if (!input.isRealAI) {
      // Demo: nothing is stored and the review says so plainly.
      return buildConversationReview({ snapshot, persistence });
    }

    const evidence = await input.service.loadReviewEvidence();
    return buildConversationReview({ snapshot, ...evidence, persistence });
  } catch {
    // Failures are reported, never hidden and never fabricated as success.
    return buildConversationReview({
      snapshot,
      persistence: { ok: false, reason: 'persistence-failed', errorMessage: CONVERSATION_MEMORY_FAILED_NOTICE },
    });
  }
}

/** The conversation being replaced, captured before the replacement begins. */
export interface OutgoingConversation {
  readonly session: ConversationSession;
  readonly recorder: ConversationMemoryRecorder;
  readonly isRealAI: boolean;
}

export interface ReplaceConversationWithMemoryInput {
  /** The replacement session that must become active. */
  readonly nextSession: ConversationSession;
  readonly service: ConversationMemoryService;
  /**
   * The outgoing conversation. Its memory snapshot is taken ONLY after the
   * atomic switch below has made it non-writable.
   */
  readonly outgoing?: OutgoingConversation | null;
  /**
   * Atomic session replacement (VoiceSessionCoordinator.switchSession): it
   * invalidates the outgoing generation, abandons the outgoing ConversationSession
   * immediately, then awaits recorder/TTS teardown before installing `nextSession`.
   */
  readonly switchSession?: (
    nextSession: ConversationSession,
  ) => Promise<ConversationSession | null>;
  readonly endedAt?: IsoDate;
}

export interface ReplaceConversationWithMemoryResult {
  /** False when a newer replacement superseded this one (nothing was installed). */
  readonly installed: boolean;
  readonly review: ConversationReview | null;
}

/**
 * The ONE ordering used when a conversation is replaced (New Chat, mode change):
 *
 *   1. capture the outgoing session + recorder + provider identity (caller),
 *   2. BEGIN the atomic replacement, which abandons the outgoing session
 *      immediately and discards its in-flight STT/AI work,
 *   3. AWAIT the teardown boundary (safe switch point),
 *   4. only now take the memory snapshot of the outgoing conversation and
 *      finalize it from its stable, already-committed history,
 *   5. derive its review — the replacement conversation is then activated by the
 *      caller, untouched by review generation.
 *
 * The invariant this enforces: no conversation-memory snapshot is ever taken
 * while the outgoing ConversationSession can still accept a late commit.
 */
export async function replaceConversationWithMemory(
  input: ReplaceConversationWithMemoryInput,
): Promise<ReplaceConversationWithMemoryResult> {
  // 1./2. Atomic replacement first: the outgoing session stops being writable
  // here (abandon + generation invalidation + awaited teardown inside).
  if (input.switchSession) {
    const installed = await input.switchSession(input.nextSession);
    if (installed !== input.nextSession) {
      // Superseded or disposed: a newer replacement owns the coordinator.
      return { installed: false, review: null };
    }
  }

  // 3. The outgoing session is now stable: finalize + review from real evidence.
  const outgoing = input.outgoing;
  if (!outgoing) return { installed: true, review: null };

  const review = await finalizeConversationWithReview({
    session: outgoing.session,
    recorder: outgoing.recorder,
    isRealAI: outgoing.isRealAI,
    service: input.service,
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
  });
  return { installed: true, review };
}

export type ConversationReviewSectionId =
  | 'went-well'
  | 'corrections'
  | 'words'
  | 'pronunciation'
  | 'practice-next';

export interface ConversationReviewSection {
  readonly id: ConversationReviewSectionId;
  readonly title: string;
  readonly items: readonly string[];
}

export interface ConversationReview {
  readonly mode: ConversationMode;
  readonly topic?: string;
  readonly learnerTurnCount: number;
  readonly tutorTurnCount: number;
  /** Only sections with real evidence are present. */
  readonly sections: readonly ConversationReviewSection[];
  readonly hasEvidence: boolean;
  /** Demo reviews are explicitly demo-only and claim no learning memory. */
  readonly isDemo: boolean;
  readonly notice: string;
  readonly persistence: FinalizeConversationResult;
  readonly generatedAt: IsoDate;
}

export interface ConversationReviewEvidence {
  readonly snapshot: ConversationMemorySnapshot;
  /** Weakness evidence ALREADY persisted by the existing pipeline (read-only). */
  readonly weaknesses?: readonly LearnerWeakness[];
  /** Review items ALREADY created by the existing pipeline (read-only). */
  readonly dueReviews?: readonly ReviewItem[];
  readonly persistence?: FinalizeConversationResult;
}

const SECTION_TITLES: Readonly<Record<ConversationReviewSectionId, string>> = {
  'went-well': 'What went well',
  corrections: 'Useful corrections',
  words: 'Words & expressions',
  pronunciation: 'Pronunciation notes',
  'practice-next': 'Practice next',
};

function firstSentences(text: string, limit = MAX_SECTION_ITEMS): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);
}

/**
 * Builds the qualitative review from structured evidence that already exists.
 * It NEVER invents scores, mastery or engagement metrics, and it omits every
 * section without real evidence.
 */
export function buildConversationReview(
  evidence: ConversationReviewEvidence,
): ConversationReview {
  const snapshot = evidence.snapshot;
  const sections: ConversationReviewSection[] = [];

  const corrections = snapshot.feedback
    .map((entry) => entry.correction)
    .filter((correction): correction is NonNullable<typeof correction> =>
      Boolean(correction && correction.original && correction.improved),
    );

  // "What went well" — only real committed turns, and only when at least one
  // learner turn came back without a correction.
  const cleanTurns = Math.max(0, snapshot.learnerTurnCount - corrections.length);
  if (snapshot.learnerTurnCount > 0 && cleanTurns > 0) {
    sections.push({
      id: 'went-well',
      title: SECTION_TITLES['went-well'],
      items: [
        `${cleanTurns} of your ${snapshot.learnerTurnCount} turns were understood without a correction.`,
      ],
    });
  }

  if (corrections.length > 0) {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const correction of corrections) {
      const key = `${correction.original}=>${correction.improved}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const explanation = correction.explanation?.trim();
      items.push(
        `"${correction.original.trim()}" → "${correction.improved.trim()}"${
          explanation ? ` — ${explanation}` : ''
        }`,
      );
      if (items.length >= MAX_SECTION_ITEMS) break;
    }
    if (items.length > 0) {
      sections.push({
        id: 'corrections',
        title: SECTION_TITLES.corrections,
        items,
      });
    }
  }

  // Words & expressions — saved items come from the EXISTING vocabulary
  // persistence path; unsaved ones are explicitly marked as suggestions. The
  // review never saves anything on its own.
  const savedKeys = new Set(
    snapshot.savedVocabulary.map((item) => item.headword.trim().toLowerCase()),
  );
  const wordItems: string[] = [];
  for (const item of snapshot.savedVocabulary) {
    if (!item.headword.trim()) continue;
    const meaning = item.meaning?.trim();
    if (!meaning) continue; // never fabricate a meaning
    wordItems.push(`Saved: "${item.headword.trim()}" — ${meaning}`);
    if (wordItems.length >= MAX_SECTION_ITEMS) break;
  }
  if (wordItems.length < MAX_SECTION_ITEMS) {
    for (const entry of snapshot.feedback) {
      const vocab = entry.vocabulary;
      if (!vocab?.headword?.trim() || !vocab.meaning?.trim()) continue;
      const key = vocab.headword.trim().toLowerCase();
      if (savedKeys.has(key)) continue;
      savedKeys.add(key);
      wordItems.push(`Suggested: "${vocab.headword.trim()}" — ${vocab.meaning.trim()}`);
      if (wordItems.length >= MAX_SECTION_ITEMS) break;
    }
  }
  if (wordItems.length > 0) {
    sections.push({ id: 'words', title: SECTION_TITLES.words, items: wordItems });
  }

  // Pronunciation notes — only real qualitative lines already produced by the
  // existing pronunciation engine (never a fabricated numeric score).
  const pronunciationItems = snapshot.pronunciationLines
    .flatMap((line) => firstSentences(line))
    .filter((line) => line.length > 0)
    .slice(0, MAX_SECTION_ITEMS);
  if (pronunciationItems.length > 0) {
    sections.push({
      id: 'pronunciation',
      title: SECTION_TITLES.pronunciation,
      items: pronunciationItems,
    });
  }

  // Practice next — persisted weaknesses/review items created elsewhere. This
  // module only READS them, so nothing is counted twice.
  const practiceItems: string[] = [];
  const weaknesses = [...(evidence.weaknesses ?? [])]
    .filter((weakness) => !weakness.resolved)
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, MAX_PRACTICE_WEAKNESSES);
  for (const weakness of weaknesses) {
    const label = weakness.notes?.trim();
    practiceItems.push(
      `${weakness.type.replace(/_/g, ' ')}: ${label ? `"${label}"` : weakness.referenceId} (${
        weakness.occurrenceCount
      } time${weakness.occurrenceCount === 1 ? '' : 's'})`,
    );
  }
  const dueReviews = (evidence.dueReviews ?? []).slice(0, MAX_PRACTICE_REVIEWS);
  for (const review of dueReviews) {
    const prompt = review.prompt?.trim();
    if (!prompt) continue;
    practiceItems.push(`Review queued: ${prompt}`);
  }
  if (practiceItems.length > 0) {
    sections.push({
      id: 'practice-next',
      title: SECTION_TITLES['practice-next'],
      items: practiceItems,
    });
  }

  const isDemo = !snapshot.isRealAI;
  const persistence: FinalizeConversationResult =
    evidence.persistence ??
    (isDemo
      ? { ok: false, reason: 'demo' }
      : snapshot.learnerTurnCount === 0
        ? { ok: false, reason: 'empty' }
        : { ok: true, reason: 'persisted' });

  let notice: string;
  if (isDemo) {
    notice = CONVERSATION_MEMORY_DEMO_NOTICE;
  } else if (!persistence.ok && persistence.reason === 'persistence-failed') {
    notice = CONVERSATION_MEMORY_FAILED_NOTICE;
  } else if (!persistence.ok) {
    notice = CONVERSATION_MEMORY_EMPTY_NOTICE;
  } else {
    notice = 'Saved to your learning memory.';
  }

  return {
    mode: snapshot.mode,
    ...(snapshot.topic ? { topic: snapshot.topic } : {}),
    learnerTurnCount: snapshot.learnerTurnCount,
    tutorTurnCount: snapshot.turns.filter((turn) => turn.role === 'tutor').length,
    sections,
    hasEvidence: sections.length > 0,
    isDemo,
    notice,
    persistence,
    generatedAt: nowIso(),
  };
}
