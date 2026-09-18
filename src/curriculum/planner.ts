/**
 * Skill Map + Curriculum Core — deterministic curriculum planner (Phase 1).
 *
 * PURE and deterministic: same input → identical output. There is no clock
 * (time is only read from an explicit `now`), no randomness, no AI, no
 * network, and no global mutable state.
 *
 * Priority philosophy (private numeric ranks, never exposed as a learner
 * score):
 *   relapsed > confirmed > active_training > repeated > observed
 *   improving  → still eligible
 *   stable     → deprioritized
 *   mastered   → normally excluded
 *
 * Prerequisite policy:
 *   If a direct prerequisite is UNRESOLVED (relapsed / confirmed /
 *   active_training / repeated / observed), a dependent skill is NOT
 *   recommended ahead of it. If every prerequisite is RESOLVED (improving /
 *   stable / mastered) or has no evidence, the dependent is eligible.
 *
 * Honesty rules:
 *   - An unsupported runtime `requestedDomain` is ignored safely and never
 *     exposed as an applied filter.
 *   - A skill with NO evidence is reported with `lifecycleState: null` and a
 *     planner-only `unobserved` status — never fabricated as `observed`.
 *   - `activeWeaknesses` raises priority with an `active_weakness` reason; it
 *     never mutates lifecycle state and never claims `confirmed`.
 *   - `recentlyPractised` is traceable via a `recently_practised` reason.
 *   - A learning goal appears in `appliedLearningGoals` ONLY when it
 *     materially changes the plan (inclusion, ordering, or selection).
 *   - Every evidenced lifecycle state maps to its own honest reason; a real
 *     `stable` skill is never described as `new_skill`.
 */

import {
  CURRICULUM_DOMAINS,
  type CurriculumPlan,
  type CurriculumPlannerInput,
  type CurriculumReason,
  type CurriculumRecommendation,
  type LearningGoalHint,
  type PlannerSkillStatus,
  type SkillDomain,
  type SkillLifecycleState,
} from './types';
import { SKILL_CATALOG, type SkillNode } from './catalog';
import { unresolvedPrerequisites } from './graph';

/** Default cap on how many skills a plan recommends. */
export const DEFAULT_MAX_ITEMS = 5;

/**
 * PRIVATE priority ranks. Higher = recommended earlier.
 * These are implementation details and are NEVER surfaced on a plan or a
 * recommendation as a learner score.
 */
const LIFECYCLE_PRIORITY: Record<SkillLifecycleState, number> = {
  relapsed: 60,
  confirmed: 50,
  active_training: 40,
  repeated: 30,
  observed: 20,
  improving: 15,
  stable: 5,
  mastered: 0,
};

/** Priority used for a skill with no evidence at all. */
const UNOBSERVED_PRIORITY = 10;

/** States that are normally excluded from a plan. */
const EXCLUDED_STATES: ReadonlySet<SkillLifecycleState> = new Set(['mastered']);

/** Deterministic mapping from a goal hint to the domains it prioritizes. */
export const GOAL_DOMAIN_WEIGHTS: Record<LearningGoalHint, readonly SkillDomain[]> = {
  everyday_fluency: ['speaking', 'expressions', 'listening'],
  workplace_communication: ['expressions', 'speaking', 'vocabulary'],
  listening_comprehension: ['listening'],
  pronunciation_clarity: ['pronunciation'],
  vocabulary_growth: ['vocabulary', 'expressions'],
  grammar_accuracy: ['grammar'],
  speaking_confidence: ['speaking', 'pronunciation'],
};

/** Narrow a runtime value to a supported domain. */
export function isSupportedDomain(value: unknown): value is SkillDomain {
  return typeof value === 'string' && (CURRICULUM_DOMAINS as readonly string[]).includes(value);
}

/** Human-readable reason per lifecycle state. */
function stateReason(state: SkillLifecycleState): CurriculumReason {
  switch (state) {
    case 'relapsed':
      return { code: 'relapsed', message: 'Relapsed skill needs retraining.' };
    case 'confirmed':
      return { code: 'confirmed', message: 'Confirmed weakness from learner evidence.' };
    case 'active_training':
      return { code: 'active_training', message: 'Skill is under active training.' };
    case 'repeated':
      return { code: 'repeated', message: 'Repeatedly observed difficulty worth reinforcing.' };
    case 'observed':
      return { code: 'observed', message: 'Observed difficulty worth an early check.' };
    case 'improving':
      return {
        code: 'improving_in_rotation',
        message: 'Improving skill should remain in rotation.',
      };
    case 'stable':
      return {
        code: 'stable_maintenance',
        message: 'Stable skill is deprioritized but may remain available for occasional maintenance.',
      };
    default:
      return { code: 'new_skill', message: 'No learner evidence yet; a reasonable default.' };
  }
}

/** Build a lookup of skillId → lifecycle state from evidence snapshots. */
function buildStateMap(
  evidence: CurriculumPlannerInput['evidence'],
): Map<string, SkillLifecycleState> {
  const map = new Map<string, SkillLifecycleState>();
  for (const snapshot of evidence ?? []) {
    if (typeof snapshot.skillId !== 'string' || snapshot.skillId.length === 0) {
      continue;
    }
    // Duplicate snapshots resolve deterministically: the FIRST occurrence wins.
    if (!map.has(snapshot.skillId)) {
      map.set(snapshot.skillId, snapshot.lifecycleState);
    }
  }
  return map;
}

/** A resolved plan candidate (internal). */
interface Candidate {
  readonly index: number;
  readonly skillId: string;
  readonly domain: SkillDomain;
  readonly title: string;
  /** The evidenced lifecycle state, or null when there is no evidence. */
  readonly lifecycleState: SkillLifecycleState | null;
  readonly status: PlannerSkillStatus;
  readonly priority: number;
  readonly domainRank: number;
  readonly reasons: readonly CurriculumReason[];
  readonly blockedBy: readonly string[];
}

/** Options controlling a single pass of candidate assembly. */
interface BuildOptions {
  readonly stateMap: Map<string, SkillLifecycleState>;
  readonly activeWeaknesses: ReadonlySet<string>;
  readonly recentlyPractised: ReadonlySet<string>;
  readonly effectiveDomain: SkillDomain | undefined;
  readonly goalBoostDomains: ReadonlySet<SkillDomain>;
}

/**
 * Assemble and order candidates. Pure and deterministic. The goal-boost set
 * is a parameter so the planner can compare "with goal" against "without
 * goal" to decide whether a goal was materially applied.
 */
function buildCandidates(options: BuildOptions): Candidate[] {
  const { stateMap, activeWeaknesses, recentlyPractised, effectiveDomain, goalBoostDomains } =
    options;
  const candidates: Candidate[] = [];

  SKILL_CATALOG.forEach((node: SkillNode, index: number) => {
    if (effectiveDomain && node.domain !== effectiveDomain) {
      return; // domain filtering
    }

    const state = stateMap.get(node.id);
    const hasEvidence = state !== undefined;

    // mastered is normally excluded (only when we actually have that evidence).
    if (hasEvidence && EXCLUDED_STATES.has(state as SkillLifecycleState)) {
      return;
    }

    const blockedBy = unresolvedPrerequisites(node.prerequisites, (id) => stateMap.get(id));
    const blocked = blockedBy.length > 0;

    let priority = hasEvidence
      ? LIFECYCLE_PRIORITY[state as SkillLifecycleState]
      : UNOBSERVED_PRIORITY;

    const reasons: CurriculumReason[] = [];

    if (hasEvidence) {
      reasons.push(stateReason(state as SkillLifecycleState));
    } else {
      reasons.push({ code: 'new_skill', message: 'No learner evidence yet; a reasonable default.' });
    }

    if (activeWeaknesses.has(node.id)) {
      priority += 15;
      reasons.push({
        code: 'active_weakness',
        message: 'Flagged as an active weakness.',
      });
    }

    if (goalBoostDomains.has(node.domain)) {
      priority += 10;
      reasons.push({
        code: 'learning_goal_domain',
        message: 'A learning goal prioritises this domain.',
      });
    }

    if (blocked) {
      // Demote below any blocker while still allowing inclusion if space allows.
      priority -= 100;
      reasons.push({
        code: 'prerequisite_for_blocked',
        message: `Blocked by unresolved prerequisite(s): ${blockedBy.join(', ')}.`,
      });
    }

    if (recentlyPractised.has(node.id)) {
      priority -= 8;
      reasons.push({
        code: 'recently_practised',
        message: 'Recently practised; slightly deprioritized to avoid immediate repetition.',
      });
    }

    if (effectiveDomain && node.domain === effectiveDomain) {
      reasons.push({ code: 'domain_focus', message: 'Matches the requested domain.' });
    }

    candidates.push({
      index,
      skillId: node.id,
      domain: node.domain,
      title: node.title,
      lifecycleState: hasEvidence ? (state as SkillLifecycleState) : null,
      status: hasEvidence ? 'evidenced' : 'unobserved',
      priority,
      domainRank: CURRICULUM_DOMAINS.indexOf(node.domain),
      reasons,
      blockedBy,
    });
  });

  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.domainRank !== b.domainRank) return a.domainRank - b.domainRank;
    return a.index - b.index;
  });

  return candidates;
}

/** Compare two ordered candidate lists by skill id only. */
function sameOrder(a: readonly Candidate[], b: readonly Candidate[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].skillId !== b[i].skillId) return false;
  }
  return true;
}

/**
 * Plan a curriculum deterministically.
 */
export function planCurriculum(input: CurriculumPlannerInput = {}): CurriculumPlan {
  const stateMap = buildStateMap(input.evidence);
  const activeWeaknesses = new Set(input.activeWeaknesses ?? []);
  const recentlyPractised = new Set(input.recentlyPractised ?? []);
  const rawRequestedDomain = input.requestedDomain;
  const maxItems =
    typeof input.maxItems === 'number' && Number.isInteger(input.maxItems) && input.maxItems >= 0
      ? input.maxItems
      : DEFAULT_MAX_ITEMS;

  // BLOCKER 1: normalise the requested domain. Only a SUPPORTED domain becomes
  // an effective filter. An unsupported runtime value is ignored safely.
  const domainSupported = isSupportedDomain(rawRequestedDomain);
  const effectiveDomain: SkillDomain | undefined = domainSupported ? rawRequestedDomain : undefined;

  const goals = input.learningGoals ?? [];

  const notes: string[] = [];
  if (rawRequestedDomain !== undefined && !domainSupported) {
    notes.push(`Requested domain "${String(rawRequestedDomain)}" is not supported; ignoring it.`);
  }

  // BLOCKER 4: a goal is "applied" only if it materially changes the plan.
  // We determine this deterministically by comparing the candidate ordering
  // (and final selection) with and without each goal's domain boost.
  const appliedLearningGoals: LearningGoalHint[] = [];
  const goalBoostDomains = new Set<SkillDomain>();

  for (const goal of goals) {
    const domains = GOAL_DOMAIN_WEIGHTS[goal];
    if (!domains) {
      continue; // unknown goal hint: never claim it
    }
    const trialBoost = new Set<SkillDomain>(goalBoostDomains);
    for (const domain of domains) {
      trialBoost.add(domain);
    }

    const currentCandidates = buildCandidates({
      stateMap,
      activeWeaknesses,
      recentlyPractised,
      effectiveDomain,
      goalBoostDomains,
    });
    const trialCandidates = buildCandidates({
      stateMap,
      activeWeaknesses,
      recentlyPractised,
      effectiveDomain,
      goalBoostDomains: trialBoost,
    });

    // Material if ordering changed OR the final top-N selection changed.
    const orderChanged = !sameOrder(trialCandidates, currentCandidates);
    const selectionChanged = !sameOrder(
      trialCandidates.slice(0, maxItems),
      currentCandidates.slice(0, maxItems),
    );

    if (orderChanged || selectionChanged) {
      appliedLearningGoals.push(goal);
      for (const domain of domains) {
        goalBoostDomains.add(domain);
      }
    }
  }

  if (appliedLearningGoals.length > 0) {
    notes.push(`Learning goals prioritise: ${[...goalBoostDomains].join(', ')}.`);
  } else if (goals.length > 0) {
    notes.push('Supplied learning goals did not change the plan.');
  }

  const finalCandidates = buildCandidates({
    stateMap,
    activeWeaknesses,
    recentlyPractised,
    effectiveDomain,
    goalBoostDomains,
  });

  const recommendations: CurriculumRecommendation[] = finalCandidates
    .slice(0, maxItems)
    .map((candidate) => ({
      skillId: candidate.skillId,
      domain: candidate.domain,
      title: candidate.title,
      lifecycleState: candidate.lifecycleState,
      status: candidate.status,
      reasons: candidate.reasons,
      blockedByPrerequisites: candidate.blockedBy,
    }));

  if (recommendations.length === 0) {
    notes.push('No skills matched the given filters.');
  }

  return {
    recommendations,
    requestedDomain: effectiveDomain,
    appliedLearningGoals,
    notes,
  };
}
