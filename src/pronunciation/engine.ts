/**
 * src/pronunciation/engine.ts
 *
 * PronunciationEngine (Phase 1): turns provider observations into
 * persisted, deduplicated evidence that feeds the EXISTING learner-weakness
 * lifecycle and the EXISTING Adaptive Review system.
 *
 * - Dedup identity: "<observation type>:<normalized target>" so repeated
 *   evidence increments occurrence data instead of creating duplicates.
 * - Pronunciation-specific evidence lives in the existing
 *   pronunciation_weaknesses table; the generic lifecycle lives in the
 *   existing learner_weaknesses table (type 'pronunciation', same states:
 *   observed → repeated → confirmed → …, conservative, no shortcuts).
 * - A pending review item (kind 'pronunciation') is scheduled through the
 *   existing review repository so the Review tab can retrain the issue.
 * - Analysis/persistence failures are non-destructive: the caller's
 *   conversation flow continues untouched.
 */

import type { ConversationMode, IsoDate, WeaknessStatus } from '../domain/shared/types';
import type { LearnerWeakness, PronunciationWeakness } from '../domain/models/learner';
import type {
  PronunciationObservationInput,
  PronunciationObservationRecord,
  PronunciationRepository,
  UserProfileRepository,
  VocabularyRepository,
  WeaknessRepository,
} from '../repositories';
import type { ReviewRepository } from '../repositories';
import type {
  PronunciationAnalysis,
  PronunciationObservation,
  PronunciationProvider,
  PronunciationTurnOutcome,
} from './types';
import { buildPronunciationFeedback } from './feedback';

/** Stable dedup identity for an observation: issue type + normalized target. */
export function observationIdentity(observation: PronunciationObservation): string {
  const target = (observation.target ?? observation.description)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
  return `${observation.type}:${target}`;
}

/** Max observations persisted per turn — never flood storage. */
const MAX_PERSISTED_PER_TURN = 3;

export interface PronunciationEngineDeps {
  readonly provider: PronunciationProvider;
  readonly pronunciation: {
    /** Deduplicating observation recorder (existing repository method). */
    readonly recordObservation: (
      input: PronunciationObservationInput,
    ) => Promise<PronunciationObservationRecord>;
    readonly listWeaknesses?: PronunciationRepository['listWeaknesses'];
  };
  readonly weaknesses: Pick<WeaknessRepository, 'listWeaknesses' | 'upsertWeakness' | 'addWeaknessEvidence'>;
  /** Existing review repository — schedules retraining through the Review system. */
  readonly review?: Pick<ReviewRepository, 'listDue' | 'upsert'>;
  /** Existing profile repository — the only source of the learner id. */
  readonly profile?: Pick<UserProfileRepository, 'get'>;
  /** Existing lexical repositories — links evidence to saved items, never duplicates them. */
  readonly vocabulary?: Pick<VocabularyRepository, 'list'>;
}

export class PronunciationEngine {
  constructor(private readonly deps: PronunciationEngineDeps) {}

  /** Identifier of the composed provider (transparency for tests/UI). */
  get providerId(): string {
    return this.deps.provider.id;
  }

  /** Resolve the active learner via the existing profile repository (never fabricated). */
  async getActiveLearnerId(): Promise<string | null> {
    if (!this.deps.profile) return null;
    try {
      const profile = await this.deps.profile.get();
      if (profile && profile.id) return profile.id;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Analyze one spoken turn and persist meaningful observations.
   * Returns null when there is no learner or analysis was skipped;
   * never throws into the conversation flow.
   */
  async analyzeSpokenTurn(input: {
    transcript: string;
    expectedText?: string;
    context?: string;
    mode?: ConversationMode;
    now?: IsoDate;
  }): Promise<PronunciationTurnOutcome | null> {
    const mode = input.mode ?? 'coach';
    const at = input.now ?? new Date().toISOString();

    const learnerId = await this.getActiveLearnerId();
    if (!learnerId || !input.transcript.trim()) return null;

    let analysis: PronunciationAnalysis;
    try {
      analysis = await this.deps.provider.analyze({
        learnerId,
        transcript: input.transcript,
        expectedText: input.expectedText,
        context: input.context,
      });
    } catch {
      // Provider failure is non-destructive: conversation continues,
      // no fabricated pronunciation result is shown or persisted.
      return {
        analysis: {
          provider: this.deps.provider.id,
          evidenceLevel: 'transcript_comparison',
          observations: [],
          insufficientEvidence: true,
          notes: 'Pronunciation analysis was unavailable for this turn.',
        },
        feedbackLines: [],
        unavailable: true,
      };
    }

    // Persist only evidence-backed observations (never inference-only entries).
    const persistable = analysis.observations
      .filter((o) => !o.inferenceOnly && !analysis.insufficientEvidence)
      .slice(0, MAX_PERSISTED_PER_TURN);

    if (persistable.length > 0) {
      try {
        // Bounded reads ONCE per turn — no N+1 queries.
        const [existingWeaknesses, dueItems, lexicalLinks] = await Promise.all([
          this.deps.weaknesses.listWeaknesses(learnerId, 100),
          this.deps.review?.listDue
            ? this.deps.review.listDue(learnerId, at)
            : Promise.resolve([]),
          this.resolveLexicalLinks(learnerId, persistable),
        ]);
        for (const observation of persistable) {
          await this.persistObservation(learnerId, observation, existingWeaknesses, dueItems, {
            at,
            lexicalItemId: lexicalLinks.get(observation.target?.toLowerCase().trim() ?? ''),
            context: input.context,
          });
        }
      } catch {
        // Persistence failure must not corrupt the conversation flow.
      }
    }

    return {
      analysis,
      feedbackLines: buildPronunciationFeedback(analysis, mode),
      unavailable: false,
    };
  }

  /**
   * Resolve saved vocabulary/expression links for observation targets.
   * One bounded read per turn; never creates vocabulary records.
   */
  private async resolveLexicalLinks(
    learnerId: string,
    observations: readonly PronunciationObservation[],
  ): Promise<Map<string, string>> {
    const links = new Map<string, string>();
    if (!this.deps.vocabulary) return links;

    const targets = observations
      .map((o) => o.target?.toLowerCase().trim())
      .filter((t): t is string => Boolean(t));
    if (targets.length === 0) return links;

    const saved = await this.deps.vocabulary.list(learnerId, { limit: 500 });
    for (const item of saved) {
      const key = item.headword.toLowerCase().trim();
      if (targets.includes(key)) {
        links.set(key, item.id);
      }
    }
    return links;
  }

  /**
   * Persist one observation: pronunciation-specific evidence (deduped by
   * identity) + conservative learner-weakness lifecycle + review scheduling.
   */
  private async persistObservation(
    learnerId: string,
    observation: PronunciationObservation,
    existingWeaknesses: readonly LearnerWeakness[],
    dueReviewItems: readonly { referenceId: string }[],
    opts: { at: IsoDate; lexicalItemId?: string; context?: string },
  ): Promise<void> {
    const identity = observationIdentity(observation);
    const target = observation.target ?? identity;

    // ---- Pronunciation-specific evidence (deduped by identity) ----
    const record = await this.deps.pronunciation.recordObservation({
      learnerId,
      identity,
      target,
      exampleText: observation.observed ?? observation.description,
      context: opts.lexicalItemId ? `lexical:${opts.lexicalItemId}` : undefined,
      at: opts.at,
    });

    // ---- Existing learner-weakness lifecycle (conservative) ----
    const existing = existingWeaknesses.find(
      (w) =>
        w.type === 'pronunciation' &&
        !w.resolved &&
        (w.referenceId === record.weakness.id || w.notes?.trim().toLowerCase() === identity),
    );

    let nextStatus: WeaknessStatus = 'observed';
    if (existing) {
      if (existing.status === 'stable' || existing.status === 'mastered') {
        nextStatus = 'relapsed';
      } else if (existing.status === 'observed') {
        nextStatus = 'repeated';
      } else if (existing.status === 'repeated') {
        nextStatus = 'confirmed';
      } else {
        // confirmed/active_training/improving stay until Review practice
        // (through the existing lifecycle) moves them — no shortcuts.
        nextStatus = existing.status;
      }
    }

    // Union contexts (bounded) and append evidence (bounded) — never truncate
    // the learner's history silently beyond these caps.
    const newContextTag = opts.lexicalItemId
      ? `lexical:${opts.lexicalItemId}`
      : opts.context
        ? `turn:${opts.context}`
        : 'conversation-turn';
    const contextTags = Array.from(
      new Set([...(existing?.contexts ?? []), newContextTag]),
    ).slice(-10);
    const evidence = [
      ...(existing?.evidence ?? []),
      {
        id: `${record.weakness.id}-${opts.at}`,
        kind: 'turn' as const,
        at: opts.at,
        summary: observation.description,
      },
    ].slice(-20);

    const weakness = await this.deps.weaknesses.upsertWeakness({
      learnerId,
      type: 'pronunciation',
      referenceId: record.weakness.id,
      severity: 0.5,
      status: nextStatus,
      lastSeenAt: opts.at,
      firstSeenAt: existing?.firstSeenAt ?? opts.at,
      occurrenceCount: record.weakness.occurrenceCount,
      contexts: contextTags,
      notes: identity,
      evidence,
      resolved: false,
    });

    // ---- Existing Review system (the ONLY scheduler) ----
    if (this.deps.review?.upsert) {
      const alreadyScheduled = dueReviewItems.some((r) => r.referenceId === weakness.id);
      if (!alreadyScheduled) {
        await this.deps.review.upsert({
          learnerId,
          kind: 'pronunciation',
          referenceId: weakness.id,
          prompt: `Listen and repeat clearly: "${target}"`,
          expectedResponse: target,
          state: 'learning',
          dueAt: opts.at,
          reviewCount: 0,
          consecutiveCorrect: 0,
          outcomeHistory: [],
        });
      }
    }
  }

  /** Expose the pronunciation weakness rows (bounded) for dashboards/tests. */
  async listPronunciationWeaknesses(
    learnerId: string,
    limit = 50,
  ): Promise<readonly PronunciationWeakness[]> {
    return this.deps.pronunciation.listWeaknesses
      ? this.deps.pronunciation.listWeaknesses(learnerId, { resolved: false, limit })
      : [];
  }
}
