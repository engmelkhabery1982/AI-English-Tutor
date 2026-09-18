/**
 * Skill Map + Curriculum Core — prerequisite graph validation (Phase 1).
 *
 * Pure, deterministic validation of the skill prerequisite graph. Detects
 * self dependencies, duplicate prerequisites, missing prerequisite ids,
 * unknown domains, duplicate/empty ids, and cycles.
 *
 * No persistence, no scores, no clock, no random.
 */

import {
  CURRICULUM_DOMAINS,
  type SkillDomain,
  type SkillFragment,
  type SkillGraphIssue,
  type SkillGraphValidation,
} from './types';

/** Narrow a value to a known domain without throwing. */
function isKnownDomain(value: unknown): value is SkillDomain {
  return typeof value === 'string' && (CURRICULUM_DOMAINS as readonly string[]).includes(value);
}

/** Convert a full skill node into the fragment shape used for validation. */
export function toFragment(node: {
  readonly id: string;
  readonly domain?: SkillDomain;
  readonly prerequisites?: readonly string[];
  readonly relatedSkills?: readonly string[];
}): SkillFragment {
  return {
    id: node.id,
    domain: node.domain,
    prerequisites: node.prerequisites,
    relatedSkills: node.relatedSkills,
  };
}

/**
 * Find a cycle in the prerequisite graph. Returns the ordered ids of the
 * first cycle discovered (deterministic: nodes and edges are visited in
 * catalog order), or `null` when acyclic.
 */
export function findPrerequisiteCycle(
  nodes: readonly SkillFragment[],
): readonly string[] | null {
  const ids = new Set(nodes.map((n) => n.id));
  const adjacency = new Map<string, readonly string[]>();
  for (const node of nodes) {
    adjacency.set(
      node.id,
      (node.prerequisites ?? []).filter((p) => ids.has(p)),
    );
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) {
    color.set(id, WHITE);
  }

  let found: readonly string[] | null = null;

  const visit = (nodeId: string, stack: string[]): boolean => {
    color.set(nodeId, GRAY);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const state = color.get(next);
      if (state === GRAY) {
        const start = stack.indexOf(next);
        found = [...stack.slice(start), next];
        return true;
      }
      if (state === WHITE && visit(next, stack)) {
        return true;
      }
    }
    stack.pop();
    color.set(nodeId, BLACK);
    return false;
  };

  // Iterate in catalog order for deterministic output.
  for (const node of nodes) {
    if (color.get(node.id) === WHITE && visit(node.id, [])) {
      break;
    }
  }

  return found;
}

/**
 * Validate a skill prerequisite graph.
 *
 * Deterministic: issues are emitted in catalog order, and within a node in a
 * fixed field order. `valid` is true only when `issues` is empty.
 */
export function validateSkillGraph(
  nodes: readonly SkillFragment[],
): SkillGraphValidation {
  const issues: SkillGraphIssue[] = [];

  // First pass: collect ids so missing-prerequisite detection is complete.
  const idCounts = new Map<string, number>();
  for (const node of nodes) {
    if (typeof node.id !== 'string' || node.id.trim().length === 0) {
      issues.push({
        kind: 'empty_id',
        skillId: node.id ?? '',
        message: 'Skill id must be a non-empty string.',
      });
      continue;
    }
    idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  }

  const knownIds = new Set(
    nodes.filter((n) => typeof n.id === 'string' && n.id.trim().length > 0).map((n) => n.id),
  );

  // Second pass: per-node checks in catalog order.
  const reportedDuplicate = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== 'string' || node.id.trim().length === 0) {
      continue;
    }

    if ((idCounts.get(node.id) ?? 0) > 1 && !reportedDuplicate.has(node.id)) {
      reportedDuplicate.add(node.id);
      issues.push({
        kind: 'duplicate_id',
        skillId: node.id,
        message: `Skill id "${node.id}" is declared more than once.`,
      });
    }

    if (node.domain !== undefined && !isKnownDomain(node.domain)) {
      issues.push({
        kind: 'unknown_domain',
        skillId: node.id,
        message: `Skill "${node.id}" has an unknown domain "${String(node.domain)}".`,
      });
    }

    const prerequisites = node.prerequisites ?? [];
    const seen = new Set<string>();
    for (const prerequisite of prerequisites) {
      if (prerequisite === node.id) {
        issues.push({
          kind: 'self_prerequisite',
          skillId: node.id,
          message: `Skill "${node.id}" lists itself as a prerequisite.`,
        });
      }
      if (seen.has(prerequisite)) {
        issues.push({
          kind: 'duplicate_prerequisite',
          skillId: node.id,
          message: `Skill "${node.id}" lists prerequisite "${prerequisite}" more than once.`,
        });
      }
      seen.add(prerequisite);
      if (!knownIds.has(prerequisite)) {
        issues.push({
          kind: 'missing_prerequisite',
          skillId: node.id,
          message: `Skill "${node.id}" references missing prerequisite "${prerequisite}".`,
        });
      }
    }
  }

  // Cycle detection (only meaningful once ids are otherwise sound).
  const cycle = findPrerequisiteCycle(nodes);
  if (cycle) {
    issues.push({
      kind: 'cycle',
      skillId: cycle[0],
      message: `Prerequisite cycle detected: ${cycle.join(' -> ')}.`,
      cycle,
    });
  }

  return { valid: issues.length === 0, issues };
}

/** Struggle states that keep a prerequisite unresolved. */
const UNRESOLVED_STATES = new Set([
  'relapsed',
  'confirmed',
  'active_training',
  'repeated',
  'observed',
]);

/**
 * Prerequisite ids that are "unresolved" given a map of lifecycle states.
 *
 * A prerequisite is unresolved when its evidenced state is a struggle state.
 * It is resolved when improving / stable / mastered, and non-blocking when
 * there is no evidence.
 *
 * When `prerequisitesOf` is supplied, unresolved ancestors along the
 * prerequisite chain are included as well (cycle-safe, deterministic).
 * Direct-only behaviour is preserved when it is omitted.
 */
export function unresolvedPrerequisites(
  prerequisites: readonly string[],
  stateOf: (skillId: string) => string | undefined,
  prerequisitesOf?: (skillId: string) => readonly string[] | undefined,
): readonly string[] {
  if (!prerequisitesOf) {
    return prerequisites.filter((id) => {
      const state = stateOf(id);
      return state !== undefined && UNRESOLVED_STATES.has(state);
    });
  }

  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const state = stateOf(id);
    if (state !== undefined && UNRESOLVED_STATES.has(state)) {
      found.push(id);
    }
    for (const next of prerequisitesOf(id) ?? []) {
      visit(next);
    }
  };
  for (const id of prerequisites) {
    visit(id);
  }
  return found;
}
