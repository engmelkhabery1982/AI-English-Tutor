/**
 * src/adaptive-lessons/planner.ts
 *
 * Adaptive Lessons Engine (Phase 1) — deterministic, evidence-based planner.
 *
 * GUARANTEES
 * - PURE: no I/O, no clock read (the caller supplies `now`), and NO AI call.
 *   Identical input always produces an identical plan, including step ids.
 *   AI is only ever used (optionally) to give feedback on a spoken answer.
 * - EXPLAINABLE: every personalized step carries a human-readable reason
 *   built from real stored evidence. Internal ids never appear in learner
 *   facing text.
 * - BOUNDED: 3–7 steps normally, 8 as a hard maximum; at most 2 steps of the
 *   same type; at most 3 review-family steps; never the same underlying
 *   problem twice.
 * - HONEST: nothing is padded to reach a step count. When evidence runs out,
 *   remaining slots are filled with clearly labeled GENERAL practice (or the
 *   lesson simply stays short) instead of inventing personalization.
 * - NON-AUTHORITATIVE: planning only SELECTS practice. Weakness lifecycle
 *   transitions, review scheduling and mastery state remain owned by the
 *   existing engines that the service calls while executing a step.
 *
 * PRIORITY (the documented Phase-1 rule order, most urgent first):
 *   1. relapsed / confirmed / active_training weaknesses
 *   2. repeated weaknesses (conservative: at most one such step)
 *   3. due review items
 *   4. listening weaknesses needing retraining
 *   5. pronunciation weaknesses needing retraining
 *   6. due vocabulary / expressions
 *   7. speaking / natural phrasing practice
 *   8. general balanced fallback
 */

import { stableReferenceId } from '../listening/generator';
import type { ReviewItem } from '../domain/models/learning';
import type { IsoDate, WeaknessStatus } from '../domain/shared/types';
import type { CoachingActiveWeakness } from '../learner-model';
import type {
  AdaptiveLessonCapability,
  AdaptiveLessonFocus,
  AdaptiveLessonFocusArea,
  AdaptiveLessonPlan,
  AdaptiveLessonPlanningInput,
  AdaptiveLessonPlannerOptions,
  AdaptiveLessonPronunciationTarget,
  AdaptiveLessonReason,
  AdaptiveLessonReasonCode,
  AdaptiveLessonSignalSummary,
  AdaptiveLessonSizeLabel,
  AdaptiveLessonSourceMode,
  AdaptiveLessonStep,
  AdaptiveLessonStepSource,
  AdaptiveLessonStepTarget,
  AdaptiveLessonStepTargetKind,
  AdaptiveLessonStepType,
  AdaptiveLessonWeaknessTarget,
} from './types';

/* ------------------------------------------------------------------ *
 * Phase-1 bounds (exported for tests and for the UI copy)
 * ------------------------------------------------------------------ */

/**
 * Fewest practice steps a lesson will contain (plus the wrap-up step).
 * Three practice steps keep every lesson inside the documented 4–7 step
 * target; the general fallback bank can always serve three distinct tasks.
 */
export const MIN_PRACTICE_STEPS = 3;
/** Most practice steps a lesson will contain (plus the wrap-up step). */
export const MAX_PRACTICE_STEPS = 6;
/** Smallest total lesson the planner will produce (3 practice + wrap-up). */
export const MIN_LESSON_STEPS = 4;
/** Normal maximum total lesson size. */
export const MAX_LESSON_STEPS = 7;
/** Absolute ceiling — never exceeded, whatever the caller requests. */
export const HARD_MAX_LESSON_STEPS = 8;
/** At most this many steps of the SAME type (prevents single-category lessons). */
export const MAX_STEPS_PER_TYPE = 2;
/** At most this many steps served by the existing review pipeline. */
export const MAX_REVIEW_FAMILY_STEPS = 3;
/** Conservative cap for "repeated but not yet confirmed" weaknesses. */
export const MAX_REPEATED_WEAKNESS_STEPS = 1;

/* Priority tiers — lower number = higher priority. */
const TIER_PRIMARY_WEAKNESS = 1;
const TIER_REPEATED_WEAKNESS = 2;
const TIER_DUE_REVIEW = 3;
const TIER_LISTENING_RETRAINING = 4;
const TIER_PRONUNCIATION_RETRAINING = 5;
const TIER_DUE_LEXICAL = 6;
const TIER_SPEAKING = 7;
const TIER_GENERAL = 8;

/** Deterministic ordering of weakness lifecycle states (most urgent first). */
const STATUS_PRIORITY: Readonly<Record<WeaknessStatus, number>> = {
  relapsed: 0,
  confirmed: 1,
  active_training: 2,
  repeated: 3,
  improving: 4,
  observed: 5,
  stable: 6,
  mastered: 7,
};

/** Step types served by the EXISTING review pipeline (bounded as a family). */
const REVIEW_FAMILY: readonly AdaptiveLessonStepType[] = ['review', 'vocabulary', 'expression'];

const FOCUS_AREA_ORDER: readonly AdaptiveLessonFocusArea[] = [
  'Review',
  'Listening',
  'Speaking',
  'Pronunciation',
  'Vocabulary',
  'Expressions',
];

/* ------------------------------------------------------------------ *
 * Internal candidate model
 * ------------------------------------------------------------------ */

/** A proposed step plus everything needed to order and de-duplicate it. */
interface LessonCandidate {
  readonly tier: number;
  readonly statusRank: number;
  readonly occurrenceCount: number;
  readonly severity: number;
  readonly lastSeenAt: string;
  /** Insertion order — the final deterministic tie-break. */
  readonly order: number;
  readonly type: AdaptiveLessonStepType;
  readonly title: string;
  readonly capability: AdaptiveLessonCapability;
  readonly source: AdaptiveLessonStepSource;
  readonly personalized: boolean;
  readonly reason: AdaptiveLessonReason;
  readonly target: AdaptiveLessonStepTarget;
  readonly maxItems: number;
  readonly reviewKindFilter?: ReviewItem['kind'];
  readonly targetText?: string;
  /** Identity of the underlying problem — the same key is never selected twice. */
  readonly dedupeKey: string;
}

type CandidateDraft = Omit<LessonCandidate, 'order'>;

/* ------------------------------------------------------------------ *
 * Small text helpers (real counts only — never scores or ratings)
 * ------------------------------------------------------------------ */

function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function quoted(text: string | undefined): string {
  return text ? ` "${text}"` : '';
}

function countDueEntries(
  entries: readonly { nextReviewAt: IsoDate | null }[],
  now: IsoDate,
): number {
  return entries.filter((entry) => entry.nextReviewAt !== null && entry.nextReviewAt <= now).length;
}

function firstDueEntry<T extends { nextReviewAt: IsoDate | null }>(
  entries: readonly T[],
  now: IsoDate,
): T | null {
  return entries.find((entry) => entry.nextReviewAt !== null && entry.nextReviewAt <= now) ?? null;
}

/** Bounded, human-readable breakdown of the due review queue. */
function describeDueKinds(
  byKind: Readonly<Partial<Record<ReviewItem['kind'], number>>>,
): string | null {
  const labels: readonly [ReviewItem['kind'], string, string][] = [
    ['expression', 'expression', 'expressions'],
    ['vocabulary', 'word', 'words'],
    ['grammar', 'grammar point', 'grammar points'],
    ['pronunciation', 'pronunciation target', 'pronunciation targets'],
    ['listening', 'listening item', 'listening items'],
  ];
  const parts: string[] = [];
  for (const [kind, singular, plural] of labels) {
    const count = byKind[kind] ?? 0;
    if (count > 0) parts.push(pluralize(count, singular, plural));
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/* ------------------------------------------------------------------ *
 * Signals
 * ------------------------------------------------------------------ */

/** Real, countable evidence available to the planner (no ratings). */
export function describePlanningSignals(
  input: AdaptiveLessonPlanningInput,
): AdaptiveLessonSignalSummary {
  const { coaching, pronunciationTargets, dueReview, now } = input;
  const weaknesses = coaching.activeWeaknesses;
  const countStatus = (...statuses: WeaknessStatus[]) =>
    weaknesses.filter((w) => statuses.includes(w.status)).length;

  return {
    activeWeaknesses: weaknesses.length,
    relapsedWeaknesses: countStatus('relapsed'),
    confirmedWeaknesses: countStatus('confirmed', 'active_training'),
    dueReviewItems: dueReview.total,
    dueVocabulary: countDueEntries(coaching.vocabularyFocus, now),
    dueExpressions: countDueEntries(coaching.expressionFocus, now),
    pronunciationTargets: pronunciationTargets.length,
    listeningTargets: weaknesses.filter((w) => w.type === 'listening').length,
    savedVocabulary: coaching.vocabularyFocus.length,
    savedExpressions: coaching.expressionFocus.length,
  };
}

/**
 * Lesson size follows the amount of REAL evidence — never a fixed number and
 * never padding. `volume` counts stored signals the lesson could act on.
 */
function resolveDesiredPracticeSteps(
  signals: AdaptiveLessonSignalSummary,
  options?: AdaptiveLessonPlannerOptions,
): number {
  if (options?.targetPracticeSteps !== undefined) {
    return Math.min(Math.max(options.targetPracticeSteps, MIN_PRACTICE_STEPS), MAX_PRACTICE_STEPS);
  }
  const volume =
    signals.activeWeaknesses +
    signals.dueReviewItems +
    signals.dueVocabulary +
    signals.dueExpressions +
    signals.pronunciationTargets;
  if (volume <= 2) return 3;
  if (volume <= 4) return 4;
  if (volume <= 6) return 5;
  return MAX_PRACTICE_STEPS;
}

/* ------------------------------------------------------------------ *
 * Weakness → step mapping (which EXISTING capability owns the practice)
 * ------------------------------------------------------------------ */

interface WeaknessBlueprint {
  readonly type: AdaptiveLessonStepType;
  readonly title: string;
  readonly capability: AdaptiveLessonCapability;
  readonly source: AdaptiveLessonStepSource;
  readonly targetKind: AdaptiveLessonStepTargetKind;
  readonly reviewKindFilter?: ReviewItem['kind'];
  readonly maxItems: number;
}

/**
 * Each weakness type is practiced by the ONE existing system that already
 * owns it. No step invents a new exercise format:
 * - listening      → existing ListeningService (retraining exercises)
 * - pronunciation  → existing PronunciationEngine (qualitative repeat evidence)
 * - vocabulary     → existing review pipeline (vocabulary candidates)
 * - grammar        → existing review pipeline (sentence/natural-phrasing)
 * - natural_expression / fluency / confidence → existing conversation stack
 */
function blueprintForWeaknessType(
  type: CoachingActiveWeakness['type'],
): WeaknessBlueprint {
  switch (type) {
    case 'listening':
      return {
        type: 'listening',
        title: 'Listening retraining',
        capability: 'listening-service',
        source: 'listening_weakness',
        targetKind: 'learner_weakness',
        maxItems: 2,
      };
    case 'pronunciation':
      return {
        type: 'pronunciation',
        title: 'Pronunciation focus',
        capability: 'pronunciation-engine',
        source: 'pronunciation_weakness',
        targetKind: 'pronunciation_weakness',
        maxItems: 1,
      };
    case 'vocabulary':
      return {
        type: 'vocabulary',
        title: 'Vocabulary review',
        capability: 'review-service',
        source: 'weakness',
        targetKind: 'learner_weakness',
        reviewKindFilter: 'vocabulary',
        maxItems: 2,
      };
    case 'grammar':
      return {
        type: 'review',
        title: 'Grammar check',
        capability: 'review-service',
        source: 'weakness',
        targetKind: 'learner_weakness',
        reviewKindFilter: 'grammar',
        maxItems: 2,
      };
    case 'natural_expression':
      return {
        type: 'speaking',
        title: 'Natural phrasing',
        capability: 'conversation-stack',
        source: 'weakness',
        targetKind: 'learner_weakness',
        maxItems: 1,
      };
    case 'fluency':
    case 'confidence':
    default:
      return {
        type: 'speaking',
        title: 'Speaking practice',
        capability: 'conversation-stack',
        source: 'weakness',
        targetKind: 'learner_weakness',
        maxItems: 1,
      };
  }
}

function tierForWeakness(
  weakness: CoachingActiveWeakness,
  blueprint: WeaknessBlueprint,
): number {
  switch (weakness.status) {
    case 'relapsed':
    case 'confirmed':
    case 'active_training':
      return TIER_PRIMARY_WEAKNESS;
    case 'repeated':
      return TIER_REPEATED_WEAKNESS;
    case 'observed':
    case 'improving':
      if (blueprint.type === 'listening') return TIER_LISTENING_RETRAINING;
      if (blueprint.type === 'pronunciation') return TIER_PRONUNCIATION_RETRAINING;
      if (blueprint.type === 'vocabulary' || blueprint.type === 'expression') {
        return TIER_DUE_LEXICAL;
      }
      return TIER_SPEAKING;
    case 'stable':
    case 'mastered':
    default:
      // A plateau is not urgent; mastered items are never retrained here.
      return TIER_SPEAKING;
  }
}

function reasonCodeForStatus(status: WeaknessStatus): AdaptiveLessonReasonCode {
  switch (status) {
    case 'relapsed':
      return 'relapsed_weakness';
    case 'confirmed':
      return 'confirmed_weakness';
    case 'active_training':
      return 'active_training_weakness';
    case 'repeated':
      return 'repeated_weakness';
    default:
      return 'repeated_weakness';
  }
}

/**
 * The learner-facing sentence explaining WHY this weakness became a step.
 * Built only from real stored fields (status, occurrence count, target text).
 */
function reasonForWeakness(
  weakness: CoachingActiveWeakness,
  blueprint: WeaknessBlueprint,
  label: string | undefined,
): AdaptiveLessonReason {
  const times =
    weakness.occurrenceCount > 1
      ? ` It has come up ${pluralize(weakness.occurrenceCount, 'time')}.`
      : '';
  const source: AdaptiveLessonStepSource = blueprint.source;

  let message: string;
  switch (weakness.type) {
    case 'listening':
      message = weakness.status === 'relapsed'
        ? `Listening difficulty with${quoted(label ?? undefined)} came back, so it is worth another pass.`
        : `Your listening practice showed a gap with${quoted(label ?? undefined)}.`;
      break;
    case 'pronunciation':
      message = `Pronunciation point${quoted(label ?? undefined)} was flagged in your speaking practice.`;
      break;
    case 'vocabulary':
      message = `The word${quoted(label ?? undefined)} has been a recurring difficulty.`;
      break;
    case 'grammar':
      message = label
        ? `A grammar pattern from your corrections needs another pass:${quoted(label)}.`
        : 'A grammar pattern from your corrections needs another pass.';
      break;
    case 'natural_expression':
      message = label
        ? `Your phrasing${quoted(label)} was understandable but not the most natural choice.`
        : 'Recent corrections suggest practicing more natural phrasing.';
      break;
    case 'fluency':
      message = 'Your history points to speaking fluency — a short speaking task keeps it moving.';
      break;
    case 'confidence':
    default:
      message = 'A short, low-pressure speaking task helps you keep using English actively.';
      break;
  }

  const urgency =
    weakness.status === 'relapsed'
      ? 'This had improved and then came back.'
      : weakness.status === 'confirmed'
        ? 'There is enough evidence to treat this as a real difficulty.'
        : weakness.status === 'active_training'
          ? 'This is already in training, so the practice continues.'
          : weakness.status === 'repeated'
            ? 'This has appeared more than once.'
            : null;

  return {
    code:
      blueprint.type === 'listening'
        ? 'listening_retraining'
        : blueprint.type === 'pronunciation'
          ? 'pronunciation_retraining'
          : blueprint.type === 'speaking' && weakness.type === 'natural_expression'
            ? 'natural_phrasing'
            : blueprint.type === 'speaking'
              ? 'fluency_practice'
              : reasonCodeForStatus(weakness.status),
    message: `${message}${times}${urgency ? ` ${urgency}` : ''}`.trim(),
    source,
    evidence: {
      occurrenceCount: weakness.occurrenceCount,
      weaknessStatus: weakness.status,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Candidate construction
 * ------------------------------------------------------------------ */

function buildCandidates(
  input: AdaptiveLessonPlanningInput,
  signals: AdaptiveLessonSignalSummary,
): readonly LessonCandidate[] {
  const { coaching, weaknessTargets, pronunciationTargets, dueReview, now } = input;
  const candidates: LessonCandidate[] = [];
  let order = 0;
  const push = (draft: CandidateDraft): void => {
    candidates.push({ ...draft, order: order++ });
  };

  const labelById = new Map<string, AdaptiveLessonWeaknessTarget>(
    weaknessTargets.map((entry) => [entry.weaknessId, entry]),
  );
  const pronunciationByWeakness = new Map<string, AdaptiveLessonPronunciationTarget>(
    pronunciationTargets
      .filter((target) => Boolean(target.weaknessId))
      .map((target) => [target.weaknessId as string, target]),
  );
  const pronunciationById = new Map<string, AdaptiveLessonPronunciationTarget>(
    pronunciationTargets.map((target) => [target.pronunciationWeaknessId, target]),
  );

  /* --- 1/2/4/5/7: steps driven by persisted weaknesses ---------------- */
  const coveredPronunciationIds = new Set<string>();
  for (const weakness of coaching.activeWeaknesses) {
    if (weakness.status === 'mastered') continue; // defensive: never retrain mastery
    const blueprint = blueprintForWeaknessType(weakness.type);
    const pronunciationTarget = weakness.referenceId
      ? pronunciationById.get(weakness.referenceId) ??
        pronunciationByWeakness.get(weakness.id)
      : undefined;
    const storedTarget = labelById.get(weakness.id);
    const label = pronunciationTarget?.target ?? storedTarget?.label;

    const target: AdaptiveLessonStepTarget = {
      kind: blueprint.targetKind,
      id: pronunciationTarget?.pronunciationWeaknessId ?? weakness.id,
      ...(label ? { label } : {}),
    };
    const dedupeKey = pronunciationTarget
      ? `pronunciation:${pronunciationTarget.pronunciationWeaknessId}`
      : `weakness:${weakness.id}`;
    if (pronunciationTarget) coveredPronunciationIds.add(pronunciationTarget.pronunciationWeaknessId);

    push({
      tier: tierForWeakness(weakness, blueprint),
      statusRank: STATUS_PRIORITY[weakness.status] ?? 9,
      occurrenceCount: weakness.occurrenceCount,
      severity: weakness.severity,
      lastSeenAt: storedTarget?.lastSeenAt ?? '',
      type: blueprint.type,
      title: blueprint.title,
      capability: blueprint.capability,
      source: blueprint.source,
      personalized: true,
      reason: reasonForWeakness(weakness, blueprint, label),
      target,
      maxItems: blueprint.maxItems,
      ...(blueprint.reviewKindFilter ? { reviewKindFilter: blueprint.reviewKindFilter } : {}),
      ...(label ? { targetText: label } : {}),
      dedupeKey,
    });
  }

  /* --- 5: pronunciation evidence not linked to an active weakness ------ */
  for (const target of pronunciationTargets) {
    if (coveredPronunciationIds.has(target.pronunciationWeaknessId)) continue;
    push({
      tier: TIER_PRONUNCIATION_RETRAINING,
      statusRank: STATUS_PRIORITY[target.weaknessStatus ?? 'observed'] ?? 5,
      occurrenceCount: target.occurrenceCount,
      severity: 0,
      lastSeenAt: '',
      type: 'pronunciation',
      title: 'Pronunciation focus',
      capability: 'pronunciation-engine',
      source: 'pronunciation_weakness',
      personalized: true,
      reason: {
        code: 'pronunciation_retraining',
        message: `${target.issueLabel} was flagged ${pluralize(
          target.occurrenceCount,
          'time',
        )} in your speaking practice.`,
        source: 'pronunciation_weakness',
        evidence: {
          occurrenceCount: target.occurrenceCount,
          ...(target.weaknessStatus ? { weaknessStatus: target.weaknessStatus } : {}),
        },
      },
      target: {
        kind: 'pronunciation_weakness',
        id: target.pronunciationWeaknessId,
        label: target.issueLabel,
      },
      maxItems: 1,
      targetText: target.target,
      dedupeKey: `pronunciation:${target.pronunciationWeaknessId}`,
    });
  }

  /* --- 3: due review items (one bounded step over the existing queue) -- */
  if (dueReview.total > 0) {
    const kinds = describeDueKinds(dueReview.byKind);
    push({
      tier: TIER_DUE_REVIEW,
      statusRank: 8,
      occurrenceCount: dueReview.total,
      severity: 0,
      lastSeenAt: '',
      type: 'review',
      title: 'Quick review',
      capability: 'review-service',
      source: 'due_review',
      personalized: true,
      reason: {
        code: 'due_review',
        message: kinds
          ? `You have ${pluralize(dueReview.total, 'saved item')} due for review (including ${kinds}).`
          : `You have ${pluralize(dueReview.total, 'saved item')} due for review.`,
        source: 'due_review',
        evidence: { dueCount: dueReview.total },
      },
      target: { kind: 'review_item' },
      maxItems: 3,
      dedupeKey: 'review:due',
    });
  }

  /* --- 6: due vocabulary / expressions --------------------------------- */
  if (signals.dueVocabulary > 0) {
    push({
      tier: TIER_DUE_LEXICAL,
      statusRank: 8,
      occurrenceCount: signals.dueVocabulary,
      severity: 0,
      lastSeenAt: '',
      type: 'vocabulary',
      title: 'Vocabulary review',
      capability: 'review-service',
      source: 'due_vocabulary',
      personalized: true,
      reason: {
        code: 'due_vocabulary',
        message: `${pluralize(signals.dueVocabulary, 'saved word', 'saved words')} due for review.`,
        source: 'due_vocabulary',
        evidence: { dueCount: signals.dueVocabulary },
      },
      target: { kind: 'vocabulary_item' },
      maxItems: 2,
      reviewKindFilter: 'vocabulary',
      dedupeKey: 'lexical:vocabulary:due',
    });
  }
  if (signals.dueExpressions > 0) {
    push({
      tier: TIER_DUE_LEXICAL,
      statusRank: 8,
      occurrenceCount: signals.dueExpressions,
      severity: 0,
      lastSeenAt: '',
      type: 'expression',
      title: 'Expression review',
      capability: 'review-service',
      source: 'due_expression',
      personalized: true,
      reason: {
        code: 'due_expression',
        message: `${pluralize(
          signals.dueExpressions,
          'saved expression',
        )} due for review.`,
        source: 'due_expression',
        evidence: { dueCount: signals.dueExpressions },
      },
      target: { kind: 'expression_item' },
      maxItems: 2,
      reviewKindFilter: 'expression',
      dedupeKey: 'lexical:expression:due',
    });
  }

  /* --- 7: speaking / natural phrasing (reuses real lesson material) ---- */
  const dueExpression = firstDueEntry(coaching.expressionFocus, now);
  if (dueExpression) {
    push({
      tier: TIER_SPEAKING,
      statusRank: 8,
      occurrenceCount: 0,
      severity: 0,
      lastSeenAt: '',
      type: 'speaking',
      title: 'Speaking practice',
      capability: 'conversation-stack',
      source: 'lesson_context',
      personalized: true,
      reason: {
        code: 'natural_phrasing',
        message: `Use your expression "${dueExpression.expression}" in your own words.`,
        source: 'lesson_context',
      },
      target: {
        kind: 'expression_item',
        id: dueExpression.itemId,
        label: dueExpression.expression,
      },
      maxItems: 1,
      targetText: dueExpression.expression,
      dedupeKey: `speak:expression:${dueExpression.itemId}`,
    });
  } else {
    const dueWord = firstDueEntry(coaching.vocabularyFocus, now);
    if (dueWord) {
      push({
        tier: TIER_SPEAKING,
        statusRank: 8,
        occurrenceCount: 0,
        severity: 0,
        lastSeenAt: '',
        type: 'speaking',
        title: 'Speaking practice',
        capability: 'conversation-stack',
        source: 'lesson_context',
        personalized: true,
        reason: {
          code: 'natural_phrasing',
          message: `Use the word "${dueWord.headword}" in two or three sentences of your own.`,
          source: 'lesson_context',
        },
        target: {
          kind: 'vocabulary_item',
          id: dueWord.itemId,
          label: dueWord.headword,
        },
        maxItems: 1,
        targetText: dueWord.headword,
        dedupeKey: `speak:vocabulary:${dueWord.itemId}`,
      });
    }
  }

  const goal = coaching.profile.learningGoals.find((entry) => entry.trim().length > 0);
  if (goal) {
    push({
      tier: TIER_SPEAKING,
      statusRank: 9,
      occurrenceCount: 0,
      severity: 0,
      lastSeenAt: '',
      type: 'speaking',
      title: 'Speaking practice',
      capability: 'conversation-stack',
      source: 'learning_goal',
      personalized: true,
      reason: {
        code: 'learning_goal',
        message: `You are learning English for: ${goal}. A short speaking task keeps that goal active.`,
        source: 'learning_goal',
      },
      target: { kind: 'none' },
      maxItems: 1,
      targetText: goal.trim(),
      dedupeKey: 'speak:goal',
    });
  }

  /* --- 8: clearly GENERAL fallback content (never personalized) -------- */
  push({
    tier: TIER_GENERAL,
    statusRank: 9,
    occurrenceCount: 0,
    severity: 0,
    lastSeenAt: '',
    type: 'listening',
    title: 'Listening warm-up',
    capability: 'listening-service',
    source: 'general',
    personalized: false,
    reason: {
      code: 'general_balance',
      message: 'General listening practice — nothing in your history needed retraining here.',
      source: 'general',
    },
    target: { kind: 'none' },
    maxItems: 2,
    dedupeKey: 'general:listening:easy',
  });
  push({
    tier: TIER_GENERAL,
    statusRank: 9,
    occurrenceCount: 0,
    severity: 0,
    lastSeenAt: '',
    type: 'speaking',
    title: 'Speaking practice',
    capability: 'conversation-stack',
    source: 'general',
    personalized: false,
    reason: {
      code: 'general_balance',
      message: 'General speaking practice to keep you talking — not based on stored evidence.',
      source: 'general',
    },
    target: { kind: 'none' },
    maxItems: 1,
    dedupeKey: 'general:speaking',
  });
  push({
    tier: TIER_GENERAL,
    statusRank: 9,
    occurrenceCount: 0,
    severity: 0,
    lastSeenAt: '',
    type: 'listening',
    title: 'Listening practice',
    capability: 'listening-service',
    source: 'general',
    personalized: false,
    reason: {
      code: 'general_balance',
      message: 'A second general listening task at a slightly higher difficulty.',
      source: 'general',
    },
    target: { kind: 'none' },
    maxItems: 2,
    dedupeKey: 'general:listening:medium',
  });

  return candidates;
}

/* ------------------------------------------------------------------ *
 * Ordering + bounded selection
 * ------------------------------------------------------------------ */

function compareCandidates(a: LessonCandidate, b: LessonCandidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.statusRank !== b.statusRank) return a.statusRank - b.statusRank;
  if (a.occurrenceCount !== b.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
  if (a.severity !== b.severity) return b.severity - a.severity;
  if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
  return a.order - b.order;
}

/**
 * Greedy, deterministic selection under the Phase-1 bounds:
 * - never more than MAX_STEPS_PER_TYPE steps of one type,
 * - never more than MAX_REVIEW_FAMILY_STEPS steps served by the review pipeline,
 * - at most MAX_REPEATED_WEAKNESS_STEPS steps from unconfirmed repeated slips,
 * - never the same underlying problem twice,
 * - never more steps than the target size (no padding to hit a number).
 */
function selectCandidates(
  sorted: readonly LessonCandidate[],
  practiceTarget: number,
): readonly LessonCandidate[] {
  const selected: LessonCandidate[] = [];
  const perType = new Map<AdaptiveLessonStepType, number>();
  const usedKeys = new Set<string>();
  let reviewFamilyCount = 0;
  let repeatedCount = 0;

  for (const candidate of sorted) {
    if (selected.length >= practiceTarget) break;
    if (usedKeys.has(candidate.dedupeKey)) continue;

    const typeCount = perType.get(candidate.type) ?? 0;
    if (typeCount >= MAX_STEPS_PER_TYPE) continue;
    if (REVIEW_FAMILY.includes(candidate.type)) {
      if (reviewFamilyCount >= MAX_REVIEW_FAMILY_STEPS) continue;
    }
    if (candidate.tier === TIER_REPEATED_WEAKNESS) {
      if (repeatedCount >= MAX_REPEATED_WEAKNESS_STEPS) continue;
    }

    selected.push(candidate);
    usedKeys.add(candidate.dedupeKey);
    perType.set(candidate.type, typeCount + 1);
    if (REVIEW_FAMILY.includes(candidate.type)) reviewFamilyCount += 1;
    if (candidate.tier === TIER_REPEATED_WEAKNESS) repeatedCount += 1;
  }

  return selected;
}

/* ------------------------------------------------------------------ *
 * Focus summary (Home card)
 * ------------------------------------------------------------------ */

function areaForStepType(type: AdaptiveLessonStepType): AdaptiveLessonFocusArea | null {
  switch (type) {
    case 'review':
      return 'Review';
    case 'listening':
      return 'Listening';
    case 'speaking':
      return 'Speaking';
    case 'pronunciation':
      return 'Pronunciation';
    case 'vocabulary':
      return 'Vocabulary';
    case 'expression':
      return 'Expressions';
    case 'wrap_up':
    default:
      return null;
  }
}

function buildFocus(
  steps: readonly AdaptiveLessonStep[],
  signals: AdaptiveLessonSignalSummary,
): readonly AdaptiveLessonFocus[] {
  const byArea = new Map<AdaptiveLessonFocusArea, AdaptiveLessonStep[]>();
  for (const step of steps) {
    const area = areaForStepType(step.type);
    if (!area) continue;
    const list = byArea.get(area) ?? [];
    list.push(step);
    byArea.set(area, list);
  }

  const focus: AdaptiveLessonFocus[] = [];
  for (const area of FOCUS_AREA_ORDER) {
    const areaSteps = byArea.get(area);
    if (!areaSteps || areaSteps.length === 0) continue;

    const labels = areaSteps
      .map((step) => step.target.label ?? step.targetText)
      .filter((label): label is string => Boolean(label && label.trim().length > 0));
    const uniqueLabels = Array.from(new Set(labels)).slice(0, 2);
    const personalized = areaSteps.some((step) => step.personalized);

    let detail: string;
    let count: number | undefined;
    switch (area) {
      case 'Review':
        detail = signals.dueReviewItems > 0
          ? `${pluralize(signals.dueReviewItems, 'item')} due`
          : 'from your correction history';
        if (signals.dueReviewItems > 0) count = signals.dueReviewItems;
        break;
      case 'Listening':
        detail = uniqueLabels.length > 0
          ? uniqueLabels.join(', ')
          : personalized
            ? 'from your listening history'
            : 'general listening practice';
        break;
      case 'Speaking':
        detail = uniqueLabels.length > 0
          ? uniqueLabels.join(', ')
          : areaSteps.some((step) => step.reason.code === 'natural_phrasing')
            ? 'natural phrasing'
            : personalized
              ? 'from your history'
              : 'general speaking practice';
        break;
      case 'Pronunciation':
        detail = uniqueLabels.length > 0 ? uniqueLabels.join(', ') : 'from your speaking history';
        break;
      case 'Vocabulary':
        detail = signals.dueVocabulary > 0
          ? `${pluralize(signals.dueVocabulary, 'word')} due`
          : uniqueLabels.length > 0
            ? uniqueLabels.join(', ')
            : 'from your saved words';
        if (signals.dueVocabulary > 0) count = signals.dueVocabulary;
        break;
      case 'Expressions':
        detail = signals.dueExpressions > 0
          ? `${pluralize(signals.dueExpressions, 'expression')} due`
          : uniqueLabels.length > 0
            ? uniqueLabels.join(', ')
            : 'from your saved expressions';
        if (signals.dueExpressions > 0) count = signals.dueExpressions;
        break;
      default:
        detail = 'practice';
    }

    focus.push({ area, detail, ...(count !== undefined ? { count } : {}) });
  }
  return focus;
}

/* ------------------------------------------------------------------ *
 * Public planner
 * ------------------------------------------------------------------ */

/**
 * Build a bounded, ordered, explainable lesson plan from real learner state.
 * Pure and deterministic: the same input always yields the same plan.
 */
export function planAdaptiveLesson(
  input: AdaptiveLessonPlanningInput,
  options?: AdaptiveLessonPlannerOptions,
): AdaptiveLessonPlan {
  const { coaching, now } = input;
  const learnerId = coaching.profile.learnerId;
  const signals = describePlanningSignals(input);
  const candidates = buildCandidates(input, signals);
  const sorted = [...candidates].sort(compareCandidates);

  const maxTotalSteps = Math.min(
    HARD_MAX_LESSON_STEPS,
    Math.max(MIN_LESSON_STEPS, options?.maxSteps ?? MAX_LESSON_STEPS),
  );
  const desiredPractice = resolveDesiredPracticeSteps(signals, options);
  // How many PERSONALIZED steps survive the diversity caps on their own.
  // General fallback content is used only to lift a thin lesson up to the
  // minimum size — a lesson that already has enough real evidence is never
  // padded with generic practice (that would dilute honest personalization).
  const survivablePersonalized = selectCandidates(
    sorted.filter((candidate) => candidate.personalized),
    MAX_PRACTICE_STEPS,
  ).length;
  const practiceTarget = Math.max(
    Math.min(MIN_PRACTICE_STEPS, maxTotalSteps - 1),
    Math.min(
      Math.max(survivablePersonalized, MIN_PRACTICE_STEPS),
      desiredPractice,
      MAX_PRACTICE_STEPS,
      maxTotalSteps - 1,
    ),
  );

  const selected = selectCandidates(sorted, practiceTarget);
  const planId = stableReferenceId(`adaptive-lesson:${learnerId}:${now}`);

  const practiceSteps: AdaptiveLessonStep[] = selected.map((candidate, index) => ({
    id: stableReferenceId(`${planId}:step:${index + 1}:${candidate.dedupeKey}`),
    type: candidate.type,
    title: candidate.title,
    reason: candidate.reason,
    capability: candidate.capability,
    source: candidate.source,
    personalized: candidate.personalized,
    target: candidate.target,
    bounds: { maxItems: candidate.maxItems },
    ...(candidate.reviewKindFilter ? { reviewKindFilter: candidate.reviewKindFilter } : {}),
    ...(candidate.targetText ? { targetText: candidate.targetText } : {}),
  }));

  const wrapUpIndex = practiceSteps.length + 1;
  const wrapUp: AdaptiveLessonStep = {
    id: stableReferenceId(`${planId}:step:${wrapUpIndex}:wrap_up`),
    type: 'wrap_up',
    title: 'Wrap-up',
    reason: {
      code: 'wrap_up',
      message: 'A short summary of what you practiced in this lesson.',
      source: 'wrap_up',
    },
    capability: 'lesson-summary',
    source: 'wrap_up',
    personalized: false,
    target: { kind: 'none' },
    bounds: { maxItems: 0 },
  };

  const steps: readonly AdaptiveLessonStep[] = [...practiceSteps, wrapUp];
  const personalizedCount = practiceSteps.filter((step) => step.personalized).length;
  const sourceMode: AdaptiveLessonSourceMode =
    personalizedCount === 0
      ? 'general'
      : personalizedCount === practiceSteps.length
        ? 'personalized'
        : 'mixed';

  const sizeLabel: AdaptiveLessonSizeLabel = steps.length <= 4 ? 'short' : 'standard';

  const sourceNote =
    sourceMode === 'personalized'
      ? 'Built from your own practice history — recurring difficulties, due reviews and saved words.'
      : sourceMode === 'mixed'
        ? 'Partly built from your practice history; the remaining steps are clearly labeled general practice.'
        : 'General balanced practice — nothing stored yet to personalize from.';

  return {
    id: planId,
    learnerId,
    createdAt: now,
    title: sourceMode === 'general' ? 'General practice lesson' : 'Your adaptive lesson',
    steps,
    sourceMode,
    sourceNote,
    sizeLabel,
    focus: buildFocus(steps, signals),
    signals,
  };
}
