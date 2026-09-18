/**
 * src/listening/deep/evaluation.ts
 *
 * WP-2 — how a deep activity is ANSWERED through the EXISTING evaluator.
 *
 * There is deliberately NO second evaluator, no second weakness lifecycle and
 * no second review scheduler here. A deep answer is expressed as a synthetic
 * `ListeningExercise` and handed to the EXISTING `ListeningService.evaluateAnswer`
 * path, which owns deterministic evaluation, the weakness lifecycle and the
 * one-time review scheduling.
 *
 * CHOICE OF PHASE-1 TYPES (deliberate, deterministic-first)
 * - a question with options maps to `listen_and_choose` (deterministic choice
 *   evaluation), never to the open-ended AI evaluator;
 * - a question answered in words maps to `listen_and_type` (deterministic text
 *   evaluation), so a deep answer is NEVER judged by a model.
 */

import type { ListeningEvaluation, ListeningExercise } from '../types';
import {
  COMPREHENSION_QUESTION_LABELS,
  connectedSpeechSpokenText,
  discoursePassage,
  isDiscourseActivity,
} from './types';
import type {
  ComprehensionQuestion,
  ConnectedSpeechItem,
  DeepListeningActivity,
  DiscourseListeningActivity,
} from './types';

/** One answerable step inside a deep activity. */
export interface DeepAnswerStep {
  readonly id: string;
  /** Learner-facing label of what this step asks (e.g. "Important detail"). */
  readonly label: string;
  readonly prompt: string;
  readonly options?: readonly string[];
  /** Present for discourse/connected steps (shadowing has no answer step). */
  readonly expectedAnswer?: string;
}

function discourseSteps(
  activity: DiscourseListeningActivity,
): readonly DeepAnswerStep[] {
  return activity.questions.map((question) => ({
    id: question.id,
    label: COMPREHENSION_QUESTION_LABELS[question.kind],
    prompt: question.prompt,
    ...(question.options !== undefined ? { options: question.options } : {}),
    expectedAnswer: question.expectedAnswer,
  }));
}

/** Every answerable step of one deep activity (shadowing has none). */
export function deepAnswerSteps(
  activity: DeepListeningActivity,
): readonly DeepAnswerStep[] {
  switch (activity.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return discourseSteps(activity);
    case 'connected_speech':
      return activity.items.map((item) => ({
        id: item.id,
        label: 'Standard written form',
        prompt: item.prompt,
        ...(item.options !== undefined ? { options: item.options } : {}),
        expectedAnswer: item.expectedAnswer,
      }));
    case 'shadowing':
      return [];
    default:
      return [];
  }
}

/** One step by id, or null when the activity has no such step. */
export function deepStepById(
  activity: DeepListeningActivity,
  stepId: string,
): DeepAnswerStep | null {
  return deepAnswerSteps(activity).find((step) => step.id === stepId) ?? null;
}

function discourseQuestion(
  activity: DiscourseListeningActivity,
  stepId: string,
): ComprehensionQuestion | null {
  return activity.questions.find((question) => question.id === stepId) ?? null;
}

function connectedItem(
  activity: DeepListeningActivity,
  stepId: string,
): ConnectedSpeechItem | null {
  if (activity.taskType !== 'connected_speech') return null;
  return activity.items.find((item) => item.id === stepId) ?? null;
}

/**
 * The synthetic Phase-1 exercise for one deep step.
 *
 * `speakText` is the material the learner really heard, so the EXISTING
 * evaluation's transcript reveal stays honest; `keyItems` carries the expected
 * answer, so a missed attempt produces bounded, meaningful retraining evidence
 * through the EXISTING weakness ownership.
 */
export function syntheticExerciseForStep(
  activity: DeepListeningActivity,
  stepId: string,
): ListeningExercise | null {
  if (isDiscourseActivity(activity)) {
    const question = discourseQuestion(activity, stepId);
    if (!question) return null;
    const options = question.options;
    return {
      id: `${activity.id}:${question.id}`,
      learnerId: activity.learnerId,
      type: options && options.length > 0 ? 'listen_and_choose' : 'listen_and_type',
      difficulty: activity.difficulty,
      speakText: discoursePassage(activity),
      question: question.prompt,
      ...(options ? { options } : {}),
      expectedAnswer: question.expectedAnswer,
      ...(question.acceptableAnswers ? { acceptableAnswers: question.acceptableAnswers } : {}),
      keyItems: [question.expectedAnswer],
      source: activity.source === 'general' ? 'general' : 'listening_weakness',
      ...(activity.contextTopic !== undefined ? { contextTopic: activity.contextTopic } : {}),
      ...(question.explanation ?? activity.explanation
        ? { explanation: question.explanation ?? activity.explanation }
        : {}),
      contentProvenance: activity.contentProvenance,
      materialOrigin: activity.materialOrigin,
      requestKey: activity.requestKey,
    };
  }

  if (activity.taskType === 'connected_speech') {
    const item = connectedItem(activity, stepId);
    if (!item) return null;
    const options = item.options;
    return {
      id: `${activity.id}:${item.id}`,
      learnerId: activity.learnerId,
      type: options && options.length > 0 ? 'listen_and_choose' : 'listen_and_type',
      difficulty: activity.difficulty,
      // What the learner really heard: the natural spoken realization.
      speakText: connectedSpeechSpokenText(item),
      question: item.prompt,
      ...(options ? { options } : {}),
      expectedAnswer: item.expectedAnswer,
      keyItems: [item.spokenRealization],
      source: 'general',
      ...(activity.contextTopic !== undefined ? { contextTopic: activity.contextTopic } : {}),
      explanation: item.explanation,
      contentProvenance: activity.contentProvenance,
      materialOrigin: activity.materialOrigin,
      requestKey: activity.requestKey,
    };
  }

  return null;
}

/**
 * Learner-facing view of one deep evaluation: the EXISTING qualitative result
 * plus the deep-specific reveal (which form was correct / what was asked).
 * No numbers, no percentages, no ratings are ever added.
 */
export function deepEvaluationView(
  evaluation: ListeningEvaluation,
  activity: DeepListeningActivity,
  stepId: string,
): ListeningEvaluation {
  const lines = [...evaluation.feedbackLines];
  if (activity.taskType === 'connected_speech') {
    const item = connectedItem(activity, stepId);
    if (item) {
      lines.push(
        `The standard written form is '${item.writtenForm}' — the spoken form '${item.spokenRealization}' keeps the same meaning (${item.register}).`,
      );
    }
  } else if (isDiscourseActivity(activity)) {
    const question = discourseQuestion(activity, stepId);
    if (question) {
      lines.unshift(`${COMPREHENSION_QUESTION_LABELS[question.kind]}: ${question.prompt}`);
    }
  }
  return { ...evaluation, feedbackLines: lines };
}

/** The reveal text for a whole activity (after all of its steps are answered). */
export function revealedTranscriptFor(activity: DeepListeningActivity): string {
  switch (activity.taskType) {
    case 'long_discourse':
    case 'multi_speaker_dialogue':
      return discoursePassage(activity);
    case 'connected_speech':
      return activity.items
        .map((item) => `${item.spokenRealization} → ${item.writtenForm}`)
        .join(' · ');
    case 'shadowing':
      return activity.canonicalWrittenForm;
    default:
      return '';
  }
}
