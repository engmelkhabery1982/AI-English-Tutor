/**
 * Professional English Core — deterministic scenario planner.
 *
 * `planScenario` is a pure, synchronous function: same input, same output.
 * It performs no I/O, no network calls, no AI calls, and no persistence.
 * Personalization is expressed qualitatively — there is no numeric skill
 * score or percentage anywhere in the output.
 */

import {
  DIFFICULTY_ORDER,
  PROFESSIONAL_LEVELS,
  type CategoryDifficultyDescriptor,
  type ChallengeEvent,
  type CoachingMode,
  type DifficultyBand,
  type LearnerProfile,
  type PlannerInput,
  type ProfessionalLevel,
  type ScenarioDefinition,
  type ScenarioPlan,
} from './types';
import { DIFFICULTY_RANK, GENERAL_SCENARIO, getScenario } from './scenarios';

/** Default cap on how many target expressions a plan carries. */
export const DEFAULT_MAX_TARGET_EXPRESSIONS = 6;

/** Difficulty bands that may be supplied via `scenarioDifficulty`. */
const DIFFICULTY_BANDS: readonly DifficultyBand[] = ['simple', 'moderate', 'complex'];

/** A qualitative level ordered by rank, for comparison only. */
function isProfessionalLevel(value: unknown): value is ProfessionalLevel {
  return typeof value === 'string' && (PROFESSIONAL_LEVELS as readonly string[]).includes(value);
}

function isDifficultyBand(value: unknown): value is DifficultyBand {
  return typeof value === 'string' && (DIFFICULTY_BANDS as readonly string[]).includes(value);
}

/** Rank a qualitative difficulty band. */
export function difficultyBandRank(band: DifficultyBand): number {
  return DIFFICULTY_RANK[band];
}

/** Rank a qualitative professional level without turning it into a score. */
export function levelRank(level: ProfessionalLevel): number {
  return PROFESSIONAL_LEVELS.indexOf(level);
}

/**
 * Resolve the effective difficulty band from scenario default + learner input.
 * A learner's explicit `scenarioDifficulty` (band or level) takes precedence,
 * otherwise the scenario's own band is used.
 */
export function resolveDifficulty(
  scenario: ScenarioDefinition,
  learner?: LearnerProfile,
): { band: DifficultyBand; descriptor: CategoryDifficultyDescriptor; applied: boolean } {
  const requested = learner?.scenarioDifficulty;
  if (requested === undefined) {
    return { band: scenario.difficulty.band, descriptor: scenario.difficulty, applied: false };
  }

  let band: DifficultyBand;
  if (isDifficultyBand(requested)) {
    band = requested;
  } else if (isProfessionalLevel(requested)) {
    // Map qualitative level -> qualitative band using ordered buckets only.
    const rank = levelRank(requested);
    band = rank === 0 ? 'simple' : rank === 1 ? 'moderate' : 'complex';
  } else {
    band = scenario.difficulty.band;
  }

  if (band === scenario.difficulty.band) {
    return { band, descriptor: scenario.difficulty, applied: true };
  }

  const descriptor: CategoryDifficultyDescriptor = {
    band,
    reasoning: `Adjusting from the scenario default of "${scenario.difficulty.band}" to "${band}" per learner preference.`,
  };
  return { band, descriptor, applied: true };
}

/**
 * Select challenge events whose gate is met by the effective difficulty rank.
 * Always at least one challenge so practice stays adaptive; never more than
 * the scenario itself offers.
 */
export function selectChallenges(
  scenario: ScenarioDefinition,
  difficulty: DifficultyBand,
): readonly ChallengeEvent[] {
  const rank = difficultyBandRank(difficulty);
  const eligible = scenario.challengeEvents.filter(
    (event) => event.minComplexityRank <= rank,
  );
  if (eligible.length > 0) {
    return eligible;
  }
  return scenario.challengeEvents.slice(0, 1);
}

/** Merge scenario expressions with learner-supplied ones, deduped, bounded. */
export function selectTargetExpressions(
  scenario: ScenarioDefinition,
  learner: LearnerProfile | undefined,
  max: number,
): readonly string[] {
  const cap = Math.max(0, Math.floor(max));
  if (cap === 0) {
    return [];
  }

  const merged: string[] = [];
  const seen = new Set<string>();

  const push = (value: string): void => {
    const key = value.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(value);
  };

  // Learner-supplied expressions are prioritised as personalization targets.
  for (const expression of learner?.targetExpressions ?? []) {
    push(expression);
  }
  for (const expression of scenario.targetExpressions) {
    push(expression);
  }

  return merged.slice(0, cap);
}

/** Resolve coaching mode from explicit learner preference or level. */
export function resolveCoachingMode(learner?: LearnerProfile): CoachingMode {
  if (learner?.coachingMode) {
    return learner.coachingMode;
  }
  const level = learner?.level;
  if (level === 'foundation' || level === 'developing') {
    return 'supportive';
  }
  if (level === 'advanced') {
    return 'challenging';
  }
  return 'balanced';
}

/** Build the qualitative personalization rationale (never numeric). */
function buildPersonalizationNotes(
  learner: LearnerProfile | undefined,
  difficulty: DifficultyBand,
  difficultyApplied: boolean,
): readonly string[] {
  const notes: string[] = [];

  if (!learner || Object.keys(learner).length === 0) {
    notes.push('No learner profile supplied; using the scenario defaults.');
    return notes;
  }

  if (learner.level) {
    notes.push(`Coaching pitched for a ${learner.level} level learner.`);
  }
  if (learner.profession && learner.profession.trim().length > 0) {
    notes.push(`Examples and register adapted to the "${learner.profession}" context.`);
  }
  if (learner.goals && learner.goals.length > 0) {
    notes.push(`Aligned with the learner's stated goals: ${learner.goals.join(', ')}.`);
  }
  if (learner.weaknesses && learner.weaknesses.length > 0) {
    notes.push(`Extra attention on stated areas: ${learner.weaknesses.join('; ')}.`);
  }
  if (learner.targetExpressions && learner.targetExpressions.length > 0) {
    notes.push('Prioritised the learner’s own target expressions.');
  }
  if (difficultyApplied) {
    notes.push(`Scenario difficulty set to "${difficulty}" per learner preference.`);
  }

  return notes;
}

/**
 * Build a deterministic scenario plan.
 *
 * Pure function: no AI, no network, no persistence, no randomness.
 * Unknown categories fall back to the general scenario (`isFallback: true`).
 */
export function planScenario(input: PlannerInput): ScenarioPlan {
  const scenario = getScenario(input.category);
  const definition = scenario ?? GENERAL_SCENARIO;
  const isFallback = scenario === undefined;

  const learner = input.learner;
  const { band, descriptor, applied } = resolveDifficulty(definition, learner);
  const max =
    input.maxTargetExpressions === undefined
      ? DEFAULT_MAX_TARGET_EXPRESSIONS
      : input.maxTargetExpressions;

  return {
    scenarioId: definition.id,
    category: definition.category,
    title: definition.title,
    situation: definition.situation,
    learnerRole: definition.learnerRole,
    counterpartyRole: definition.counterpartyRole,
    objective: definition.objective,
    speakingGoals: definition.speakingGoals,
    languageGoals: definition.languageGoals,
    targetExpressions: selectTargetExpressions(definition, learner, max),
    challengeEvents: selectChallenges(definition, band),
    practiceType: definition.practiceType,
    difficulty: band,
    difficultyDescriptor: descriptor,
    coachingMode: resolveCoachingMode(learner),
    coachingNotes: definition.coachingNotes,
    personalizationNotes: buildPersonalizationNotes(learner, band, applied),
    isFallback,
  };
}

/** Exposed for tests and ordering checks. */
export const DIFFICULTY_ORDER_VALUES = DIFFICULTY_ORDER;
