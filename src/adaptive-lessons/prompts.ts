/**
 * src/adaptive-lessons/prompts.ts
 *
 * Deterministic speaking-prompt templates (Phase 1).
 *
 * Prompts are built from REAL lesson context — a due expression, a saved word,
 * a corrected phrase, a listening target, a stored learning goal — or from a
 * small clearly GENERAL bank when there is no stored evidence to use.
 *
 * NO AI call is required to plan a lesson or to produce a prompt. The existing
 * AIProvider is used only to give qualitative feedback on the learner's spoken
 * or typed answer, and when it is unavailable the lesson says so honestly
 * instead of inventing an evaluation (see speaking.ts).
 */

import type { AdaptiveLessonStep } from './types';

/** Small bank of clearly GENERAL speaking tasks (fallback content only). */
export const GENERAL_SPEAKING_PROMPTS: readonly string[] = [
  'Describe what you did today, from morning until now. Say three or four sentences.',
  'Talk about something you are looking forward to this week and why.',
  'Describe a place you know well — what it looks like and what people do there.',
  'Explain how you usually get through a busy day at work or at school.',
];

/** Honest hint shown when no real AI provider can evaluate the answer. */
export const SPEAKING_FEEDBACK_UNAVAILABLE_NOTE =
  'AI feedback is not available right now, so this answer was not evaluated. Your practice still counts as completed.';

/** Short, deterministic index derived from a step id (stable across renders). */
function hashIndex(identity: string, length: number): number {
  if (length <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < identity.length; i += 1) {
    sum = (sum + identity.charCodeAt(i) * (i + 1)) >>> 0;
  }
  return sum % length;
}

/** Deterministic general prompt for a step (varies by day via the plan id). */
export function pickGeneralSpeakingPrompt(stepId: string): string {
  return GENERAL_SPEAKING_PROMPTS[hashIndex(stepId, GENERAL_SPEAKING_PROMPTS.length)];
}

/**
 * Build the speaking task for a step from real context.
 *
 * The templates never invent facts about the learner: each one either quotes
 * material that is really stored (an expression, a word, the learner's own
 * corrected phrase, a learning goal) or is taken from the general bank.
 */
export function buildSpeakingPrompt(step: AdaptiveLessonStep): string {
  const target = step.targetText?.trim();

  // A phrase the learner wrote that was correct but unnatural.
  if (step.source === 'weakness' && step.title === 'Natural phrasing') {
    return target
      ? `Say this more naturally in your own words: "${target}". Then use your version in a sentence.`
      : 'Take one sentence you often need at work or with friends and say it in two different, natural ways.';
  }

  // Fluency / confidence weaknesses: keep the learner talking.
  if (step.source === 'weakness' && target === undefined) {
    return 'Talk for about a minute about something you did recently. Do not stop to correct yourself — just keep going.';
  }

  // A listening weakness reused as speaking material (e.g. "deadline").
  if (step.source === 'weakness' && target) {
    return `Explain, in two or three sentences, how you deal with "${target}" in your work or studies.`;
  }

  // A real expression from the learner's saved list.
  if (step.target.kind === 'expression_item' && target) {
    return `Talk about your week and use the expression "${target}" naturally in two or three sentences.`;
  }

  // A real word from the learner's saved list.
  if (step.target.kind === 'vocabulary_item' && target) {
    return `Use the word "${target}" in two or three sentences about something real in your life.`;
  }

  // The learner's own stored learning goal.
  if (step.source === 'learning_goal' && target) {
    return `Your goal is: ${target}. Talk for a minute about how you use English for that, and what your next step is.`;
  }

  // No stored evidence — clearly general practice.
  return pickGeneralSpeakingPrompt(step.id);
}

/** Compact label for the UI header of a speaking step. */
export function describeSpeakingTask(step: AdaptiveLessonStep): string {
  if (step.personalized) {
    return step.targetText ? `Speaking task using "${step.targetText}"` : 'Targeted speaking task';
  }
  return 'General speaking task';
}
