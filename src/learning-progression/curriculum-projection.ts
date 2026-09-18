/**
 * src/learning-progression/curriculum-projection.ts
 *
 * WP-1: ONE shared deterministic CURRICULUM EVIDENCE PROJECTION.
 *
 * WHY IT LIVES HERE (outside src/curriculum)
 * The curriculum core is deliberately acyclic and must never import domain
 * learner types. This module sits OUTSIDE it and depends on the domain
 * evidence types + the curriculum types, so the dependency direction is
 * one-way: domain evidence → projection → curriculum snapshots.
 *
 * WHAT IT DOES
 * Turns ALREADY-LOADED learner evidence rows into the EXISTING
 * `SkillEvidenceSnapshot[]` the curriculum planner consumes.
 *
 * HONESTY RULES
 * - Pure and deterministic: it performs NO repository reads, NO AI call, NO
 *   network, NO clock read and NO randomness. It only reads the snapshot it
 *   is given.
 * - Only REAL supported mappings emit evidence. Every possible source
 *   mapping is explicitly classified SUPPORTED / DEAD / UNMAPPABLE below.
 * - A `skillId` is never guessed: DEAD and UNMAPPABLE mappings emit nothing.
 * - Projection NEVER mutates lifecycle, weaknesses, reviews or vocabulary.
 * - At most ONE snapshot per skillId; the most urgent existing lifecycle
 *   state wins and the aggregate metadata is deterministic.
 * - There is deliberately NO LearnerStrength projection: the system has no
 *   success-evidence writer yet, so a strength projection could not be
 *   trustworthy. Later work introduces observed success evidence first.
 */

import { getSkill } from '../curriculum/catalog';
import type {
  SkillEvidenceSnapshot,
  SkillLifecycleState,
} from '../curriculum/types';
import type {
  LearnerWeakness,
  PronunciationWeakness,
} from '../domain/models/learner';
import type {
  ExpressionItem,
  VocabularyItem,
} from '../domain/models/vocabulary';
import type { MasteryState } from '../domain/shared/types';
import { parseWeaknessIdentity } from '../listening/generator';
import type { SkillDomain } from '../curriculum/types';

/* ------------------------------------------------------------------ *
 * Mapping classification
 * ------------------------------------------------------------------ */

/**
 * How a source mapping is classified at THIS baseline.
 *
 * SUPPORTED  a current writer really emits enough semantic evidence for the
 *            mapped skillId.
 * DEAD       the type/identity exists in code, but no current writer or
 *            provider can produce it.
 * UNMAPPABLE data exists, but it does not carry enough semantic precision to
 *            identify a skillId.
 */
export type EvidenceMappingStatus = 'SUPPORTED' | 'DEAD' | 'UNMAPPABLE';

/** The evidence family a mapping belongs to. */
export type EvidenceMappingSource =
  | 'listening_weakness'
  | 'pronunciation_weakness'
  | 'vocabulary_review'
  | 'expression_review'
  | 'grammar_weakness'
  | 'learner_strength';

/** ONE explicitly classified source mapping. */
export interface CurriculumEvidenceMapping {
  /** Stable id of this mapping (its source + identity kind). */
  readonly id: string;
  readonly source: EvidenceMappingSource;
  /** The stored identity kind / observation type, when the source has one. */
  readonly identityKind?: string;
  readonly status: EvidenceMappingStatus;
  /** The curriculum skill emitted. Present only for SUPPORTED mappings. */
  readonly skillId?: string;
  /** Domain of the emitted skillId, when SUPPORTED. */
  readonly domain?: SkillDomain;
  readonly reason: string;
}

/**
 * LISTENING identity mappings.
 *
 * The listening engine currently writes exactly two identities:
 * `word_recognition:<target>` and `expression_recognition:<target>`.
 *
 * Those identities record WHICH lexical item was missed by ear. They do NOT
 * record gist / detail / inference discrimination, so reinterpreting them as
 * `gist_listening`, `detail_listening` or `inference_listening` would invent
 * a skill. No other listening skill is reachable from this evidence, so the
 * honest classification is UNMAPPABLE (emit nothing).
 */
const LISTENING_IDENTITY_MAPPINGS: readonly CurriculumEvidenceMapping[] = [
  {
    id: 'listening_weakness:word_recognition',
    source: 'listening_weakness',
    identityKind: 'word_recognition',
    status: 'UNMAPPABLE',
    reason:
      'Identifies a lexical item that was missed by ear — it stores no gist/detail/inference discrimination, so no listening skill can be inferred without guessing.',
  },
  {
    id: 'listening_weakness:expression_recognition',
    source: 'listening_weakness',
    identityKind: 'expression_recognition',
    status: 'UNMAPPABLE',
    reason:
      'Identifies an expression that was missed by ear — recognition of one stored expression is not evidence about a curriculum listening skill.',
  },
  {
    id: 'listening_weakness:connected_speech',
    source: 'listening_weakness',
    identityKind: 'connected_speech',
    status: 'DEAD',
    reason:
      'No current listening writer emits a connected-speech identity; evidence is never created merely because the catalog knows the name.',
  },
  {
    id: 'listening_weakness:meaning_comprehension',
    source: 'listening_weakness',
    identityKind: 'meaning_comprehension',
    status: 'DEAD',
    reason: 'No current listening writer emits this identity.',
  },
  {
    id: 'listening_weakness:detail_comprehension',
    source: 'listening_weakness',
    identityKind: 'detail_comprehension',
    status: 'DEAD',
    reason: 'No current listening writer emits this identity.',
  },
];

/**
 * PRONUNCIATION observation mappings.
 *
 * The ONE current provider (transcript comparison) really produces
 * `word_pronunciation`, `ending` and `rhythm` observations. Only the first
 * two carry honest, if coarse, evidence about producing a word clearly.
 */
const PRONUNCIATION_IDENTITY_MAPPINGS: readonly CurriculumEvidenceMapping[] = [
  {
    id: 'pronunciation_weakness:word_pronunciation',
    source: 'pronunciation_weakness',
    identityKind: 'word_pronunciation',
    status: 'SUPPORTED',
    skillId: 'sound_clarity',
    domain: 'pronunciation',
    reason:
      'A word the transcript could not recognise (or substituted) is real, if coarse, evidence about producing that word clearly — the existing catalog skill for that is sound_clarity.',
  },
  {
    id: 'pronunciation_weakness:ending',
    source: 'pronunciation_weakness',
    identityKind: 'ending',
    status: 'SUPPORTED',
    skillId: 'sound_clarity',
    domain: 'pronunciation',
    reason:
      'A dropped/changed word ending is evidence about producing the final sounds of that word clearly; sound_clarity is the only existing catalog mapping that is semantically valid.',
  },
  {
    id: 'pronunciation_weakness:rhythm',
    source: 'pronunciation_weakness',
    identityKind: 'rhythm',
    status: 'UNMAPPABLE',
    reason:
      'The only current writer emits this from an extra-word-length heuristic, which is NOT rhythm evidence.',
  },
  {
    id: 'pronunciation_weakness:intelligibility',
    source: 'pronunciation_weakness',
    identityKind: 'intelligibility',
    status: 'DEAD',
    reason:
      'Intelligibility is computed per analysis but never persisted as an observation identity.',
  },
  {
    id: 'pronunciation_weakness:word_stress',
    source: 'pronunciation_weakness',
    identityKind: 'word_stress',
    status: 'DEAD',
    reason: 'No current pronunciation provider emits this observation type.',
  },
  {
    id: 'pronunciation_weakness:sentence_stress',
    source: 'pronunciation_weakness',
    identityKind: 'sentence_stress',
    status: 'DEAD',
    reason: 'No current pronunciation provider emits this observation type.',
  },
  {
    id: 'pronunciation_weakness:vowel',
    source: 'pronunciation_weakness',
    identityKind: 'vowel',
    status: 'DEAD',
    reason: 'No current pronunciation provider emits this observation type.',
  },
  {
    id: 'pronunciation_weakness:consonant',
    source: 'pronunciation_weakness',
    identityKind: 'consonant',
    status: 'DEAD',
    reason: 'No current pronunciation provider emits this observation type.',
  },
  {
    id: 'pronunciation_weakness:linking',
    source: 'pronunciation_weakness',
    identityKind: 'linking',
    status: 'DEAD',
    reason: 'No current pronunciation provider emits this observation type.',
  },
  {
    id: 'pronunciation_weakness:intonation',
    source: 'pronunciation_weakness',
    identityKind: 'intonation',
    status: 'DEAD',
    reason: 'No current pronunciation provider emits this observation type.',
  },
];

/** Lexical mappings — the broad EXISTING lexical nodes only. */
const LEXICAL_MAPPINGS: readonly CurriculumEvidenceMapping[] = [
  {
    id: 'vocabulary_review:core_vocabulary',
    source: 'vocabulary_review',
    status: 'SUPPORTED',
    skillId: 'core_vocabulary',
    domain: 'vocabulary',
    reason:
      'A saved word carries a REAL stored per-meaning review state; that is stored review evidence about core vocabulary, and no finer curriculum node is supported by it.',
  },
  {
    id: 'expression_review:common_expressions',
    source: 'expression_review',
    status: 'SUPPORTED',
    skillId: 'common_expressions',
    domain: 'expressions',
    reason:
      'A saved expression carries a REAL stored per-meaning review state; that is stored review evidence about common expressions, and no finer curriculum node is supported by it.',
  },
];

/** Grammar mapping — deliberately not projected at skill granularity. */
const GRAMMAR_MAPPING: CurriculumEvidenceMapping = {
  id: 'grammar_weakness:any',
  source: 'grammar_weakness',
  status: 'UNMAPPABLE',
  reason:
    'The current grammar weakness identity does not reliably identify a specific grammar-skill node (articles / tense / preposition …), so no skill-level snapshot is emitted rather than guessing one.',
};

/** Strength mapping — deliberately DEAD until observed success evidence exists. */
const STRENGTH_MAPPING: CurriculumEvidenceMapping = {
  id: 'learner_strength:any',
  source: 'learner_strength',
  status: 'DEAD',
  reason:
    'The system has no observed-success evidence writer yet, so projecting strengths from the current rows could not be trustworthy.',
};

/**
 * EVERY possible source mapping, explicitly classified. Tests assert that
 * DEAD / UNMAPPABLE mappings never emit and that the reachable skillIds equal
 * exactly the SUPPORTED set.
 */
export const CURRICULUM_EVIDENCE_MAPPINGS: readonly CurriculumEvidenceMapping[] = [
  ...LISTENING_IDENTITY_MAPPINGS,
  ...PRONUNCIATION_IDENTITY_MAPPINGS,
  ...LEXICAL_MAPPINGS,
  GRAMMAR_MAPPING,
  STRENGTH_MAPPING,
];

/** Look up the classification for one pronunciation observation kind. */
export function pronunciationMappingFor(
  kind: string,
): CurriculumEvidenceMapping | null {
  return (
    PRONUNCIATION_IDENTITY_MAPPINGS.find((entry) => entry.identityKind === kind) ?? null
  );
}

/** The skillIds this projection can EVER emit (from the SUPPORTED mappings). */
export const PROJECTED_SKILL_IDS: readonly string[] = Array.from(
  new Set(
    CURRICULUM_EVIDENCE_MAPPINGS.filter((mapping) => mapping.status === 'SUPPORTED')
      .map((mapping) => mapping.skillId)
      .filter((skillId): skillId is string => Boolean(skillId)),
  ),
).sort();

/** The listener-reachable skillIds that are deliberately never emitted. */
export const NEVER_PROJECTED_SKILL_IDS: readonly string[] = CURRICULUM_EVIDENCE_MAPPINGS.filter(
  (mapping) => mapping.status !== 'SUPPORTED',
).map((mapping) => mapping.id);

/* ------------------------------------------------------------------ *
 * Lifecycle resolution
 * ------------------------------------------------------------------ */

/**
 * Existing urgency priority — the SAME ordering the rest of the system uses.
 * Lower index = more urgent.
 */
export const LIFECYCLE_URGENCY: Readonly<Record<SkillLifecycleState, number>> = {
  relapsed: 0,
  confirmed: 1,
  active_training: 2,
  repeated: 3,
  observed: 4,
  improving: 5,
  stable: 6,
  mastered: 7,
};

/** The urgency priority of a lifecycle state (unknown states rank lowest). */
export function lifecycleUrgency(state: SkillLifecycleState): number {
  return LIFECYCLE_URGENCY[state] ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Most urgent existing state wins. Used both for merging several rows onto
 * one skillId and for merging the states inside one lexical item.
 */
function mostUrgent(
  a: SkillLifecycleState,
  b: SkillLifecycleState,
): SkillLifecycleState {
  return lifecycleUrgency(a) <= lifecycleUrgency(b) ? a : b;
}

/**
 * Real stored per-meaning review state → curriculum lifecycle state.
 *
 * `null` means the stored state carries NO usable evidence and is skipped
 * (a brand-new meaning that was never actually reviewed, or a retired one).
 * Nothing is upgraded: a struggling meaning never becomes 'improving'.
 */
export function lifecycleFromMasteryState(
  state: MasteryState,
  reviewCount: number,
): SkillLifecycleState | null {
  switch (state) {
    case 'struggling':
      return 'confirmed';
    case 'familiar':
      return 'repeated';
    case 'learning':
      return 'observed';
    case 'new':
      return reviewCount > 0 ? 'observed' : null;
    case 'mastered':
      return 'mastered';
    case 'retired':
      return null;
    default:
      return null;
  }
}

/** A contributing piece of evidence before it is merged per skillId. */
interface SkillEvidenceCandidate {
  readonly skillId: string;
  readonly lifecycleState: SkillLifecycleState;
  readonly lastObservedAt?: string;
  readonly evidenceCount: number;
}

/** The ALREADY-LOADED learner snapshot the projection may look at. */
export interface CurriculumEvidenceInput {
  readonly weaknesses: readonly LearnerWeakness[];
  readonly pronunciationWeaknesses: readonly PronunciationWeakness[];
  /**
   * Already-loaded lexical items. Owners that do not load them simply omit
   * them — omitted evidence is never fabricated.
   */
  readonly vocabulary?: readonly VocabularyItem[];
  readonly expressions?: readonly ExpressionItem[];
}

/* ------------------------------------------------------------------ *
 * Source readers
 * ------------------------------------------------------------------ */

function isUsableTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/** Later of two optional ISO timestamps (undefined-safe, deterministic). */
function latestTimestamp(a?: string, b?: string): string | undefined {
  if (!isUsableTimestamp(a)) return isUsableTimestamp(b) ? b : undefined;
  if (!isUsableTimestamp(b)) return a;
  return a >= b ? a : b;
}

/**
 * Pronunciation evidence: pair each real pronunciation weakness row with the
 * learner-weakness row that tracks its lifecycle, and map ONLY the
 * observation kinds classified SUPPORTED above.
 */
function pronunciationCandidates(
  input: CurriculumEvidenceInput,
): SkillEvidenceCandidate[] {
  const rows = new Map<string, PronunciationWeakness>();
  for (const row of input.pronunciationWeaknesses ?? []) {
    if (row && typeof row.id === 'string') rows.set(row.id, row);
  }
  if (rows.size === 0) return [];

  const candidates: SkillEvidenceCandidate[] = [];
  for (const weakness of input.weaknesses ?? []) {
    if (weakness.type !== 'pronunciation') continue;
    const row = rows.get(weakness.referenceId);
    if (!row) continue;
    // The stored identity is `<observation kind>:<target>` — read through the
    // EXISTING parser so this module never invents a second identity format.
    const kind = parseWeaknessIdentity(row.targetSound)?.kind;
    if (!kind) continue;
    const mapping = pronunciationMappingFor(kind);
    if (!mapping || mapping.status !== 'SUPPORTED' || !mapping.skillId) continue;
    if (!getSkill(mapping.skillId)) continue; // Never emit a skill the catalog does not have.
    candidates.push({
      skillId: mapping.skillId,
      lifecycleState: weakness.status as SkillLifecycleState,
      ...(isUsableTimestamp(weakness.lastSeenAt)
        ? { lastObservedAt: weakness.lastSeenAt }
        : {}),
      evidenceCount: Math.max(0, Math.floor(weakness.occurrenceCount ?? 0)),
    });
  }
  return candidates;
}

/**
 * Lexical evidence: ONLY meanings that carry a REAL stored review state
 * contribute. The item-level review aggregate is a convenience copy and is
 * deliberately not consulted (per-meaning review is authoritative), and a
 * saved-but-never-reviewed meaning contributes nothing.
 */
function lexicalCandidates(
  items: readonly { readonly meanings?: readonly { readonly review?: { readonly state?: string; readonly reviewCount?: number; readonly lastReviewAt?: string } }[] }[] | undefined,
  skillId: string,
): SkillEvidenceCandidate[] {
  if (!Array.isArray(items)) return [];
  const candidates: SkillEvidenceCandidate[] = [];
  for (const item of items) {
    if (!item || !Array.isArray(item.meanings)) continue;
    let itemState: SkillLifecycleState | null = null;
    let contributingCount = 0;
    let lastObservedAt: string | undefined;
    for (const meaning of item.meanings) {
      const review = meaning?.review;
      if (!review || typeof review.state !== 'string') continue;
      const mapped = lifecycleFromMasteryState(
        review.state as MasteryState,
        typeof review.reviewCount === 'number' ? review.reviewCount : 0,
      );
      if (!mapped) continue;
      itemState = itemState === null ? mapped : mostUrgent(itemState, mapped);
      contributingCount += 1;
      lastObservedAt = latestTimestamp(lastObservedAt, review.lastReviewAt);
    }
    if (itemState === null || contributingCount === 0) continue;
    if (!getSkill(skillId)) continue;
    candidates.push({
      skillId,
      lifecycleState: itemState,
      ...(lastObservedAt ? { lastObservedAt } : {}),
      evidenceCount: contributingCount,
    });
  }
  return candidates;
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

/**
 * Project the loaded learner snapshot into curriculum evidence snapshots.
 *
 * Deterministic: the output is sorted by skillId, at most one snapshot per
 * skillId, and the aggregate metadata is a pure function of the input.
 */
export function projectCurriculumEvidence(
  input: CurriculumEvidenceInput,
): readonly SkillEvidenceSnapshot[] {
  const candidates: SkillEvidenceCandidate[] = [
    ...pronunciationCandidates(input),
    ...lexicalCandidates(input.vocabulary, 'core_vocabulary'),
    ...lexicalCandidates(input.expressions, 'common_expressions'),
    // Grammar weakness identity cannot identify a specific grammar node, and
    // listening identities cannot identify a listening skill: both are
    // classified UNMAPPABLE above and therefore emit nothing here.
  ];

  const merged = new Map<
    string,
    { state: SkillLifecycleState; lastObservedAt?: string; count: number }
  >();

  for (const candidate of candidates) {
    const current = merged.get(candidate.skillId);
    if (!current) {
      merged.set(candidate.skillId, {
        state: candidate.lifecycleState,
        ...(candidate.lastObservedAt ? { lastObservedAt: candidate.lastObservedAt } : {}),
        count: candidate.evidenceCount,
      });
      continue;
    }
    const nextLast = latestTimestamp(current.lastObservedAt, candidate.lastObservedAt);
    merged.set(candidate.skillId, {
      state: mostUrgent(current.state, candidate.lifecycleState),
      ...(nextLast ? { lastObservedAt: nextLast } : {}),
      count: current.count + candidate.evidenceCount,
    });
  }

  return Array.from(merged.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([skillId, entry]) => ({
      skillId,
      lifecycleState: entry.state,
      ...(entry.lastObservedAt ? { lastObservedAt: entry.lastObservedAt } : {}),
      evidenceCount: entry.count,
    }));
}

/**
 * Skill ids the learner has REAL active difficulty with, derived from the
 * same projection (never from a second, parallel mapping).
 */
export const PROJECTION_ACTIVE_STATES: readonly SkillLifecycleState[] = [
  'relapsed',
  'confirmed',
  'active_training',
  'repeated',
] as const;

/** Active-difficulty skill ids for a projection output (deterministic). */
export function activeDifficultySkillIds(
  snapshots: readonly SkillEvidenceSnapshot[],
): readonly string[] {
  const active: ReadonlySet<string> = new Set<string>(PROJECTION_ACTIVE_STATES);
  return snapshots
    .filter((snapshot) => active.has(snapshot.lifecycleState))
    .map((snapshot) => snapshot.skillId)
    .sort();
}
