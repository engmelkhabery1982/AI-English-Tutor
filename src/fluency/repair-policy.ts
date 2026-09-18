/**
 * src/fluency/repair-policy.ts
 *
 * WP-3 clarification / repair interaction policy: small, pure, testable.
 *
 * RULES
 * - PURE: no I/O, no AI call, no clock read, no randomness. Same inputs
 *   always produce the same decision — misunderstanding is NEVER faked
 *   randomly.
 * - A repair prompt MUST have a reason. Allowed triggers only:
 *   1. actually ambiguous/insufficient learner content (deterministic
 *      signals: very short transcript covering none of the task points), or
 *   2. existing structured correction evidence (real incorrect/unnatural
 *      correction from the committed turn), or
 *   3. an explicit repair-exercise scenario contract (declared practice).
 * - SCRIPTED HONESTY: trigger 3 is flagged `scripted` and carries the
 *   practice label the UI MUST show, so the learner knows the tutor asks on
 *   purpose. The UI/content must never pretend the AI genuinely failed to
 *   understand when the misunderstanding is scripted practice.
 * - OPEN-ENDED TALK IS NEVER A REPAIR SURFACE: `surface: 'talk'` always
 *   yields `allowed: false`. Ordinary Talk stays open-ended; deliberate
 *   repair training lives only in the structured fluency surface.
 * - Repair guidance is task-layer guidance (shown labeled in the UI), never
 *   forged AI output. A clarification/reformulation attempt is submitted as a
 *   normal attempt and completes normally.
 */

import { REPAIR_PRACTICE_LABEL } from './tasks';
import type { FluencyRepairDecision, FluencyRepairMove, FluencyRepairSurface } from './types';

/* ------------------------------------------------------------------ *
 * Bounds & thresholds (deterministic signals)
 * ------------------------------------------------------------------ */

/**
 * Below this many words — while covering NONE of the task points — the
 * content counts as insufficient for the task (deterministic, explainable).
 */
export const INSUFFICIENT_WORD_COUNT = 6;

/* ------------------------------------------------------------------ *
 * Repair prompts (bounded, deterministic selection — never random)
 * ------------------------------------------------------------------ */

/** Honest clarification prompts for genuinely unclear content. */
const EVIDENCE_REPAIR_PROMPTS: readonly string[] = [
  'Could you explain that another way?',
  'I’m not sure I understood the last part — could you be more specific?',
  'What happened after that?',
];

/** Deliberate-practice prompts (only inside an explicit repair exercise). */
const SCRIPTED_REPAIR_PROMPTS: readonly string[] = [
  'Do you mean the fastest way, or the easiest way? Explain it another way.',
  'Could you check I understood: repeat the key steps once more, slowly.',
  'Pretend I took a wrong turn — correct me and guide me back.',
];

export interface RepairTriggerInput {
  /** Which surface is asking (talk always refuses). */
  readonly surface: FluencyRepairSurface;
  /** Committed learner transcript of the attempt. */
  readonly transcript: string;
  /** Descriptive word count of the transcript. */
  readonly wordCount: number;
  /** How many required task points the attempt covered (deterministic). */
  readonly pointsCoveredCount: number;
  /** Real correction severity of the committed turn (null = none/demo). */
  readonly correctionSeverity: 'incorrect' | 'unnatural' | 'minor' | null;
  /** False for demo/offline attempts (no real evidence exists). */
  readonly isRealAI: boolean;
  /** True only inside an explicit repair-exercise scenario contract. */
  readonly repairExercise: boolean;
  /** 1-based attempt number (deterministic prompt rotation, never random). */
  readonly attemptNumber: number;
}

/**
 * Evaluate whether a clarification/repair prompt is allowed. Pure and
 * deterministic: identical inputs always yield the identical decision.
 */
export function evaluateRepairTrigger(
  input: RepairTriggerInput,
): FluencyRepairDecision {
  // Open-ended Talk never fakes misunderstanding. Ever.
  if (input.surface === 'talk') {
    return {
      allowed: false,
      reason: 'talk-never-fakes',
      scripted: false,
      practiceLabel: null,
      prompt: null,
    };
  }

  // Explicit repair exercise: the scenario contract licenses a deliberate
  // clarification prompt — always LABELED as deliberate practice.
  if (input.repairExercise) {
    const index =
      Math.max(0, input.attemptNumber - 1) % SCRIPTED_REPAIR_PROMPTS.length;
    return {
      allowed: true,
      reason: 'repair-exercise',
      scripted: true,
      practiceLabel: REPAIR_PRACTICE_LABEL,
      prompt: SCRIPTED_REPAIR_PROMPTS[index] ?? null,
    };
  }

  // Demo/offline: no real evidence exists, so no evidence-driven repair.
  if (!input.isRealAI) {
    return {
      allowed: false,
      reason: 'no-evidence',
      scripted: false,
      practiceLabel: null,
      prompt: null,
    };
  }

  // Real evidence trigger 1: actually insufficient content for the task.
  const insufficient =
    input.wordCount < INSUFFICIENT_WORD_COUNT && input.pointsCoveredCount === 0;
  if (insufficient) {
    return {
      allowed: true,
      reason: 'insufficient-content',
      scripted: false,
      practiceLabel: null,
      prompt: EVIDENCE_REPAIR_PROMPTS[0] ?? null,
    };
  }

  // Real evidence trigger 2: existing structured correction evidence.
  if (
    input.correctionSeverity === 'incorrect' ||
    input.correctionSeverity === 'unnatural'
  ) {
    return {
      allowed: true,
      reason: 'real-correction',
      scripted: false,
      practiceLabel: null,
      prompt:
        'Try saying that once more in your own words — ' +
        'rephrase the part that was corrected.',
    };
  }

  return {
    allowed: false,
    reason: 'no-evidence',
    scripted: false,
    practiceLabel: null,
    prompt: null,
  };
}

/* ------------------------------------------------------------------ *
 * Communication-strategy support (bounded, contextual)
 * ------------------------------------------------------------------ */

/**
 * Useful interaction strategies, shown as pre-speaking support at guided
 * level only (contextual — never dumped as a list during conversation).
 */
export const REPAIR_SUPPORT_MOVES: readonly FluencyRepairMove[] = [
  {
    id: 'ask-clarification',
    label: 'Ask for clarification',
    examples: ['Could you explain that another way?', 'Do you mean…?'],
  },
  {
    id: 'check-understanding',
    label: 'Check understanding',
    examples: ['So you mean…? Is that right?', 'Just to confirm, …'],
  },
  {
    id: 'buy-time',
    label: 'Buy thinking time naturally',
    examples: ['That’s a good question — let me think.', 'Well, …'],
  },
  {
    id: 'reformulate',
    label: 'Reformulate',
    examples: ['What I mean is…', 'In other words, …'],
  },
  {
    id: 'give-example',
    label: 'Give an example',
    examples: ['For example, …', 'Like when…'],
  },
];

/** Maximum strategy moves shown together (bounded support, never a dump). */
export const MAX_REPAIR_SUPPORT_MOVES = 3;

/**
 * Strategy support for a task: only repair tasks at guided level show moves
 * (bounded); every other combination shows none. Pure.
 */
export function repairSupportFor(
  taskKind: 'repetition' | 'monologue' | 'repair',
  supportLevel: 'guided' | 'supported' | 'independent',
): readonly FluencyRepairMove[] {
  if (taskKind !== 'repair') return [];
  if (supportLevel !== 'guided') return [];
  return REPAIR_SUPPORT_MOVES.slice(0, MAX_REPAIR_SUPPORT_MOVES);
}
