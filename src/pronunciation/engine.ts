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
 *   pronunciation_weaknesses table (including the per-occurrence evidence
 *   source log); the generic lifecycle lives in the existing
 *   learner_weaknesses table (type 'pronunciation', same states:
 *   observed → repeated → confirmed → …, conservative, no shortcuts).
 * - Weakness identity is resolved with an EXACT repository lookup by
 *   (learnerId, type, referenceId) — never by scanning a capped list — so
 *   lifecycle state can never reset because a learner has >100 weaknesses.
 * - Review scheduling: an existing pronunciation review item (kind
 *   'pronunciation', same referenceId) is looked up EXACTLY — including
 *   future-scheduled items listDue cannot see — and is NEVER recreated or
 *   reset. Its reviewCount, consecutiveCorrect, outcomeHistory,
 *   lastReviewAt and dueAt are preserved untouched.
 * - A pending review item is created only when none exists yet, through
 *   the existing review repository (no second scheduler).
 * - Analysis/persistence failures are non-destructive: the caller's
 *   conversation flow continues untouched.
 */

import type { ConversationMode, IsoDate, WeaknessStatus } from '../domain/shared/types';
import type { LearnerWeakness, PronunciationWeakness } from '../domain/models/learner';
import type { ReviewItem } from '../domain/models/learning';
import { recordPronunciationSuccess, type SuccessObservationRecorder } from '../reassessment';
import type {
  PronunciationObservationInput,
  PronunciationObservationRecord,
  PronunciationRepository,
  ReviewRepository,
  UserProfileRepository,
  VocabularyRepository,
  WeaknessRepository,
} from '../repositories';
import type {
  PronunciationAnalysis,
  PronunciationEvidenceSource,
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

/**
 * Evidence levels that can ground a POSITIVE pronunciation claim.
 *
 * - 'acoustic' / 'transcript_comparison' / 'stt_substitution' / 'practice_result'
 *   are observed evidence about the learner's production.
 * - 'ai_explanation_only' is explicitly inference, never evidence.
 * - 'learner_self_report' is not an evaluated signal about production, so it
 *   cannot justify a strength claim either.
 */
const SUPPORTED_POSITIVE_EVIDENCE_SOURCES: readonly PronunciationEvidenceSource[] = [
  'acoustic',
  'transcript_comparison',
  'stt_substitution',
  'practice_result',
];

/**
 * WP-4 evidence integrity: does this analysis carry an EXPLICIT POSITIVE
 * pronunciation signal from the EXISTING provider contract?
 *
 * The contract's positive signal is `overallIntelligibility === 'clear'`: the
 * provider must have ASSERTED that the production was clear from a supported
 * evidence source. The previous rule ("not insufficient + zero negative
 * observations") treated the mere ABSENCE of a weakness as success, which is
 * inference — a provider that reports nothing, or only inference-only
 * coaching, produced no positive evidence at all.
 *
 * Everything below must hold:
 * - the analysis is not `insufficientEvidence` (no invented judgement);
 * - a real transcript AND a known expected target exist (nothing to compare
 *   against → nothing to claim);
 * - the provider explicitly reported `overallIntelligibility: 'clear'`;
 * - that judgement rests on a supported observed evidence source.
 *
 * When any of these is missing the engine persists NO pronunciation strength:
 * omitting the success evidence is always better than fabricating it. No new
 * provider metric is introduced — this reads the existing contract only.
 */
function hasExplicitPositiveSignal(
  analysis: PronunciationAnalysis,
  input: { transcript: string; expectedText?: string },
): boolean {
  if (analysis.insufficientEvidence) return false;
  if (analysis.overallIntelligibility !== 'clear') return false;
  if (!input.transcript.trim()) return false;
  if (!input.expectedText?.trim()) return false;
  return SUPPORTED_POSITIVE_EVIDENCE_SOURCES.includes(analysis.evidenceLevel);
}

export interface PronunciationEngineDeps {
  readonly successRecorder?: SuccessObservationRecorder;
  readonly provider: PronunciationProvider;
  readonly pronunciation: {
    /** Deduplicating observation recorder (existing repository method). */
    readonly recordObservation: (
      input: PronunciationObservationInput,
    ) => Promise<PronunciationObservationRecord>;
    readonly listWeaknesses?: PronunciationRepository['listWeaknesses'];
  };
  readonly weaknesses: {
    readonly upsertWeakness: WeaknessRepository['upsertWeakness'];
    /**
     * EXACT lookup by (learnerId, type, referenceId) — required so the
     * engine never mistakes an old weakness for a new one (no capped scan).
     */
    readonly getWeaknessByReference: (
      learnerId: string,
      type: LearnerWeakness['type'],
      referenceId: string,
    ) => Promise<LearnerWeakness | null>;
  };
  /** Existing review repository — schedules retraining through the Review system. */
  readonly review?: {
    readonly upsert: NonNullable<ReviewRepository['upsert']>;
    /**
     * EXACT existence lookup by (learnerId, kind, referenceId) — including
     * future-scheduled items. Required when review is provided, so repeats
     * never reset already-practiced review items.
     */
    readonly getByReference: (
      learnerId: string,
      kind: ReviewItem['kind'],
      referenceId: string,
    ) => Promise<ReviewItem | null>;
  };
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
   *
   * Hardened:
   * - checkStale() – if true, late result after dispose/session switch cannot persist
   * - failed provider cannot become positive evidence
   * - cancellation/disposal terminal (caller checks stale before and after)
   */
  async analyzeSpokenTurn(input: {
    transcript: string;
    expectedText?: string;
    context?: string;
    mode?: ConversationMode;
    now?: IsoDate;
    checkStale?: () => boolean;
  }): Promise<PronunciationTurnOutcome | null> {
    const mode = input.mode ?? 'coach';
    const at = input.now ?? new Date().toISOString();

    if (input.checkStale?.()) return null;

    const learnerId = await this.getActiveLearnerId();
    if (!learnerId || !input.transcript.trim()) return null;
    if (input.checkStale?.()) return null;

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
      // Failed pronunciation provider cannot become positive evidence
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

    if (input.checkStale?.()) return null;

    // Persist only evidence-backed observations. AI explanations are NOT
    // pronunciation evidence and are never persisted as such.
    const persistable = analysis.observations
      .filter(
        (o) =>
          !o.inferenceOnly &&
          o.evidence !== 'ai_explanation_only' &&
          !analysis.insufficientEvidence,
      )
      .slice(0, MAX_PERSISTED_PER_TURN);

    if (persistable.length > 0) {
      if (input.checkStale?.()) return null;
      try {
        // Bounded read ONCE per turn for lexical links — no N+1 queries.
        const lexicalLinks = await this.resolveLexicalLinks(learnerId, persistable);
        for (const observation of persistable) {
          if (input.checkStale?.()) return null;
          await this.persistObservation(learnerId, observation, {
            at,
            lexicalItemId: lexicalLinks.get(observation.target?.toLowerCase().trim() ?? ''),
            context: input.context,
          });
        }
      } catch {
        // Persistence failure must not corrupt the conversation flow.
      }
    }

    // WP-4 evidence integrity: a success claim requires an EXPLICIT POSITIVE
    // SIGNAL in the provider contract — never the mere absence of negative
    // observations. See `hasExplicitPositiveSignal`.
    const positiveSignalTarget = input.expectedText?.trim();
    if (
      this.deps.successRecorder &&
      persistable.length === 0 &&
      positiveSignalTarget &&
      hasExplicitPositiveSignal(analysis, input)
    ) {
      if (input.checkStale?.()) return null;
      const refId = `pron:${positiveSignalTarget.toLowerCase().slice(0, 30)}`;
      try {
        await recordPronunciationSuccess(this.deps.successRecorder, {
          learnerId,
          referenceId: refId,
          context: input.context ?? 'target_sentence',
          summary: `Clear pronunciation of target sentence: "${input.expectedText}"`,
        });
      } catch {
        // Evidence persistence must never break the conversation flow.
      }
    }

    if (input.checkStale?.()) return null;

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
   * identity, with its evidence source) + conservative learner-weakness
   * lifecycle + review scheduling that never resets existing history.
   */
  private async persistObservation(
    learnerId: string,
    observation: PronunciationObservation,
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
      evidenceSource: observation.evidence,
      confidence: observation.confidence,
      at: opts.at,
    });

    // ---- Existing learner-weakness lifecycle (conservative, EXACT lookup) ----
    // A single-row lookup by referenceId: immune to any list cap, so an
    // existing weakness is never mistaken for a new one.
    const existing = await this.deps.weaknesses.getWeaknessByReference(
      learnerId,
      'pronunciation',
      record.weakness.id,
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
        // confirmed/active_training/improving/relapsed stay until Review
        // practice (through the existing lifecycle) moves them — never
        // regress confirmed → observed or relapsed → observed here.
        nextStatus = existing.status;
      }
    }

    // Union contexts (bounded) and append evidence (bounded).
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
    // EXACT existence lookup — listDue can NOT see future-scheduled items,
    // so it must never be used to decide existence. An existing review item
    // keeps its complete history (reviewCount, consecutiveCorrect,
    // outcomeHistory, lastReviewAt) and its schedule (dueAt) untouched.
    if (this.deps.review?.upsert && this.deps.review?.getByReference) {
      const existingReview = await this.deps.review.getByReference(
        learnerId,
        'pronunciation',
        weakness.id,
      );
      if (!existingReview) {
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
