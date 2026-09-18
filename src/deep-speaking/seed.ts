/**
 * src/deep-speaking/seed.ts
 *
 * Builds the Deep Speaking seed for an EXISTING Adaptive Lesson speaking step.
 *
 * HONESTY RULE
 * The seed carries the REAL practice target when the lesson has one. A generic
 * step title ("Speaking practice step 3") is a display label, never a learning
 * target, so it is not part of this input at all.
 *
 * Order of preference:
 *   1. `step.targetText` — the real practice target (word / expression / phrase),
 *   2. the step's own material prompt — real practice material,
 *   3. no seed: the caller starts a general plan instead of inventing a target.
 */

import type { SpeakingPracticeSeed } from './types';

export interface AdaptiveSpeakingSeedInput {
  readonly stepId: string;
  /** The real practice target of the lesson step, when it has one. */
  readonly targetText?: string | null;
  /** The step's own practice prompt/material. */
  readonly prompt?: string | null;
}

/**
 * Returns the seed for the real target material, or null when the step carries
 * no real target and no real prompt (nothing is invented in that case).
 */
export function buildSpeakingSeed(
  input: AdaptiveSpeakingSeedInput,
): SpeakingPracticeSeed | null {
  const stepId = input.stepId?.trim();
  if (!stepId) return null;

  const target = input.targetText?.trim();
  const prompt = input.prompt?.trim();
  const resolvedTarget = target || prompt;
  if (!resolvedTarget) return null;

  return {
    stepId,
    targetText: resolvedTarget,
    ...(prompt ? { prompt } : {}),
  };
}
