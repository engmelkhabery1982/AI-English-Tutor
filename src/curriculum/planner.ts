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
 */

import {
  CURRICULUM_DOMAINS,
  type CurriculumPlan,
  type CurriculumPlannerInput,
  type CurriculumReason,
  type CurriculumRecommendation,
  type LearningGoalHint,
  type SkillDomain,
  type SkillLifecycleState,
} from './types';
import { SKILL_CATALOG } from './catalog';
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

/** Human-readable reason per state. */
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

/**
 * Plan a curriculum deterministically.
 *
 * Ordering is by (private) priority rank, then domain order, then catalog
 * order — so ties are always stable.
 */
export function planCurriculum(input: CurriculumPlannerInput = {}): CurriculumPlan {
  const evidenceState = buildStateMap(input.evidence);
  const activeWeaknesses = new Set(input.activeWeaknesses ?? []);
  const recentlyPractised = new Set(input.recentlyPractised ?? []);
  const requestedDomain = input.requestedDomain;
  const maxItems =
    typeof input.maxItems === 'number' && Number.isInteger(input.maxItems) && input.maxItems >= 0
      ? input.maxItems
      : DEFAULT_MAX_ITEMS;

  // Which goal hints actually map to a candidate domain. A goal is only
  // "applied" when it materially affects the plan.
  const goals = input.learningGoals ?? [];
  const appliedLearningGoals: LearningGoalHint[] = [];
  const goalBoostDomains = new Set<SkillDomain>();
  for (const goal of goals) {
    const domains = GOAL_DOMAIN_WEIGHTS[goal];
    if (!domains) {
      continue;
    }
    const relevant = requestedDomain ? domains.filter((d) => d === requestedDomain) : domains;
    if (relevant.length > 0) {
      appliedLearningGoals.push(goal);
      for (const domain of relevant) {
        goalBoostDomains.add(domain);
      }
    }
  }

  const notes: string[] = [];
  if (requestedDomain && !(CURRICULUM_DOMAINS as readonly string[]).includes(requestedDomain)) {
    notes.push(`Requested domain "${String(requestedDomain)}" is not supported; ignoring it.`);
  }
  if (appliedLearningGoals.length > 0) {
    notes.push(`Learning goals prioritise: ${[...goalBoostDomains].join(', ')}.`);
  } else if (goals.length > 0) {
    notes.push('Supplied learning goals did not map to the candidate domains.');
  }

  // ---- Candidate assembly (catalog order → fully deterministic) -----------
  interface Candidate {
    readonly index: number;
    readonly skillId: string;
    readonly domain: SkillDomain;
    readonly title: string;
    readonly state: SkillLifecycleState;
    readonly priority: number;
    readonly domainRank: number;
    readonly reasons: CurriculumReason[];
    readonly blockedBy: readonly string[];
  }

  const candidates: Candidate[] = [];

  SKILL_CATALOG.forEach((node, index) => {
    if (requestedDomain && node.domain !== requestedDomain) {
      return; // domain filtering
    }

    const state = evidenceState.get(node.id);
    const effectiveState: SkillLifecycleState = state ?? 'observed';
    const hasEvidence = state !== undefined;

    // mastered is normally excluded (only when we actually have that evidence).
    if (hasEvidence && EXCLUDED_STATES.has(effectiveState)) {
      return;
    }

    const blockedBy = unresolvedPrerequisites(node.prerequisites, (id) => evidenceState.get(id));
    const blocked = blockedBy.length > 0;

    let priority = LIFECYCLE_PRIORITY[effectiveState];

    const reasons: CurriculumReason[] = [];

    if (hasEvidence) {
      reasons.push(stateReason(effectiveState));
    } else {
      reasons.push({ code: 'new_skill', message: 'No learner evidence yet; a reasonable default.' });
    }

    if (activeWeaknesses.has(node.id)) {
      priority += 15;
      reasons.push({ code: 'confirmed', message: 'Flagged as an active weakness.' });
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
    }

    if (requestedDomain && node.domain === requestedDomain) {
      reasons.push({ code: 'domain_focus', message: 'Matches the requested domain.' });
    }

    candidates.push({
      index,
      skillId: node.id,
      domain: node.domain,
      title: node.title,
      state: effectiveState,
      priority,
      domainRank: CURRICULUM_DOMAINS.indexOf(node.domain),
      reasons,
      blockedBy,
    });
  });

  // ---- Deterministic ordering --------------------------------------------
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.domainRank !== b.domainRank) return a.domainRank - b.domainRank;
    return a.index - b.index;
  });

  const recommendations: CurriculumRecommendation[] = candidates
    .slice(0, maxItems)
    .map((candidate) => ({
      skillId: candidate.skillId,
      domain: candidate.domain,
      title: candidate.title,
      lifecycleState: candidate.state,
      reasons: candidate.reasons,
      blockedByPrerequisites: candidate.blockedBy,
    }));

  if (recommendations.length === 0) {
    notes.push('No skills matched the given filters.');
  }

  return {
    recommendations,
    requestedDomain,
    appliedLearningGoals,
    notes,
  };
}
