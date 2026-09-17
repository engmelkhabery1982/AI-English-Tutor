/**
 * Professional English Core — deterministic scenario planner.
 *
 * `planScenario` is a pure, synchronous function: same input, same output.
 * It performs no I/O, no network calls, no AI calls, and no persistence.
 * Personalization is expressed qualitatively — there is no numeric skill
 * score or percentage anywhere in the output.
 *
 * Honesty rule: every personalization note must correspond to a MATERIAL,
 * deterministic change in the returned plan. If a learner attribute does not
 * change a field of the plan, the planner does not claim it was applied.
 */

import {
  DIFFICULTY_ORDER,
  PROFESSIONAL_LEVELS,
  type CategoryDifficultyDescriptor,
  type ChallengeEvent,
  type CoachingMode,
  type DifficultyBand,
  type LanguageGoal,
  type LearnerProfile,
  type LearningGoal,
  type PlannerInput,
  type ProfessionalLevel,
  type ScenarioCategory,
  type ScenarioDefinition,
  type ScenarioPlan,
  type SpeakingGoal,
} from './types';
import { DIFFICULTY_RANK, GENERAL_SCENARIO, getScenario } from './scenarios';

/** Default cap on how many target expressions a plan carries. */
export const DEFAULT_MAX_TARGET_EXPRESSIONS = 6;

/** Difficulty bands that may be supplied via `scenarioDifficulty`. */
const DIFFICULTY_BANDS: readonly DifficultyBand[] = ['simple', 'moderate', 'complex'];

/**
 * Deterministic mapping from a learner goal to the scenario categories that
 * goal is most relevant to. Used to (a) flag goal alignment and (b) reorder
 * speaking goals so the ones matching the learner's stated goals come first.
 */
export const GOAL_RELEVANT_CATEGORIES: Record<LearningGoal, readonly ScenarioCategory[]> = {
  everyday_fluency: [
    'meeting',
    'problem_solving',
    'technical_explanation',
    'email_discussion',
  ],
  workplace_communication: [
    'meeting',
    'project_update',
    'email_discussion',
    'problem_solving',
    'leadership_conversation',
  ],
  client_communication: [
    'client_discussion',
    'claim_discussion',
    'contract_discussion',
    'stakeholder_discussion',
  ],
  meetings_and_updates: ['meeting', 'project_update', 'reporting'],
  presentations: ['presentation', 'reporting', 'technical_explanation'],
  interviews: ['interview'],
  negotiation: ['negotiation', 'contract_discussion', 'stakeholder_discussion'],
  technical_discussion: ['technical_explanation', 'problem_solving', 'reporting'],
  leadership: ['leadership_conversation', 'stakeholder_discussion', 'meeting'],
  reporting_and_writing: ['reporting', 'email_discussion', 'project_update'],
};

/**
 * Deterministic mapping from a qualitative weakness keyword to the language
 * goal it should be emphasised by moving to the front of `languageGoals`.
 * Only safe, well-understood emphasis mappings are listed; anything not
 * matched here is treated as context, never as an applied adaptation.
 */
export const WEAKNESS_LANGUAGE_EMPHASIS: readonly {
  readonly match: RegExp;
  readonly languageGoalId: string;
}[] = [
  { match: /hesit|pause|slow|stumbl|filler/i, languageGoalId: 'fillers' },
  { match: /fluen|speed|fast|rush|pace/i, languageGoalId: 'pace' },
  { match: /grammar|tense|verb/i, languageGoalId: 'accuracy' },
  { match: /vocab|word|lexic|express/i, languageGoalId: 'range' },
  { match: /pronunciation|accent|stress|intonation/i, languageGoalId: 'pronunciation' },
  { match: /listening|understand|follow/i, languageGoalId: 'confirmation' },
  { match: /formal|register|polite|tone/i, languageGoalId: 'register' },
  { match: /structure|organis|organiz|tangent|ramble/i, languageGoalId: 'structure' },
];

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

/**
 * Goals relevant to the requested category, preserving the learner's own
 * order. Empty when the learner stated no goals or none map to this category.
 */
export function relevantGoals(
  goals: readonly LearningGoal[] | undefined,
  category: ScenarioCategory,
): readonly LearningGoal[] {
  if (!goals || goals.length === 0) {
    return [];
  }
  return goals.filter((goal) => GOAL_RELEVANT_CATEGORIES[goal]?.includes(category));
}

/**
 * Deterministically reorder speaking goals so those flagged by the learner's
 * relevant goals come first. This is a REAL change to the generated plan:
 * the same goals in a different order. Order is otherwise preserved.
 */
export function prioritizeSpeakingGoals(
  scenario: ScenarioDefinition,
  goals: readonly LearningGoal[] | undefined,
  category: ScenarioCategory,
): { goals: readonly SpeakingGoal[]; reordered: boolean } {
  const relevant = relevantGoals(goals, category);
  if (relevant.length === 0) {
    return { goals: scenario.speakingGoals, reordered: false };
  }

  const selectedFirst: SpeakingGoal[] = [];
  const remaining: SpeakingGoal[] = [];
  for (const speakingGoal of scenario.speakingGoals) {
    if (relevant.includes(speakingGoal.id as LearningGoal)) {
      selectedFirst.push(speakingGoal);
    } else {
      remaining.push(speakingGoal);
    }
  }

  if (selectedFirst.length === 0) {
    return { goals: scenario.speakingGoals, reordered: false };
  }

  return { goals: [...selectedFirst, ...remaining], reordered: true };
}

/**
 * Match qualitative weaknesses to a safe language-goal emphasis. Returns the
 * matched language-goal ids (in scenario order) so the planner can emphasise
 * them; unmatched weaknesses are never claimed as applied.
 */
export function emphasizedLanguageGoalIds(
  weaknesses: readonly string[] | undefined,
): readonly string[] {
  if (!weaknesses || weaknesses.length === 0) {
    return [];
  }
  const matched: string[] = [];
  for (const weakness of weaknesses) {
    for (const rule of WEAKNESS_LANGUAGE_EMPHASIS) {
      if (rule.match.test(weakness) && !matched.includes(rule.languageGoalId)) {
        matched.push(rule.languageGoalId);
      }
    }
  }
  return matched;
}

/**
 * Reorder + select language goals so those matching a weakness emphasis come
 * first. A real change to the generated plan, not a note.
 */
export function prioritizeLanguageGoals(
  scenario: ScenarioDefinition,
  weaknesses: readonly string[] | undefined,
): { goals: readonly LanguageGoal[]; emphasized: readonly string[] } {
  const emphasized = emphasizedLanguageGoalIds(weaknesses);
  if (emphasized.length === 0) {
    return { goals: scenario.languageGoals, emphasized: [] };
  }

  const first: LanguageGoal[] = [];
  const rest: LanguageGoal[] = [];
  for (const languageGoal of scenario.languageGoals) {
    if (emphasized.includes(languageGoal.id)) {
      first.push(languageGoal);
    } else {
      rest.push(languageGoal);
    }
  }

  if (first.length === 0) {
    return { goals: scenario.languageGoals, emphasized: [] };
  }

  return { goals: [...first, ...rest], emphasized };
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

/** Normalize optional profession/industry context (trimmed, or undefined). */
export function professionalContext(learner?: LearnerProfile): string | undefined {
  const profession = learner?.profession?.trim();
  return profession && profession.length > 0 ? profession : undefined;
}

/**
 * Build the qualitative personalization rationale (never numeric).
 *
 * Honesty rule: each note is emitted only when the corresponding attribute
 * actually produced a material change in the plan. Attributes that are merely
 * carried as context are described as such, never as applied adaptations.
 */
function buildPersonalizationNotes(params: {
  readonly learner: LearnerProfile | undefined;
  readonly difficulty: DifficultyBand;
  readonly difficultyApplied: boolean;
  readonly goalsReordered: boolean;
  readonly relevantGoals: readonly LearningGoal[];
  readonly emphasizedLanguageGoals: readonly string[];
  readonly coachingModeFromLevel: boolean;
  readonly context: string | undefined;
  readonly unmatchedWeaknesses: readonly string[];
}): readonly string[] {
  const notes: string[] = [];
  const { learner } = params;

  if (!learner || Object.keys(learner).length === 0) {
    notes.push('No learner profile supplied; using the scenario defaults.');
    return notes;
  }

  if (params.difficultyApplied) {
    notes.push(`Scenario difficulty set to "${params.difficulty}" per learner preference.`);
  }

  if (params.goalsReordered) {
    notes.push(
      `Speaking goals reordered to prioritise goals relevant to this scenario: ${params.relevantGoals.join(', ')}.`,
    );
  }

  if (params.emphasizedLanguageGoals.length > 0) {
    notes.push(
      `Language goals reordered to emphasise areas matched from stated weaknesses: ${params.emphasizedLanguageGoals.join(', ')}.`,
    );
  }

  if (params.unmatchedWeaknesses.length > 0) {
    notes.push(
      `Noted weaknesses with no deterministic mapping (no plan change applied): ${params.unmatchedWeaknesses.join('; ')}.`,
    );
  }

  if (params.coachingModeFromLevel) {
    notes.push(`Coaching mode derived from the stated ${learner.level} level.`);
  } else if (learner.coachingMode) {
    notes.push(`Coaching mode set to "${learner.coachingMode}" per learner preference.`);
  }

  if (learner.targetExpressions && learner.targetExpressions.length > 0) {
    notes.push('Prioritised the learner’s own target expressions in the plan.');
  }

  if (params.context) {
    notes.push(
      `Professional context "${params.context}" is carried for the future execution layer; it does not change the deterministic scenario, examples, or register at this step.`,
    );
  }

  if (notes.length === 0) {
    notes.push('Learner profile supplied but no field produced a deterministic plan change.');
  }

  return notes;
}

/**
 * Build a deterministic scenario plan.
 *
 * Pure function: no AI, no network, no persistence, no randomness.
 * Unknown categories fall back to the general scenario (`isFallback: true`).
 * The explicitly requested category is always authoritative — it is never
 * silently replaced.
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

  const goals = learner?.goals;
  const relevant = relevantGoals(goals, definition.category);
  const { goals: speakingGoals, reordered } = prioritizeSpeakingGoals(
    definition,
    goals,
    definition.category,
  );
  const { goals: languageGoals, emphasized } = prioritizeLanguageGoals(
    definition,
    learner?.weaknesses,
  );

  const unmatchedWeaknesses = (learner?.weaknesses ?? []).filter(
    (weakness) => emphasizedLanguageGoalIds([weakness]).length === 0,
  );

  const levelDerived =
    !learner?.coachingMode &&
    (learner?.level === 'foundation' ||
      learner?.level === 'developing' ||
      learner?.level === 'advanced');

  return {
    scenarioId: definition.id,
    category: definition.category,
    title: definition.title,
    situation: definition.situation,
    learnerRole: definition.learnerRole,
    counterpartyRole: definition.counterpartyRole,
    objective: definition.objective,
    speakingGoals,
    languageGoals,
    targetExpressions: selectTargetExpressions(definition, learner, max),
    challengeEvents: selectChallenges(definition, band),
    practiceType: definition.practiceType,
    difficulty: band,
    difficultyDescriptor: descriptor,
    coachingMode: resolveCoachingMode(learner),
    coachingNotes: definition.coachingNotes,
    professionalContext: professionalContext(learner),
    personalizationNotes: buildPersonalizationNotes({
      learner,
      difficulty: band,
      difficultyApplied: applied,
      goalsReordered: reordered,
      relevantGoals: relevant,
      emphasizedLanguageGoals: emphasized,
      coachingModeFromLevel: levelDerived,
      context: professionalContext(learner),
      unmatchedWeaknesses,
    }),
    isFallback,
  };
}

/** Exposed for tests and ordering checks. */
export const DIFFICULTY_ORDER_VALUES = DIFFICULTY_ORDER;
