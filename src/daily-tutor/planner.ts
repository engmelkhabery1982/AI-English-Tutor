/**
 * src/daily-tutor/planner.ts
 *
 * Daily AI Tutor Loop — deterministic activity planner.
 *
 * PURE and deterministic: same input → identical plan. No clock (the date key
 * is an input), no randomness (variety comes from a day-index rotation, never
 * Math.random), no I/O, no AI. Planning is local and offline-safe by design.
 *
 * SELECTION POLICY (priority order)
 *   1. Due review / relapsed / confirmed weaknesses (urgent — never
 *      penalized for recent practice).
 *   2. Active training / repeated / observed areas.
 *   3. Curriculum progression and learner goals (the recommendations of the
 *      EXISTING curriculum planner are an INPUT here — priority logic,
 *      lifecycle ordering and prerequisites stay owned by Curriculum).
 *   4. Balanced skill rotation (deterministic day rotation for variety).
 *
 * VARIETY RULES
 *   - No duplicate activity kinds in one session.
 *   - Family caps: at most 2 review-family, 2 speaking-family and 2
 *     adaptive-family activities — a plan is never "speaking + speaking +
 *     speaking + speaking" unless real urgent evidence fills the speaking
 *     family cap.
 *   - Activities are interleaved so two same-family activities are not
 *     adjacent when a different family is still available.
 *   - Recently practised kinds are deprioritized (unless still urgent).
 *
 * HONESTY RULES
 *   - 3–5 activities, ~15–25 estimated minutes (guidance only, no timers).
 *   - Professional English appears ONLY when real stored goals map to
 *     professional practice, never on alternate-consecutive days, and never
 *     for every learner.
 *   - `sourceMode` reflects how many selected activities were driven by real
 *     stored evidence (personalized ≥ 2, mixed = 1, general = 0).
 *   - Reasons state real evidence only ("4 expressions are due for review"),
 *     never invented improvement.
 */

import { mapLearningGoals } from '../professional-english';
import { GOAL_RELEVANT_CATEGORIES } from '../professional-english/planner';
import type { ScenarioCategory } from '../professional-english';
import type { LearningGoalHint } from '../curriculum/types';
import { daysBetweenDateKeys, rotationOf } from './date';
import type {
  DailyActivityKind,
  DailyTutorActivityPlan,
  DailyTutorActivityTarget,
  DailyTutorPlan,
  DailyTutorPlanningInput,
  DailyTutorWeaknessEvidence,
} from './types';

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/** Hard bounds on session size. */
export const MIN_ACTIVITIES = 3;
export const MAX_ACTIVITIES = 5;
/** Soft time budget (minutes) — guidance, never a timer. */
export const TARGET_MINUTES_MAX = 25;
export const TARGET_MINUTES_MIN = 15;
/** Bounded review subset the daily plan may ask the Review flow for. */
export const MAX_REVIEW_LIMIT = 6;

/** Honest planning estimates per activity kind (never measurements). */
const ESTIMATED_MINUTES: Readonly<Record<DailyActivityKind, number>> = {
  review: 5,
  vocabulary: 5,
  expressions: 5,
  adaptive_lesson: 6,
  listening: 5,
  pronunciation: 5,
  deep_speaking: 7,
  professional_english: 7,
  weakness_retraining: 7,
};

/** Modality families used for variety caps and interleaving. */
type ActivityFamily = 'review' | 'adaptive' | 'listening' | 'speaking';

/** Max activities per family in one session. */
const FAMILY_CAPS: Readonly<Record<ActivityFamily, number>> = {
  review: 2,
  adaptive: 2,
  listening: 1,
  speaking: 2,
};

/**
 * Lifecycle priority for weakness-driven work. Mirrors the Curriculum
 * philosophy (relapsed > confirmed > active_training > repeated > observed >
 * improving > stable; mastered excluded) applied to the learner's REAL
 * weakness rows — the ordering the Daily Tutor must respect.
 */
const WEAKNESS_STATUS_PRIORITY: Readonly<Record<string, number>> = {
  relapsed: 95,
  confirmed: 90,
  active_training: 80,
  repeated: 70,
  observed: 60,
  improving: 40,
  stable: 10,
  mastered: 0,
};

/** Statuses that justify dedicated weakness retraining. */
const RETRAINING_STATUSES: ReadonlySet<string> = new Set([
  'relapsed',
  'confirmed',
  'active_training',
  'repeated',
]);

/**
 * Priority rank of a weakness lifecycle state (shared with the service's
 * evidence assembly). Higher = more urgent. Unknown states rank lowest.
 */
export function weaknessStatusPriority(status: string): number {
  return WEAKNESS_STATUS_PRIORITY[status] ?? -1;
}

/** Statuses urgent enough to ignore recent-practice penalties. */
const URGENT_WEAKNESS_STATUSES: ReadonlySet<string> = new Set(['relapsed', 'confirmed']);

/** Honest mapping from curriculum speaking skills to existing practice types. */
const SPEAKING_SKILL_PRACTICE_TYPE: Readonly<Record<string, string>> = {
  fluency: 'free_conversation',
  elaboration: 'explain_and_expand',
  follow_up_questions: 'guided_topic',
  opinion_and_reasoning: 'opinion_and_reasoning',
  explanation: 'explain_and_expand',
  problem_solving: 'problem_solution',
  reformulation: 'reformulation',
};

/** Deterministic keyword mapping from stored goal text to curriculum hints. */
const GOAL_HINT_MATCHERS: readonly { readonly pattern: RegExp; readonly hint: LearningGoalHint }[] = [
  { pattern: /work|business|professional|office|career|job/i, hint: 'workplace_communication' },
  { pattern: /listen/i, hint: 'listening_comprehension' },
  { pattern: /pronounc/i, hint: 'pronunciation_clarity' },
  { pattern: /vocab|word/i, hint: 'vocabulary_growth' },
  { pattern: /grammar|accura/i, hint: 'grammar_accuracy' },
  { pattern: /confiden/i, hint: 'speaking_confidence' },
  { pattern: /fluen|everyday|daily|conversation/i, hint: 'everyday_fluency' },
];

/**
 * Map free-text learner goals onto curriculum goal hints. Unmatched goals are
 * dropped honestly — a hint is never invented.
 */
export function mapLearningGoalsToCurriculumHints(
  goals: readonly string[],
): readonly LearningGoalHint[] {
  const hints: LearningGoalHint[] = [];
  const seen = new Set<LearningGoalHint>();
  for (const goal of goals) {
    if (typeof goal !== 'string' || goal.length === 0) continue;
    for (const matcher of GOAL_HINT_MATCHERS) {
      if (matcher.pattern.test(goal) && !seen.has(matcher.hint)) {
        seen.add(matcher.hint);
        hints.push(matcher.hint);
        break;
      }
    }
  }
  return hints;
}

/**
 * True when stored goals map to at least one PROFESSIONAL learning goal
 * (anything except plain everyday fluency) — the honest eligibility signal
 * for Professional English activities. Reuses the existing PE mapping.
 */
export function hasProfessionalGoal(goals: readonly string[]): boolean {
  return mapLearningGoals(goals).some((goal) => goal !== 'everyday_fluency');
}

/**
 * Deterministically choose a Professional English scenario category from the
 * learner's real mapped goals, rotated by the day index for variety.
 * Reuses GOAL_RELEVANT_CATEGORIES from the existing PE planner.
 */
export function chooseProfessionalCategory(
  goals: readonly string[],
  dateKey: string,
): ScenarioCategory {
  const mapped = mapLearningGoals(goals).filter((goal) => goal !== 'everyday_fluency');
  const relevant: ScenarioCategory[] = [];
  const seen = new Set<ScenarioCategory>();
  for (const goal of mapped) {
    for (const category of GOAL_RELEVANT_CATEGORIES[goal] ?? []) {
      if (!seen.has(category)) {
        seen.add(category);
        relevant.push(category);
      }
    }
  }
  if (relevant.length === 0) {
    // Honest default: the universal workplace scenario, rotated over time.
    const rotation = rotationOf(dateKey, 3);
    const fallbacks: readonly ScenarioCategory[] = ['meeting', 'project_update', 'problem_solving'];
    return fallbacks[rotation % fallbacks.length];
  }
  return relevant[rotationOf(dateKey, relevant.length)];
}

/* ------------------------------------------------------------------ *
 * Candidates
 * ------------------------------------------------------------------ */

export interface ActivityCandidate {
  readonly kind: DailyActivityKind;
  readonly title: string;
  readonly reason: string;
  readonly target: DailyTutorActivityTarget;
  readonly priority: number;
  readonly family: ActivityFamily;
  /** Urgent candidates are exempt from recent-practice penalties. */
  readonly urgent: boolean;
  /** True when real stored evidence drove this candidate (sourceMode). */
  readonly evidenceDriven: boolean;
  /** Insertion index — the deterministic final tie-breaker. */
  readonly index: number;
}

function candidateId(dateKey: string, kind: DailyActivityKind): string {
  return `dt:${dateKey}:${kind}`;
}

function estimatedMinutesFor(
  kind: DailyActivityKind,
  target: DailyTutorActivityTarget,
): number {
  if (target.reviewLimit !== undefined) {
    return Math.min(7, Math.max(4, 2 + target.reviewLimit));
  }
  return ESTIMATED_MINUTES[kind];
}

/** Deterministic comparison: priority desc, then insertion order. */
function byPriorityDesc(a: ActivityCandidate, b: ActivityCandidate): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  return a.index - b.index;
}

/** Deterministic string compare (no locale dependence). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The most retraining-worthy weakness (lifecycle order, then severity…). */
export function pickTopWeakness(
  weaknesses: readonly DailyTutorWeaknessEvidence[],
): DailyTutorWeaknessEvidence | null {
  const eligible = weaknesses.filter((w) => RETRAINING_STATUSES.has(w.status));
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) => {
    const statusDiff =
      (WEAKNESS_STATUS_PRIORITY[b.status] ?? 0) - (WEAKNESS_STATUS_PRIORITY[a.status] ?? 0);
    if (statusDiff !== 0) return statusDiff;
    if (b.severity !== a.severity) return b.severity - a.severity;
    if (b.occurrenceCount !== a.occurrenceCount) return b.occurrenceCount - a.occurrenceCount;
    return compareStrings(a.id, b.id);
  });
  return sorted[0] ?? null;
}

/** Best (highest) retraining priority among weaknesses of one type. */
function bestWeaknessPriorityOfType(
  weaknesses: readonly DailyTutorWeaknessEvidence[],
  type: string,
): number {
  let best = -1;
  for (const weakness of weaknesses) {
    if (weakness.type !== type) continue;
    if (!RETRAINING_STATUSES.has(weakness.status)) continue;
    const priority = WEAKNESS_STATUS_PRIORITY[weakness.status] ?? 0;
    if (priority > best) best = priority;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Plan assembly
 * ------------------------------------------------------------------ */

/** Recent-practice penalty for a kind (non-urgent candidates only). */
function recentPracticePenalty(
  kind: DailyActivityKind,
  input: DailyTutorPlanningInput,
): number {
  let penalty = 0;
  for (const session of input.recentSessions) {
    if (session.dateKey === input.dateKey) continue;
    const age = daysBetweenDateKeys(input.dateKey, session.dateKey);
    if (!session.kinds.includes(kind)) continue;
    if (age === 1) penalty += 10;
    else if (age === 2) penalty += 6;
    else if (age === 3) penalty += 3;
  }
  return Math.min(penalty, 19);
}

function buildCandidates(input: DailyTutorPlanningInput): ActivityCandidate[] {
  const candidates: ActivityCandidate[] = [];
  let index = 0;

  const push = (candidate: Omit<ActivityCandidate, 'index'>): void => {
    candidates.push({ ...candidate, index: index++ });
  };

  /* --- 1. Due review (first priority; urgent, never penalized) --- */
  const reviewLimitFor = (count: number): number =>
    Math.max(1, Math.min(MAX_REVIEW_LIMIT, count));

  if (input.dueVocabularyCount > 0) {
    const limit = reviewLimitFor(input.dueVocabularyCount);
    push({
      kind: 'vocabulary',
      title: `Review ${limit} due ${limit === 1 ? 'word' : 'words'}`,
      reason: `${input.dueVocabularyCount} saved ${input.dueVocabularyCount === 1 ? 'word is' : 'words are'} due for review.`,
      target: { reviewKind: 'vocabulary', reviewLimit: limit },
      priority: 100 + Math.min(input.dueVocabularyCount, 20) * 2 + 2,
      family: 'review',
      urgent: true,
      evidenceDriven: true,
    });
  }
  if (input.dueExpressionCount > 0) {
    const limit = reviewLimitFor(input.dueExpressionCount);
    push({
      kind: 'expressions',
      title: `Review ${limit} due ${limit === 1 ? 'expression' : 'expressions'}`,
      reason: `${input.dueExpressionCount} saved ${input.dueExpressionCount === 1 ? 'expression is' : 'expressions are'} due for review.`,
      target: { reviewKind: 'expression', reviewLimit: limit },
      priority: 100 + Math.min(input.dueExpressionCount, 20) * 2 + 1,
      family: 'review',
      urgent: true,
      evidenceDriven: true,
    });
  }
  if (input.dueOtherReviewCount > 0) {
    const limit = reviewLimitFor(input.dueOtherReviewCount);
    push({
      kind: 'review',
      title: `Quick review — ${limit} due ${limit === 1 ? 'item' : 'items'}`,
      reason: `${input.dueOtherReviewCount} review ${input.dueOtherReviewCount === 1 ? 'item is' : 'items are'} due (grammar, pronunciation, listening).`,
      target: { reviewLimit: limit },
      priority: 100 + Math.min(input.dueOtherReviewCount, 20) * 2,
      family: 'review',
      urgent: true,
      evidenceDriven: true,
    });
  }

  /* --- 2. Weakness retraining (relapsed > confirmed > active_training > repeated) --- */
  const topWeakness = pickTopWeakness(input.activeWeaknesses);
  if (topWeakness) {
    const statusPriority = WEAKNESS_STATUS_PRIORITY[topWeakness.status] ?? 0;
    const label = topWeakness.label?.trim();
    push({
      kind: 'weakness_retraining',
      title: label
        ? `Retrain: ${label}`
        : `Weakness retraining (${topWeakness.type.replace(/_/g, ' ')})`,
      reason: `A ${topWeakness.status.replace(/_/g, ' ')} weakness from your own practice history.`,
      target: {
        practiceType: 'weakness_retraining',
        weaknessId: topWeakness.id,
        weaknessStatus: topWeakness.status,
      },
      priority: statusPriority + Math.min(topWeakness.occurrenceCount, 10),
      family: 'speaking',
      urgent: URGENT_WEAKNESS_STATUSES.has(topWeakness.status),
      evidenceDriven: true,
    });
  }

  /* Listening weaknesses are retrained by the EXISTING Listening Engine
   * (its own planner puts listening-weakness retraining first). */
  const listeningWeaknessPriority = bestWeaknessPriorityOfType(input.activeWeaknesses, 'listening');
  if (listeningWeaknessPriority > 0) {
    push({
      kind: 'listening',
      title: 'Listening retraining',
      reason: 'A real listening weakness from your history — the listening engine retrains it first.',
      target: {},
      priority: listeningWeaknessPriority,
      family: 'listening',
      urgent: listeningWeaknessPriority >= WEAKNESS_STATUS_PRIORITY.confirmed,
      evidenceDriven: true,
    });
  }

  /* --- 3. Pronunciation evidence (existing Pronunciation Engine targets) --- */
  if (input.unresolvedPronunciationCount > 0) {
    const firstTarget = input.pronunciationTargets[0];
    push({
      kind: 'pronunciation',
      title: 'Pronunciation practice',
      reason: `${input.unresolvedPronunciationCount} pronunciation ${
        input.unresolvedPronunciationCount === 1 ? 'target is' : 'targets are'
      } recorded in your history.`,
      target: firstTarget ? { pronunciationTarget: firstTarget } : {},
      priority: 65 + Math.min(input.unresolvedPronunciationCount, 5),
      family: 'adaptive',
      urgent: false,
      evidenceDriven: true,
    });
  }

  /* --- 4. Curriculum progression (recommendations of the EXISTING planner) --- */
  input.curriculum.forEach((rec, recIndex) => {
    const evidenceDriven = rec.lifecycleState !== null;
    const reason = evidenceDriven
      ? `Curriculum priority: ${rec.title} (${rec.lifecycleState?.replace(/_/g, ' ')}).`
      : `Curriculum next step: ${rec.title} (no evidence yet).`;
    switch (rec.domain) {
      case 'listening':
        push({
          kind: 'listening',
          title: `Listening — ${rec.title}`,
          reason,
          target: { skillId: rec.skillId, domain: rec.domain },
          priority: 55 - recIndex * 5,
          family: 'listening',
          urgent: false,
          evidenceDriven,
        });
        break;
      case 'pronunciation':
        // Pronunciation practice needs REAL targets (Phase 1 is
        // evidence-based): without stored evidence there is nothing honest
        // to practise, so an unobserved pronunciation skill is skipped.
        if (input.unresolvedPronunciationCount > 0) {
          push({
            kind: 'pronunciation',
            title: `Pronunciation — ${rec.title}`,
            reason,
            target: {
              skillId: rec.skillId,
              domain: rec.domain,
              ...(input.pronunciationTargets[0]
                ? { pronunciationTarget: input.pronunciationTargets[0] }
                : {}),
            },
            priority: 55 - recIndex * 5,
            family: 'adaptive',
            urgent: false,
            evidenceDriven,
          });
        }
        break;
      case 'speaking': {
        const practiceType =
          SPEAKING_SKILL_PRACTICE_TYPE[rec.skillId] ?? 'guided_topic';
        push({
          kind: 'deep_speaking',
          title: `Speaking — ${rec.title}`,
          reason,
          target: { skillId: rec.skillId, domain: rec.domain, practiceType },
          priority: 55 - recIndex * 5,
          family: 'speaking',
          urgent: false,
          evidenceDriven,
        });
        break;
      }
      case 'grammar':
      case 'vocabulary':
      case 'expressions':
      default:
        push({
          kind: 'adaptive_lesson',
          title: `Adaptive lesson — ${rec.title}`,
          reason,
          target: { skillId: rec.skillId, domain: rec.domain },
          priority: 55 - recIndex * 5,
          family: 'adaptive',
          urgent: false,
          evidenceDriven,
        });
        break;
    }
  });

  /* --- 5. Professional English (only from real goals; never daily) --- */
  const professionalYesterday = input.recentSessions.some(
    (session) =>
      session.dateKey !== input.dateKey &&
      daysBetweenDateKeys(input.dateKey, session.dateKey) === 1 &&
      session.kinds.includes('professional_english'),
  );
  if (hasProfessionalGoal(input.learningGoals) && rotationOf(input.dateKey, 2) === 0 && !professionalYesterday) {
    const category = chooseProfessionalCategory(input.learningGoals, input.dateKey);
    push({
      kind: 'professional_english',
      title: `Professional English — ${category.replace(/_/g, ' ')}`,
      reason: 'Your goals include workplace communication (planned every other day at most).',
      target: { professionalCategory: category },
      priority: 52,
      family: 'speaking',
      urgent: false,
      evidenceDriven: true,
    });
  }

  /* --- 6. Balanced general rotation (honest fill, never fabricated) --- */
  const generalPool: readonly { kind: DailyActivityKind; title: string; family: ActivityFamily }[] =
    [
      { kind: 'adaptive_lesson', title: 'Adaptive lesson', family: 'adaptive' },
      { kind: 'listening', title: 'Listening practice', family: 'listening' },
      { kind: 'deep_speaking', title: 'Speaking practice', family: 'speaking' },
    ];
  const rotation = rotationOf(input.dateKey, generalPool.length);
  for (let offset = 0; offset < generalPool.length; offset += 1) {
    const entry = generalPool[(rotation + offset) % generalPool.length];
    if (candidates.some((c) => c.kind === entry.kind)) continue;
    push({
      kind: entry.kind,
      title: entry.title,
      reason: 'Balanced practice — this will personalize as you build history.',
      target: {},
      priority: 20,
      family: entry.family,
      urgent: false,
      evidenceDriven: false,
    });
  }

  /* --- 7. Recent-practice penalties (variety across days; urgent exempt) --- */
  const penalized = candidates.map((candidate) => {
    if (candidate.urgent) return candidate;
    let priority = candidate.priority - recentPracticePenalty(candidate.kind, input);
    // A learner with several recent conversations has been speaking a lot
    // outside the Daily Tutor: slightly deprioritize more speaking.
    if (candidate.family === 'speaking' && input.recentConversations.length >= 2) {
      priority -= 5;
    }
    return { ...candidate, priority };
  });

  return penalized;
}

/** Can `candidate` join `selected` under the variety rules? */
function isSelectable(candidate: ActivityCandidate, selectedKinds: Set<DailyActivityKind>, familyCounts: Map<ActivityFamily, number>): boolean {
  if (selectedKinds.has(candidate.kind)) return false;
  if (selectedKinds.size >= MAX_ACTIVITIES) return false;
  return (familyCounts.get(candidate.family) ?? 0) < FAMILY_CAPS[candidate.family];
}

function selectActivities(candidates: ActivityCandidate[]): ActivityCandidate[] {
  const sorted = [...candidates].sort(byPriorityDesc);
  const selected: ActivityCandidate[] = [];
  const selectedKinds = new Set<DailyActivityKind>();
  const familyCounts = new Map<ActivityFamily, number>();

  for (const candidate of sorted) {
    if (selected.length >= MAX_ACTIVITIES) break;
    if (!isSelectable(candidate, selectedKinds, familyCounts)) continue;
    selected.push(candidate);
    selectedKinds.add(candidate.kind);
    familyCounts.set(candidate.family, (familyCounts.get(candidate.family) ?? 0) + 1);
  }

  /* Soft time budget: trim optional low-priority activities that push the
   * estimate past the guidance maximum (never below the minimum count).
   * `selected` is priority-sorted, so the last item is always the
   * lowest-priority activity; index 0 (the plan's top driver) is never
   * removed. */
  const totalMinutes = (): number =>
    selected.reduce((sum, c) => sum + estimatedMinutesFor(c.kind, c.target), 0);
  while (selected.length > MIN_ACTIVITIES && totalMinutes() > TARGET_MINUTES_MAX) {
    selected.pop();
  }

  return selected;
}

/**
 * Interleave for modality variety: never place two same-family activities
 * next to each other while a different family is still available.
 * Deterministic — a pure function of the priority-sorted selection.
 */
export function interleaveForVariety(selected: readonly ActivityCandidate[]): ActivityCandidate[] {
  const remaining = [...selected];
  const ordered: ActivityCandidate[] = [];
  let lastFamily: ActivityFamily | null = null;
  while (remaining.length > 0) {
    let pickIndex = remaining.findIndex((c) => c.family !== lastFamily);
    if (pickIndex < 0) pickIndex = 0;
    const [picked] = remaining.splice(pickIndex, 1);
    ordered.push(picked);
    lastFamily = picked.family;
  }
  return ordered;
}

/** Honest session-level headline built from the real drivers. */
function buildHeadline(
  input: DailyTutorPlanningInput,
  selected: readonly ActivityCandidate[],
): string {
  const parts: string[] = [];
  const dueTotal =
    input.dueVocabularyCount + input.dueExpressionCount + input.dueOtherReviewCount;
  if (dueTotal > 0) {
    parts.push(`${dueTotal} ${dueTotal === 1 ? 'item is' : 'items are'} due for review`);
  }
  const topWeakness = pickTopWeakness(input.activeWeaknesses);
  if (topWeakness && URGENT_WEAKNESS_STATUSES.has(topWeakness.status)) {
    parts.push(`a ${topWeakness.status.replace(/_/g, ' ')} weakness needs retraining`);
  }
  const professional = selected.find((c) => c.kind === 'professional_english');
  if (professional) {
    parts.push('your goals include workplace practice');
  }
  const curriculumSkill = selected.find((c) => c.target.skillId !== undefined);
  if (parts.length === 0 && curriculumSkill) {
    parts.push(`your curriculum continues with ${curriculumSkill.target.skillId?.replace(/_/g, ' ')}`);
  }
  if (parts.length === 0) {
    return 'A balanced session to keep you practising — it will personalize as you build history.';
  }
  const drivers = parts.slice(0, 2).join(' and ');
  return `Today focuses on ${drivers}.`;
}

/** Honest sourceMode: how many selected activities real evidence drove. */
function sourceModeOf(selected: readonly ActivityCandidate[]): 'personalized' | 'mixed' | 'general' {
  const evidenceDriven = selected.filter((c) => c.evidenceDriven).length;
  if (evidenceDriven >= 2) return 'personalized';
  if (evidenceDriven === 1) return 'mixed';
  return 'general';
}

/**
 * Plan today's daily session. Pure and deterministic: the same input (which
 * includes the date key) always yields the identical plan.
 */
export function planDailyTutorSession(input: DailyTutorPlanningInput): DailyTutorPlan {
  const candidates = buildCandidates(input);
  const selected = selectActivities(candidates);
  const ordered = interleaveForVariety(selected);

  const activities: DailyTutorActivityPlan[] = ordered.map((candidate) => ({
    id: candidateId(input.dateKey, candidate.kind),
    kind: candidate.kind,
    title: candidate.title,
    reason: candidate.reason,
    estimatedMinutes: estimatedMinutesFor(candidate.kind, candidate.target),
    target: candidate.target,
  }));

  const estimatedMinutes = activities.reduce((sum, a) => sum + a.estimatedMinutes, 0);

  return {
    learnerId: input.learnerId,
    dateKey: input.dateKey,
    headline: buildHeadline(input, ordered),
    sourceMode: sourceModeOf(ordered),
    estimatedMinutes,
    activities,
  };
}
