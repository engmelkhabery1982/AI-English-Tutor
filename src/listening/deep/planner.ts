/**
 * src/listening/deep/planner.ts
 *
 * WP-2 — planning DEEP listening sessions.
 *
 * Everything here is DETERMINISTIC for the same inputs and reuses what the
 * EXISTING engine already provides:
 * - the WP-1 difficulty profile (`resolveDifficultyProfile`) resolved from the
 *   stored working level plus the ALREADY-LOADED listening weakness rows —
 *   so a real weakness makes the material more supported, and a real
 *   unresolved weakness decides the session focus;
 * - the WP-1 shared evidence conversion (`listeningEvidenceFromWeaknesses`);
 * - the same bounded read limits and request-key digest as the Phase-1 planner.
 *
 * No new learner model, no second scheduler, no independent mastery model and
 * no numeric difficulty score exist anywhere in this file.
 */

import type { AIProvider } from '../../providers/ai/types';
import type {
  ExpressionRepository,
  VocabularyRepository,
  WeaknessRepository,
} from '../../repositories';
import { resolveDifficultyProfile } from '../../learning-progression';
import type {
  DifficultyProfile,
  LearnerProgressionEvidence,
  ProgressionLevel,
  SupportLevel,
} from '../../learning-progression/types';
import {
  deterministicProvenanceForSource,
  listeningEvidenceFromWeaknesses,
} from '../ai-material';
import { LISTENING_READ_LIMITS, parseWeaknessIdentity } from '../generator';
import {
  CONNECTED_SPEECH_CATEGORIES,
  COMPREHENSION_QUESTION_KINDS,
  DISCOURSE_KINDS,
  SHADOWING_SUPPORT_ORDER,
} from './types';
import type {
  ComprehensionQuestionKind,
  ConnectedSpeechCategory,
  DeepListeningActivity,
  DeepListeningBounds,
  DeepListeningTaskType,
  DeepListeningSource,
  DiscourseKind,
  ShadowingSupportLevel,
} from './types';
import {
  MULTI_SPEAKER_DISCOURSE_KINDS,
  SOLO_DISCOURSE_KINDS,
  catalogueConnectedSpeechMaterial,
  catalogueDiscourseMaterial,
  catalogueShadowingMaterial,
  discourseEntryFor,
} from './catalogue';
import { buildDeepListeningRequest } from './request';
import type { DeepListeningRequest } from './request';
import { materialToActivity, generateDeepListeningActivity } from './generation';
import { planSpeechRate } from './speech-rate';
import type {
  DeepSpeechRateLevel,
  SpeechRateCapability,
  SpeechRatePlan,
} from './speech-rate';

/** The honest difficulty bands a plan resolves to (never a score). */
export type DeepDifficultyBand = 'supported' | 'core' | 'extended';

/** What the session is really focused on (honest, evidence-derived). */
export type DeepSessionFocus =
  | 'listening_weakness_retraining'
  | 'due_lexical_practice'
  | 'general';

/** The full resolved plan behind one deep session. */
export interface DeepListeningPlan {
  readonly level: ProgressionLevel;
  readonly band: DeepDifficultyBand;
  readonly difficultyProfile: DifficultyProfile;
  readonly supportLevel: SupportLevel;
  readonly evidenceAdjusted: boolean;
  readonly bounds: DeepListeningBounds;
  readonly speechRate: SpeechRatePlan;
  /** The task types this session serves, in deterministic order. */
  readonly taskTypes: readonly DeepListeningTaskType[];
  readonly discourseKind?: DiscourseKind;
  readonly questionKinds: readonly ComprehensionQuestionKind[];
  readonly connectedSpeechCategories: readonly ConnectedSpeechCategory[];
  readonly shadowingSupport: ShadowingSupportLevel;
  readonly focus: DeepSessionFocus;
}

/** The band implied by the stored working level. */
export function deepBandForLevel(level: ProgressionLevel): DeepDifficultyBand {
  switch (level) {
    case 'C1':
    case 'C2':
      return 'extended';
    case 'B1':
    case 'B2':
      return 'core';
    default:
      // 'unknown' and A1/A2 resolve to the most supported band — a working
      // level is a claim, and unknown never inflates difficulty.
      return 'supported';
  }
}

const BAND_ORDER: readonly DeepDifficultyBand[] = ['supported', 'core', 'extended'] as const;

/** Move one band down (more support) when real difficulty evidence exists. */
function withEvidenceSupport(band: DeepDifficultyBand, evidenceAdjusted: boolean): DeepDifficultyBand {
  const index = BAND_ORDER.indexOf(band);
  return BAND_ORDER[evidenceAdjusted ? Math.max(0, index - 1) : index];
}

/** Deterministic bounds per band. */
export function boundsForBand(band: DeepDifficultyBand): DeepListeningBounds {
  switch (band) {
    case 'extended':
      return {
        minSpeakers: 1,
        maxSpeakers: 3,
        minSegments: 3,
        maxSegments: 8,
        maxWordsPerSegment: 30,
        maxWords: 130,
        minQuestions: 2,
        maxQuestions: 4,
        minOptions: 2,
        maxOptions: 3,
        minConnectedSpeechItems: 4,
        maxConnectedSpeechItems: 5,
        minShadowingChunkWords: 10,
        maxShadowingChunkWords: 16,
        maxKeyItems: 4,
        maxExplanationLength: 300,
      };
    case 'core':
      return {
        minSpeakers: 1,
        maxSpeakers: 3,
        minSegments: 3,
        maxSegments: 6,
        maxWordsPerSegment: 26,
        maxWords: 95,
        minQuestions: 2,
        maxQuestions: 3,
        minOptions: 2,
        maxOptions: 3,
        minConnectedSpeechItems: 3,
        maxConnectedSpeechItems: 4,
        minShadowingChunkWords: 8,
        maxShadowingChunkWords: 12,
        maxKeyItems: 4,
        maxExplanationLength: 240,
      };
    case 'supported':
    default:
      return {
        minSpeakers: 1,
        maxSpeakers: 2,
        minSegments: 3,
        maxSegments: 5,
        maxWordsPerSegment: 20,
        maxWords: 60,
        minQuestions: 1,
        maxQuestions: 2,
        minOptions: 2,
        maxOptions: 3,
        minConnectedSpeechItems: 2,
        maxConnectedSpeechItems: 3,
        minShadowingChunkWords: 4,
        maxShadowingChunkWords: 8,
        maxKeyItems: 3,
        maxExplanationLength: 180,
      };
  }
}

/** Question kinds allowed per band (bounded, never unlimited). */
function questionKindsForBand(band: DeepDifficultyBand): readonly ComprehensionQuestionKind[] {
  switch (band) {
    case 'extended':
      return COMPREHENSION_QUESTION_KINDS;
    case 'core':
      return ['main_idea', 'detail', 'sequencing', 'speaker_intention'];
    case 'supported':
    default:
      return ['main_idea', 'detail'];
  }
}

/** Shadowing support per band: less support as the learner advances. */
function shadowingSupportForBand(
  band: DeepDifficultyBand,
  evidenceAdjusted: boolean,
): ShadowingSupportLevel {
  const base = band === 'extended' ? 2 : band === 'core' ? 1 : 0;
  const index = evidenceAdjusted ? Math.max(0, base - 1) : base;
  return SHADOWING_SUPPORT_ORDER[index];
}

/**
 * The discourse kinds a band serves, simplest first. Multi-speaker work
 * prefers the dialogue entries, so a single-speaker plan never claims to be a
 * conversation and a conversation plan always really has 2+ speakers.
 */
export function discourseKindsFor(
  band: DeepDifficultyBand,
  multiSpeaker: boolean,
): readonly DiscourseKind[] {
  const kinds = multiSpeaker ? MULTI_SPEAKER_DISCOURSE_KINDS : SOLO_DISCOURSE_KINDS;
  if (kinds.length === 0) return DISCOURSE_KINDS;
  return kinds;
}

function discourseKindForBand(
  band: DeepDifficultyBand,
  multiSpeaker: boolean,
  allowed?: readonly DiscourseKind[],
): DiscourseKind {
  const available = discourseKindsFor(band, multiSpeaker).filter(
    (kind) => allowed === undefined || allowed.includes(kind),
  );
  const pool = available.length > 0 ? available : discourseKindsFor(band, multiSpeaker);
  const index = band === 'extended' ? pool.length - 1 : band === 'core' ? Math.floor((pool.length - 1) / 2) : 0;
  return pool[Math.min(index, pool.length - 1)];
}

/** The session's task types, in deterministic order. */
export function taskTypesForPlan(
  band: DeepDifficultyBand,
  targetCount: number,
  requested?: readonly DeepListeningTaskType[],
): readonly DeepListeningTaskType[] {
  const first: DeepListeningTaskType =
    band === 'supported' ? 'long_discourse' : 'multi_speaker_dialogue';
  const base: readonly DeepListeningTaskType[] = [first, 'connected_speech', 'shadowing'];
  const requestedTypes =
    requested && requested.length > 0 ? requested.filter((type) => base.includes(type)) : null;
  const order: readonly DeepListeningTaskType[] =
    requestedTypes && requestedTypes.length > 0 ? requestedTypes : base;
  const count = Math.min(Math.max(targetCount, 1), order.length);
  return order.slice(0, count);
}

export interface DeepPlanInput {
  readonly level: ProgressionLevel;
  readonly evidence?: LearnerProgressionEvidence | null;
  readonly speechRateCapability: SpeechRateCapability;
  readonly requestedSpeechRate?: DeepSpeechRateLevel;
  readonly taskTypes?: readonly DeepListeningTaskType[];
  readonly discourseKinds?: readonly DiscourseKind[];
  readonly targetCount?: number;
}

/**
 * Resolve ONE deep plan: deterministic, evidence-aware, and honest about
 * playback capability. Identical inputs always produce an identical plan.
 */
export function resolveDeepListeningPlan(input: DeepPlanInput): DeepListeningPlan {
  const profile = resolveDifficultyProfile(
    input.level,
    input.evidence ?? null,
    'listening',
  );
  const baseBand = deepBandForLevel(profile.level);
  const band = withEvidenceSupport(baseBand, profile.evidenceAdjusted);
  const multiSpeaker = band !== 'supported';
  const targetCount = input.targetCount ?? 3;

  return {
    level: profile.level,
    band,
    difficultyProfile: profile,
    supportLevel: profile.supportLevel,
    evidenceAdjusted: profile.evidenceAdjusted,
    bounds: boundsForBand(band),
    speechRate: planSpeechRate(input.requestedSpeechRate, input.speechRateCapability),
    taskTypes: taskTypesForPlan(band, targetCount, input.taskTypes),
    discourseKind: discourseKindForBand(band, multiSpeaker, input.discourseKinds),
    questionKinds: questionKindsForBand(band),
    connectedSpeechCategories: CONNECTED_SPEECH_CATEGORIES,
    shadowingSupport: shadowingSupportForBand(band, profile.evidenceAdjusted),
    focus: input.evidence?.weaknesses.some((entry) => !entry.resolved)
      ? 'listening_weakness_retraining'
      : 'general',
  };
}

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export interface DeepRequestContext {
  readonly topic?: string;
  readonly learningGoals: readonly string[];
  readonly professionalContext?: string;
  readonly knownVocabulary: readonly string[];
  readonly targetExpressions: readonly string[];
  readonly listeningObjective?: string;
}

/** Build ONE request for a planned task type (bounds/kind pinned by the plan). */
export function deepRequestForTaskType(
  plan: DeepListeningPlan,
  taskType: DeepListeningTaskType,
  context: DeepRequestContext,
): DeepListeningRequest | null {
  const discourseKind =
    taskType === 'long_discourse' || taskType === 'multi_speaker_dialogue'
      ? plan.discourseKind
      : undefined;
  const built = buildDeepListeningRequest({
    difficultyProfile: plan.difficultyProfile,
    taskType,
    bounds: plan.bounds,
    ...(discourseKind !== undefined ? { discourseKind } : {}),
    questionKinds: plan.questionKinds,
    connectedSpeechCategories: plan.connectedSpeechCategories,
    shadowingSupport: plan.shadowingSupport,
    knownVocabulary: context.knownVocabulary,
    targetExpressions: context.targetExpressions,
    context: {
      ...(context.topic !== undefined ? { topic: context.topic } : {}),
      learningGoals: context.learningGoals,
      ...(context.professionalContext !== undefined
        ? { professionalContext: context.professionalContext }
        : {}),
    },
    ...(context.listeningObjective !== undefined
      ? { listeningObjective: context.listeningObjective }
      : {}),
  });
  return built.status === 'ok' ? built.request : null;
}

/* ------------------------------------------------------------------ *
 * Session planning
 * ------------------------------------------------------------------ */

export interface DeepPlannerDeps {
  readonly weaknesses: Pick<WeaknessRepository, 'listWeaknesses'>;
  readonly vocabulary: Pick<VocabularyRepository, 'list' | 'listDue'>;
  readonly expressions?: Pick<ExpressionRepository, 'listDue'>;
}

export interface DeepSessionOptions {
  readonly level: ProgressionLevel;
  readonly learningGoals: readonly string[];
  readonly professionalContext?: string;
  readonly topic?: string;
  readonly speechRateCapability: SpeechRateCapability;
  readonly requestedSpeechRate?: DeepSpeechRateLevel;
  readonly taskTypes?: readonly DeepListeningTaskType[];
  readonly discourseKinds?: readonly DiscourseKind[];
  readonly targetCount?: number;
  readonly now?: string;
  /** Opt-in: allow ONE generated activity to replace the last planned one. */
  readonly generatedContent?: { readonly provider: AIProvider };
}

export interface PlannedDeepSession {
  readonly activities: readonly DeepListeningActivity[];
  readonly plan: DeepListeningPlan;
  readonly sourceNote: string;
}

/** Deterministic: the first unresolved listening weakness target, if any. */
export function retrainingObjective(
  rows: readonly { readonly type: string; readonly status: string; readonly resolved: boolean; readonly notes?: string }[],
): string | null {
  for (const row of rows) {
    if (row.type !== 'listening' || row.resolved) continue;
    const identity = parseWeaknessIdentity(row.notes);
    if (identity && identity.target) return identity.target;
  }
  return null;
}

/**
 * Plan ONE bounded deep listening session.
 *
 * Reads are ONE bounded parallel batch (no N+1); the deterministic catalogue
 * always supplies usable material, and generated content can only ever
 * REPLACE one planned activity — never empty, block or break the session.
 */
export async function planDeepListeningSession(
  deps: DeepPlannerDeps,
  learnerId: string,
  options: DeepSessionOptions,
): Promise<PlannedDeepSession> {
  const now = options.now ?? new Date().toISOString();

  const [weaknessRows, dueVocabulary, dueExpressions, savedVocabulary] = await Promise.all([
    deps.weaknesses.listWeaknesses(learnerId, LISTENING_READ_LIMITS.weaknesses),
    deps.vocabulary.listDue(learnerId, now, LISTENING_READ_LIMITS.dueVocabulary),
    deps.expressions
      ? deps.expressions.listDue(learnerId, now, LISTENING_READ_LIMITS.dueExpressions)
      : Promise.resolve([]),
    deps.vocabulary.list(learnerId, { limit: LISTENING_READ_LIMITS.savedVocabulary }),
  ]);

  const evidence = listeningEvidenceFromWeaknesses(weaknessRows);
  const plan = resolveDeepListeningPlan({
    level: options.level,
    evidence,
    speechRateCapability: options.speechRateCapability,
    ...(options.requestedSpeechRate !== undefined
      ? { requestedSpeechRate: options.requestedSpeechRate }
      : {}),
    ...(options.taskTypes !== undefined ? { taskTypes: options.taskTypes } : {}),
    ...(options.discourseKinds !== undefined ? { discourseKinds: options.discourseKinds } : {}),
    ...(options.targetCount !== undefined ? { targetCount: options.targetCount } : {}),
  });

  const objective = retrainingObjective(weaknessRows);
  const context: DeepRequestContext = {
    ...(options.topic !== undefined ? { topic: options.topic } : {}),
    learningGoals: options.learningGoals,
    ...(options.professionalContext !== undefined
      ? { professionalContext: options.professionalContext }
      : {}),
    // BOUNDED known vocabulary from REAL stored evidence: saved items plus the
    // items that are due. This is a bounded hint, never "everything known".
    knownVocabulary: [
      ...savedVocabulary.map((entry) => entry.headword),
      ...dueVocabulary.map((entry) => entry.headword),
    ],
    // TARGET HONESTY: only REAL expression targets are offered as targets;
    // due vocabulary stays in the bounded known-vocabulary context.
    targetExpressions: dueExpressions.map((entry) => entry.expression),
    ...(objective !== null ? { listeningObjective: objective } : {}),
  };

  const activities: DeepListeningActivity[] = [];
  const requests: (DeepListeningRequest | null)[] = [];

  for (const taskType of plan.taskTypes) {
    const request = deepRequestForTaskType(plan, taskType, context);
    requests.push(request);
    if (!request) continue;
    const activity = buildDeterministicActivity(learnerId, request);
    if (activity) activities.push(activity);
  }

  // Opt-in generation replaces the LAST planned activity (deterministic slot).
  const generatedProvider = options.generatedContent?.provider;
  const replaceIndex = activities.length - 1;
  if (generatedProvider && replaceIndex >= 0) {
    const request = requests[replaceIndex];
    if (request) {
      const outcome = await generateDeepListeningActivity(generatedProvider, {
        learnerId,
        request,
      });
      if (outcome.activity) activities[replaceIndex] = outcome.activity;
    }
  }

  return {
    activities,
    plan,
    sourceNote: deepSessionSourceNote(activities),
  };
}

/** Deterministic catalogue material for one request (never personalized). */
function buildDeterministicActivity(
  learnerId: string,
  request: DeepListeningRequest,
): DeepListeningActivity | null {
  const input = {
    learnerId,
    request,
    // The served text is authored general material, so the honest source AND
    // provenance are 'general' even when real evidence chose the slot — the
    // Phase-1 rule: provenance describes the material, not the selection.
    source: 'general' as DeepListeningSource,
    materialOrigin: 'deterministic' as const,
    provenance: deterministicProvenanceForSource('general'),
  };

  switch (request.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue': {
      const kind = request.discourseKind ?? 'short_story';
      const entry = discourseEntryFor(kind);
      if (!entry) return null;
      return materialToActivity(catalogueDiscourseMaterial(entry, request), input);
    }
    case 'connected_speech': {
      const material = catalogueConnectedSpeechMaterial(request);
      if (material.items.length === 0) return null;
      return materialToActivity(material, input);
    }
    case 'shadowing':
      return materialToActivity(catalogueShadowingMaterial(request), input);
    default:
      return null;
  }
}

/** Honest session note: what the session really contains (no claims). */
export function deepSessionSourceNote(
  activities: readonly DeepListeningActivity[],
): string {
  if (activities.length === 0) {
    return 'Deep listening practice is unavailable right now. Please try again.';
  }
  const parts = activities.map((activity) => {
    switch (activity.taskType) {
      case 'long_discourse':
        return 'a longer listening passage';
      case 'multi_speaker_dialogue':
        return 'a conversation with more than one speaker';
      case 'connected_speech':
        return 'how spoken English compresses words';
      case 'shadowing':
        return 'a repeat-after-the-audio chunk';
      default:
        return 'listening practice';
    }
  });
  const unique = Array.from(new Set(parts));
  const generated = activities.some((activity) => activity.materialOrigin === 'ai');
  const base = `Deep listening: ${unique.join(', ')}. This is general practice — it is not based on your saved words.`;
  return generated
    ? `${base} One activity was freshly generated for this session.`
    : base;
}

