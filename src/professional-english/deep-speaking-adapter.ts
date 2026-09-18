/**
 * Professional English → Deep Speaking adapter.
 *
 * Translates a deterministic ScenarioPlan into the smallest existing Deep
 * Speaking planner input. Pure, no I/O, no AI, no persistence, no second
 * planner, no prompt duplication.
 *
 * Deep Speaking remains the owner of turns, follow-ups, feedback, memory,
 * finalization and voice. This module only maps CONTENT.
 */

import type { CoachingContext } from '../learner-model';
import type {
  SpeakingPlannerOptions,
  SpeakingPracticeType,
  SpeakingProfessionalScenario,
} from '../deep-speaking/types';
import { planScenario } from './planner';
import type {
  LearningGoal,
  PracticeType,
  ScenarioCategory,
  ScenarioPlan,
} from './types';

/**
 * Lightweight learner context used by the Professional English planner.
 * Profession is present ONLY when a real value is supplied — never invented.
 */
export interface ProfessionalLearnerContext {
  readonly learningGoals: readonly string[];
  readonly weaknesses: readonly string[];
  readonly profession?: string;
}

const EXISTING_SPEAKING_PRACTICE_TYPES: ReadonlySet<SpeakingPracticeType> = new Set([
  'free_conversation',
  'guided_topic',
  'role_play',
  'explain_and_expand',
  'opinion_and_reasoning',
  'problem_solution',
  'retell_or_summarize',
  'reformulation',
  'target_expression_practice',
  'weakness_retraining',
]);

const MAX_DEEP_SPEAKING_EXPRESSIONS = 3;

/**
 * Explicit mapping of Professional English practice types onto EXISTING
 * Deep Speaking practice types. Never invents a new DS type.
 *
 * - role_play → role_play
 * - guided_dialogue → guided_topic (roles exist, but the catalog type is guided)
 * - structured_exchange → role_play (both named roles drive a role-play)
 * - simulated_call → role_play
 * - prepared_monologue → explain_and_expand
 * - question_and_answer → guided_topic
 * - open_discussion → problem_solution / explain_and_expand /
 *   opinion_and_reasoning / guided_topic depending on category
 */
export function mapPracticeType(
  practiceType: PracticeType,
  category: ScenarioCategory,
): SpeakingPracticeType {
  switch (practiceType) {
    case 'role_play':
      return 'role_play';
    case 'guided_dialogue':
      return 'guided_topic';
    case 'structured_exchange':
      return 'role_play';
    case 'simulated_call':
      return 'role_play';
    case 'prepared_monologue':
      return 'explain_and_expand';
    case 'question_and_answer':
      return 'guided_topic';
    case 'open_discussion':
      if (category === 'problem_solving') return 'problem_solution';
      if (category === 'technical_explanation') return 'explain_and_expand';
      if (category === 'leadership_conversation') return 'opinion_and_reasoning';
      return 'guided_topic';
    default: {
      const exhaustive: never = practiceType;
      return exhaustive;
    }
  }
}

/** True when the mapped type is one of the existing Deep Speaking types. */
export function isExistingSpeakingPracticeType(
  value: string,
): value is SpeakingPracticeType {
  return EXISTING_SPEAKING_PRACTICE_TYPES.has(value as SpeakingPracticeType);
}

/**
 * Convert a ScenarioPlan into the bounded professional scenario payload that
 * Deep Speaking already knows how to conduct.
 */
export function toSpeakingProfessionalScenario(
  plan: ScenarioPlan,
): SpeakingProfessionalScenario {
  return {
    scenarioId: plan.scenarioId,
    title: plan.title,
    situation: plan.situation,
    learnerRole: plan.learnerRole,
    counterpartyRole: plan.counterpartyRole,
    objective: plan.objective,
    difficulty: plan.difficulty,
    coachingPosture: plan.coachingMode,
    coachingNotes: plan.coachingNotes,
    speakingGoals: plan.speakingGoals.map((goal) => ({
      id: goal.id,
      description: goal.description,
    })),
    languageGoals: plan.languageGoals.map((goal) => ({
      id: goal.id,
      description: goal.description,
    })),
    targetExpressions: plan.targetExpressions.slice(0, MAX_DEEP_SPEAKING_EXPRESSIONS),
    challengeEvents: plan.challengeEvents.map((event) => ({
      id: event.id,
      description: event.description,
    })),
    ...(plan.professionalContext ? { professionalContext: plan.professionalContext } : {}),
  };
}

/**
 * Smallest Deep Speaking planner input that starts the EXISTING pipeline on
 * this professional scenario. No seed, no second prompt, no new practice type.
 */
export function toSpeakingPlannerOptions(plan: ScenarioPlan): SpeakingPlannerOptions {
  return {
    practiceType: mapPracticeType(plan.practiceType, plan.category),
    professionalScenario: toSpeakingProfessionalScenario(plan),
  };
}

/**
 * Plan a professional scenario for Deep Speaking. Caps target expressions at
 * the Deep Speaking bound (3) so the adapter never over-fills the session.
 */
export function planProfessionalScenario(
  category: ScenarioCategory,
  context?: ProfessionalLearnerContext | null,
): ScenarioPlan {
  return planScenario({
    category,
    maxTargetExpressions: MAX_DEEP_SPEAKING_EXPRESSIONS,
    ...(context
      ? {
          learner: {
            goals: mapLearningGoals(context.learningGoals),
            weaknesses: context.weaknesses,
            ...(context.profession ? { profession: context.profession } : {}),
          },
        }
      : {}),
  });
}

/**
 * Map free-text learner goals onto Professional English LearningGoal values.
 * First match wins, specific before general. Unmatched goals are dropped
 * honestly (they do not invent a professional goal).
 */
export function mapLearningGoals(goals: readonly string[]): readonly LearningGoal[] {
  const mapped: LearningGoal[] = [];
  const seen = new Set<LearningGoal>();
  for (const raw of goals) {
    const goal = matchLearningGoal(raw);
    if (!goal || seen.has(goal)) continue;
    seen.add(goal);
    mapped.push(goal);
  }
  return mapped;
}

function matchLearningGoal(raw: string): LearningGoal | null {
  const lower = raw.toLowerCase();
  if (lower.includes('present')) return 'presentations';
  if (lower.includes('interview')) return 'interviews';
  if (lower.includes('negotiat')) return 'negotiation';
  if (lower.includes('client') || lower.includes('customer')) return 'client_communication';
  if (lower.includes('lead') || lower.includes('manag') || lower.includes('team')) {
    return 'leadership';
  }
  if (lower.includes('report') || lower.includes('writ')) return 'reporting_and_writing';
  if (lower.includes('meet') || lower.includes('update') || lower.includes('status')) {
    return 'meetings_and_updates';
  }
  if (lower.includes('technic')) return 'technical_discussion';
  if (
    lower.includes('work') ||
    lower.includes('business') ||
    lower.includes('professional') ||
    lower.includes('office')
  ) {
    return 'workplace_communication';
  }
  if (lower.includes('daily') || lower.includes('everyday') || lower.includes('fluency')) {
    return 'everyday_fluency';
  }
  return null;
}

/**
 * Honest translation of CoachingContext into Professional English planner
 * input. Profession is NEVER taken from the model (the model has no such
 * field). Weaknesses that are mastered or stable are excluded. Unmatched
 * weakness types stay as qualitative phrases that match no emphasis regex.
 */
export function toProfessionalLearnerContext(
  coaching: CoachingContext,
): ProfessionalLearnerContext {
  const weaknesses: string[] = [];
  for (const weakness of coaching.activeWeaknesses) {
    if (weakness.status === 'mastered' || weakness.status === 'stable') continue;
    weaknesses.push(weaknessPhrase(weakness.type));
  }
  return {
    learningGoals: coaching.profile.learningGoals,
    weaknesses,
  };
}

function weaknessPhrase(type: string): string {
  switch (type) {
    case 'grammar':
      return 'grammar accuracy';
    case 'pronunciation':
      return 'pronunciation';
    case 'vocabulary':
      return 'vocabulary range';
    case 'listening':
      return 'listening and understanding';
    case 'fluency':
      return 'fluency and hesitation';
    case 'natural_expression':
      return 'natural expression';
    case 'confidence':
      return 'confidence in speaking';
    default:
      return type.replace(/_/g, ' ');
  }
}
