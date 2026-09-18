/**
 * src/deep-speaking/planner.ts
 *
 * Deterministic, pure, no-I/O, no-AI speaking-practice planner.
 *
 * Guarantees:
 * - PURE: identical input → identical output (including ids).
 * - BOUNDED: 6–12 target turns, hard max 15; ≤2 weakness targets; ≤3 target
 *   expressions; ≤3 recent conversations.
 * - HONEST: source is 'personalized' only when REAL stored evidence materially
 *   shapes the plan. Demo learner data is never personalized.
 * - NON-AUTHORITATIVE: weakness lifecycle is never mutated.
 */

import type { WeaknessStatus } from '../domain/shared/types';
import type { CoachingActiveWeakness } from '../learner-model';
import type {
  SpeakingFocus,
  SpeakingFocusArea,
  SpeakingPlanningInput,
  SpeakingPlannerOptions,
  SpeakingPracticePlan,
  SpeakingPracticePlanResult,
  SpeakingPracticeSource,
  SpeakingPracticeType,
  SpeakingProfessionalScenario,
  SpeakingTargetExpression,
  SpeakingTurnGoal,
  SpeakingTurnGoalKind,
  SpeakingWeaknessTarget,
} from './types';
import {
  TURN_GOAL_INSTRUCTIONS,
  buildProfessionalScenarioPrompt,
  defaultCoachingModeForType,
  practiceTypeForGoal,
  selectScenario,
} from './prompts';

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

export const MIN_TARGET_TURNS = 6;
export const MAX_TARGET_TURNS = 12;
export const HARD_MAX_TURNS = 15;
export const MAX_WEAKNESS_TARGETS = 2;
export const MAX_TARGET_EXPRESSIONS = 3;
export const MAX_RECENT_CONVERSATIONS = 3;

const WEAKNESS_PRIORITY: Readonly<Record<WeaknessStatus, number>> = {
  relapsed: 0,
  confirmed: 1,
  active_training: 2,
  repeated: 3,
  observed: 4,
  improving: 5,
  stable: 6,
  mastered: 7,
};

/** Weakness types that are most relevant to speaking practice. */
const SPEAKING_RELEVANT_WEAKNESS_TYPES: ReadonlySet<string> = new Set([
  'grammar',
  'natural_expression',
  'fluency',
  'confidence',
  'vocabulary',
]);

/* ------------------------------------------------------------------ *
 * Weakness selection
 * ------------------------------------------------------------------ */

function selectWeaknessTargets(
  weaknesses: readonly CoachingActiveWeakness[],
  maxCount: number,
): readonly SpeakingWeaknessTarget[] {
  const eligible = weaknesses
    .filter((w) => w.status !== 'mastered' && w.status !== 'stable')
    .filter((w) => SPEAKING_RELEVANT_WEAKNESS_TYPES.has(w.type))
    .sort((a, b) => {
      const pa = WEAKNESS_PRIORITY[a.status] ?? 9;
      const pb = WEAKNESS_PRIORITY[b.status] ?? 9;
      if (pa !== pb) return pa - pb;
      return b.occurrenceCount - a.occurrenceCount;
    });

  return eligible.slice(0, maxCount).map((w) => ({
    weaknessId: w.id,
    type: w.type,
    label: w.contexts[0] ?? undefined,
    status: w.status,
    occurrenceCount: w.occurrenceCount,
    reason: weaknessReason(w),
  }));
}

function weaknessReason(w: CoachingActiveWeakness): string {
  const statusLabel = w.status.replace(/_/g, ' ');
  return `Recurring ${w.type.replace(/_/g, ' ')} difficulty (${statusLabel}, ${w.occurrenceCount} occurrence${w.occurrenceCount === 1 ? '' : 's'}).`;
}

/* ------------------------------------------------------------------ *
 * Target expression selection
 * ------------------------------------------------------------------ */

interface TargetCandidate {
  readonly itemId: string;
  readonly label: string;
  readonly meaningDefinition: string;
  readonly reviewState: string | null;
  readonly nextReviewAt: string | null;
}

/** True only for a real stored item that is actually due at `now`. */
function isDue(candidate: TargetCandidate, now: string): boolean {
  if (!candidate.nextReviewAt) return false;
  const dueAt = Date.parse(candidate.nextReviewAt);
  const at = Date.parse(now);
  if (!Number.isFinite(dueAt) || !Number.isFinite(at)) return false;
  return dueAt <= at;
}

/**
 * Deterministic ordering: due items first, then the stored order. Nothing is
 * invented — mastered items are dropped, never reordered around a score.
 */
function dueFirst(
  candidates: readonly TargetCandidate[],
  now: string,
): readonly TargetCandidate[] {
  const due: TargetCandidate[] = [];
  const notDue: TargetCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.reviewState === 'mastered') continue;
    (isDue(candidate, now) ? due : notDue).push(candidate);
  }
  return [...due, ...notDue];
}

/** Honest provenance reason. A stored item is never called "due" unless it is. */
function targetReason(kind: 'expression' | 'word', due: boolean): string {
  const noun = kind === 'expression' ? 'expression' : 'word';
  return due
    ? `Due for review from your saved ${noun}s.`
    : `From your saved ${noun}s — not mastered yet.`;
}

/**
 * Target expressions from EXISTING stored vocabulary/expression data only.
 * Meanings are copied from `meaningDefinition` verbatim (never invented).
 * Expressions are preferred over single words, and due items come first.
 */
function selectTargetExpressions(
  vocabularyFocus: readonly { itemId: string; headword: string; meaningDefinition: string; reviewState: string | null; nextReviewAt: string | null }[],
  expressionFocus: readonly { itemId: string; expression: string; meaningDefinition: string; reviewState: string | null; nextReviewAt: string | null }[],
  maxCount: number,
  now: string,
): readonly SpeakingTargetExpression[] {
  const candidates: SpeakingTargetExpression[] = [];

  // Prefer expressions (richer for speaking) over single words.
  const expressions = dueFirst(
    expressionFocus.map((expr) => ({
      itemId: expr.itemId,
      label: expr.expression,
      meaningDefinition: expr.meaningDefinition,
      reviewState: expr.reviewState,
      nextReviewAt: expr.nextReviewAt,
    })),
    now,
  );
  for (const expr of expressions) {
    if (candidates.length >= maxCount) break;
    candidates.push({
      itemId: expr.itemId,
      headword: expr.label,
      meaning: expr.meaningDefinition,
      reason: targetReason('expression', isDue(expr, now)),
    });
  }

  const vocabulary = dueFirst(
    vocabularyFocus.map((vocab) => ({
      itemId: vocab.itemId,
      label: vocab.headword,
      meaningDefinition: vocab.meaningDefinition,
      reviewState: vocab.reviewState,
      nextReviewAt: vocab.nextReviewAt,
    })),
    now,
  );
  for (const vocab of vocabulary) {
    if (candidates.length >= maxCount) break;
    candidates.push({
      itemId: vocab.itemId,
      headword: vocab.label,
      meaning: vocab.meaningDefinition,
      reason: targetReason('word', isDue(vocab, now)),
    });
  }

  return candidates;
}

/**
 * Additive (Professional English): merge the learner's REAL saved lexical
 * targets with professional scenario language under the SAME existing bound.
 *
 * Honesty rules:
 * - Real evidence ALWAYS keeps priority: professional expressions only fill
 *   the slots not already taken by saved vocabulary/expressions. They never
 *   replace or reorder real targets.
 * - The total stays bounded by MAX_TARGET_EXPRESSIONS (3).
 * - Professional items are labelled as scenario context, not saved vocabulary.
 * - Deterministic: identical input yields the identical merged list.
 */
function mergeProfessionalTargetExpressions(
  realTargets: readonly SpeakingTargetExpression[],
  professional: SpeakingProfessionalScenario | undefined,
): readonly SpeakingTargetExpression[] {
  if (!professional || professional.targetExpressions.length === 0) {
    return realTargets;
  }
  const remaining = MAX_TARGET_EXPRESSIONS - realTargets.length;
  if (remaining <= 0) return realTargets;

  const seen = new Set(realTargets.map((target) => target.headword.trim().toLowerCase()));
  const added: SpeakingTargetExpression[] = [];
  for (const expression of professional.targetExpressions) {
    if (added.length >= remaining) break;
    const key = expression.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    added.push({
      itemId: `professional-${professional.scenarioId}-${added.length}`,
      headword: expression,
      meaning: 'Professional scenario language to use naturally.',
      reason: 'Professional scenario practice target (scenario context, not saved vocabulary).',
    });
  }
  return [...realTargets, ...added];
}

/* ------------------------------------------------------------------ *
 * Focus areas
 * ------------------------------------------------------------------ */

function buildFocusAreas(
  weaknesses: readonly SpeakingWeaknessTarget[],
  expressions: readonly SpeakingTargetExpression[],
  dueVocabCount: number,
  dueExprCount: number,
): readonly SpeakingFocus[] {
  const focus: SpeakingFocus[] = [];

  for (const w of weaknesses) {
    const area = weaknessTypeToFocusArea(w.type);
    focus.push({
      area,
      detail: w.label ?? w.type.replace(/_/g, ' '),
      ...(w.occurrenceCount > 0 ? { count: w.occurrenceCount } : {}),
    });
  }

  if (expressions.length > 0) {
    focus.push({
      area: 'Expressions',
      detail: `${expressions.length} target expression${expressions.length === 1 ? '' : 's'}`,
    });
  } else if (dueExprCount > 0) {
    focus.push({
      area: 'Expressions',
      detail: `${dueExprCount} expression${dueExprCount === 1 ? '' : 's'} due for review`,
      count: dueExprCount,
    });
  }

  if (dueVocabCount > 0) {
    focus.push({
      area: 'Vocabulary',
      detail: `${dueVocabCount} due word${dueVocabCount === 1 ? '' : 's'}`,
      count: dueVocabCount,
    });
  }

  return focus;
}

function weaknessTypeToFocusArea(type: string): SpeakingFocusArea {
  switch (type) {
    case 'grammar': return 'Grammar';
    case 'vocabulary': return 'Vocabulary';
    case 'natural_expression': return 'Expressions';
    case 'fluency': return 'Fluency';
    case 'confidence': return 'Confidence';
    case 'pronunciation': return 'Pronunciation';
    case 'listening': return 'Listening';
    default: return 'Fluency';
  }
}

/* ------------------------------------------------------------------ *
 * Source determination
 * ------------------------------------------------------------------ */

function determineSource(
  weaknesses: readonly SpeakingWeaknessTarget[],
  expressions: readonly SpeakingTargetExpression[],
  hasGoals: boolean,
  hasRecentMemory: boolean,
  practiceType: SpeakingPracticeType,
): SpeakingPracticeSource {
  const hasRealEvidence =
    weaknesses.length > 0 ||
    expressions.length > 0 ||
    (hasGoals && practiceType !== 'free_conversation');

  // free_conversation with no evidence is general even if goals exist
  if (practiceType === 'free_conversation' && !hasRealEvidence && !hasRecentMemory) {
    return 'general';
  }

  if (!hasRealEvidence && !hasRecentMemory) return 'general';

  // If we have real evidence but the practice type is inherently general
  // (free_conversation), it's mixed.
  if (hasRealEvidence && practiceType === 'free_conversation') return 'mixed';

  // reformulation/weakness_retraining require real evidence to be personalized
  if ((practiceType === 'reformulation' || practiceType === 'weakness_retraining') && weaknesses.length === 0) {
    return 'general';
  }

  if (hasRealEvidence) return 'personalized';
  if (hasRecentMemory) return 'mixed';
  return 'general';
}

function sourceNote(source: SpeakingPracticeSource): string {
  switch (source) {
    case 'personalized':
      return 'Built from your own practice history — recurring difficulties, due expressions and learning goals.';
    case 'mixed':
      return 'Partly built from your practice history; the remaining practice is clearly labeled general.';
    case 'general':
      return 'General speaking practice — not enough stored evidence to personalize yet.';
  }
}

/* ------------------------------------------------------------------ *
 * Turn-goal generation
 * ------------------------------------------------------------------ */

function buildTurnGoals(
  targetTurns: number,
  practiceType: SpeakingPracticeType,
  hasExpressions: boolean,
  hasWeaknesses: boolean,
): readonly SpeakingTurnGoal[] {
  const goals: SpeakingTurnGoal[] = [];

  // Turn 0 is the tutor opening (not a learner turn goal per se, but we
  // include it for the system-prompt augmentation of the tutor's first reply).
  goals.push({
    turnIndex: 0,
    goal: 'open',
    instruction: TURN_GOAL_INSTRUCTIONS.open,
  });

  for (let i = 1; i <= targetTurns; i += 1) {
    const goal = determineTurnGoal(i, targetTurns, practiceType, hasExpressions, hasWeaknesses);
    goals.push({
      turnIndex: i,
      goal,
      instruction: TURN_GOAL_INSTRUCTIONS[goal],
    });
  }

  // Wrap-up goal
  goals.push({
    turnIndex: targetTurns + 1,
    goal: 'wrap_up',
    instruction: TURN_GOAL_INSTRUCTIONS.wrap_up,
  });

  return goals;
}

function determineTurnGoal(
  turnIndex: number,
  targetTurns: number,
  practiceType: SpeakingPracticeType,
  hasExpressions: boolean,
  hasWeaknesses: boolean,
): SpeakingTurnGoalKind {
  // Last turn is always wrap_up (handled separately, but just in case)
  if (turnIndex >= targetTurns) return 'wrap_up';

  // Early turns: open or follow_up
  if (turnIndex <= 2) return 'follow_up';

  // Mid turns: weave in target expression or weakness retraining
  if (hasExpressions && (turnIndex === 3 || turnIndex === Math.floor(targetTurns / 2))) {
    return 'target_expression';
  }
  if (hasWeaknesses && (turnIndex === 4 || turnIndex === Math.floor(targetTurns / 2) + 1)) {
    return 'weakness_retraining';
  }

  // Late turns (before wrap-up): follow_up
  return 'follow_up';
}

/* ------------------------------------------------------------------ *
 * Recent memory note
 * ------------------------------------------------------------------ */

function buildRecentMemoryNote(
  recentConversations: readonly { mode: string; topic: string | null; turnCount: number }[],
): string | undefined {
  // Bounded: at most MAX_RECENT_CONVERSATIONS stored summaries, newest first.
  const bounded = recentConversations.slice(0, MAX_RECENT_CONVERSATIONS);
  if (bounded.length === 0) return undefined;
  const parts = bounded.map((conv) => {
    const topicLabel = conv.topic ? `"${conv.topic}"` : 'an open topic';
    return `${topicLabel} in ${conv.mode} mode (${conv.turnCount} turns)`;
  });
  return `You previously practiced ${parts.join('; ')}.`;
}

/* ------------------------------------------------------------------ *
 * Practice type resolution
 * ------------------------------------------------------------------ */

function resolvePracticeType(
  options: SpeakingPlannerOptions | undefined,
  coaching: SpeakingPlanningInput['coaching'],
  evidenceIsReal: boolean,
): SpeakingPracticeType {
  if (options?.practiceType) return options.practiceType;

  if (options?.seed) {
    return 'target_expression_practice';
  }

  // Demo/unknown learner state must not shape the plan: honest general default.
  if (!evidenceIsReal) return 'guided_topic';

  const firstGoal = coaching.profile.learningGoals.find((g) => g.trim().length > 0);
  if (firstGoal) {
    return practiceTypeForGoal(firstGoal);
  }

  return 'guided_topic';
}

/* ------------------------------------------------------------------ *
 * Target turns resolution
 * ------------------------------------------------------------------ */

function resolveTargetTurns(
  options: SpeakingPlannerOptions | undefined,
  evidenceVolume: number,
): number {
  if (options?.targetTurns !== undefined) {
    return clamp(options.targetTurns, MIN_TARGET_TURNS, MAX_TARGET_TURNS);
  }
  if (evidenceVolume <= 2) return MIN_TARGET_TURNS;
  if (evidenceVolume <= 5) return 8;
  if (evidenceVolume <= 8) return 10;
  return MAX_TARGET_TURNS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/* ------------------------------------------------------------------ *
 * Deterministic plan id
 * ------------------------------------------------------------------ */

function planId(learnerId: string, now: string, practiceType: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const identity = `deep-speaking:${learnerId}:${now}:${practiceType}`;
  for (let i = 0; i < identity.length; i += 1) {
    const code = identity.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ (code + i)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  const hex = (n: number, len: number) =>
    n.toString(16).padStart(len, '0').slice(0, len);
  const block = (salt: number) => hex((h1 ^ (h2 + salt)) >>> 0, 8).slice(0, 4);
  return [
    hex(h1 >>> 0, 8),
    block(0x9e37),
    block(0x85eb),
    block(0xc2b2),
    hex((h1 + h2) >>> 0, 8).slice(0, 12),
  ].join('-');
}

/* ------------------------------------------------------------------ *
 * Public planner
 * ------------------------------------------------------------------ */

/**
 * Build a bounded, ordered, explainable speaking-practice plan from real
 * learner state. Pure and deterministic.
 */
export function planSpeakingPractice(
  input: SpeakingPlanningInput,
  options?: SpeakingPlannerOptions,
): SpeakingPracticePlanResult {
  const { coaching, hasProfile, recentConversations, now } = input;
  // Real stored evidence only. Anything else can never be presented as
  // personalization (demo learner data included).
  const evidenceIsReal = input.evidenceIsReal !== false;

  if (!hasProfile || !coaching.profile.learnerId) {
    return {
      status: 'no-profile',
      message: 'Set up your learning profile before starting speaking practice.',
      plan: null,
    };
  }

  const learnerId = coaching.profile.learnerId;
  // Additive (Professional English): bounded scenario content from the content
  // layer. The adapter always pairs it with the mapped EXISTING practice type,
  // so `resolvePracticeType` already resolves it through options.practiceType.
  const professional = options?.professionalScenario;
  const practiceType = resolvePracticeType(options, coaching, evidenceIsReal);
  const scenario = selectScenario(practiceType, learnerId, now);

  // Weakness targets (real evidence only)
  const weaknessTargets = evidenceIsReal
    ? selectWeaknessTargets(coaching.activeWeaknesses, MAX_WEAKNESS_TARGETS)
    : [];

  // Target expressions (real saved evidence only — professional scenario
  // language is merged in later and never counted as learner evidence).
  const realTargetExpressions = evidenceIsReal
    ? selectTargetExpressions(
        coaching.vocabularyFocus,
        coaching.expressionFocus,
        MAX_TARGET_EXPRESSIONS,
        now,
      )
    : [];

  // Focus areas — from real evidence only.
  const dueVocabCount = evidenceIsReal
    ? coaching.vocabularyFocus.filter((v) => v.reviewState !== 'mastered').length
    : 0;
  const dueExprCount = evidenceIsReal
    ? coaching.expressionFocus.filter((e) => e.reviewState !== 'mastered').length
    : 0;
  const focusAreas = buildFocusAreas(
    weaknessTargets,
    realTargetExpressions,
    dueVocabCount,
    dueExprCount,
  );

  // Recent memory (bounded; real persisted conversations only)
  const boundedRecent = evidenceIsReal
    ? recentConversations.slice(0, MAX_RECENT_CONVERSATIONS)
    : [];
  const recentMemoryNote = buildRecentMemoryNote(boundedRecent);

  // The full lexical targets the session will carry: real saved evidence
  // first, professional scenario language only in the remaining slots.
  const targetExpressions = mergeProfessionalTargetExpressions(
    realTargetExpressions,
    professional,
  );

  // Source — determined from REAL learner evidence only. Professional scenario
  // content is practice material, never personalization evidence: a session
  // with only scenario language stays honestly 'general'.
  const hasGoals =
    evidenceIsReal && coaching.profile.learningGoals.some((g) => g.trim().length > 0);
  const source = evidenceIsReal
    ? determineSource(
        weaknessTargets,
        realTargetExpressions,
        hasGoals,
        Boolean(recentMemoryNote),
        practiceType,
      )
    : 'general';

  // Coaching mode
  const coachingMode = defaultCoachingModeForType(
    practiceType,
    coaching.profile.preferredModes,
  );

  // Target turns
  const evidenceVolume =
    weaknessTargets.length +
    targetExpressions.length +
    (recentMemoryNote ? 1 : 0) +
    (hasGoals ? 1 : 0);
  const targetTurns = resolveTargetTurns(options, evidenceVolume);

  // Turn goals
  const turnGoals = buildTurnGoals(
    targetTurns,
    practiceType,
    targetExpressions.length > 0,
    weaknessTargets.length > 0,
  );

  // Seed from adaptive lesson
  const seedFromAdaptiveLesson = options?.seed
    ? { stepId: options.seed.stepId, targetText: options.seed.targetText }
    : undefined;

  // Topic / opening prompt: professional scenario content wins over the
  // generic bank (seed is never set together with a professional scenario in
  // practice; seed still takes precedence if both were somehow present).
  const topic = options?.seed
    ? options.seed.targetText
    : professional
      ? professional.title
      : scenario.topic;

  const scenarioPrompt = options?.seed?.prompt
    ?? (professional ? buildProfessionalScenarioPrompt(professional) : scenario.scenarioPrompt);

  const plan: SpeakingPracticePlan = {
    id: planId(learnerId, now, practiceType),
    learnerId,
    createdAt: now,
    practiceType,
    topic,
    scenarioPrompt,
    coachingMode,
    source,
    sourceNote: sourceNote(source),
    focusAreas,
    targetExpressions,
    weaknessTargets,
    targetTurns,
    hardMaxTurns: HARD_MAX_TURNS,
    turnGoals,
    ...(recentMemoryNote ? { recentMemoryNote } : {}),
    ...(seedFromAdaptiveLesson ? { seedFromAdaptiveLesson } : {}),
    ...(professional ? { professionalScenario: professional } : {}),
  };

  return { status: 'planned', plan };
}
